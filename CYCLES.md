# Cycles

A cycle reconciles one resource domain. It fetches live state from the Forgejo
API and builds the desired slice from the policy, then diffs the two into a
change set and (in `apply` mode) applies each entry. Cycles run in registry
order; select a subset with `--cycles` ([CLI.md](CLI.md)).

All cycles share the same ground rules. A slice absent from the policy produces
an empty desired state, so the cycle proposes nothing for it (the
selective-by-omission rule). Deletes are gated behind ownership: the diff emits a
`delete` for a live entry missing from the policy only when an `isOwned`
predicate says warden owns it. That predicate comes from the org's `owned:`
declaration in the policy. Absent means never delete (the default); `true`
means every collection; a list means only the named resource types. The
per-cycle delete behavior below therefore applies only in orgs marked `owned`.
A library embedding can instead pass `diffOptions.isOwned` to `runReconcile`,
which takes precedence; see [POLICY.md](POLICY.md), "Delete semantics".

Every API request charges a shared budget of 1000 per run by default. On
exhaustion the run stops cleanly and reports deferred cycles and entries
instead of failing mid-apply. List endpoints paginate at 50 per page, and each
page costs one budget unit.

Collections are keyed by a stable logical key (name, URL, or rule name), never
by Forgejo's numeric ids. Teams and webhooks are the resources Forgejo itself
addresses by numeric id; for those the live snapshot carries the id and the
apply path uses it.

## org-settings

The org-settings cycle reconciles org-level settings. It reads `GET
/orgs/{org}` and applies `PATCH /orgs/{org}` with only the declared fields; the
PATCH is a partial update, so no read-modify-write is needed. Its change set
holds a single entry keyed `org-settings`, and nothing is ever deleted here
because settings are only patched. The managed fields are `fullName`,
`description`, `website`, `location`, `visibility` (`public` | `limited` |
`private`), `repoAdminChangeTeamAccess`. A 404 on the org, whether the token
can't see it or it doesn't exist, yields an empty live state; the plan then
shows an entry that looks like a create, and its PATCH will fail visibly rather
than silently skipping.

## membership

The membership cycle asserts the org member inventory, and by design it can
only remove. It reads `GET /orgs/{org}/members` (paginated) and, for a delete
entry, applies `DELETE /orgs/{org}/members/{username}`; entries are keyed by
`username`. The quirk is that Forgejo org membership is team-driven: there is
no "add user to org" endpoint, and a user becomes a member by joining a team. A
`create` entry for a member therefore fails loudly with a message pointing at
the `teams` cycle (the run continues, and the entry lands in the cycle's
`failed` list). Updates are impossible because a member has no fields. Day to
day, use `teams.<name>.members` to add people, and use the `members:` list
to assert the expected roster and (in an org that owns `member`) remove
stragglers who are no longer in any declared team.

## teams

The teams cycle is team CRUD plus two subresources, team membership and team
repo access. It reads `GET /orgs/{org}/teams` (paginated), then per team
`GET /teams/{id}/members` and `GET /teams/{id}/repos`.

A team create is `POST /orgs/{org}/teams` followed by inline
`PUT /teams/{id}/members/{username}` and `PUT /teams/{id}/repos/{org}/{repo}`
for the declared members and repos; the diff emits no separate child entries
for a not-yet-live team. A team update is `PATCH /teams/{id}` with the declared
fields, and a team delete is `DELETE /teams/{id}`. Child entries add or remove
with `PUT`/`DELETE /teams/{id}/members/{username}` and
`PUT`/`DELETE /teams/{id}/repos/{org}/{repo}`.

Teams are keyed by name (the config keys the `teams:` map by name); child
entries are keyed `{team}/{username}` and `{team}/{repo}`. Forgejo addresses
teams by numeric id, so the apply path reads the id off the live snapshot or
resolves the name to an id via `GET /orgs/{org}/teams/{name}` for child
entries. A team entry with `previously: <old-name>` matching a pending delete
collapses into an update (a rename) instead of a delete plus a create, and the
team id and its memberships survive. For the team itself the diff compares
`description` and `permission` along with `canCreateOrgRepo`,
`includesAllRepositories`, `units`.

## repo-settings

This cycle manages settings and topics of existing org repos. It reads
`GET /orgs/{org}/repos` (paginated) and applies `PATCH /repos/{org}/{repo}`
with the declared fields only; when `topics` is declared it also applies
`PUT /repos/{org}/{repo}/topics` as a full replacement. Entries are keyed by
repo name, the `repos:` map key. The cycle never deletes a repo (warden has no
repo deletion anywhere), and it never creates one either: a declared repo that
doesn't exist live shows up as a `create` whose PATCH 404s into the cycle's
`failed` list, an honest "this repo doesn't exist yet" signal. Provision the
repo with the `repo-baseline` cycle instead. The scalar diff covers
`description`, `website`, `private`, `hasIssues`, `hasWiki`,
`hasPullRequests`, `defaultBranch`, `allowMergeCommits`, `allowRebase`,
`allowSquashMerge`, `defaultMergeStyle`; declared `topics` are compared
order-insensitively.

