# Changelog

Changes to `@intentius/forgejo-warden`. Versions follow semver, and
releases before `0.5.0` are not recorded here.

## Unreleased

- The package ships a `forge-governance` member kind for chant workspaces in
  `workspace-kinds.json`, exported at `@intentius/forgejo-warden/workspace-kinds`.
  `chant workspace check` validates a member's `governance.yml` against
  `schemas/governance.schema.json`. The kind's graph reader
  (`dist/graph-reader.mjs`) gives `chant workspace graph` the orgs, repos and
  teams the policy declares. The kind needs chant `>= 0.124.49`. See
  [README.md](README.md#as-a-chant-workspace-member).
- The `@intentius/chant` and `@intentius/chant-lexicon-github` range moves from
  `^0.109.0` to `^0.124.95`.
- `@intentius/tsad-reference` moves to `^2.3.0`. When a `.ts` policy is folded,
  a plan line now names a preset by the name the policy imported it under: a
  preset exported as `export { reviewPreset as preset }` is reported as
  `preset`.
- Node 24 or later is required (`engines.node` is `>=24`).

## 0.5.1 (2026-10-07)

The `repo-settings` cycle no longer puts branch protection, webhooks, secrets
or variables into its desired state, so its plan stops listing creates its
apply skips. Those slices belong to the `branch-protection`, `webhooks` and
`secrets-variables` cycles.

## 0.5.0 (2026-10-07)

The example policy applies a `reviewPreset({ approvals, squashOnly })` preset
to two repos, and a plan line for a drifted field names where the field was
written: the preset call with its argument and line, or the policy itself.
The origin comes from `@intentius/tsad-reference` provenance, which needs
`^2.2.0`. chant moves to `^0.109.0`.
