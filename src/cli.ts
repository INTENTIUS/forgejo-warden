#!/usr/bin/env node
/**
 * forgejo-warden — governance reconcile CLI.
 *
 * Subcommands:
 *   reconcile   Load config, build an authed client, run selected cycles.
 *               `--plan-json <file>` also writes the plan as a chant
 *               change-set part; `--drift-issue` keeps one forge issue
 *               tracking the drift a dry run finds.
 *   repos       Write the policy's org's repository list in the format
 *               `chant workspace check --forge-repos` reads.
 *
 * Auth is a Forgejo API token + the instance base URL (self-hosted):
 *   --base-url <url> | --base-url-env <VAR>     Forgejo instance URL
 *   --token-env <VAR>                           env var holding the API token
 *
 * Exit codes: 0 success · 1 guardrail block (apply) · 2 arg/config error ·
 *             3 runtime error.
 */

import { pathToFileURL } from "node:url";
import { loadGovernancePolicy, type ConfigMode } from "./config/load.js";
import { resolveConfigPath } from "./config/resolve.js";
import { createClient } from "./auth/client.js";
import { writeFileSync } from "node:fs";
import { runReconcile, type Cycle } from "./reconcile/runner.js";
import { defaultMemberName, planPart } from "./reconcile/plan-part.js";
import { forgeRepoList, pickOrg } from "./repos.js";
import { governanceDrift } from "./drift/reader.js";
import {
  describeDriftIssue,
  driftIssueEnvironment,
  driftIssueForge,
  driftIssueRepo,
  driftIssueRunUrl,
  isRepoName,
  keepGovernanceDriftIssue,
} from "./drift/issue.js";
import { CYCLE_REGISTRY } from "./cli/registry.js";
import type { GovernanceConfig } from "./config/types.js";
import type { PolicyProvenance } from "./reconcile/origin.js";
import pkg from "../package.json" with { type: "json" };

/** Inlined from package.json at build time — always matches the published version. */
const VERSION: string = pkg.version;

export class CliError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface ReconcileArgs {
  /** `--config`; undefined reads governance.yml (or governance.ts) in the working directory. */
  config: string | undefined;
  /** How a `.ts` policy is evaluated: folded without running (default), imported, or both and compared. */
  configMode: ConfigMode;
  mode: "dry-run" | "apply";
  cycles: string[];
  baseUrl: string | undefined;
  baseUrlEnv: string | undefined;
  tokenEnv: string | undefined;
  allowGuardrailOverride: boolean;
  /** Removal-cap threshold in (0,1]; undefined leaves chant's default (0.25). */
  removalCapFraction: number | undefined;
  /** File to write the run's plan to, as a chant change-set part. */
  planJson: string | undefined;
  /** The workspace member the part and the drift records name; undefined defaults to the policy directory's name. */
  member: string | undefined;
  /** Keep one forge issue tracking the drift this dry run finds. */
  driftIssue: boolean;
  /** `owner/name` of the repository the drift issue lives in; undefined reads the Actions environment. */
  driftIssueRepo: string | undefined;
}

const KNOWN_FLAGS = new Set([
  "--config",
  "--config-mode",
  "--mode",
  "--cycles",
  "--base-url",
  "--base-url-env",
  "--token-env",
  "--allow-guardrail-override",
  "--removal-cap-fraction",
  "--plan-json",
  "--member",
  "--drift-issue",
  "--drift-issue-repo",
]);

