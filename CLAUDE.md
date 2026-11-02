# CLAUDE.md - QATOOL

Context for Claude Code. Setup and usage live in `README.md`; the long behaviour reference is
`docs/IMPLEMENTATION.md`. This file is only what you need before changing code.

## What this is

Internal QA tool: documents (PDF/DOCX/XLSX) -> requirements -> SIT test cases -> `SIT Script.xlsx`.
Node >= 22.13 ESM, Fastify 5, Zod 4, React 19 + Vite (npm workspace `web/`). No database, no native
deps. Principle: **AI drafts, deterministic code validates, QA decides.**

## Flow and modules

```text
POST /api/extract   server/extract/ (parse, blocks) -> server/structure/ (LLM #1) -> requirements + test_points
POST /api/generate  server/generate/ (LLM #2) + scenario/ (checklist, obligations) -> test cases
POST /api/validate  server/schema + semantic/heuristics (+ semantic/ LLM #3 when ?semantic=true)
POST /api/export    server/export/ -> .xlsx from templates/sit-script-template.xlsx
```

| Path                        | Responsibility                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `server/routes/pipeline.js` | The four routes; chooses the provider per request (`chooseProvider`)                                                                   |
| `server/structure/`         | LLM #1. `prompt.js`, `contract.js` (JSON schema + Zod), `validate.js` (rebuild), `recover.js`, `test-points.js`, `index.js` (fallback) |
| `server/generate/`          | LLM #2. Prompt, contract, `assemble.js` (ids, source refs, dedup, coverage)                                                            |
| `server/semantic/`          | LLM #3 plus free deterministic heuristics                                                                                              |
| `server/scenario/`          | Deterministic checklist and 10 obligation types + matching                                                                             |
| `server/schema/`            | Canonical model. `enums.js` is the only place enum values are written                                                                  |
| `server/export/`            | OOXML writer; edge mapping; read-back `inspect.js` self-verification                                                                   |
| `server/llm/`               | `provider.js` interface; `gemini.js`, `apayee.js`, `mock.js`; `catalog.js` = user-selectable models and availability                   |
| `server/config.js`          | All env parsing and `redactSecrets()`                                                                                                  |
| `web/src/`                  | `pipeline.js` (phases), `api.js`, `state/run.js` (run + frozen model), `providers.js`, `stages/`, `components/`                        |

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
  enforces it. Do not add a database, cache or upload directory.
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
- **Apayee** is a separate repo at `../Apayee` (127.0.0.1:4100). It is read-only from QATOOL's side:
  do not edit it, start/stop it, or call it from tests (`npm test` blocks non-localhost traffic; the
  fake gateway in `server/llm/fixtures/` stands in). QATOOL has no Claude credentials.
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

## Conventions

- ESM everywhere; Prettier config in `.prettierrc` (single quotes, width 100). No ESLint.
- Tests sit next to the code as `*.test.js` on `node:test`; the frontend tests are plain `.js` too.
- Enum values only in `server/schema/enums.js`; ids only via `server/lib/ids.js`; vendor code only in `server/llm/`.
- Tests read two PDFs by literal path: `fixtures/prd/PRD_*.pdf`. Keep them there.
- Docs for users are English; the QAI blueprints in `docs/` are Indonesian.
- `server/benchmark/` is a golden oracle: correct it only by citing the source PRD, never to make a run agree.

## Status and cautions

- V1 pipeline, export, per-run model selection and the Apayee provider are implemented. The QAI P0
  architecture (`docs/QAI_Blueprint_v4_P0_Refinement.md`) is specified but not implemented, and would
  supersede the stateless rule for its own path only.
- Prompt-efficiency audit of stage 1 was done (read-only); nothing was applied. Candidate savings are
  small (system prompt about -9%); serialization of the block list and the schema are the larger levers.
  Treat any change to `structure/prompt.js` as needing a regression run on real PRDs.
- `server/lib/trace.js` is not imported anywhere. `confidence` is a hard enum in the generation
  reply. Model compliance with the granularity rules has not been proven by a recorded live run.
- Under `npm run dev` the UI double-runs each phase (React StrictMode); production does not.
- Keep `.env` out of anything you print: read variable names only.
