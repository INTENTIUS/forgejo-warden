# Policy

The policy is the foundation of this tool: one YAML (or JSON) file with an `orgs:`
map that declares the desired state of each Forgejo organization. Everything else
(flags, tokens, cycles) just serves the policy. It is the one file you must author.

- Loaded from the path given to `--config` (see [CLI.md](CLI.md)).
- Schema (authoritative): `src/config/types.ts` (`GovernanceConfig` / `OrgConfig`).
- Selective-by-omission: **every field is optional, and an absent field is never
  touched**. Warden will not read, diff, or modify an aspect of live state that
  the policy does not mention. Declaring `settings: {description: ...}` manages
  the description and nothing else.

Each slice of the policy is consumed by exactly one reconcile cycle (see
[CYCLES.md](CYCLES.md)); `--cycles` runs a subset without editing the policy.

## Delete semantics (read this before trusting a plan)

Warden's diff only proposes a `delete` for a live entry that is missing from the
policy when an ownership predicate (`isOwned`) marks that entry as warden-owned.
The CLI currently passes no ownership predicate, so **CLI runs never emit
deletes**: a live team, member, webhook, secret, variable, or branch-protection
rule that the policy doesn't mention is left alone, and removing an entry from
the policy stops managing it rather than removing it live. The per-cycle delete
paths documented in [CYCLES.md](CYCLES.md) exist and activate when forgejo-warden
is embedded as a library with `diffOptions.isOwned` supplied to `runReconcile`.
When deletes are active, the `removalDeltaCap` guardrail refuses an apply whose
deletes exceed 25% of the pre-existing managed entries.

## A complete policy

Copy this, delete what you don't need, and edit it. Every field from
`src/config/types.ts` is shown. Comments name the cycle that consumes each slice.

```yaml
orgs:
  # One entry per Forgejo organization, keyed by org name.
  acme:

    # ----- org-settings cycle: PATCH /orgs/{org} (partial update) -----
    settings:
      fullName: ACME Corporation
      description: Internal engineering org
      website: https://acme.example.com
      location: Rotterdam
      visibility: limited            # public | limited | private
      repoAdminChangeTeamAccess: false  # may repo admins change team access?

    # ----- membership cycle: org member inventory -----
    # Forgejo org membership is team-driven: there is no "add org member" API.
    # This cycle can only REMOVE members (and only when deletes are active, see
    # above); to add someone, put them in a team below. Declaring this list
    # asserts "these are the members I expect".
    members:
      - username: alice
      - username: bob

    # ----- teams cycle: teams + their members and repo access -----
    teams:
      platform:                      # key = team name
        description: Platform engineers
        permission: write            # read | write | admin | owner
        canCreateOrgRepo: false
        includesAllRepositories: false
        units:                       # enabled units for the team
          - repo.code
          - repo.issues
          - repo.pulls
        members:
          - username: alice
          - username: bob
        repos:                       # repos the team's permission applies to
          - name: api
          - name: infra
        previously: platform-eng     # former name: turns a rename into an
                                     # update instead of a delete + create

    # ----- repos: a map of per-repo desired state. Four cycles read it. -----
    repos:
      api:                           # key = repo name (must already exist;
                                     # provisioning is repoBaselines, below)

        # -- repo-settings cycle: PATCH /repos/{org}/{repo} + PUT .../topics --
        description: The ACME API
        website: https://api.acme.example.com
        private: true
        hasIssues: true
        hasWiki: false
        hasPullRequests: true
        defaultBranch: main
        allowMergeCommits: false
        allowRebase: true
        allowSquashMerge: true
        defaultMergeStyle: squash    # merge | rebase | rebase-merge | squash
        topics: [api, golang]        # full replacement when declared

        # -- branch-protection cycle: Forgejo branch_protections, keyed by
        #    ruleName (Forgejo's rule_name; a branch name or glob) --
        branchProtection:
          - ruleName: main
            enablePush: false
            requireSignedCommits: true
            requiredApprovals: 2
            enableStatusCheck: true
            statusCheckContexts: [ci/test, ci/lint]
            blockOnOutdatedBranch: true
            dismissStaleApprovals: true
          - ruleName: "release/*"
            enablePush: false
            requiredApprovals: 1

        # -- webhooks cycle (repo scope), keyed by url --
        webhooks:
          - url: https://ci.acme.example.com/hooks/api
            type: forgejo            # forgejo | gitea | slack | ...; default forgejo
            contentType: json        # json | form; default json
            events: [push, pull_request]
            active: true
            branchFilter: "main"

        # -- secrets-variables cycle (repo scope) --
        secrets:                     # Actions secrets: presence only.
          - name: DEPLOY_KEY         # Value never read; written from
                                     # $FORGEJO_SECRET_DEPLOY_KEY at apply time
                                     # (empty placeholder if unset).
        variables:                   # Actions variables: values reconciled fully.
          - name: DEPLOY_ENV
            value: production

    # ----- repo-baseline cycle: repos that must EXIST in the org -----
    # Existence-only: creates a missing repo, never updates or deletes an
    # existing one. Settings for it belong under repos: above.
    repoBaselines:
      - name: api
        private: true                # default true
      - name: new-service
        template: acme/service-template   # "owner/repo": generate from template
        private: true

    # ----- secrets-variables cycle (org scope) -----
    secrets:
      - name: NPM_TOKEN              # presence only, as with repo secrets
    variables:
      - name: REGISTRY
        value: registry.acme.example.com

    # ----- webhooks cycle (org scope), keyed by url -----
    webhooks:
      - url: https://audit.acme.example.com/hooks/org
        type: forgejo
        contentType: json
        events: [repository, organization]
        active: true
```

