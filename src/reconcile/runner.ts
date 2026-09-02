/**
 * Forgejo reconcile runner.
 *
 * A thin adapter over the provider-agnostic `runReconcile` / `Cycle` harness in
 * `@intentius/chant/reconcile` — it wires Forgejo's `diff` and a Forgejo-
 * appropriate guardrail set into the shared loop, and re-exports the harness
 * types so cycles import them from here.
 *
 * Guardrails: the removal cap (don't let a typo mass-delete). Rename-without-
 * loss needs no guardrail wiring here: a `previously:` alias is planned as a
 * direct update by warden's own `diffTeams`, so the plan and the apply both
 * see the rename. The member-floor / self-lockout guardrails are
 * GitHub-flavored and omitted; add a Forgejo equivalent later only if
 * meaningful.
 *
 * The removal cap is chant's `removalDeltaCap`, evaluated per resource type:
 * warden's `diff` stamps `ChangeSet.managedCounts` (live entries per
 * delete-capable collection, counted during the diff walk itself), so each
 * type's deletes divide by that type's own live count — live entries of one
 * type cannot dilute a wipe of another, and one stale delete in an otherwise
 * converged cycle still reads as a small fraction rather than 100%.
 *
 * Every warden cycle stamps a cross-provider governance verb
 * (`@intentius/chant/governance`); the shared runner copies it onto change-set
 * entries so Forgejo plans group by the same grammar as other providers'.
 */

import {
  runReconcile as coreRunReconcile,
  runGuardrailChecks,
  removalDeltaCap,
} from "@intentius/chant/reconcile";
import type {
  Cycle as CoreCycle,
  ReconcileResult,
  DiffOptions,
} from "@intentius/chant/reconcile";
import type { ForgejoClient } from "../auth/client.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";
import type { LiveOrgState } from "./live.js";
import { diff } from "./diff.js";

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
  /** Max fraction, in (0,1], of any one resource type's live managed entries deletable in one apply — passed to chant's `removalDeltaCap`, which owns the default (0.25) and throws on an out-of-range value. */
  removalDeltaCapFraction?: number;
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
      // No `resolveRenames` here: warden's `previously:` renames are planned
      // as direct updates inside `diffTeams`, so the change set never carries
      // a delete + create pair for it to collapse. `runGuardrailChecks` still
      // resolves internally before its checks, so guardrail semantics are
      // unchanged.
      return diff(scopeId, desired, live, scoped);
    },
    guardrails: (changeSet) =>
      runGuardrailChecks(changeSet, [
        // Per-type live denominators ride on `changeSet.managedCounts`
        // (stamped by warden's diff); chant validates the fraction's (0,1]
        // bound and owns the 0.25 default.
        (resolved) => removalDeltaCap(resolved, { maxFraction: opts.removalDeltaCapFraction }),
      ]),
    diffOptions: opts.diffOptions,
    allowGuardrailOverride: opts.allowGuardrailOverride,
    requestBudget: opts.requestBudget,
  });
}
