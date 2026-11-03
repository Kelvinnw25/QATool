import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The pages as the public demo shows them, rendered with renderToStaticMarkup like the other
 * component tests: effects do not run, so nothing here reaches a network, and the markup is exactly
 * the state passed in. The same pages with the default (local) configuration are checked too, so a
 * change for the demo cannot quietly change the local tool.
 */

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let vite;
let mod = {};

before(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  vite = await createServer({
    root: webRoot,
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'error',
    plugins: [react()],
  });

  const load = (file) => vite.ssrLoadModule(file);
  mod = {
    ...(await load('/src/config.js')),
    ...(await load('/src/state/appConfig.js')),
    ...(await load('/src/state/canonical.jsx')),
    ...(await load('/src/session/SessionProvider.jsx')),
    ...(await load('/src/components/JobProgress.jsx')),
    ...(await load('/src/components/SessionPanel.jsx')),
    ...(await load('/src/stages/UploadStage.jsx')),
    ...(await load('/src/stages/ProcessingStage.jsx')),
    ...(await load('/src/stages/ResultsStage.jsx')),
  };
});

after(async () => {
  await vite?.close();
});

const demoConfig = () =>
  Object.freeze({
    ...mod.readConfig({
      VITE_PUBLIC_DEMO: 'true',
      VITE_API_BASE_URL: 'https://api.example.com',
      VITE_TURNSTILE_SITE_KEY: 'site-key',
    }),
  });

const session = (status, extra = {}) => ({
  required: true,
  ready: status === 'ready',
  manager: null,
  limits: { max_files: 30, max_file_bytes: 10 * 1024 * 1024, max_total_bytes: 20 * 1024 * 1024 },
  state: {
    status,
    reason: null,
    error: null,
    expiresAt: Date.UTC(2026, 10, 3, 12, 30),
    challenge: 0,
    ...extra,
  },
});

function inDemo(element, sessionValue = session('ready')) {
  return createElement(
    mod.ConfigContext.Provider,
    { value: demoConfig() },
    createElement(mod.SessionContext.Provider, { value: sessionValue }, element)
  );
}

const named = (project_name) => ({
  project: {
    project_name,
    project_description: null,
    project_summary: null,
    qa_guidance: null,
    project_background: null,
    sit_scope: [],
  },
  documents: [],
  requirements: [],
  test_cases: [],
});

const file = { name: 'prd.docx', size: 2048 };

function renderUpload(wrap, { files = [file], project = 'Demo' } = {}) {
  return renderToStaticMarkup(
    wrap(
      createElement(
        mod.CanonicalProvider,
        { initialCanonical: named(project) },
        createElement(mod.UploadStage, {
          onAdvance: () => {},
          onStartRun: () => {},
          files,
          onFilesChange: () => {},
          modelChoice: undefined,
          onModelChoice: () => {},
        })
      )
    )
  );
}

const processButton = (html) => /<button[^>]*>Process[^<]*<\/button>/.exec(html)?.[0] ?? '';

describe('the upload page in the public demo', () => {
  it('has no model selector', () => {
    const html = renderUpload(inDemo);
    assert.doesNotMatch(html, /ai-model|model-options|AI model|type="radio"/);
    assert.doesNotMatch(html, /Gemini|Claude|Apayee/);
  });

  it('shows the data-handling notice before anything is uploaded', () => {
    const html = renderUpload(inDemo, { files: [] });
    assert.match(html, /Before you upload/);
    assert.match(html, /sent to the QATOOL demo server/);
    assert.match(html, /sent to the AI service the server is configured to use/);
    assert.match(html, /memory for a short time/);
    assert.match(html, /no database/);
    // The notice names no provider: that is the server's business.
    assert.doesNotMatch(html, /Gemini|Claude|Apayee|Anthropic/);
  });

  it('keeps Process disabled until the session is ready, and says why', () => {
    const waiting = renderUpload((el) => inDemo(el, session('unverified')));
    assert.match(processButton(waiting), /disabled/);
    assert.match(waiting, /Verify your session above first/);

    const ready = renderUpload(inDemo);
    assert.match(processButton(ready), /Process 1 document/);
    assert.doesNotMatch(processButton(ready), /disabled/);
  });

  it('refuses files over the limits the session announced', () => {
    const html = renderUpload(inDemo, { files: [{ name: 'huge.pdf', size: 50 * 1024 * 1024 }] });
    assert.match(html, /huge\.pdf is too large/);
    assert.match(processButton(html), /disabled/);
  });

  it('is unchanged for the local tool: the picker is there and no session is needed', () => {
    const html = renderUpload((el) => el);
    assert.match(html, /AI model/);
    assert.doesNotMatch(html, /Before you upload/);
  });
});

