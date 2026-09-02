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

| Cycle | Read | Apply + idempotence + drift | Delete via `owned` | Extras exercised |
|---|---|---|---|---|
| `org-settings` | yes | yes (description/website) | n/a (never deletes) | — |
| `membership` | yes | remove-only: no create path | yes (org member removed) | loud failure on a member create (adds are team-driven) |
| `teams` | yes | yes (create with members + repos; description drift) | yes (stale team; out-of-band team member) | `previously:` rename WITHOUT `owned` — one update, id and members survive |
| `repo-settings` | yes | yes (description/wiki/topics) | n/a (never deletes) | topics as a full-replacement set |
| `branch-protection` | yes | yes (rule create; approvals drift) | yes (rule removed) | — |
| `repo-baseline` | yes | create-only + idempotence | n/a (never deletes) | generation from a template repo, asserting the template's files actually arrive (`git_content`) |
| `secrets-variables` | yes | yes (variable value drift) | yes (org secret + variables) | secret material from `FORGEJO_SECRET_<NAME>`; repo-variable value re-fetch (Forgejo's list omits `data`) |
| `webhooks` | yes | yes (org + repo hooks; active-flag drift) | yes (org + repo hooks) | — |

Guardrails ride along implicitly: delete scenarios pass an explicit
`removalDeltaCapFraction` where the default 25% `removalLiveCap` would
(correctly) block a small-denominator smoke org.
