# Cycles

A cycle reconciles one resource domain. It fetches live state from the Forgejo
API and builds the desired slice from the policy, then diffs the two into a
change set and (in `apply` mode) applies each entry. Cycles run in registry
order; select a subset with `--cycles` ([CLI.md](CLI.md)).

Shared behavior, so it isn't repeated eight times:

- **Selective-by-omission.** An absent field or collection is never read for
  mutation, diffed, or changed: a slice absent from the policy produces an
  empty desired state, so the cycle proposes nothing for it.
- **Ownership-gated deletes.** The diff proposes deleting a live entry
  missing from the policy only when that entry's collection is marked owned,
  and by default nothing is owned: a run creates and updates but never
  deletes. An org's `owned:` declaration in the policy (`true`, or a list of
  resource types; see [POLICY.md](POLICY.md), "Delete semantics") marks
  resources owned; a programmatic `diffOptions.isOwned` predicate passed to
  `runReconcile` overrides the declaration when supplied. The per-cycle
  delete behavior below applies only in orgs that opted in.
- **Guardrails before apply.** Chant's `removalDeltaCap` refuses an apply
  whose deletes exceed 25% (or `--removal-cap-fraction`) of any single
  resource type's live managed entries; see [POLICY.md](POLICY.md), "The
  removal cap". A team rename declared with `previously:` is planned as a
  single update, so a rename is not counted as a deletion. A tripped
  guardrail blocks the apply (exit 1) unless `--allow-guardrail-override` is
  set.
- **Request budget.** A run has a shared budget of 1000 API requests. On
  exhaustion the run stops cleanly and prints `DEFERRED (budget): <cycles>`
  to stderr; run again (or narrow `--cycles`) to finish. List endpoints
  paginate at 50 per page, and each page costs one budget unit.
- **Keying.** Collections are keyed by a stable logical key (name, URL, or
  rule name), never by Forgejo's numeric ids. Teams and webhooks are the
  resources Forgejo itself addresses by numeric id; for those the live
  snapshot carries the id and the apply path uses it.

## org-settings

Reconciles org-level settings from `orgs.<org>.settings`.

- Read: `GET /orgs/{org}`. The apply is `PATCH /orgs/{org}` with only the
  declared fields; the PATCH is a partial update, so no read-modify-write is
  needed. The managed fields are `fullName`, `description`, `website`,
  `location`, `visibility` (`public` | `limited` | `private`), and
  `repoAdminChangeTeamAccess`.
- The change set holds a single entry keyed `org-settings` per org, with
  nothing to delete: settings are only ever patched.
- A 404 on the org (the token can't see it, or it doesn't exist) yields an
  empty live state; the plan then shows an entry that looks like a create,
  and its PATCH will fail visibly rather than silently skipping.

## membership

Asserts the org member inventory from `orgs.<org>.members`, and by design it
can only remove.

- Read: `GET /orgs/{org}/members` (paginated). The apply is
  `DELETE /orgs/{org}/members/{username}` for delete entries; updates are
  impossible because a member has no fields.
- Entries are keyed by `username`, and the delete candidates are unlisted
  members in an org that owns `member`.
- Forgejo org membership is team-driven: there is no "add user to org"
  endpoint, and a user becomes a member by joining a team. A `create` entry
  for a member therefore fails loudly with a message pointing at the `teams`
  cycle (the run continues, and the entry lands in the cycle's `failed`
  list). Day to day, use `teams.<name>.members` to add people, and use the
  `members:` list to assert the expected roster and (in an org that owns
  `member`) remove stragglers who are no longer in any declared team.

## teams

Team CRUD plus two subresources, team membership and team repo access, from
`orgs.<org>.teams`.

- Read: `GET /orgs/{org}/teams` (paginated), then per team
  `GET /teams/{id}/members` and `GET /teams/{id}/repos`.
