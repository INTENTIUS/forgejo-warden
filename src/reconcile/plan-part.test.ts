/**
 * `reconcile --plan-json`: the part a run writes reads back through chant's
 * `readChangeSetPartFile`, names the member and carries the planned change
 * sets. The Forgejo client is mocked the way the cycle tests do it.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { composeChangeSet, readChangeSetPartFile } from "@intentius/chant/change-set";
import { mapChangeSetToGraph } from "@intentius/chant/change-set-graph";
import { driftAddress, governanceDrift } from "../drift/reader.js";
import { readGovernance } from "../graph/reader.js";
import type { ChangeSet } from "./diff.js";
import { membershipCycle } from "../cycles/membership.js";
import { makeClient } from "../cycles/_testutil.js";
import { runReconcile, type Cycle } from "./runner.js";
import { defaultMemberName, planPart, PLAN_PART_LEXICON } from "./plan-part.js";
import type { GovernanceConfig } from "../config/types.js";

const config: GovernanceConfig = {
  orgs: {
    acme: { owned: ["member"], members: [{ username: "ada" }, { username: "bob" }] },
  },
};

/** Live: ada and carol are members, so the plan creates bob and deletes carol. */
const client = () =>
  makeClient({
    "GET /orgs/acme/members?limit=50&page=1": [{ login: "ada" }, { login: "carol" }],
  });

/** What the CLI writes: the part as JSON text, parsed back. */
const roundTrip = (part: unknown): unknown => JSON.parse(`${JSON.stringify(part, null, 2)}\n`);

describe("planPart", () => {
  it("writes a part readChangeSetPartFile accepts, naming the member and carrying the plan", async () => {
    const result = await runReconcile({ config, client: client(), cycles: [membershipCycle], mode: "dry-run" });
    expect(result.changeSets).toHaveLength(1);

    const written = roundTrip(planPart({ member: "governance", changeSets: result.changeSets, errored: result.errored, deferred: result.deferred }));
    const part = readChangeSetPartFile(written, "warden", "governance", PLAN_PART_LEXICON);

    expect(part.member).toMatchObject({ member: "governance", lexicon: "forgejo", planner: "warden", scope: "acme", status: "planned", holes: [] });
    expect(part.member.planDigest).toMatch(/\S/);
    const actions = part.entries.map((e) => [e.action, e.address, e.scope, e.lexicon, e.member]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ["create", "org/acme#member[bob]", "acme", "forgejo", "governance"],
        ["delete", "org/acme#member[carol]", "acme", "forgejo", "governance"],
      ]),
    );
    expect(part.entries).toHaveLength(2);

    // It composes into a change-set document beside other members' parts.
    const doc = composeChangeSet([part]);
    expect(doc.summary.byMember.governance).toMatchObject({ create: 1, delete: 1 });
  });

  it("is deterministic: the same plan gives the same digest", async () => {
    const a = await runReconcile({ config, client: client(), cycles: [membershipCycle], mode: "dry-run" });
    const b = await runReconcile({ config, client: client(), cycles: [membershipCycle], mode: "dry-run" });
    expect(planPart({ member: "m", changeSets: a.changeSets }).member.planDigest).toBe(
      planPart({ member: "m", changeSets: b.changeSets }).member.planDigest,
    );
  });

  it("marks the member failed, with no digest, when a cycle errored", async () => {
    const broken: Cycle = {
      name: "broken",
      async fetchLive() {
        throw new Error("GET returned 500");
      },
      buildDesired: () => ({}),
      async apply() {},
    };
    const result = await runReconcile({ config, client: client(), cycles: [membershipCycle, broken], mode: "dry-run" });
    expect(result.errored).toHaveLength(1);

    const part = readChangeSetPartFile(
      roundTrip(planPart({ member: "governance", changeSets: result.changeSets, errored: result.errored, deferred: result.deferred })),
      "warden",
      "governance",
    );
    expect(part.member.status).toBe("failed");
    expect(part.member.planDigest).toBeNull();
    expect(part.member.error).toMatch(/broken @ acme errored in fetchLive/);
    // What the other cycles planned stays in the part.
    expect(part.entries).toHaveLength(2);
  });
});

describe("planPart on the graph", () => {
  /** Two orgs that each declare a repo named api. */
  const policy: GovernanceConfig = {
    orgs: {
      acme: { repos: { api: { private: true } }, teams: { core: { permission: "write", members: [{ username: "ada" }] } } },
      globex: { repos: { api: { private: false } } },
    },
  };

  const changeSets: ChangeSet[] = [
    {
      org: "acme",
      entries: [
        // The repo node's own change.
        { kind: "update", resourceType: "repo", key: "api", before: { private: false }, after: { private: true }, fields: [{ field: "private", before: false, after: true }] },
        // Changes under a node: a repo's secret, a team's member, the org's member.
        { kind: "create", resourceType: "repo-secret", key: "api/TOKEN", after: { name: "TOKEN" } },
        { kind: "create", resourceType: "team-member", key: "core/ada", after: { username: "ada" } },
        { kind: "delete", resourceType: "member", key: "carol", before: { username: "carol" } },
      ],
    },
    // The other org's same-named repo.
    { org: "globex", entries: [{ kind: "create", resourceType: "repo", key: "api", after: { name: "api", private: false } }] },
  ];

  it("places every entry on the node the drift reader gives for the same change", () => {
    const ir = readGovernance(policy);
    const part = readChangeSetPartFile(roundTrip(planPart({ member: "governance", changeSets })), "warden", "governance", PLAN_PART_LEXICON);
    const addresses = part.entries.map((e) => e.address);
    expect(new Set(addresses).size).toBe(addresses.length);

    const doc = mapChangeSetToGraph(composeChangeSet([part]), { member: null, at: null, ids: ir.nodes.map((n) => n.id) });
    expect(doc.entries).toHaveLength(5);
    for (const e of doc.entries) {
      expect(e.node, e.address).toBe(driftAddress(e.scope!, { resourceType: e.type, key: e.name! }));
    }
    expect(doc.entries.map((e) => [e.scope, e.type, e.node]).sort()).toEqual(
      [
        ["acme", "member", "org/acme"],
        ["acme", "repo", "repo/acme/api"],
        ["acme", "repo-secret", "repo/acme/api"],
        ["acme", "team-member", "team/acme/core"],
        ["globex", "repo", "repo/globex/api"],
      ].sort(),
    );

    // The drift reader's drifted records sit on the same nodes.
    const { records } = governanceDrift({ member: "governance", observedAt: "2026-11-15T00:00:00.000Z", policy, changeSets });
    const drifted = records.filter((r) => r.status === "drifted").map((r) => r.address);
    expect(new Set(drifted)).toEqual(new Set(doc.entries.map((e) => e.node)));
  });
});

describe("defaultMemberName", () => {
  it("is the name of the policy file's directory", () => {
    expect(defaultMemberName("members/governance/governance.yml")).toBe("governance");
    expect(defaultMemberName(join(process.cwd(), "governance.ts"))).toBe(join(process.cwd()).split("/").pop());
  });
  it("is undefined for a policy at the filesystem root", () => {
    expect(defaultMemberName("/governance.yml")).toBeUndefined();
  });
});
