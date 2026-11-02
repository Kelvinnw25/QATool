/**
 * Compares a QATOOL run against the golden oracle.
 *
 * TEST-ONLY. Nothing in the running application imports this file, and nothing
 * here may be imported into the pipeline: the whole point is to judge QATOOL
 * from outside, with a reference built from the PRD rather than from QATOOL's
 * own output.
 *
 * It therefore does its OWN matching, deliberately simple and deliberately not
 * server/scenario/obligations.js. Sharing the matcher would make the benchmark
 * agree with the tool by construction - a detector bug would move the oracle
 * and the result together, and the comparison would show nothing. The rule here
 * is literal term presence over the generated text, normalised for case and
 * punctuation and for two compounds English spells several ways (below), and
 * nothing else.
 *
 * What it reports is a measurement, not a verdict. An oracle item the run
 * missed may be a real gap or may be an evidence term this file spells
 * differently from the model; both are findings, and the second is fixed in the
 * oracle's expected_evidence, never by loosening the comparison.
 */

/**
 * A quantity joined to its unit by a hyphen - "1-hour", "3-digit", "one-hour".
 *
 * That hyphen is punctuation: "a 1-hour delay" and "a delay of 1 hour" state
 * the same duration, and English requires the first form before a noun. It was
 * kept, so "1-hour" never contained the evidence term "1 hour", and GO-014 was
 * reported missing in five runs whose cases all said "a strict 1-hour delay
 * from the original timeout timestamp" - the exact obligation, word for word.
 *
 * Narrow on purpose. Only a number (or a spelled cardinal) directly before a
 * single word that ENDS there is folded, so a date - "03-Feb-25", which carries
 * on past its letters - is left whole, and so is every identifier, which puts
 * letters first ("D-1", "SDE4-17394"). Applied to evidence and text alike, so
 * it can only make equal phrasings compare equal.
 */
const HYPHENATED_QUANTITY =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)-(\p{L}+)\b(?!-)/gu;

/**
 * "Times out" - the verb English writes as two words where the noun is one.
 *
 * The PRD itself uses the noun as a verb ("the transaction still Timeout"), and
 * the grammatical rendering of that sentence is "still times out". Thirteen
 * saved runs wrote exactly that - "if the transaction still times out after the
 * 1st and/or 2nd retry attempt, Check Status is performed again", GO-019 word
 * for word - and were scored missing, because "times out" does not contain the
 * evidence term "timeout". Every run that wrote "timeout" or "timeouts" for the
 * same sentence was scored covered.
 *
 * One compound, the same kind of fold as the hyphen above: time out, times out,
 * timed out, timing out and time-out are read as "timeout", on both sides.
 * "Times out of" is a ratio ("2 times out of 3") and is left alone.
 */
const TIME_OUT = /\btim(?:e|es|ed|ing)[ -]out\b(?! of\b)/g;

/** Case and punctuation folded, plus the two compounds above. Keeps the comparison auditable. */
function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(HYPHENATED_QUANTITY, '$1 $2')
    .replace(/[^\p{L}\p{N}.+&_~-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(TIME_OUT, 'timeout')
    .trim();
}

/**
 * Whether normalised text contains one evidence term.
 *
 * Substring presence, with one exception: a term that starts or ends with a
 * digit is not found inside a longer number. "1 hour" is not in "11 hour", "3"
 * is not in "30", "h+1" is not in "h+10". Plain substring matching accepted all
 * of those, and the hyphen fold widened it - "an 11-hour delay from the
 * original timeout timestamp" became "11 hour ...", which contains "1 hour" and
 * closed GO-014. A number inside a different number is never the same value.
 * Over every saved run this changes no verdict; it only removes a way to be
 * wrong.
 */
const DIGIT = /\p{N}/u;

function contains(haystack, term) {
  const needle = normalise(term);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (DIGIT.test(needle[0] ?? '') && DIGIT.test(haystack[at - 1] ?? '')) continue;
    if (DIGIT.test(needle.at(-1) ?? '') && DIGIT.test(haystack[at + needle.length] ?? '')) continue;
    return true;
  }
  return false;
}

/**
 * Whether a run's text shows one evidence requirement.
 *
 * expected_evidence is an array of alternatives-groups: every group must be
 * present, and a group is present when ANY of its spellings is. That shape is
 * what lets the oracle say "the case must name the status, however it writes
 * the word" without saying "anything resembling this is fine".
 */
const showsGroup = (haystack, group) => group.some((term) => contains(haystack, term));

const missingGroups = (haystack, evidence) =>
  (evidence ?? []).filter((group) => !showsGroup(haystack, group));