The smallest valid policy is `orgs: {}` (manages nothing). The smallest useful
one declares a single slice, e.g. just `settings:` for one org.

## Field reference

### `orgs{}` (top level)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `orgs` | map of org name → org config | **required** | all | organizations to manage; the key is the Forgejo org name used in API paths |

### `orgs.<org>` (org config)

| Field | Type | Required / default | Cycle | Meaning |
|---|---|---|---|---|
| `settings` | object | optional | `org-settings` | org-level settings (below) |
| `members` | list | optional | `membership` | expected org members (presence; removal-only, see below) |
| `teams` | map of name → team | optional | `teams` | teams with members and repo access |
| `repos` | map of name → repo | optional | `repo-settings`, `branch-protection`, `webhooks`, `secrets-variables` | per-repo desired state (each cycle reads its own slice) |
| `repoBaselines` | list | optional | `repo-baseline` | repos that must exist (create-only provisioning) |
| `secrets` | list | optional | `secrets-variables` | org-level Actions secrets (presence only) |
| `variables` | list | optional | `secrets-variables` | org-level Actions variables (name + value) |
| `webhooks` | list | optional | `webhooks` | org-level webhooks, keyed by `url` |

### `settings` (cycle: `org-settings`)

Applied as a partial `PATCH /orgs/{org}` with only the declared keys.

| Field | Type | Required / default | Meaning |
|---|---|---|---|
| `fullName` | string | optional | display name (`full_name`) |
| `description` | string | optional | org description |
| `website` | string | optional | org website URL |
| `location` | string | optional | org location |
| `visibility` | `public` \| `limited` \| `private` | optional | org visibility. `limited` = visible to signed-in users only (Forgejo-specific; GitHub has no equivalent) |
| `repoAdminChangeTeamAccess` | boolean | optional | whether repo admins may change team access to their repos |

### `members[]` (cycle: `membership`)

| Field | Type | Required / default | Meaning |
|---|---|---|---|
| `username` | string | **required** | expected org member |

Forgejo has no direct "add org member" endpoint — membership is a consequence of
team membership. This cycle therefore only removes members (an unlisted member,
when deletes are active) and fails loudly if the diff asks it to add one,
pointing you at the `teams` cycle. There is no role field here; permission is
expressed through teams.

### `teams{}` (cycle: `teams`)

Keyed by team name. On create, `members` and `repos` are applied inline with the
new team; on an existing team they reconcile as separate child entries.

| Field | Type | Required / default | Meaning |
|---|---|---|---|
| `description` | string | optional | team description |
| `permission` | `read` \| `write` \| `admin` \| `owner` | optional | access level the team grants on its repos |
| `canCreateOrgRepo` | boolean | optional | may team members create org repos |
| `includesAllRepositories` | boolean | optional | team has access to every org repo |
| `units` | list of string | optional | enabled units, e.g. `repo.code`, `repo.issues`, `repo.pulls` |
| `members` | list of `{username}` | optional | team members (presence) |
| `repos` | list of `{name}` | optional | org repos the team has access to (presence) |
| `previously` | string | optional | former team name; a rename is resolved into an update instead of a delete + create (`resolveRenames` guardrail step) |

### `repos{}` scalar fields + `topics` (cycle: `repo-settings`)

