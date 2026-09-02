/**
 * Tests for the Forgejo diff().
 */

import { describe, it, expect } from "vitest";
import { countLiveManaged, diff } from "./diff.js";
import type { OrgConfig } from "../config/types.js";
import type { LiveOrgState } from "./live.js";

const ORG = "acme";
const kinds = (d: OrgConfig, l: LiveOrgState, opts = {}) =>
  diff(ORG, d, l, opts).entries.map((e) => `${e.resourceType}:${e.kind}:${e.key}`);

describe("diff: org settings", () => {
  it("update when a field differs", () => {
    const cs = diff(ORG, { settings: { description: "new" } }, { settings: { description: "old" } });
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.kind).toBe("update");
    expect(cs.entries[0]!.fields).toEqual([{ field: "description", before: "old", after: "new" }]);
  });
  it("no entry when settings match / absent", () => {
    expect(diff(ORG, {}, { settings: { description: "x" } }).entries).toHaveLength(0);
    expect(diff(ORG, { settings: { description: "x" } }, { settings: { description: "x" } }).entries).toHaveLength(0);
  });
});

describe("diff: members (presence; team-driven)", () => {
  it("create for new member; ownership-gated delete", () => {
    const d: OrgConfig = { members: [{ username: "alice" }] };
    const l: LiveOrgState = { members: [{ username: "bob" }] };
    expect(kinds(d, l)).toEqual(["member:create:alice"]); // bob not deleted without ownership
    const owned = kinds(d, l, { isOwned: (_t: string, k: string) => k === "bob" });
    expect(owned).toContain("member:delete:bob");
  });
});

describe("diff: teams", () => {
  it("create a new team with embedded members/repos", () => {
    const d: OrgConfig = { teams: { devs: { permission: "write", members: [{ username: "a" }], repos: [{ name: "svc" }] } } };
    const cs = diff(ORG, d, { teams: {} });
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0]!.resourceType).toBe("team");
    expect(cs.entries[0]!.kind).toBe("create");
    expect((cs.entries[0]!.after as { members?: unknown[] }).members).toHaveLength(1);
  });
  it("units are compared as a set (Forgejo does not guarantee response order)", () => {
    const d: OrgConfig = { teams: { devs: { units: ["repo.code", "repo.issues"] } } };
    const same: LiveOrgState = { teams: { devs: { id: 1, units: ["repo.issues", "repo.code"] } } };
    expect(diff(ORG, d, same).entries).toHaveLength(0);
    const differs: LiveOrgState = { teams: { devs: { id: 1, units: ["repo.code"] } } };
    const cs = diff(ORG, d, differs);
    expect(cs.entries[0]!.fields).toEqual([
      { field: "units", before: ["repo.code"], after: ["repo.code", "repo.issues"] },
    ]);
  });
  it("existing team → field update + separate child entries", () => {
    const d: OrgConfig = { teams: { devs: { permission: "admin", members: [{ username: "a" }], repos: [{ name: "svc" }] } } };
    const l: LiveOrgState = { teams: { devs: { id: 1, permission: "write", members: [], repos: [] } } };
    const ks = kinds(d, l);
    expect(ks).toContain("team:update:devs");
    expect(ks).toContain("team-member:create:devs/a");
    expect(ks).toContain("team-repo:create:devs/svc");
  });
});

describe("diff: teams — `previously:` renames directly (no `owned` required)", () => {
  const liveOld: LiveOrgState = {
    teams: { "platform-eng": { id: 7, permission: "write", members: [{ username: "a" }], repos: [] } },
  };

  it("plans exactly one update against the old live team, carrying its id", () => {
    const d: OrgConfig = { teams: { platform: { permission: "write", previously: "platform-eng" } } };
    const cs = diff(ORG, d, liveOld); // NO isOwned — deletes are impossible here
    expect(cs.entries).toHaveLength(1);
    const e = cs.entries[0]!;
    expect(e).toMatchObject({ kind: "update", resourceType: "team", key: "platform" });
    expect((e.before as { id?: number }).id).toBe(7);
    expect(e.fields).toContainEqual({ field: "key", before: "platform-eng", after: "platform" });
  });

  it("diffs declared fields and children against the old live team in the same plan", () => {
    const d: OrgConfig = {
      teams: {
        platform: {
          permission: "admin",
          previously: "platform-eng",
          members: [{ username: "a" }, { username: "b" }],
        },
      },
    };
    const ks = kinds(d, liveOld);
    expect(ks).toContain("team:update:platform");
    expect(ks).toContain("team-member:create:platform/b"); // keyed by the NEW name
    expect(ks).not.toContain("team:create:platform");
    expect(ks.filter((k) => k.includes(":delete:"))).toEqual([]);
  });

  it("wins over the owned delete+create mechanism — still one update, never a delete", () => {
    const d: OrgConfig = { teams: { platform: { permission: "write", previously: "platform-eng" } } };
    const cs = diff(ORG, d, liveOld, { isOwned: () => true });
    expect(cs.entries.map((e) => `${e.kind}:${e.key}`)).toEqual(["update:platform"]);
  });

  it("is inert once converged (live has the new name; the old name is gone)", () => {
    const d: OrgConfig = { teams: { platform: { permission: "write", previously: "platform-eng" } } };
    const liveNew: LiveOrgState = { teams: { platform: { id: 7, permission: "write" } } };
    expect(diff(ORG, d, liveNew).entries).toHaveLength(0);
  });

  it("is inert when a live team by the new name already exists alongside the old", () => {
    const d: OrgConfig = { teams: { platform: { permission: "write", previously: "platform-eng" } } };
    const both: LiveOrgState = {
      teams: {
        platform: { id: 9, permission: "write" },
        "platform-eng": { id: 7, permission: "write" },
      },
    };
    // Not a rename — the new name is live. The old team is untouched without ownership.
    expect(diff(ORG, d, both).entries).toHaveLength(0);
    expect(kinds(d, both, { isOwned: () => true })).toEqual(["team:delete:platform-eng"]);
  });
});

