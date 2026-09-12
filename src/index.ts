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
export { loadGovernanceConfig, GovernanceConfigError } from "./config/load.js";
export type { ConfigMode } from "./config/load.js";
