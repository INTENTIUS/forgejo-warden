/**
 * The forge-governance drift reader (INTENTIUS/chant#5068): what it returns
 * for a forge that differs from the policy, one that matches, a cycle that
 * fails and a missing credential, checked against chant's drift-reader
 * schema and its drift line codec. The Forgejo client is mocked.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { decodeDriftLine, type DriftLine, type DriftRecord } from "@intentius/chant/drift-record";
import type { DriftReaderInput, DriftReaderOutput } from "@intentius/chant/workspace/drift-reader";
import { makeClient } from "../cycles/_testutil.js";
import { driftAddress, driftAttributes, governanceDrift, planAddress, readGovernanceDrift } from "./reader.js";

const require = createRequire(import.meta.url);
const readSchema = (id: string) => JSON.parse(readFileSync(require.resolve(id), "utf-8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(readSchema("@intentius/chant/workspace/drift.schema.json"));
const validateOutput = ajv.compile(readSchema("@intentius/chant/workspace/drift-reader.schema.json"));

const at = "2026-11-14T09:00:00.000Z";
const env = { FORGEJO_URL: "https://forgejo.example.com", FORGEJO_TOKEN: "t0ken" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function memberDir(policy: string, file = "governance.yml"): string {
  const dir = mkdtempSync(join(tmpdir(), "forgejo-warden-drift-"));
  dirs.push(dir);
  writeFileSync(join(dir, file), policy);
  return dir;
}

const POLICY = `orgs:
  acme:
    settings:
      description: Acme
    repos:
      api:
        hasWiki: false
    teams:
      core:
        permission: read
`;

const CLEAN_POLICY = `orgs:
  acme:
    settings:
      description: Acme
    repos:
      api:
        hasWiki: false
`;

/** The forge: org description "Old", repo api with its wiki on, no teams. */
const LIVE = {
  "GET /orgs/acme": { username: "acme", description: "Old" },
  "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api", has_wiki: true }],
};
const CLEAN_LIVE = {
  "GET /orgs/acme": { username: "acme", description: "Acme" },
  "GET /orgs/acme/repos?limit=50&page=1": [{ name: "api", has_wiki: false }],
};

function input(dir: string, extra: Partial<DriftReaderInput> = {}): DriftReaderInput {
  return { dir, config: { dir, file: "governance.yml" }, member: "forge", observedAt: at, ...extra };
}

/** The output, checked the way chant checks it: the schema, then each line through the codec. */
function checked(out: DriftReaderOutput): DriftLine[] {
  expect(validateOutput(out), JSON.stringify(validateOutput.errors)).toBe(true);
  if (!("lines" in out)) throw new Error(`refused: ${JSON.stringify(out)}`);
  for (const line of out.lines) expect(decodeDriftLine(JSON.stringify(line))).toEqual(line);
  return out.lines;
}

const recordsOf = (lines: DriftLine[]): DriftRecord[] =>
  lines.filter((l) => l.type === "drift-record").map(({ type: _t, ...r }) => r as DriftRecord);

describe("driftAddress", () => {
  test("is the graph reader's node id each planned change falls under", () => {
    const at = (resourceType: string, key: string) => driftAddress("acme", { resourceType, key });
    expect(at("org-settings", "org-settings")).toBe("org/acme");
    expect(at("member", "alice")).toBe("org/acme");
    expect(at("org-webhook", "https://hooks.example.com/x")).toBe("org/acme");
    expect(at("repo", "api")).toBe("repo/acme/api");
    expect(at("repo-baseline", "api")).toBe("repo/acme/api");
    expect(at("repo-webhook", "api/https://hooks.example.com/x")).toBe("repo/acme/api");
    expect(at("repo-variable", "api/REGION")).toBe("repo/acme/api");
    expect(at("team", "core")).toBe("team/acme/core");
    expect(at("team-member", "core/alice")).toBe("team/acme/core");
    expect(at("team-repo", "core/api")).toBe("team/acme/core");
    expect(at("branch-protection", "api/release/*")).toBe("protection/acme/api/release/*");
  });
});

