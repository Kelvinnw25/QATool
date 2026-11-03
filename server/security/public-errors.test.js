import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../lib/errors.js';
import { LlmError, LLM_ERRORS } from '../llm/provider.js';
import { ProviderUnavailableError } from '../llm/catalog.js';
import { assertProviderAccess } from './provider-policy.js';
import { presentError, publicProviderList, scrub } from './public-errors.js';

const INTERNAL = /apayee|127\.0\.0\.1|localhost|:4100|http:\/\/|C:\\|\/home\/|APAYEE_|claude cli/i;

describe('outside public mode errors are unchanged', () => {
  it('relays an AppError exactly', () => {
    const error = new LlmError(
      LLM_ERRORS.UNAVAILABLE,
      'Could not reach Apayee at http://apayee:4100.',
      502
    );
    const shown = presentError(error, { publicMode: false });
    assert.equal(shown.status, 502);
    assert.match(shown.body.message, /apayee:4100/);
  });

  it("relays the framework's client errors", () => {
    const error = Object.assign(new Error('Unexpected token'), {
      statusCode: 400,
      code: 'FST_ERR',
    });
    assert.equal(presentError(error, { publicMode: false }).body.message, 'Unexpected token');
  });

  it('leaves unexpected errors to the handler', () => {
    assert.deepEqual(presentError(new Error('boom'), { publicMode: true }), { expected: false });
    assert.deepEqual(presentError(new Error('boom'), { publicMode: false }), { expected: false });
  });
});

describe('in public mode', () => {
  it('describes a provider failure by its kind, never by what it said', () => {
    const leaky = [
      new LlmError(
        LLM_ERRORS.UNAVAILABLE,
        'Could not reach Apayee at http://apayee:4100 (ECONNREFUSED). Check APAYEE_BASE_URL.',
        502
      ),
      new LlmError(
        LLM_ERRORS.AUTH_FAILED,
        'Apayee rejected the credentials. Check APAYEE_TOKEN on the server.',
        502
      ),
      new LlmError(
        LLM_ERRORS.NOT_CONFIGURED,
        "Apayee's provider is not ready, the Claude CLI is signed out.",
        503
      ),
      new LlmError(
        LLM_ERRORS.RATE_LIMITED,
        "Apayee's provider reported a usage limit for the subscription.",
        429
      ),
      new LlmError(LLM_ERRORS.TIMEOUT, 'Apayee did not respond within 180 seconds.', 504),
      new LlmError(
        LLM_ERRORS.MALFORMED_OUTPUT,
        'Apayee returned a reply that is not a generation result.',
        502
      ),
    ];

    for (const error of leaky) {
      const shown = presentError(error, { publicMode: true });
      assert.equal(shown.status, error.statusCode, 'the status is kept');
      assert.equal(shown.body.code, error.code, 'the code is kept');
      assert.doesNotMatch(shown.body.message, INTERNAL, shown.body.message);
      assert.doesNotMatch(shown.logMessage, INTERNAL, 'the log gets the same text');
    }
  });

  it('reduces an unavailable provider to a coarse reason', () => {
    const error = new ProviderUnavailableError('claude', {
      reason: 'Apayee is running with the mock provider, so Claude is not available.',
      code: 'provider_not_ready',
    });
    const shown = presentError(error, { publicMode: true });
    assert.equal(shown.status, 503);
    assert.equal(shown.body.provider, 'claude');
    assert.equal(shown.body.reason_code, 'unavailable');
    assert.doesNotMatch(JSON.stringify(shown.body), /apayee|mock/i);

    const missing = new ProviderUnavailableError('gemini', {
      reason: 'Gemini is not configured on the server.',
      code: 'not_configured',
    });
    assert.equal(presentError(missing, { publicMode: true }).body.reason_code, 'not_configured');
  });

  it('replaces messages that quote an uploaded filename or a parser', () => {
    const name = 'ClientX-Secret-Merger-PRD.pdf';
    for (const code of [
      'EMPTY_DOCUMENT',
      'UNSUPPORTED_FILE_TYPE',
      'CORRUPT_DOCUMENT',
      'PARSER_FAILURE',
    ]) {
      const error = new AppError(
        code,
        `'${name}' failed: Invalid PDF structure at C:\\tmp\\x`,
        422
      );
      const shown = presentError(error, { publicMode: true });
      assert.doesNotMatch(shown.body.message, /ClientX|Invalid PDF|C:\\/);
      assert.doesNotMatch(shown.logMessage, /ClientX/);
    }
  });

  it("masks the uploaded filename in an extraction failure's text but keeps the field", () => {
    const name = 'Acme-Merger-PRD-v3.docx';
    const error = new AppError('EXTRACTION_FAILED', `'${name}' is empty.`, 422, [
      { document_id: 'DOC-001', filename: name, message: `'${name}' is empty.` },
    ]);

    const shown = presentError(error, { publicMode: true });
    assert.doesNotMatch(shown.body.message, /Acme/);
    assert.doesNotMatch(shown.logMessage, /Acme/, 'nor does the log');
    assert.doesNotMatch(shown.body.details[0].message, /Acme/);
    assert.equal(shown.body.details[0].filename, name, 'the structured field is kept');
    assert.equal(shown.body.details[0].document_id, 'DOC-001');
  });

  it('leaves the filename in the text when not in public mode', () => {
    const error = new AppError('EXTRACTION_FAILED', "'a-name.docx' is empty.", 422, [
      { document_id: 'DOC-001', filename: 'a-name.docx', message: "'a-name.docx' is empty." },
    ]);
    assert.match(presentError(error, { publicMode: false }).body.message, /a-name\.docx/);
  });

  it('cuts addresses and paths out of any other message', () => {
    const error = new AppError(
      'SOMETHING',
      'Failed at http://apayee:4100/v1/generate reading C:\\Users\\kelvi\\x.txt and /app/server/a.js',
      500
    );
    const { body } = presentError(error, { publicMode: true });
    assert.doesNotMatch(body.message, INTERNAL);
    assert.match(body.message, /\[address\]/);
    assert.match(body.message, /\[path\]/);
  });

  it("does not quote the body that broke the framework's parser", () => {
    const error = Object.assign(
      new SyntaxError('Unexpected token \'s\', "secret-document-text" is not valid JSON'),
      {
        statusCode: 400,
        code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      }
    );
    const shown = presentError(error, { publicMode: true });
    assert.equal(shown.status, 400);
    assert.doesNotMatch(JSON.stringify(shown), /secret-document-text/);
  });

  it('keeps the useful, safe messages', () => {
    const error = new AppError('FILE_TOO_LARGE', 'A document exceeds the 10 MB limit.', 413);
    assert.equal(
      presentError(error, { publicMode: true }).body.message,
      'A document exceeds the 10 MB limit.'
    );
  });
});

