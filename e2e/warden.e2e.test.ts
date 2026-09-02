/**
 * Hermetic end-to-end smoke suite — exercises every registered cycle against a
 * REAL Forgejo instance (a throwaway Docker Compose stack, see
 * e2e/docker-compose.yml + e2e/bootstrap.sh). Gated and excluded from the
 * default test run (`vitest.config.ts` only globs `src/**`); run with
 * `npm run test:e2e:run`. Coverage table: e2e/README.md.
 *
 * ## Why this is fully hermetic
 * Forgejo is self-hostable, so — unlike github-warden's App-based e2e — this
 * needs NO external account or credentials. CI stands up Forgejo, mints an admin
 * token, and the suite provisions its own throwaway org + repos + user,
 * exercises the cycles, and tears them down.
 *
 * ## Gating
 * Skips entirely unless FORGEJO_E2E_URL and FORGEJO_E2E_TOKEN are set.
 *
 * ## Phases
 *   1 (always): per cycle, fetchLive + buildDesired + diff against the live org,
 *     asserting every HTTP call was read-only (GET) and the change set composes —
 *     catches live API-contract drift.
 *   2 (FORGEJO_E2E_APPLY=1): the full apply smoke — for every cycle: apply from
 *     a policy, re-run for an idempotent empty plan, mutate out-of-band and
 *     re-run for drift correction; real deletes via `owned`; the direct
 *     `previously:` team rename (no `owned`); repo-baseline generation from a
 *     template (asserting the template's files arrive); secret presence
 *     create/delete driven by FORGEJO_SECRET_<NAME>; and membership's
 *     remove-only semantics including the loud create failure.
 *
 * Tests in phase 2 are order-dependent (the org's state evolves); vitest runs
 * tests within a file sequentially, which this suite relies on.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createClient, type ForgejoClient } from "../src/auth/client.js";
import { CYCLE_REGISTRY } from "../src/cli/registry.js";
import { orgSettingsCycle } from "../src/cycles/org-settings.js";
import { membershipCycle } from "../src/cycles/membership.js";
import { teamsCycle } from "../src/cycles/teams.js";
import { repoSettingsCycle } from "../src/cycles/repo-settings.js";
import { branchProtectionCycle } from "../src/cycles/branch-protection.js";
import { repoBaselineCycle } from "../src/cycles/repo-baseline.js";
import { secretsVariablesCycle } from "../src/cycles/secrets-variables.js";
import { webhooksCycle } from "../src/cycles/webhooks.js";
import { diff } from "../src/reconcile/diff.js";
import { runReconcile, type Cycle, type RateBudget, type CycleResult } from "../src/reconcile/runner.js";
import type { OrgConfig } from "../src/config/types.js";

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

const ENV = process.env;
const URL = ENV.FORGEJO_E2E_URL;
const TOKEN = ENV.FORGEJO_E2E_TOKEN;
const APPLY = ENV.FORGEJO_E2E_APPLY === "1";

const configured = Boolean(URL && TOKEN);
const suite = configured ? describe : describe.skip;
const applySuite = configured && APPLY ? describe : describe.skip;

if (!configured) {
  // eslint-disable-next-line no-console
  console.warn("[e2e] skipped — run e2e/bootstrap.sh and set FORGEJO_E2E_URL / FORGEJO_E2E_TOKEN.");
} else if (!APPLY) {
  // eslint-disable-next-line no-console
  console.warn("[e2e] apply smoke skipped — set FORGEJO_E2E_APPLY=1 to run it.");
}

const ORG = `warden-e2e-${ENV.GITHUB_RUN_ID ?? Date.now()}`.toLowerCase();
const REPO = "probe";
const EXTRA_USER = "warden-smokey";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBudget(initial = 500): RateBudget {
  let remaining = initial;
  return {
    get remaining() {
      return remaining;
    },
    get exhausted() {
      return remaining <= 0;
    },
    use(n = 1) {
      remaining = Math.max(0, remaining - n);
    },
  };
}

interface Call {
  method: string;
  path: string;
}

/** Wrap a client to record every (method, path) it performs. */
function recording(inner: ForgejoClient): { client: ForgejoClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        calls.push({ method, path });
        return inner.request<T>(method, path, body);
      },
    },
  };
}

