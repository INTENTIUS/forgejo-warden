# CLI

One subcommand: `reconcile`. It loads the policy, builds an authed client for
your Forgejo instance, runs the selected cycles, and prints one plan per cycle
per org.

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

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--config <path>` | yes | — | policy file (YAML or JSON; see below) |
| `--mode dry-run\|apply` | no | `dry-run` | `dry-run` computes and prints plans; `apply` also mutates the instance (guardrails permitting) |
| `--cycles <name[,name...]>` | no | all cycles | comma-separated subset of cycles to run, e.g. `--cycles org-settings,teams`. Unknown names exit 2 and list the known cycles |
| `--base-url <url>` | one of the two | — | Forgejo instance URL, e.g. `https://forgejo.example.com` or `https://codeberg.org` (no trailing `/api`) |
| `--base-url-env <VAR>` | one of the two | — | env var holding the instance URL instead of putting it on the command line |
| `--token-env <VAR>` | yes | — | env var holding the Forgejo API token. The token itself never appears in argv |
| `--allow-guardrail-override` | no | off | apply even when a guardrail trips (the plan still prints the guardrail block) |

Cycle names (see [CYCLES.md](CYCLES.md)): `org-settings`, `membership`, `teams`,
`repo-settings`, `branch-protection`, `repo-baseline`, `secrets-variables`,
`webhooks`.

## Config loading

- A path ending in `.json` is parsed as JSON; anything else is parsed as YAML.
- The parsed document must be an object with an `orgs` map, otherwise the run
  exits 2 with `invalid governance config`.
- No further schema validation happens at load time; unknown fields are ignored
  by the cycles (each cycle reads only its declared slice).

## Auth

Auth is a single Forgejo API token plus the instance base URL — there is no
GitHub-Apps-style installation-token machinery. Requests go to
`<base-url>/api/v1/...` with an `Authorization: token <token>` header, so the
same invocation works against any self-hosted Forgejo, a Gitea instance with a
compatible API, or Codeberg (`--base-url https://codeberg.org`).

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

In `apply` mode each block is followed by `Applied: N, Failed: N` and a `FAILED`
line per entry that errored (the run continues past individual failures). A
tripped guardrail prints `GUARDRAIL BLOCK: <reason>` and skips that cycle's
apply. Cycles that errored during fetch print `ERROR in <cycle> @ <org>` on
stderr, and cycles skipped because the request budget ran out print
`DEFERRED (budget): ...` (the budget defaults to 1000 API requests per run and
is not currently exposed as a flag).

## Guardrails

The apply path runs one guardrail, `removalDeltaCap`: it refuses an apply whose
deletes exceed 25% of the pre-existing managed entries (deletes + updates), so a
truncated or mistyped policy cannot mass-delete in one run. Rename aliases
(`previously:` on a team) are resolved first, so a rename does not count as a
delete. `--allow-guardrail-override` applies anyway; use it deliberately.

Deletes themselves are opt-in per org: the plan contains them only for orgs the
policy marks with `owned:` (see [POLICY.md](POLICY.md), "Delete semantics").
For an org without `owned`, plans never contain deletes and the cap has nothing
to block.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success (dry-run printed, or apply completed with no failures) |
| 1 | a guardrail blocked an apply |
| 2 | argument or config error (bad flag, missing env var, unparseable policy, unknown cycle) |
| 3 | runtime error (API failure, failed apply entries, cycle errors) |

In CI, treat 0 as pass, 1 as "needs a human", and 2/3 as failures.