/**
 * Every form in which one case can show an item: expected_evidence, then each
 * set in alternative_evidence.
 *
 * Alternatives exist for a guard, which has two logically equivalent
 * statements. "Retry only when FAILED and attempts have not reached 3" is also
 * "no retry when the response is not FAILED or attempts have reached 3" - the
 * side a guard is about, and the side the generation contract asks a guard's
 * negative case to state. Literal groups cannot hold both: adding "has reached"
 * beside "has not reached" would accept a case retrying AT the limit. So each
 * form is a complete set of its own, a case must show every group of ONE form,
 * and groups are never mixed across forms.
 */
const formsOf = (item) => [item.expected_evidence, ...(item.alternative_evidence ?? [])];

/** The text a tester actually reads, per case and in total. */
function textsOf(testCases) {
  return (testCases ?? []).map((testCase) => ({
    case_id: testCase.case_id,
    text: normalise(`${testCase.test_case ?? ''} ${testCase.expected_result ?? ''}`),
  }));
}

/** Which cases show every evidence group of one form of one oracle item. */
function casesShowing(cases, item) {
  return cases.filter((entry) =>
    formsOf(item).some((evidence) => missingGroups(entry.text, evidence).length === 0)
  );
}

/**
 * Whether QATOOL's own obligation layer found this part of the document at all.
 *
 * Separate from coverage on purpose, because the two fail for different reasons
 * and need different fixes. An item the detector never derived was lost before
 * generation ever saw it; an item derived and then untested was lost by the
 * generator. Matched on a run of the source's own words, so the detector has to
 * have read the same sentence, not merely the same requirement.
 */
const DISCOVERY_RUN = 4;

function discoveredBy(obligations, sourceText) {
  const words = normalise(sourceText).split(' ').filter(Boolean);
  if (words.length === 0) return [];

  const probes = [];
  for (let start = 0; start + DISCOVERY_RUN <= words.length; start += 1) {
    probes.push(words.slice(start, start + DISCOVERY_RUN).join(' '));
  }
  if (probes.length === 0) probes.push(words.join(' '));

  return (obligations ?? [])
    .filter((obligation) => {
      const basis = normalise(obligation.source_basis);
      return probes.some((probe) => basis.includes(probe));
    })
    .map((obligation) => obligation.obligation_id);
}

/**
 * Compares one run against the oracle.
 *
 * @param {object} oracle      the frozen fixture
 * @param {object} run         { test_cases, obligations?, requirements? }
 * @returns {object} the report
 */
