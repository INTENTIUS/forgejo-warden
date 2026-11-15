# CLI

Two subcommands. `reconcile` loads the policy and builds an authed client for
your Forgejo instance, then runs the selected cycles and prints one plan per
cycle per org. With `--plan-json` it also writes the plan as a chant
change-set part, and with `--drift-issue` it keeps one forge issue tracking
the drift a dry run finds. `repos` writes the policy's org's repository list for
`chant workspace check --forge-repos` (see "repos" below).

```bash
forgejo-warden reconcile \
  --config governance.yml \
  --base-url https://forgejo.example.com \
  --token-env FORGEJO_TOKEN \
  --mode dry-run
```

`forgejo-warden --help` (or no arguments, or `--help` after a subcommand)
prints usage; `forgejo-warden --version` prints the version (inlined from
package.json at build time).

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | `governance.yml` in the working directory | policy file (YAML, JSON, or a `.ts` policy; see below). When `governance.yml` is absent and `governance.ts` exists, that is read instead. With neither, exits 2 |
| `--config-mode fold\|run\|check` | `fold` | how a `.ts` policy is evaluated: `fold` reduces it to its value without running it, `run` imports it, `check` does both and exits 2 if they differ |
| `--mode dry-run\|apply` | `dry-run` | `dry-run` computes and prints plans; `apply` also mutates the instance (guardrails permitting) |
| `--cycles <name[,name...]>` | all cycles | comma-separated subset of cycles to run, e.g. `--cycles org-settings,teams`. Unknown names exit 2 and list the known cycles |
| `--base-url <url>` | one of the two URL flags is **required** | Forgejo instance URL, e.g. `https://forgejo.example.com` or `https://codeberg.org` (no trailing `/api`) |
| `--base-url-env <VAR>` | — | env var holding the instance URL instead of putting it on the command line |
| `--token-env <VAR>` | **required** | env var holding the Forgejo API token. The token itself never appears in argv |
| `--removal-cap-fraction <f>` | `0.25` | removal-cap threshold, a number in (0,1]; values outside that range exit 2 (see "Guardrails" below) |
| `--allow-guardrail-override` | off | apply even when a guardrail trips (the plan still prints the guardrail block) |
| `--plan-json <file>` | none | also write the plan to the file as a chant change-set part (see "Plan as a change-set part" below). Nothing is applied: combining it with `--mode apply` exits 2 |
| `--member <name>` | the name of the policy file's directory | the workspace member the `--plan-json` part and the `--drift-issue` records name. Giving it without either flag exits 2 |
| `--drift-issue` | off | keep one issue tracking the drift this dry run finds (see "Drift issue" below). Combining it with `--mode apply` or `--cycles` exits 2 |
| `--drift-issue-repo <owner/name>` | `FORGEJO_REPOSITORY`, else `GITHUB_REPOSITORY` | the repository on the governed instance that holds the drift issue. Giving it without `--drift-issue`, or a value that is not `owner/name`, exits 2 |

Cycle names (see [CYCLES.md](CYCLES.md)): `org-settings`, `membership`, `teams`,
`repo-settings`, `branch-protection`, `repo-baseline`, `secrets-variables`,
`webhooks`.

## Config loading

- A path ending in `.json` is parsed as JSON; a path ending in `.ts` is a
  TypeScript policy whose default export is the policy (see `--config-mode`);
  anything else is parsed as YAML.
- The parsed document must be an object with an `orgs` map, otherwise the run
  exits 2 with `invalid governance config`.
- No further schema validation happens at load time; unknown fields are ignored
  by the cycles (each cycle reads only its declared slice).

## Auth

Auth is a single Forgejo API token plus the instance base URL — there is no
GitHub-Apps-style installation-token machinery. Requests go to
`<base-url>/api/v1/...` with an `Authorization: token <token>` header. The same
invocation therefore works against any self-hosted Forgejo or Codeberg
(`--base-url https://codeberg.org`), and against a Gitea instance with a
compatible API.

### Token permissions

The token must belong to a user with owner/admin rights in every org the policy
manages. Scope-wise it needs read/write on the surfaces the cycles touch:

- organization (org settings, members, teams)
- repository (repo settings, topics, branch protections, webhooks, repo creation for `repo-baseline`)
- Actions secrets/variables (the `secrets-variables` cycle)