/** Parse reconcile argv. Pure: throws `CliError` (with exit code) on bad input. */
export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const args: ReconcileArgs = {
    config: undefined,
    configMode: "fold",
    mode: "dry-run",
    cycles: [],
    baseUrl: undefined,
    baseUrlEnv: undefined,
    tokenEnv: undefined,
    allowGuardrailOverride: false,
    removalCapFraction: undefined,
    planJson: undefined,
    member: undefined,
    driftIssue: false,
    driftIssueRepo: undefined,
  };

  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new CliError(2, `${flag} requires a value`);
    return v;
  };

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new CliError(2, `unexpected positional argument: ${flag}`);
    if (!KNOWN_FLAGS.has(flag)) throw new CliError(2, `unknown flag: ${flag}`);
    switch (flag) {
      case "--config":
        args.config = need(++i, flag);
        break;
      case "--config-mode": {
        const v = argv[++i];
        if (v !== "fold" && v !== "run" && v !== "check") throw new CliError(2, `--config-mode must be "fold", "run" or "check", got: ${v ?? "(missing)"}`);
        args.configMode = v;
        break;
      }
      case "--mode": {
        const v = argv[++i];
        if (v !== "dry-run" && v !== "apply") throw new CliError(2, `--mode must be "dry-run" or "apply", got: ${v ?? "(missing)"}`);
        args.mode = v;
        break;
      }
      case "--cycles":
        args.cycles = need(++i, flag).split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--base-url":
        args.baseUrl = need(++i, flag);
        break;
      case "--base-url-env":
        args.baseUrlEnv = need(++i, flag);
        break;
      case "--token-env":
        args.tokenEnv = need(++i, flag);
        break;
      case "--allow-guardrail-override":
        args.allowGuardrailOverride = true;
        break;
      case "--removal-cap-fraction": {
        const raw = need(++i, flag);
        const f = Number(raw);
        if (!(f > 0 && f <= 1)) {
          throw new CliError(2, `--removal-cap-fraction must be a number in (0,1], got: ${raw}`);
        }
        args.removalCapFraction = f;
        break;
      }
      case "--plan-json":
        args.planJson = need(++i, flag);
        break;
      case "--member":
        args.member = need(++i, flag);
        if (args.member.trim() === "") throw new CliError(2, "--member requires a non-empty name");
        break;
      case "--drift-issue":
        args.driftIssue = true;
        break;
      case "--drift-issue-repo":
        args.driftIssueRepo = need(++i, flag);
        if (!isRepoName(args.driftIssueRepo)) throw new CliError(2, `--drift-issue-repo must be owner/name, got: ${args.driftIssueRepo}`);
        break;
    }
    i++;
  }

  if (!args.baseUrl && !args.baseUrlEnv) throw new CliError(2, "instance URL is required: supply --base-url <url> or --base-url-env <VAR>");
  if (!args.tokenEnv) throw new CliError(2, "--token-env <VAR> is required");
  if (args.planJson !== undefined && args.mode === "apply") {
    throw new CliError(2, "--plan-json writes a plan without applying it; it cannot be combined with --mode apply");
  }
  if (args.member !== undefined && args.planJson === undefined && !args.driftIssue) {
    throw new CliError(2, "--member names the member of the --plan-json part or the drift records; give it with --plan-json or --drift-issue");
  }
  if (args.driftIssue && args.mode === "apply") {
    throw new CliError(2, "--drift-issue tracks the drift a dry run finds; it cannot be combined with --mode apply");
  }
  if (args.driftIssue && args.cycles.length > 0) {
    throw new CliError(2, "--drift-issue tracks the whole policy's drift; it cannot be combined with --cycles, whose run would read the other cycles' nodes as matching");
  }
  if (args.driftIssueRepo !== undefined && !args.driftIssue) {
    throw new CliError(2, "--drift-issue-repo names the repository of the drift issue; give it with --drift-issue");
  }

  return args;
}

export interface ReposArgs {
  /** `--config`; undefined reads governance.yml (or governance.ts) in the working directory. */
  config: string | undefined;
  configMode: ConfigMode;
  /** The org to list; undefined means the policy's only org. */
  org: string | undefined;
  /** File to write; undefined writes to stdout. */
  out: string | undefined;
  baseUrl: string | undefined;
  baseUrlEnv: string | undefined;
  tokenEnv: string | undefined;
}

const REPOS_FLAGS = new Set(["--config", "--config-mode", "--org", "--out", "--base-url", "--base-url-env", "--token-env"]);

