/**
 * Runner integration — warden's runReconcile (the chant harness + Forgejo diff
 * + guardrails) driven with a fake cycle and a mock client.
 */

import { describe, it, expect } from "vitest";
import { runReconcile, type Cycle } from "./runner.js";
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

  it("the removal cap blocks a mass-delete apply", async () => {
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

describe("removalDeltaCap (per-type live denominators)", () => {
  const tenLive: LiveOrgState = {
    members: Array.from({ length: 10 }, (_, i) => ({ username: `m${i}` })),
  };
  const keep = (n: number) =>
    cfg(Array.from({ length: n }, (_, i) => `m${i}`));

  it("1 stale delete of 10 live passes (a plan-relative cap would trip at 100%)", async () => {
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

  it("4 deletes of 10 live blocks (40% > 25%), naming the offending type", async () => {
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
    expect(cr.guardrails.diagnostics[0]!.guardrail).toBe("removalDeltaCap");
    expect(cr.guardrails.diagnostics[0]!.message).toContain("4 of 10 live member entries");
    expect(applied).toHaveLength(0);
  });

  it("3 team deletes of 4 live block at 75% even beside 20 live team members", async () => {
    // The dilution case from the review: a pooled denominator read this wipe
    // as 3 of 24 entries (12.5%) and let it through. Per-type counts divide
    // team deletes by live teams only.
    const live: LiveOrgState = {
      teams: {
        t0: { id: 0, members: Array.from({ length: 20 }, (_, i) => ({ username: `m${i}` })) },
        t1: { id: 1 },
        t2: { id: 2 },
        t3: { id: 3 },
      },
    };
    const teamsCycle: Cycle = {
      name: "teams",
      async fetchLive() {
        return live;
      },
      buildDesired(config: OrgConfig) {
        return { teams: config.teams };
      },
      async apply() {},
    };
    const result = await runReconcile({
      config: {
        orgs: {
          acme: {
            owned: ["team"],
            teams: {
              t0: {
                members: Array.from({ length: 20 }, (_, i) => ({ username: `m${i}` })),
              },
            },
          },
        },
      },
      client: mockClient(),
      cycles: [teamsCycle],
      mode: "apply",
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrailBlocked).toBe(true);
    if (cr.guardrails.ok) throw new Error("expected diagnostics");
    expect(cr.guardrails.diagnostics[0]!.message).toContain("3 of 4 live team entries (75%)");
  });

  it("empty live keeps the cap armed on its per-type plan-relative fallback", async () => {
    // Bootstrap: nothing live, so every per-type count is zero and the plan
    // holds only creates — which the cap never counts, so the apply proceeds.
    // Warden's diff cannot plan a delete of a type without live entries of
    // that type (counts come from the same walk that emits the deletes), so a
    // zero count coinciding with deletes is unreachable from here; chant's
    // per-type plan-relative fallback stays as defense in depth.
    const applied: string[] = [];
    const result = await runReconcile({
      config: cfg(["a", "b", "c"]),
      client: mockClient(),
      cycles: [membersCycle({}, applied)],
      mode: "apply",
      diffOptions: { isOwned: () => true },
    });
    const cr = result.cycles[0]!;
    expect(cr.guardrails.ok).toBe(true);
    expect(cr.guardrailBlocked).toBe(false);
    expect(applied.sort()).toEqual(["a", "b", "c"]);
  });
});