When creating a scoped token in the Forgejo UI, grant read-and-write on
`organization` and `repository` at minimum; a dry-run needs only read. The e2e
suite mints its token with `--scopes all` for simplicity. See
[SETUP.md](SETUP.md) for the click-path.

## Output

For each cycle and org, the run prints:

```
=== <cycle> @ <org> ===
<plan: creates / updates (field diffs) / deletes>
```

When the policy is a `.ts` file loaded in `fold` (the default) or `check`
mode, each drifted field in an update is followed by a line saying where the
policy wrote the value it wants back:

```
UPDATE:
  [repo] api
    hasWiki: true → false
      <- direct
    allowMergeCommits: true → false
      <- reviewPreset(...) argument squashOnly at examples/governance.ts:33:55
```

| Origin line | Meaning |
|---|---|
| `direct` | the value is written on the field itself in the policy |
| `<fn>(...) argument <param> at <file>:<line>:<col>` | a function in the policy (a preset) set the field from one of its parameters; the location is the argument at the call, so change the argument to change the field. When the parameter's default applied, the line names the call instead |
| `<fn>(...) sets it in its body at <file>:<line>:<col>, called at ...` | the function's body fixes the value, so the edit belongs in the function |
| `unknown (<reason>)` | the fold could not attribute the value; it is never reported as `direct` |

A YAML or JSON policy, or a `.ts` policy loaded with `--config-mode run`,
prints the plan without these lines. The same origins are on each cycle
result's `origins` field when warden is used as a library.

In `apply` mode each block is followed by `Applied: N, Failed: N` and a `FAILED`
line per entry that errored (the run continues past individual failures). A
tripped guardrail prints `GUARDRAIL BLOCK: <reason>` and skips that cycle's
apply. Cycles that errored while fetching live state or building desired state
print `ERROR in <cycle> @ <org>` on
stderr, and cycles skipped because the request budget ran out print
`DEFERRED (budget): ...` (the budget defaults to 1000 API requests per run and
is not currently exposed as a flag).

## Plan as a change-set part

`--plan-json <file>` writes the run's plan as one part of a chant change-set
document, so a governance member's planned changes can sit next to the rest of
a workspace's plan. The file is the output of `reconcilePlanPart` from
`@intentius/chant/change-set`, and chant reads it back with
`readChangeSetPartFile(part, "warden", member, "forgejo")`.

```bash
forgejo-warden reconcile \
  --config members/governance/governance.yml \
  --base-url https://forgejo.example.com \
  --token-env FORGEJO_TOKEN \
  --plan-json governance.plan.json
```

The part's member is named by `--member`, or by the policy file's directory
(`governance` above) when the flag is absent; a policy at the filesystem root
needs `--member`. Its planner is `warden` and its lexicon `forgejo`. Each
planned change is one entry with the address `<resourceType>.<key>` and the
org as its scope, and the member's `planDigest` covers every change set the
run planned.

When a cycle errors or the request budget defers one, the plan is incomplete:
the member's status is `failed`, its `planDigest` is `null` and its `error`
says which cycles are missing. The entries the other cycles planned stay in
the part. Once the cycles have run, the file is written whatever the exit
code.

## Drift issue

`--drift-issue` turns a scheduled dry run into one issue that tracks the
governance drift, instead of a job log nobody reads. It passes the run's drift
to `keepDriftIssue` from `@intentius/chant/drift-issue`:

- a run that finds drift opens the issue, or updates the open one when the
  drift changed. A run that finds the same drift leaves it as it is, so a
  nightly schedule does not open a second issue or edit the first;
- a run that finds no drift closes the open issue with a comment;
- a run where a cycle failed and found no drift leaves the open issue alone,
  since it cannot say the forge matches.

```bash
forgejo-warden reconcile \
  --config governance.yml \
  --base-url https://forgejo.example.com \
  --token-env FORGEJO_TOKEN \
  --drift-issue \
  --drift-issue-repo acme/governance
```

