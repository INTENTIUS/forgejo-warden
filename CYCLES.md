# Cycles

A cycle reconciles one resource domain: it fetches live state from the Forgejo
API, builds the desired slice from the policy, diffs the two into a change set,
and (in `apply` mode) applies each entry. Cycles run in registry order; select a
subset with `--cycles` ([CLI.md](CLI.md)).

Shared behavior:

- **Selective-by-omission.** A slice absent from the policy produces an empty
  desired state, so the cycle proposes nothing for it.
- **Deletes are ownership-gated.** The diff emits a `delete` for a live entry
  missing from the policy only when an `isOwned` predicate says warden owns it.
  The CLI wires no such predicate, so CLI runs never emit deletes; the delete
  behavior described per cycle below applies when forgejo-warden is embedded as
  a library with `diffOptions.isOwned` set. See [POLICY.md](POLICY.md).
- **Budget-aware.** Every API request charges a shared budget (default 1000 per
  run). On exhaustion the run stops cleanly and reports deferred cycles/entries
  instead of failing mid-apply. List endpoints paginate at 50 per page; each
  page is one budget unit.
- **Keying.** Collections are keyed by a stable logical key (name, URL, or rule
  name), never by Forgejo's numeric ids. Where Forgejo addresses a resource by
  id (teams, webhooks), the live snapshot carries the id and the apply path uses
  it.

## org-settings

Reconciles org-level settings.

- Reads: `GET /orgs/{org}`.
- Applies: `PATCH /orgs/{org}` with only the declared fields (the PATCH is a
  partial update, so no read-modify-write is needed).
- Keying: singleton (`org-settings`).
- Deletes: never — org settings are only patched.
- Fields: `fullName`, `description`, `website`, `location`, `visibility`
  (`public` | `limited` | `private`), `repoAdminChangeTeamAccess`.
- A 404 on the org (token can't see it, or it doesn't exist) yields an empty
  live state; the plan then shows a create-shaped entry whose PATCH will fail
  visibly rather than silently skipping.

## membership

Org member inventory. **Remove-only by design.**

