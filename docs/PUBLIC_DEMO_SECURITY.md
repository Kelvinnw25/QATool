# Public-mode security (backend hardening, P1)

How the QATOOL backend protects itself when it sits behind a Cloudflare Tunnel for a public portfolio
demo. This covers the **owner-only backend mode and Compose**. The visitor-facing public demo (Turnstile
tickets, async jobs and its frontend) is implemented and described in [PUBLIC_DEMO_JOBS.md](PUBLIC_DEMO_JOBS.md).
The Vercel deployment and the tunnel itself are not set up yet (nothing is deployed);
[what they must provide](#what-the-infrastructure-must-provide) is listed below.

> **The rule this enforces:** the public can look at the frontend. Only the owner can reach the live
> backend, and only the owner can spend the personal Claude subscription behind Apayee.

## Contents

1. [What changed, in one view](#what-changed-in-one-view)
2. [Request pipeline](#request-pipeline)
3. [Authentication](#authentication)
4. [Origin and CORS](#origin-and-cors)
5. [Model providers](#model-providers)
6. [Resource limits](#resource-limits)
7. [Timeouts and Cloudflare](#timeouts-and-cloudflare)
8. [Errors and logs](#errors-and-logs)
9. [Docker Compose](#docker-compose)
10. [Configuration reference](#configuration-reference)
11. [What the infrastructure must provide](#what-the-infrastructure-must-provide)
12. [Verification](#verification)
13. [Remaining risks and limits](#remaining-risks-and-limits)

## What changed, in one view

`PUBLIC_MODE` is **off by default**, so `npm run dev` and the plain Docker setup behave as before. Two
protections are always on because the audit measured them as exploitable regardless of mode.

| Audit finding                                               | Control                                                                                      | Where                               | Mode                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| F1 No authentication; `?provider=claude` open to any caller | Cloudflare Access JWT on every route, owner email allowlist, default deny                    | `server/security/access.js`         | public                          |
| F1 Provider choice                                          | Explicit choice needs the verified owner; implicit default may not be Apayee                 | `provider-policy.js`, `settings.js` | public                          |
| F2 No rate, concurrency or budget limits                    | Per-identity rate; one model call at a time, bounded queue. There is no model request budget | `server/security/gate.js`           | public (opt-in locally)         |
| F3 ZIP expansion (DOCX/XLSX)                                | Streaming unzip that counts bytes actually produced                                          | `server/extract/zip.js`             | **always**                      |
| F4 Multipart total unbounded                                | File count, per-file and **total** size enforced while streaming                             | `server/security/uploads.js`        | **always** (stricter in public) |
| F5 PDF without a page cap                                   | Page cap checked before any page is read                                                     | `server/extract/parsers/pdf.js`     | **always**                      |
| F6 No Origin check (CSRF)                                   | Exact origin allowlist; state-changing request without Origin refused                        | `server/security/origin.js`         | public                          |
| F7 Provider state visible                                   | Provider list reduced to "available / not available right now"                               | `routes/llm.js`, `public-errors.js` | public                          |
| F8 Timeouts vs Cloudflare                                   | Request deadline below Cloudflare's read timeout, startup-enforced                           | `settings.js`, `gate.js`            | public                          |
| F9 Internals in errors                                      | Provider, parser and framework messages replaced; addresses/paths scrubbed                   | `public-errors.js`                  | public                          |
| F10 Logs lacked identity                                    | Request id, route, status, duration, identity label, peer/client address                     | `access.js`, `app.js`               | public                          |
| F11 Docker hygiene                                          | Apayee not published; capabilities dropped; resource ceilings                                | `compose.yaml`                      | Compose                         |

## Request pipeline

Every control that decides _whether_ a request is served runs in `onRequest`: before the body is
parsed, before a provider is chosen, before a document is read. An unauthorised request costs one
header check and never reaches Apayee.

```text
0. start the run          request id, timing, summary line            (app.js)
1. CORS                   headers for an allowed origin; answers a preflight
2. origin policy          public: unlisted Origin, or a POST with none -> 403
3. Cloudflare Access      public: valid owner JWT or 401/403/503; /healthz is the only exception
4. request rate           per identity, whole API
   ---- the route ----
   provider check         an explicit ?provider= needs the verified owner (defence in depth)
   upload reading         count, per-file and total size, while streaming
   model gate             one model call at a time, bounded queue, whole-request deadline
```

Steps 1 to 4 are registered after step 0 and before the routes (`server/security/index.js`, called from
`buildApp`). **Order matters and is tested:** hooks run in the order they were added, so registering
security earlier would run it before the run exists (no request id in the log).

## Authentication

Cloudflare Access authenticates the owner at the edge and adds a signed JWT in
`Cf-Access-Jwt-Assertion`. The backend does not trust that header because it is present; it verifies it,
because a request can reach the backend without passing the edge (a local process, a misrouted tunnel).

- **Library:** [`jose`](https://github.com/panva/jose). No cryptography is written in this repository.
- **Checks:** RS256 only (`none`, HS256 and every other algorithm are refused); issuer
  `https://<ACCESS_TEAM_DOMAIN>`; audience `ACCESS_AUD`; `exp` and `email` must be present; 5 s clock
  tolerance. A service token has no email and is refused: the API is for the owner, not automation.
- **Owner list:** the email must equal one in `OWNER_EMAILS`, compared exactly after lower-casing both.
  Access policy is the first gate and this list the second, so a wider Access policy cannot widen API access.
- **Keys:** Cloudflare's published set at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  cached in memory by `jose` (10 minutes), re-fetched when a token names an unknown key (at most every
  30 s). Nothing is written to disk. **Fails closed:** if the keys cannot be fetched the answer is `503`,
  never "let it through".
- **Default deny:** every request needs a token unless its route is marked public in code. Only
  `/healthz` is. Unknown paths and `/` also answer `401`, so the API cannot be mapped without a token.
  The decision uses the matched route, not the URL text, so a path trick cannot reach a route the check
  did not name.
- **One answer:** every `401` has the same body whatever was wrong (expired, wrong audience, bad
  signature, unknown key...). The reason goes to the log only, as a label such as `expired`.
- **Not trusted:** the `CF_Authorization` cookie, `Cf-Access-Authenticated-User-Email`, and any other
  identity header. Only the JWT header is read.
- **Liveness:** `GET /healthz` returns `{"status":"ok"}` and nothing else, calls nothing, needs no
  credentials. Docker uses it. `/api/health` and `/api/llm/providers` need the owner's token.

## Origin and CORS

CORS is a browser courtesy, not authentication. It decides whether a page from another origin may _read_
a reply; it does not stop a request being sent and identifies nobody. Authentication is above. This layer
keeps a page the owner did not choose from riding the owner's session.

- **Exact allowlist** (`ALLOWED_ORIGINS`): an origin is allowed only if its text equals an entry. No
  wildcard (refused at startup), no suffix or prefix match, no reflection, `null` never allowed.
  Credentials are enabled for those origins only. The download headers the page needs
  (`Content-Disposition`, `X-QATOOL-Row-Count`, `X-QATOOL-Export-Warnings`, `Retry-After`) are exposed.
- **CSRF guard (public mode):** an `Origin` that is not listed is refused (`403`), and so is a
  state-changing request (`POST`...) with **no** `Origin`. This matters because the upload route takes
  `multipart/form-data`, which a cross-site form can post without a preflight. Side effect: curl and
  scripts cannot `POST` to a public-mode backend. That is intended; the live API is for the owner's browser.
- **Preflight (`OPTIONS`):** answered without a token (a preflight carries no credentials by design) and
  without data: `204` with CORS headers for an allowed origin, nothing for any other. No route answers
  `OPTIONS` with content.
- **Refusals stay readable:** CORS runs before the checks, so an allowed page can read a `401` and show a
  message instead of an opaque network error.

**Compatibility with Cloudflare Access preflight handling.** Access blocks a preflight with `403` by
design, because browsers send no cookies with it. Either of Cloudflare's two documented remedies works
with this backend:

1. _Bypass OPTIONS requests to origin_ (Access app setting): the preflight reaches the backend, which
   answers it as above. Access's own JWT check still applies to every real request.
2. Configure the allowed origin, credentials, methods and headers in the Access app's CORS settings so
   Cloudflare answers the preflight itself; the backend then sees only real requests.

Either way, the real request must still carry a valid Access session. Match the values to
`compose`/`.env`: methods `GET, POST, OPTIONS`; headers `Content-Type`; credentials on.

## Model providers

- **Claude and Apayee are owner-only, enforced on the server.** Every route needs the owner token; in
  addition `assertProviderAccess()` refuses an explicit `?provider=` from anyone but the verified owner
  _before_ Apayee is asked anything.
- **No implicit default.** In public mode the server refuses to start if `LLM_PROVIDER` is `apayee` (or
  `claude`), so a request that names no provider can never reach the subscription. `gemini` and `mock`
  are accepted. The owner still picks Claude per run (`?provider=claude`).
- **Unchanged:** per-run consistency (the UI freezes the choice), the provider allowlist (the raw
  registry name `apayee` is a `400`), the availability check before the stage, **no fallback to another
  provider**, Apayee's error mapping and its no-retry behaviour.
- **Not relayed publicly:** `/api/llm/providers` returns only `available` plus one of two phrases
  ("Not configured on the server." / "Not available right now."). Offline, rejecting credentials and
  running-the-mock-provider all look the same. The full reasons remain in local mode.

## Resource limits

All limits are environment variables; public mode is stricter. Values are bytes unless stated.

| Limit                                  | Variable                             | Public     | Local                     | Enforced                      |
| -------------------------------------- | ------------------------------------ | ---------- | ------------------------- | ----------------------------- |
| Files per upload (a technical ceiling) | `UPLOAD_MAX_FILES`                   | 30         | 20                        | while streaming               |
| One file                               | `UPLOAD_MAX_FILE_BYTES`              | 10 MiB     | `MAX_BODY_BYTES` (25 MiB) | while streaming               |
| All files together                     | `UPLOAD_MAX_TOTAL_BYTES`             | 20 MiB     | 100 MiB                   | while streaming               |
| ZIP entries (DOCX/XLSX)                | `ZIP_MAX_ENTRIES`                    | 2000       | 2000                      | on discovery                  |
| ZIP inflated bytes                     | `ZIP_MAX_UNCOMPRESSED_BYTES`         | 64 MiB     | 64 MiB                    | on bytes actually produced    |
| PDF pages                              | `PDF_MAX_PAGES`                      | 150        | 300                       | before the first page is read |
| JSON body (generate, validate, export) | `JSON_BODY_MAX_BYTES`                | 5 MiB      | `MAX_BODY_BYTES`          | by Fastify                    |
| Time to receive a request              | `REQUEST_TIMEOUT_MS`                 | 90 000     | Node default              | by Node                       |
| Concurrent model calls                 | `LLM_MAX_CONCURRENT`                 | 1          | none                      | gate                          |
| Queue behind them                      | `LLM_QUEUE_MAX`, `LLM_QUEUE_WAIT_MS` | 2, 20 s    | 2, 20 s                   | gate                          |
| Whole-request deadline                 | `REQUEST_DEADLINE_MS`                | 110 000 ms | none                      | gate                          |
| Requests per minute                    | `RATE_LIMIT_PER_MINUTE`              | 120        | none                      | per identity                  |

`0` means "no limit" for the gate's values. A malformed value (`UPLOAD_MAX_FILES=ten`, `PUBLIC_MODE=yes`)
is a **startup error**, never a silent default.

**Uploads.** The earlier route read each file with `toBuffer()`, which caps one file but lets twenty
through: the audit measured 60 MB accepted under a 25 MB `bodyLimit`. Now each chunk is counted as it
arrives and the first limit crossed ends the read, so an oversized request costs about one chunk beyond
the limit. A declared `Content-Length` far over the total is refused before any byte is read. Errors are
stable and all `413`: `TOO_MANY_FILES`, `FILE_TOO_LARGE`, `UPLOAD_TOO_LARGE`. After a refusal the connection
is closed so the rest of the upload is not read for nothing.

**ZIP.** `unzipSync` sized its output from numbers the archive declares about itself and inflated every
entry fully; the audit measured 0.2 MB becoming 200 MB (about 1000:1) while blocking the event loop.
`safeUnzip()` streams the compressed input in 4 KiB steps, so the output can overshoot a limit by only a
few megabytes before it is stopped, and counts bytes _produced_, never declared. Tested against: a 200 MB
bomb, a header that lies about its size, many entries, an archive cut off mid-entry, and a streamed archive
with data descriptors (as Java writes). It returns exactly what `unzipSync` returned (checked byte for byte
against the Excel-made template). Export-side reads of the server's own template are unchanged.

**Concurrency and rate.** One model call runs at a time; up to two wait up to 20 s; the next is
refused at once with `429 SERVER_BUSY`. A client that disconnects while queued leaves the queue. There is
**no request budget**: an hourly and a daily count of model requests existed in the first version of this
mode and were removed; `LLM_BUDGET_PER_*` are ignored. The only quota on a model is the provider's own.
Every `429` carries `Retry-After`. Nothing is ever retried automatically.

## Timeouts and Cloudflare

| Layer                         | Limit                                                                         | Source                |
| ----------------------------- | ----------------------------------------------------------------------------- | --------------------- |
| Cloudflare proxy read timeout | 125 s (error 524) on non-Enterprise plans                                     | Cloudflare docs       |
| QATOOL request deadline       | 110 s default, **must be ≤ 115 s in public mode** (startup refuses otherwise) | `REQUEST_DEADLINE_MS` |
| One model call                | `LLM_TIMEOUT_MS` (120 s by default)                                           | `.env`                |
| Apayee queue wait             | `APAYEE_QUEUE_WAIT_MS` (60 s)                                                 | `.env`                |

The deadline counts from the start of the request, so upload time and queue wait use it up. When it fires
the model call is aborted (through the same signal a client disconnect uses), the backend answers
`504 REQUEST_DEADLINE_EXCEEDED`, and it does so _before_ Cloudflare would give up, instead of carrying on
with a paid call nobody is waiting for. Because one model call may legitimately take longer than 110 s,
**set `LLM_TIMEOUT_MS` at or below `REQUEST_DEADLINE_MS`**; the server logs a warning at startup if not.
A semantic review that runs out of time ends the same way (`504`), not as the soft stage-3 failure a
provider error would be: the deadline is the request's, and the request is over. The page keeps its
project and can retry.

## Errors and logs

**Public replies** carry text written for a network, not an error's own message:

- provider failures are described by kind (`LLM_UNAVAILABLE` → "The model provider is temporarily
  unavailable. Retry later.") and never name Apayee, its address, a setting or the Claude CLI;
- extraction failures keep `details[].filename` (sanitised data the page uses to point at the right file)
  but the **text** no longer repeats it;
- the framework's own 4xx errors lose their text, because a JSON syntax error can quote the body;
- any other message has web addresses and file paths cut out as a last resort.

Outside public mode every message is unchanged.

**Logs** are metadata only, as before (`server/lib/trace.js` drops any field that could carry content).
Added: the request id on every line; for authenticated requests a short **identity label**
(`sha256(email)[0:12]`, never the address); `peer_ip` (the socket address) and `client_ip`
(`CF-Connecting-IP` **only if the peer is listed in `TRUSTED_PROXY_PEERS`**, otherwise the socket address);
for refusals a reason label (`missing_token`, `expired`, `wrong_audience`, `origin_not_allowed`...). Never
logged: tokens, the owner's email, upload filenames, document text, prompts, replies, schemas.
`X-Forwarded-For` is never read.

Headers on every reply: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; `Cache-Control:
no-store` for the API (everything, in public mode); and in public mode `Content-Security-Policy: default-src
'none'; frame-ancestors 'none'` and `X-Frame-Options: DENY`. HSTS is left to Cloudflare, which terminates TLS.

**Choosing `TRUSTED_PROXY_PEERS`.** Measured on Docker Desktop (WSL2) with this Compose file: a client on
the Windows host connecting to `127.0.0.1:3001` appears to the container as **`172.18.0.1`**, the Compose
network's gateway. That is where `cloudflared`, running on the host, will appear, so
`TRUSTED_PROXY_PEERS=172.18.0.1`. Confirm it from the `peer_ip` field of a real request, and re-check
after recreating the network (the subnet can change). Understand what it buys: _every_ process on the PC
appears as that address, so a local process could set `CF-Connecting-IP` to anything. It affects log lines
only. Access is decided by the JWT, never by an address.

## Docker Compose

The three-service architecture, the `apayee-claude-config` volume and the published backend and frontend
ports are unchanged. Changes (see `compose.yaml`):

| Change               | Detail                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Apayee not published | No host port 4100. `qatool-backend` still reaches `http://apayee:4100`; 4101 was never published. Checked from the host: both closed |
| Capabilities         | `cap_drop: [ALL]` and `no-new-privileges` on all three. Verified: Apayee, the Claude CLI and the volume work                         |
| Ceilings             | Apayee 2 GiB / 2 CPU / 512 PIDs; backend 1 GiB / 1.5 CPU / 256 PIDs; frontend 512 MiB / 1 CPU / 256 PIDs                             |
| Health               | The backend image checks `/healthz`, which needs no token, so public mode does not mark it unhealthy                                 |

The ceilings are starting points. The backend's were sized from measured parsing (the fixture PDFs peak
near 130 MB; a worst-case 64 MiB inflate holds about twice that briefly). **Apayee's were not load-tested**
because that needs model calls; if it is ever `OOMKilled`, raise `mem_limit`.

The Vite dev server in `qatool-frontend` is for local work. **Never expose it through the tunnel.** In the
target architecture the public frontend is a static build on Vercel and this container is not part of the
public path.

## Configuration reference

Names only; see `.env.example` for defaults and comments. Values are never committed.

| Variable                                                              | Purpose                                                                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_MODE`                                                         | `true` turns the controls on and makes the next four required. `false`/unset: local behaviour                                    |
| `ACCESS_TEAM_DOMAIN`                                                  | Access team domain, `<team>.cloudflareaccess.com` (anything else is refused, which also prevents pointing key fetches elsewhere) |
| `ACCESS_AUD`                                                          | Audience tag of the Access application                                                                                           |
| `OWNER_EMAILS`                                                        | Comma-separated owner accounts                                                                                                   |
| `ALLOWED_ORIGINS`                                                     | Comma-separated exact origins of the public frontend (`https://` unless localhost)                                               |
| `TRUSTED_PROXY_PEERS`                                                 | Addresses or CIDR ranges whose `CF-Connecting-IP` is believed, for logs                                                          |
| `UPLOAD_MAX_FILES`, `UPLOAD_MAX_FILE_BYTES`, `UPLOAD_MAX_TOTAL_BYTES` | Upload limits                                                                                                                    |
| `ZIP_MAX_ENTRIES`, `ZIP_MAX_UNCOMPRESSED_BYTES`, `PDF_MAX_PAGES`      | Document limits                                                                                                                  |
| `JSON_BODY_MAX_BYTES`, `REQUEST_TIMEOUT_MS`                           | Request limits                                                                                                                   |
| `LLM_MAX_CONCURRENT`, `LLM_QUEUE_MAX`, `LLM_QUEUE_WAIT_MS`            | Model concurrency                                                                                                                |
| `REQUEST_DEADLINE_MS`, `RATE_LIMIT_PER_MINUTE`                        | Deadline and rate                                                                                                                |

The four required values are checked at startup. A refusal prints the missing **names** and exits with
code 1; it never prints a value. `LLM_PROVIDER=apayee`, a missing deadline, a deadline over 115 s, a
wildcard origin, a non-`https` public origin and malformed numbers are refused the same way.

## What the infrastructure must provide

Not part of this work; the backend assumes them.

1. **Cloudflare Access** in front of the tunnel hostname, with a policy allowing only the owner, a short
   session, and the application's audience tag copied into `ACCESS_AUD`.
2. **A tunnel with one ingress rule** for the backend only (`http://localhost:3001`) and a final
   `http_status:404`. Nothing maps to 4100, 4101 or 5173.
3. **A same-site frontend hostname** (for example `demo.<domain>` and `api.<domain>`) so the Access cookie
   is first-party. Cloudflare's docs describe the cookie as scoped per domain and warn about third-party
   cookies; this is inferred, not tested here.
4. **Preflight handling** as described under [Origin and CORS](#origin-and-cors).
5. **The frontend** sends `credentials: 'include'` to the API host, shows a clear message when the backend
   is offline or the session is missing, and never holds a secret in a `VITE_` variable. **No frontend for
   this owner-only mode exists:** the frontend that was built (`VITE_PUBLIC_DEMO=true`) serves the visitor demo
   (`PUBLIC_DEMO`), which uses a bearer ticket and no cookies or credentials. The owner-only mode is exercised
   with the Access cookie from a browser on the owner's own hostname, or not at all, until that is built.

## Verification

Test baseline at the time of writing (2026-11-03, whole repository including the public demo backend and
frontend): 1,978 tests, 1,967 pass, 0 fail, 0 cancelled, 1 skipped, 10 todo.

Offline only: no real model, no network, no tunnel (the suite's network guard refuses anything but
loopback). The fake gateway records every request, so "never reached Apayee" is a count, not a claim.

| Area                 | Tests                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access JWT           | valid; wrong audience, issuer; expired; not yet valid; wrong key; unknown `kid`; `alg: none`; HS256; no email; garbage and oversize tokens; non-owner; case and look-alike emails; cookie and identity headers ignored; keys unreachable → 503                            |
| Origin / CORS        | allowed, unlisted, look-alike, `null`, empty; POST without Origin; preflight allowed and denied; bare OPTIONS; refusals readable by the allowed page                                                                                                                      |
| Provider policy      | owner can choose Claude; unavailable Claude → coarse 503 and no fallback (Gemini fetch spied); raw `apayee` is a 400; provider list identical across three gateway states; non-owner refused                                                                              |
| Never reaches Apayee | every model route unauthenticated; wrong origin; non-owner; contrasted with the owner reaching it once                                                                                                                                                                    |
| Uploads              | count, per file, total, early `Content-Length`, stops reading on the first limit, closes the connection, never before authentication                                                                                                                                      |
| ZIP / PDF            | bomb, lying header, many entries, truncated, streamed archive; byte-for-byte parity with `unzipSync`; PDF page cap at and over the limit                                                                                                                                  |
| Gate                 | rate, no budget of any kind (hundreds of model requests over days are never refused for their count), queue order, queue full, wait limit, disconnect while queued, slot released on failure, deadline (including time already spent), client departure outranks deadline |
| Errors / logs        | provider text hidden, filename masked, framework text hidden; logs contain the identity label, run id and client address rules, and none of the token, email, filename or gateway token                                                                                   |
| Settings             | defaults per mode, every required value, exact origins, provider default, deadline bounds, malformed values                                                                                                                                                               |
| Unchanged            | local mode needs no token or origin and sends no CORS headers; existing statelessness and cancellation tests pass                                                                                                                                                         |

Run: `npm test`. Focused: `node --import ./server/testing/no-network.js --test "server/security/**/*.test.js" server/extract/zip.test.js`.

Also checked on a real process (throwaway fake configuration, a spare port, no `.env`, no token sent):
public mode refuses to start without its settings, with `LLM_PROVIDER=apayee`, and with `PUBLIC_MODE=yes`
(exit 1); once configured it serves `/healthz` and answers `401` to everything else and `403` to a POST
without Origin.

## Remaining risks and limits

- **Counters are in memory.** The rate and the queue reset when the backend restarts and are not
  shared between processes. They stop a runaway page or a leaked session from burning a quota in minutes;
  they are **not** a durable spending control. The providers' own limits and the account's settings are.
- **Flooding.** Cloudflare absorbs unauthenticated traffic at the edge. A request that does reach the
  backend without a token costs one header check, and there is no per-address limiter for it. If the
  backend is ever reachable without passing Access, add one.
- **A stolen owner session** is a valid owner. The mitigations are Access's session length and policy,
  the rate limit, and the log. The Origin guard stops other sites from using the session in the owner's
  browser; it cannot stop malware on the owner's PC.
- **Local processes** on the PC can reach `127.0.0.1:3001` without Access, but still need a valid JWT
  signed by Cloudflare's key, which they cannot forge.
- **Apayee limits** are untested under load. The Claude CLI's memory use under a long generation is
  unmeasured.
- **PDF and DOCX parsing** run in the main process in this owner-only mode (the visitor demo parses on a worker
  thread with a time and heap limit). The limits bound input size, archive expansion and
  pages, not the CPU cost of an adversarial document within them (a PDF with 100 dense pages). The
  one-at-a-time gate bounds how many run together in public mode.
- **Non-browser clients cannot POST** in public mode (no `Origin`). This is a deliberate consequence of the
  CSRF guard.
- **Not covered here:** anything about Vercel or Cloudflare configuration (neither is set up; nothing is
  deployed), TLS (the tunnel provides it), and a web application firewall. The visitor demo's frontend is
  covered in [PUBLIC_DEMO_JOBS.md](PUBLIC_DEMO_JOBS.md#the-frontend).

## The public demo (PUBLIC_DEMO)

Owner-only mode above is one of three. The **public demo**, with visitors, Turnstile tickets and an
asynchronous job API, is a separate mode with its own document: [PUBLIC_DEMO_JOBS.md](PUBLIC_DEMO_JOBS.md).
The two cannot be switched on together.