The drift is the same list `chant workspace drift` reports for the member
([README.md](README.md#drift)): each org, repo, team or branch protection rule
with planned changes under it, the changes as attributes. Each such node appears in the issue
with every attribute's declared and live values (secrets, variables
and webhooks without values). Nodes that could not be read are listed too. The run
must cover every cycle, so `--drift-issue` with `--cycles` exits 2: a subset
would report the other cycles' nodes as matching and close the issue.

This issue sits in a repository on the instance the run governs. The run reaches it with
the same `--base-url` and `--token-env` token, so that token must be able to read
and write issues there. The repository is `--drift-issue-repo`, or the
workflow's own repository from `FORGEJO_REPOSITORY` or `GITHUB_REPOSITORY` on
a Forgejo Actions runner. With none of them the run exits 2 before reading
the forge. A policy repository on GitHub that governs a Forgejo instance
passes `--drift-issue-repo` naming a repository on that instance.

One issue is kept per instance and policy: the hidden marker on its first line
names the instance's host and the policy's orgs
(`<!-- forgejo-warden:drift forgejo.example.com/acme -->`), and its title is
`Governance drift on forgejo.example.com/acme`. An issue closed by hand stays
closed, and the next drift opens a new one.

The run prints `Drift issue: <action>` with the issue's number and URL
(`opened`, `updated`, `unchanged`, `closed`, `left` or `none`). A dry run with
drift still exits 0. When the forge refuses the issue call the run exits 3.

## Guardrails

The apply path runs one guardrail: chant's `removalDeltaCap`, evaluated per
resource type against the live managed entries counted during the diff, so a
truncated or mistyped policy cannot mass-delete in one run. See
[POLICY.md](POLICY.md), "The removal cap" for the full promise.
`--removal-cap-fraction` sets the threshold (default 0.25, valid in (0,1];
out-of-range values exit 2). `--allow-guardrail-override` applies anyway;
use both deliberately.

Deletes themselves are opt-in per org: the plan contains them only for orgs the
policy marks with `owned:` (see [POLICY.md](POLICY.md), "Delete semantics").
For an org without `owned`, plans never contain deletes and the cap has nothing
to block.

## repos

`repos` lists every repository of the org the policy governs, archived ones
included, and writes the list in the format
`chant workspace check --forge-repos <file>` reads. chant never asks the forge
itself: it compares this list with an org workspace's `repo` members, and
reports a repository the forge lists that no member names (WSP014) and a
member naming a repository the forge no longer lists (WSP015). An archived
repository need not be declared.

```bash
forgejo-warden repos \
  --config governance.yml \
  --base-url https://forgejo.example.com \
  --token-env FORGEJO_TOKEN \
  --out forge-repos.json

chant workspace check --forge-repos forge-repos.json
```

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | `governance.yml` in the working directory | policy file, found and read the same way as for `reconcile` |
| `--config-mode fold\|run\|check` | `fold` | how a `.ts` policy is evaluated, as for `reconcile` |
| `--org <name>` | the policy's only org | the org to list; it must be one of the policy's orgs. A policy with several orgs needs it |
| `--out <file>` | stdout | file to write the list to |
| `--base-url <url>` | one of the two URL flags is **required** | Forgejo instance URL |
| `--base-url-env <VAR>` | none | env var holding the instance URL |
| `--token-env <VAR>` | **required** | env var holding the Forgejo API token; it needs read access to the org's repositories, private ones included |

The output names the forge and the org and lists each repository by its web
URL, sorted, with `archived: true` on an archived one:

```json
{
  "forge": "forgejo",
  "org": "acme",
  "repos": [
    { "url": "https://forgejo.example.com/acme/api" },
    { "url": "https://forgejo.example.com/acme/legacy", "archived": true }
  ]
}
```

chant matches URLs by host, owner and name, so a member that names the
repository by its https or ssh clone URL, with or without `.git`, matches the
web URL here. An org the instance does not have exits 3 rather than writing
an empty list, which chant would read as every member dropped. A policy with
no org, several orgs and no `--org`, or an `--org` the policy does not govern
exits 2.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success: the plan printed (dry-run), or apply completed with no failures. |
| 1 | Guardrail block: apply mode, at least one guardrail tripped, and `--allow-guardrail-override` was not set. |
| 2 | Argument or config error (unknown flag, unknown cycle, unreadable or invalid config, missing auth, an org `repos` cannot pick). |
| 3 | Runtime error (API failure, an errored cycle, failed apply entries, or a file that could not be written). |

In CI, treat 0 as pass and 1 as "needs a human"; treat 2 and 3 as failures.
