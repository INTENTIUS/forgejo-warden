# Hermetic e2e smoke suite

A throwaway Forgejo 11 (sqlite, Docker Compose) plus `warden.e2e.test.ts`.
No external account or secrets: `bootstrap.sh` stands the stack up, mints an
admin token, and the suite provisions its own org, repos, and a second user,
then tears everything down.

```sh
eval "$(npm run --silent e2e:up)"        # compose up + mint token
FORGEJO_E2E_APPLY=1 npm run test:e2e:run # full apply smoke (omit the var for read-only)
npm run e2e:down                         # compose down -v
```

The suite self-skips without `FORGEJO_E2E_URL` / `FORGEJO_E2E_TOKEN`; the apply
phase additionally requires `FORGEJO_E2E_APPLY=1` (CI sets it — see
`.github/workflows/e2e.yml`). Apply tests are order-dependent within the file:
the org's state evolves test by test, and vitest's in-file sequential execution
is what keeps that sound.

## Coverage

Read = fetchLive + buildDesired + diff against live, asserted read-only.
Apply = reconcile from a policy, then a dry-run asserting an empty plan
(idempotence), then an out-of-band API mutation corrected by a re-run.
Delete = a real deletion unlocked by `owned:` and verified by re-fetch.

| Cycle | Read | Apply | Converge | Drift | Delete via `owned` | Gated-read NOTE |
|---|---|---|---|---|---|---|
| org-settings | yes | yes (description/website) | yes | yes | n/a (never deletes) | — |
| membership | yes | n/a (remove-only; no create path) | — | — | yes (org member removed) | — |
| teams | yes | yes (create with members + repos) | yes | yes (description) | yes (stale team; out-of-band team member) | — |
| repo-settings | yes | yes (description/wiki/topics) | yes | yes | n/a (never deletes) | — |
| branch-protection | yes | yes (rule create) | yes | yes (approvals) | yes (rule removed) | — |
| repo-baseline | yes | yes (create-only) | yes | n/a (create-only) | n/a (never deletes) | — |
| secrets-variables | yes | yes | yes | yes (variable value) | yes (org secret + variables) | — |
| webhooks | yes | yes (org + repo hooks) | yes | yes (active flag) | yes (org + repo hooks) | — |

forgejo-warden implements no gated-read tolerance (there are no tier- or
permission-gated NOTE paths, unlike the sibling wardens), so that column has
nothing to exercise.

Extras exercised along the way:

- membership: loud failure on a member create (adds are team-driven).
- teams: the `previously:` rename WITHOUT `owned` — one update, id and
  members survive.
- repo-settings: topics as a full-replacement set.
- repo-baseline: generation from a template repo, asserting the template's
  files actually arrive (`git_content`).
- secrets-variables: secret material from `FORGEJO_SECRET_<NAME>`;
  repo-variable value re-fetch (Forgejo's list omits `data`).

Guardrails ride along implicitly: delete scenarios pass an explicit
`removalDeltaCapFraction` where the default 25% `removalDeltaCap` would
(correctly) block a small-denominator smoke org.