- A team create is `POST /orgs/{org}/teams` followed by inline
  `PUT /teams/{id}/members/{username}` and
  `PUT /teams/{id}/repos/{org}/{repo}` for the declared members and repos
  (the diff emits no separate child entries for a not-yet-live team). A team
  update is `PATCH /teams/{id}` with the declared fields plus the team name
  (Forgejo's edit-team API requires `name`, which also carries a rename),
  and a team delete is `DELETE /teams/{id}`. Child entries add or remove
  with `PUT`/`DELETE /teams/{id}/members/{username}` and
  `PUT`/`DELETE /teams/{id}/repos/{org}/{repo}`.
- Teams are keyed by name (the `teams:` map key); child entries carry the
  keys `{team}/{username}` and `{team}/{repo}`. Forgejo addresses teams by
  numeric id, so the apply path reads the id off the live snapshot. A child
  entry only knows the team name, so it resolves name to id via
  `GET /orgs/{org}/teams/search` with an exact match on the result (Forgejo
  has no by-name team endpoint). Deleting a team or a child entry requires
  the org to own those types.
- Rename: a team entry with `previously: <old-name>` is an explicit rename.
  When a live team by the old name exists and none by the new name does, the
  diff plans a single update (the rename) against that live team. There is
  no delete plus create and no `owned` requirement, and the team id and its
  memberships survive.
For the team itself the diff compares `description` and `permission` along
with `canCreateOrgRepo`, `includesAllRepositories`, and `units`. Units are
compared as a set, since Forgejo does not guarantee unit order in responses.

## repo-settings

Manages settings and topics of existing org repos from `orgs.<org>.repos`.

- Read: `GET /orgs/{org}/repos` (paginated). Drift is fixed through
  `PATCH /repos/{org}/{repo}` carrying just the declared fields; when
  `topics` is declared it also applies `PUT /repos/{org}/{repo}/topics` as a
  full replacement.
- Entries are keyed by repo name, the `repos:` map key. The cycle never
  deletes a repo (warden has no repo deletion anywhere), and it never
  creates one either: a declared repo that doesn't exist live shows up as a
  `create` whose PATCH 404s into the cycle's `failed` list, an honest "this
  repo doesn't exist yet" signal. Provision the repo with the
  `repo-baseline` cycle instead.
- The scalar diff covers `description`, `website`, `private`, `hasIssues`,
  `hasWiki`, `hasPullRequests`, `defaultBranch`, `allowMergeCommits`,
  `allowRebase`, `allowSquashMerge`, `defaultMergeStyle`; declared `topics`
  are compared order-insensitively.

## branch-protection

Reconciles Forgejo branch protections (`branch_protections`) per repo, from
`repos.<name>.branchProtection`. Forgejo has no GitHub-style rulesets; a
protection rule applies to a branch name or glob.

- Read: `GET /orgs/{org}/repos`, then per repo
  `GET /repos/{org}/{repo}/branch_protections`. A create is
  `POST /repos/{org}/{repo}/branch_protections` with `rule_name` in the
  body, an update is `PATCH /repos/{org}/{repo}/branch_protections/{rule}`,
  and a delete is `DELETE` on the same path.
- The applies use the change-set key `{repo}/{ruleName}`, and a live rule
  absent from the policy becomes a delete candidate in an org that owns
  `branch-protection`.
- A rule is diffed on five booleans (`enablePush`, `requireSignedCommits`,
  `enableStatusCheck`, `blockOnOutdatedBranch`, `dismissStaleApprovals`) and
  the `requiredApprovals` number; `statusCheckContexts` is compared without
  regard to order. This cycle owns only the `branchProtection` slice of each
  repo; the repo's scalar settings belong to `repo-settings`, so the two
  cycles never fight over the same fields.

## repo-baseline

Provisions repos from `orgs.<org>.repoBaselines`: it ensures the named repos
exist in the org, and it only ever creates.

- Read: `GET /orgs/{org}/repos` for names only, an existence check. For a
  baseline whose repo is missing, `template: owner/repo` turns the apply
  into `POST /repos/{owner}/{repo}/generate` (generate from the template
  into the org, with `git_content` enabled so the template's files come
  along); otherwise the apply is `POST /orgs/{org}/repos` for an empty
  repo, and `private` defaults to `true` for the new repo.
- The change-set key is the baseline's repo name. The diff emits a `create`
  only when the repo is absent and nothing else, so existing repos stay
  untouched regardless of how they differ from the baseline; ongoing
  settings management belongs to `repo-settings`.

## secrets-variables

Reconciles Forgejo Actions secrets and variables at both org and repo scope,
from `secrets`/`variables` at the org level and under `repos.<name>`.

- Read: `GET /orgs/{org}/actions/secrets` and
  `GET /orgs/{org}/actions/variables`, then `GET /orgs/{org}/repos` and per
  repo `GET /repos/{org}/{repo}/actions/secrets` and
  `.../actions/variables`. A secret create or update is
  `PUT .../secrets/{name}`; a variable create is `POST .../variables/{name}`
  and a variable update is `PUT .../variables/{name}`; a delete of either
  kind is a `DELETE` on the same path.
- Everything here is keyed by `name`, with repo entries using
  `/repos/{org}/{repo}/actions/...` paths and the key `{repo}/{name}`. In an
  org that owns the secret and variable types, unlisted live entries are
  removed.
- Secrets come with a quirk: the Forgejo API is write-only for their values,
  so warden reconciles presence only. A value is never read back or diffed,
  so a drifted secret value is invisible to warden. On create the value
  comes from the environment variable `FORGEJO_SECRET_<NAME>` at apply time;
  if that variable is unset an empty placeholder is written, and the
  operator is expected to set the real value out-of-band.
- Variables behave differently from secrets: their values are not secret,
  and they are reconciled fully. Declaring `value` corrects drift; omitting
  it makes the variable presence-only, and a create then writes an empty
  string.

## webhooks

Reconciles org and repo webhooks together, from `webhooks` at the org level
and under `repos.<name>`.

- Read: `GET /orgs/{org}/hooks`, followed by `GET /orgs/{org}/repos` and
  each repo's `GET /repos/{org}/{repo}/hooks`. A create is a `POST` to the
  base (`/orgs/{org}/hooks` or `/repos/{org}/{repo}/hooks`), whose body
  includes `type` (default `forgejo`) and `config.content_type` (default
  `json`); an update is `PATCH .../hooks/{id}` and a delete is
  `DELETE .../hooks/{id}`.
- Hooks are matched by `url`, with repo hooks keyed `{repo}/{url}`.
  Forgejo's numeric hook `id` rides on the live snapshot and drives update
  and delete; a hook whose live id can't be found fails that entry rather
  than guessing. Undeclared live hooks become delete candidates where the
  org owns the webhook types.
- The hook diff compares `type` and `contentType` together with `active` and
  `branchFilter`, and it treats `events` as an unordered set. Changing a
  hook's `url` changes its identity: the plan shows a create for the new URL
  and, where webhook types are owned, a delete for the old one. There is no
  `previously:` alias for webhooks.
