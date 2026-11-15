/**
 * `reconcile --drift-issue` (INTENTIUS/forgejo-warden#47): one issue per
 * forge, kept by chant's keepDriftIssue through chant's Forgejo client. The
 * Forgejo issue API is an in-memory fake behind `fetch`; nothing leaves the
 * process.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DriftRecord } from "@intentius/chant/drift-record";
import type { ForgeFetch } from "@intentius/chant/pr-forge";
import { run } from "../cli.js";
import {
  describeDriftIssue,
  driftIssueEnvironment,
  driftIssueForge,
  driftIssueRepo,
  driftIssueRunUrl,
  keepGovernanceDriftIssue,
} from "./issue.js";
import { governanceDrift } from "./reader.js";

const BASE = "https://forgejo.example.com";
const at = "2026-11-14T09:00:00.000Z";

interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  comments: string[];
}

/** Forgejo's issue API for one repository, in memory, plus whatever `reads` answers for the warden's own GETs. */
function fakeForgejo(repo: string, reads: Record<string, unknown> = {}) {
  const issues: Issue[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const view = (i: Issue) => ({ number: i.number, id: i.number + 1000, title: i.title, body: i.body, state: i.state, html_url: `${BASE}/${repo}/issues/${i.number}`, created_at: at });
  const handle = async (url: string, method: string, rawBody?: string): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, "");
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    const issuesPath = `/repos/${repo}/issues`;
    if (path === issuesPath && method === "GET") {
      const page = Number(u.searchParams.get("page") ?? "1");
      return json(200, page === 1 ? issues.filter((i) => i.state === "open").map(view) : []);
    }
    if (path === issuesPath && method === "POST") {
      const i: Issue = { number: issues.length + 1, title: body.title, body: body.body, state: "open", comments: [] };
      issues.push(i);
      return json(201, view(i));
    }
    const m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/comments)?$/.exec(path);
    if (m) {
      const i = issues.find((x) => x.number === Number(m[1]));
      if (!i) return json(404, { message: "not found" });
      if (m[2] && method === "POST") {
        i.comments.push(body.body);
        return json(201, { id: 1, body: body.body });
      }
      if (method === "PATCH") {
        if (body.title !== undefined) i.title = body.title;
        if (body.body !== undefined) i.body = body.body;
        if (body.state !== undefined) i.state = body.state;
        return json(200, view(i));
      }
    }
    const key = `${method} ${path}${u.search}`;
    if (key in reads) return json(200, reads[key]);
    return json(200, u.searchParams.has("page") ? [] : {});
  };
  const forgeFetch: ForgeFetch = (url, init) => handle(url, init.method, init.body);
  const globalFetch = ((url: string | URL, init?: RequestInit) => handle(String(url), init?.method ?? "GET", init?.body as string | undefined)) as typeof fetch;
  return { issues, forgeFetch, globalFetch };
}

const record = (address: string, status: DriftRecord["status"], extra: Partial<DriftRecord> = {}): DriftRecord => ({
  member: "governance",
  engine: "warden",
  address,
  node: null,
  observedAt: at,
  read: "plan",
  status,
  evidence: { tool: "forgejo-warden" },
  ...extra,
});

const environment = "forgejo.example.com/acme";

