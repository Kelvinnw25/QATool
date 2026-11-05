# QATOOL

Internal QA productivity tool. A QA analyst uploads project documents (PRD, RFC, specs); three LLM
calls draft requirements, test cases and a review; deterministic code validates the result and owns
every identifier and traceability link; the run ends in an `.xlsx` built from the office
**SIT Script** template, which QA then reviews by hand in Excel.

> **AI drafts. Deterministic code validates. QA decides.**

This README is the entry point: what the tool does, how to set it up on a new Windows laptop (both
repositories), how to run it, and where the detailed documents are. Working context for Claude Code is in
[`CLAUDE.md`](CLAUDE.md).

## Contents

1. [Documentation map](#documentation-map)
2. [Features](#features)
3. [Technology stack](#technology-stack)
4. [How it works](#how-it-works)
5. [The three-stage LLM pipeline](#the-three-stage-llm-pipeline)
6. [Providers and Apayee](#providers-and-apayee)
7. [Running modes: local, owner-only public, public demo](#running-modes-local-owner-only-public-public-demo)
8. [Repository layout](#repository-layout)
9. [Setup on a new Windows laptop](#setup-on-a-new-windows-laptop)
10. [Environment variables](#environment-variables)
11. [Running, building, testing](#running-building-testing)
12. [Troubleshooting](#troubleshooting)
13. [Project status](#project-status)

## Documentation map

| Document                                                       | What it is for                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md)                                       | Short AI-development context: invariants and rules that are easy to break                   |
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)             | Detailed behaviour reference for the local tool and the pipeline (23 sections)              |
| [`docs/DOCKER_LOCAL.md`](docs/DOCKER_LOCAL.md)                 | The three-container Docker stack, networking, the one-time Claude sign-in, health checks    |
| [`docs/PUBLIC_DEMO_JOBS.md`](docs/PUBLIC_DEMO_JOBS.md)         | The public demo: Turnstile, tickets, the async job API, the frontend                        |
| [`docs/PUBLIC_DEMO_SECURITY.md`](docs/PUBLIC_DEMO_SECURITY.md) | Security controls for both public modes: limits, headers, Compose hardening                 |
| [`docs/STAGING_DEPLOYMENT.md`](docs/STAGING_DEPLOYMENT.md)     | The free staging runbook: Vercel + Cloudflare Quick Tunnel; custom domain as an alternative |
| [`docs/ENVIRONMENT_SNAPSHOT.md`](docs/ENVIRONMENT_SNAPSHOT.md) | Versions, lockfile hash and test baseline last verified; recovery procedure                 |
| [`docs/edge-cases.md`](docs/edge-cases.md)                     | Why Edge cases are mapped to Positive/Negative on export                                    |
| [`docs/archive/`](docs/archive/)                               | Historical design documents (the unimplemented QAI blueprints), kept as written             |
| [`fixtures/README.md`](fixtures/README.md)                     | Which sample PDFs tests read and which are manual samples                                   |
| Apayee: `../Apayee/README.md`                                  | The separate gateway repository (its own CLAUDE.md, README and `docs/`)                     |

## Features

- Upload one or more **PDF, DOCX or XLSX** documents (format detected from content, not the file name).
- Extraction into numbered source blocks (`DOC-001-B001`, ...), with noise filtering and
  cross-document conflict detection.
- **Requirement structuring**: the model decides which blocks belong together; the system rebuilds the
  requirement text verbatim from those blocks, so quoted text is never model-written.
- **Test case generation**: Positive / Negative / Edge cases with steps, expected results and source
  references, plus five project-level text outputs (description, summary, QA guidance, SIT scope,
  background).
- **Coverage accounting**: deterministic "obligations" derived from the requirements are matched
  against the generated cases, and gaps are reported honestly.
- **Optional semantic review** of the generated cases (advisory only; nothing is regenerated from it).
- **XLSX export** into the unmodified office template, with a read-back self-check.
- **Per-run model choice** on the Upload page: Gemini (default) or Claude via the Apayee gateway.
- **A public async demo** for visitors without accounts (Turnstile, short-lived tickets, a bounded job
  queue); see [Running modes](#running-modes-local-owner-only-public-public-demo).
- **Stateless by design**: no database, no uploads on disk, no session store. The project lives in the
  browser for one session; the exported file is the deliverable.

## Technology stack

| Layer    | Choice                                                                              |
| -------- | ----------------------------------------------------------------------------------- |
| Runtime  | Node.js >= 22.13 (developed on 24.18), ESM only, no native dependencies             |
| Backend  | Fastify 5, `@fastify/multipart`, `@fastify/static`, `@fastify/cors`, `jose`, Zod 4  |
| Parsing  | `pdfjs-dist` (PDF), `fflate` (DOCX/XLSX are zip/XML, read directly)                 |
| Frontend | React 19, Vite 7 (npm workspace in `web/`)                                          |
| LLM      | Gemini API (default), Apayee gateway (optional), scripted `mock` provider for tests |
| Tests    | Node's built-in test runner (`node --test`); no Jest/Vitest                         |
| Style    | Prettier only; there is no ESLint configuration                                     |

## How it works

```text
Browser (React state holds the project)
  1. POST /api/extract    upload -> parse -> blocks -> LLM #1 -> requirements + test points
  2. POST /api/generate   requirements -> LLM #2 -> test cases + project outputs
  3. POST /api/validate   schema, references, coverage, heuristics (+ LLM #3 with ?semantic=true)
  4. POST /api/export     canonical project -> SIT Script .xlsx
```

Each endpoint is stateless, so a failed step retries without re-uploading. The server keeps nothing
between requests. `GET /api/llm/providers` lists the selectable models and whether each is usable now;
`GET /api/health` and `/api/meta/*` are small helpers. Errors are uniform:
`{ "error": { "code": "...", "message": "...", "details": [] } }`.

## The three-stage LLM pipeline

All three calls go through one interface, `LLMProvider.generateJson({ system, prompt, schema, signal })`.

| #   | Stage                    | Code                | Runs in                            | What the model decides                                                           |
| --- | ------------------------ | ------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Extraction / structuring | `server/structure/` | `POST /api/extract`                | Which blocks form a requirement, which are supporting, title, flags, test points |
| 2   | Test case generation     | `server/generate/`  | `POST /api/generate`               | Test case content and the project text outputs                                   |
| 3   | Semantic validation      | `server/semantic/`  | `POST /api/validate?semantic=true` | Advisory findings on the generated cases (optional)                              |

What the model does **not** decide: requirement text (rebuilt from cited blocks), ids (`REQ-nnn`,
`TC-nnn`), source references, categories, coverage figures. Stage 1 falls back to deterministic
extraction if the provider fails; a malformed stage 2 reply is fatal; a stage 3 failure is reported
and never blocks the run. Details: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) section 6.

## Providers and Apayee

| Provider | Selected by                                  | Notes                                                                                     |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `gemini` | default, or `?provider=gemini`               | Needs `GEMINI_API_KEY`. The key never leaves the server.                                  |
| `claude` | `?provider=claude` (UI: "Claude via Apayee") | Goes through the Apayee gateway; usable only when Apayee reports provider `claude`.       |
| `mock`   | `LLM_PROVIDER=mock`                          | Operator/test setting only; never offered in the UI. Runs the whole flow offline.         |
| `apayee` | `LLM_PROVIDER=apayee`                        | Server-wide default through Apayee; the UI shows it as "Server default (Apayee gateway)". |

**Apayee** is a separate private gateway in its own repository, expected at `../Apayee` (listening on
`http://127.0.0.1:4100` when run on the host). QATOOL stays the owner of prompts, schemas, validation and
export; Apayee only runs the inference request by driving a locally signed-in Claude Code CLI. QATOOL
reads Apayee, never modifies it, and holds no Claude credentials. Per-run rules: the choice is frozen
when Process is pressed and reused for every call of that run; an unavailable provider is refused
(`503 PROVIDER_UNAVAILABLE`) before the stage starts; nothing falls back to another provider. Full
behaviour: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) section 17.

## Running modes: local, owner-only public, public demo

One backend, three mutually exclusive modes chosen by environment variables. `PUBLIC_MODE` and `PUBLIC_DEMO`
cannot be combined.

| Mode            | Switch             | Who may use it                                     | API shape                                                                   |
| --------------- | ------------------ | -------------------------------------------------- | --------------------------------------------------------------------------- |
| **Local**       | default            | the single user on this machine; no authentication | the four routes above, any provider                                         |
| **Owner-only**  | `PUBLIC_MODE=true` | an owner signed in through Cloudflare Access       | the same routes behind an Access JWT; Claude stays owner-only               |
| **Public demo** | `PUBLIC_DEMO=true` | any visitor who passes a Turnstile check           | tickets and an async job API; model fixed to Claude; no direct model routes |

**The public demo in brief** (contract and limits in [`docs/PUBLIC_DEMO_JOBS.md`](docs/PUBLIC_DEMO_JOBS.md)):

```text
Vercel (static React build, no secret)            Windows PC (Docker, private)
  Turnstile widget ──► POST /api/session ──► ticket (HS256, 30 min, bound to the page's origin)
  upload           ──► POST /api/jobs    ──► 202 + job id    (documents parsed now, bytes dropped)
  poll every ~2.5 s──► GET  /api/jobs/:id ──► queued -> processing (extract/generate/validate) -> completed | failed | cancelled
  results, cancel  ──► GET  /api/jobs/:id/result, POST /api/jobs/:id/cancel
                                      qatool-backend ──► apayee (internal Docker network only) ──► Claude Code CLI
```

- **Frontend and backend are separate.** The React app is built with `VITE_PUBLIC_DEMO=true` and deployed to Vercel as static
  files; it learns the API address from `VITE_API_BASE_URL` at build time and holds its ticket in memory only (a reload starts a new session).
- **Visitors are identified only by the ticket's `sid`.** There are no accounts and no cookies. One live job per ticket; jobs
  run FIFO on `JOB_WORKERS` (default 1) with `JOB_MAX_PENDING` waiting. Jobs and counters live in memory and are lost on restart.
- **Apayee stays private.** It publishes no host port; only the backend reaches it over the Compose network.
- **Staging** runs the backend in Docker on this PC behind a free Cloudflare Quick Tunnel, with the frontend at
  `https://qatool-staging.vercel.app`. The tunnel's address changes on every restart, which needs a Vercel variable update and a redeploy;
  the Vercel page stays up while the PC, Docker or the tunnel is off. Runbook: [`docs/STAGING_DEPLOYMENT.md`](docs/STAGING_DEPLOYMENT.md).
  Security controls: [`docs/PUBLIC_DEMO_SECURITY.md`](docs/PUBLIC_DEMO_SECURITY.md).

## Repository layout

```text
QATOOL/
  README.md, CLAUDE.md        Overview/setup, and context for Claude Code
  package.json                Scripts; npm workspace "web"
  compose.yaml, Dockerfile.*  Optional local Docker stack (UI, API, Apayee); .dockerignore is an allow-list
  .env.example                Every supported variable, no secrets (copy to .env)
  vercel.json, .vercelignore  Frontend deployment settings for Vercel; what the CLI may upload
  deploy/                     Copy-from checklists for the staging variables; cloudflared config template
  server/                     Fastify API and the whole pipeline
    index.js, app.js          Entry point; app factory, error handling, static serving
    config.js                 Environment parsing + redactSecrets()
    routes/                   pipeline.js (extract/generate/validate/export), meta.js, llm.js, session.js
    extract/                  Format detection, parsers (pdf/docx/xlsx), blocks, noise, conflicts
    structure/                LLM #1: prompt, contract, validation/rebuild, recovery, test points
    generate/                 LLM #2: prompt, contract, assembly (ids, refs, dedup, coverage)
    semantic/                 LLM #3: heuristics, prompt, contract, merge and anchor check
    scenario/                 Deterministic checklist and coverage obligations
    schema/                   Canonical Zod model; enums.js is the only place enum values live
    export/                   Template reader, OOXML sheet builder, edge mapping, read-back inspect
    llm/                      provider.js (interface), gemini.js, apayee.js, mock.js, catalog.js
    security/                 Public-mode controls: Access JWT, tickets, Turnstile, origin/CORS, limiter, uploads, model gate
    jobs/                     Public demo job platform: manager, runner, routes, breaker, metrics, fixtures
    pipeline/                 Pieces the routes and the job runner share (validation, canonical input, merge)
    lib/                      errors, ids, text, cancellation, trace
    benchmark/                Golden oracle for one real PRD, and its tests
    testing/no-network.js     Makes any non-localhost request throw during tests
  web/                        React UI (src/stages, components, state, session, jobs, api.js, pipeline.js, config.js)
  templates/                  sit-script-template.xlsx (the office template, never modified)
  scripts/                    dev.js, llm-smoke.js, e2e-live.js, qa-eval/ (live-model evaluation tools)
  fixtures/prd/               Sample PDFs (two are read by tests; see fixtures/README.md)
  docs/                       Reference documents (see the map above); archive/ holds the QAI blueprints;
                              HUMAN_REVIEW_QUEUE.csv is the QA team's open review-queue data (Indonesian)
```

Generated or local only (ignored by Git): `node_modules/`, `web/dist/`, `.env`, `.vercel/`, `.qa-eval-output/`.

## Setup on a new Windows laptop

QATOOL does not run Claude by itself: for the Claude and public-demo paths it depends on **Apayee**, a
separate repository. Set up both, side by side.

### 1. What the two repositories share

```text
Desktop/                (any parent folder works, but the two folders must be siblings)
├── QATool/             this repository
└── Apayee/             https://github.com/Kelvinnw25/Apayee  (a separate Git project)
```

- **Why side by side.** QATOOL's `compose.yaml` builds the `apayee` service from `../Apayee` and reads
  `../Apayee/.env`; the opt-in test `npm run test:apayee` starts Apayee from `../Apayee` too (override with `APAYEE_DIR`).
- **Docker network.** Compose creates one private network, `qatool_qatool-net`. `qatool-backend` reaches Apayee at
  `http://apayee:4100`; inside the Apayee container the app listens on `127.0.0.1:4101` and `socat` forwards `4100`. Apayee publishes
  **no host port**; only `127.0.0.1:3001` (API) and `127.0.0.1:5173` (UI container) are published.
- **Which variables belong to which repository.**

  | Repository | File                | Holds                                                                                                                   |
  | ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | QATOOL     | `QATool/.env`       | `APAYEE_TOKEN`, `GEMINI_API_KEY` (optional), `LLM_PROVIDER`, public-demo settings (`TICKET_SECRET`, `TURNSTILE_*`, ...) |
  | Apayee     | `Apayee/.env`       | `APAYEE_AUTH_TOKEN`, `APAYEE_PROVIDER`, `APAYEE_CLAUDE_*`, `APAYEE_MAX_CONCURRENT`, queue and timeout limits            |
  | QATOOL web | Vercel (Production) | `VITE_PUBLIC_DEMO`, `VITE_API_BASE_URL`, `VITE_TURNSTILE_SITE_KEY`, `VITE_TURNSTILE_ACTION` (all public)                |

- **Credentials that must match.** `APAYEE_TOKEN` (QATOOL) must equal `APAYEE_AUTH_TOKEN` (Apayee). Nothing else is shared.
- **Local-only, excluded from Git.** Both `.env` files, `.vercel/`, the Vercel variables, the Turnstile keys (in your Cloudflare account) and
  the Claude login. Compose overrides only `HOST`, `PORT` and `APAYEE_BASE_URL` for the backend and `APAYEE_CLAUDE_CLI_PATH` for Apayee.
- **Why the Claude login is not in Git.** It is the owner's personal subscription sign-in. It lives in the Docker named volume
  `apayee-claude-config` (declared `external: true` in `compose.yaml`, so `docker compose down -v` cannot delete it), is never in an image, and
  is created per machine by signing in once. Never copy, commit or paste it.

### 2. Install the prerequisites

PowerShell, on a clean Windows 11 laptop (accept the UAC prompts; open a **new** terminal afterwards so `PATH` refreshes):

```powershell
winget install --id Git.Git
winget install --id OpenJS.NodeJS.LTS          # Node >= 22.13 is required; node -v to check
winget install --id Docker.DockerDesktop       # then start it once and accept its WSL 2 backend setup
wsl --install                                  # only if Docker Desktop asks for WSL 2; reboot when told to
```

Optional, for the public staging path only: `npm i -g vercel` (Vercel CLI) and `winget install --id Cloudflare.cloudflared`.
Check with `git --version`, `node -v`, `npm -v`, `docker version` (client **and** server must answer; if not, Docker Desktop is not running yet).

### 3. Clone both repositories

```powershell
cd $HOME\Desktop
git clone https://github.com/Kelvinnw25/QATool.git QATool
git clone https://github.com/Kelvinnw25/Apayee.git Apayee
```

### 4. Create Apayee's `.env`

```powershell
cd $HOME\Desktop\Apayee
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | Set-Clipboard   # a fresh token, not shown
notepad .env
```

In the editor set `APAYEE_AUTH_TOKEN=` (paste the token, then `Set-Clipboard -Value $null`), `APAYEE_PROVIDER=claude`,
`APAYEE_CLAUDE_EXPERIMENTAL=true`, and, only after you have checked your own plan in your Claude account settings,
`APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true` (your attestation; Apayee cannot verify a plan). Leave `APAYEE_MAX_CONCURRENT` unset (default 1).
For standalone (non-Docker) use see the Apayee README. Optional: `npm ci` and `npm test` in `Apayee` (offline; no Claude call).

### 5. Create QATOOL's `.env`, install, test, build

```powershell
cd $HOME\Desktop\QATool
npm ci                                  # lockfile-exact install of the root and the web workspace
Copy-Item .env.example .env
notepad .env
```

In `.env`: set `APAYEE_TOKEN=` to **the same value** as `APAYEE_AUTH_TOKEN` (compare without printing: the snippet in
[`docs/DOCKER_LOCAL.md`](docs/DOCKER_LOCAL.md#before-you-start)); set `GEMINI_API_KEY` only if you will use Gemini (get it through your own channel);
for offline work set `LLM_PROVIDER=mock`. Extraction and export need no key. Then:

```powershell
npm test                                # offline, free; baseline in docs/ENVIRONMENT_SNAPSHOT.md
npm run build                           # builds web/dist
npm run format:check
```

### 6. Start the Docker stack and sign Claude in

Docker Desktop must be running. `compose.yaml` requires the sign-in volume to exist, and it is created once per machine:

```powershell
docker volume create apayee-claude-config
docker compose up -d --build            # first build takes several minutes; apayee -> backend -> frontend
docker compose ps                       # all three: healthy (Apayee "healthy" does not yet mean Claude is signed in)
docker compose run --rm apayee node scripts/claude-auth.js login      # one-time; you finish the browser step
docker compose up -d --force-recreate apayee
```

The sign-in step prints a URL; open it in your own browser, choose the Claude **account** (subscription) option, and paste the code back. Full
procedure, the safe status check and troubleshooting: [`docs/DOCKER_LOCAL.md`](docs/DOCKER_LOCAL.md#one-time-claude-sign-in). Do not run
`docker volume rm` or `docker volume prune` on `apayee-claude-config`.

### 7. Verify (no model call)

```powershell
docker compose ps                                          # apayee, qatool-backend, qatool-frontend: healthy
Invoke-RestMethod http://127.0.0.1:3001/healthz            # status ok
Invoke-RestMethod http://localhost:5173/api/llm/providers  # claude "available": true once Apayee reports provider claude
docker compose exec apayee node -e "fetch('http://127.0.0.1:4100/v1/health',{headers:{Authorization:'Bearer '+process.env.APAYEE_AUTH_TOKEN}}).then(r=>r.json()).then(j=>console.log(j.status,j.provider,j.queue.max_active))"
```

Expected: `ok claude 1` (provider `claude`, one execution at a time). Open `http://localhost:5173`. The two stacks share ports 3001 and 5173, so
use either the Docker stack **or** `npm run dev`, not both. For Apayee on the host instead of Docker, follow the Apayee README, point `APAYEE_BASE_URL` at
`http://127.0.0.1:4100`, and run `npm run dev`.

### 8. Optional: the public staging demo

Needs a Cloudflare account (Turnstile widget), a Vercel account, `vercel login` and `vercel link` (choose the existing `qatool-staging` project;
`.vercel/` is Git-ignored and per machine), the four Production variables, and a **new** Quick Tunnel address every time (update
`VITE_API_BASE_URL`, then redeploy). All steps: [`docs/STAGING_DEPLOYMENT.md`](docs/STAGING_DEPLOYMENT.md).

### What to recreate when moving to another computer

Everything in Git comes back with the two clones. Recreate: both `.env` files (a fresh `APAYEE_AUTH_TOKEN` is fine, if both sides match), the
`apayee-claude-config` volume and the Claude sign-in, Docker images (`docker compose up -d --build`), Vercel CLI login and `vercel link`, and
`cloudflared`. The Vercel variables and the Turnstile widget live in your accounts and carry over; the Quick Tunnel address does not. Uncommitted
work does not travel: commit and push first.

## Environment variables

Names and purpose only; defaults are in `server/config.js` and `.env.example`. Values are never committed.

| Variable                                                                           | Purpose                                                                                   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `PORT`, `HOST`                                                                     | API address (defaults `3001`, `127.0.0.1`)                                                |
| `NODE_ENV`                                                                         | `production` makes the server also serve `web/dist`                                       |
| `LOG_LEVEL`                                                                        | Fastify log level                                                                         |
| `SIT_TEMPLATE_PATH`                                                                | Path to the SIT Script template                                                           |
| `MAX_BODY_BYTES`                                                                   | Request ceiling; also the in-memory ceiling for uploads (default 25 MB)                   |
| `LLM_PROVIDER`                                                                     | Server default: `gemini`, `mock` or `apayee`                                              |
| `GEMINI_API_KEY`                                                                   | Gemini key (server-side only)                                                             |
| `GEMINI_MODEL`, `GEMINI_BASE_URL`                                                  | Pin a Gemini model / endpoint                                                             |
| `LLM_TIMEOUT_MS`, `LLM_MAX_OUTPUT_TOKENS`                                          | Per-call budget and output cap                                                            |
| `LLM_TEMPERATURE`                                                                  | Leave unset for Gemini 3 models                                                           |
| `APAYEE_BASE_URL`                                                                  | Where Apayee is (default `http://127.0.0.1:4100`; Compose sets `http://apayee:4100`)      |
| `APAYEE_TOKEN`                                                                     | Bearer token; must equal Apayee's `APAYEE_AUTH_TOKEN`                                     |
| `APAYEE_QUEUE_WAIT_MS`                                                             | Extra time allowed for waiting in Apayee's queue                                          |
| `PUBLIC_MODE`                                                                      | `true` requires a Cloudflare Access owner token on every route (off by default)           |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`                                                 | Cloudflare Access team domain and audience tag (required in public mode)                  |
| `OWNER_EMAILS`, `ALLOWED_ORIGINS`                                                  | Owner accounts, and exact origins of the public frontend (required in public mode)        |
| `TRUSTED_PROXY_PEERS`                                                              | Peers whose `CF-Connecting-IP` is believed (logs, and the demo's ticket-minting backstop) |
| `UPLOAD_*`, `ZIP_*`, `PDF_MAX_PAGES`                                               | Upload, archive and PDF limits (always on; stricter in public mode)                       |
| `LLM_MAX_CONCURRENT`, `RATE_LIMIT_PER_MINUTE`, `REQUEST_DEADLINE_MS`               | Owner-mode model gate: concurrency, rate, deadline (there is no request budget)           |
| `PUBLIC_DEMO`, `TICKET_SECRET`, `TURNSTILE_*`, `JOB_*`, `UPLOAD_INFLIGHT_MAX`, ... | Public demo: Turnstile tickets and the async job API (`docs/PUBLIC_DEMO_JOBS.md`)         |

Frontend (build time, all public, `web/.env.example`): `VITE_PUBLIC_DEMO`, `VITE_API_BASE_URL`, `VITE_TURNSTILE_SITE_KEY`,
`VITE_TURNSTILE_ACTION`. **No secret ever gets a `VITE_` name.** Opt-in test switches (read only by those tests): `QATOOL_LIVE_LLM=1`,
`QATOOL_APAYEE_SMOKE=1`, `APAYEE_DIR` (location of the Apayee project, default `../Apayee`).

## Running, building, testing

| Command                           | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `npm run dev`                     | API (http://127.0.0.1:3001) and UI (http://localhost:5173) together    |
| `npm run dev:server`              | API only, no file watcher                                              |
| `npm run dev:server:watch`        | API only with `node --watch` (a restart aborts any in-flight request)  |
| `npm run dev:web`                 | UI only (Vite, proxies `/api` to the API)                              |
| `npm run build`                   | Build the UI into `web/dist`                                           |
| `npm start`                       | API server; serves `web/dist` when `NODE_ENV=production`               |
| `npm test`                        | Whole suite; offline, never calls an LLM (`no-network.js` enforces it) |
| `npm run test:llm`                | Live Gemini test (needs `QATOOL_LIVE_LLM=1` and a key; spends quota)   |
| `npm run test:apayee`             | Pipeline test against a real Apayee (needs `QATOOL_APAYEE_SMOKE=1`)    |
| `npm run llm:smoke`               | One real provider call with a synthetic fixture                        |
| `npm run e2e:live`                | Whole pipeline against a running server (real provider calls)          |
| `npm run qa:eval`                 | Quality evaluation over synthetic documents (real provider calls)      |
| `npm run format` / `format:check` | Prettier write / check                                                 |

Production-style run on the host: `npm run build`, then `NODE_ENV=production npm start` (PowerShell:
`$env:NODE_ENV='production'; npm start`). Under `npm run dev`, React StrictMode runs each UI processing phase twice, so a development run makes two
model calls per stage; a production build makes one. `docker compose` commands are in [`docs/DOCKER_LOCAL.md`](docs/DOCKER_LOCAL.md).

## Troubleshooting

| Symptom                                                  | Cause and fix                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run dev` stops at a Node version error              | Install Node >= 22.13.                                                                                            |
| `docker` says it cannot connect to the API               | Docker Desktop is not running. Start it and wait until `docker version` shows a server.                           |
| `docker compose up` fails on a missing volume            | `docker volume create apayee-claude-config` (the volume is `external`, so Compose will not create it).            |
| `env file ... .env not found`                            | Create `QATool/.env` and `Apayee/.env` from their `.env.example` files.                                           |
| UI loads but requests fail with an empty 500             | The API is not up yet or crashed; `dev.js` normally waits for `/api/health`. Check the API terminal.              |
| Generation fails with an LLM error and no key is set     | `LLM_PROVIDER` is `gemini` but `GEMINI_API_KEY` is empty. Set the key or use `LLM_PROVIDER=mock`.                 |
| Gemini returns 429 or 503                                | Free tier is 20 requests/day/model, and a 503 still consumes one. Wait; do not retry in a loop.                   |
| "Claude via Apayee" is greyed out                        | Apayee is offline, wrong token, not signed in, or not running the `claude` provider. The UI shows the reason.     |
| Apayee rejects the server's credentials                  | `APAYEE_TOKEN` differs from `APAYEE_AUTH_TOKEN`. Make them equal, then recreate the containers.                   |
| Structuring warning "deterministic extraction"           | The model call failed or returned nothing usable; extraction continued without the model.                         |
| Server fails at startup with an Apayee URL/token message | A bad `APAYEE_BASE_URL`, a malformed token, or a remote URL without `APAYEE_TOKEN`.                               |
| `npm test` fails on a PDF path                           | The two `PRD_*` PDFs must stay in `fixtures/prd/`.                                                                |
| Production server shows no UI                            | Run `npm run build` and start with `NODE_ENV=production`.                                                         |
| Port 3001 or 5173 already in use                         | Stop the other process (the Docker stack and `npm run dev` share both ports).                                     |
| The public page says the demo service cannot be reached  | Docker, the backend or the Quick Tunnel is down, or the tunnel address changed: see `docs/STAGING_DEPLOYMENT.md`. |

## Project status

- **Implemented and tested offline:** the three-call pipeline, XLSX export, per-run model selection, the Apayee provider with cancellation,
  the golden-oracle benchmark, backend hardening for both public modes, the public demo's async job backend, and its frontend
  (Turnstile session, job client, queue and phase UI). The offline baseline is recorded in
  [`docs/ENVIRONMENT_SNAPSHOT.md`](docs/ENVIRONMENT_SNAPSHOT.md) (a recorded snapshot, not a live number: 2,009 tests, 1,998 pass, 0 fail, 0 cancelled, 1 skipped, 10 todo);
  run `npm test` for the current result.
- **Staging:** the frontend is deployed at `https://qatool-staging.vercel.app` and a browser Turnstile session through a Quick Tunnel has been
  verified. **A full real generation and export run through the browser has not yet been confirmed**, and real model run time and memory under load
  are unmeasured. The stack runs only while this PC, Docker, the backend and a tunnel are up.
- **Specified, not implemented:** the QAI P0 target architecture (two LLM calls, run-scoped artifact storage, no obligation engine, red highlighting
  for rows needing review) in [`docs/archive/QAI_Blueprint_v4_P0_Refinement.md`](docs/archive/QAI_Blueprint_v4_P0_Refinement.md).
- **Known limitations:** Gemini free-tier quota; large documents truncate at 400 blocks / 120,000 characters; local mode has no authentication and plain
  HTTP (single user); no ESLint. Full list: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) section 19.
- **Open work:** extraction prompt efficiency (audit done, nothing applied), live validation that the model follows the generation granularity rules,
  and measuring a real public-demo run.
- **Data handling:** documents are parsed in memory and discarded; prompts and replies are not logged; see
  [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) section 20. Sending real internal documents to a model is an organisational decision, not something the
  code decides.
