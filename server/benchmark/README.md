# The golden oracle

A fixed, source-grounded benchmark for one real document: **PRD QR Manager
Settlement Report**. It is the reference every future QATOOL run is measured
against.

## Why it exists

Every previous round of tuning measured QATOOL against its own output. The
coverage denominator was whatever the obligation detector happened to derive
from whatever Gemini #1 happened to group, so "30 of 30 covered" meant only that
the tool agreed with itself. A detector that stopped reading a sentence made the
denominator smaller and the score better.

This fixture breaks that loop. It was built by reading the PDF — with
`pdftotext -layout`, independently of QATOOL's own extractor — and enumerating
what the document states. It does not know what QATOOL derives and must never be
edited to agree with it.

## The rule that matters

**A mismatch is a finding about QATOOL until someone shows the oracle misread the
PRD.** The oracle is corrected only by citing the source document — a page, a
quotation, and an argument. Never because a run disagreed with it.

The comparator deliberately does **not** use
`server/scenario/obligations.js`. Sharing the matcher would make the benchmark
agree with the tool by construction: a detector bug would move both sides
together and the comparison would show nothing. It does its own literal term
matching, normalised for case and punctuation and for two compounds English
spells several ways — `1-hour` / `1 hour`, and `times out` / `timed out` /
`time-out` / `timeout` — and nothing else. A number term is never found inside
a longer number (`1 hour` is not in `11 hour`).

## Files

| File                                           | What it is                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `prd-qr-manager-settlement-report.oracle.json` | The frozen oracle. 69 items, every one quoted from the PDF with its page.                    |
| `compare.js`                                   | Test-only comparator. Nothing in the running application imports it.                         |
| `oracle.test.js`                               | Tests the oracle's integrity and the comparator's behaviour — **not** whether QATOOL passes. |
| `semantic-equivalence.test.js`                 | Accepted paraphrases and rejected weakenings for GO-014, GO-019 and GO-033, from real runs.  |

## Shape

```
oracle_version, frozen, source_document, revision_history, classification_rules
actionable_obligations[]      47   the measured set
not_measurable[]               1
implementation_instructions[]  3
examples[]                     8
background[]                  10
document_metadata[]            7
                              --
                              76   oracle_total
```

Coverage is the **only** axis that is summed, and the identity
`actionable = covered + missing` is asserted on every run and printed at the top
of every report. `discovered`, `extra` and the two verbatim checks are
diagnostics and are deliberately kept out of it: an item can be undiscovered, or
paraphrased rather than quoted, and is still either covered or missing — never
both, never neither.

Every item carries `id`, `source_page`, `source_text`, `classification` and a
justification or `expected_evidence`. Ids are contiguous, so deleting one is
visible: `oracle.test.js` fails on a gap.

### The four actionable kinds

A **QUALIFIER** and a **GUARD_CONDITION** are counted as items in their own
right rather than folded into the behaviour they modify, because losing them is
the failure mode this project keeps hitting. `calls T24 via MW` and `calls T24
via MW (mscore*)` are different tests; `a retry happens on FAILED` and `a retry
happens only when FAILED and attempts have not reached 3` are different tests.
Each records `qualifies` or `guards` pointing at its parent.

**OUTPUT_CONTRACT** covers stated properties of produced artefacts: the file
name, the format, the delimiter, the destination, and the two response mappings.

### `expected_evidence`

An array of groups. **Every group must be shown; a group is shown when any of
its spellings appears.**

```json
"expected_evidence": [["unsettled"], ["unreleased"]]
```

Both statuses required, either spelling of each accepted. This is what lets the
oracle say "the case must name the status, however it writes the word" without
degrading into "anything resembling this is fine".

If a run genuinely covers an item but the comparator misses it, the fix belongs
in that item's `expected_evidence` — adding the spelling the generator used —
never in the comparator's matching rule.

### `alternative_evidence`

Optional, and only on a guard. A guard has two equivalent statements — _"retry
only when FAILED and attempts have not reached 3"_ and _"no retry when the
response is not FAILED or attempts have reached 3"_ — and literal groups cannot
hold both: putting `has reached` beside `has not reached` would accept a retry
at the limit. So the second statement is a complete evidence set of its own:

```json
"alternative_evidence": [
  [["not performed", "no retry"], ["not failed", "other than failed"], ["reached 3"]]
]
```

A case shows the item when it shows every group of **one** form. Groups are
never mixed across forms, and the alternative still needs both conditions —
withholding the retry at the limit alone is half the guard.

## Running a comparison

```js
import { compareToOracle, formatComparison } from './compare.js';

const report = compareToOracle(oracle, {
  test_cases: generated.test_cases,
  obligations: matchedObligations, // optional; enables discovered / extra
});

console.log(formatComparison(report));
```

`discovered` and `covered` are reported separately and answer different
questions:

- **not discovered** — QATOOL's obligation layer never derived anything from
  this sentence. Lost before generation saw it: look at Gemini #1, recovery, or
  the detectors.
- **discovered but not covered** — derived, then no test case exercised it. Lost
  by Gemini #2 or hidden by the matcher.

`extra` lists obligations the run derived that no oracle item accounts for. Each
is either a behaviour this audit missed — **a defect in the oracle** — or text
the PRD does not state as a requirement.

`qualifier_not_verbatim` and `condition_not_verbatim` are **phrase-level** checks
and are named for what they measure. They ask whether the PRD's own phrase
appears word for word, which is weaker than "the qualifier was lost": a run
writing _"including H+1 and On Hold transactions"_ does not contain _"including
**both** H+1 and On Hold transactions"_ and is flagged while having kept the
qualifier perfectly well. Read them by hand. They are left strict because the
alternative is a similarity rule, and a similarity rule inside the benchmark
would start forgiving real losses and the number would stop meaning anything.

## Known gaps in the source

Two things the PRD does not give, recorded honestly rather than guessed:

- **GO-042, the daily report format.** The PRD says _"Report format to be
  generated as shown below:"_ and then supplies it as a **picture**. The text
  layer holds nothing between that line and _"Also refer to this note:"_.
  The field list, their order and their sources are not recoverable from the
  document. This is the largest piece of unspecified output contract in the PRD
  and it needs a human to supply before any tool can be held to it.
- **GO-041, "quickly".** No threshold stated. The nearby `28 seconds` is
  explicitly labelled today's production behaviour, not a target.

## Calls flagged for human review

Two items carry `review_required: true`. They are judgement calls the audit made
one way and could defensibly have made the other:

- **GO-044** _"Perform Table Tuning to optimize data retrieval process"_ —
  classified as an implementation instruction, but it is written as an
  acceptance criterion under `THEN` and could be held verifiable by inspecting
  the database.
- **GO-046** the sample OFS request — classified as an example, but
  `ENQUIRY.SELECT` and `E.CHN.VERIFY.FT` look like fixed interface constants
  rather than specimens. If they are, they belong in the actionable set.

## Changing the oracle

Bump `oracle_version` and record what changed and which page justifies it. A
change that is not argued from the PDF is not a correction.
