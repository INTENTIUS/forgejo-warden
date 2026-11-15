# Running warden in CI

The steady state for governance is a pipeline: dry-run the plan on every pull
request, apply on the default branch, and a scheduled run to correct drift
that happens between pushes. The dry-run makes the plan visible before merge,
the apply keeps a merged policy converging the org, and the scheduled run
(apply, or dry-run if you prefer alerts over correction) catches out-of-band
drift even when nobody edits the policy.

Exit codes make this easy to wire: 0 success, 1 guardrail block, 2 arg/config
error, 3 runtime/apply failure ([CLI.md](CLI.md)). A guardrail block failing
the job is the desired behavior: it means a human should look at the plan.

The token is a repository secret; warden never takes it as a file in the repo
or as a flag, only from an env var via `--token-env`. Create a
`FORGEJO_WARDEN_TOKEN` secret holding an API token with write access to the
managed orgs ([SETUP.md](SETUP.md)).

## Forgejo Actions

Forgejo Actions is GitHub-Actions-compatible, so the workflow reads the same.
Enable Actions on the policy repo and add the secret under repo Settings >
Actions > Secrets. One workflow can cover all three triggers:

```yaml
# .forgejo/workflows/governance.yml
name: governance

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 4 * * *"   # nightly drift run

jobs:
  reconcile:
    runs-on: docker
    container:
      image: node:24-bookworm
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - name: Dry-run (pull request)
        if: github.event_name == 'pull_request'
        env:
          FORGEJO_TOKEN: ${{ secrets.FORGEJO_WARDEN_TOKEN }}
        run: |
          npx @intentius/forgejo-warden reconcile \
            --config governance.yml \
            --base-url ${{ github.server_url }} \
            --token-env FORGEJO_TOKEN \
            --mode dry-run

      - name: Apply (main / schedule)
        if: github.event_name != 'pull_request'
        env:
          FORGEJO_TOKEN: ${{ secrets.FORGEJO_WARDEN_TOKEN }}
        run: |
          npx @intentius/forgejo-warden reconcile \
            --config governance.yml \
            --base-url ${{ github.server_url }} \
            --token-env FORGEJO_TOKEN \
            --mode apply
```

`${{ github.server_url }}` is the instance the workflow runs on, so the same
workflow file works on any Forgejo. Hardcode `--base-url` instead if the policy
repo lives on a different instance than the one it governs.

### A scheduled drift issue

To be told about drift rather than have the schedule correct it, run the
scheduled job as a dry run with `--drift-issue`: one issue in the policy
repository tracks the drift, is updated when it changes, and closes on the
first run that finds the forge matching the policy again
([CLI.md](CLI.md#drift-issue)). The token needs to read and write issues in
the policy repository as well as read the managed orgs.

```yaml
# .forgejo/workflows/governance-drift.yml
name: governance drift

on:
  schedule:
    - cron: "17 4 * * *"   # nightly
  workflow_dispatch:

jobs:
  drift:
    runs-on: docker
    container:
      image: node:24-bookworm
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4

      - name: Dry-run and keep the drift issue
        env:
          FORGEJO_TOKEN: ${{ secrets.FORGEJO_WARDEN_TOKEN }}
        run: |
          npx @intentius/forgejo-warden reconcile \
            --config governance.yml \
            --base-url ${{ github.server_url }} \
            --token-env FORGEJO_TOKEN \
            --mode dry-run \
            --drift-issue
```

The issue goes to the workflow's own repository (`FORGEJO_REPOSITORY`) and
links the run. Drop the `schedule` trigger from the apply step of the workflow
above when this job replaces it.

## GitHub Actions

If the policy repo lives on GitHub (governing a Forgejo instance elsewhere),
the same shape works with the instance URL pinned. You need two values in the
repo: the `FORGEJO_WARDEN_TOKEN` secret, and the instance URL in a plain
variable (it isn't sensitive).

```yaml
# .github/workflows/governance.yml
name: governance

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 4 * * *"

permissions:
  contents: read

jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '24'

      - name: Dry-run (pull request)
        if: github.event_name == 'pull_request'
        env:
          FORGEJO_TOKEN: ${{ secrets.FORGEJO_WARDEN_TOKEN }}
        run: |
          npx @intentius/forgejo-warden reconcile \
            --config governance.yml \
            --base-url ${{ vars.FORGEJO_URL }} \
            --token-env FORGEJO_TOKEN \
            --mode dry-run

      - name: Apply (main / schedule)
        if: github.event_name != 'pull_request'
        env:
          FORGEJO_TOKEN: ${{ secrets.FORGEJO_WARDEN_TOKEN }}
        run: |
          npx @intentius/forgejo-warden reconcile \
            --config governance.yml \
            --base-url ${{ vars.FORGEJO_URL }} \
            --token-env FORGEJO_TOKEN \
            --mode apply
```

A policy repository on GitHub keeps its drift issue on the Forgejo instance
it governs, so the scheduled dry run names a repository there with
`--drift-issue-repo <owner/name>`; `GITHUB_REPOSITORY` would name the GitHub
repository.

## Notes

The `secrets-variables` cycle writes a secret's value from
`FORGEJO_SECRET_<NAME>` in the warden process's environment. To have CI
provision real values, map them in the apply step:
`env: { FORGEJO_SECRET_DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }} }`. Without that,
a newly created secret gets an empty placeholder.

`--cycles` lets a job reconcile a subset, for instance a frequent schedule for
`branch-protection` and a daily one for everything.

Dry-run plans on PRs go to the job log. If you want the plan on the PR itself,
capture stdout and post it as a comment with your forge's API; the plan is
plain text and stable-ordered, so diffs between runs are readable.

Pin the version with `npx @intentius/forgejo-warden@0.1.2 ...` so a new release
can't change CI behavior unreviewed.