export function compareToOracle(oracle, run) {
  const cases = textsOf(run.test_cases);
  const haystack = cases.map((entry) => entry.text).join(' | ');
  const obligations = run.obligations ?? [];

  const actionable = oracle.actionable_obligations;

  const assessed = actionable.map((item) => {
    const proving = casesShowing(cases, item);
    const found = discoveredBy(obligations, item.source_text);

    // Verbatim, and reported as verbatim. These ask whether the PRD's own
    // phrase appears word for word, which is a WEAKER claim than "the qualifier
    // was lost": a run writing "including H+1 and On Hold transactions" does not
    // contain "including both H+1 and On Hold transactions" and is flagged here
    // while having kept the qualifier perfectly well.
    //
    // Left strict on purpose. The alternative is a similarity rule, and a
    // similarity rule in the benchmark is the thing this whole fixture exists to
    // avoid - it would start forgiving losses and the number would stop meaning
    // anything. A reviewer reads these as "look at these by hand", and the
    // spelling a run actually used belongs in expected_evidence.
    const qualifierNotVerbatim = (item.required_qualifiers ?? []).filter(
      (term) => !contains(haystack, term)
    );
    const conditionNotVerbatim = (item.required_conditions ?? []).filter(
      (term) => !contains(haystack, term)
    );
    const valueNotVerbatim = (item.required_values ?? []).filter(
      (term) => !contains(haystack, term)
    );

    return {
      id: item.id,
      classification: item.classification,
      requirement: item.requirement,
      source_page: item.source_page,
      source_text: item.source_text,
      discovered: found.length > 0,
      discovered_as: found,
      covered: proving.length > 0,
      case_ids: proving.map((entry) => entry.case_id),
      missing_evidence: proving.length > 0 ? [] : missingGroups(haystack, item.expected_evidence),
      qualifier_not_verbatim: qualifierNotVerbatim,
      condition_not_verbatim: conditionNotVerbatim,
      value_not_verbatim: valueNotVerbatim,
    };
  });

  // Classification errors, in both directions. The run calling an oracle
  // actionable item "not measurable" excuses a behaviour that is testable; the
  // run counting an oracle not-measurable item as actionable invites an
  // invented threshold. Both are reported.
  const notMeasurableIds = new Set(oracle.not_measurable.map((item) => item.id));
  const runNotMeasurable = new Set(
    obligations.filter((entry) => entry.measurable === false).map((entry) => entry.obligation_id)
  );

  const wronglyExcused = assessed
    .filter((item) => item.discovered_as.some((id) => runNotMeasurable.has(id)))
    .map((item) => ({
      oracle_id: item.id,
      obligation_ids: item.discovered_as.filter((id) => runNotMeasurable.has(id)),
      source_text: item.source_text,
      why: 'the oracle holds this testable from the PRD; the run excused it as not measurable',
    }));

  const wronglyActionable = oracle.not_measurable
    .map((item) => ({ item, found: discoveredBy(obligations, item.source_text) }))
    .filter(({ found }) => found.some((id) => !runNotMeasurable.has(id)))
    .map(({ item, found }) => ({
      oracle_id: item.id,
      obligation_ids: found.filter((id) => !runNotMeasurable.has(id)),
      source_text: item.source_text,
      why: `the oracle holds this unmeasurable (${item.reason}); the run counted it as actionable`,
    }));

  // Obligations the run derived that no oracle item accounts for. Each is either
  // a behaviour this audit missed - which would be a defect in the ORACLE - or
  // something the PRD does not state as a requirement.
  const accountedFor = new Set(
    [
      ...actionable,
      ...oracle.not_measurable,
      ...oracle.implementation_instructions,
      ...oracle.examples,
      ...oracle.background,
      ...oracle.document_metadata,
    ].flatMap((item) => discoveredBy(obligations, item.source_text))
  );

  const extra = obligations
    .filter((obligation) => !accountedFor.has(obligation.obligation_id))
    .map((obligation) => ({
      obligation_id: obligation.obligation_id,
      requirement_id: obligation.requirement_id,
      type: obligation.type,
      statement: obligation.statement,
      source_basis: obligation.source_basis,
      why_not_in_oracle:
        'no oracle item quotes this wording; it is either a behaviour the audit missed (an oracle defect) or text the PRD does not state as a requirement',
    }));

  const covered = assessed.filter((item) => item.covered);
  const missing = assessed.filter((item) => !item.covered);
  const undiscovered = assessed.filter((item) => !item.discovered);

  // The arithmetic, stated and checked rather than left to be inferred.
  //
  // v1.0.0 reported covered 39 of 40 actionable while also naming a qualifier
  // it believed absent, which read as a contradiction. It was not one - the two
  // numbers answered different questions about the same sentence - but a report
  // nobody can reconcile at a glance is a report nobody trusts. Coverage is now
  // the ONLY axis that is summed, every actionable item falls on exactly one
  // side of it, and the identity below is asserted on every run.
  const nonActionable =
    oracle.not_measurable.length +
    oracle.implementation_instructions.length +
    oracle.examples.length +
    oracle.background.length +
    oracle.document_metadata.length;

  const reconciliation = {
    oracle_actionable: actionable.length,
    covered: covered.length,
    missing: missing.length,
    identity: 'oracle_actionable = covered + missing',
    holds: actionable.length === covered.length + missing.length,
    non_actionable: nonActionable,
    oracle_total: actionable.length + nonActionable,
    note: 'discovered, extra, and the two verbatim checks are DIAGNOSTICS. None of them is summed into this identity: an item can be discovered or not, quoted or paraphrased, and is still either covered or missing, never both and never neither.',
  };

  return {
    oracle_version: oracle.oracle_version,
    reconciliation,
    totals: {
      oracle_total:
        actionable.length +
        oracle.not_measurable.length +
        oracle.implementation_instructions.length +
        oracle.examples.length +
        oracle.background.length +
        oracle.document_metadata.length,
      oracle_actionable: actionable.length,
      discovered: assessed.filter((item) => item.discovered).length,
      covered: covered.length,
      missing: missing.length,
      undiscovered: undiscovered.length,
      extra: extra.length,
      classification_errors: wronglyExcused.length + wronglyActionable.length,
      qualifier_not_verbatim: assessed.filter((item) => item.qualifier_not_verbatim.length > 0)
        .length,
      condition_not_verbatim: assessed.filter((item) => item.condition_not_verbatim.length > 0)
        .length,
      output_contract_loss: assessed.filter(
        (item) => item.classification === 'OUTPUT_CONTRACT' && !item.covered
      ).length,
    },
    by_classification: [
      'ACTIONABLE_BEHAVIOR',
      'QUALIFIER',
      'GUARD_CONDITION',
      'OUTPUT_CONTRACT',
    ].map((classification) => {
      const group = assessed.filter((item) => item.classification === classification);
      return {
        classification,
        total: group.length,
        covered: group.filter((item) => item.covered).length,
      };
    }),
    items: assessed,
    missing,
    undiscovered,
    extra,
    classification_errors: {
      wrongly_excused: wronglyExcused,
      wrongly_actionable: wronglyActionable,
    },
  };
}

