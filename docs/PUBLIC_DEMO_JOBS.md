# Public demo: visitors, tickets and the async job API

`PUBLIC_DEMO=true`. A third mode beside local (default) and `PUBLIC_MODE` (owner-only, Cloudflare Access;
[PUBLIC_DEMO_SECURITY.md](PUBLIC_DEMO_SECURITY.md)). The two public modes cannot be switched on together.
The backend and the browser side ([The frontend](#the-frontend)) are implemented and tested offline. **Staging:** the frontend is
deployed to Vercel (`https://qatool-staging.vercel.app`) and a browser Turnstile session through a Cloudflare Quick Tunnel has been
verified; a full real generation and export run through the browser is not yet confirmed, and no real model run has been measured
([STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md)).

Target: about ten visitors on their own devices run the real pipeline at once. The frontend is on Vercel,
this backend runs in Docker on the owner's PC behind a Cloudflare Tunnel, and Apayee stays on the private
Docker network. **No database:** every job, counter and replay record is in this process's memory and is
lost on restart, and clients are told so.

## What changes for a visitor

```text
Turnstile widget  ->  POST /api/session  ->  ticket (HS256, 30 min)         no cookies, no login
documents         ->  POST /api/jobs     ->  202 + job id                    parsed now, buffers freed
page polls        ->  GET  /api/jobs/:id ->  state, phase, queue position    renews the lease
page reads        ->  GET  /api/jobs/:id/result                              every phase so far
page cancels      ->  POST /api/jobs/:id/cancel
                      POST /api/export, POST /api/validate (no model)         unchanged, ticket required
```

One **job** is one workflow segment: its `from` phase and every phase after it
(`extract` → `generate` → `validate`), the server-side form of the browser's `runPipeline`. A workflow that
fails keeps the phases it finished; the page resubmits with `from` set to the phase that failed.

## Who may do what

- **No owner account.** There is no Cloudflare Access on the API host. Access remains available for a
  separate owner-only hostname (`PUBLIC_MODE`), never combined with this mode.
- **Turnstile → ticket.** `POST /api/session` verifies the widget's token with Cloudflare **server-side**
  (`challenges.cloudflare.com/turnstile/v0/siteverify`) and requires `success`, an allowed `hostname`, the
  configured `action`, and a `challenge_ts` that is recent and not in the future. It **fails closed**: a
  network error, a timeout, a non-2xx reply or malformed JSON is `503 CHALLENGE_UNAVAILABLE`, never a pass.
  Tokens are single use: a bounded in-memory set of token _hashes_ refuses a replay without another round
  trip; a token Cloudflare could not be asked about is not counted as spent.
- **The ticket** is HS256 signed with `TICKET_SECRET`, algorithm pinned, claims `sid` (128-bit random),
  `iss`, `aud`, `iat`, `exp`. `aud` is the frontend origin it was issued to and is compared with the request's
  `Origin` on every use. It is **not bound to a client address**: visitors share Wi-Fi and change networks.
  `Authorization: Bearer` only; there are no cookies and CORS credentials are off.
- **The `sid` is the only identity.** It is generated in `security/ticket.js`. No header, body field or
  query value is ever read as an identity. Rate limits are keyed on it, so ten visitors behind one address
  have ten independent allowances.
- **The address** is used for one thing: a loose backstop on ticket minting (`SESSION_MINT_PER_MINUTE_PER_IP`),
  from `CF-Connecting-IP` only when the socket peer is in `TRUSTED_PROXY_PEERS` (`security/network.js`),
  otherwise the peer itself.
- **Default deny.** Every route needs a ticket except `/healthz` and `POST /api/session`. Unknown paths are
  `401`, so the API cannot be mapped without one.

### Origin and CORS

Exact-origin allowlist (`ALLOWED_ORIGINS`), `Authorization` and `Content-Type` allowed, `Retry-After` and the
download headers exposed, credentials off. In this mode a request with a missing or unlisted `Origin` is `403`
on **every** method (owner mode only insists on one for POST). `/healthz` is exempt; `POST /api/session` is
public but browser-only. Preflight is answered without data. CORS and Origin are a courtesy to browsers, not a
lock: a script can send any `Origin`. What stops abuse is the ticket, the limits and the queue.

## The job API

All bodies are JSON unless noted; every reply is `Cache-Control: no-store`.

### `POST /api/session`

```http
{ "turnstile_token": "<token from the widget>" }
→ 200 { "ticket": "<jwt>", "expires_at": "2026-11-03T12:30:00.000Z",
        "limits": { "max_files": 30, "max_file_bytes": 10485760, "max_total_bytes": 20971520 },
        "poll_interval_ms": 2500 }
→ 400 TURNSTILE_FAILED · 429 RATE_LIMITED (+ Retry-After) · 503 CHALLENGE_UNAVAILABLE (+ Retry-After)
```

### `POST /api/jobs` (`Authorization: Bearer <ticket>`)

Documents: `multipart/form-data` with `project_name` and one or more `documents` files (starts at `extract`).
Resume: `application/json` `{ "from": "generate" | "validate", "canonical": {...}, "test_points": [...] }`.
A `provider` or `model` anywhere in the request is ignored; the model is fixed on the server.

```http
→ 202  Location: /api/jobs/j_Qp3…
       { "job": { "id": "j_Qp3…", "state": "queued", "from": "extract", "phase": null,
                  "phases": { "extract": "pending", "generate": "pending", "validate": "pending" },
                  "position": 4, "queue": { "capacity": 10 }, "paused": false,
                  "created_at": "…", "started_at": null, "updated_at": "…", "completed_at": null,
                  "elapsed_ms": 0, "queue_wait_ms": 0, "processing_ms": 0,
                  "poll_after_ms": 2500, "result_available": false, "cancel_reason": null,
                  "error": null, "boot_id": "b_91c…" } }
→ 409 JOB_ALREADY_ACTIVE   { "error": { …, "details": { "job_id": "j_Qp3…" } } }   one live job per ticket
→ 429 QUEUE_FULL (+ Retry-After)       workers + pending places are taken
→ 429 UPLOAD_BUSY (+ Retry-After: 2)   too many uploads being read at once; send again
→ 429 RATE_LIMITED (+ Retry-After)     this ticket's submissions per minute
→ 503 SERVICE_UNAVAILABLE | SERVICE_PAUSED | SERVICE_SHUTTING_DOWN   (+ Retry-After)
→ 413 TOO_MANY_FILES | FILE_TOO_LARGE | UPLOAD_TOO_LARGE
→ 422 EXTRACTION_FAILED | DOCUMENT_TOO_COMPLEX | NO_REQUIREMENTS …   documents unreadable: reported now
→ 400 BAD_REQUEST | VALIDATION_FAILED     malformed form, project name or resume body
```

**Admission happens before the body is read.** The submit limiter, the provider check and the reservation run
in `onRequest`; a refusal closes the connection (`Connection: close`) so the rest of an upload is never
buffered for a queue that is full. Only then are the documents read (under the upload limits), parsed
(on a worker thread, below), **the uploaded bytes dropped**, and the job queued holding the parsed blocks.
A reservation is given back on every failure path, including a connection that dies mid-upload.

### `GET /api/jobs/:id`

```http
→ 200 { "job": { "state": "processing", "phase": "generate",
                 "phases": { "extract": "done", "generate": "running", "validate": "pending" },
                 "position": null, "elapsed_ms": 41200, "queue_wait_ms": 1800, "processing_ms": 39400,
                 "poll_after_ms": 2500, "result_available": true, "error": null, "boot_id": "b_91c…", … } }
failed adds: "error": { "code": "LLM_UNAVAILABLE", "message": "…", "retryable": true, "phase": "generate" }
→ 404 JOB_NOT_FOUND     unknown, expired, malformed and someone else's: byte-identical
```

Renews the job's lease. `boot_id` changes when the backend restarts: a client that sees it change (or a 404
for a job it had) knows every job was lost and can resubmit; it still holds the files and the project.
Phase states: `pending`, `running`, `done`, `failed`, `cancelled`, `skipped` (before `from`), `not_run`.

### `GET /api/jobs/:id/result`

```http
→ 200 { "job": {…},
        "phases": { "extract":  { documents, requirements, test_points, criteria, structuring, warnings, metrics },
                    "generate": { project, test_cases, warnings, metadata },
                    "validate": { valid, schema_issues, reference_issues, semantic_warnings, semantic,
                                  coverage, testcase_diagnostics } } }
```

Each phase is exactly what the route it replaces returns, **without** `provider`, `model` or `usage`
(`jobs/public-result.js`). Only finished phases appear, so a failed job still shows its extraction.

### `POST /api/jobs/:id/cancel`

Idempotent. Queued: leaves the line. Processing: the job's `AbortController` fires, the gateway request is
closed (so Apayee cancels the call) and the state is `cancelled` at once; the worker is reused when the work has
actually stopped. A finished job is returned as it is.

## Lifecycle, capacity and time

```text
reserve → commit → queued → processing → completed | failed | cancelled
```

| Rule                 | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| Order                | FIFO                                                                                   |
| Accepted at once     | effective workers + `JOB_MAX_PENDING` (queued + processing + reservations)             |
| Live jobs per ticket | 1 (a reservation counts)                                                               |
| Lease                | 45 s from creation, renewed by `GET /api/jobs/:id` only                                |
| Expired, queued      | removed outright (the id is 404)                                                       |
| Expired, processing  | cancelled (`cancel_reason: "abandoned"`), model work aborted                           |
| Job deadline         | `JOB_DEADLINE_MS`, default 3 × `LLM_TIMEOUT_MS` + 2 min, **from when a worker starts** |
| Retention            | completed 15 min, failed/cancelled 5 min, at most 30 finished jobs                     |
| Cleanup              | one unref'd interval (1 s); never keeps the process alive                              |
| Shutdown             | stop admission, cancel the queue, abort what runs, wait up to 5 s                      |

Queue wait and processing time are recorded apart. Nothing is retried, anywhere. HTTP calls are all short; the
old 110-second whole-request deadline is not used here.

### Workers and the gateway

`JOB_WORKERS` defaults to **1**, may be 1–3, and is never raised automatically. It is a ceiling: the number of
jobs actually run at once is `min(JOB_WORKERS, max_active)`, where `max_active` is what Apayee's
`GET /v1/health` reports in its `queue` block (`active`, `max_active`, `pending`, `capacity`, and the older
`length`/`running` kept). The reason is concrete: a call that waits in the gateway's queue past
`LLM_TIMEOUT_MS + APAYEE_QUEUE_WAIT_MS` gives up, and a call that gives up is not retried.

| The gateway reports                                      | QATOOL does                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `max_active: N` (a positive whole number)                | runs up to `min(JOB_WORKERS, N)`; follows changes without restart |
| no `max_active` (an Apayee that predates it)             | assumes **1**                                                     |
| `max_active` present but `0`, negative, fractional, text | **incompatible**: starts nothing, refuses new jobs (503)          |
| not ready / offline / wrong provider / bad token         | refuses new jobs (503), starts nothing                            |

Capacity is read from the same cached health answer (5 s) the rest of the system uses, and refreshed by the
fresh check every job makes when a worker picks it up. Apayee keeps its own queue; this adds no second one.
**Nothing here changes Apayee or Compose, and nothing sets either service to concurrency 3.**

### The provider

Fixed on the server to catalog id `claude` (Claude through Apayee), acquired **once per job** (`jobs/runner.js`).
The catalog asks the gateway afresh and requires it to say its provider is exactly `claude`; there is no
fallback to anything else. `LLM_PROVIDER` does not matter in this mode. `APAYEE_TOKEN` stays in the backend.
The stages are handed a wrapper (`jobs/public-provider.js`) that reports a neutral name and turns any provider
failure into the fixed public sentence for its code, because structuring and the semantic review write the
failure message into results a visitor reads.

The routes that call a model directly are **not registered** in this mode (`/api/extract`, `/api/generate`),
`POST /api/validate?semantic=true` is `400 USE_JOBS`, and `/api/llm/providers` is absent: nothing can bypass the
workers.

### The provider breaker

When a call fails with Apayee's `PROVIDER_NOT_READY` or `PROVIDER_RATE_LIMITED`, or the gateway is found not
ready when a job starts, the breaker opens for `PROVIDER_BREAKER_COOLDOWN_MS` (60 s): that job fails (retryable,
with a fixed sentence), new submissions get `503 SERVICE_PAUSED` with `Retry-After`, and queued jobs **wait**
(`paused: true`) instead of each learning the same thing. It closes by itself. Nothing is retried. Note that
structuring and the semantic review absorb a provider failure by design, so the breaker usually trips on the
generation call.

## Limits

| What                           | Setting                                            | Demo default          | Why                                                     |
| ------------------------------ | -------------------------------------------------- | --------------------- | ------------------------------------------------------- |
| One file / all files           | `UPLOAD_MAX_FILE_BYTES` / `UPLOAD_MAX_TOTAL_BYTES` | 10 / 20 MiB           | memory                                                  |
| Files per upload               | `UPLOAD_MAX_FILES`                                 | 30                    | a technical ceiling, **not** a product rule (was 5)     |
| Uploads read or parsed at once | `UPLOAD_INFLIGHT_MAX`                              | 4                     | bounds buffered bytes across visitors                   |
| Parses at once                 | `PARSE_CONCURRENCY`                                | 1 (max 2)             | one worker thread at a time                             |
| Parse time / heap              | `PARSE_TIMEOUT_MS` / `PARSE_MAX_HEAP_MB`           | 20 s / 384            | a hostile document ends its own thread                  |
| Parsed text a job may hold     | `PARSED_TEXT_MAX_CHARS`                            | 2,000,000             | what a pending job keeps                                |
| PDF pages                      | `PDF_MAX_PAGES`                                    | 150                   | before the first page is read                           |
| ZIP entries / inflated bytes   | `ZIP_MAX_ENTRIES` / `ZIP_MAX_UNCOMPRESSED_BYTES`   | 2000 / 64 MiB         | on bytes actually produced                              |
| XLSX sheets / rows / cells     | `XLSX_MAX_SHEETS` / `_ROWS` / `_CELLS`             | 20 / 20,000 / 200,000 | counted as read, whole file                             |
| One inflated XML part          | `XML_PART_MAX_BYTES`                               | 16 MiB                | what the regex readers walk                             |
| Submissions per ticket         | `JOB_SUBMIT_PER_MINUTE`                            | 10                    | burst protection                                        |
| Polling per ticket             | `JOB_POLL_PER_MINUTE`                              | 60                    | a separate bucket; also covers validate, export, health |
| Ticket minting per address     | `SESSION_MINT_PER_MINUTE_PER_IP`                   | 30                    | a loose backstop only                                   |

**There is no request budget.** No hourly or daily count of model requests exists, `LLM_BUDGET_PER_*` are
ignored, and nothing replaced them. Polling and provider health checks are never counted as model usage; a
workflow is one submission, not three.

With the cap on uploads in flight at 4, ten visitors pressing the button in the same instant see `429
UPLOAD_BUSY` for some and must send again after `Retry-After` (2 s); the page should do that without bothering
the visitor. Measured below.

### Why documents are read on a thread of their own

The XLSX and DOCX readers walk XML with regular expressions, synchronously, on the thread that answers every
request. Measured on this machine (Node 22.15, in-thread):

| Input                                                    | Time on the main thread           |
| -------------------------------------------------------- | --------------------------------- |
| 20,000 × 10 spreadsheet (200,000 cells)                  | 332 ms                            |
| 6,000-paragraph DOCX                                     | 20 ms                             |
| the two sanitised PDFs                                   | 168–212 ms (≤ 78 ms at a stretch) |
| 256 KiB of unclosed `<w:p>` (a few hundred bytes zipped) | **4.3 s**                         |
| 128 KiB / 64 KiB of the same                             | 1.1 s / 0.27 s (quadratic)        |
| 256 KiB of unclosed `<row r="1">`                        | 1.3 s                             |

The last rows are a denial of service no size ceiling can fix: the cost quadruples when the size doubles, an XML
part may be megabytes, and a synchronous call cannot be stopped from inside. So in this mode a parse runs in a
fresh `worker_thread` (`extract/isolated.js`) with a time limit (the thread is terminated, which interrupts the
regular expression), a heap limit, and the visitor's departure; the worker runs the same `parseDocuments` with
the same limits, so results are identical (tested). With a 4 MiB hostile DOCX the thread ended at the 2 s limit
and the main thread was never more than 29 ms late. Local mode keeps parsing in-thread, unchanged.

### Measured: ten visitors at once

Real HTTP, real tickets, real job manager and runner, fake Turnstile, a model that takes 400 ms per call;
five DOCX and five PDF uploads submitted in the same instant:

|                            | 3 workers (gateway `max_active` 3)       | 1 worker      |
| -------------------------- | ---------------------------------------- | ------------- |
| all ten admitted           | 2.5 s (uploads are parsed one at a time) | 2.4 s         |
| all ten finished           | 5.1 s                                    | 12.6 s        |
| queue wait, median / max   | 0.4 s / 1.4 s                            | 4.9 s / 9.0 s |
| model calls / peak at once | 30 / 3                                   | 30 / 1        |
| main-thread worst lag      | 38 ms                                    | 32 ms         |

`UPLOAD_BUSY` was retried by the simulated clients (25 ms spin; a browser waits `Retry-After`).
These are a fake model's numbers: a real Claude call takes far longer, and **real run time, Claude CLI memory
under three parallel calls, and whether three CLI processes can share one login are unmeasured** (no real call
was made).

## The frontend

`web/src/`, built with `VITE_PUBLIC_DEMO=true`. Without it the same code is the local tool, unchanged (the model picker, relative
`/api/...` calls through the Vite proxy). Implemented and tested offline; deployed to staging (see the status note at the top of this file).

### Build-time settings

Every `VITE_` value is copied into the JavaScript anyone can download. They are public by design, and **no secret ever gets one**
(a test builds the bundle with secret-looking values in the environment and fails if any appears). See `web/.env.example`.

| Variable                  | Meaning                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `VITE_PUBLIC_DEMO`        | `true` builds the public demo. Anything else is the local tool                                                 |
| `VITE_API_BASE_URL`       | The API's origin, e.g. `https://api.example.com` (https unless localhost; origin only). Empty keeps `/api/...` |
| `VITE_TURNSTILE_SITE_KEY` | The widget's public site key. The secret key stays on the backend as `TURNSTILE_SECRET`                        |
| `VITE_TURNSTILE_ACTION`   | Optional; must equal the backend's `TURNSTILE_ACTION` (default `qatool_demo`) or verification fails            |

A demo build missing its site key, or with an invalid API origin, shows what is missing instead of starting a session.

### Session

The page draws the Turnstile widget, sends its token to `POST /api/session` and keeps the returned ticket **in one in-memory
variable** (`session/ticket-store.js`): no localStorage, sessionStorage, cookie, IndexedDB or `credentials` option anywhere (tested
by trapping those APIs and by scanning the source). Every other call carries `Authorization: Bearer <ticket>`. One mint at a time,
none while a session is usable; polling and navigation never mint. At expiry, or on a 401, the ticket is dropped and the widget
is rebuilt (a Turnstile token is single use), so a fresh verification is required. Nothing assumes the visitor's address.
A **reload loses the session**; the page says so, and says that a job started before the reload cannot be reattached and stops by
itself when its 45 s lease runs out.

### Jobs

`api.js` is the only file that builds URLs or attaches the ticket. `jobs/run.js` submits (`POST /api/jobs`: multipart for extract,
JSON `{from, canonical, test_points}` to resume), polls (`GET /api/jobs/:id`), reads `GET /api/jobs/:id/result` **once the job has
ended** (partial results included after a failure or cancellation) and applies each finished phase through the same callbacks and
`mergeCanonical` the local runner uses. A semantic re-review is a job `from: "validate"`. No provider or model is ever sent, and the
demo never asks which models exist.

| Rule                                                | Behaviour                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Poll interval                                       | `poll_after_ms` clamped to 1-10 s (default 2.5 s); one loop per job; a tab returning to the foreground polls at once                                                                             |
| Lease                                               | A silence over 30 s between answered polls is shown to the visitor; a job gone after a long silence is reported as "stopped for inactivity"                                                      |
| Navigation                                          | Leaving the page area never cancels. Only the Cancel button calls `POST /api/jobs/:id/cancel`                                                                                                    |
| `UPLOAD_BUSY`                                       | Retried automatically, at most 4 attempts, waiting `Retry-After` (1-10 s), with a **new** `FormData` each time (safe: refused before the body is read)                                           |
| `QUEUE_FULL`, `SERVICE_PAUSED`, `RATE_LIMITED`, 503 | Not retried by itself. The input is kept and the Try again button counts down `Retry-After`                                                                                                      |
| Network failure on submit                           | Never resent by itself ("ambiguous"). "Check and try again" resubmits; if the server already has the job, `JOB_ALREADY_ACTIVE` hands it back and the page follows it instead of starting another |
| Failed poll                                         | Retried up to 5 times with backoff (a read), then "Reconnect to the job" follows the same job id                                                                                                 |
| `401`                                               | Session ended: verify again. The old job cannot be reattached (new session, new `sid`)                                                                                                           |
| `403`                                               | The site's origin is not in `ALLOWED_ORIGINS`: a configuration problem, not retried                                                                                                              |
| `404`                                               | "Lost": expired or the server restarted (a 404 carries no `boot_id`). A changed `boot_id` on the next accepted job is reported as a restart                                                      |
| `cancel_reason: "shutdown"`                         | The server cancelled the job because it is restarting. **Shown as a failure with restart guidance, never as the visitor's cancellation**; the step can be started again after a short wait       |
| `cancel_reason: "abandoned"`                        | Shown as the inactivity message (keep the tab in the foreground)                                                                                                                                 |

Job state is shown from the backend's own fields: queue position and `paused` while queued, the current phase while processing,
elapsed and queue time. There is no percentage because the backend gives none. Results carry no `provider`, `model` or review
error message; the Results page says an AI drafted them and words a failed review from its code.

### Before upload

The upload page states that documents are sent to the QATOOL demo server, that text taken from them goes to the AI service the
server is configured with (no provider is named), that jobs and results are held in the server's memory for minutes and lost on a
restart, and that there is no database. It also checks files against the limits the session announced before sending anything.

### What a deployment needs

The full runbook (architecture, Vercel and Cloudflare settings, the Windows operating guide, checklist and rollback) is
[STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md); this is the short list.

- **Vercel:** build variables `VITE_PUBLIC_DEMO=true`, `VITE_API_BASE_URL`, `VITE_TURNSTILE_SITE_KEY` (and `VITE_TURNSTILE_ACTION` if changed).
- **Backend:** `ALLOWED_ORIGINS` containing the exact Vercel origin; `TICKET_SECRET`, `TURNSTILE_SECRET`, `TURNSTILE_HOSTNAMES` (the Vercel
  hostname must also be allowed on the widget), `TRUSTED_PROXY_PEERS`.
- **Cloudflare:** a tunnel to the backend only (staging uses a free Quick Tunnel whose address changes on every restart, so
  `VITE_API_BASE_URL` must be updated and the page redeployed each time), and whatever WAF rules the owner wants (a Quick Tunnel
  cannot use zone rules; a named tunnel on an owned domain can).

### Frontend limits

- Browsers can slow timers in a hidden tab to once a minute, beyond the 45 s lease. The page cannot prevent that; it reports the
  silence and polls the moment the tab is visible again.
- A reload loses the ticket and the page's data (documents, results); nothing is stored to recover them.
- Verified against the real backend app in-process (fake Turnstile, fake model); never against a real model, Cloudflare or Vercel.

## Metrics (internal, no route)

`app.jobPlatform.metrics.snapshot()` returns plain numbers for a future owner-only dashboard: active sessions
in the last 2 minutes; tickets minted and failures by kind; jobs queued/processing/completed/failed/cancelled
(current and totals, cancellations by reason); configured, effective and busy workers and utilization; queue
wait and processing time as count/p50/p95/max over the last 200; rejections by reason; errors by code and
breaker trips; Apayee `active`/`max_active`/`pending`/`capacity` as last reported; uploads and parses in
flight; process RSS, heap and event-loop delay (excess over the sampling interval). **No route serves it**; it
describes every visitor, so a future dashboard belongs behind the owner-only Access hostname, never behind a
ticket. It holds no name, filename, document or session id (tested).

## Configuration

Required with `PUBLIC_DEMO=true` (startup refuses, naming the variable, never the value): `TICKET_SECRET`
(≥ 32 random characters), `TURNSTILE_SECRET`, `TURNSTILE_HOSTNAMES`, `ALLOWED_ORIGINS`. Everything else is in
`.env.example` with its default. Malformed values are startup errors.

## Verification

Offline only, no model, no Cloudflare, no Apayee. New suites: `security/{limiter,ticket,turnstile}.test.js`,
`security/uploads.form.test.js`, `jobs/{manager,jobs.api,jobs.flow,simulation,modes,metrics}.test.js`,
`extract/{isolated,ceilings}.test.js`, `pipeline/merge.test.js`, `llm/apayee.capacity.test.js`; and on the frontend
`web/src/{config,api.demo,bundle,useProviders}.test.js`, `session/session.test.js`, `jobs/{run,failure}.test.js`,
`components/demo.ui.test.js`. Whole-repository baseline: **2,009 tests, 1,998 pass, 0 fail, 0 cancelled, 1 skipped, 10 todo**
(2026-11-03). Covered:
ticket signature, pinned algorithm, issuer, audience, expiry, tampering; Turnstile failure, replay (including
concurrent), wrong hostname/action, stale, unavailable; the CORS and Origin matrix; ownership across ten
tickets; one live job; ten simultaneous submissions; 3 processing + 7 pending and all ten completing; overflow
at workers + pending; FIFO and positions; cancellation queued and processing; lease expiry; partial results and
resume; restart (`boot_id`); graceful shutdown; poll flood vs submit limits; the breaker; workers never above the
gateway's `max_active`; the multipart, ZIP, PDF, XLSX and DOCX limits; cancellation and timeout reaching the
gateway; sanitised errors and metadata-only logs; no direct model route; local and owner modes unchanged.

## Remaining risks

- **Real model behaviour is unmeasured** (run time, memory, parallel logins). `JOB_WORKERS` stays 1 until it is.
- **In-memory state** is lost on restart and not shared; a stolen ticket is a valid visitor for its life (30 min).
- **A determined attacker with a Turnstile-solving service** can mint tickets; the global capacity (workers +
  pending), one live job per ticket and the mint backstop bound the damage to filling the queue.
- **Policy:** serving other people from a Claude subscription is, per Apayee's own documentation, of unconfirmed
  status with Anthropic. That is the owner's decision and risk; nothing here changes it.
- **Local mode** still parses in-thread, where the quadratic inputs above apply to the person running it.
- **A real end-to-end run is not yet confirmed:** the deployed frontend has passed a Turnstile session, but no complete real
  generation and export through the browser has been recorded; see [The frontend](#the-frontend).
- **The staging host is a PC:** if it sleeps, reboots, or the tunnel restarts, the demo is unreachable until the stack, a new tunnel and
  a redeploy are done (the Vercel page itself stays up).
