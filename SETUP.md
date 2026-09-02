# Setup

Get from zero to a first dry-run against your instance.

## Install

The package ships a bundled CLI, `forgejo-warden`. Run it with npx or install it:

```bash
# one-off
npx @intentius/forgejo-warden

# or install
npm install -g @intentius/forgejo-warden
forgejo-warden --help
```

Node 20+ (the CLI uses the global `fetch`).

## Create an API token

Warden authenticates with a single Forgejo API token, sent as
`Authorization: token ...`. The token's user must be an owner (or site admin) of
every org the policy manages.

In the Forgejo web UI:

1. Avatar menu → **Settings** → **Applications**.
2. Under **Manage access tokens**, name the token (e.g. `forgejo-warden`).
3. Select scopes. For a dry-run, read access to `organization` and `repository`
   is enough. For apply, grant read-and-write on `organization` and
   `repository`; the `secrets-variables` cycle also needs whatever your Forgejo
   version gates Actions secrets/variables behind (on current versions this is
   covered by write access to `organization` and `repository`).
4. **Generate token** and copy it immediately (it is shown once).

On a self-hosted instance you can also mint one from the CLI:

```bash
forgejo admin user generate-access-token --username <admin> --scopes all --raw
```

Export it into the environment — warden only ever reads the token from an env
var (`--token-env`), never from argv:

```bash
export FORGEJO_TOKEN=<the token>
```

## Base URL

`--base-url` is the instance root, no trailing `/api`:

- self-hosted: `--base-url https://forgejo.example.com`
- Codeberg: `--base-url https://codeberg.org`
- or keep it out of the command line: `--base-url-env FORGEJO_URL`

Requests resolve to `<base-url>/api/v1/...`.

## First dry-run

Write a minimal policy that only reads what you already have. Start with one
slice — say, org settings:

```yaml
# governance.yml
orgs:
  my-org:
    settings:
      description: Managed by forgejo-warden
```

Run it (dry-run is the default; nothing is written):

```bash
forgejo-warden reconcile \
  --config governance.yml \
  --base-url https://forgejo.example.com \
  --token-env FORGEJO_TOKEN
```

You get one plan block per cycle per org. Cycles with no declared slice report
an empty plan. If the plan looks right, apply it:

```bash
forgejo-warden reconcile --config governance.yml \
  --base-url https://forgejo.example.com --token-env FORGEJO_TOKEN \
  --mode apply
```

Then grow the policy slice by slice — teams, repos, branch protection —
checking the dry-run plan each time. [POLICY.md](POLICY.md) has a complete
annotated example; [CLI.md](CLI.md) covers flags and exit codes.

## A local sandbox (the e2e stack)

The repo ships a hermetic throwaway Forgejo you can experiment against without
touching a real instance: Forgejo 11 on sqlite, web installer skipped, no
persistence beyond the compose volume.

```bash
git clone https://github.com/INTENTIUS/forgejo-warden && cd forgejo-warden
npm ci

# compose up + create an admin user + mint a token;
# exports FORGEJO_E2E_URL / FORGEJO_E2E_TOKEN into your shell
eval "$(npm run --silent e2e:up)"

# point warden at it
forgejo-warden reconcile --config governance.yml \
  --base-url "$FORGEJO_E2E_URL" --token-env FORGEJO_E2E_TOKEN

# tear down (removes the volume and all state)
npm run e2e:down
```

The stack definition is `e2e/docker-compose.yml`; `e2e/bootstrap.sh` waits for
the API, creates the `warden-admin` user, and mints an all-scopes token. The
instance serves the web UI at http://localhost:3000 if you want to click around
and watch warden's changes land. `npm run test:e2e:run` runs the e2e suite
against it (set `FORGEJO_E2E_APPLY=1` to include the apply phase).
