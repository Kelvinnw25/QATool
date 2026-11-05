# Running QATOOL and Apayee in Docker (local development)

Three containers on Docker Desktop (WSL2 backend) started by one Compose file. This is an optional way
to run the same code; the host workflow (`npm run dev`) is unchanged. For versions and the host
environment see [`ENVIRONMENT_SNAPSHOT.md`](ENVIRONMENT_SNAPSHOT.md); for Apayee's own image and standalone
`docker run` see `../Apayee/docs/DOCKER_LOCAL.md`. A start-to-finish checklist for a new laptop (both repositories)
is in the root [README](../README.md#setup-on-a-new-windows-laptop); this file is the detailed Docker reference.

## Contents

1. [Architecture](#architecture)
2. [Files](#files)
3. [Before you start](#before-you-start)
4. [Networking](#networking)
5. [Environment and secrets](#environment-and-secrets)
6. [First start](#first-start)
7. [One-time Claude sign-in](#one-time-claude-sign-in)
8. [Daily commands](#daily-commands)
9. [Health checks](#health-checks)
10. [Shutdown and removal](#shutdown-and-removal)
11. [Troubleshooting](#troubleshooting)
12. [What was verified, and what was not](#what-was-verified-and-what-was-not)

## Architecture

```text
Browser ──> http://localhost:5173  qatool-frontend  (Vite dev server, React)
                                       │  proxy /api  ->  http://qatool-backend:3001
                                       ▼
            127.0.0.1:3001         qatool-backend   (Fastify API)
                                       │  http://apayee:4100   Authorization: Bearer <APAYEE_TOKEN>
                                       ▼
            (not published)        apayee           (socat :4100 -> Apayee 127.0.0.1:4101 -> Claude Code CLI)
```

Exactly three long-running services share one Compose network, `qatool_qatool-net`:

| Service           | Image                   | Built from            | Container port | Published on host                  |
| ----------------- | ----------------------- | --------------------- | -------------- | ---------------------------------- |
| `qatool-frontend` | `qatool-frontend:local` | `Dockerfile.frontend` | 5173 (0.0.0.0) | `127.0.0.1:5173`                   |
| `qatool-backend`  | `qatool-backend:local`  | `Dockerfile.backend`  | 3001 (0.0.0.0) | `127.0.0.1:3001`                   |
| `apayee`          | `apayee:local`          | `../Apayee` (its own) | 4100 (socat)   | **nothing**, internal network only |

All three images use Node.js 22.15.0 (`node:22.15.0-bookworm-slim`) and run as the unprivileged `node`
user, with all Linux capabilities dropped, `no-new-privileges`, and memory, CPU and process ceilings
(`compose.yaml`; the reasoning is in [PUBLIC_DEMO_SECURITY.md](PUBLIC_DEMO_SECURITY.md#docker-compose)).
Start order is enforced by health checks: `apayee` healthy, then `qatool-backend` healthy, then
`qatool-frontend`.

For a public staging run the frontend container is not needed (Vercel serves the UI) and the backend is reached
through a Cloudflare Tunnel started from Windows, never from a container: see
[STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md). This file stays about the local stack.

Apayee has no host port on purpose: only the backend needs it, over the network. To reach it yourself, run
a command inside the container (see [Health checks](#health-checks)).

No database, cache, proxy or other service is added. `docker compose run` creates short-lived
containers for the sign-in; they are not part of the stack.

## Files

| File                  | Purpose                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `compose.yaml`        | The three services, the network and the `apayee-claude-config` volume                                         |
| `Dockerfile.backend`  | Production dependencies of the root package (`npm ci --omit=dev --workspaces=false`), `server/`, the template |
| `Dockerfile.frontend` | Only the `web` workspace's dependencies (`npm ci --workspace web`) and the web sources                        |
| `.dockerignore`       | Allow-list build context; `.env*`, `node_modules`, tests, docs and `web/dist` never enter an image            |
| `web/vite.config.js`  | Reads the proxy target from `API_PROXY_TARGET`, defaulting to `http://127.0.0.1:3001`                         |

Dependencies come from the existing `package-lock.json`; no version was changed. The images use the npm
bundled with Node 22.15.0 (10.9.2); the Windows PC uses 11.6.4. `npm ci` accepts the lockfile as is.

## Before you start

1. Docker Desktop is running (WSL2 backend). `docker version` shows a client and a server.
2. **Nothing else uses ports 3001 or 5173.** Stop `npm run dev` first. Otherwise `up` fails with "port is
   already allocated". An Apayee started with `npm start` on Windows no longer conflicts (the container
   publishes no port), but it is not the one QATOOL talks to either: the backend reaches the container.
3. `./.env` (QATOOL) and `../Apayee/.env` exist (copy each from its `.env.example`; neither is in Git). `../Apayee` is the
   other repository cloned next to this one and has its `Dockerfile`, `.dockerignore` and `docker/entrypoint.sh`.
   The sign-in volume exists: `docker volume ls` lists `apayee-claude-config`, otherwise `docker volume create apayee-claude-config`
   (it is declared `external`, so `up` stops with an error instead of creating an empty one).
4. `APAYEE_TOKEN` in QATOOL's `.env` equals `APAYEE_AUTH_TOKEN` in Apayee's `.env`. Compare without
   printing either:

   ```powershell
   $v = { param($f,$n) ((Get-Content $f | Where-Object { $_ -match "^$n=" }) -replace "^$n=",'').Trim() }
   (& $v .env APAYEE_TOKEN) -ceq (& $v ..\Apayee\.env APAYEE_AUTH_TOKEN)    # expect True
   ```

## Networking

| From -> to                        | Address                      | Notes                                                                        |
| --------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| Browser -> UI                     | `http://localhost:5173`      | Use `localhost`; the port is published on IPv4 loopback                      |
| Browser -> API (optional, direct) | `http://127.0.0.1:3001`      | The UI itself never calls this; it uses the proxy                            |
| UI container -> API container     | `http://qatool-backend:3001` | `API_PROXY_TARGET`, read by Vite only (no `VITE_`)                           |
| API container -> Apayee           | `http://apayee:4100`         | `APAYEE_BASE_URL`; a non-loopback host requires `APAYEE_TOKEN`, which is set |
| Host -> Apayee                    | none                         | Not published; use `docker compose exec apayee ...`                          |

Inside the Apayee container the application listens on `127.0.0.1:4101` only (its Claude provider
refuses any other address) and `socat` forwards `0.0.0.0:4100` to it. Neither port is published. The
bearer token, the origin check and the readiness checks all still run in Apayee.

The two published ports are bound to `127.0.0.1`, so nothing is reachable from other machines. Anyone who
can run `docker inspect` on this PC can read a container's environment, including the token.

Public modes: when `PUBLIC_MODE=true` the backend also requires a Cloudflare Access token on every route and
the setting `LLM_PROVIDER` may not be `apayee`. All of it is described in
[PUBLIC_DEMO_SECURITY.md](PUBLIC_DEMO_SECURITY.md); the Compose file is unchanged by it apart from the items
above, and the container health check uses `/healthz`, which needs no token.

## Environment and secrets

No secret appears in `compose.yaml`, a Dockerfile, an image or a tracked file.

| Container         | Receives                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `qatool-backend`  | Everything in `./.env` (`env_file`), then three overrides: `HOST=0.0.0.0`, `PORT=3001`, `APAYEE_BASE_URL=http://apayee:4100` |
| `apayee`          | Everything in `../Apayee/.env`, then one override: `APAYEE_CLAUDE_CLI_PATH=/home/node/.local/bin/claude`                     |
| `qatool-frontend` | Only `API_PROXY_TARGET=http://qatool-backend:3001`. No `env_file`, no keys, no tokens                                        |

- `environment:` in Compose wins over `env_file`, so the host `.env` files keep their host values
  (`HOST=127.0.0.1`, `APAYEE_BASE_URL=http://127.0.0.1:4100`) and the host workflow still works.
- Apayee's `.env` may hold `APAYEE_CLAUDE_CLI_PATH` as a Windows path (`C:\...\claude.exe`). Left alone it
  would override the image's Linux path and make Apayee report `cli_not_found`; hence the override.
  `APAYEE_HOST` and `APAYEE_PORT` in that file are harmless: the image entrypoint fixes both.
- Apayee's own documentation suggests a separate `.env.docker`. This setup reads `../Apayee/.env` as
  requested; either works. If you create `.env.docker`, change `env_file` in `compose.yaml`.
- `env_file` values are interpolated by Compose, so a value containing `$` would be altered. Generated
  tokens (base64url) contain no `$`.
- `APAYEE_CLAUDE_EXPERIMENTAL` and `APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED` are read from Apayee's `.env`
  and are yours to set. Nothing here changes them.
- To add a Gemini key, put `GEMINI_API_KEY` in `./.env` and run `docker compose up -d` (the backend is
  recreated). Variables in `.env` are read when the container is created, not while it runs.

## First start

```powershell
docker compose up -d --build     # builds three images, starts apayee -> backend -> frontend
docker compose ps                # all three should say "healthy"
```

The first build downloads the Claude Code CLI (about 850 MB image for Apayee) and takes several minutes;
later builds reuse the cache. Open `http://localhost:5173`.

Docker's "healthy" for Apayee means the service answers its authenticated health endpoint, **not** that
Claude is ready. Until you sign in (next section) the UI shows "Claude via Apayee" as unavailable, and Gemini
is unavailable without `GEMINI_API_KEY`. Nothing falls back to another provider.

## One-time Claude sign-in

The container has its **own** Linux Claude Code CLI and its own sign-in. The Windows login is never copied.
The sign-in is stored in the named volume **`apayee-claude-config`**, mounted at **`/home/node/.claude`**
(the `node` user's home; `CLAUDE_CONFIG_DIR` points there, so the CLI's settings file is inside it too).

1. Start the interactive login (needs a terminal; it does not start the service):

   ```powershell
   docker compose run --rm apayee node scripts/claude-auth.js login
   ```

2. It prints a sign-in URL and `Paste code here if prompted >`. Open the URL in **your own browser on
   Windows**, choose the Claude account (subscription) option, never Console or API billing, finish with
   Anthropic, then paste the code into the terminal.
3. Check the result without any model request. The output of a signed-in account contains your email and
   organization, so show only the safe fields:

   ```powershell
   docker compose run --rm -T apayee claude auth status 2>$null | ConvertFrom-Json | Select-Object loggedIn, authMethod
   ```

   Expect `loggedIn True` and `authMethod claude.ai`. (Before sign-in it shows `False` and `none`.)

4. Check your plan in your Claude account settings. Setting `APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true` in
   `../Apayee/.env` is your decision; until it is set, Apayee reports `subscription_unconfirmed`.
5. Recreate Apayee so it picks up the sign-in and any `.env` change, then check:

   ```powershell
   docker compose up -d --force-recreate apayee
   ```

   Apayee caches its readiness for a short time, so give it a minute or recreate it as above. The
   health check in [Health checks](#health-checks) should then report `provider = claude`.

The volume survives `docker compose down`, `down -v`, rebuilds and recreation: `compose.yaml` declares it
`external: true`, so Compose does not own it and never deletes it. It is removed only by
`docker volume rm apayee-claude-config`. If the volume is ever missing, `docker compose up` stops with an error
instead of creating an empty one; create it on purpose with `docker volume create apayee-claude-config`. If the
login expires or the volume is lost, repeat steps 1 to 3.

## Daily commands

| Task                                  | Command                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------ |
| Build and start everything            | `docker compose up -d --build`                                           |
| Status and health                     | `docker compose ps`                                                      |
| Follow all logs                       | `docker compose logs -f`                                                 |
| Logs of one service                   | `docker compose logs -f qatool-backend` (or `apayee`, `qatool-frontend`) |
| Start / stop one service              | `docker compose start apayee` / `docker compose stop apayee`             |
| Restart one service                   | `docker compose restart qatool-backend`                                  |
| Rebuild and replace one service       | `docker compose up -d --build qatool-frontend`                           |
| Rebuild one image without cache       | `docker compose build --no-cache apayee`                                 |
| Run a command in a running service    | `docker compose exec qatool-backend node -v`                             |
| Stop the whole stack, keep everything | `docker compose stop`                                                    |
| Start it again after `stop`           | `docker compose start`                                                   |

Starting one service starts what it depends on: `docker compose up -d qatool-frontend` also starts the
backend and Apayee. After a code change in `server/` or `web/` rebuild that service; the images contain a
copy of the source, so there is no hot reload in the container. For editing with hot reload use the host
workflow.

Log lines carry metadata only. Prompts, replies and document text are not logged.

## Health checks

None of these calls a model.

```powershell
docker compose ps                                          # healthy / unhealthy per service
Invoke-WebRequest http://localhost:5173/ -UseBasicParsing | Select-Object StatusCode
Invoke-RestMethod http://127.0.0.1:3001/api/health         # status ok
Invoke-RestMethod http://localhost:5173/api/health         # same, through the UI's proxy
Invoke-RestMethod http://localhost:5173/api/llm/providers  # what QATOOL thinks of Gemini and Claude
Invoke-RestMethod http://127.0.0.1:3001/healthz            # liveness only: {"status":"ok"}, no token ever

# Apayee's authenticated health, run INSIDE the container (its port is not published). The token is
# read from the container's own environment and never printed.
docker compose exec apayee node -e "fetch('http://127.0.0.1:4100/v1/health',{headers:{Authorization:'Bearer '+process.env.APAYEE_AUTH_TOKEN}}).then(r=>r.json()).then(j=>console.log(j.status,j.provider))"

# Backend container reaches Apayee over the Docker network
docker compose exec qatool-backend node -e "require('dns').promises.lookup('apayee').then(a=>console.log(a.address))"
```

In Apayee's reply, `provider` is `claude` only when the CLI is signed in and ready. Otherwise it is
`claude_not_ready` and `provider_status.state` says why (for example `not_authenticated`). Without a token
the endpoint answers 401. From the host, `http://127.0.0.1:4100` and `:4101` do not answer at all.

## Shutdown and removal

| Goal                                                                              | Command                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Stop, keep containers                                                             | `docker compose stop`                                  |
| Stop and remove containers and network, **keep the sign-in**                      | `docker compose down`                                  |
| Also remove the three images                                                      | `docker compose down --rmi all`                        |
| **Sign the container out** (delete the volume)                                    | `docker volume rm apayee-claude-config` (after `down`) |
| Remove containers and network (the sign-in volume is external, so `-v` leaves it) | `docker compose down -v`                               |

`down -v` no longer deletes the Claude sign-in (the volume is external), but do not run `docker volume prune`: it
removes any volume no container is using. The containers restart with Docker
Desktop (`restart: unless-stopped`) unless you have run `stop` or `down`.

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `port is already allocated` / bind error on up                 | A host `npm run dev` or `npm start` holds 3001 or 5173. Stop it                                                 |
| A container is `OOMKilled` or keeps restarting                 | It hit its `mem_limit` in `compose.yaml` (Apayee's were not load-tested). Raise it, then `docker compose up -d` |
| Backend unhealthy right after `PUBLIC_MODE=true`               | It refused to start: `docker compose logs qatool-backend` names the missing settings (never their values)       |
| `env file ... .env not found`                                  | Create `./.env` or `../Apayee/.env`; they are not in the repositories                                           |
| Backend never starts (waiting on `apayee`)                     | `docker compose logs apayee`: a weak or missing `APAYEE_AUTH_TOKEN`, or an invalid setting, stops it at start   |
| UI says Claude is unavailable, reason "provider is not Claude" | Not signed in, or `subscription_unconfirmed`. See sign-in; read `provider_status` in Apayee's health            |
| UI says Apayee "rejected the server's credentials"             | `APAYEE_TOKEN` differs from `APAYEE_AUTH_TOKEN`. Make them equal, then `docker compose up -d --force-recreate`  |
| Apayee reports `cli_not_found`                                 | The path override was removed from `compose.yaml`, or the CLI is missing in the image. Rebuild                  |
| Signed in but still `not_authenticated`                        | A different volume is mounted. The volume must be `apayee-claude-config`; check `docker volume ls`              |
| `http://127.0.0.1:5173` does not answer                        | Use `http://localhost:5173`                                                                                     |
| Gemini unavailable                                             | `GEMINI_API_KEY` is empty in `./.env`. Set it and `docker compose up -d`                                        |
| A code change does not show                                    | The image holds a copy. `docker compose up -d --build <service>`                                                |
| Edited `.env` has no effect                                    | `.env` is read at container creation: `docker compose up -d --force-recreate <service>`                         |
| `docker compose run ... login` shows no prompt                 | It needs an interactive terminal; run it in PowerShell or Windows Terminal, not through a script                |

## What was verified, and what was not

Verified on 2026-11-03, Docker Desktop with Engine 29.9.2 and Compose v5.6.1 on Windows 11, with Node 22.15.0 images:

- All three images built from the existing lockfiles; the QATOOL images contain no `.env` file, no test files
  and only their own dependencies; they run as `node`.
- `docker compose up -d --build` started three containers, each `healthy`, in dependency order, with ports
  bound to `127.0.0.1` only.
- The UI answered with HTTP 200; `/api/health` answered directly and through the Vite proxy; the backend
  resolved `apayee` and connected to port 4100; Apayee's health answered 200 with the token and 401 without.
- At the first check QATOOL's `/api/llm/providers` reported Claude unavailable because the container's CLI was
  not yet signed in (`loggedIn false`). That was the true state, not a fault. The frontend container's
  environment holds only `API_PROXY_TARGET`.
- A marker file in `apayee-claude-config` survived `docker compose down` and recreation. The volume is owned by
  `node` and mounted at `/home/node/.claude`.

After the security hardening (same day), rebuilt and recreated with the hardened `compose.yaml`:

- All three containers `healthy`; Apayee publishes no port (host `127.0.0.1:4100` and `:4101` both closed).
- `cap_drop: ALL`, `no-new-privileges`, and the memory, CPU and PID ceilings are applied (read back with
  `docker inspect`). Under them the Claude CLI runs (`2.1.316`), the volume is writable, and the existing
  sign-in survived recreation (`loggedIn=true`, `claude.ai`); Apayee reported `provider=claude`, ready, and
  QATOOL listed Claude as available. The volume was not removed or recreated.
- The backend's `/healthz` answers `{"status":"ok"}` with `no-store` and `nosniff`.
- Measured: a client on the Windows host connecting to the published backend port appears to the container as
  `172.18.0.1`, the Compose network's gateway (relevant to `TRUSTED_PROXY_PEERS`).

Not done in that verification (2026-11-03): any request to `/api/extract`, `/api/generate`, `/api/validate` or Apayee's
`/v1/generate`, any model call (so a run with Claude signed in, and Apayee's behaviour under load, were untested), and behaviour
across a Windows restart. Since then the stack has been used for the public staging demo ([STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md)):
a browser Turnstile session through a Quick Tunnel was verified, but a full real generation run through the browser is not yet confirmed.
After a Windows reboot Docker Desktop must be started again; the containers then restart by themselves (`restart: unless-stopped`) and a Quick
Tunnel, which is not a container, must be restarted by hand. The browser sign-in is the owner's. The Claude provider remains experimental
and owner-run; the policy status of serving other people from a personal subscription is unconfirmed, as in `../Apayee/docs/CLAUDE_PROVIDER.md`.