describe("keepGovernanceDriftIssue", () => {
  test("opens one issue for drift, leaves it for the same drift, updates it when the drift changes, and closes it when clean", async () => {
    const fake = fakeForgejo("acme/governance");
    const forge = driftIssueForge({ baseUrl: BASE, repo: "acme/governance", token: "t", tokenEnv: "FORGEJO_TOKEN", fetch: fake.forgeFetch });
    const drift = [
      record("repo/acme/api", "drifted", { attributes: [{ path: "repo[#api].hasWiki", before: false, after: true }] }),
      record("team/acme/core", "drifted", { attributes: [{ path: "team[#core]", before: { permission: "read" } }] }),
      record("org/acme", "in-sync"),
    ];

    const opened = await keepGovernanceDriftIssue(forge, { environment, records: drift });
    expect(opened.action).toBe("opened");
    expect(fake.issues).toHaveLength(1);
    const issue = fake.issues[0];
    expect(issue.title).toBe("Governance drift on forgejo.example.com/acme");
    expect(issue.body.split("\n")[0]).toBe("<!-- forgejo-warden:drift forgejo.example.com/acme -->");
    expect(issue.body).toContain("| `repo/acme/api` | drifted | `repo[#api].hasWiki`: declared `false`, live `true` |");
    // A declared team the forge lacks is drift under its node.
    expect(issue.body).toContain("| `team/acme/core` | drifted | `team[#core]`: declared `{\"permission\":\"read\"}`, live `absent` |");
    expect(issue.body).not.toContain("org/acme");
    expect(issue.body).toContain("forgejo-warden reconcile --mode apply");

    expect((await keepGovernanceDriftIssue(forge, { environment, records: drift })).action).toBe("unchanged");
    expect(fake.issues).toHaveLength(1);

    const updated = await keepGovernanceDriftIssue(forge, { environment, records: [drift[0], record("team/acme/core", "in-sync")] });
    expect(updated.action).toBe("updated");
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].body).not.toContain("team/acme/core");

    // A read that failed proves nothing: the issue stays open.
    const failed = record("cycle/acme/teams", "not-observed", { unobserved: { reason: "read-failed", detail: "fetchLive: 500" } });
    expect((await keepGovernanceDriftIssue(forge, { environment, records: [failed] })).action).toBe("left");
    expect(fake.issues[0].state).toBe("open");

    const closed = await keepGovernanceDriftIssue(forge, { environment, records: [record("repo/acme/api", "in-sync")], observedAt: at });
    expect(closed.action).toBe("closed");
    expect(fake.issues[0].state).toBe("closed");
    expect(fake.issues[0].comments).toEqual([`forgejo-warden's drift check at ${at} found forgejo.example.com/acme matching, so this issue is closed.`]);
    expect((await keepGovernanceDriftIssue(forge, { environment, records: [] })).action).toBe("none");
  });

  test("a sensitive attribute shows no value", async () => {
    const fake = fakeForgejo("acme/governance");
    const forge = driftIssueForge({ baseUrl: BASE, repo: "acme/governance", token: "t", tokenEnv: "FORGEJO_TOKEN", fetch: fake.forgeFetch });
    const records = [record("repo/acme/api", "drifted", { attributes: [{ path: "repo-variable[#api/REGION].value", sensitive: true }] })];
    expect((await keepGovernanceDriftIssue(forge, { environment, records })).action).toBe("opened");
    expect(fake.issues[0].body).toContain("`repo-variable[#api/REGION].value` (sensitive)");
  });
});

describe("drift issue helpers", () => {
  test("the target repository is the flag, else FORGEJO_REPOSITORY, else GITHUB_REPOSITORY", () => {
    expect(driftIssueRepo("acme/gov", { FORGEJO_REPOSITORY: "x/y" })).toBe("acme/gov");
    expect(driftIssueRepo(undefined, { FORGEJO_REPOSITORY: "x/y", GITHUB_REPOSITORY: "z/w" })).toBe("x/y");
    expect(driftIssueRepo(undefined, { GITHUB_REPOSITORY: "z/w" })).toBe("z/w");
    expect(driftIssueRepo(undefined, {})).toBeUndefined();
  });

  test("the environment is the instance host and the policy's orgs", () => {
    expect(driftIssueEnvironment("https://Forgejo.Example.com/", ["beta", "acme"])).toBe("forgejo.example.com/acme,beta");
  });

  test("the run URL comes from the Actions variables", () => {
    expect(driftIssueRunUrl({ FORGEJO_SERVER_URL: "https://f.example/", GITHUB_REPOSITORY: "acme/gov", GITHUB_RUN_ID: "7" })).toBe("https://f.example/acme/gov/actions/runs/7");
    expect(driftIssueRunUrl({ GITHUB_REPOSITORY: "acme/gov" })).toBeUndefined();
  });

  test("describes what was done in one line", () => {
    expect(describeDriftIssue({ action: "opened", number: 4, url: `${BASE}/acme/gov/issues/4`, marker: "m" })).toBe(`Drift issue: opened #4 ${BASE}/acme/gov/issues/4`);
    expect(describeDriftIssue({ action: "none", marker: "m" })).toBe("Drift issue: none");
  });

  test("the issue's records are the drift reader's", () => {
    const { records } = governanceDrift({
      member: "governance",
      observedAt: at,
      policy: { orgs: { acme: { repos: { api: {} } } } },
      changeSets: [{ org: "acme", entries: [{ kind: "update", resourceType: "repo", key: "api", before: {}, after: {}, fields: [{ field: "hasWiki", before: true, after: false }] }] }],
    });
    expect(records.map((r) => [r.address, r.status])).toEqual([
      ["org/acme", "in-sync"],
      ["repo/acme/api", "drifted"],
    ]);
  });
});