describe('scrub', () => {
  it('handles empty and non-string input', () => {
    assert.equal(scrub(undefined), '');
    assert.equal(scrub(null), '');
    assert.equal(scrub(42), '42');
  });
});

describe('the provider list a public-mode caller sees', () => {
  const list = {
    default: null,
    default_label: 'Server default (Apayee gateway)',
    default_note: 'Every call goes to the Apayee gateway (LLM_PROVIDER=apayee).',
    providers: [
      {
        id: 'gemini',
        label: 'Gemini',
        available: false,
        reason: 'Gemini is not configured on the server.',
        code: 'not_configured',
      },
      {
        id: 'claude',
        label: 'Claude via Apayee',
        available: false,
        reason: 'Apayee rejected the server’s credentials.',
        code: 'gateway_auth_failed',
      },
    ],
  };

  it('keeps what can be chosen and drops why it cannot', () => {
    const shown = publicProviderList(list);
    assert.deepEqual(
      shown.providers.map((p) => [p.id, p.available, p.code]),
      [
        ['gemini', false, 'not_configured'],
        ['claude', false, 'unavailable'],
      ]
    );
    // The label ("Claude via Apayee") is what the picker shows and stays; the
    // reasons, codes and notes are what describe the setup and must not.
    const described = JSON.stringify([
      shown.providers.map((p) => [p.reason, p.code]),
      shown.default_label,
    ]);
    assert.doesNotMatch(described, /apayee|credential|LLM_PROVIDER|gateway|mock/i);
    assert.equal('default_note' in shown, false);
  });

  it('reports an available provider with no reason', () => {
    const shown = publicProviderList({
      default: 'gemini',
      providers: [{ id: 'gemini', label: 'Gemini', available: true, reason: null, code: null }],
    });
    assert.deepEqual(shown.providers[0], {
      id: 'gemini',
      label: 'Gemini',
      available: true,
      reason: null,
      code: null,
    });
  });
});

describe('provider access policy', () => {
  const requestFor = (publicMode, identity) => ({ server: { security: { publicMode } }, identity });

  it('does nothing outside public mode', () => {
    assert.doesNotThrow(() => assertProviderAccess(requestFor(false, null)));
    assert.doesNotThrow(() => assertProviderAccess({ server: {}, identity: undefined }));
  });

  it('lets the verified owner choose', () => {
    assert.doesNotThrow(() => assertProviderAccess(requestFor(true, { owner: true, id: 'abc' })));
  });

  it('refuses everyone else in public mode, with the same answer', () => {
    for (const identity of [null, undefined, {}, { owner: false }, { id: 'abc' }]) {
      assert.throws(
        () => assertProviderAccess(requestFor(true, identity)),
        (error) =>
          error instanceof AppError && error.statusCode === 403 && error.code === 'FORBIDDEN'
      );
    }
  });
});
