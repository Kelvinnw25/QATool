# QATOOL

Internal QA productivity tool. A QA analyst uploads project documents (PRD, RFC, specs); three LLM
calls draft requirements, test cases and a review; deterministic code validates the result and owns
every identifier and traceability link; the run ends in an `.xlsx` built from the office
**SIT Script** template, which QA then reviews by hand in Excel.

> **AI drafts. Deterministic code validates. QA decides.**

This README is the entry point: what the tool does, how to set it up on a new machine, and how to
run it. The detailed behaviour reference (23 sections, the original README) is
[`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md). Working context for Claude Code is in
[`CLAUDE.md`](CLAUDE.md).

## Contents

1. [Features](#features)
2. [Technology stack](#technology-stack)
3. [How it works](#how-it-works)
4. [The three-stage LLM pipeline](#the-three-stage-llm-pipeline)
5. [Providers and Apayee](#providers-and-apayee)
6. [Repository layout](#repository-layout)
7. [Setup on a new computer](#setup-on-a-new-computer)
8. [Environment variables](#environment-variables)
9. [Running, building, testing](#running-building-testing)
10. [Troubleshooting](#troubleshooting)
11. [Project status](#project-status)

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
- **Stateless by design**: no database, no uploads on disk, no session store. The project lives in the
  browser for one session; the exported file is the deliverable.

## Technology stack

| Layer    | Choice                                                                              |
| -------- | ----------------------------------------------------------------------------------- |
| Runtime  | Node.js >= 22.13 (developed on 24.18), ESM only, no native dependencies             |
| Backend  | Fastify 5, `@fastify/multipart`, `@fastify/static`, Zod 4                           |
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
`GET /api/health` and `/api/meta/*` are small helpers.

Errors are uniform: `{ "error": { "code": "...", "message": "...", "details": [] } }`.

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
and never blocks the run.

Details of each stage's prompt, schema and validation: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) section 6.

## Providers and Apayee

| Provider | Selected by                                  | Notes                                                                                     |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `gemini` | default, or `?provider=gemini`               | Needs `GEMINI_API_KEY`. The key never leaves the server.                                  |
| `claude` | `?provider=claude` (UI: "Claude via Apayee") | Goes through the Apayee gateway; usable only when Apayee reports provider `claude`.       |
| `mock`   | `LLM_PROVIDER=mock`                          | Operator/test setting only; never offered in the UI. Runs the whole flow offline.         |
| `apayee` | `LLM_PROVIDER=apayee`                        | Server-wide default through Apayee; the UI shows it as "Server default (Apayee gateway)". |

**Apayee** is a separate private AI gateway kept in its own repository (expected at `../Apayee`,
listening on `http://127.0.0.1:4100`). QATOOL stays the owner of prompts, schemas, validation and
export; Apayee only runs the inference request. QATOOL reads Apayee, it never modifies it, and it
holds no Claude credentials. Start Apayee first (`npm start` in its directory), then QATOOL.

Per-run rules: the choice is frozen when Process is pressed and reused for every call of that run;
an unavailable provider is refused (`503 PROVIDER_UNAVAILABLE`) before the stage starts; nothing falls
back to another provider. Full behaviour: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) section 17.

## Repository layout

```text
QATOOL/
  README.md, CLAUDE.md      Overview/setup, and context for Claude Code
  package.json              Scripts; npm workspace "web"
  .env.example              Every supported variable, no secrets (copy to .env)
  server/                   Fastify API and the whole pipeline
    index.js, app.js        Entry point; app factory, error handling, static serving
    config.js               Environment parsing + redactSecrets()
    routes/                 pipeline.js (extract/generate/validate/export), meta.js, llm.js
    extract/                Format detection, parsers (pdf/docx/xlsx), blocks, noise, conflicts
    structure/              LLM #1: prompt, contract, validation/rebuild, recovery, test points
    generate/               LLM #2: prompt, contract, assembly (ids, refs, dedup, coverage)
    semantic/               LLM #3: heuristics, prompt, contract, merge and anchor check
    scenario/               Deterministic checklist and coverage obligations
    schema/                 Canonical Zod model; enums.js is the only place enum values live
    export/                 Template reader, OOXML sheet builder, edge mapping, read-back inspect
    llm/                    provider.js (interface), gemini.js, apayee.js, mock.js, catalog.js
    lib/                    errors, ids, text, cancellation, trace
    benchmark/              Golden oracle for one real PRD, and its tests
    testing/no-network.js   Makes any non-localhost request throw during tests
  web/                      React UI (src/stages, src/components, src/state, api.js, pipeline.js)
  templates/                sit-script-template.xlsx (the office template, never modified)
  scripts/                  dev.js, llm-smoke.js, e2e-live.js, qa-eval/
  fixtures/prd/             Sample PDFs (two are read by tests; see fixtures/README.md)
  docs/                     IMPLEMENTATION.md, edge-cases.md, QAI blueprints, review queue CSV
```

Generated or local only (ignored by Git): `node_modules/`, `web/dist/`, `.env`, `.qa-eval-output/`.

## Setup on a new computer

Requirements: **Node.js >= 22.13** and npm. Nothing else (no database, no Docker).

```bash
git clone <repo-url> QATOOL        # or copy the folder, without node_modules
cd QATOOL
npm install                        # installs the root and the web workspace
cp .env.example .env               # PowerShell: Copy-Item .env.example .env
```

Then edit `.env`:

- To use Gemini: set `GEMINI_API_KEY`. Get the key through your own channel; it is not in the repo.
- To work offline: set `LLM_PROVIDER=mock`.
- To use Claude: run Apayee separately (see above); no QATOOL setting is needed for the per-run choice
  while Apayee is on the same machine without a token. For a remote Apayee set `APAYEE_BASE_URL` and `APAYEE_TOKEN`.

Extraction and export work without any key. Check the install with `npm test` (offline, free).

## Environment variables

Names and purpose only; defaults are in `server/config.js` and `.env.example`. Values are never committed.

| Variable                                  | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `PORT`, `HOST`                            | API address (defaults `3001`, `127.0.0.1`)                              |
| `NODE_ENV`                                | `production` makes the server also serve `web/dist`                     |
| `LOG_LEVEL`                               | Fastify log level                                                       |
| `SIT_TEMPLATE_PATH`                       | Path to the SIT Script template                                         |
| `MAX_BODY_BYTES`                          | Request ceiling; also the in-memory ceiling for uploads (default 25 MB) |
| `LLM_PROVIDER`                            | Server default: `gemini`, `mock` or `apayee`                            |
| `GEMINI_API_KEY`                          | Gemini key (server-side only)                                           |
| `GEMINI_MODEL`, `GEMINI_BASE_URL`         | Pin a Gemini model / endpoint                                           |
| `LLM_TIMEOUT_MS`, `LLM_MAX_OUTPUT_TOKENS` | Per-call budget and output cap                                          |
| `LLM_TEMPERATURE`                         | Leave unset for Gemini 3 models                                         |
| `APAYEE_BASE_URL`                         | Where Apayee is (default `http://127.0.0.1:4100`)                       |
| `APAYEE_TOKEN`                            | Bearer token; required for a non-local Apayee                           |
| `APAYEE_QUEUE_WAIT_MS`                    | Extra time allowed for waiting in Apayee's queue                        |

Opt-in test switches (read only by those tests): `QATOOL_LIVE_LLM=1`, `QATOOL_APAYEE_SMOKE=1`,
`APAYEE_DIR` (location of the Apayee project, default `../Apayee`).

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

Production-style run:

```bash
npm run build
NODE_ENV=production npm start               # PowerShell: $env:NODE_ENV='production'; npm start
```

Under `npm run dev`, React StrictMode runs each UI processing phase twice, so a development run makes
two model calls per stage. A production build makes one.

## Troubleshooting

| Symptom                                                  | Cause and fix                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run dev` stops at a Node version error              | Install Node >= 22.13.                                                                               |
| UI loads but requests fail with an empty 500             | The API is not up yet or crashed; `dev.js` normally waits for `/api/health`. Check the API terminal. |
| Generation fails with an LLM error and no key is set     | `LLM_PROVIDER` is `gemini` but `GEMINI_API_KEY` is empty. Set the key or use `LLM_PROVIDER=mock`.    |
| Gemini returns 429 or 503                                | Free tier is 20 requests/day/model, and a 503 still consumes one. Wait; do not retry in a loop.      |
| "Claude via Apayee" is greyed out                        | Apayee is offline, wrong token, or not running the `claude` provider. The reason is shown in the UI. |
| Structuring warning "deterministic extraction"           | The model call failed or returned nothing usable; extraction continued without the model.            |
| Server fails at startup with an Apayee URL/token message | A bad `APAYEE_BASE_URL`, a malformed token, or a remote URL without `APAYEE_TOKEN`.                  |
| `npm test` fails on a PDF path                           | The two `PRD_*` PDFs must stay in `fixtures/prd/`.                                                   |
| Production server shows no UI                            | Run `npm run build` and start with `NODE_ENV=production`.                                            |
| Port 3001 or 5173 already in use                         | Stop the other process, or set `PORT` (and update the Vite proxy in `web/vite.config.js`).           |

## Project status

- **Implemented (V1):** the three-call pipeline above, XLSX export, per-run model selection, Apayee
  provider with cancellation, the golden-oracle benchmark, and an offline test suite.
- **Specified, not implemented:** the QAI P0 target architecture (two LLM calls, run-scoped artifact
  storage, no obligation engine, red highlighting for rows needing review) in
  [`docs/QAI_Blueprint_v4_P0_Refinement.md`](docs/QAI_Blueprint_v4_P0_Refinement.md).
- **Known limitations:** Gemini free-tier quota; large documents truncate at 400 blocks / 120,000
  characters; no authentication and plain HTTP on localhost only (local single-user use); `server/lib/trace.js`
  exists but is not wired in; no ESLint. Full list: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) section 19.
- **Open work:** extraction prompt efficiency (audit done, nothing applied), live validation that the
  model follows the generation granularity rules, run-level tracing.
- **Data handling:** documents are parsed in memory and discarded; prompts and replies are not logged;
  see [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) section 20. Sending real internal documents to
  a model is an organisational decision, not something the code decides.
