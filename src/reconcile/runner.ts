/**
 * Forgejo reconcile runner.
 *
 * A thin adapter over the provider-agnostic `runReconcile` / `Cycle` harness in
 * `@intentius/chant/reconcile` — it wires Forgejo's `diff` and a Forgejo-
 * appropriate guardrail set into the shared loop, and re-exports the harness
 * types so cycles import them from here.
 *
 * Guardrails: the removal cap (don't let a typo mass-delete) + rename-without-
 * loss (a `previously` alias collapses a delete+create into an update — applied
 * to the change set itself, so the plan and the apply both see the rename). The
 * member-floor / self-lockout guardrails are GitHub-flavored and omitted; add a
 * Forgejo equivalent later only if meaningful.
 *
 * The removal cap here is `removalLiveCap`, a warden-local check that divides
 * deletes by the LIVE managed entry count (chant's `removalDeltaCap` divides by
 * the plan's updates + deletes, so one stale delete in an otherwise converged
 * cycle trips at 100%). The live count comes from `countLiveManaged` over the
 * same declared slices the diff walks; when nothing is live the check delegates
 * to chant's plan-relative cap.
 *
 * Every warden cycle stamps a cross-provider governance verb
 * (`@intentius/chant/governance`); the shared runner copies it onto change-set
 * entries so Forgejo plans group by the same grammar as other providers'.
 */

import {
  runReconcile as coreRunReconcile,
  runGuardrailChecks,
  removalDeltaCap,
  resolveRenames,
} from "@intentius/chant/reconcile";
import type {
  ChangeSet,
  Cycle as CoreCycle,
  GuardrailDiagnostic,
  ReconcileResult,
  DiffOptions,
} from "@intentius/chant/reconcile";
import type { ForgejoClient } from "../auth/client.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";
import type { LiveOrgState } from "./live.js";
import { diff, countLiveManaged } from "./diff.js";

export { BudgetExhaustedError } from "@intentius/chant/reconcile";
export type {
  RateBudget,
  CycleResult,
  CycleError,
  DeferredWork,
  ReconcileResult,
} from "@intentius/chant/reconcile";
export { GOVERNANCE_VERBS, isGovernanceVerb } from "@intentius/chant/governance";
export type { GovernanceVerb } from "@intentius/chant/governance";

/** A Forgejo governance cycle — the shared `Cycle` specialized to warden's types. */
export type Cycle<TScope = unknown> = CoreCycle<ForgejoClient, OrgConfig, LiveOrgState, TScope>;

/** Options for warden's `runReconcile` (config-based). */
export interface RunReconcileOptions<TScope = unknown> {
  config: GovernanceConfig;
  client: ForgejoClient;
  cycles: Cycle<TScope>[];
  scope?: TScope;
  mode?: "dry-run" | "apply";
  diffOptions?: DiffOptions;
  allowGuardrailOverride?: boolean;
  requestBudget?: number;
  /** Max fraction of live managed entries deletable in one apply (`removalLiveCap`). Default 0.25. */
  removalDeltaCapFraction?: number;
}

/** Options for {@link removalLiveCap}. */
export interface RemovalLiveCapOptions {
  /** Max fraction of live managed entries that may be deleted. Must be in (0,1]. Default 0.25. */
  maxFraction?: number;
}

/**
 * Warden-local removal cap: refuse when deletes exceed `maxFraction` of the
 * LIVE managed entries — the live-side count of the collections the policy
 * declares for the cycle (`countLiveManaged`). Live-relative, unlike chant's
 * `removalDeltaCap` (plan-relative: deletes / plan's updates + deletes), so one
 * stale delete in an otherwise converged cycle no longer trips at 100%.
 *
 * `liveManagedTotal === 0` (nothing counted live for this cycle) delegates to
 * chant's plan-relative cap, so a miscounted denominator can never disable the
 * guardrail outright.
 */
export function removalLiveCap(
  changeSet: ChangeSet,
  liveManagedTotal: number,
  opts: RemovalLiveCapOptions = {},
): GuardrailDiagnostic | null {
  if (liveManagedTotal <= 0) return removalDeltaCap(changeSet, opts);
  const maxFraction = opts.maxFraction ?? 0.25;
  const deletes = changeSet.entries.filter((e) => e.kind === "delete").length;
  const fraction = deletes / liveManagedTotal;
  if (fraction > maxFraction) {
    return {
      guardrail: "removalLiveCap",
      message:
        `${deletes} of ${liveManagedTotal} live managed entries (${Math.round(fraction * 100)}%) would be deleted, ` +
        `exceeding the ${Math.round(maxFraction * 100)}% threshold. ` +
        `Check for typos in config or raise maxFraction to proceed.`,
    };
  }
  return null;
}

/**
 * Derive an ownership predicate from an org's `owned` declaration.
 * Absent/`false` → `undefined` (deletes never emitted, the default);
 * `true` → warden owns every collection; a string list → only those types.
 */
function isOwnedFromConfig(owned: OrgConfig["owned"]): DiffOptions["isOwned"] {
  if (owned === true) return () => true;
  if (Array.isArray(owned)) return (type) => owned.includes(type);
  return undefined;
}

/**
 * Run the Forgejo governance reconcile loop, delegating to the shared runner
 * with warden's `diff` (org name as scope id) and guardrails wired in.
 *
 * Deletes are ownership-gated per org: a caller-supplied `diffOptions.isOwned`
 * wins; otherwise the predicate is derived from that org's `owned` declaration
 * in the policy (absent → no deletes, the safe default).
 */
export async function runReconcile<TScope = unknown>(
  opts: RunReconcileOptions<TScope>,
): Promise<ReconcileResult> {
  const maxFraction = opts.removalDeltaCapFraction ?? 0.25;
  // `removalLiveCap`'s denominator, captured from the immediately preceding
  // diff call. Chant's loop is strictly sequential per scope×cycle — diff runs,
  // then guardrails run on that diff's change set before the next diff — so a
  // single captured value can't be read stale (locked by a runner test).
  let liveManagedTotal = 0;
  return coreRunReconcile<ForgejoClient, OrgConfig, LiveOrgState, TScope>({
    client: opts.client,
    scopes: opts.config.orgs,
    cycles: opts.cycles,
    scope: opts.scope,
    mode: opts.mode,
    diff: (scopeId, desired, live, dopts) => {
      const scoped: DiffOptions = dopts?.isOwned
        ? dopts
        : { ...dopts, isOwned: isOwnedFromConfig(opts.config.orgs[scopeId]?.owned) };
      liveManagedTotal = countLiveManaged(desired, live);
      // Resolve `previously:` rename aliases in the change set itself, so the
      // plan and the apply see one update (the live id survives) rather than a
      // delete + create. Guardrails re-resolve internally; that is idempotent.
      return resolveRenames(diff(scopeId, desired, live, scoped));
    },
    guardrails: (changeSet) =>
      runGuardrailChecks(changeSet, [
        (resolved) => removalLiveCap(resolved, liveManagedTotal, { maxFraction }),
      ]),
    diffOptions: opts.diffOptions,
    allowGuardrailOverride: opts.allowGuardrailOverride,
    requestBudget: opts.requestBudget,
  });
}
