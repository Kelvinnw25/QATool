# Test case coverage: investigation and benchmark procedure

Written 2026-11-13 after a Bank Routing PRD run produced about 20 test cases, against 40+ in earlier runs and about 44
from the same PRD in Claude Chat. The primary metric throughout is **requirement coverage and correctness**, never the
number of test cases. A run is not "complete" because it produced 44.

## 1. What the evidence says (ranked)

All figures are from the backend log of the running stack, 2026-11-13 04:59-05:11 UTC: six jobs on the same PDF
(233 blocks, 10 pages), plus one that failed. Counts, not content.

| Rank | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                                     | Confidence                                                                                                                 |
| ---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
|    1 | **The running backend is not the code that was tested.** The backend image was built 2026-11-06 17:35 (+07); the fail-fast change was written 19:18 the same day. Inside the running container `unusableReply` is absent while `deterministic_fallback_used` and `DEGRADED` are present, so a structuring failure would still silently produce a deterministic extraction there. The Apayee image does contain the schema fix (built after it).                 | `docker compose ps`, `docker inspect` creation times, marker counts in `/app/server/...`     | Confirmed                                                                                                                  |
|    2 | **Generation covers about half of what it is asked to.** 42-43 obligations are derived and shown to the model; 17-27 test cases come back; the matcher counts 22-37 of 42-43 obligations covered. The model's own plan claims far more than its cases state (`planned_covered 39`, `claims_evidenced 22`, `claims_unverified 17` in one run). It merges obligations into one case, which the prompt tells it not to do.                                         | `gemini_2_completed`, `coverage_completed`, `obligation_claims_audited`                      | Confirmed for the counts; "uncovered" is a word-overlap heuristic, so some of it may be wording the matcher cannot see     |
|    3 | **15 image regions of the PDF are never read.** Pages 3-10 carry pictures (UI screens) whose content is not in the text layer. QATOOL warns (`UNREAD_IMAGE_CONTENT`) and nothing downstream sees them. Claude Chat reads the PDF's images.                                                                                                                                                                                                                      | parse warning, replay of the parser                                                          | Confirmed that the content is missing; **that it explains the gap to 44 is an inference** (the pictures were not compared) |
|    4 | **The prompts lean towards fewer cases.** "Aim for maximum meaningful coverage with minimum redundancy", "Do NOT split to raise a count", "One test case may cover several requirements", "Do not force all three [types]". Nothing tells the model to enumerate per control, per option set, per transaction type, or per Domestic / Cross Border variant. Structuring is told to "group aggressively", so about ten requirements stand for fifteen scenarios. | `generate/prompt.js` 34-93, `structure/prompt.js` 36                                         | Confirmed (text); effect on counts not isolated                                                                            |
|    5 | **Run-to-run variance on identical input.** Structuring: 9-11 requirements, 37-41 test points. Generation: 17, 20, 21, 22, 27 cases. One structuring call took 206 s and 25,658 output tokens; the others 21-23 s and about 4,400.                                                                                                                                                                                                                              | the six runs above                                                                           | Confirmed                                                                                                                  |
|    6 | **The semantic review does not find missing coverage.** It is told to treat the mechanical gap list as "a place to look", is shown at most 25 gaps (`MAX_REVIEW_GAPS`), and returned `{"issues":[]}` (13 bytes) for a run with 20 uncovered obligations. It only reports; nothing it says is applied to the test cases. It cannot add a case.                                                                                                                   | `gemini_3_completed` (`response_bytes 13`), `semantic/prompt.js`, `obligations.js` 3172-3190 | Confirmed                                                                                                                  |
|    7 | **Model and effort were never pinned.** `APAYEE_CLAUDE_MODEL` is unset and no `--effort` was passed, so the CLI used its own default model at its default effort (documented default for Opus 5.5, Sonnet 5.5 and Haiku 5.5 is `medium`). Generation ran 34-50 s for about 7,000 output tokens, which fits shallow reasoning. Which model answered is not in any log.                                                                                           | `invocation.js`, `.env` presence check, logs                                                 | Confirmed that nothing was pinned; the model identity is unknown                                                           |
|    - | **Ruled out as the cause.** No maximum test case count exists (only the plan's exact length up to 40, 16 obligations per requirement, 120 in the prompt, 200 requirements). Validation discarded 0 and deduplication removed 0 in every run. The route, the job result and the page do not filter or paginate. The input was not truncated (`truncated_block_count 0`, 49.7 k characters of 120 k).                                                             | `contract.js`, `assemble.js`, `testcase_validation_completed`                                | Confirmed                                                                                                                  |

Not investigated in depth: DOCX and XLSX parsing (they have their own tests), and whether requirement text rebuilt from
cited blocks loses a continuation line the model did not cite (check it in the benchmark, section 4).

## 2. What changed with this investigation

Apayee now takes `APAYEE_CLAUDE_MODEL` (a full id from an allowlist) and `APAYEE_CLAUDE_EFFORT`, refuses unsupported
combinations at start-up, passes both to the CLI as separate arguments, fails a request answered by a different model than
configured, and logs the model, effort, stage, tokens, cache tokens and failure class of every request (metadata only).
QATOOL labels each call with its step (`structure`, `generate`, `review`). **No prompt was changed.** Details:
`../Apayee/docs/CLAUDE_PROVIDER.md` > "Model and effort".

## 3. Recommended prompt changes (proposed, not applied)

Each needs the benchmark below before it is kept; `structure/prompt.js` changes also need a regression on real PRDs.

1. **Generation: coverage before economy.** Replace the count-averse sentences with a completion rule the model and the
   code can both check: every listed obligation ends in exactly one of "covered by these case ids" or
   `INSUFFICIENT_INFORMATION` with a reason, and a covered obligation's behaviour must be restated in that case's expected
   result. Add the missing enumeration rules: one case per control state, option set or transaction type whose behaviour or
   options differ; Domestic and Cross Border are separate unless the source says they behave alike; every transaction type
   and every switching-specific rule named in the source appears in at least one case. Keep "never invent" and "no
   duplicates that differ only in wording".
2. **Structuring: one requirement per acceptance scenario.** Replace "group aggressively" with "one requirement per
   GIVEN/WHEN/THEN scenario or per distinct rule; group only continuation lines". Keep "never drop a bulleted outcome".
3. **Review: a coverage audit, not a review of wording.** Give it every uncovered obligation (not 25), ask for one
   `missing_coverage` finding per genuinely untested behaviour with the obligation id, and show the count of uncovered
   obligations in the result whatever the model says, so a result is never presented as complete while any remain.
4. **Pictures.** The parser already accepts a human-verified transcription of an image (`extract/parsers/transcription.js`).
   Supplying one for the 15 regions is the cheap route; reading images through Apayee would be a larger change.

### A bounded correction pass (needs your approval: it spends extra quota)

Completion condition, checkable by code: **no measurable obligation is uncovered**, or the correction pass has run once.
Strategy: after generation, if the matcher reports uncovered obligations, run **one** further generation call limited to
those obligations and the requirement text they come from; validate its cases exactly like the first batch; emit
`gap_fill_started` and `gap_fill_completed` with the counts before and after. If that call fails, the job fails (no silent
skip); obligations still uncovered afterwards are reported as warnings, never hidden. There is no loop and no retry.

## 4. Benchmark procedure (reproducible)

**Goal:** compare four configurations on exactly the same document, changing nothing else.

| Run        | `APAYEE_CLAUDE_MODEL` | `APAYEE_CLAUDE_EFFORT`   |
| ---------- | --------------------- | ------------------------ |
| 0 baseline | unset                 | `auto` (what ran before) |
| 1          | `claude-sonnet-5-5`   | `high`                   |
| 2          | `claude-opus-5-5`     | `high`                   |
| 3          | `claude-opus-5-5`     | `xhigh`                  |

**Fixed:** the PDF (record its SHA-256 and size), the parser, prompts and schemas (record `git rev-parse HEAD` of both
repositories and `git diff --stat`), `LLM_TIMEOUT_MS`, `JOB_WORKERS=2`, `APAYEE_MAX_CONCURRENT=2`,
`structuredOutputAttempts=1`. Repeat each configuration **three times** (section 5 showed 17-27 cases on identical input,
so one run proves nothing).

**Before the first run (each needs your go-ahead; they change the running stack):**

1. Rebuild and recreate only the two services, in this order, so the new `stage` field is understood before it is sent:
   `docker compose up -d --build --no-deps apayee`, then `docker compose up -d --build --no-deps qatool-backend`.
   Never `down -v`; the `apayee-claude-config` volume is untouched.
2. Confirm the running code: `docker compose exec -T qatool-backend sh -c "grep -c unusableReply /app/server/structure/index.js"`
   must print `1`, and `grep -c deterministic_fallback_used` must print `0`.
3. For each configuration set the two variables in `../Apayee/.env`, recreate `apayee` only
   (`docker compose up -d --no-deps apayee`), and confirm the model reached the process: the first request's
   `claude_cli_finished` event must show `model_configured`, `effort_configured` and, if the CLI exposes it,
   `model_effective`. A `claude_cli_failed` with `kind: model_mismatch` means the account cannot use that model; record
   it and stop that configuration rather than substituting another.
4. One synthetic call first (`npm run claude:smoke` in Apayee, `APAYEE_CLAUDE_SMOKE=1`): it prints configured and effective
   model, effort, tokens and cache counts.

**Per run, record** (from the backend and Apayee logs, by `run_id`; never the PRD text): job id and final status;
structuring requirement and test point counts; obligation count; test cases proposed, kept, discarded, duplicates removed;
obligations covered and uncovered (`coverage_completed`); claims audited (`obligation_claims_audited`); per-stage duration
and tokens including cache tokens; schema validity (`schema_validation`, `failure_class`).

**Scoring against the source, by a person.** Build the list of independently testable criteria from the PRD **once**,
before looking at any run, from the explicit statements only (and the pictures, if a transcription exists). Then for each
run:

- _requirement coverage_ = criteria with at least one case that states that behaviour, divided by all criteria;
- _uncovered_ = the criteria with none, by name;
- _duplicates_ = cases that verify the same behaviour in different words;
- _hallucinated_ = cases asserting a rule, field, code or value the PRD does not state;
- _schema valid_ = the job completed with no `LLM_MALFORMED_OUTPUT`.

Report coverage and correctness first, then count, time and tokens. A run with 44 cases and 70% coverage loses to a run
with 30 cases and 90%.

**Results table (fill in):**

| Config | Run | Status | Req / test pts | Obligations | Cases | Covered (matcher) | Criteria covered (person) | Duplicates | Hallucinated | Time | Tokens in/out/cache |
| ------ | --: | ------ | -------------- | ----------- | ----: | ----------------- | ------------------------- | ---------: | -----------: | ---- | ------------------- |

Do not call the regression fixed until the same PDF has been run successfully through the running QATOOL pipeline and
scored this way.
