# CLAUDE.md - QATOOL

Context for Claude Code. Setup and usage live in `README.md`; the long behaviour reference is
`docs/IMPLEMENTATION.md`. This file is only what you need before changing code.

## What this is

Internal QA tool: documents (PDF/DOCX/XLSX) -> requirements -> SIT test cases -> `SIT Script.xlsx`.
Node >= 22.13 ESM, Fastify 5, Zod 4, `jose`, React 19 + Vite (npm workspace `web/`). No database, no
native deps. Principle: **AI drafts, deterministic code validates, QA decides.**

## Flow and modules

```text
POST /api/extract   server/extract/ (parse, blocks) -> server/structure/ (LLM #1) -> requirements + test_points
POST /api/generate  server/generate/ (LLM #2) + scenario/ (checklist, obligations) -> test cases
POST /api/validate  server/schema + semantic/heuristics (+ semantic/ LLM #3 when ?semantic=true)
POST /api/export    server/export/ -> .xlsx from templates/sit-script-template.xlsx
```

| Path                        | Responsibility                                                                                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/routes/pipeline.js` | The four routes; chooses the provider per request (`chooseProvider`)                                                                                                                                                                                       |
| `server/structure/`         | LLM #1. `prompt.js`, `contract.js` (JSON schema + Zod), `validate.js` (rebuild), `recover.js`, `test-points.js`, `index.js` (fallback)                                                                                                                     |
| `server/generate/`          | LLM #2. Prompt, contract, `assemble.js` (ids, source refs, dedup, coverage)                                                                                                                                                                                |
| `server/semantic/`          | LLM #3 plus free deterministic heuristics                                                                                                                                                                                                                  |
| `server/scenario/`          | Deterministic checklist and 10 obligation types + matching                                                                                                                                                                                                 |
| `server/schema/`            | Canonical model. `enums.js` is the only place enum values are written                                                                                                                                                                                      |
| `server/export/`            | OOXML writer; edge mapping; read-back `inspect.js` self-verification                                                                                                                                                                                       |
| `server/llm/`               | `provider.js` interface; `gemini.js`, `apayee.js`, `mock.js`; `catalog.js` = user-selectable models and availability                                                                                                                                       |
| `server/security/`          | Public-mode controls: Access JWT (`access.js`), demo tickets and Turnstile (`ticket.js`, `turnstile.js`, `session.js`), origin/CORS, owner-mode model gate (rate, concurrency, deadline; no budget), limiter, streaming uploads, error scrubbing, settings |
| `server/jobs/`              | Public demo job platform: manager (FIFO queue, workers, lease, retention), runner (the phases), routes, breaker, metrics, public-result scrubbing. Fixtures in `jobs/fixtures/`                                                                            |
| `server/pipeline/`          | Pieces the routes and the job runner share: `validation.js`, `canonical-input.js`, `merge.js` (a copy of the browser's, held equal by a test)                                                                                                              |
| `server/config.js`          | All env parsing and `redactSecrets()`; `config.security` comes from `security/settings.js`                                                                                                                                                                 |
| `web/src/`                  | `pipeline.js` (phases), `api.js` (the only place URLs and the ticket header are built), `config.js` (`VITE_*`), `session/` (Turnstile, in-memory ticket), `jobs/` (job runner, failure wording), `state/run.js`, `providers.js`, `stages/`, `components/`  |

Exactly three call sites use `generateJson` (structure, generate, semantic). Keep it that way unless asked.

## Concepts you must know before editing

- **Source blocks.** The parser yields blocks; ids `DOC-001-Bnnn` are assigned by the system. Stage 1
  sends them to the model (cap: 400 blocks, 120,000 chars, 1,200 chars each).
- **The model never writes requirement text.** It cites `source_block_id`s; `structure/validate.js`
  rebuilds `description`, category, `source_references` and `REQ-nnn` from the blocks. Unknown ids are
  dropped with a warning. `recover.js` restores unclaimed behavioural blocks. Descriptions are cut at
  5,000 chars silently. Do not add prompt text that asks the model to quote.
- **Zod caps** in `structure/contract.js` (<=300 requirements, <=20 test points each, title/statement
  <=300) fail the whole reply, which triggers deterministic fallback; the prompt does not state them.
- **Fallbacks.** Stage 1 provider error or unparseable reply -> deterministic extraction + warning.
  Stage 2 malformed reply is fatal. Stage 3 failure is reported, never blocking.
- **Test points** are not in the canonical model: returned by `/api/extract`, held in a React ref,
  posted back, revalidated and pinned to real requirement ids.
- **Obligations** (`scenario/obligations.js`) are derived mechanically and drive coverage arithmetic;
  matching is word-overlap.
- **Edge cases.** `case_type = Edge` exists internally with a required `edge_polarity`
  (`valid`/`invalid`). Export deterministically maps Edge -> Positive/Negative and prefixes
  `[Edge Case] `, because the office template's dropdown only allows Positive/Negative
  (`docs/edge-cases.md`). Never write `Edge` into the workbook; a missing polarity is a blocking error.
- **The template is never modified** (`templates/sit-script-template.xlsx`). The five project text
  outputs show on the Results page, not as a worksheet.
- **Stateless.** Nothing is written to disk or kept between requests; `server/no-persistence.test.js`
  enforces it. Do not add a database, cache or upload directory. The carve-outs are in-memory only, held in one
  app instance, reset by a restart, and bounded: the owner-mode model gate (`security/gate.js`, off unless limits
  are configured) and the demo's job table, limiters and replay set (`server/jobs/`, `security/limiter.js`,
  `security/turnstile.js`; demo mode only). They are a brake, not a billing control.
- **Public mode** (`PUBLIC_MODE=true`, off by default; `docs/PUBLIC_DEMO_SECURITY.md`). Every route needs a
  valid Cloudflare Access JWT from an owner (`jose`, RS256, issuer, audience, `exp`, exact email), except
  `/healthz`. Default deny, fail closed, startup refuses missing settings. Never loosen it to make a test
  or a demo pass; add the test to `server/security/`. Rules that are easy to break:
  - **Hook order.** Security hooks must be added after the run-starting hook and before the routes
    (`registerSecurity` in `app.js`), or they run without a request id.
  - **Limits are enforced while data streams** (`security/uploads.js`, `extract/zip.js`), counting bytes
    actually produced, never sizes an upload declares. Do not call `unzipSync` on an upload.
  - **Claude is owner-only**, enforced server-side. `LLM_PROVIDER=apayee` is refused in public mode.
  - **Public errors and logs** carry no provider text, address, path or upload filename.
  - `X-Forwarded-For` is never read; `CF-Connecting-IP` only from `TRUSTED_PROXY_PEERS`, for logs only.
- **Public demo** (`PUBLIC_DEMO=true`, a third mode that cannot be combined with `PUBLIC_MODE`; `docs/PUBLIC_DEMO_JOBS.md`).
  Visitors get a Turnstile-checked HS256 ticket (`sid`, `iss`, `aud` = their origin, `exp`; never bound to an address)
  and work through `/api/jobs`: one job = one workflow segment (`from` extract/generate/validate onward), FIFO,
  `JOB_WORKERS` (default 1, max 3, never above the gateway's `max_active`; assume 1 if it is not reported) running
  plus `JOB_MAX_PENDING` waiting, one live job per `sid`. The model is fixed to catalog id `claude`; direct model
  routes are not registered. Rules easy to break:
  - **The `sid` is the only identity**, from `ticket.js` only. Job ids are names, never credentials; unknown, expired
    and not-yours are the same 404.
  - **Admission before bytes:** limiter, provider check and reservation run in `onRequest`; documents are parsed in a
    worker thread (`extract/isolated.js`) at submission and the uploaded buffers are dropped. Never hold uploads in a
    pending job.
  - **There is no model request budget.** Do not add an hourly/daily count. Polling and health checks never count.
  - **Visitor-visible text** carries no provider, model, address or gateway message (`jobs/public-provider.js`,
    `public-result.js`). Metrics (`jobPlatform.metrics`) are internal and have no route.
  - **Jobs are in memory** and lost on restart (`boot_id`); this is the second carve-out of the stateless rule.
- **Public demo frontend** (implemented; `web/src/`; details in `docs/PUBLIC_DEMO_JOBS.md` > Frontend). Built with
  `VITE_PUBLIC_DEMO=true`; otherwise the page is the local tool, unchanged. Four public build-time settings, all
  readable by anyone who downloads the bundle, so **no secret ever gets a `VITE_` name**: `VITE_PUBLIC_DEMO`,
  `VITE_API_BASE_URL` (API origin; empty keeps relative `/api/...` and the Vite proxy), `VITE_TURNSTILE_SITE_KEY`,
  `VITE_TURNSTILE_ACTION` (must equal the backend's `TURNSTILE_ACTION`, default `qatool_demo`). Rules easy to break:
  - **The ticket lives in memory only** (`session/ticket-store.js`): no localStorage, sessionStorage, cookie or
    `credentials`. A reload loses it and the page says so; a test scans the source and the bundle.
  - **`api.js` builds every URL and attaches `Authorization: Bearer`**; nothing else calls `fetch`. No provider or
    model is ever sent, and the demo never asks which models exist (`useProviders({ enabled: false })`).
  - **Work goes through `jobs/run.js`**, one polling loop per job, interval `poll_after_ms` clamped to 10 s (the lease is
    45 s). Only `UPLOAD_BUSY` is retried automatically; an ambiguous network failure is never resent by itself
    (`JOB_ALREADY_ACTIVE` recovery adopts the job that exists). Nothing cancels a job but the visitor's Cancel button;
    a server shutdown or an abandoned lease is shown as a failure with restart/inactivity guidance, not as a cancellation.
  - **Results carry no provider or model**; pages must not print one (`madeBy()` in `ResultsStage.jsx`).
- **Provider selection is per request.** `?provider=gemini|claude`; absent means the server's
  `LLM_PROVIDER`. Claude is available only when Apayee's `/v1/health` reports provider exactly `claude`;
  availability is checked before the stage runs; no fallback to another provider; mock is never offered.
  The UI freezes the choice into the run (`state/run.js`) and ignores replies from replaced runs.
- **Secrets.** Keys/tokens stay server-side, go in headers only, and are never logged or returned.
  Provider error bodies are never relayed (they can echo document text). Prompts/replies are not logged.

## External integrations

- **Gemini** (`gemini-3.8-flash` default): free tier is 20 requests/day/model and a 503 still consumes
  one. Never retry in a loop. Never send temperature for Gemini 3 unless `LLM_TEMPERATURE` is set.
  A full run costs 3 calls (extract, generate, semantic; the UI always asks for semantic).
- **Apayee** is a separate Git repo cloned as a sibling, `../Apayee` (host: 127.0.0.1:4100; in Docker it has no
  host port and is `http://apayee:4100`). Compose builds it from there and reads `../Apayee/.env`. `APAYEE_TOKEN`
  (QATOOL) must equal `APAYEE_AUTH_TOKEN` (Apayee). The Claude login lives in the external Docker volume
  `apayee-claude-config`, never in Git. It is read-only from QATOOL's side unless the user explicitly asks for a
  change there: do not edit it, start/stop it, or call it from tests (`npm test` blocks non-localhost traffic; the
  fake gateway in `server/llm/fixtures/` stands in). QATOOL has no Claude credentials. New-machine setup for both
  repositories: `README.md` > "Setup on a new Windows laptop".
