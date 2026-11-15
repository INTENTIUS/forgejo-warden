/**
 * `forgejo-warden repos`: the written list reads back through chant's
 * `--forge-repos` parser, and against an org workspace it gives WSP014 for a
 * repository the declaration lacks and WSP015 for one the forge no longer
 * has. The Forgejo client is mocked the way the cycle tests do it.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForgeRepos } from "@intentius/chant/workspace/checks/org";
import { runDeclarationChecks } from "@intentius/chant/workspace/checks";
import { makeClient } from "./cycles/_testutil.js";
import { forgeRepoList, listOrgRepos, pickOrg } from "./repos.js";
import { parseReposArgs } from "./cli.js";

const BASE = "https://forgejo.example.com";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const repo = (name: string, archived = false) => ({ name, full_name: `acme/${name}`, html_url: `${BASE}/acme/${name}`, archived });

/** acme has api, web and an archived legacy repo. */
const client = () =>
  makeClient({
    "GET /orgs/acme/repos?limit=50&page=1": [repo("web"), repo("legacy", true), repo("api")],
  });

/** What the CLI writes: the document as JSON text. */
const written = async () => `${JSON.stringify(await forgeRepoList(client(), "acme", BASE), null, 2)}\n`;

/** An org workspace whose repo members name these URLs. */
function orgWorkspace(urls: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fw-repos-"));
  const members = Object.entries(urls).map(([name, url]) => ({ name, kind: "repo", repo: { url, rev: SHA } }));
  writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, scope: "org", members }));
  return root;
}

async function forgeFindings(root: string, text: string) {
  const report = await runDeclarationChecks(root, (f) => f, { forgeRepos: parseForgeRepos(text, "forge.json") });
  return report.diagnostics.filter((d) => d.ruleId === "WSP014" || d.ruleId === "WSP015");
}

describe("forgeRepoList", () => {
  it("writes { forge, org, repos } sorted by url, archived repos marked", async () => {
    expect(JSON.parse(await written())).toEqual({
      forge: "forgejo",
      org: "acme",
      repos: [
        { url: `${BASE}/acme/api` },
        { url: `${BASE}/acme/legacy`, archived: true },
        { url: `${BASE}/acme/web` },
      ],
    });
  });

  it("reads back through chant's --forge-repos parser", async () => {
    expect(parseForgeRepos(await written(), "forge.json").repos).toEqual([
      { url: `${BASE}/acme/api`, archived: false },
      { url: `${BASE}/acme/legacy`, archived: true },
      { url: `${BASE}/acme/web`, archived: false },
    ]);
  });

  it("passes chant workspace check against an org workspace with the same repos", async () => {
    // Clone URLs in the declaration: chant compares by host, owner and name.
    const root = orgWorkspace({ api: `${BASE}/acme/api.git`, web: "git@forgejo.example.com:acme/web.git" });
    expect(await forgeFindings(root, await written())).toEqual([]);
  });

  it("gives WSP014 for a repo the declaration lacks and WSP015 for one the forge no longer has", async () => {
    const root = orgWorkspace({ api: `${BASE}/acme/api.git`, gone: `${BASE}/acme/gone.git` });
    const findings = await forgeFindings(root, await written());
    expect(findings.map((d) => d.ruleId).sort()).toEqual(["WSP014", "WSP015"]);
    expect(findings.find((d) => d.ruleId === "WSP014")!.message).toContain(`${BASE}/acme/web`);
    expect(findings.find((d) => d.ruleId === "WSP015")!.entity).toBe("gone");
  });

  it("falls back to <baseUrl>/<full_name> when the instance leaves out html_url", async () => {
    const c = makeClient({ "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api", full_name: "acme/api" }] });
    expect((await forgeRepoList(c, "acme", `${BASE}/`)).repos).toEqual([{ url: `${BASE}/acme/api` }]);
  });
});

describe("listOrgRepos", () => {
  it("pages until a short page", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => repo(`r${i}`));
    const c = makeClient({
      "GET /orgs/acme/repos?limit=50&page=1": page1,
      "GET /orgs/acme/repos?limit=50&page=2": [repo("r50")],
    });
    expect(await listOrgRepos(c, "acme")).toHaveLength(51);
    expect(c.calls).toHaveLength(2);
  });

  it("throws on a 404 instead of reading a missing org as empty", async () => {
    const c = makeClient({
      "GET /orgs/ghost/repos?limit=50&page=1": () => {
        throw new Error("GET /orgs/ghost/repos returned 404");
      },
    });
    await expect(listOrgRepos(c, "ghost")).rejects.toThrow(/404/);
  });
});

describe("pickOrg", () => {
  it("takes the policy's only org, or the --org the policy governs", () => {
    expect(pickOrg(["acme"], undefined)).toBe("acme");
    expect(pickOrg(["acme", "beta"], "beta")).toBe("beta");
  });
  it("refuses several orgs without --org, an --org the policy lacks, and no orgs", () => {
    expect(() => pickOrg(["acme", "beta"], undefined)).toThrow(/--org/);
    expect(() => pickOrg(["acme"], "other")).toThrow(/not an org the policy governs/);
    expect(() => pickOrg([], undefined)).toThrow(/no org/);
  });
});

describe("parseReposArgs", () => {
  const base = ["--config", "g.yml", "--base-url", "u", "--token-env", "T"];
  it("parses --org and --out, both optional", () => {
    expect(parseReposArgs(base)).toMatchObject({ config: "g.yml", org: undefined, out: undefined, configMode: "fold" });
    expect(parseReposArgs([...base, "--org", "acme", "--out", "repos.json"])).toMatchObject({ org: "acme", out: "repos.json" });
    expect(parseReposArgs(["--config", "g.ts", "--base-url-env", "U", "--token-env", "T", "--config-mode", "run"])).toMatchObject({ baseUrlEnv: "U", configMode: "run" });
  });
  it("throws code 2 on missing config, url or token, reconcile flags and empty values", () => {
    const bad = (argv: string[]) => expect(() => parseReposArgs(argv)).toThrow(expect.objectContaining({ code: 2 }));
    bad(["--base-url", "u", "--token-env", "T"]);
    bad(["--config", "g.yml", "--token-env", "T"]);
    bad(["--config", "g.yml", "--base-url", "u"]);
    bad([...base, "--mode", "apply"]);
    bad([...base, "--out"]);
    bad([...base, "--org", ""]);
    bad([...base, "stray"]);
  });
});
