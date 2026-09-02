# Running warden in CI

The natural home for the policy is a git repo, with warden run by CI:

- **on pull request** — dry-run, so the plan is visible before merge;
- **on push to the default branch** — apply, so merging the policy converges the org;
- **on a schedule** — apply (or dry-run, if you prefer alerts over correction),
  so out-of-band drift gets caught even when nobody edits the policy.

Exit codes make this easy to wire: 0 success, 1 guardrail block, 2 arg/config
error, 3 runtime/apply failure ([CLI.md](CLI.md)). A guardrail block failing the
job is the desired behavior — it means a human should look at the plan.

The token is a repository secret (never a file in the repo, never a flag —
warden reads it from an env var via `--token-env`). Create a
`FORGEJO_WARDEN_TOKEN` secret holding an API token with write access to the
managed orgs ([SETUP.md](SETUP.md)).

## Forgejo Actions

Forgejo Actions is GitHub-Actions-compatible, so the workflow reads the same.
Enable Actions on the policy repo and add the secret under repo Settings →
Actions → Secrets. One workflow can cover all three triggers:

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
      image: node:22-bookworm
    steps:
      - uses: actions/checkout@v4

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

## GitHub Actions

If the policy repo lives on GitHub (governing a Forgejo instance elsewhere),
the same shape works with the instance URL pinned. Two secrets/variables:
`FORGEJO_WARDEN_TOKEN` (secret) and the instance URL (a plain variable is
fine — it isn't sensitive).

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
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

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

## Notes

- **Secrets values in CI.** The `secrets-variables` cycle writes a secret's
  value from `FORGEJO_SECRET_<NAME>` in the warden process's environment. To
  have CI provision real values, map them in the apply step:
  `env: { FORGEJO_SECRET_DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }} }`. Without
  that, a newly created secret gets an empty placeholder.
- **Scoping runs.** `--cycles` lets a job reconcile a subset — for instance a
  frequent schedule for `branch-protection` and a daily one for everything.
- **Dry-run plans on PRs.** The plan goes to the job log. If you want it on the
  PR itself, capture stdout and post it as a comment with your forge's API; the
  plan is plain text and stable-ordered, so diffs between runs are readable.
- **Pinning.** `npx @intentius/forgejo-warden@0.1.1 ...` pins the version so a
  new release can't change CI behavior unreviewed.
