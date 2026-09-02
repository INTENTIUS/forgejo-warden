/**
 * Runner integration — warden's runReconcile (the chant harness + Forgejo diff
 * + guardrails) driven with a fake cycle and a mock client.
 */

import { describe, it, expect } from "vitest";
import { removalDeltaCap } from "@intentius/chant/reconcile";
import type { ChangeSet } from "@intentius/chant/reconcile";
import { removalLiveCap, runReconcile, type Cycle } from "./runner.js";
import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig } from "../config/types.js";
import type { LiveOrgState } from "./live.js";
import type { GovernanceConfig } from "../config/types.js";

const mockClient = (): ForgejoClient => ({ async request<T = unknown>(): Promise<T> {
  return {} as T;
} });

/** A members cycle: fetchLive returns the given live; buildDesired passes members through. */
function membersCycle(live: LiveOrgState, applied: string[]): Cycle {
  return {
    name: "members",
    async fetchLive() {
      return live;
    },
    buildDesired(config: OrgConfig) {
      return { members: config.members };
    },
    async apply(_client, entry) {
      applied.push(entry.key);
    },
  };
}

const cfg = (members: string[]): GovernanceConfig => ({
  orgs: { acme: { members: members.map((username) => ({ username })) } },
});

describe("runReconcile (Forgejo adapter)", () => {
  it("dry-run reports creates and applies nothing", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: cfg(["a", "b", "c"]),
      client: mockClient(),
      cycles: [membersCycle({}, applied)], // empty live → all creates
      mode: "dry-run",
    });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(3);
    expect(applied).toHaveLength(0);
  });

  it("apply applies each entry", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: cfg(["a", "b"]),
      client: mockClient(),
      cycles: [membersCycle({}, applied)],
      mode: "apply",
    });
    expect(result.completed).toBe(true);
    expect(applied.sort()).toEqual(["a", "b"]);
  });

  it("derives isOwned from `owned: true` — a live-only entry becomes a delete", async () => {
    const live: LiveOrgState = { members: [{ username: "a" }, { username: "b" }] };
    const result = await runReconcile({
      config: { orgs: { acme: { owned: true, members: [{ username: "a" }] } } },
      client: mockClient(),
      cycles: [membersCycle(live, [])],
      mode: "dry-run",
    });
    expect(result.cycles[0]!.counts.delete).toBe(1);
  });

  it("absent `owned` yields no deletes (current default preserved)", async () => {
    const live: LiveOrgState = { members: [{ username: "a" }, { username: "b" }] };
    const result = await runReconcile({
      config: cfg(["a"]),
      client: mockClient(),
      cycles: [membersCycle(live, [])],
      mode: "dry-run",
    });
    expect(result.cycles[0]!.counts.delete).toBe(0);
  });

  it("`owned: [types]` unlocks deletes only for the listed resource types", async () => {
    const applied: string[] = [];
    const orgCycle: Cycle = {
      name: "org",
      async fetchLive() {
        return {
          members: [{ username: "a" }, { username: "b" }],
          teams: { stale: { description: "live-only team" } },
        };
      },
      buildDesired(config: OrgConfig) {
        return { members: config.members, teams: config.teams };
      },
      async apply(_client, entry) {
        applied.push(`${entry.kind}:${entry.resourceType}:${entry.key}`);
      },
    };
    const result = await runReconcile({
      config: {
        orgs: { acme: { owned: ["member"], members: [{ username: "a" }], teams: {} } },
      },
      client: mockClient(),
      cycles: [orgCycle],
      mode: "apply",
      removalDeltaCapFraction: 1,
    });
    expect(result.cycles[0]!.counts.delete).toBe(1);
    expect(applied).toContain("delete:member:b");
    expect(applied.filter((a) => a.includes(":team:"))).toHaveLength(0);
  });

  it("caller-supplied diffOptions.isOwned wins over the org's `owned` declaration", async () => {
    const live: LiveOrgState = { members: [{ username: "a" }, { username: "b" }] };
    const result = await runReconcile({
      config: { orgs: { acme: { owned: true, members: [{ username: "a" }] } } },
      client: mockClient(),
      cycles: [membersCycle(live, [])],
      mode: "dry-run",
      diffOptions: { isOwned: () => false },
    });
    expect(result.cycles[0]!.counts.delete).toBe(0);
  });

  it("removalLiveCap blocks a mass-delete apply", async () => {
    const applied: string[] = [];
    const live: LiveOrgState = { members: Array.from({ length: 10 }, (_, i) => ({ username: `m${i}` })) };
    const result = await runReconcile({
      config: cfg(["m0"]), // keep 1, would delete 9 of 10 → 90% > 25%
      client: mockClient(),
      cycles: [membersCycle(live, applied)],
      mode: "apply",
      diffOptions: { isOwned: () => true }, // make the unmanaged members deletable
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrailBlocked).toBe(true);
    expect(cr.guardrails.ok).toBe(false);
    expect(applied).toHaveLength(0);
  });
});

