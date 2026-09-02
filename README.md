# forgejo-warden

<p>
  <a href="https://github.com/INTENTIUS/forgejo-warden/actions/workflows/ci.yml"><img src="https://github.com/INTENTIUS/forgejo-warden/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/INTENTIUS/forgejo-warden/actions/workflows/e2e.yml"><img src="https://github.com/INTENTIUS/forgejo-warden/actions/workflows/e2e.yml/badge.svg" alt="e2e"></a>
  <a href="https://www.npmjs.com/package/@intentius/forgejo-warden"><img src="https://img.shields.io/npm/v/@intentius/forgejo-warden" alt="npm"></a>
</p>

Keep your Forgejo org and repos in a declared state, with guardrails and drift
correction. This is a sibling of
[github-warden](https://github.com/INTENTIUS/github-warden), built on the shared
reconcile primitive in
[`@intentius/chant/reconcile`](https://github.com/INTENTIUS/chant). What this
repo supplies is the Forgejo layer: a REST client for a self-hosted instance,
the config and live-state types, and a Forgejo `diff()` with its reconcile
cycles.

See the [docs site](https://intentius.io/forgejo-warden/) for these pages
rendered ([policy](POLICY.md) · [CLI](CLI.md) · [cycles](CYCLES.md) ·
[CI](CI.md) · [setup](SETUP.md)).

## What you need

- A clone of this repo (`git clone https://github.com/INTENTIUS/forgejo-warden`).
  The agent skill, the annotated policy example, and the CI templates live in
  it, and setup ends with a pipeline ([CI.md](CI.md)), so you'll have the repo
  anyway.
- A Forgejo API token ([SETUP.md](SETUP.md) has the click-path and scopes; a
  dry-run needs only read). Any self-hosted Forgejo works, and so does
  [Codeberg](https://codeberg.org); point `--base-url` at the instance.
- Node 22+.

About ten minutes to a first dry-run plan. To probe before cloning anything:

```bash
# Dry-run against your instance: reads only, prints a plan, changes nothing.
npx @intentius/forgejo-warden reconcile --config governance.yml --base-url https://forgejo.example.com --token-env FORGEJO_TOKEN --mode dry-run
```

The [npm package](https://www.npmjs.com/package/@intentius/forgejo-warden) is
there for pipelines; day-to-day authoring happens in the checkout.

## Set up with an agent

From a checkout, Claude Code picks up the skill in
`.claude/skills/forgejo-warden/` automatically. It knows the policy format and
the CLI, and it follows the safety rules: dry-run first, and deletes only in
orgs marked `owned`. For other agents, run
`npx skills add INTENTIUS/forgejo-warden` or copy the skill directory into
`~/.claude/skills/`.

Paste this, filling in the placeholders:

```text
Use the forgejo-warden skill in this repo to help me set up governance for my
Forgejo org <ORG> on <BASE_URL>. My API token is in the <TOKEN_ENV> env var.
Author a governance.yml policy for the org settings, teams, and repos I care
about (interview me for the details), then run a dry-run reconcile and walk me
through the plan. Do not apply anything.
```

## What it reconciles

You declare desired state in YAML (selective-by-omission: an absent field is
never touched); warden diffs it against the live org and, in `apply` mode,
converges it. Deletes are opt-in per org via `owned:` and guarded by a removal
cap so a typo can't mass-delete ([POLICY.md](POLICY.md), "Delete semantics").

| Cycle | Reconciles |
|-------|------------|
| `org-settings` | org name/description/website/visibility, repo-admin team access |
| `membership` | org members (team-driven; ownership-gated removal) |
| `teams` | teams + their members and repo access |
| `repo-settings` | repo settings + topics |
| `branch-protection` | Forgejo `branch_protections` (not rulesets) |
| `repo-baseline` | provision repos (empty or from a template) |
| `secrets-variables` | Actions secrets (presence) + variables (value), org & repo |
| `webhooks` | org & repo webhooks |

## Tests

`npm test` runs the unit suite (mock-client, fully offline). The
[e2e suite](https://github.com/INTENTIUS/forgejo-warden/tree/main/e2e) is
**fully hermetic**: it stands up a throwaway Forgejo via Docker Compose and
mints an admin token, then provisions its own org and exercises every cycle
before tearing down. No external account or secrets are needed:

```sh
eval "$(npm run --silent e2e:up)"   # compose up + mint token
npm run test:e2e:run                # FORGEJO_E2E_APPLY=1 to include the apply phase
npm run e2e:down                    # compose down -v
```

CI runs it on every push to main and nightly.

## How it differs from github-warden

The client takes a configurable instance base URL instead of a fixed API host,
and auth is a plain Forgejo API token with no GitHub Apps or installation-token
machinery. Membership is team-driven here, branch protection stands in for
rulesets, and webhooks are in scope. Some GitHub surfaces have no Forgejo
equivalent and stay out of scope; that covers GHAS and the other security
features, deployment environments, and Dependabot, as well as fine-grained PAT
governance.
