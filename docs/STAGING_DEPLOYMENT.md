# Public staging deployment (Vercel + Cloudflare Quick Tunnel + Docker on Windows)

How the QATOOL public demo is put on the internet for staging: the React app on Vercel, the API in Docker on the
owner's Windows PC behind a temporary Cloudflare Quick Tunnel, visitors admitted by Turnstile and a signed ticket.

> **Status.** The Vercel project `qatool-staging` is deployed (production alias `https://qatool-staging.vercel.app`),
> the Turnstile widget exists, `PUBLIC_DEMO=true` is set on the local backend, and a browser Turnstile session
> ("Session ready") through a Quick Tunnel has been verified. **A full real generation and export run through the
> browser has not yet been confirmed**, and real Claude run time and memory under load are unmeasured.
> The demo is reachable only while this PC, Docker, the backend **and** a tunnel are running. When any of them is off,
> the Vercel page still loads and says the demo service cannot be reached.

Related: [PUBLIC_DEMO_JOBS.md](PUBLIC_DEMO_JOBS.md) (the API and the frontend), [PUBLIC_DEMO_SECURITY.md](PUBLIC_DEMO_SECURITY.md)
(limits, headers, Compose hardening), [DOCKER_LOCAL.md](DOCKER_LOCAL.md) (the containers and the Claude sign-in).

## Contents

