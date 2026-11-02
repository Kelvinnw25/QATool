import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  beginRun,
  classifyLlmError,
  currentRun,
  LLM_ERROR_CATEGORIES,
  newRunId,
  recordFacts,
  recordTiming,
  setStage,
  summarise,
  trace,
  withRun,
} from './trace.js';
import { LlmError, LLM_ERRORS } from '../llm/provider.js';

/**
 * Run tracing, tested as a unit.
 *
 * Two properties matter more than the rest and are asserted hardest:
 *
 *   one run, one id     every event in a request must carry the same run_id, or
 *                       the logs cannot be joined back together and the whole
 *                       thing is worthless.
 *   nothing leaks       a tracer that emits a prompt, a document body or an API
 *                       key is worse than no tracer, because it turns a log
 *                       file into a copy of the confidential input.
 */

/** A pino-shaped logger that keeps what it was given. */
function recorder() {
  const lines = [];
  return { lines, info: (fields) => lines.push(fields) };
}

describe('run ids', () => {
  it('formats as QATOOL-YYYYMMDD-XXXXXX', () => {
    const id = newRunId(new Date('2026-09-24T10:00:00Z'));

    assert.match(id, /^QATOOL-20260924-[0-9A-F]{6}$/);
  });

  it('pads single-digit months and days', () => {
    assert.match(newRunId(new Date('2026-01-05T10:00:00Z')), /^QATOOL-20260105-/);
  });

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRunId()));

    assert.equal(ids.size, 200, 'two runs in one process must never share an id');
  });
});

describe('the run context', () => {
  it('reuses one id across every stage of a run', () => {
    const logger = recorder();

    withRun({ logger }, () => {
      trace('request_received');
      setStage('EXTRACT');
      trace('extraction_started');
      setStage('GENERATE');
      trace('gemini_2_started', { call_number: 2 });
    });

    const ids = new Set(logger.lines.map((line) => line.run_id));
    assert.equal(ids.size, 1, 'one run, one id');
    assert.equal(logger.lines.length, 3);
  });

  it('labels each event with the stage that was current when it fired', () => {
    const logger = recorder();

    withRun({ logger }, () => {
      trace('request_received');
      setStage('EXTRACT');
      trace('extraction_started');
      setStage('REVIEW');
      trace('review_started');
    });

    assert.deepEqual(
      logger.lines.map((line) => `${line.stage}:${line.event}`),
      ['REQUEST:request_received', 'EXTRACT:extraction_started', 'REVIEW:review_started']
    );
  });

  it('is a no-op outside a run rather than an error', () => {
    // The same modules are called by tests, scripts and the qa-eval harness,
    // none of which starts a run. Emitting must never be the thing that breaks.
    assert.equal(currentRun(), null);
    assert.doesNotThrow(() => {
      trace('extraction_started', { file_count: 1 });
      setStage('EXTRACT');
      recordTiming('extract', 10);
      recordFacts({ files: 1 });
    });
  });

  it('keeps concurrent runs apart', async () => {
    const first = recorder();
    const second = recorder();

    await Promise.all([
      withRun({ logger: first }, async () => {
        trace('request_received');
        await new Promise((resolve) => setTimeout(resolve, 5));
        trace('request_completed');
      }),
      withRun({ logger: second }, async () => {
        trace('request_received');
        await new Promise((resolve) => setTimeout(resolve, 1));
        trace('request_completed');
      }),
    ]);

    const firstIds = new Set(first.lines.map((line) => line.run_id));
    const secondIds = new Set(second.lines.map((line) => line.run_id));

    assert.equal(firstIds.size, 1);
    assert.equal(secondIds.size, 1);
    assert.notEqual([...firstIds][0], [...secondIds][0], 'two requests are two runs');
  });

  it('beginRun attaches a run to the surrounding context', async () => {
    // What the Fastify onRequest hook relies on: no wrapping function, and the
    // run survives the awaits that follow.
    const logger = recorder();

    await withRun({ logger: recorder() }, async () => {
      const run = beginRun({ logger });
      trace('request_received');
      await new Promise((resolve) => setImmediate(resolve));
      trace('request_completed');

      assert.equal(currentRun().id, run.id, 'the run survived an await');
    });

    assert.equal(new Set(logger.lines.map((line) => line.run_id)).size, 1);
  });
});

