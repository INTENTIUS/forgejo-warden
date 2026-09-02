---
name: forgejo-warden
description: Set up and run Forgejo/Codeberg org governance in this repo via the forgejo-warden CLI — author the orgs: policy, dry-run a reconcile, read the plan, and (only with human approval) apply. Use when an operator asks to configure, audit, or reconcile a Forgejo or Codeberg org, its teams, repos, branch protection, secrets, or webhooks here.
---

# forgejo-warden

Use the **`forgejo-warden` CLI** to govern Forgejo/Codeberg orgs from a declared
YAML policy. This skill is a pointer — do not restate the docs, read them:

- [POLICY.md](../../../POLICY.md) — authoring the `orgs:` policy (a complete
  annotated example plus per-field reference). The policy is
  selective-by-omission: absent fields are never touched.
- [SETUP.md](../../../SETUP.md) — API token creation, base URL
  (self-hosted / Codeberg), first dry-run, and the local docker sandbox.
- [CLI.md](../../../CLI.md) — flags, config loading, exit codes, token scopes.
- [CYCLES.md](../../../CYCLES.md) — what each of the 8 cycles reads and applies.

Core rules:

- Dry-run is the default and safe: `forgejo-warden reconcile --config <policy>
  --base-url <url> --token-env <VAR>` only reads and prints a plan.
- **Never pass `--mode apply` until a human has reviewed the rendered plan.**
  Show them the dry-run output first.
- Exit `1` means a guardrail blocked the apply (removal cap): stop and ask the
  operator; do not reach for `--allow-guardrail-override` on your own. Exit `2`
  is an argument/config error, `3` a runtime/apply failure.
- The token comes from an env var via `--token-env`; never put it in argv or
  files.

Forgejo quirks you must respect:

- Org membership is team-driven: adds go through `teams.<name>.members`, never
  the `members:` list (the membership cycle can only remove).
- `repoBaselines` only creates missing repos — it never updates or deletes;
  ongoing settings live under `repos:` (the repo-settings cycle, which itself
  never creates).
- Secret values are write-only: warden reconciles presence only, and a created
  secret's value comes from `FORGEJO_SECRET_<NAME>` in the environment at apply
  time (empty placeholder otherwise).
