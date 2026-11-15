/**
 * The drift reader for a forge-governance member (INTENTIUS/chant#5068).
 *
 * `chant workspace drift --member <name>` imports `dist/drift-reader.mjs`
 * (`./entry.ts`) for a member of the `forge-governance` kind and calls it
 * with the member's directory. The reader loads the member's policy, runs
 * every registered cycle in dry-run against the Forgejo instance, and answers
 * with drift stream lines: a start naming every node the graph reader draws
 * for the policy, one record per node, and a settle. It never applies
 * anything.
 *
 * A record is one graph node (chant places a `warden` record by its address,
 * so the address is the node id): `in-sync` when no planned change falls
 * under it, `drifted` when some do, each planned change one attribute. A
 * change under a node the graph does not draw (a repo baseline for a repo the
 * policy does not list) is a record of its own with no node.
 *
 * `reconcile --drift-issue` builds its records with {@link governanceDrift}
 * too, so the drift issue and `chant workspace drift` report the same thing.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  driftRecord,
  driftRecordLine,
  driftSettle,
  driftStart,
  type DriftAttribute,
  type DriftEvidence,
  type DriftLine,
  type DriftRecord,
  type DriftStartLine,
  type DriftUnobserved,
} from "@intentius/chant/drift-record";
import type { DriftReaderInput, DriftReaderOutput } from "@intentius/chant/workspace/drift-reader";
import type { CycleError, DeferredWork } from "@intentius/chant/reconcile";
import { createClient, type ForgejoClient } from "../auth/client.js";
import { CYCLE_REGISTRY } from "../cli/registry.js";
import { loadGovernancePolicy } from "../config/load.js";
import { resolveConfigPath } from "../config/resolve.js";
import type { GovernanceConfig } from "../config/types.js";
import { readGovernance } from "../graph/reader.js";
import type { ChangeSet, ChangeSetEntry } from "../reconcile/diff.js";
import { runReconcile, type Cycle } from "../reconcile/runner.js";
import pkg from "../../package.json" with { type: "json" };

/** The engine a warden's records name. */
export const DRIFT_ENGINE = "warden" as const;
/** The read a warden answers: its own read of the forge, compared with the policy. */
export const DRIFT_READ = "live-read" as const;
/** The env vars the reader takes its credentials from, unless the kind's config names others. */
export const DEFAULT_TOKEN_ENV = "FORGEJO_TOKEN";
export const DEFAULT_BASE_URL_ENV = "FORGEJO_URL";

/** What every record and the start line say produced them. */
export function driftEvidence(): DriftEvidence {
  return { tool: "forgejo-warden", version: pkg.version, command: "reconcile --mode dry-run" };
}

/** The first segment of a child entry's key, which names its parent (`core/alice` is team `core`'s). */
const parentOf = (key: string): string => key.split("/")[0];

/**
 * The graph node a planned change falls under: the graph reader's id
 * (`../graph/reader.ts`) for the org, a repo, a team or a branch protection
 * rule. Org-level collections go on the org, a team's members and repos on
 * the team, a repo's webhooks, secrets and variables on the repo.
 */
export function driftAddress(org: string, entry: Pick<ChangeSetEntry, "resourceType" | "key">): string {
  switch (entry.resourceType) {
    case "org-settings":
    case "org-secret":
    case "org-variable":
    case "org-webhook":
    case "member":
      return `org/${org}`;
    case "team":
      return `team/${org}/${entry.key}`;
    case "team-member":
    case "team-repo":
      return `team/${org}/${parentOf(entry.key)}`;
    case "repo":
    case "repo-baseline":
      return `repo/${org}/${entry.key}`;
    case "repo-webhook":
    case "repo-secret":
    case "repo-variable":
      return `repo/${org}/${parentOf(entry.key)}`;
    case "branch-protection":
      return `protection/${org}/${entry.key}`;
    default:
      return `${entry.resourceType}/${org}/${entry.key}`;
  }
}

/** Resource types whose values can hold a secret: their attributes carry no values. */
const SENSITIVE_TYPES = new Set(["org-secret", "repo-secret", "org-variable", "repo-variable", "org-webhook", "repo-webhook"]);

