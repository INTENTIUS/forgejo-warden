# forgejo-warden

Keep your Forgejo org and repos in a declared state — reconcile, guardrails, drift correction.

A sibling of [github-warden](https://github.com/INTENTIUS/github-warden), built on
the shared provider-agnostic reconcile primitive in
[`@intentius/chant/reconcile`](https://github.com/INTENTIUS/chant) (change-set
model, generic collection diff, guardrail framework, and the `runReconcile`
loop). forgejo-warden supplies the Forgejo-specific layer: a REST client for a
self-hosted instance, the config + live-state types, a Forgejo `diff()`, and the
reconcile cycles.

> 🚧 **Early/in-progress.** The plan lives in the
> [roadmap epic](https://github.com/INTENTIUS/forgejo-warden/issues/14) and its
> sub-issues. This is currently scaffolding.

## How it differs from github-warden

- **Self-hosted:** the client takes a configurable instance base URL, not a fixed API host.
- **Auth:** a Forgejo API token — no GitHub Apps, no installation tokens.
- **Membership is team-driven**, branch protection (not rulesets), plus webhooks.
- Out of scope (no Forgejo equivalent): GHAS/security features, deployment environments, Dependabot, fine-grained PAT governance.