describe("forgejo-warden reconcile --drift-issue", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  class Exit extends Error {
    constructor(public readonly code: number) {
      super(`exit ${code}`);
    }
  }

  /** Run the CLI to its exit, collecting stdout and stderr. */
  async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exit(code ?? 0);
    }) as typeof process.exit);
    try {
      await run(argv);
      return { code: -1, out, err };
    } catch (e) {
      if (e instanceof Exit) return { code: e.code, out, err };
      throw e;
    } finally {
      vi.restoreAllMocks();
    }
  }

  function policy(): string {
    const dir = mkdtempSync(join(tmpdir(), "forgejo-warden-issue-"));
    dirs.push(dir);
    const path = join(dir, "governance.yml");
    writeFileSync(path, "orgs:\n  acme:\n    repos:\n      api:\n        hasWiki: false\n");
    return path;
  }

  test("a dry run with drift opens one issue, a second run leaves it, and a clean run closes it", async () => {
    vi.stubEnv("FORGEJO_TOKEN", "t0ken");
    vi.stubEnv("FORGEJO_REPOSITORY", "acme/governance");
    vi.stubEnv("GITHUB_REPOSITORY", "");
    const path = policy();
    const argv = ["reconcile", "--config", path, "--base-url", BASE, "--token-env", "FORGEJO_TOKEN", "--drift-issue"];

    const drifting = fakeForgejo("acme/governance", { "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api", has_wiki: true }] });
    vi.stubGlobal("fetch", drifting.globalFetch);
    const first = await cli(argv);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain(`Drift issue: opened #1 ${BASE}/acme/governance/issues/1`);
    const second = await cli(argv);
    expect(second.out).toContain("Drift issue: unchanged #1");
    expect(drifting.issues).toHaveLength(1);
    expect(drifting.issues[0].body).toContain("`repo/acme/api` | drifted");

    // The same forge, now matching the policy.
    const issues = drifting.issues;
    const clean = fakeForgejo("acme/governance", { "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api", has_wiki: false }] });
    clean.issues.push(...issues);
    vi.stubGlobal("fetch", clean.globalFetch);
    const third = await cli(argv);
    expect(third.code, third.err).toBe(0);
    expect(third.out).toContain("Drift issue: closed #1");
    expect(clean.issues[0].state).toBe("closed");
  });

  test("exits 2 with no repository to keep the issue in, before calling the forge", async () => {
    vi.stubEnv("FORGEJO_TOKEN", "t0ken");
    vi.stubEnv("FORGEJO_REPOSITORY", "");
    vi.stubEnv("GITHUB_REPOSITORY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await cli(["reconcile", "--config", policy(), "--base-url", BASE, "--token-env", "FORGEJO_TOKEN", "--drift-issue"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--drift-issue needs the repository");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("exits 3 when the forge refuses the issue", async () => {
    vi.stubEnv("FORGEJO_TOKEN", "t0ken");
    const drifting = fakeForgejo("acme/governance", { "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api", has_wiki: true }] });
    vi.stubGlobal("fetch", ((url: string | URL, init?: RequestInit) =>
      String(url).includes("/repos/acme/elsewhere/issues")
        ? Promise.resolve(new Response('{"message":"forbidden"}', { status: 403 }))
        : drifting.globalFetch(url, init)) as typeof fetch);
    const r = await cli(["reconcile", "--config", policy(), "--base-url", BASE, "--token-env", "FORGEJO_TOKEN", "--drift-issue", "--drift-issue-repo", "acme/elsewhere"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("keeping the drift issue failed");
  });

  test("exits 2 for --drift-issue with a cycle subset, which cannot say the forge matches", async () => {
    vi.stubEnv("FORGEJO_TOKEN", "t0ken");
    const r = await cli(["reconcile", "--config", policy(), "--base-url", BASE, "--token-env", "FORGEJO_TOKEN", "--drift-issue", "--drift-issue-repo", "acme/gov", "--cycles", "teams"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--cycles");
  });
});