describe("planAddress", () => {
  const at = (resourceType: string, key: string, org = "acme") => planAddress(org, { resourceType, key });

  test("is the bare node id for the node's own type", () => {
    expect(at("org-settings", "org-settings")).toBe("org/acme");
    expect(at("repo", "api")).toBe("repo/acme/api");
    expect(at("team", "core")).toBe("team/acme/core");
    expect(at("branch-protection", "api/release/*")).toBe("protection/acme/api/release/*");
  });

  test("is <node id>#<resourceType>[<key>] for a change under the node", () => {
    expect(at("member", "alice")).toBe("org/acme#member[alice]");
    expect(at("org-webhook", "https://hooks.example.com/x")).toBe("org/acme#org-webhook[https://hooks.example.com/x]");
    expect(at("org-secret", "TOKEN")).toBe("org/acme#org-secret[TOKEN]");
    expect(at("repo-baseline", "api")).toBe("repo/acme/api#repo-baseline[api]");
    expect(at("repo-variable", "api/REGION")).toBe("repo/acme/api#repo-variable[api/REGION]");
    expect(at("team-member", "core/alice")).toBe("team/acme/core#team-member[core/alice]");
    expect(at("team-repo", "core/api")).toBe("team/acme/core#team-repo[core/api]");
  });

  test("starts with the node driftAddress gives, before the first #", () => {
    for (const [resourceType, key] of [["member", "alice"], ["repo", "api"], ["repo-secret", "api/TOKEN"], ["team-repo", "core/api"]]) {
      expect(at(resourceType, key).split("#")[0]).toBe(driftAddress("acme", { resourceType, key }));
    }
  });

  test("keeps two orgs' same-named repos apart", () => {
    expect(at("repo", "api", "acme")).not.toBe(at("repo", "api", "globex"));
    expect(at("repo-secret", "api/TOKEN", "acme")).not.toBe(at("repo-secret", "api/TOKEN", "globex"));
  });
});

describe("driftAttributes", () => {
  test("an update gives one attribute per field, declared before and live after", () => {
    expect(
      driftAttributes({ kind: "update", resourceType: "repo", key: "api", before: {}, after: {}, fields: [{ field: "hasWiki", before: true, after: false }] }),
    ).toEqual([{ path: "repo[#api].hasWiki", before: false, after: true }]);
    expect(driftAttributes({ kind: "update", resourceType: "org-settings", key: "org-settings", fields: [{ field: "description", before: "Old", after: "Acme" }] })).toEqual([
      { path: "org-settings.description", before: "Acme", after: "Old" },
    ]);
  });

  test("a create carries the declared value, a delete the live one", () => {
    expect(driftAttributes({ kind: "create", resourceType: "team-member", key: "core/alice", after: { username: "alice" } })).toEqual([
      { path: "team-member[#core/alice]", before: { username: "alice" } },
    ]);
    expect(driftAttributes({ kind: "delete", resourceType: "member", key: "mallory", before: { username: "mallory" } })).toEqual([
      { path: "member[#mallory]", after: { username: "mallory" } },
    ]);
  });

  test("a type whose values can hold a secret carries none", () => {
    expect(driftAttributes({ kind: "update", resourceType: "repo-variable", key: "api/REGION", fields: [{ field: "value", before: "a", after: "b" }] })).toEqual([
      { path: "repo-variable[#api/REGION].value", sensitive: true },
    ]);
    expect(driftAttributes({ kind: "create", resourceType: "org-webhook", key: "https://x", after: { url: "https://x", secret: "s" } })).toEqual([
      { path: "org-webhook[#https://x]", sensitive: true },
    ]);
  });
});