1. [Architecture](#1-architecture)
2. [Security boundaries](#2-security-boundaries)
3. [Prerequisites and what lives outside Git](#3-prerequisites-and-what-lives-outside-git)
4. [Variables, side by side](#4-variables-side-by-side)
5. [Configure the local backend](#5-configure-the-local-backend)
6. [Turnstile widget](#6-turnstile-widget)
7. [Vercel project](#7-vercel-project)
8. [Pre-tunnel gate](#8-pre-tunnel-gate)
9. [Start the Quick Tunnel and deploy](#9-start-the-quick-tunnel-and-deploy)
10. [End-to-end check](#10-end-to-end-check)
11. [Windows operating guide](#11-windows-operating-guide)
12. [Troubleshooting](#12-troubleshooting)
13. [Rollback](#13-rollback)
14. [Known risks](#14-known-risks)
15. [Alternative: custom domain with a named tunnel](#15-alternative-custom-domain-with-a-named-tunnel)

## 1. Architecture

```text
Visitor's browser
   │  https://qatool-staging.vercel.app            static files only (Vercel, production alias)
   ├──────────────────────────────────────────►  Vercel (built from this repo, no secret inside)
   │
   │  https://<random-words>.trycloudflare.com/api/...      Turnstile -> ticket -> jobs
   └──────────────────────────────────────────►  Cloudflare edge  (CORS: the Vercel origin only)
                                                     │  Quick Tunnel (outbound connection from the PC)
                                                     ▼
   Windows host:  cloudflared --url http://127.0.0.1:3001      (Docker publishes 127.0.0.1:3001 only)
                                                     │
   Docker network qatool_qatool-net (private)        ▼
        qatool-backend :3001  ──►  apayee :4100 (socat) ──► 127.0.0.1:4101 ──► Claude Code CLI
                                      no host port, never tunnelled
```

| Name                                       | What it is                                                                                    | Reachable from the internet?                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `https://qatool-staging.vercel.app`        | **Public frontend.** Static files; holds no secret and no state                               | Yes, by design                                                 |
| `https://<random-words>.trycloudflare.com` | **Public API address.** The backend through the Quick Tunnel; changes on every tunnel restart | Yes, but every route needs a ticket, a Turnstile pass, or both |
| `qatool-backend`                           | Private Docker service, host port `127.0.0.1:3001`                                            | Only through the tunnel                                        |
| `apayee`                                   | **Private Docker service.** The Claude gateway. Ports 4100 and 4101 are unpublished           | **Never**                                                      |
| `qatool-frontend`                          | The Vite dev-server container (5173). **Not needed in staging**                               | Never; stop it (see [11](#11-windows-operating-guide))         |

Public access uses **Turnstile + a QATOOL ticket**. Cloudflare Access (owner-only) is not applied to the API: it would
block visitors. `PUBLIC_DEMO` and `PUBLIC_MODE` are separate modes that cannot be on together.

**Two consequences of a Quick Tunnel to accept:**

- **The tunnel address changes every time `cloudflared` restarts** (a reboot, a closed window, a crash). The frontend reads it
  at build time as `VITE_API_BASE_URL`, so each new tunnel needs the Vercel variable updated **and a new production
  deployment** ([9](#9-start-the-quick-tunnel-and-deploy)). The Turnstile widget, `ALLOWED_ORIGINS` and `TURNSTILE_HOSTNAMES`
  name the Vercel host, not the tunnel, so they never change.
- **The production frontend can stay up while the backend is offline.** Vercel serves `qatool-staging.vercel.app` regardless of this
  PC. With Docker or the tunnel off, visitors see the Verify panel and a "cannot be reached" message, not a blank page. Nothing
  works until the stack and a tunnel are back and the page has been rebuilt with the current tunnel address.

Quick Tunnels carry no uptime promise and Cloudflare documents limits for them; this is for staging and demonstrations. They cannot
use WAF or rate-limit rules, because the hostname is not in your Cloudflare zone: Turnstile, the ticket and the app's own limits
are the whole defence. Unique per-deployment `*.vercel.app` URLs are different origins: the API refuses them, and Vercel
Authentication also blocks anyone not signed in to the Vercel team.

## 2. Security boundaries

| Boundary                | What holds it                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internet -> API         | Cloudflare edge, then the tunnel. The PC opens no inbound port and no router forwarding is needed                                                                             |
| Who may call the API    | A ticket (HS256, 30 min, bound to the frontend origin, **not** to an address) minted only after a server-side Turnstile check. `Authorization: Bearer`; no cookies            |
| Which page may call it  | `ALLOWED_ORIGINS`, exact match. A missing or unlisted `Origin` is refused on every route except `/healthz`. CORS is a browser courtesy; the ticket and limits are the control |
| Cost and abuse          | One live job per ticket, `JOB_MAX_PENDING` queue, submit/poll limiters per ticket, a loose per-address backstop on ticket minting, upload and parser ceilings                 |
| Model access            | Fixed on the server to Claude through Apayee. The browser cannot name a model. No hourly/daily budget exists; capacity is the queue, not a counter                            |
| Apayee                  | Internal Docker network only; `APAYEE_TOKEN` stays in the backend's environment; the Claude login stays in the `apayee-claude-config` volume (external, never in an image)    |
| Secrets in the frontend | None. Every `VITE_` value is public. The Turnstile **site** key is public; the **secret** key, `TICKET_SECRET` and `APAYEE_TOKEN` exist only in the backend's `.env`          |
| Tunnel credentials      | A Quick Tunnel has none. A named tunnel ([15](#15-alternative-custom-domain-with-a-named-tunnel)) keeps them in `%USERPROFILE%\.cloudflared\`, outside the repository         |

**Never start the tunnel while `PUBLIC_DEMO` is off.** Local mode has no authentication; a tunnel to it would hand the model to the
internet. The gate in [8](#8-pre-tunnel-gate) exists for this.

## 3. Prerequisites and what lives outside Git

Needed, and not provided by the repository:

- The Windows PC from the root [README](../README.md#setup-on-a-new-windows-laptop): Docker Desktop, both repositories cloned side by side, both `.env`
  files, and Apayee signed in to Claude ([DOCKER_LOCAL.md](DOCKER_LOCAL.md#one-time-claude-sign-in)).
- A **Cloudflare account** (Turnstile; no domain needed for the free profile) and `cloudflared` on the PC
  (`winget install --id Cloudflare.cloudflared`; open a new terminal and run `cloudflared --version`). Cloudflare WARP is a different product.
- A **Vercel account** and the Vercel CLI (`npm i -g vercel`, then `vercel login`).
- A decision on the GitHub repository's visibility. `github.com/Kelvinnw25/QATool` is publicly readable; the tree holds no secret, but
  it documents the whole deployment. Vercel's CLI deploys from the working folder, so it does not need a Git connection.
- The Claude subscription behind Apayee is **the owner's**. Serving other people from it is, per Apayee's own documentation
  (`docs/CLAUDE_PROVIDER.md`), of unconfirmed status with Anthropic; that is the owner's decision and risk.

**Kept out of Git** (recreate on a new machine): both `.env` files, `.vercel/` (the folder's link to the Vercel project; recreate with
`vercel link`), the Vercel environment variables, the Turnstile keys (in your Cloudflare account), and the Claude login volume
`apayee-claude-config`. Quick Tunnel addresses are temporary and belong nowhere in the repository.

## 4. Variables, side by side

**Vercel** (public, read at build time; project `qatool-staging`, environment **Production** only). All four are public by design;
**no secret ever gets a `VITE_` name** (a test builds the bundle with secret-looking values present and fails if any appears):

| Variable                  | Value                                                                                           | Secret? |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| `VITE_PUBLIC_DEMO`        | `true`                                                                                          | No      |
| `VITE_API_BASE_URL`       | the current Quick Tunnel origin: `https://<random-words>.trycloudflare.com`, https, origin only | No      |
| `VITE_TURNSTILE_SITE_KEY` | the widget's **Site Key**                                                                       | No      |
| `VITE_TURNSTILE_ACTION`   | `qatool_demo` (must equal the backend's `TURNSTILE_ACTION`)                                     | No      |

**Local backend `.env`** (secret, never in Vercel, never `VITE_`). Names come from `server/security/settings.js` and `.env.example`;
the backend refuses to start (naming the variable, never the value) when a required one is missing or malformed:

| Variable              | Required     | Value                                                                                                                      | Secret? |
| --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- | ------- |
| `PUBLIC_DEMO`         | to go public | `true` last, after everything else is set and verified. Do **not** set `PUBLIC_MODE`                                       | No      |
| `ALLOWED_ORIGINS`     | yes          | `https://qatool-staging.vercel.app`: exact origin, scheme and host, no path, no wildcard; also the ticket's audience       | No      |
| `TURNSTILE_HOSTNAMES` | yes          | `qatool-staging.vercel.app` (no scheme)                                                                                    | No      |
| `TURNSTILE_ACTION`    | optional     | `qatool_demo` (the default)                                                                                                | No      |
| `TURNSTILE_SECRET`    | yes          | the widget's **Secret Key**. Backend only                                                                                  | **Yes** |
| `TICKET_SECRET`       | yes          | at least 32 random characters, generated locally ([5](#5-configure-the-local-backend)). Changing it logs every visitor out | **Yes** |
| `TRUSTED_PROXY_PEERS` | recommended  | `172.18.0.1`, the Docker network gateway through which the host's `cloudflared` appears                                    | No      |
| `APAYEE_TOKEN`        | existing     | already in `.env`; must equal Apayee's `APAYEE_AUTH_TOKEN`. Compose points the backend at `http://apayee:4100`             | **Yes** |

Left unset on purpose: `PUBLIC_MODE` (cannot be combined), `JOB_WORKERS` (default 1; it can never exceed Apayee's `max_active`),
`JOB_MAX_PENDING` (default 10: at most workers + 10 jobs are accepted) and Apayee's `APAYEE_MAX_CONCURRENT` (default 1; set in
Apayee's own `.env`). The upload and parser ceilings keep their defaults (10 MiB per file, 20 MiB total, 30 files); there is no
hourly or daily model budget. `LLM_PROVIDER` is ignored in this mode (the model is fixed to Claude). The backend also refuses a short or
placeholder ticket secret and any `ALLOWED_ORIGINS` that is not an exact `https` origin.

Two copy-from checklists with no secret in them, read by no code, are in `deploy/`:
[`staging.backend.env.example`](../deploy/staging.backend.env.example) and [`staging.vercel.env.example`](../deploy/staging.vercel.env.example).
Tests keep both in step with the code.

## 5. Configure the local backend

Edit `.env` yourself, in an editor (`notepad .env`). **Do not replace the file**: it holds `APAYEE_TOKEN` and your other settings. **Do not
paste secret values into a chat, a ticket or a terminal log.** `.env` is read by Docker Compose (`env_file`) and is Git-ignored.

1. Add the lines from `deploy/staging.backend.env.example`, keeping `PUBLIC_DEMO=false` for now.
2. Generate `TICKET_SECRET` on the PC without showing it (copies 48 random bytes, base64, to the clipboard; works in Windows
   PowerShell 5.1 and PowerShell 7), paste it after `TICKET_SECRET=`, then clear the clipboard:

   ```powershell
   $b = New-Object byte[] 48; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   [Convert]::ToBase64String($b) | Set-Clipboard
   # paste into .env, then:
   Set-Clipboard -Value $null
   ```

3. Paste the Turnstile **Secret Key** ([6](#6-turnstile-widget)) after `TURNSTILE_SECRET=`.
4. Check the Docker gateway that `TRUSTED_PROXY_PEERS` should list (the stack must have been started once):

   ```powershell
   docker network inspect qatool_qatool-net --format "{{range .IPAM.Config}}{{.Gateway}}{{end}}"
   ```

   The backend sees the TCP peer, not the visitor. With Docker Desktop, a request that `cloudflared` sends to `localhost:3001` arrives from
   that gateway. With the value listed, the backend believes `CF-Connecting-IP` from that peer, which matters for one thing: the backstop on
   ticket minting (`SESSION_MINT_PER_MINUTE_PER_IP`, 30). **Left empty, every visitor shares one address and one allowance of 30 mints a
   minute.** Anything on the PC can reach the loopback port and claim a `CF-Connecting-IP`; that can only affect that backstop and the logs,
   never authentication.

5. Only after the lines are saved, change `PUBLIC_DEMO=false` to `PUBLIC_DEMO=true` and save.
6. Recreate **only** the backend (no rebuild; Apayee and its sign-in are untouched; `.env` is read when a container is created):

   ```powershell
   docker compose up -d --no-deps --force-recreate qatool-backend
   docker compose ps          # qatool-backend: healthy. If it exits, its log names the variable (never a value)
   ```

Never `docker compose down -v`, never remove or prune the `apayee-claude-config` volume, and do not change `JOB_WORKERS` or Apayee's
concurrency until a real run has been measured.

## 6. Turnstile widget

Manual, in the Cloudflare dashboard. Menu names change now and then; look for the same words.

1. Sign in at <https://dash.cloudflare.com> and open **Turnstile** (it may sit under "Application security"). Click **Add widget**.
2. **Widget name:** `QATOOL Staging`. **Hostname management:** add exactly `qatool-staging.vercel.app`. Nothing else: no `localhost`,
   no `*.vercel.app`, no `trycloudflare.com` (the widget runs on the Vercel page, not on the tunnel).
3. **Widget Mode:** Managed. Pre-clearance: No. Click **Create**. Cloudflare shows two keys:

| Shown as                | Is the | Public? | Goes to                                    | Variable                  |
| ----------------------- | ------ | ------- | ------------------------------------------ | ------------------------- |
| **Site Key**            | Site   | Yes     | Vercel (Production environment variable)   | `VITE_TURNSTILE_SITE_KEY` |
| **Secret Key** (hidden) | Secret | **No**  | Your local `.env` only, typed in an editor | `TURNSTILE_SECRET`        |

The **action** (`qatool_demo`) is not set in the dashboard: the page sends it and the backend checks it comes back, so the two action
variables must match. Do not use Cloudflare's always-pass test keys on this hostname. Verification happens on the server
(`challenges.cloudflare.com/turnstile/v0/siteverify`) and fails closed: if the backend cannot reach Cloudflare it answers 503 and admits
nobody. A real Turnstile token cannot be produced from the command line; the first genuine verification happens in the browser ([10](#10-end-to-end-check)).

## 7. Vercel project

Most settings are in [`vercel.json`](../vercel.json) at the repository root, and [`.vercelignore`](../.vercelignore) keeps everything that
is not the browser app (backend, Docker files, docs, every `.env`) off Vercel's servers. The project needs only the framework, root
directory and environment variables set by hand.

| Setting              | Value                                                               | Why                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root Directory       | `./` (the repository root, **not** `web`)                           | The lockfile and the npm workspace are at the root                                                                                                        |
| Framework Preset     | Other (`"framework": null`)                                         | Vite is run by the project's own script                                                                                                                   |
| Install Command      | `npm ci --workspace web`                                            | Installs only the frontend's dependencies from the lockfile (what `Dockerfile.frontend` does)                                                             |
| Build Command        | `npm run build`                                                     | Runs `vite build` in the `web` workspace                                                                                                                  |
| Output Directory     | `web/dist`                                                          | `web/vite.config.js` sets `outDir: 'dist'`                                                                                                                |
| Node.js version      | follows `engines` (`>=22.13.0`)                                     | Check the build log's Node line; Vite 7 builds on current Node versions                                                                                   |
| Rewrites / redirects | **none**                                                            | The page calls the tunnel address directly. **No `/api` rewrite** and no proxy to the PC: that would put Vercel's servers between visitors and the tunnel |
| Headers              | `nosniff`, `X-Frame-Options: DENY`, referrer and permissions policy | From `vercel.json`. No Content-Security-Policy is shipped (it would have to name the API host)                                                            |
| Branch builds        | skipped for every branch except `main`                              | `vercel.json` `ignoreCommand`: a preview URL is a different origin the API refuses                                                                        |

A build with `VITE_PUBLIC_DEMO=true` and a missing site key or a bad API origin shows what is missing instead of starting a session.
The static build is `index.html` plus two hashed assets.

**One-time link and variables** (run from the repository folder; `vercel link` writes the Git-ignored `.vercel/` and remembers the account and
project, so no scope flag is needed afterwards). The CLI prompts for each value; values are never shown by `env ls`:

```powershell
vercel login
vercel link                                                   # choose the existing project qatool-staging; do not connect a Git repository
vercel env add VITE_PUBLIC_DEMO production                    # enter: true
vercel env add VITE_TURNSTILE_SITE_KEY production             # paste the Site Key (public)
vercel env add VITE_TURNSTILE_ACTION production               # enter: qatool_demo
vercel env ls production                                      # names only
```

`VITE_API_BASE_URL` is set per tunnel in [9](#9-start-the-quick-tunnel-and-deploy). Never add `TURNSTILE_SECRET`, `TICKET_SECRET` or
`APAYEE_TOKEN` to Vercel, under any name. A deployment before the tunnel exists is fine: the page shows the widget and "the demo service
cannot be reached".

_Optional hardening, later:_ a `Content-Security-Policy` that allows scripts, frames and connections to `https://challenges.cloudflare.com` and
connections to the API origin; try it as `Content-Security-Policy-Report-Only` first (the page also uses inline `style` attributes).

## 8. Pre-tunnel gate

Nothing is public yet. All checks go to the loopback port, which only this PC can reach. Every row must match; stop at the first that
does not. Use `curl.exe`, not PowerShell's `curl` alias. The same checks run offline, with stand-in secrets, in `server/security/staging.test.js`;
running them against your real `.env` is the only proof that the real configuration is right.

| #   | Command (PowerShell)                                                                                                                                                                                                       | Must give                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `docker compose logs --tail 30 qatool-backend`                                                                                                                                                                             | a line with `demo_mode`, `workers` 1; no secret                                         |
| 2   | `curl.exe -s -i http://127.0.0.1:3001/healthz`                                                                                                                                                                             | 200, body `{"status":"ok"}` and nothing else                                            |
| 3   | `curl.exe -s -i http://127.0.0.1:3001/api/health`                                                                                                                                                                          | **403** (no Origin)                                                                     |
| 4   | `curl.exe -s -i http://127.0.0.1:3001/api/health -H "Origin: https://example.org"`                                                                                                                                         | **403**                                                                                 |
| 5   | `curl.exe -s -i http://127.0.0.1:3001/api/health -H "Origin: https://qatool-staging.vercel.app"`                                                                                                                           | **401**, `access-control-allow-origin` is that origin, no `allow-credentials`           |
| 6   | same with `-X POST http://127.0.0.1:3001/api/extract`, then `/api/generate?provider=claude`                                                                                                                                | **401** each: no direct model route is reachable                                        |
| 7   | `curl.exe -s -i -X POST http://127.0.0.1:3001/api/session -H "Origin: https://qatool-staging.vercel.app" -H "Content-Type: application/json" -d "{}"`                                                                      | **400** `TURNSTILE_FAILED`, no ticket                                                   |
| 8   | `curl.exe -s -i -X OPTIONS http://127.0.0.1:3001/api/session -H "Origin: https://qatool-staging.vercel.app" -H "Access-Control-Request-Method: POST"`                                                                      | 204 with the allowed origin only                                                        |
| 9   | `docker compose ps`                                                                                                                                                                                                        | published ports: `127.0.0.1:3001->3001` only; nothing for 4100, 4101, 5173 or `0.0.0.0` |
| 10  | `Get-Process cloudflared -ErrorAction SilentlyContinue`                                                                                                                                                                    | nothing: no tunnel is running                                                           |
| 11  | `docker compose exec -T apayee node -e "fetch('http://127.0.0.1:4100/v1/health',{headers:{Authorization:'Bearer '+process.env.APAYEE_AUTH_TOKEN}}).then(r=>r.json()).then(j=>console.log(j.provider,j.queue.max_active))"` | `claude 1`                                                                              |

(The 503 `SERVICE_UNAVAILABLE` a job submission returns while Apayee is unreachable is the provider-unavailable refusal, not a gate failure.)

## 9. Start the Quick Tunnel and deploy

Only when every gate row matched **and** `PUBLIC_DEMO=true` is live. The stack for staging is the backend and Apayee only; the frontend
container is not needed because Vercel serves the UI:

```powershell
docker compose stop qatool-frontend                  # once; also frees port 5173
docker compose up -d apayee qatool-backend           # names listed on purpose: a plain `up -d` restarts the frontend
docker compose ps                                    # apayee and qatool-backend: healthy
```

Start the tunnel in its own window (closing it ends the tunnel; there is deliberately no Windows service, so nothing is public unless you
started it). Point it at port 3001 only, never 4100, 4101 or 5173:

```powershell
cloudflared tunnel --url http://127.0.0.1:3001
```

The address `https://<random-words>.trycloudflare.com` is printed in the banner. **For every new tunnel address**, do all of this:

```powershell
curl.exe -s -i https://<random-words>.trycloudflare.com/healthz                                                    # 200
curl.exe -s -i https://<random-words>.trycloudflare.com/api/health                                                 # 403
curl.exe -s -i https://<random-words>.trycloudflare.com/api/health -H "Origin: https://qatool-staging.vercel.app"  # 401
vercel env rm VITE_API_BASE_URL production --yes                                                                   # skip if it does not exist yet
vercel env add VITE_API_BASE_URL production                                                                        # enter the new address
vercel deploy --prod                                                                                               # a new build picks it up
```

`vercel deploy --prod` is a production deployment of the staging project and the one way to update `qatool-staging.vercel.app` (it needs the
owner's explicit decision each time). Afterwards confirm the backend saw the gateway as the peer: in
`docker compose logs --since 5m qatool-backend | Select-String peer_ip`, the **401** request above (the one with an allowed Origin) must show
the address listed in `TRUSTED_PROXY_PEERS`; if it shows another, fix the setting and recreate the backend.

## 10. End-to-end check

On `https://qatool-staging.vercel.app`:

- [ ] Complete Turnstile -> "Session ready". _(Verified.)_
- [ ] Upload one small document -> queued/processing with the real phase -> results -> download the `.xlsx`. **This makes real Claude calls
      through Apayee** and is the first real exercise of the stack: keep `JOB_WORKERS=1`. _(Not yet confirmed.)_
- [ ] Cancel works; a second tab with a second session sees the queue position.
- [ ] Reload the page -> it says the session was reset and asks to verify again.
- [ ] Browser developer tools: requests go to the tunnel host only; no cookie; no `localStorage` or `sessionStorage` entry; no request to `/api` on the Vercel host.
- [ ] Record the run time of one full workflow and the container memory (`docker stats --no-stream`) before considering more workers.

## 11. Windows operating guide

Commands are PowerShell, run from the repository folder. Nothing here contains a secret.

**Start order after a reboot:** Docker Desktop -> `docker compose up -d apayee qatool-backend` (the containers also restart by themselves,
`restart: unless-stopped`) -> `cloudflared tunnel --url http://127.0.0.1:3001` -> the new-address steps in [9](#9-start-the-quick-tunnel-and-deploy).

**Status:** `docker compose ps`; `curl.exe -s http://127.0.0.1:3001/healthz`; the tunnel window; `curl.exe -s https://<random-words>.trycloudflare.com/healthz`.

**Stop (end of presentation):** Ctrl+C in the tunnel window (or `Stop-Process -Name cloudflared`). The API is gone from the internet at
once. Stop the containers only if you want to: `docker compose stop` (never `down -v`; do not `docker volume prune`).

**Keep the PC awake during a presentation.** Note the current values first so you can restore them:

```powershell
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
# closing a laptop lid: Control Panel > Power Options > "Choose what closing the lid does" > Do nothing (plugged in)
# afterwards restore your previous values, for example: powercfg /change standby-timeout-ac 30
```

Also: stay on mains power, pause Windows Update restarts, keep Docker Desktop running, and note that visitors' uploads and your Claude run
time use the PC's connection.

## 12. Troubleshooting

| Symptom                                                       | Likely cause and what to check                                                                                                                                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Page says the demo service cannot be reached**              | PC off or asleep, Docker stopped, or the tunnel is down or has a **new address** the page was not rebuilt with. Start Docker, the stack, the tunnel, then update `VITE_API_BASE_URL` and redeploy ([9](#9-start-the-quick-tunnel-and-deploy)) |
| **Docker stopped**                                            | `cloudflared` runs but Cloudflare returns 502 (origin refused). Start Docker Desktop; `docker compose ps`                                                                                                                                     |
| **Backend unhealthy or missing**                              | `docker compose logs --tail 50 qatool-backend` (no secrets are logged). A startup refusal names the variable. Fix `.env`, then `docker compose up -d --no-deps --force-recreate qatool-backend`                                               |
| **Backend up, jobs say the AI service is paused/unavailable** | Apayee is not ready or the Claude login expired: run gate row 11; if `provider` is not `claude`, sign in again ([DOCKER_LOCAL.md](DOCKER_LOCAL.md#one-time-claude-sign-in)). The pause lifts by itself after the cooldown                     |
| `403 ORIGIN_FORBIDDEN` in the browser                         | `ALLOWED_ORIGINS` is not exactly the origin in the address bar (scheme, host, port; a `*.vercel.app` deployment URL is a different origin). Fix `.env`, recreate the backend                                                                  |
| `TURNSTILE_FAILED`                                            | Widget hostname is not `qatool-staging.vercel.app`, action mismatch between `VITE_TURNSTILE_ACTION` and `TURNSTILE_ACTION`, wrong secret, or a token used twice                                                                               |
| `503 CHALLENGE_UNAVAILABLE`                                   | The backend cannot reach Cloudflare's verification service (PC offline, DNS or firewall in Docker). Nothing is admitted until it can                                                                                                          |
| `429 RATE_LIMITED` on session creation for everyone           | `TRUSTED_PROXY_PEERS` is empty or wrong, so all visitors share one address and one allowance                                                                                                                                                  |
| `QUEUE_FULL` / `UPLOAD_BUSY`                                  | Expected under load; the page retries or asks the visitor to wait. Capacity is workers + 10                                                                                                                                                   |
| Page shows "not configured"                                   | A `VITE_` variable is missing in Vercel (Production) or the deployment predates it; redeploy                                                                                                                                                  |

## 13. Rollback

Ordered from fastest to most complete. None of them uses `docker compose down -v` or touches the Claude volume.

1. **Stop traffic now:** Ctrl+C the tunnel window. The API is gone from the internet immediately.
2. **Lock the backend:** set `PUBLIC_DEMO=false` and recreate it; local mode has no authentication, so keep the tunnel stopped (or
   `docker compose stop qatool-backend`).
3. **Invalidate every visitor:** change `TICKET_SECRET` and recreate the backend (all tickets stop working); rotate the Turnstile secret in the
   dashboard and `.env` if it may have leaked.
4. **Remove the frontend:** in Vercel, roll back to the previous deployment or pause the project.
5. **Back to local use:** `docker compose up -d` restores the three-service local stack (frontend container included).

## 14. Known risks

- Real Claude run time, memory under load and parallel logins are **unmeasured**. Keep `JOB_WORKERS=1` and `APAYEE_MAX_CONCURRENT=1`
  until they are measured.
- The PC is the single point of failure: sleep, a reboot, Docker, the tunnel or the home connection take the demo down, and a Quick Tunnel
  restart changes the API address.
- A reload loses a visitor's session and data by design; background tabs can lose a job's 45 s lease.
- Serving others from a personal Claude subscription is the owner's policy risk.
- The owner-only operations dashboard is not designed; `PUBLIC_DEMO` and `PUBLIC_MODE` cannot share a process.

## 15. Alternative: custom domain with a named tunnel

Optional. For a standing service with a stable API address, a domain whose DNS is on Cloudflare replaces the Quick Tunnel. Everything above
(security boundaries, backend variables, gate, Vercel settings) still applies with these substitutions:

| Free profile                                     | Custom domain                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `qatool-staging.vercel.app`                      | `demo.<DOMAIN>`, added as the Vercel project's domain (DNS-only record if the zone is on Cloudflare)                            |
| `https://<random-words>.trycloudflare.com`       | `api.<DOMAIN>`, a **proxied** CNAME created by `cloudflared tunnel route dns`; it never changes                                 |
| `ALLOWED_ORIGINS`, `TURNSTILE_HOSTNAMES`, widget | the `demo.<DOMAIN>` origin and hostname (one entry, nothing broader)                                                            |
| `cloudflared tunnel --url ...`                   | a **named tunnel** run from a config file ([`deploy/cloudflared/config.example.yml`](../deploy/cloudflared/config.example.yml)) |
| redeploy on every tunnel restart                 | not needed: `VITE_API_BASE_URL=https://api.<DOMAIN>` is set once                                                                |

Tunnel setup (one time; opens a browser; writes `cert.pem` and a credentials JSON into `%USERPROFILE%\.cloudflared\`, outside Git, both secret):

```powershell
cloudflared tunnel login
cloudflared tunnel create qatool-staging                    # prints the tunnel UUID
cloudflared tunnel route dns qatool-staging api.<DOMAIN>
Copy-Item deploy\cloudflared\config.example.yml "$env:USERPROFILE\.cloudflared\config.yml"
notepad "$env:USERPROFILE\.cloudflared\config.yml"          # fill in the placeholders
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://api.<DOMAIN>/healthz   # must say: Matched rule #0
cloudflared tunnel --config "$env:USERPROFILE\.cloudflared\config.yml" run qatool-staging
```

The config has one hostname, one origin (`http://localhost:3001`) and a final `http_status:404`; **never** add 4100, 4101 or 5173. Do not put
`api.<DOMAIN>` behind Cloudflare Access (it would block visitors) or behind a Vercel rewrite.

Network protection becomes available, depending on your Cloudflare plan. This API is called by `fetch`, so **do not enable interactive
challenges on `api.<DOMAIN>`**; keep Turnstile as the gate:

- **WAF custom rule (block):** host is `api.<DOMAIN>` and the path does not start with `/api/` and is not `/healthz`; also block methods other
  than `GET`, `POST` and `OPTIONS`.
- **Rate limiting** per client address, generous enough for polling (about one request per 2.5 s per visitor); start with log/count, then enforce.
- If you try Bot Fight Mode, test the whole flow afterwards and turn it off for the API hostname if it interrupts `fetch`.
- The app's limits (20 MiB total upload) are below Cloudflare's per-request upload limits, and no request should run longer than about half a
  minute (inside Cloudflare's proxy read timeout of roughly 100 s).

To remove it: delete the `api.<DOMAIN>` DNS record, `cloudflared tunnel delete qatool-staging` (stop it first), and delete the credentials JSON
and `cert.pem` from `%USERPROFILE%\.cloudflared\`.