- External LLM use for the internal PRDs was explicitly approved by the user; do not re-ask.

## Commands

```bash
npm install
npm run dev            # API :3001 + UI :5173
npm test               # offline; never calls an LLM. Run it after any change
npm run build          # UI -> web/dist
npm run format:check   # Prettier (only style tool)
NODE_ENV=production npm start   # serves web/dist
```

`npm run llm:smoke`, `e2e:live`, `qa:eval`, `test:llm`, `test:apayee` make real provider calls: run them
only when asked.

Optional Docker stack (`compose.yaml`, `Dockerfile.backend`, `Dockerfile.frontend`, `.dockerignore`;
details in `docs/DOCKER_LOCAL.md`): three services, `qatool-frontend`, `qatool-backend`, `apayee`
(built from `../Apayee`, which stays read-only). Containers read `./.env` and `../Apayee/.env` at run
time and override only `HOST`, `PORT` and `APAYEE_BASE_URL` (`http://apayee:4100`); no secret goes in
a Dockerfile, the compose file or an image. The Claude sign-in lives in the named volume
`apayee-claude-config`, declared `external: true` in `compose.yaml` so `down -v` cannot delete it: never `docker volume rm` or `docker volume prune` it unless asked. The Vite proxy target comes from
the server-side `API_PROXY_TARGET` (default unchanged), never a `VITE_` variable. **Apayee publishes no
host port** (reach it with `docker compose exec apayee ...`); all three containers drop every capability
and have memory/CPU/PID ceilings. The backend health check is `/healthz`. The host workflow and the stack
share ports 3001/5173, so only one runs at a time.