describe("governanceDrift", () => {
  const policy = { orgs: { acme: { repos: { api: {}, web: {} }, teams: { core: { permission: "read" as const } } } } };

  test("names every declared node, in-sync unless a planned change falls under it", () => {
    const { start, records } = governanceDrift({
      member: "forge",
      observedAt: at,
      policy,
      changeSets: [
        { org: "acme", entries: [{ kind: "create", resourceType: "team-member", key: "core/alice", after: { username: "alice" } }] },
        { org: "acme", entries: [{ kind: "update", resourceType: "repo", key: "api", fields: [{ field: "hasWiki", before: true, after: false }] }] },
      ],
    });
    expect(start.expected).toEqual(["org/acme", "repo/acme/api", "repo/acme/web", "team/acme/core"]);
    expect(records.map((r) => [r.address, r.status, r.attributes?.map((a) => a.path)])).toEqual([
      ["org/acme", "in-sync", undefined],
      ["repo/acme/api", "drifted", ["repo[#api].hasWiki"]],
      ["repo/acme/web", "in-sync", undefined],
      ["team/acme/core", "drifted", ["team-member[#core/alice]"]],
    ]);
  });

  test("a cycle that errored leaves its org's nodes not-observed, or drifted with attributesUnobserved where others found drift", () => {
    const { records } = governanceDrift({
      member: "forge",
      observedAt: at,
      policy,
      changeSets: [{ org: "acme", entries: [{ kind: "update", resourceType: "repo", key: "api", fields: [{ field: "hasWiki", before: true, after: false }] }] }],
      errored: [{ name: "teams", org: "acme", stage: "fetchLive", error: "GET /orgs/acme/teams returned 500" }],
    });
    const why = { reason: "read-failed", detail: "teams errored in fetchLive: GET /orgs/acme/teams returned 500" };
    expect(records.find((r) => r.address === "team/acme/core")).toMatchObject({ status: "not-observed", unobserved: why });
    expect(records.find((r) => r.address === "repo/acme/api")).toMatchObject({ status: "drifted", attributesUnobserved: why });
    expect(records.some((r) => r.status === "in-sync")).toBe(false);
  });

  test("a deferred cycle leaves every node not-observed", () => {
    const { records } = governanceDrift({ member: "forge", observedAt: at, policy, changeSets: [], deferred: { skippedCycles: ["webhooks"], skippedEntries: [] } });
    expect(new Set(records.map((r) => r.status))).toEqual(new Set(["not-observed"]));
    expect(records[0].unobserved).toEqual({ reason: "not-reached", detail: "deferred by the request budget: webhooks" });
  });

  test("a change under a node the graph does not draw is a record of its own", () => {
    const { records } = governanceDrift({
      member: "forge",
      observedAt: at,
      policy,
      changeSets: [{ org: "acme", entries: [{ kind: "create", resourceType: "repo-baseline", key: "new", after: { name: "new" } }] }],
    });
    expect(records.find((r) => r.address === "repo/acme/new")).toMatchObject({ status: "drifted", attributes: [{ path: "repo-baseline[#new]", before: { name: "new" } }] });
  });
});