let client: ForgejoClient;
let admin = ""; // login of the token's user (the org owner)

/** Run one cycle over ORG with the given policy slice. */
async function reconcile(
  orgCfg: OrgConfig,
  cycle: Cycle,
  mode: "dry-run" | "apply",
  capFraction?: number,
): Promise<CycleResult> {
  const result = await runReconcile({
    config: { orgs: { [ORG]: orgCfg } },
    client,
    cycles: [cycle],
    mode,
    ...(capFraction !== undefined ? { removalDeltaCapFraction: capFraction } : {}),
  });
  expect(result.errored).toEqual([]);
  expect(result.cycles).toHaveLength(1);
  return result.cycles[0]!;
}

/** Apply a policy slice and require it to fully succeed. */
async function applyClean(orgCfg: OrgConfig, cycle: Cycle, capFraction?: number): Promise<CycleResult> {
  const cr = await reconcile(orgCfg, cycle, "apply", capFraction);
  expect(cr.guardrailBlocked, cr.guardrails.ok ? "" : JSON.stringify(cr.guardrails)).toBe(false);
  expect(cr.failed).toEqual([]);
  return cr;
}

/** Assert a follow-up dry-run plans nothing (the cycle has converged). */
async function expectConverged(orgCfg: OrgConfig, cycle: Cycle): Promise<void> {
  const cr = await reconcile(orgCfg, cycle, "dry-run");
  expect(cr.counts, `expected empty plan, got:\n${cr.plan}`).toEqual({ create: 0, update: 0, delete: 0 });
}

async function getTeams(): Promise<Array<{ id: number; name: string; description?: string }>> {
  return client.request("GET", `/orgs/${ORG}/teams?limit=50&page=1`);
}

async function memberLogins(): Promise<string[]> {
  const users = await client.request<Array<{ login?: string; username?: string }>>(
    "GET",
    `/orgs/${ORG}/members?limit=50&page=1`,
  );
  return users.map((u) => u.login ?? u.username ?? "").filter(Boolean).sort();
}