Before changing the Node.js or npm version, `package-lock.json` or any dependency version, read
`docs/ENVIRONMENT_SNAPSHOT.md` (and its `.json` twin): it records the versions last checked, the
lockfile hash, and the `npm test` baseline: 2,009 tests, 1,998 pass, 0 fail, 0 cancelled, 1 skipped, 10
todo, exit code 0. (The 11 cancelled tests in `server/llm/llm.test.js` that older snapshots record were a
test-only timer problem, fixed; a cancellation now is a regression.)

## Conventions

- ESM everywhere; Prettier config in `.prettierrc` (single quotes, width 100). No ESLint.
- Tests sit next to the code as `*.test.js` on `node:test`; the frontend tests are plain `.js` too.
- Enum values only in `server/schema/enums.js`; ids only via `server/lib/ids.js`; vendor code only in `server/llm/`.
- Tests read two PDFs by literal path: `fixtures/prd/PRD_*.pdf`. Keep them there.
- Docs for users are English; the QAI blueprints in `docs/archive/` are Indonesian and historical.
- `server/benchmark/` is a golden oracle: correct it only by citing the source PRD, never to make a run agree.

## Status and cautions

- V1 pipeline, export, per-run model selection and the Apayee provider are implemented. The QAI P0
  architecture (`docs/archive/QAI_Blueprint_v4_P0_Refinement.md`) is specified but not implemented, and would
  supersede the stateless rule for its own path only.
