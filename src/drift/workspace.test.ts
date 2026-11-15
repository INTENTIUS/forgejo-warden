/**
 * `chant workspace drift --member` over this package's kind: a throwaway chant
 * workspace pins the package (its kinds file and schema, and the drift reader
 * bundled the way `build:drift` bundles it), and chant's own
 * `readWorkspaceDrift` imports the reader and reads a forge-governance
 * member. Forgejo is a stubbed `fetch`; nothing leaves the process.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, test, vi } from "vitest";
import { driftReadDocument, readWorkspaceDrift } from "@intentius/chant/workspace/drift-cli";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A chant workspace with one forge-governance member, `forge` in `org/`, and this package installed. */
async function workspace(policy: string): Promise<string> {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "forgejo-warden-ws-")));
  dirs.push(ws);
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), text);
  };
  write(
    "chant.workspace.json",
    JSON.stringify({ name: "acme", schema: 1, pins: [{ package: pkg.name, version: pkg.version }], members: [{ name: "forge", dir: "org", kind: "forge-governance" }] }, null, 2),
  );
  write("org/governance.yml", policy);
  write(".gitignore", "node_modules\n");
  const installed = join(ws, "node_modules", ...pkg.name.split("/"));
  write(join("node_modules", ...pkg.name.split("/"), "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", exports: pkg.exports }));
  cpSync(join(root, "workspace-kinds.json"), join(installed, "workspace-kinds.json"));
  cpSync(join(root, "schemas"), join(installed, "schemas"), { recursive: true });
  await build({
    entryPoints: [join(root, "src/graph/entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
    outfile: join(installed, "dist/graph-reader.mjs"),
    logLevel: "silent",
  });
  await build({
    entryPoints: [join(root, "src/drift/entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
    external: ["@intentius/tsad-reference"],
    outfile: join(installed, "dist/drift-reader.mjs"),
    logLevel: "silent",
  });
  execFileSync("git", ["init", "-q"], { cwd: ws });
  return ws;
}

/** Forgejo, as a fetch: the routes given, an empty page for any other list, an empty object otherwise. */
function forgejo(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? "GET"} ${u.pathname.replace(/^\/api\/v1/, "")}${u.search}`;
    const body = key in routes ? routes[key] : u.searchParams.has("page") ? [] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const POLICY = `orgs:
  acme:
    repos:
      api:
        hasWiki: false
`;

describe("chant workspace drift over the forge-governance kind", () => {
  test("reports drift for a policy the forge differs from, and none for one it matches", async () => {
    vi.stubEnv("FORGEJO_URL", "https://forgejo.example.com");
    vi.stubEnv("FORGEJO_TOKEN", "t0ken");
    try {
      const ws = await workspace(POLICY);

      vi.stubGlobal("fetch", forgejo({ "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api", has_wiki: true }] }));
      const drifted = await readWorkspaceDrift({ cwd: ws, member: "forge" });
      if ("error" in drifted) throw new Error(`${drifted.error.code}: ${drifted.error.message}`);
      const doc = driftReadDocument("forge", drifted);
      expect(doc.records.map((r) => [r.member, r.engine, r.address, r.status, r.node])).toEqual([
        ["forge", "warden", "org/acme", "in-sync", "forge/org/acme"],
        ["forge", "warden", "repo/acme/api", "drifted", "forge/repo/acme/api"],
      ]);

      vi.stubGlobal("fetch", forgejo({ "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api", has_wiki: false }] }));
      const clean = await readWorkspaceDrift({ cwd: ws, member: "forge" });
      if ("error" in clean) throw new Error(`${clean.error.code}: ${clean.error.message}`);
      expect(driftReadDocument("forge", clean).records.map((r) => [r.address, r.status, r.node])).toEqual([
        ["org/acme", "in-sync", "forge/org/acme"],
        ["repo/acme/api", "in-sync", "forge/repo/acme/api"],
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  test("answers no-drift-read when the token variable is unset", async () => {
    vi.stubEnv("FORGEJO_URL", "https://forgejo.example.com");
    vi.stubEnv("FORGEJO_TOKEN", "");
    try {
      const ws = await workspace(POLICY);
      const answer = await readWorkspaceDrift({ cwd: ws, member: "forge" });
      expect("error" in answer && answer.error.code).toBe("no-drift-read");
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