describe('the session panel', () => {
  const panel = (value, config = demoConfig()) =>
    renderToStaticMarkup(
      createElement(
        mod.ConfigContext.Provider,
        { value: config },
        createElement(mod.SessionContext.Provider, { value }, createElement(mod.SessionPanel))
      )
    );

  it('renders nothing outside the demo', () => {
    assert.equal(
      renderToStaticMarkup(createElement(mod.SessionPanel)),
      '',
      'the local tool has no session to show'
    );
  });

  it('asks for verification, and explains that the session lives in memory only', () => {
    const html = panel(session('unverified'));
    assert.match(html, /Verify to start/);
    assert.match(html, /turnstile-box/);
    assert.match(html, /nothing is stored in your browser/);
  });

  it('shows verifying without a widget', () => {
    const html = panel(session('verifying'));
    assert.match(html, /Verifying/);
    assert.doesNotMatch(html, /turnstile-box/);
  });

  it('shows why verification failed and offers a fresh widget', () => {
    const html = panel(
      session('failed', {
        error: {
          code: 'TURNSTILE_FAILED',
          message: 'The verification did not pass. Please try again.',
          retryAfterSeconds: null,
        },
      })
    );
    assert.match(html, /did not pass/);
    assert.match(html, /turnstile-box/);
  });

  it('says the session ended when the ticket expired, and asks for a new verification', () => {
    const html = panel(session('expired', { reason: 'expired' }));
    assert.match(html, /Session ended/);
    assert.match(html, /Your session expired/);
    assert.match(html, /turnstile-box/);
  });

  it('shows a quiet confirmation once ready, with no widget', () => {
    const html = panel(session('ready'));
    assert.match(html, /Session ready/);
    assert.match(html, /reloading the page starts a new one/);
    assert.doesNotMatch(html, /turnstile-box/);
  });

  it('lists missing configuration instead of pretending to work', () => {
    const broken = Object.freeze(mod.readConfig({ VITE_PUBLIC_DEMO: 'true' }));
    const html = panel(session('unverified'), broken);
    assert.match(html, /not configured/);
    assert.match(html, /VITE_TURNSTILE_SITE_KEY/);
  });
});

