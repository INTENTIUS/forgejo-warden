import { describe, it, expect } from "vitest";
import { teamsCycle, buildTeamBody } from "./teams.js";
import { makeClient, makeBudget } from "./_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";

const scope = {};

describe("buildTeamBody", () => {
  it("maps camelCase to Forgejo snake_case", () => {
    expect(buildTeamBody({ permission: "write", canCreateOrgRepo: true, units: ["repo.code"] })).toEqual({
      permission: "write",
      can_create_org_repo: true,
      units: ["repo.code"],
    });
  });
});

describe("teamsCycle.fetchLive", () => {
  it("lists teams with members and repos, carrying the id", async () => {
    const client = makeClient({
      "GET /orgs/acme/teams?limit=50&page=1": [
        { id: 7, name: "devs", permission: "write", can_create_org_repo: true, units: ["repo.code"] },
      ],
      "GET /teams/7/members?limit=50&page=1": [{ login: "alice" }, { login: "bob" }],
      "GET /teams/7/repos?limit=50&page=1": [{ name: "api" }],
    });
    const live = await teamsCycle.fetchLive(client, "acme", scope, makeBudget());
    expect(live.teams!.devs).toMatchObject({
      id: 7,
      permission: "write",
      canCreateOrgRepo: true,
      members: [{ username: "alice" }, { username: "bob" }],
      repos: [{ name: "api" }],
    });
  });
});

describe("teamsCycle.apply — team create embeds children", () => {
  it("POSTs the team then PUTs members and repos with the new id", async () => {
    const client = makeClient({ "POST /orgs/acme/teams": { id: 42 } });
    await teamsCycle.apply(
      client,
      {
        kind: "create",
        resourceType: "team",
        key: "devs",
        after: { permission: "write", members: [{ username: "alice" }], repos: [{ name: "api" }] },
      },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /orgs/acme/teams",
      "PUT /teams/42/members/alice",
      "PUT /teams/42/repos/acme/api",
    ]);
    expect(client.calls[0]!.body).toMatchObject({ name: "devs", permission: "write" });
  });
});

describe("teamsCycle.apply — update/delete use the live id", () => {
  it("PATCHes /teams/{id} on update, always sending the name (EditTeamOption requires it)", async () => {
    const client = makeClient();
    await teamsCycle.apply(
      client,
      { kind: "update", resourceType: "team", key: "devs", before: { id: 7 }, after: { permission: "admin" }, fields: [] },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "PATCH", path: "/teams/7", body: { name: "devs", permission: "admin" } });
  });
  it("DELETEs /teams/{id} on delete", async () => {
    const client = makeClient();
    await teamsCycle.apply(
      client,
      { kind: "delete", resourceType: "team", key: "devs", before: { id: 7 } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[0]).toMatchObject({ method: "DELETE", path: "/teams/7" });
  });
});