describe("removalLiveCap (live-relative removal cap)", () => {
  const tenLive: LiveOrgState = {
    members: Array.from({ length: 10 }, (_, i) => ({ username: `m${i}` })),
  };
  const keep = (n: number) =>
    cfg(Array.from({ length: n }, (_, i) => `m${i}`));

  it("1 stale delete of 10 live passes (chant's plan-relative cap would trip at 100%)", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: keep(9), // converged but for one stale delete: 1 of 10 live = 10%
      client: mockClient(),
      cycles: [membersCycle(tenLive, applied)],
      mode: "apply",
      diffOptions: { isOwned: () => true },
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrails.ok).toBe(true);
    expect(cr.guardrailBlocked).toBe(false);
    expect(applied).toEqual(["m9"]);
  });

  it("4 deletes of 10 live blocks (40% > 25%), naming live managed entries", async () => {
    const applied: string[] = [];
    const result = await runReconcile({
      config: keep(6), // 4 of 10 live = 40%
      client: mockClient(),
      cycles: [membersCycle(tenLive, applied)],
      mode: "apply",
      diffOptions: { isOwned: () => true },
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrailBlocked).toBe(true);
    if (cr.guardrails.ok) throw new Error("expected diagnostics");
    expect(cr.guardrails.diagnostics[0]!.guardrail).toBe("removalLiveCap");
    expect(cr.guardrails.diagnostics[0]!.message).toContain("4 of 10 live managed entries");
    expect(applied).toHaveLength(0);
  });

  it("zero live managed entries falls back to chant's plan-relative removalDeltaCap", () => {
    const changeSet: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "delete", resourceType: "member", key: "a", before: { username: "a" } },
        { kind: "update", resourceType: "member", key: "b", before: {}, after: {}, fields: [] },
      ],
    };
    expect(removalLiveCap(changeSet, 0)).toEqual(removalDeltaCap(changeSet));
    expect(removalLiveCap(changeSet, 0, { maxFraction: 0.6 })).toEqual(
      removalDeltaCap(changeSet, { maxFraction: 0.6 }),
    );
    expect(removalLiveCap({ org: "acme", entries: [] }, 0)).toBeNull();
  });

  it("guardrails see the count captured from the IMMEDIATELY preceding diff (per scope×cycle sequencing)", async () => {
    // Two orgs through one runner call. The shared loop must run
    // diff → guardrails per scope before moving on, so each org's guardrail
    // divides by its own live count. big: 1 delete of 20 live (5%, passes).
    // small: 2 deletes of 4 live (50%, blocks). If `small` read `big`'s stale
    // count instead, 2/20 = 10% would slip through the 25% cap.
    const liveByOrg: Record<string, LiveOrgState> = {
      big: { members: Array.from({ length: 20 }, (_, i) => ({ username: `m${i}` })) },
      small: { members: Array.from({ length: 4 }, (_, i) => ({ username: `s${i}` })) },
    };
    const perOrgCycle: Cycle = {
      name: "members",
      async fetchLive(_client, scopeId) {
        return liveByOrg[scopeId]!;
      },
      buildDesired(config: OrgConfig) {
        return { members: config.members };
      },
      async apply() {},
    };
    const members = (names: string[]) => names.map((username) => ({ username }));
    const result = await runReconcile({
      config: {
        orgs: {
          big: { owned: true, members: members(Array.from({ length: 19 }, (_, i) => `m${i}`)) },
          small: { owned: true, members: members(["s0", "s1"]) },
        },
      },
      client: mockClient(),
      cycles: [perOrgCycle],
      mode: "dry-run",
    });
    const byOrg = Object.fromEntries(result.cycles.map((c) => [c.org, c]));
    expect(byOrg.big!.guardrails.ok).toBe(true);
    const small = byOrg.small!;
    if (small.guardrails.ok) throw new Error("expected small org to be capped");
    expect(small.guardrails.diagnostics[0]!.message).toContain("2 of 4 live managed entries");
  });
});