- Prompt-efficiency audit of stage 1 was done (read-only); nothing was applied. Candidate savings are
  small (system prompt about -9%); serialization of the block list and the schema are the larger levers.
  Treat any change to `structure/prompt.js` as needing a regression run on real PRDs.
- `server/lib/trace.js` gives each `/api/` request a run id and one metadata-only summary line (wired in
  `app.js`). `confidence` is a hard enum in the generation reply. Model compliance with the granularity
  rules has not been proven by a recorded live run.
- Backend hardening (P1), the public demo's async job backend and the public demo frontend (Turnstile session, job
  client, queue/phase UI) are implemented and tested offline. **Staging is deployed, not a standing service:** the frontend is
  at `https://qatool-staging.vercel.app` (Vercel project `qatool-staging`), the backend runs in Docker on the owner's PC behind a free
  Cloudflare Quick Tunnel, and a browser Turnstile session was verified. A full real generation and export run through the browser is **not
  yet confirmed** and no real model run has been measured. The tunnel address changes on every restart (update `VITE_API_BASE_URL`, redeploy);
  the Vercel page stays up while the PC, Docker or the tunnel is off. Runbook: `docs/STAGING_DEPLOYMENT.md`; `vercel.json`, `.vercelignore`
  and `deploy/` hold the templates. `jose` and `@fastify/cors` are the two dependencies added. Remaining risks are in
  `docs/PUBLIC_DEMO_SECURITY.md` and `docs/PUBLIC_DEMO_JOBS.md`.
- Under `npm run dev` the UI double-runs each phase (React StrictMode); production does not.
- Keep `.env` out of anything you print: read variable names only.