- Reads: `GET /orgs/{org}/members` (paginated).
- Applies: `DELETE /orgs/{org}/members/{username}` for a delete entry.
- Keying: `username`.
- Quirk: Forgejo org membership is team-driven — there is no "add user to org"
  endpoint; a user becomes a member by joining a team. A `create` entry for a
  member therefore fails loudly with a message pointing at the `teams` cycle
  (the run continues; the entry lands in the cycle's `failed` list). Updates are
  impossible (a member has no fields).
- Practical upshot: use `teams.<name>.members` to add people; use the
  `members:` list to assert the expected roster and (with deletes active)
  remove stragglers who are no longer in any declared team.

## teams

Team CRUD plus two subresources: team members and team repo access.

- Reads: `GET /orgs/{org}/teams` (paginated), then per team
  `GET /teams/{id}/members` and `GET /teams/{id}/repos`.
- Applies:
  - team create: `POST /orgs/{org}/teams`, then inline
    `PUT /teams/{id}/members/{username}` and `PUT /teams/{id}/repos/{org}/{repo}`
    for the declared members/repos (the diff emits no separate child entries for
    a not-yet-live team).
  - team update: `PATCH /teams/{id}` with declared fields.
  - team delete: `DELETE /teams/{id}`.
  - team-member add/remove: `PUT`/`DELETE /teams/{id}/members/{username}`.
  - team-repo add/remove: `PUT`/`DELETE /teams/{id}/repos/{org}/{repo}`.
- Keying: teams by name (config keys the `teams:` map by name); child entries by
  `{team}/{username}` and `{team}/{repo}`. Forgejo addresses teams by numeric
  id, so the apply path reads the id off the live snapshot, or resolves
  name → id via `GET /orgs/{org}/teams/{name}` for child entries.
- Rename: a team entry with `previously: <old-name>` matching a pending delete
  is collapsed into an update (rename) instead of delete + create, preserving
  the team id and its memberships.
- Compared fields: `description`, `permission`, `canCreateOrgRepo`,
  `includesAllRepositories`, `units`.

## repo-settings

Settings and topics of *existing* org repos.

- Reads: `GET /orgs/{org}/repos` (paginated).
- Applies: `PATCH /repos/{org}/{repo}` (partial, declared fields only) and, when
  `topics` is declared, `PUT /repos/{org}/{repo}/topics` (full replacement).
- Keying: repo name (the `repos:` map key).
- Deletes: never — this cycle never deletes a repo, and warden has no repo
  deletion anywhere.
- Quirk: it never *creates* a repo either. A declared repo that doesn't exist
  live shows up as a `create` whose PATCH 404s into the cycle's `failed` list —
  an honest "this repo doesn't exist yet" signal. Provision it with the
  `repo-baseline` cycle.
- Compared fields: `description`, `website`, `private`, `hasIssues`, `hasWiki`,
  `hasPullRequests`, `defaultBranch`, `allowMergeCommits`, `allowRebase`,
  `allowSquashMerge`, `defaultMergeStyle`, plus order-insensitive `topics`.

## branch-protection

Forgejo branch protections (`branch_protections`), per repo. Forgejo has no
GitHub-style rulesets; a protection rule is keyed by `rule_name` and applies to
a branch name or glob.

- Reads: `GET /orgs/{org}/repos`, then per repo
  `GET /repos/{org}/{repo}/branch_protections`.
- Applies (key `{repo}/{ruleName}`):
  - create: `POST /repos/{org}/{repo}/branch_protections` (body includes `rule_name`).
  - update: `PATCH /repos/{org}/{repo}/branch_protections/{rule}`.
  - delete: `DELETE /repos/{org}/{repo}/branch_protections/{rule}`.
- Keying: `ruleName`.
- Compared fields: `enablePush`, `requireSignedCommits`, `requiredApprovals`,
  `enableStatusCheck`, `blockOnOutdatedBranch`, `dismissStaleApprovals`, plus
  order-insensitive `statusCheckContexts`.
- This cycle owns only the `branchProtection` slice of each repo; the repo's
  scalar settings belong to `repo-settings`, so the two cycles never fight over
  the same fields.

## repo-baseline

Provisioning: ensures named repos exist in the org. **Create-only.**

- Reads: `GET /orgs/{org}/repos` (names only — existence).
- Applies, for a baseline whose repo is missing:
  - with `template: owner/repo` set: `POST /repos/{owner}/{repo}/generate`
    (generate from template into the org).
  - otherwise: `POST /orgs/{org}/repos` (empty repo).
  - `private` defaults to `true` for the new repo.
- Keying: repo name.
- Deletes/updates: never — the diff emits a `create` only when the repo is
  absent, and nothing else. Existing repos are untouched regardless of how they
  differ from the baseline; ongoing settings management is `repo-settings`.

## secrets-variables

Forgejo Actions secrets and variables, at org and repo scope.

- Reads: `GET /orgs/{org}/actions/secrets`, `GET /orgs/{org}/actions/variables`,
  then `GET /orgs/{org}/repos` and per repo
  `GET /repos/{org}/{repo}/actions/secrets` and `.../actions/variables`.
- Applies (org paths shown; repo entries use `/repos/{org}/{repo}/actions/...`
  and are keyed `{repo}/{name}`):
  - secret create/update: `PUT .../secrets/{name}`.
  - variable create: `POST .../variables/{name}`; update: `PUT .../variables/{name}`.
  - delete (secret or variable): `DELETE` on the same path.
- Keying: `name` (prefixed by repo for repo scope).
- Secrets quirk: the Forgejo API is write-only for secret values, so warden
  reconciles **presence only** — it lists names, creates missing secrets, and
  (with deletes active) removes unlisted ones, but never reads or diffs a value.
  On create the value comes from the environment variable
  `FORGEJO_SECRET_<NAME>` at apply time; if unset, an empty placeholder is
  written and the operator is expected to set the real value out-of-band. A
  drifted secret *value* is invisible to warden.
- Variables quirk: values are not secret and are reconciled fully — declaring
  `value` corrects drift; omitting it makes the variable presence-only (a create
  writes an empty string).

## webhooks

Org and repo webhooks, keyed by URL.

- Reads: `GET /orgs/{org}/hooks`, then `GET /orgs/{org}/repos` and per repo
  `GET /repos/{org}/{repo}/hooks`.
- Applies (org base `/orgs/{org}/hooks`, repo base `/repos/{org}/{repo}/hooks`;
  repo entries keyed `{repo}/{url}`):
  - create: `POST` to the base (body includes `type`, default `forgejo`, and
    `config.content_type`, default `json`).
  - update: `PATCH .../hooks/{id}`.
  - delete: `DELETE .../hooks/{id}`.
- Keying: `url` in the policy and diff; Forgejo's numeric hook `id` is carried
  on the live snapshot and used for update/delete. A hook whose live id can't be
  found fails that entry rather than guessing.
- Compared fields: `type`, `contentType`, `active`, `branchFilter`, plus
  order-insensitive `events`.
- Changing a hook's `url` changes its identity: the plan shows a create for the
  new URL (and, with deletes active, a delete for the old one) — there is no
  `previously:` alias for webhooks.