Applied as a partial `PATCH /repos/{org}/{repo}`; `topics` is a separate
full-replacement `PUT /repos/{org}/{repo}/topics`. This cycle never creates a
repo — a declared repo missing live surfaces as a failed entry ("this repo
doesn't exist yet"); provision it with `repoBaselines`.

| Field | Type | Required / default | Meaning |
|---|---|---|---|
| `description` | string | optional | repo description |
| `website` | string | optional | repo website URL |
| `private` | boolean | optional | repo is private |
| `hasIssues` | boolean | optional | issues enabled |
| `hasWiki` | boolean | optional | wiki enabled |
| `hasPullRequests` | boolean | optional | pull requests enabled |
| `defaultBranch` | string | optional | default branch name |
| `allowMergeCommits` | boolean | optional | merge commits allowed |
| `allowRebase` | boolean | optional | rebase merges allowed |
| `allowSquashMerge` | boolean | optional | squash merges allowed |
| `defaultMergeStyle` | string | optional | `merge` \| `rebase` \| `rebase-merge` \| `squash` |
| `topics` | list of string | optional | repo topics; compared order-insensitively, applied as full replacement |

### `repos.<name>.branchProtection[]` (cycle: `branch-protection`)

Forgejo uses branch protections (its `branch_protections` API), not GitHub-style
rulesets. Entries are keyed by `ruleName` (Forgejo's `rule_name` — a branch name
or glob such as `release/*`).

| Field | Type | Required / default | Meaning |
|---|---|---|---|
| `ruleName` | string | **required** (identity key) | rule name / branch glob the rule applies to |
| `enablePush` | boolean | optional | allow direct pushes to matching branches |
| `requireSignedCommits` | boolean | optional | require signed commits |
| `requiredApprovals` | number | optional | required PR approvals |
| `enableStatusCheck` | boolean | optional | require status checks |
| `statusCheckContexts` | list of string | optional | required status-check contexts (order-insensitive compare) |
| `blockOnOutdatedBranch` | boolean | optional | block merge when the branch is behind |
| `dismissStaleApprovals` | boolean | optional | dismiss approvals on new pushes |

### `webhooks[]` — org scope and `repos.<name>.webhooks[]` (cycle: `webhooks`)

Keyed by `url`. Forgejo addresses a hook by numeric id internally; warden tracks
the live id for you and updates/deletes by it.

| Field | Type | Required / default | Meaning |
|---|---|---|---|
| `url` | string | **required** (identity key) | delivery URL |
| `type` | string | default `forgejo` on create | hook type, e.g. `forgejo`, `gitea`, `slack` |
| `contentType` | `json` \| `form` | default `json` | payload content type |
| `events` | list of string | optional | events to deliver (order-insensitive compare) |
| `active` | boolean | optional | hook enabled |
| `branchFilter` | string | optional | branch filter glob |

### `secrets[]` — org scope and `repos.<name>.secrets[]` (cycle: `secrets-variables`)

| Field | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | string | **required** (identity key) | Actions secret name |

Secrets are write-only in the Forgejo API, so warden reconciles **presence
only**: a listed secret missing live is created, and its value comes from the
environment variable `FORGEJO_SECRET_<NAME>` at apply time (an empty placeholder
is written if that variable is unset — set the real value out-of-band). Values
are never read back or diffed, so warden cannot detect a changed secret value.

### `variables[]` — org scope and `repos.<name>.variables[]` (cycle: `secrets-variables`)

| Field | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | string | **required** (identity key) | Actions variable name |
| `value` | string | optional | desired value. Declared: reconciled fully (drift is corrected). Omitted: presence only; a create writes an empty string |

### `repoBaselines[]` (cycle: `repo-baseline`)

Existence-only provisioning: a listed repo missing from the org is created;
existing repos are never updated or deleted by this cycle. Pair a baseline with
an entry under `repos:` to also manage its settings.

| Field | Type | Required / default | Meaning |
|---|---|---|---|
| `name` | string | **required** | repo that must exist in the org |
| `template` | string (`owner/repo`) | optional | generate the new repo from this template (`POST /repos/{owner}/{repo}/generate`); omitted: create an empty repo |
| `private` | boolean | default `true` | whether the newly created repo is private |

## What a plan looks like

`--mode dry-run` (the default) prints one plan per cycle per org, listing
creates, updates (with field-level before/after), and deletes (when active),
in a stable order. Nothing is written. `--mode apply` performs the same diff,
runs the guardrails, then applies each entry — see [CLI.md](CLI.md).
