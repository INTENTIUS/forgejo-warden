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
import { driftAddress, driftRecords, readGovernanceDrift } from "./reader.js";

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
  test("is the graph reader's node id for the types it draws, and org-qualified for the rest", () => {
    expect(driftAddress("acme", { resourceType: "org-settings", key: "org-settings" })).toBe("org/acme");
    expect(driftAddress("acme", { resourceType: "repo", key: "api" })).toBe("repo/acme/api");
    expect(driftAddress("acme", { resourceType: "team", key: "core" })).toBe("team/acme/core");
    expect(driftAddress("acme", { resourceType: "branch-protection", key: "api/main" })).toBe("protection/acme/api/main");
    expect(driftAddress("acme", { resourceType: "team-member", key: "core/alice" })).toBe("team-member/acme/core/alice");
  });
});

describe("driftRecords", () => {
  test("maps create, update and delete to pending, drifted and undeclared, with the record's attribute direction", () => {
    const records = driftRecords({
      member: "forge",
      observedAt: at,
      changeSets: [
        {
          org: "acme",
          entries: [
            { kind: "create", resourceType: "team", key: "core", after: { permission: "read" } },
            { kind: "update", resourceType: "repo", key: "api", before: { hasWiki: true }, after: { hasWiki: false }, fields: [{ field: "hasWiki", before: true, after: false }] },
            { kind: "delete", resourceType: "member", key: "mallory", before: { username: "mallory" } },
          ],
        },
      ],
    });
    expect(records.map((r) => [r.address, r.status, r.resourceType, r.evidence.engineCode])).toEqual([
      ["team/acme/core", "pending", "team", "create"],
      ["repo/acme/api", "drifted", "repo", "update"],
      ["member/acme/mallory", "undeclared", "member", "delete"],
    ]);
    // before is the policy's value, after the forge's.
    expect(records[1].attributes).toEqual([{ path: "hasWiki", before: false, after: true }]);
    expect(records[0].attributes).toBeUndefined();
  });

  test("a cycle that errored or was deferred is a not-observed record", () => {
    const records = driftRecords({
      member: "forge",
      observedAt: at,
      changeSets: [],
      errored: [{ name: "teams", org: "acme", stage: "fetchLive", error: "GET /orgs/acme/teams returned 500" }],
      deferred: { skippedCycles: ["webhooks"], skippedEntries: [] },
    });
    expect(records.map((r) => [r.address, r.status, r.unobserved])).toEqual([
      ["cycle/acme/teams", "not-observed", { reason: "read-failed", detail: "fetchLive: GET /orgs/acme/teams returned 500" }],
      ["cycle/webhooks", "not-observed", { reason: "not-reached", detail: "the webhooks cycle was deferred by the request budget" }],
    ]);
  });
});

describe("readGovernanceDrift", () => {
  test("reports one record per planned change for a forge that differs from the policy", async () => {
    const dir = memberDir(POLICY);
    const client = makeClient(LIVE);
    const lines = checked(await readGovernanceDrift(input(dir), { env, createClient: () => client }));

    expect(lines[0]).toMatchObject({ type: "drift-start", member: "forge", engine: "warden", read: "plan", at, expected: [] });
    expect(lines.at(-1)).toMatchObject({ type: "drift-settle", member: "forge", engine: "warden", read: "plan", at, counts: { drifted: 2, pending: 1 } });
    const records = recordsOf(lines);
    expect(records.map((r) => [r.address, r.status])).toEqual([
      ["org/acme", "drifted"],
      ["repo/acme/api", "drifted"],
      ["team/acme/core", "pending"],
    ]);
    expect(records.every((r) => r.member === "forge" && r.observedAt === at && r.read === "plan" && r.engine === "warden")).toBe(true);
    expect(records[0].attributes).toEqual([{ path: "description", before: "Acme", after: "Old" }]);
    expect(records[0].evidence).toMatchObject({ tool: "forgejo-warden", command: "reconcile --mode dry-run" });
    // A dry run: nothing but reads.
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("reports no records, and zero counts, for a forge that matches", async () => {
    const dir = memberDir(CLEAN_POLICY);
    const lines = checked(await readGovernanceDrift(input(dir), { env, createClient: () => makeClient(CLEAN_LIVE) }));
    expect(recordsOf(lines)).toEqual([]);
    expect(lines.map((l) => l.type)).toEqual(["drift-start", "drift-settle"]);
    const settle = lines[1] as Extract<DriftLine, { type: "drift-settle" }>;
    expect(Object.values(settle.counts).every((n) => n === 0)).toBe(true);
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
    const failed = records.find((r) => r.address === "cycle/acme/repo-settings");
    expect(failed?.status).toBe("not-observed");
    expect(failed?.unobserved).toEqual({ reason: "read-failed", detail: "fetchLive: GET /orgs/acme/repos returned 500" });
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
    expect(await readGovernanceDrift(input(dir, { resource: "repo/acme/api" }), deps)).toEqual({ refused: { code: "resource-unsupported", message: expect.any(String) } });
    checked(await readGovernanceDrift(input(dir, { read: "plan" }), deps));
  });

  test("throws for a member with no policy, which chant reports as a failed read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forgejo-warden-drift-"));
    dirs.push(dir);
    mkdirSync(join(dir, "sub"));
    await expect(readGovernanceDrift(input(dir), { env, createClient: () => makeClient() })).rejects.toThrow(/no governance policy/);
  });
});
