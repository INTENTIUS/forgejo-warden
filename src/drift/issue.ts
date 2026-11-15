/**
 * `reconcile --drift-issue`: one forge issue tracking the governance drift a
 * dry run finds (INTENTIUS/forgejo-warden#47).
 *
 * chant's `keepDriftIssue` (`@intentius/chant/drift-issue`) does the work:
 * it opens the issue when the run finds drift, updates it when the drift
 * changes, leaves it alone when the drift is the same or the read was
 * incomplete, and closes it when the forge matches the policy again. The
 * records are the drift reader's (`./reader.ts`), so the issue and
 * `chant workspace drift` report the same thing: a node with planned
 * changes is `drifted`, which is drift under keepDriftIssue's default
 * statuses.
 */

import { keepDriftIssue, type DriftIssueResult, type DriftIssueWords } from "@intentius/chant/drift-issue";
import type { DriftRecord } from "@intentius/chant/drift-record";
import { forgeClient, type ForgeFetch, type PrForge } from "@intentius/chant/pr-forge";

/** The product name on the marker and the fingerprint. */
export const DRIFT_ISSUE_PRODUCT = "forgejo-warden";

type Env = Record<string, string | undefined>;

const pick = (env: Env, ...names: string[]): string | undefined =>
  names.map((n) => env[n]?.trim()).find((v): v is string => v !== undefined && v !== "");

/** `owner/name`: what Forgejo calls a repository by. */
export const isRepoName = (v: string): boolean => /^[^/\s]+\/[^/\s]+$/.test(v);

/** The repository the issue lives in: the flag, else the Forgejo (or GitHub-compatible) Actions variable. Undefined when none is set. */
export function driftIssueRepo(flag: string | undefined, env: Env = process.env): string | undefined {
  return flag ?? pick(env, "FORGEJO_REPOSITORY", "GITHUB_REPOSITORY");
}

/** The run's URL on a Forgejo Actions (or GitHub Actions) runner, when the job says it. */
export function driftIssueRunUrl(env: Env = process.env): string | undefined {
  const server = pick(env, "FORGEJO_SERVER_URL", "GITHUB_SERVER_URL")?.replace(/\/+$/, "");
  const repo = pick(env, "FORGEJO_REPOSITORY", "GITHUB_REPOSITORY");
  const run = pick(env, "FORGEJO_RUN_ID", "GITHUB_RUN_ID");
  return server && repo && run ? `${server}/${repo}/actions/runs/${run}` : undefined;
}

/** What the issue is for: the instance's host and the policy's orgs, `forgejo.example.com/acme`. Keys the marker. */
export function driftIssueEnvironment(baseUrl: string, orgs: readonly string[]): string {
  return `${new URL(baseUrl).host.toLowerCase()}/${[...orgs].sort().join(",")}`;
}

/** forgejo-warden's words for its drift issue. */
export const DRIFT_ISSUE_WORDS: DriftIssueWords = {
  product: DRIFT_ISSUE_PRODUCT,
  title: (facts) => `Governance drift on ${facts.environment}`,
  values: { before: "declared", after: "live" },
  advice: () =>
    "Run `forgejo-warden reconcile --mode apply` to bring the forge back to the policy, or change the policy to match. This issue closes on the first dry run that finds no drift.",
};

export interface DriftIssueForgeOptions {
  /** The Forgejo instance the warden governs; the issue repository is on it. */
  baseUrl: string;
  /** `owner/name`. */
  repo: string;
  token: string;
  /** The variable the token came from, for messages. */
  tokenEnv: string;
  runUrl?: string;
  fetch?: ForgeFetch;
}

/** chant's Forgejo client for the issue repository, with the warden's own token. */
export function driftIssueForge(opts: DriftIssueForgeOptions): PrForge {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return forgeClient(
    {
      kind: "forgejo",
      apiBase: `${base}/api/v1`,
      repo: opts.repo,
      host: new URL(base).host.toLowerCase(),
      token: opts.token,
      tokenSource: opts.tokenEnv,
      ...(opts.runUrl ? { runUrl: opts.runUrl } : {}),
    },
    opts.fetch,
  );
}

export interface KeepGovernanceDriftIssueInput {
  environment: string;
  records: readonly DriftRecord[];
  runUrl?: string;
  observedAt?: string;
}

/** Bring the environment's one drift issue in line with the run. Throws what the forge throws. */
export function keepGovernanceDriftIssue(forge: Pick<PrForge, "trackIssue">, input: KeepGovernanceDriftIssueInput): Promise<DriftIssueResult> {
  return keepDriftIssue(forge, {
    words: DRIFT_ISSUE_WORDS,
    environment: input.environment,
    records: input.records,
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
  });
}

/** One line for the job log: `Drift issue: opened #4 <url>`. */
export function describeDriftIssue(r: DriftIssueResult): string {
  return [`Drift issue: ${r.action}`, r.number !== undefined ? `#${r.number}` : "", r.url ?? "", r.why ? `(${r.why})` : ""].filter(Boolean).join(" ");
}