describe("readGovernanceDrift", () => {
  test("reports a drifted record for each node a forge that differs from the policy has drift under", async () => {
    const dir = memberDir(POLICY);
    const client = makeClient(LIVE);
    const lines = checked(await readGovernanceDrift(input(dir), { env, createClient: () => client }));

    expect(lines[0]).toMatchObject({
      type: "drift-start",
      member: "forge",
      engine: "warden",
      read: "live-read",
      at,
      expected: ["org/acme", "repo/acme/api", "team/acme/core"],
    });
    expect(lines.at(-1)).toMatchObject({ type: "drift-settle", member: "forge", engine: "warden", read: "live-read", at, counts: { drifted: 3 }, notReached: [] });
    const records = recordsOf(lines);
    expect(records.map((r) => [r.address, r.status, r.attributes])).toEqual([
      ["org/acme", "drifted", [{ path: "org-settings.description", before: "Acme", after: "Old" }]],
      ["repo/acme/api", "drifted", [{ path: "repo[#api].hasWiki", before: false, after: true }]],
      ["team/acme/core", "drifted", [{ path: "team[#core]", before: expect.objectContaining({ permission: "read" }) }]],
    ]);
    expect(records.every((r) => r.member === "forge" && r.observedAt === at && r.read === "live-read" && r.engine === "warden" && r.node === null)).toBe(true);
    expect(records[0].evidence).toMatchObject({ tool: "forgejo-warden", command: "reconcile --mode dry-run" });
    // A dry run: nothing but reads.
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("reports every node in-sync for a forge that matches", async () => {
    const dir = memberDir(CLEAN_POLICY);
    const lines = checked(await readGovernanceDrift(input(dir), { env, createClient: () => makeClient(CLEAN_LIVE) }));
    expect(recordsOf(lines).map((r) => [r.address, r.status])).toEqual([
      ["org/acme", "in-sync"],
      ["repo/acme/api", "in-sync"],
    ]);
    expect(lines.at(-1)).toMatchObject({ type: "drift-settle", counts: { "in-sync": 2, drifted: 0, "not-observed": 0 } });
  });

  test("a cycle that fails gives a not-observed record, never a clean read", async () => {
    const dir = memberDir(CLEAN_POLICY);
    const client = makeClient({
      ...CLEAN_LIVE,
      "GET /orgs/acme/repos?limit=50&page=1": () => {
        throw new Error("GET /orgs/acme/repos returned 500");
      },
    });
    const records = recordsOf(checked(await readGovernanceDrift(input(dir), { env, createClient: () => client })));
    expect(records.map((r) => r.status)).toEqual(["not-observed", "not-observed"]);
    expect(records[0].unobserved?.reason).toBe("read-failed");
    expect(records[0].unobserved?.detail).toContain("repo-settings errored in fetchLive: GET /orgs/acme/repos returned 500");
  });

  test("uses the credential variables the kind's config names", async () => {
    const dir = memberDir(CLEAN_POLICY);
    let seen: { baseUrl: string; token: string } | undefined;
    const out = await readGovernanceDrift(input(dir, { config: { file: "governance.yml", tokenEnv: "MY_TOKEN", baseUrlEnv: "MY_URL" } }), {
      env: { MY_URL: "https://git.example.org", MY_TOKEN: "abc" },
      createClient: (opts) => {
        seen = opts;
        return makeClient(CLEAN_LIVE);
      },
    });
    checked(out);
    expect(seen).toEqual({ baseUrl: "https://git.example.org", token: "abc" });
  });

  test("refuses with no-drift-read when a credential is missing, without calling the forge", async () => {
    const dir = memberDir(CLEAN_POLICY);
    const client = makeClient(CLEAN_LIVE);
    for (const e of [{ FORGEJO_URL: "https://forgejo.example.com" }, { FORGEJO_TOKEN: "t0ken" }, { FORGEJO_URL: " ", FORGEJO_TOKEN: "t0ken" }]) {
      const out = await readGovernanceDrift(input(dir), { env: e, createClient: () => client });
      expect(validateOutput(out), JSON.stringify(validateOutput.errors)).toBe(true);
      expect(out).toEqual({ refused: { code: "no-drift-read", message: expect.stringMatching(/^FORGEJO_(TOKEN|URL) is not set/) } });
    }
    expect(client.calls).toEqual([]);
  });

  test("refuses a read, stack or resource it has not got", async () => {
    const dir = memberDir(CLEAN_POLICY);
    const deps = { env, createClient: () => makeClient(CLEAN_LIVE) };
    expect(await readGovernanceDrift(input(dir, { read: "state" }), deps)).toEqual({ refused: { code: "read-unsupported", message: expect.any(String) } });
    expect(await readGovernanceDrift(input(dir, { stack: "prod" }), deps)).toEqual({ refused: { code: "read-unsupported", message: expect.any(String) } });
    expect(await readGovernanceDrift(input(dir, { read: "plan" }), deps)).toEqual({ refused: { code: "read-unsupported", message: expect.any(String) } });
    checked(await readGovernanceDrift(input(dir, { read: "live-read" }), deps));
  });

  test("reads one declared node alone with --resource, and refuses an undeclared one", async () => {
    const dir = memberDir(POLICY);
    const lines = checked(await readGovernanceDrift(input(dir, { resource: "repo/acme/api" }), { env, createClient: () => makeClient(LIVE) }));
    expect(lines[0]).toMatchObject({ type: "drift-start", resource: "repo/acme/api", expected: ["repo/acme/api"] });
    expect(recordsOf(lines).map((r) => [r.address, r.status])).toEqual([["repo/acme/api", "drifted"]]);
    const out = await readGovernanceDrift(input(dir, { resource: "repo/acme/nope" }), { env, createClient: () => makeClient(LIVE) });
    expect(out).toEqual({ refused: { code: "no-drift-read", message: expect.stringContaining("declares no repo/acme/nope") } });
  });

  test("refuses with no-drift-read for a member with no policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forgejo-warden-drift-"));
    dirs.push(dir);
    mkdirSync(join(dir, "sub"));
    expect(await readGovernanceDrift(input(dir), { env, createClient: () => makeClient() })).toEqual({
      refused: { code: "no-drift-read", message: expect.stringContaining("has no governance policy") },
    });
  });

  test("throws for a policy that does not load, which chant reports as a failed read", async () => {
    const dir = memberDir("orgs: {acme: [unclosed\n");
    await expect(readGovernanceDrift(input(dir), { env, createClient: () => makeClient() })).rejects.toThrow();
  });
});