describe("countLiveManaged (removalLiveCap denominator)", () => {
  it("counts only collections the policy declares", () => {
    const live: LiveOrgState = {
      members: [{ username: "a" }, { username: "b" }],
      secrets: [{ name: "S1" }],
      variables: [{ name: "V1" }],
      webhooks: [{ url: "https://h.test" }],
    };
    expect(countLiveManaged({}, live)).toBe(0);
    expect(countLiveManaged({ members: [] }, live)).toBe(2);
    expect(countLiveManaged({ members: [], secrets: [], variables: [], webhooks: [] }, live)).toBe(5);
  });

  it("counts nested slices only for parents present in both desired and live", () => {
    const live: LiveOrgState = {
      teams: {
        devs: { id: 1, members: [{ username: "a" }], repos: [{ name: "r" }] },
        ops: { id: 2, members: [{ username: "b" }] },
      },
      repos: {
        svc: { branchProtection: [{ ruleName: "main" }], webhooks: [{ url: "u" }], secrets: [], variables: [{ name: "V" }] },
        other: { branchProtection: [{ ruleName: "main" }] },
      },
    };
    // Teams: 2 live teams + devs' declared members (1) — ops' children undeclared.
    expect(countLiveManaged({ teams: { devs: { members: [] } } }, live)).toBe(3);
    // Repos: 2 live repos + svc's declared branchProtection (1) + variables (1).
    expect(
      countLiveManaged({ repos: { svc: { branchProtection: [], variables: [] } } }, live),
    ).toBe(4);
    // A declared parent with no live counterpart contributes nothing nested.
    expect(countLiveManaged({ teams: { fresh: { members: [] } } }, live)).toBe(2);
  });

  it("ignores the settings singleton and repoBaselines", () => {
    const live: LiveOrgState = { settings: { description: "x" }, repos: { a: {}, b: {} } };
    expect(countLiveManaged({ settings: {}, repoBaselines: [{ name: "a" }] }, live)).toBe(0);
  });
});

describe("diff: repos + branch protection", () => {
  it("repo field + topics update; branch protection create/update", () => {
    const d: OrgConfig = {
      repos: {
        svc: {
          hasWiki: false,
          topics: ["api"],
          branchProtection: [{ ruleName: "main", requiredApprovals: 2, statusCheckContexts: ["ci"] }],
        },
      },
    };
    const l: LiveOrgState = {
      repos: { svc: { hasWiki: true, topics: ["old"], branchProtection: [{ ruleName: "main", requiredApprovals: 1, statusCheckContexts: [] }] } },
    };
    const ks = kinds(d, l);
    expect(ks).toContain("repo:update:svc");
    expect(ks).toContain("branch-protection:update:svc/main");
    const repoEntry = diff(ORG, d, l).entries.find((e) => e.resourceType === "repo")!;
    expect(repoEntry.fields!.map((f) => f.field).sort()).toEqual(["hasWiki", "topics"]);
  });
});

describe("diff: webhooks / secrets / variables", () => {
  it("org webhook create keyed by url", () => {
    const d: OrgConfig = { webhooks: [{ url: "https://h.test", events: ["push"] }] };
    expect(kinds(d, { webhooks: [] })).toEqual(["org-webhook:create:https://h.test"]);
  });
  it("secret presence (create only, no update) + variable value update", () => {
    const d: OrgConfig = { secrets: [{ name: "TOKEN" }], variables: [{ name: "ENV", value: "prod" }] };
    const l: LiveOrgState = { secrets: [], variables: [{ name: "ENV", value: "staging" }] };
    const ks = kinds(d, l);
    expect(ks).toContain("org-secret:create:TOKEN");
    expect(ks).toContain("org-variable:update:ENV");
  });
});

describe("diff: repo baselines (existence only)", () => {
  it("create only for missing repos", () => {
    const d: OrgConfig = { repoBaselines: [{ name: "exists" }, { name: "fresh" }] };
    const l: LiveOrgState = { repos: { exists: {} } };
    expect(kinds(d, l)).toEqual(["repo-baseline:create:fresh"]);
  });
});