describe('LLM error classification', () => {
  const cases = [
    [LLM_ERRORS.RATE_LIMITED, 429, LLM_ERROR_CATEGORIES.RATE_LIMITED],
    [LLM_ERRORS.TIMEOUT, 504, LLM_ERROR_CATEGORIES.TIMEOUT],
    [LLM_ERRORS.UNAVAILABLE, 503, LLM_ERROR_CATEGORIES.UNAVAILABLE],
    [LLM_ERRORS.UNAVAILABLE, 502, LLM_ERROR_CATEGORIES.NETWORK_ERROR],
    [LLM_ERRORS.MALFORMED_OUTPUT, 502, LLM_ERROR_CATEGORIES.PARSE_ERROR],
    [LLM_ERRORS.TRUNCATED, 502, LLM_ERROR_CATEGORIES.PARSE_ERROR],
    [LLM_ERRORS.AUTH_FAILED, 502, LLM_ERROR_CATEGORIES.UNKNOWN],
    [LLM_ERRORS.NOT_CONFIGURED, 500, LLM_ERROR_CATEGORIES.UNKNOWN],
  ];

  for (const [code, statusCode, expected] of cases) {
    it(`classifies ${code} (${statusCode}) as ${expected}`, () => {
      assert.equal(classifyLlmError(new LlmError(code, 'message', statusCode)), expected);
    });
  }

  /**
   * 503 and 502 share a code and must not share a category. A 503 is refused
   * capacity that still costs a quota request and clears by waiting; a 502 is
   * a transport failure that does not. Telling a user to wait is right for one
   * and wrong for the other.
   */
  it('separates provider overload from transport failure', () => {
    assert.notEqual(
      classifyLlmError(new LlmError(LLM_ERRORS.UNAVAILABLE, 'overloaded', 503)),
      classifyLlmError(new LlmError(LLM_ERRORS.UNAVAILABLE, 'unreachable', 502))
    );
  });

  it('never throws on something that is not an LLM error', () => {
    assert.equal(classifyLlmError(new TypeError('nope')), LLM_ERROR_CATEGORIES.UNKNOWN);
    assert.equal(classifyLlmError(null), LLM_ERROR_CATEGORIES.UNKNOWN);
    assert.equal(classifyLlmError(undefined), LLM_ERROR_CATEGORIES.UNKNOWN);
  });
});

