/**
 * forgejo-warden public surface.
 *
 * Grows as the auth client, config/live types, diff, runner, and cycles land.
 * The provider-agnostic reconcile harness is consumed from
 * `@intentius/chant/reconcile` — it is not vendored here.
 */

// Forgejo REST client
export { createClient, ForgejoApiError } from "./auth/client.js";
export type { ForgejoClient, ForgejoClientOptions } from "./auth/client.js";

// The governance policy: its types, for `satisfies GovernanceConfig` in a
// `.ts` policy, and the loader that folds, runs, or checks one.
export type * from "./config/types.js";
export { loadGovernanceConfig, loadGovernancePolicy, GovernanceConfigError } from "./config/load.js";
export type { ConfigMode, LoadedPolicy } from "./config/load.js";
// Where a drifted field was written, when the policy was folded.
export { originAt, formatOrigin, driftOrigins, annotatePlan } from "./reconcile/origin.js";
export type { FieldOrigin, SourceLocation, PolicyProvenance, DriftOrigin } from "./reconcile/origin.js";