describe('job progress', () => {
  const job = (extra) => ({
    id: 'j_1',
    state: 'queued',
    phase: null,
    position: 3,
    paused: false,
    processing_ms: 0,
    queue_wait_ms: 0,
    ...extra,
  });
  const labels = { generate: 'Generating test cases' };
  const show = (props) =>
    renderToStaticMarkup(
      createElement(mod.JobProgress, { phaseLabels: labels, onCancel() {}, ...props })
    );

  it('uploading: before there is a job', () => {
    assert.match(show({ job: null, submitting: true }), /Uploading/);
  });

  it('queued: shows the real position and offers cancel', () => {
    const html = show({ job: job({ position: 4 }) });
    assert.match(html, /Waiting in line/);
    assert.match(html, /number 4 in line/);
    assert.match(html, /Cancel job/);
  });

  it('queued while the AI service is paused: says so and keeps the place', () => {
    const html = show({ job: job({ paused: true }) });
    assert.match(html, /paused/);
    assert.match(html, /place in line is kept/);
  });

  it('processing: names the current backend phase and invents no percentage', () => {
    const html = show({
      job: job({ state: 'processing', phase: 'generate', processing_ms: 41_000, position: null }),
    });
    assert.match(html, /Processing/);
    assert.match(html, /Now: Generating test cases/);
    assert.match(html, /41s/);
    assert.doesNotMatch(html, /%/);
  });

  it('completed: no cancel button', () => {
    const html = show({ job: job({ state: 'completed', position: null }) });
    assert.match(html, /Completed/);
    assert.doesNotMatch(html, /Cancel job/);
  });

  it('upload busy: says it will retry and that the files are kept', () => {
    const html = show({
      job: null,
      waiting: { kind: 'upload_busy', seconds: 3, attempt: 1, of: 4 },
    });
    assert.match(html, /Trying again in 3s/);
    assert.match(html, /attempt 2 of 4/);
    assert.match(html, /files are kept/);
  });

  it('surfaces a long silence so a throttled tab is never silent', () => {
    const html = show({ job: job(), leaseGapMs: 52_000 });
    assert.match(html, /did not check on the job for 52s/);
    assert.match(html, /foreground/);
  });

  it('shows connection trouble while the job keeps running', () => {
    const html = show({ job: job(), trouble: { failures: 2, of: 5 } });
    assert.match(html, /Having trouble reaching the demo service/);
    assert.match(html, /keeps running on the server/);
  });

  it('shows cancelling', () => {
    assert.match(show({ job: job(), cancelling: true }), /Cancelling/);
  });
});

describe('the processing page in the demo', () => {
  it('shows the phases without a model line', () => {
    const html = renderToStaticMarkup(
      inDemo(
        createElement(
          mod.CanonicalProvider,
          { initialCanonical: named('Demo') },
          createElement(mod.ProcessingStage, { files: [file], onAdvance() {}, onBack() {} })
        )
      )
    );
    assert.match(html, /Extracting requirements from documents/);
    assert.doesNotMatch(html, /Model for this run/);
  });
});

describe('results that carry no provider', () => {
  const generation = { warnings: [], metadata: { requirement_count: 2, duration_ms: 2500 } };
  const render = (validation, config = demoConfig()) =>
    renderToStaticMarkup(
      createElement(
        mod.ConfigContext.Provider,
        { value: config },
        createElement(
          mod.CanonicalProvider,
          {
            initialCanonical: {
              ...named('Demo'),
              test_cases: [
                {
                  case_id: 'TC-001',
                  requirement_ids: ['REQ-001'],
                  warnings: [],
                  title: 't',
                },
              ],
            },
            initialValidation: validation,
            initialGeneration: generation,
          },
          createElement(mod.ResultsStage, { onDownloaded() {}, detailed: true })
        )
      )
    );

  const validation = (semantic) => ({
    valid: true,
    schema_issues: [],
    reference_issues: [],
    semantic_warnings: [],
    coverage: { uncovered: [], partial: [], by_requirement: [] },
    testcase_diagnostics: [],
    semantic,
  });

  it('says an AI model drafted it, never "undefined"', () => {
    const html = render(validation({ llm: 'completed', discarded_issues: 0, error: null }));
    assert.match(html, /Drafted by an AI model from/);
    assert.doesNotMatch(html, /undefined/);
  });

  it('does not print an empty provider for the review', () => {
    const html = render(validation({ llm: 'completed', discarded_issues: 0, error: null }));
    assert.match(html, /Checked by rules and by an AI review\./);
  });

  it('explains a failed review from its code, since the demo sends no message', () => {
    const html = render(validation({ llm: 'failed', error: { code: 'LLM_TIMEOUT' } }));
    assert.match(html, /The AI review did not run\./);
    assert.match(html, /did not answer in time/);
    assert.doesNotMatch(html, /undefined/);
  });
});