## branch-protection

Forgejo branch protections (`branch_protections`) are reconciled per repo.
Forgejo has no GitHub-style rulesets; a protection rule is keyed by `rule_name`
and applies to a branch name or glob. The cycle reads `GET /orgs/{org}/repos`,
then per repo `GET /repos/{org}/{repo}/branch_protections`.

The applies use the change-set key `{repo}/{ruleName}`. A create is
`POST /repos/{org}/{repo}/branch_protections` with `rule_name` in the body; an
update is `PATCH /repos/{org}/{repo}/branch_protections/{rule}`; a delete is
`DELETE /repos/{org}/{repo}/branch_protections/{rule}`. A rule is diffed on
five booleans (`enablePush`, `requireSignedCommits`, `enableStatusCheck`,
`blockOnOutdatedBranch`, `dismissStaleApprovals`) and the `requiredApprovals`
number; `statusCheckContexts` is compared without regard to order.

This cycle owns only the `branchProtection` slice of each repo; the repo's
scalar settings belong to `repo-settings`, so the two cycles never fight over
the same fields.

## repo-baseline

The repo-baseline cycle provisions repos: it ensures the named repos exist in
the org, and it only ever creates. Reads are `GET /orgs/{org}/repos` for names
only, an existence check. For a baseline whose repo is missing,
`template: owner/repo` turns the apply into `POST /repos/{owner}/{repo}/generate`
(generate from the template into the org); otherwise the apply is
`POST /orgs/{org}/repos` for an empty repo, and `private` defaults to `true`
for the new repo. The change-set key is the baseline's repo name. The diff emits a `create`
only when the repo is absent and nothing else, so existing repos stay untouched
regardless of how they differ from the baseline; ongoing settings management
belongs to `repo-settings`.

## secrets-variables

Forgejo Actions secrets and variables are reconciled at both org and repo
scope. Reading starts with `GET /orgs/{org}/actions/secrets` and
`GET /orgs/{org}/actions/variables`, then covers `GET /orgs/{org}/repos` and
per repo `GET /repos/{org}/{repo}/actions/secrets` and
`.../actions/variables`. Repo
entries use `/repos/{org}/{repo}/actions/...` paths and the key
`{repo}/{name}`; everything else below shows the org paths. A secret create or
update is `PUT .../secrets/{name}`; a variable create is
`POST .../variables/{name}` and a variable update is
`PUT .../variables/{name}`; a delete of either kind is a `DELETE` on the same
path. Everything is keyed by `name`, prefixed by repo at repo scope.

Secrets come with a quirk: the Forgejo API is write-only for their values, so
warden reconciles presence only. It lists names and creates missing secrets,
and in an org that owns the secret types it removes unlisted ones. A value is
never read back or diffed, so a drifted secret value is invisible to warden. On
create the value comes from the environment variable `FORGEJO_SECRET_<NAME>` at
apply time; if that variable is unset an empty placeholder is written, and the
operator is expected to set the real value out-of-band.

Variables behave differently from secrets: their values are not secret, and
they are reconciled fully. Declaring `value` corrects drift; omitting it makes the
variable presence-only, and a create then writes an empty string.

## webhooks

Org and repo webhooks are reconciled together, keyed by URL. The cycle reads
`GET /orgs/{org}/hooks` first, followed by `GET /orgs/{org}/repos` and each
repo's `GET /repos/{org}/{repo}/hooks`. The org base is `/orgs/{org}/hooks` and the
repo base is `/repos/{org}/{repo}/hooks`, with repo entries keyed
`{repo}/{url}`. A create is a `POST` to the base, whose body includes `type`
(default `forgejo`) and `config.content_type` (default `json`); an update is
`PATCH .../hooks/{id}`; a delete is `DELETE .../hooks/{id}`.

The policy and the diff key a hook by `url`, while Forgejo's numeric hook `id`
rides on the live snapshot and drives update and delete. A hook whose live id
can't be found fails that entry rather than guessing. The hook diff compares
`type` and `contentType` together with `active` and `branchFilter`, and it
treats `events` as an unordered set. Changing a hook's `url` changes its
identity: the plan shows a create for the new URL and, in an org that owns the
webhook types, a delete for the old one. There is no `previously:` alias for
webhooks.
