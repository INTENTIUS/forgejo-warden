# Changelog

Changes to `@intentius/forgejo-warden`. Versions follow semver, and
releases before `0.5.0` are not recorded here.

## Unreleased

- `reconcile --plan-json` gives each entry its graph node id as its address,
  in place of `<resourceType>.<key>` (INTENTIUS/chant#5089). A change to a node
  itself is the bare node id (`repo/acme/api`); any other change is
  `<node id>#<resourceType>[<key>]` (`org/acme#member[bob]`). chant places the
  entries on the same graph nodes as the drift reader's records, and two orgs
  with a same-named repo no longer share an address. See
  [CLI.md](CLI.md#plan-as-a-change-set-part).
- The `@intentius/chant` and `@intentius/chant-lexicon-github` range moves to
  `^0.124.97`, the first chant whose `reconcilePlanPart` takes an entry's
  address.

## 0.6.0 (2026-11-14)

- `--config` is optional for `reconcile` and `repos`. Without it the policy is
  `governance.yml` in the working directory, or `governance.ts` there when no
  `governance.yml` exists. With neither file the command exits 2.
- The package ships a `forge-governance` member kind for chant workspaces in
  `workspace-kinds.json`, exported at `@intentius/forgejo-warden/workspace-kinds`.
  `chant workspace check` validates a member's `governance.yml` against
  `schemas/governance.schema.json`. The kind's graph reader
  (`dist/graph-reader.mjs`) gives `chant workspace graph` the orgs, repos and
  teams the policy declares. See
  [README.md](README.md#as-a-chant-workspace-member).
- The `@intentius/chant` and `@intentius/chant-lexicon-github` range moves from
  `^0.109.0` to `^0.124.96`.
- `@intentius/tsad-reference` moves to `^2.3.0`. When a `.ts` policy is folded,
  a plan line now names a preset by the name the policy imported it under: a
  preset exported as `export { reviewPreset as preset }` is reported as
  `preset`.
- Node 24 or later is required (`engines.node` is `>=24`).
- `reconcile --plan-json <file>` writes the run's plan as a chant change-set
  part (`reconcilePlanPart` from `@intentius/chant/change-set`), with lexicon
  `forgejo`. `--member <name>` names the member and defaults to the policy
  file's directory name. A run where a cycle errored or was deferred writes a
  `failed` member with no plan digest. `--plan-json` cannot be combined with
  `--mode apply`. See [CLI.md](CLI.md#plan-as-a-change-set-part).
- `forgejo-warden repos [--out <file>]` writes the policy's org's repository
  list, archived repositories marked `archived: true`, as
  `{ forge: "forgejo", org, repos: [{ url, archived? }] }`, the file
  `chant workspace check --forge-repos` reads to report undeclared (WSP014)
  and dropped (WSP015) repositories. `--org` picks the org when the policy
  governs several. See [CLI.md](CLI.md#repos).
- The `forge-governance` kind has a drift reader (`dist/drift-reader.mjs`, built
  by `build:drift`), so `chant workspace drift --member <name>` reports a
  governance member's drift: one record per node of the member's graph,
  `drifted` with the changes a dry run plans under it as attributes, or
  `in-sync`. It reads the instance URL and token from
  `FORGEJO_URL` and `FORGEJO_TOKEN`. The kind now needs chant `>= 0.124.96`.
  See [README.md](README.md#drift).
- `reconcile --drift-issue` keeps one issue tracking the drift a dry run
  finds, through `keepDriftIssue` from `@intentius/chant/drift-issue`: drift
  opens or updates it, the same drift leaves it alone, and a clean run closes
  it. The records are the drift reader's. The issue lives in
  `--drift-issue-repo <owner/name>`, or the workflow's repository
  (`FORGEJO_REPOSITORY`, `GITHUB_REPOSITORY`), on the governed instance.
  `--drift-issue` cannot be combined with `--mode apply` or `--cycles`, and `--member` now
  also names the drift records. See [CLI.md](CLI.md#drift-issue) and the
  scheduled job in [CI.md](CI.md#a-scheduled-drift-issue).

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