/** Parse `repos` argv. Pure: throws `CliError` (with exit code) on bad input. */
export function parseReposArgs(argv: string[]): ReposArgs {
  const args: ReposArgs = {
    config: undefined,
    configMode: "fold",
    org: undefined,
    out: undefined,
    baseUrl: undefined,
    baseUrlEnv: undefined,
    tokenEnv: undefined,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--") || v === "") throw new CliError(2, `${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new CliError(2, `unexpected positional argument: ${flag}`);
    if (!REPOS_FLAGS.has(flag)) throw new CliError(2, `unknown flag for repos: ${flag}`);
    switch (flag) {
      case "--config":
        args.config = need(++i, flag);
        break;
      case "--config-mode": {
        const v = argv[++i];
        if (v !== "fold" && v !== "run" && v !== "check") throw new CliError(2, `--config-mode must be "fold", "run" or "check", got: ${v ?? "(missing)"}`);
        args.configMode = v;
        break;
      }
      case "--org":
        args.org = need(++i, flag);
        break;
      case "--out":
        args.out = need(++i, flag);
        break;
      case "--base-url":
        args.baseUrl = need(++i, flag);
        break;
      case "--base-url-env":
        args.baseUrlEnv = need(++i, flag);
        break;
      case "--token-env":
        args.tokenEnv = need(++i, flag);
        break;
    }
  }
  if (!args.baseUrl && !args.baseUrlEnv) throw new CliError(2, "instance URL is required: supply --base-url <url> or --base-url-env <VAR>");
  if (!args.tokenEnv) throw new CliError(2, "--token-env <VAR> is required");
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function env(name: string): string {
  const v = process.env[name];
  if (!v) die(2, `env var ${name} is not set or is empty`);
  return v;
}

function die(code: number, message: string): never {
  process.stderr.write(`forgejo-warden: error: ${message}\n`);
  process.exit(code);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runReconcileCommand(argv: string[]): Promise<void> {
  let args: ReconcileArgs;
  try {
    args = parseReconcileArgs(argv);
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    throw err;
  }

  const configPath = resolveConfigPath(args.config);
  if (!configPath) die(2, "no --config given and no governance.yml or governance.ts in the working directory");

  let config: GovernanceConfig;
  let provenance: PolicyProvenance | undefined;
  try {
    ({ config, provenance } = await loadGovernancePolicy(configPath, args.configMode));
  } catch (err) {
    die(2, `invalid governance config "${configPath}": ${errMsg(err)}`);
  }

  let member: string | undefined;
  if (args.planJson !== undefined || args.driftIssue) {
    member = args.member ?? defaultMemberName(configPath);
    if (!member) die(2, `cannot name the member from "${configPath}"'s directory; give --member <name>`);
  }

  let issueRepo: string | undefined;
  if (args.driftIssue) {
    issueRepo = driftIssueRepo(args.driftIssueRepo);
    if (!issueRepo) {
      die(2, "--drift-issue needs the repository to keep the issue in: give --drift-issue-repo <owner/name>, or run where FORGEJO_REPOSITORY or GITHUB_REPOSITORY is set");
    }
    if (!isRepoName(issueRepo)) die(2, `the drift issue repository must be owner/name, got: ${issueRepo}`);
  }

  const baseUrl = args.baseUrl ?? env(args.baseUrlEnv!);
  const token = env(args.tokenEnv!);
  const client = createClient({ baseUrl, token });
  if (args.driftIssue) {
    try {
      new URL(baseUrl);
    } catch {
      die(2, `--drift-issue needs an absolute instance URL, got: ${baseUrl}`);
    }
  }

  let cycles: Cycle[];
  if (args.cycles.length === 0) {
    cycles = Object.values(CYCLE_REGISTRY);
  } else {
    cycles = [];
    for (const name of args.cycles) {
      const cycle = CYCLE_REGISTRY[name];
      if (!cycle) die(2, `unknown cycle: "${name}". Known cycles: ${Object.keys(CYCLE_REGISTRY).join(", ") || "(none yet)"}`);
      cycles.push(cycle);
    }
  }

  let result;
  try {
    result = await runReconcile({
      config,
      client,
      cycles,
      mode: args.mode,
      allowGuardrailOverride: args.allowGuardrailOverride,
      removalDeltaCapFraction: args.removalCapFraction,
      provenance,
    });
  } catch (err) {
    die(3, `reconcile failed: ${errMsg(err)}`);
  }

  if (args.planJson !== undefined) {
    const part = planPart({ member: member!, changeSets: result.changeSets, errored: result.errored, deferred: result.deferred });
    try {
      writeFileSync(args.planJson, `${JSON.stringify(part, null, 2)}\n`, "utf-8");
    } catch (err) {
      die(3, `failed to write plan to "${args.planJson}": ${errMsg(err)}`);
    }
  }

  for (const cr of result.cycles) {
    process.stdout.write(`\n=== ${cr.name} @ ${cr.org} ===\n${cr.plan}\n`);
    if (cr.guardrailBlocked) {
      const diags = cr.guardrails.ok ? [] : cr.guardrails.diagnostics;
      process.stdout.write(`\nGUARDRAIL BLOCK: ${diags.map((d) => d.message).join("; ")}\n`);
    }
    if (args.mode === "apply" && !cr.guardrailBlocked) {
      process.stdout.write(`Applied: ${cr.applied.length}, Failed: ${cr.failed.length}\n`);
      for (const f of cr.failed) process.stdout.write(`  FAILED [${f.entry.resourceType}] ${f.entry.key}: ${f.error}\n`);
    }
  }
  for (const ce of result.errored) process.stderr.write(`ERROR in ${ce.name} @ ${ce.org} (${ce.stage}): ${ce.error}\n`);
  if (result.deferred.skippedCycles.length > 0) {
    process.stderr.write(`DEFERRED (budget): ${result.deferred.skippedCycles.join(", ")}\n`);
  }

  if (args.driftIssue) {
    const observedAt = new Date().toISOString();
    const runUrl = driftIssueRunUrl();
    try {
      const kept = await keepGovernanceDriftIssue(driftIssueForge({ baseUrl, repo: issueRepo!, token, tokenEnv: args.tokenEnv!, runUrl }), {
        environment: driftIssueEnvironment(baseUrl, Object.keys(config.orgs)),
        records: governanceDrift({ member: member!, observedAt, policy: config, changeSets: result.changeSets, errored: result.errored, deferred: result.deferred }).records,
        observedAt,
        runUrl,
      });
      process.stdout.write(`\n${describeDriftIssue(kept)}\n`);
    } catch (err) {
      die(3, `keeping the drift issue failed: ${errMsg(err)}`);
    }
  }

  if (result.cycles.some((cr) => cr.guardrailBlocked)) process.exit(1);
  if (result.errored.length > 0 || result.cycles.some((cr) => cr.failed.length > 0)) process.exit(3);
  process.exit(0);
}

async function runReposCommand(argv: string[]): Promise<void> {
  let args: ReposArgs;
  try {
    args = parseReposArgs(argv);
  } catch (err) {
    if (err instanceof CliError) die(err.code, err.message);
    throw err;
  }

  const configPath = resolveConfigPath(args.config);
  if (!configPath) die(2, "no --config given and no governance.yml or governance.ts in the working directory");

  let config: GovernanceConfig;
  try {
    ({ config } = await loadGovernancePolicy(configPath, args.configMode));
  } catch (err) {
    die(2, `invalid governance config "${configPath}": ${errMsg(err)}`);
  }

  let org: string;
  try {
    org = pickOrg(Object.keys(config.orgs), args.org);
  } catch (err) {
    die(2, errMsg(err));
  }

  const baseUrl = args.baseUrl ?? env(args.baseUrlEnv!);
  const token = env(args.tokenEnv!);
  const client = createClient({ baseUrl, token });

  let text: string;
  try {
    text = `${JSON.stringify(await forgeRepoList(client, org, baseUrl), null, 2)}\n`;
  } catch (err) {
    die(3, `listing the repositories of ${org} failed: ${errMsg(err)}`);
  }
  if (args.out === undefined) {
    process.stdout.write(text);
  } else {
    try {
      writeFileSync(args.out, text, "utf-8");
    } catch (err) {
      die(3, `failed to write the repository list to "${args.out}": ${errMsg(err)}`);
    }
  }
  process.exit(0);
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: forgejo-warden reconcile [flags]",
      "       forgejo-warden repos [flags]",
      "",
      "reconcile flags:",
      "  --config <path>               Governance config (YAML, JSON, or a .ts policy; default governance.yml, else governance.ts).",
      "  --config-mode fold|run|check  How a .ts policy is evaluated (default: fold).",
      "  --mode dry-run|apply          Reconcile mode (default: dry-run).",
      "  --cycles <name[,name...]>     Cycles to run (default: all).",
      "  --base-url <url>              Forgejo instance URL (or --base-url-env <VAR>).",
      "  --token-env <VAR>             Env var holding the Forgejo API token.",
      "  --removal-cap-fraction <f>    Removal-cap threshold, a number in (0,1] (default 0.25).",
      "  --allow-guardrail-override    Apply even when guardrails trip.",
      "  --plan-json <file>            Write the plan as a chant change-set part (dry-run only).",
      "  --member <name>               Member the part and drift records name (default: the policy file's directory name).",
      "  --drift-issue                 Keep one forge issue tracking the drift this dry run finds (dry-run only).",
      "  --drift-issue-repo <owner/name>  Repository the issue lives in (default: FORGEJO_REPOSITORY, else GITHUB_REPOSITORY).",
      "",
      "repos writes the policy's org's repository list, archived repos included, as",
      "the JSON `chant workspace check --forge-repos <file>` reads.",
      "",
      "repos flags:",
      "  --config <path>               Governance config (YAML, JSON, or a .ts policy; default governance.yml, else governance.ts).",
      "  --config-mode fold|run|check  How a .ts policy is evaluated (default: fold).",
      "  --org <name>                  Org to list (default: the policy's only org).",
      "  --out <file>                  File to write (default: stdout).",
      "  --base-url <url>              Forgejo instance URL (or --base-url-env <VAR>).",
      "  --token-env <VAR>             Env var holding the Forgejo API token.",
      "",
      "Exit codes: 0 success · 1 guardrail block · 2 arg/config error · 3 runtime error.",
      "",
    ].join("\n"),
  );
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const sub = argv[0];
  if (!sub || argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  if (sub === "--version" || sub === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (sub === "reconcile") {
    await runReconcileCommand(argv.slice(1));
    return;
  }
  if (sub === "repos") {
    await runReposCommand(argv.slice(1));
    return;
  }
  die(2, `unknown subcommand: ${sub}. Known subcommands: reconcile, repos`);
}

export async function run(argv: string[]): Promise<void> {
  await main(argv);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err: unknown) => {
    process.stderr.write(`forgejo-warden: fatal: ${errMsg(err)}\n`);
    process.exit(3);
  });
}