/** A readable rendering of a comparison, for a report or a failing test. */
export function formatComparison(report) {
  const lines = [];
  const t = report.totals;

  const r = report.reconciliation;

  lines.push(`oracle ${report.oracle_version}`);
  lines.push(
    `RECONCILES: ${r.oracle_actionable} actionable = ${r.covered} covered + ${r.missing} missing ` +
      `${r.holds ? '[OK]' : '[BROKEN]'}   (+ ${r.non_actionable} non-actionable = ${r.oracle_total} total)`
  );
  lines.push(
    `total ${t.oracle_total} | actionable ${t.oracle_actionable} | discovered ${t.discovered} | ` +
      `covered ${t.covered} | missing ${t.missing} | extra ${t.extra}`
  );
  lines.push(
    `classification errors ${t.classification_errors} | output-contract loss ${t.output_contract_loss}`
  );
  lines.push(
    `qualifier not verbatim ${t.qualifier_not_verbatim} | condition not verbatim ${t.condition_not_verbatim} ` +
      `(phrase-level checks: read by hand, not all are real losses)`
  );

  lines.push('');
  for (const group of report.by_classification) {
    lines.push(`  ${group.classification.padEnd(20)} ${group.covered}/${group.total}`);
  }

  if (report.missing.length > 0) {
    lines.push('', 'MISSING:');
    for (const item of report.missing) {
      lines.push(`  ${item.id} [${item.classification}] p${item.source_page}`);
      lines.push(`     source   : ${item.source_text.slice(0, 150)}`);
      lines.push(`     expected : ${item.missing_evidence.map((g) => g.join('|')).join('  +  ')}`);
      lines.push(
        `     derived  : ${item.discovered ? item.discovered_as.join(', ') : 'NOT DERIVED BY THE OBLIGATION LAYER'}`
      );
    }
  }

  if (report.extra.length > 0) {
    lines.push('', 'EXTRA (derived by the run, not in the oracle):');
    for (const item of report.extra) {
      lines.push(`  ${item.obligation_id} [${item.type}] ${item.statement.slice(0, 110)}`);
      lines.push(`     basis: ${String(item.source_basis).replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }

  const errors = [
    ...report.classification_errors.wrongly_excused,
    ...report.classification_errors.wrongly_actionable,
  ];
  if (errors.length > 0) {
    lines.push('', 'CLASSIFICATION ERRORS:');
    for (const error of errors) {
      lines.push(`  ${error.oracle_id} <- ${error.obligation_ids.join(', ')}: ${error.why}`);
    }
  }

  return lines.join('\n');
}

/**
 * The full per-item trace: every actionable oracle item, what QATOOL did with
 * it, and the evidence.
 *
 * Separate from formatComparison because it is long and is read for a different
 * purpose - that one answers "did this run pass", this one answers "show me
 * every row so I can check the arithmetic myself".
 */
export function formatTrace(report) {
  const lines = [
    'ID      TYPE              ACT  DISC  COV  TESTCASES            EVIDENCE / WHY NOT',
    '------  ----------------  ---  ----  ---  -------------------  ------------------',
  ];

  const short = (type) =>
    ({
      ACTIONABLE_BEHAVIOR: 'BEHAVIOR',
      QUALIFIER: 'QUALIFIER',
      GUARD_CONDITION: 'GUARD',
      OUTPUT_CONTRACT: 'OUTPUT_CONTRACT',
    })[type] ?? type;

  for (const item of report.items) {
    const evidence = item.covered
      ? item.case_ids.slice(0, 3).join(' ')
      : `missing: ${item.missing_evidence.map((group) => group[0]).join(' + ')}`;

    lines.push(
      [
        item.id.padEnd(6),
        short(item.classification).padEnd(16),
        'yes'.padEnd(3),
        (item.discovered ? 'yes' : 'NO').padEnd(4),
        (item.covered ? 'yes' : 'NO').padEnd(3),
        (item.covered ? item.case_ids.join(',') : '-').slice(0, 19).padEnd(19),
        evidence,
      ].join('  ')
    );
  }

  lines.push('');
  lines.push(
    `actionable ${report.reconciliation.oracle_actionable} = ` +
      `covered ${report.reconciliation.covered} + missing ${report.reconciliation.missing}` +
      ` -> ${report.reconciliation.holds ? 'reconciles' : 'DOES NOT RECONCILE'}`
  );

  return lines.join('\n');
}
