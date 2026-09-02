# forgejo-warden

<p>
  <a href="https://github.com/INTENTIUS/forgejo-warden/actions/workflows/ci.yml"><img src="https://github.com/INTENTIUS/forgejo-warden/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/INTENTIUS/forgejo-warden/actions/workflows/e2e.yml"><img src="https://github.com/INTENTIUS/forgejo-warden/actions/workflows/e2e.yml/badge.svg" alt="e2e"></a>
  <a href="https://www.npmjs.com/package/@intentius/forgejo-warden"><img src="https://img.shields.io/npm/v/@intentius/forgejo-warden" alt="npm"></a>
</p>

**Keep your Forgejo org and repos in a declared state, with guardrails and
drift correction.**

Full documentation lives at
[intentius.io/forgejo-warden](https://intentius.io/forgejo-warden/), with deep
dives on these pages.

- [Policy](POLICY.md)
- [CLI](CLI.md)
- [Cycles](CYCLES.md)
- [CI pipelines](CI.md)
- [Setup](SETUP.md)

## Set up with an agent

From a checkout, Claude Code picks up the skill in
`.claude/skills/forgejo-warden` automatically. Other agents can install it with
`npx skills add INTENTIUS/forgejo-warden`, or by copying the skill directory
into `~/.claude/skills/`. Then paste this prompt, filling in the placeholders:

```text
Use the forgejo-warden skill in this repo to help me set up governance for my
Forgejo org <ORG> on <BASE_URL>. My API token is in the <TOKEN_ENV> env var.
Author a governance.yml policy for the org settings, teams, and repos I care
about (interview me for the details), then run a dry-run reconcile and walk me
through the plan. Do not apply anything.
```

The skill holds the agent to dry-run until you've reviewed the plan; deletes
stay off entirely until you mark an org `owned` in the policy.

## What you need

- A clone of this repo (`git clone https://github.com/INTENTIUS/forgejo-warden`).
  The agent skill, the annotated policy example, and the CI templates live in
  it, and setup ends with a pipeline ([CI.md](CI.md)), so you'll have the repo
  anyway.
- A Forgejo API token ([SETUP.md](SETUP.md) has the click-path and scopes; a
  dry-run needs only read). Any self-hosted Forgejo works, and so does
  [Codeberg](https://codeberg.org); point `--base-url` at the instance.
- Node 22+.

About ten minutes gets you to a first dry-run plan. The quickest probe needs
no clone at all:

```bash
# Dry-run: reads only, prints a plan, changes nothing.
npx @intentius/forgejo-warden reconcile --config governance.yml --base-url https://forgejo.example.com --token-env FORGEJO_TOKEN --mode dry-run
```

The [npm package](https://www.npmjs.com/package/@intentius/forgejo-warden) is
there for pipelines; day-to-day authoring happens in the checkout.

## What it reconciles

You declare desired state in YAML (selective-by-omission: an absent field is
never read, diffed, or touched); warden diffs it against the live org and, in
`apply` mode, converges it. Deletes are opt-in per org via `owned:` and guarded
by a removal cap so a typo can't mass-delete ([POLICY.md](POLICY.md), "Delete
semantics").

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
mints an admin token, then provisions its own org and runs every cycle's read
path against it (fetchLive, buildDesired, diff, asserted read-only), so live
API-contract drift gets caught. The opt-in apply phase is a full smoke: every
cycle applies from a policy, converges to an empty plan, and corrects an
out-of-band mutation, plus real `owned:` deletes, the `previously:` team
rename, template-based repo provisioning, and secret/membership semantics —
see [e2e/README.md](https://github.com/INTENTIUS/forgejo-warden/blob/main/e2e/README.md)
for the coverage table. No external account or secrets are needed:

```sh
eval "$(npm run --silent e2e:up)"   # compose up + mint token
npm run test:e2e:run                # FORGEJO_E2E_APPLY=1 to include the apply phase
npm run e2e:down                    # compose down -v
```

CI runs it on every push to main and nightly.

## How it differs from github-warden

This is a sibling of
[github-warden](https://github.com/INTENTIUS/github-warden), built on the
shared reconcile primitive in
[`@intentius/chant/reconcile`](https://github.com/INTENTIUS/chant). What this
repo supplies is the Forgejo layer: a REST client for a self-hosted instance,
the config and live-state types, and a Forgejo `diff()` with its reconcile
cycles.

The client takes a configurable instance base URL instead of a fixed API host,
and auth is a plain Forgejo API token with no GitHub Apps or installation-token
machinery. Membership is team-driven here, branch protection stands in for
rulesets, and webhooks are in scope. Some GitHub surfaces have no Forgejo
equivalent and stay out of scope; that covers GHAS and the other security
features, deployment environments, and Dependabot, as well as fine-grained PAT
governance.