describe("teamsCycle.apply — subresources resolve name → id", () => {
  // Forgejo has no by-name team endpoint; resolution goes through teams/search
  // with an exact-name match on the result.
  const SEARCH = "GET /orgs/acme/teams/search?q=devs&limit=50";
  it("team-member add resolves the team id via search first", async () => {
    const client = makeClient({ [SEARCH]: { ok: true, data: [{ id: 9, name: "devs" }] } });
    await teamsCycle.apply(
      client,
      { kind: "create", resourceType: "team-member", key: "devs/carol", after: { username: "carol" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /orgs/acme/teams/search?q=devs&limit=50",
      "PUT /teams/9/members/carol",
    ]);
  });
  it("team-repo remove resolves id then DELETEs", async () => {
    const client = makeClient({ [SEARCH]: { ok: true, data: [{ id: 9, name: "devs" }] } });
    await teamsCycle.apply(
      client,
      { kind: "delete", resourceType: "team-repo", key: "devs/api", before: { name: "api" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[1]).toMatchObject({ method: "DELETE", path: "/teams/9/repos/acme/api" });
  });
  it("search results are exact-matched on name (substring hits don't win)", async () => {
    const client = makeClient({
      [SEARCH]: { ok: true, data: [{ id: 8, name: "devs-ops" }, { id: 9, name: "Devs" }] },
    });
    await teamsCycle.apply(
      client,
      { kind: "create", resourceType: "team-member", key: "devs/carol", after: { username: "carol" } },
      "acme",
      scope,
      makeBudget(),
    );
    expect(client.calls[1]).toMatchObject({ method: "PUT", path: "/teams/9/members/carol" });
  });
});

describe("teamsCycle — `previously:` rename", () => {
  const liveRoutes = {
    "GET /orgs/acme/teams?limit=50&page=1": [{ id: 7, name: "platform-eng", permission: "write" }],
    "GET /teams/7/members?limit=50&page=1": [],
    "GET /teams/7/repos?limit=50&page=1": [],
  };
  const renameConfig = (owned: boolean): GovernanceConfig => ({
    orgs: {
      acme: {
        ...(owned ? { owned: true } : {}),
        teams: { platform: { permission: "write", previously: "platform-eng" } },
      },
    },
  });

  it("renames in a NON-owned org: exactly one update, applied as one PATCH", async () => {
    const client = makeClient(liveRoutes);
    const result = await runReconcile({
      config: renameConfig(false),
      client,
      cycles: [teamsCycle],
      mode: "apply",
    });
    const cr = result.cycles[0]!;
    expect(cr.counts).toEqual({ create: 0, delete: 0, update: 1 });
    expect(cr.guardrailBlocked).toBe(false);
    expect(cr.failed).toEqual([]);
    // ONE PATCH carrying the new name against the old team's live id — no
    // duplicate-team POST, no delete of the old team.
    const writes = client.calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "PATCH", path: "/teams/7", body: { name: "platform" } });
  });

  it("converges after the rename: live under the new name → empty plan", async () => {
    const client = makeClient({
      "GET /orgs/acme/teams?limit=50&page=1": [{ id: 7, name: "platform", permission: "write" }],
      "GET /teams/7/members?limit=50&page=1": [],
      "GET /teams/7/repos?limit=50&page=1": [],
    });
    const result = await runReconcile({
      config: renameConfig(false),
      client,
      cycles: [teamsCycle],
      mode: "dry-run",
    });
    expect(result.cycles[0]!.counts).toEqual({ create: 0, delete: 0, update: 0 });
  });

  it("in an owned org the direct-update path still wins: one PATCH, no delete", async () => {
    const client = makeClient(liveRoutes);
    const result = await runReconcile({
      config: renameConfig(true),
      client,
      cycles: [teamsCycle],
      mode: "apply",
    });
    const cr = result.cycles[0]!;
    expect(cr.counts).toMatchObject({ create: 0, delete: 0, update: 1 });
    expect(cr.guardrailBlocked).toBe(false);
    expect(cr.failed).toEqual([]);
    const patch = client.calls.find((c) => c.method === "PATCH");
    expect(patch).toMatchObject({ path: "/teams/7", body: { name: "platform" } });
    expect(client.calls.some((c) => c.method === "DELETE" || c.method === "POST")).toBe(false);
  });
});

describe("teamsCycle via runReconcile", () => {
  it("creates a missing team end-to-end", async () => {
    const config: GovernanceConfig = {
      orgs: { acme: { teams: { devs: { permission: "write", members: [{ username: "alice" }] } } } },
    };
    const client = makeClient({
      "GET /orgs/acme/teams?limit=50&page=1": [],
      "POST /orgs/acme/teams": { id: 100 },
    });
    const result = await runReconcile({ config, client, cycles: [teamsCycle], mode: "apply" });
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(1);
    expect(client.calls.some((c) => c.path === "PUT /teams/100/members/alice".split(" ")[1])).toBe(true);
  });
});