/** Single-object slices: their attribute path is the type alone. */
const SINGLE_TYPES = new Set(["org-settings"]);

/**
 * A planned change as attributes, in the drift record's direction (`before`
 * the declared value, `after` the live one): an update gives one per field
 * (`repo[#api].hasWiki`), a create its declared value, a delete its live one.
 */
export function driftAttributes(entry: ChangeSetEntry): DriftAttribute[] {
  const base = SINGLE_TYPES.has(entry.resourceType) ? entry.resourceType : `${entry.resourceType}[#${entry.key}]`;
  const sensitive = SENSITIVE_TYPES.has(entry.resourceType);
  const attr = (path: string, before: unknown, after: unknown): DriftAttribute =>
    sensitive
      ? { path, sensitive: true }
      : { path, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
  if (entry.kind === "update" && entry.fields?.length) return entry.fields.map((f) => attr(`${base}.${f.field}`, f.after, f.before));
  if (entry.kind === "delete") return [attr(base, undefined, entry.before)];
  return [attr(base, entry.after, undefined)];
}

export interface GovernanceDriftInput {
  member: string;
  /** RFC 3339, given to every record. */
  observedAt: string;
  /** The policy the run reconciled, for the nodes it declares. */
  policy: GovernanceConfig;
  /** Every change set the run diffed, one per cycle and org. */
  changeSets: readonly ChangeSet[];
  /** Cycles that failed before they could plan. */
  errored?: readonly CycleError[];
  /** Cycles the request budget skipped. */
  deferred?: DeferredWork;
  /** One node to read alone (`--resource`); its record is the only one. */
  resource?: string;
}

/** The node ids the graph reader draws for the policy, by org. */
export function declaredNodes(policy: GovernanceConfig): Record<string, string[]> {
  return readGovernance(policy).groups.byStack;
}

/**
 * The read as a start line and its records: every declared node in-sync,
 * drifted (each planned change under it an attribute) or not-observed (a
 * cycle errored in its org, or the budget deferred one).
 */
export function governanceDrift(input: GovernanceDriftInput): { start: DriftStartLine; records: DriftRecord[] } {
  const evidence = driftEvidence();
  const base = { member: input.member, engine: DRIFT_ENGINE, node: null, observedAt: input.observedAt, read: DRIFT_READ, evidence };
  const byOrg = declaredNodes(input.policy);
  const declared = Object.values(byOrg).flat();
  const orgOf = new Map(Object.entries(byOrg).flatMap(([org, ids]) => ids.map((id) => [id, org] as const)));

  const attributes = new Map<string, DriftAttribute[]>();
  for (const cs of input.changeSets) {
    for (const entry of cs.entries) {
      const address = driftAddress(cs.org, entry);
      if (!orgOf.has(address)) orgOf.set(address, cs.org);
      attributes.set(address, [...(attributes.get(address) ?? []), ...driftAttributes(entry)]);
    }
  }

  const failedIn = new Map<string, string[]>();
  for (const e of input.errored ?? []) failedIn.set(e.org, [...(failedIn.get(e.org) ?? []), `${e.name} errored in ${e.stage}: ${e.error}`]);
  const deferred = input.deferred?.skippedCycles ?? [];
  const deferredWhy: DriftUnobserved | undefined = deferred.length
    ? { reason: "not-reached", detail: `deferred by the request budget: ${deferred.join(", ")}` }
    : undefined;

  const addresses = [...new Set([...declared, ...attributes.keys()])].filter((a) => input.resource === undefined || a === input.resource);
  const records = addresses.map((address) => {
    const attrs = attributes.get(address);
    const failed = failedIn.get(orgOf.get(address) ?? "");
    const unobserved: DriftUnobserved | undefined = deferredWhy ?? (failed ? { reason: "read-failed", detail: failed.join("; ") } : undefined);
    if (unobserved && (deferredWhy || !attrs)) return driftRecord({ ...base, address, status: "not-observed", unobserved });
    if (attrs) return driftRecord({ ...base, address, status: "drifted", attributes: attrs, ...(unobserved ? { attributesUnobserved: unobserved } : {}) });
    return driftRecord({ ...base, address, status: "in-sync" });
  });

  const start = driftStart({
    member: input.member,
    engine: DRIFT_ENGINE,
    read: DRIFT_READ,
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
    at: input.observedAt,
    expected: input.resource !== undefined ? [input.resource] : declared,
    evidence,
  });
  return { start, records };
}

/** The stream for one read: start, the records, settle. */
export function driftLines(start: DriftStartLine, records: readonly DriftRecord[], at: string): DriftLine[] {
  const settled = driftSettle(start, records, at);
  return [start, ...settled.records.map(driftRecordLine), settled.line];
}

export interface ReadGovernanceDriftDeps {
  /** The environment credentials come from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Builds the Forgejo client. Default {@link createClient}. */
  createClient?: (opts: { baseUrl: string; token: string }) => ForgejoClient;
  /** The cycles to run. Default every registered cycle. */
  cycles?: Cycle[];
}

const refuse = (code: "read-unsupported" | "resource-unsupported" | "no-drift-read", message: string): DriftReaderOutput => ({ refused: { code, message } });

const configString = (config: Record<string, unknown>, key: string, fallback: string): string => {
  const v = config[key];
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
};

/**
 * Read a forge-governance member's drift. Refuses, without throwing, a read
 * or stack it does not have, a missing credential or policy, and a
 * `--resource` the policy does not declare. A policy that does not load
 * throws, which chant reports as a failed read.
 */
export async function readGovernanceDrift(input: DriftReaderInput, deps: ReadGovernanceDriftDeps = {}): Promise<DriftReaderOutput> {
  if (input.read !== undefined && input.read !== DRIFT_READ) {
    return refuse("read-unsupported", `forgejo-warden answers the ${DRIFT_READ} read only (a reconcile dry run), not ${input.read}`);
  }
  if (input.stack !== undefined) return refuse("read-unsupported", "forgejo-warden has no stacks; a governance member is read whole");

  const env = deps.env ?? process.env;
  const config = input.config ?? {};
  const tokenEnv = configString(config, "tokenEnv", DEFAULT_TOKEN_ENV);
  const baseUrlEnv = configString(config, "baseUrlEnv", DEFAULT_BASE_URL_ENV);
  const token = env[tokenEnv]?.trim();
  if (!token) return refuse("no-drift-read", `${tokenEnv} is not set; forgejo-warden reads its Forgejo API token from it to read ${input.member}'s drift`);
  const baseUrl = env[baseUrlEnv]?.trim();
  if (!baseUrl) return refuse("no-drift-read", `${baseUrlEnv} is not set; forgejo-warden reads the Forgejo instance URL from it to read ${input.member}'s drift`);

  const dir = resolve(input.dir);
  const named = join(dir, configString(config, "file", "governance.yml"));
  const path = existsSync(named) ? named : resolveConfigPath(undefined, dir);
  if (!path) return refuse("no-drift-read", `${input.member} has no governance policy: neither ${named} nor governance.ts exists`);
  const { config: policy } = await loadGovernancePolicy(path, "fold");

  let scope = policy;
  if (input.resource !== undefined) {
    const org = Object.entries(declaredNodes(policy)).find(([, ids]) => ids.includes(input.resource!))?.[0];
    if (org === undefined) return refuse("no-drift-read", `${input.member}'s policy declares no ${input.resource}`);
    // A node's drift is its org's: reconcile that org alone.
    scope = { ...policy, orgs: { [org]: policy.orgs[org] } };
  }

  const client = (deps.createClient ?? createClient)({ baseUrl, token });
  const result = await runReconcile({ config: scope, client, cycles: deps.cycles ?? Object.values(CYCLE_REGISTRY), mode: "dry-run" });
  const { start, records } = governanceDrift({
    member: input.member,
    observedAt: input.observedAt,
    policy: scope,
    changeSets: result.changeSets,
    errored: result.errored,
    deferred: result.deferred,
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
  });
  return { lines: driftLines(start, records, input.observedAt) };
}