/** Poll until `probe` succeeds or ~10s elapse (repo generation is not instant). */
async function eventually<T>(probe: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return await probe();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

suite("forgejo-warden e2e (Docker Compose Forgejo)", () => {
  let orgConfig: OrgConfig;
  let orgCreated = false;
  let extraUserCreated = false;

  beforeAll(async () => {
    client = createClient({ baseUrl: URL!, token: TOKEN! });
    admin = (await client.request<{ login: string }>("GET", "/user")).login;

    // Provision a throwaway org and a repo inside it (auto_init gives `main`).
    await client.request("POST", `/orgs`, { username: ORG, visibility: "private" });
    orgCreated = true;
    await client.request("POST", `/orgs/${ORG}/repos`, {
      name: REPO,
      private: true,
      auto_init: true,
      description: "warden e2e — auto-created, safe to delete",
    });
    await client.request("POST", `/orgs/${ORG}/actions/variables/WARDEN_E2E_VAR`, { value: "ok" });

    // A second (non-admin) user for membership / team-member scenarios.
    await client
      .request("POST", `/admin/users`, {
        username: EXTRA_USER,
        email: `${EXTRA_USER}@example.com`,
        password: "Warden-e2e-pw-1234",
        must_change_password: false,
      })
      .then(() => {
        extraUserCreated = true;
      })
      .catch(() => {
        extraUserCreated = true; // already exists from a prior run — still ours to clean up
      });

    // Kitchen-sink config so every repo-scoped cycle's fetchLive hits its
    // endpoints (reads tolerate 404 for absent resources).
    orgConfig = {
      settings: { description: "warden e2e" },
      members: [],
      teams: {},
      repos: {
        [REPO]: {
          description: "warden e2e",
          topics: ["warden-e2e"],
          branchProtection: [{ ruleName: "main", requiredApprovals: 1 }],
          webhooks: [],
          secrets: [],
          variables: [{ name: "WARDEN_E2E_VAR", value: "ok" }],
        },
      },
      repoBaselines: [{ name: REPO }],
      secrets: [],
      variables: [{ name: "WARDEN_E2E_VAR", value: "ok" }],
      webhooks: [],
    };
  }, 90_000);

  afterAll(async () => {
    // Best-effort teardown — delete the repos, then the (now-empty) org.
    if (orgCreated) {
      for (const repo of [REPO, "tmpl", "from-tmpl", "plain"]) {
        await client.request("DELETE", `/repos/${ORG}/${repo}`).catch(() => {});
      }
      await client.request("DELETE", `/orgs/${ORG}`).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[e2e] teardown: failed to delete org ${ORG}:`, err);
      });
    }
    if (extraUserCreated) {
      await client.request("DELETE", `/admin/users/${EXTRA_USER}`).catch(() => {});
    }
  }, 60_000);

  // ── Phase 1: every cycle's read path is contract-valid and read-only ──────

  for (const cycle of Object.values(CYCLE_REGISTRY)) {
    it(`${cycle.name}: fetchLive is read-only and diffs cleanly`, async () => {
      const rec = recording(client);
      const live = await cycle.fetchLive(rec.client, ORG, {}, makeBudget());

      const desired = cycle.buildDesired(orgConfig, ORG, {});
      const changeSet = diff(ORG, desired, live, {});

      const nonGet = rec.calls.filter((c) => c.method !== "GET");
      expect(nonGet, `non-GET calls from ${cycle.name}.fetchLive`).toEqual([]);
      expect(Array.isArray(changeSet.entries)).toBe(true);
    }, 60_000);
  }

  // ── Phase 2: full apply smoke, cycle by cycle (opt-in) ────────────────────

  applySuite("org-settings", () => {
    const policy: OrgConfig = {
      settings: { description: "governed by warden", website: "https://warden.example.com" },
    };

    it("applies from a policy, verified by re-fetch", async () => {
      const cr = await applyClean(policy, orgSettingsCycle);
      expect(cr.applied.length).toBeGreaterThan(0);
      const org = await client.request<{ description?: string; website?: string }>("GET", `/orgs/${ORG}`);
      expect(org.description).toBe("governed by warden");
      expect(org.website).toBe("https://warden.example.com");
    }, 60_000);

    it("re-run is an idempotent empty plan", async () => {
      await expectConverged(policy, orgSettingsCycle);
    }, 60_000);

    it("corrects out-of-band drift", async () => {
      await client.request("PATCH", `/orgs/${ORG}`, { description: "drifted out of band" });
      const plan = await reconcile(policy, orgSettingsCycle, "dry-run");
      expect(plan.counts.update).toBe(1);
      await applyClean(policy, orgSettingsCycle);
      const org = await client.request<{ description?: string }>("GET", `/orgs/${ORG}`);
      expect(org.description).toBe("governed by warden");
    }, 60_000);
  });

  applySuite("teams", () => {
    // `Owners` is Forgejo's built-in owner team; declaring it (empty) keeps the
    // owned-delete scenarios from planning its (forbidden) deletion.
    const teamPolicy = (extra: OrgConfig["teams"] = {}): OrgConfig => ({
      teams: {
        Owners: {},
        platoon: {
          description: "governed smoke team",
          permission: "write",
          units: ["repo.code", "repo.issues", "repo.pulls"],
          members: [{ username: admin }],
          repos: [{ name: REPO }],
        },
        ...extra,
      },
    });

    it("creates a team (with members and repos) from a policy", async () => {
      await applyClean(teamPolicy(), teamsCycle);
      const teams = await getTeams();
      const platoon = teams.find((t) => t.name === "platoon");
      expect(platoon).toBeDefined();
      const members = await client.request<Array<{ login?: string }>>(
        "GET",
        `/teams/${platoon!.id}/members?limit=50&page=1`,
      );
      expect(members.map((m) => m.login)).toContain(admin);
      const repos = await client.request<Array<{ name?: string }>>(
        "GET",
        `/teams/${platoon!.id}/repos?limit=50&page=1`,
      );
      expect(repos.map((r) => r.name)).toContain(REPO);
    }, 60_000);

    it("re-run is an idempotent empty plan", async () => {
      await expectConverged(teamPolicy(), teamsCycle);
    }, 60_000);

    it("corrects out-of-band drift (team description)", async () => {
      const platoon = (await getTeams()).find((t) => t.name === "platoon")!;
      await client.request("PATCH", `/teams/${platoon.id}`, { name: "platoon", description: "drifted" });
      const plan = await reconcile(teamPolicy(), teamsCycle, "dry-run");
      expect(plan.counts.update).toBe(1);
      await applyClean(teamPolicy(), teamsCycle);
      const after = (await getTeams()).find((t) => t.name === "platoon")!;
      expect(after.description).toBe("governed smoke team");
    }, 60_000);

    it("removes an out-of-band team member via `owned: [team-member]` at a realistic cap", async () => {
      const platoon = (await getTeams()).find((t) => t.name === "platoon")!;
      await client.request("PUT", `/teams/${platoon.id}/members/${EXTRA_USER}`);
      // 1 delete of 2 live platoon members = 50%: passes a 0.5 cap only
      // because the denominator is the LIVE team-member count — the same
      // plan holds exactly one team-member non-create, so a plan-relative
      // cap would read 100% and block.
      const cr = await applyClean({ owned: ["team-member"], ...teamPolicy() }, teamsCycle, 0.5);
      expect(cr.applied.map((e) => `${e.kind}:${e.key}`)).toContain(`delete:platoon/${EXTRA_USER}`);
      const members = await client.request<Array<{ login?: string }>>(
        "GET",
        `/teams/${platoon.id}/members?limit=50&page=1`,
      );
      expect(members.map((m) => m.login)).toEqual([admin]);
    }, 60_000);

    it("the default removal cap blocks the stale-team delete, naming the type", async () => {
      await client.request("POST", `/orgs/${ORG}/teams`, {
        name: "stale",
        permission: "read",
        units: ["repo.code"],
      });
      // 1 delete of 3 live teams (Owners, platoon, stale) = 33% > the default
      // 25%: the apply is refused and the diagnostic is per-type.
      const cr = await reconcile({ owned: ["team"], ...teamPolicy() }, teamsCycle, "apply");
      expect(cr.guardrailBlocked).toBe(true);
      if (cr.guardrails.ok) throw new Error("expected removalDeltaCap diagnostics");
      expect(cr.guardrails.diagnostics[0]!.guardrail).toBe("removalDeltaCap");
      expect(cr.guardrails.diagnostics[0]!.message).toContain("1 of 3 live team entries (33%)");
      expect(cr.applied).toEqual([]);
      expect((await getTeams()).map((t) => t.name)).toContain("stale"); // nothing deleted
    }, 60_000);

    it("deletes the stale live-only team via `owned: [team]` once the cap allows it", async () => {
      // The same plan under a raised 0.5 cap: 1 of 3 live teams = 33% passes.
      const cr = await applyClean({ owned: ["team"], ...teamPolicy() }, teamsCycle, 0.5);
      expect(cr.applied.map((e) => `${e.kind}:${e.key}`)).toContain("delete:stale");
      const names = (await getTeams()).map((t) => t.name);
      expect(names).not.toContain("stale");
      expect(names).toContain("Owners"); // the declared built-in survives
    }, 60_000);

    it("renames via `previously:` WITHOUT `owned`: one update, id and members survive", async () => {
      const before = (await getTeams()).find((t) => t.name === "platoon")!;
      const renamed: OrgConfig = {
        teams: {
          Owners: {},
          squad: {
            description: "governed smoke team",
            permission: "write",
            units: ["repo.code", "repo.issues", "repo.pulls"],
            members: [{ username: admin }],
            repos: [{ name: REPO }],
            previously: "platoon",
          },
        },
      };
      const plan = await reconcile(renamed, teamsCycle, "dry-run");
      expect(plan.counts).toEqual({ create: 0, update: 1, delete: 0 });
      await applyClean(renamed, teamsCycle);

      const teams = await getTeams();
      expect(teams.map((t) => t.name)).not.toContain("platoon");
      const squad = teams.find((t) => t.name === "squad");
      expect(squad).toBeDefined();
      expect(squad!.id).toBe(before.id); // renamed in place, not recreated
      const members = await client.request<Array<{ login?: string }>>(
        "GET",
        `/teams/${squad!.id}/members?limit=50&page=1`,
      );
      expect(members.map((m) => m.login)).toContain(admin);
      await expectConverged(renamed, teamsCycle);
    }, 60_000);
  });

  applySuite("membership", () => {
    it("reads live membership (team-driven presence)", async () => {
      const squad = (await getTeams()).find((t) => t.name === "squad")!;
      await client.request("PUT", `/teams/${squad.id}/members/${EXTRA_USER}`);
      expect(await memberLogins()).toEqual([admin, EXTRA_USER].sort());
      await expectConverged(
        { members: [{ username: admin }, { username: EXTRA_USER }] },
        membershipCycle,
      );
    }, 60_000);

    it("removes a member via `owned: [member]` (remove-only semantics)", async () => {
      // 1 delete of 2 live org members = 50% — a 0.5 cap passes on the live
      // per-type denominator (plan-relative would read 100%).
      const cr = await applyClean({ owned: ["member"], members: [{ username: admin }] }, membershipCycle, 0.5);
      expect(cr.applied.map((e) => `${e.kind}:${e.key}`)).toEqual([`delete:${EXTRA_USER}`]);
      expect(await memberLogins()).toEqual([admin]);
    }, 60_000);

    it("fails loudly on a member create (adds must go through teams)", async () => {
      const cr = await reconcile(
        { members: [{ username: admin }, { username: EXTRA_USER }] },
        membershipCycle,
        "apply",
      );
      expect(cr.failed).toHaveLength(1);
      expect(cr.failed[0]!.entry.key).toBe(EXTRA_USER);
      expect(cr.failed[0]!.error).toMatch(/team-driven/);
      expect(await memberLogins()).toEqual([admin]); // nothing was mutated
    }, 60_000);
  });

  applySuite("repo-settings", () => {
    const policy: OrgConfig = {
      repos: {
        [REPO]: {
          description: "governed probe repo",
          hasWiki: false,
          hasIssues: true,
          topics: ["smoke", "warden"],
        },
      },
    };

    it("applies settings and topics from a policy", async () => {
      await applyClean(policy, repoSettingsCycle);
      const repo = await client.request<{ description?: string; has_wiki?: boolean }>(
        "GET",
        `/repos/${ORG}/${REPO}`,
      );
      expect(repo.description).toBe("governed probe repo");
      expect(repo.has_wiki).toBe(false);
      const topics = await client.request<{ topics?: string[] }>("GET", `/repos/${ORG}/${REPO}/topics`);
      expect((topics.topics ?? []).sort()).toEqual(["smoke", "warden"]);
    }, 60_000);

    it("re-run is an idempotent empty plan", async () => {
      await expectConverged(policy, repoSettingsCycle);
    }, 60_000);

    it("corrects out-of-band drift", async () => {
      await client.request("PATCH", `/repos/${ORG}/${REPO}`, { description: "drifted", has_wiki: true });
      const plan = await reconcile(policy, repoSettingsCycle, "dry-run");
      expect(plan.counts.update).toBe(1);
      await applyClean(policy, repoSettingsCycle);
      const repo = await client.request<{ description?: string; has_wiki?: boolean }>(
        "GET",
        `/repos/${ORG}/${REPO}`,
      );
      expect(repo.description).toBe("governed probe repo");
      expect(repo.has_wiki).toBe(false);
    }, 60_000);
  });

  applySuite("branch-protection", () => {
    const policy: OrgConfig = {
      repos: {
        [REPO]: {
          branchProtection: [
            { ruleName: "main", requiredApprovals: 1, enablePush: false, dismissStaleApprovals: true },
          ],
        },
      },
    };

    it("creates a protection rule from a policy", async () => {
      await applyClean(policy, branchProtectionCycle);
      const bp = await client.request<{ required_approvals?: number; enable_push?: boolean }>(
        "GET",
        `/repos/${ORG}/${REPO}/branch_protections/main`,
      );
      expect(bp.required_approvals).toBe(1);
      expect(bp.enable_push).toBe(false);
    }, 60_000);

    it("re-run is an idempotent empty plan", async () => {
      await expectConverged(policy, branchProtectionCycle);
    }, 60_000);

    it("corrects out-of-band drift", async () => {
      await client.request("PATCH", `/repos/${ORG}/${REPO}/branch_protections/main`, {
        required_approvals: 3,
      });
      const plan = await reconcile(policy, branchProtectionCycle, "dry-run");
      expect(plan.counts.update).toBe(1);
      await applyClean(policy, branchProtectionCycle);
      const bp = await client.request<{ required_approvals?: number }>(
        "GET",
        `/repos/${ORG}/${REPO}/branch_protections/main`,
      );
      expect(bp.required_approvals).toBe(1);
    }, 60_000);

    it("deletes a rule via `owned: [branch-protection]`", async () => {
      const gone: OrgConfig = { owned: ["branch-protection"], repos: { [REPO]: { branchProtection: [] } } };
      // 1 of 1 live rule = 100%: a deliberate full wipe of a one-entry
      // collection genuinely needs the cap at 1 here.
      const cr = await applyClean(gone, branchProtectionCycle, 1);
      expect(cr.applied.map((e) => `${e.kind}:${e.key}`)).toContain(`delete:${REPO}/main`);
      const rules = await client.request<unknown[]>("GET", `/repos/${ORG}/${REPO}/branch_protections`);
      expect(rules).toEqual([]);
    }, 60_000);
  });

  applySuite("repo-baseline", () => {
    const MARKER = "WARDEN.md";
    const MARKER_CONTENT = "provisioned from the warden e2e template\n";
    const policy: OrgConfig = {
      repoBaselines: [
        { name: REPO },
        { name: "tmpl" },
        { name: "from-tmpl", template: `${ORG}/tmpl` },
        { name: "plain" },
      ],
    };

    it("provisions missing repos — from a template (files arrive) and empty", async () => {
      // Build the template: an initialized repo with a marker file, flagged as
      // a template so `POST …/generate` accepts it.
      await client.request("POST", `/orgs/${ORG}/repos`, { name: "tmpl", private: true, auto_init: true });
      await client.request("PATCH", `/repos/${ORG}/tmpl`, { template: true });
      await client.request("POST", `/repos/${ORG}/tmpl/contents/${MARKER}`, {
        content: Buffer.from(MARKER_CONTENT).toString("base64"),
        message: "add template marker",
      });

      const plan = await reconcile(policy, repoBaselineCycle, "dry-run");
      expect(plan.counts).toEqual({ create: 2, update: 0, delete: 0 }); // from-tmpl + plain
      await applyClean(policy, repoBaselineCycle);

      // git_content: the template's FILES must actually arrive.
      const file = await eventually(() =>
        client.request<{ content?: string }>("GET", `/repos/${ORG}/from-tmpl/contents/${MARKER}`),
      );
      expect(Buffer.from(file.content ?? "", "base64").toString()).toBe(MARKER_CONTENT);
      await client.request("GET", `/repos/${ORG}/plain`); // exists (404 would throw)
    }, 120_000);

    it("re-run is an idempotent empty plan", async () => {
      await expectConverged(policy, repoBaselineCycle);
    }, 60_000);
  });

  applySuite("secrets-variables", () => {
    const policy: OrgConfig = {
      secrets: [{ name: "SMOKE_TOKEN" }],
      variables: [
        { name: "SMOKE_VAR", value: "v1" },
        { name: "WARDEN_E2E_VAR", value: "ok" },
      ],
      repos: {
        [REPO]: {
          secrets: [{ name: "REPO_TOKEN" }],
          variables: [{ name: "REPO_VAR", value: "r1" }],
        },
      },
    };

    async function orgSecretNames(): Promise<string[]> {
      const list = await client.request<Array<{ name?: string }>>(
        "GET",
        `/orgs/${ORG}/actions/secrets?limit=50&page=1`,
      );
      return list.map((s) => s.name ?? "").filter(Boolean).sort();
    }

    it("creates secrets (value from FORGEJO_SECRET_<NAME>) and variables", async () => {
      process.env.FORGEJO_SECRET_SMOKE_TOKEN = "org-secret-material";
      process.env.FORGEJO_SECRET_REPO_TOKEN = "repo-secret-material";
      await applyClean(policy, secretsVariablesCycle);
      expect(await orgSecretNames()).toContain("SMOKE_TOKEN");
      const repoSecrets = await client.request<Array<{ name?: string }>>(
        "GET",
        `/repos/${ORG}/${REPO}/actions/secrets?limit=50&page=1`,
      );
      expect(repoSecrets.map((s) => s.name)).toContain("REPO_TOKEN");
      const v = await client.request<{ data?: string; value?: string }>(
        "GET",
        `/orgs/${ORG}/actions/variables/SMOKE_VAR`,
      );
      expect(v.data ?? v.value).toBe("v1");
    }, 60_000);

    it("re-run is an idempotent empty plan", async () => {
      await expectConverged(policy, secretsVariablesCycle);
    }, 60_000);

    it("corrects out-of-band variable drift", async () => {
      await client.request("PUT", `/orgs/${ORG}/actions/variables/SMOKE_VAR`, { value: "drifted" });
      const plan = await reconcile(policy, secretsVariablesCycle, "dry-run");
      expect(plan.counts.update).toBe(1);
      await applyClean(policy, secretsVariablesCycle);
      const v = await client.request<{ data?: string; value?: string }>(
        "GET",
        `/orgs/${ORG}/actions/variables/SMOKE_VAR`,
      );
      expect(v.data ?? v.value).toBe("v1");
    }, 60_000);

    it("deletes org secrets and variables via `owned`", async () => {
      const gone: OrgConfig = { owned: ["org-secret", "org-variable"], secrets: [], variables: [] };
      // Full wipes (1 of 1 secret, 2 of 2 variables = 100% each) — the cap
      // must be 1 for this deliberate teardown.
      const cr = await applyClean(gone, secretsVariablesCycle, 1);
      expect(cr.applied.map((e) => `${e.kind}:${e.resourceType}:${e.key}`)).toContain(
        "delete:org-secret:SMOKE_TOKEN",
      );
      expect(await orgSecretNames()).toEqual([]);
      const vars = await client.request<Array<{ name?: string }>>(
        "GET",
        `/orgs/${ORG}/actions/variables?limit=50&page=1`,
      );
      expect(vars).toEqual([]);
    }, 60_000);
  });

  applySuite("webhooks", () => {
    const ORG_HOOK = "https://warden.example.com/org-hook";
    const REPO_HOOK = "https://warden.example.com/repo-hook";
    const policy: OrgConfig = {
      webhooks: [{ url: ORG_HOOK, contentType: "json", events: ["push"], active: true }],
      repos: {
        [REPO]: { webhooks: [{ url: REPO_HOOK, contentType: "json", events: ["push"], active: true }] },
      },
    };

    async function orgHooks(): Promise<Array<{ id: number; active?: boolean; config?: { url?: string } }>> {
      return client.request("GET", `/orgs/${ORG}/hooks?limit=50&page=1`);
    }

    it("creates org and repo webhooks from a policy", async () => {
      await applyClean(policy, webhooksCycle);
      expect((await orgHooks()).map((h) => h.config?.url)).toContain(ORG_HOOK);
      const repoHooks = await client.request<Array<{ config?: { url?: string } }>>(
        "GET",
        `/repos/${ORG}/${REPO}/hooks?limit=50&page=1`,
      );
      expect(repoHooks.map((h) => h.config?.url)).toContain(REPO_HOOK);
    }, 60_000);

    it("re-run is an idempotent empty plan", async () => {
      await expectConverged(policy, webhooksCycle);
    }, 60_000);

    it("corrects out-of-band drift (hook deactivated)", async () => {
      const hook = (await orgHooks()).find((h) => h.config?.url === ORG_HOOK)!;
      await client.request("PATCH", `/orgs/${ORG}/hooks/${hook.id}`, { active: false });
      const plan = await reconcile(policy, webhooksCycle, "dry-run");
      expect(plan.counts.update).toBe(1);
      await applyClean(policy, webhooksCycle);
      const after = (await orgHooks()).find((h) => h.config?.url === ORG_HOOK)!;
      expect(after.active).toBe(true);
    }, 60_000);

    it("deletes webhooks via `owned`", async () => {
      const gone: OrgConfig = {
        owned: ["org-webhook", "repo-webhook"],
        webhooks: [],
        repos: { [REPO]: { webhooks: [] } },
      };
      // Full wipes again (1 of 1 hook at each scope = 100%) — cap 1 is the
      // honest setting for this deliberate teardown.
      const cr = await applyClean(gone, webhooksCycle, 1);
      expect(cr.applied.filter((e) => e.kind === "delete")).toHaveLength(2);
      expect(await orgHooks()).toEqual([]);
      const repoHooks = await client.request<unknown[]>("GET", `/repos/${ORG}/${REPO}/hooks?limit=50&page=1`);
      expect(repoHooks).toEqual([]);
    }, 60_000);
  });
});