describe('redaction and safe fields', () => {
  it('drops any field whose name could carry content', () => {
    const logger = recorder();

    withRun({ logger }, () => {
      trace('gemini_1_started', {
        prompt: 'the entire document text',
        system: 'the entire system instruction',
        description: 'a requirement body',
        quote: 'a verbatim source quote',
        response: 'the whole model reply',
        test_case: 'a drafted action',
        expected_result: 'a drafted outcome',
        documents: 'everything uploaded',
        api_key: 'AIzaSyABCDEFGHIJKLMNOP',
        authorization: 'Bearer sk-abcdef1234567890',
        block_count: 252,
      });
    });

    const [line] = logger.lines;
    assert.equal(line.block_count, 252, 'the diagnostic count survives');

    for (const forbidden of [
      'prompt',
      'system',
      'description',
      'quote',
      'response',
      'test_case',
      'expected_result',
      'documents',
      'api_key',
      'authorization',
    ]) {
      assert.ok(!(forbidden in line), `${forbidden} must never be emitted`);
    }
  });

  it('redacts key-shaped strings that arrive under an innocent name', () => {
    const logger = recorder();

    withRun({ logger }, () => {
      trace('gemini_1_failed', {
        error_message: 'Request failed for key AIzaSyABCDEFGHIJKLMNOP at ?key=abcdef123456',
      });
    });

    const [line] = logger.lines;
    assert.ok(!line.error_message.includes('AIzaSyABCDEFGHIJKLMNOP'));
    assert.match(line.error_message, /\[redacted\]/);
  });

  it('truncates a long value rather than emitting a document', () => {
    const logger = recorder();

    withRun({ logger }, () => {
      trace('parser_completed', { note: 'x'.repeat(5000) });
    });

    const [line] = logger.lines;
    assert.ok(line.note.length < 250, 'a 5000-character value cannot reach the log whole');
    assert.match(line.note, /\[truncated\]$/);
  });

  it('reduces an array of objects to its length', () => {
    const logger = recorder();

    withRun({ logger }, () => {
      trace('extraction_completed', {
        warning_codes: ['LOW_EXTRACTED_TEXT', 'PARSER_LIMITATION'],
        issues: [{ secret: 'content' }, { secret: 'more content' }],
      });
    });

    const [line] = logger.lines;
    assert.deepEqual(line.warning_codes, ['LOW_EXTRACTED_TEXT', 'PARSER_LIMITATION']);
    assert.equal(line.issues, 2, 'objects are content until proven otherwise');
  });

  it('replaces a nested object with a marker', () => {
    const logger = recorder();

    withRun({ logger }, () => {
      trace('gemini_2_completed', { usage: { input_tokens: 10, secret_text: 'a document' } });
    });

    assert.equal(logger.lines[0].usage, '[object]');
  });
});

describe('the run summary', () => {
  it('reports a success with its timings and facts', () => {
    const logger = recorder();
    let line;

    withRun({ logger }, (run) => {
      recordTiming('extract', 4100);
      recordTiming('gemini1', 5200);
      recordFacts({ files: 1, block_count: 252, testcases: 15 });
      line = summarise(run, { status: 'SUCCESS' });
    });

    assert.match(line, /^RUN QATOOL-\d{8}-[0-9A-F]{6} \| status=SUCCESS \| total=\d+\.\ds/);
    assert.match(line, /extract=4\.1s/);
    assert.match(line, /gemini1=5\.2s/);
    assert.match(line, /files=1/);
    assert.match(line, /block_count=252/);
    assert.match(line, /testcases=15/);
  });

  it('reports a failure with the stage it stopped at', () => {
    const logger = recorder();
    let line;

    withRun({ logger }, (run) => {
      setStage('EXTRACT');
      line = summarise(run, { status: 'FAILED', reason: 'EXTRACTION_FAILED', failSoft: false });
    });

    assert.match(line, /status=FAILED/);
    assert.match(line, /stage=EXTRACT/);
    assert.match(line, /reason=EXTRACTION_FAILED/);
    assert.match(line, /fail_soft=false/);
  });

  it('reports a degraded run as degraded, not as success', () => {
    const logger = recorder();
    let line;

    withRun({ logger }, (run) => {
      setStage('EXTRACT');
      recordFacts({ fallback_used: true });
      line = summarise(run, { status: 'DEGRADED', reason: '503', failSoft: true });
    });

    assert.match(line, /status=DEGRADED/);
    assert.match(line, /reason=503/);
    assert.match(line, /fail_soft=true/);
  });

  it('never carries content into the summary', () => {
    const logger = recorder();
    let line;

    withRun({ logger }, (run) => {
      recordFacts({ description: 'a requirement body', prompt: 'a prompt', files: 2 });
      line = summarise(run, { status: 'SUCCESS' });
    });

    assert.match(line, /files=2/);
    assert.ok(!line.includes('a requirement body'));
    assert.ok(!line.includes('a prompt'));
  });
});
