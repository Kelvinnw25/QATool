import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The model picker and the two pages that depend on it.
 *
 * Rendered with renderToStaticMarkup, like the Results page tests: effects do
 * not run, so nothing here reaches the network, and the markup is exactly the
 * state passed in. Components are loaded through Vite because Node cannot parse
 * JSX.
 */

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let vite;
let ModelSelector;
let CanonicalProvider;
let UploadStage;
let ProcessingStage;

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

  ({ ModelSelector } = await vite.ssrLoadModule('/src/components/ModelSelector.jsx'));
  ({ CanonicalProvider } = await vite.ssrLoadModule('/src/state/canonical.jsx'));
  ({ UploadStage } = await vite.ssrLoadModule('/src/stages/UploadStage.jsx'));
  ({ ProcessingStage } = await vite.ssrLoadModule('/src/stages/ProcessingStage.jsx'));
});

after(async () => {
  await vite?.close();
});

const GEMINI = { id: 'gemini', label: 'Gemini', available: true, reason: null, code: null };
const CLAUDE_DOWN = {
  id: 'claude',
  label: 'Claude via Apayee',
  available: false,
  reason: 'Apayee is running with the mock provider, so Claude is not available.',
  code: 'provider_not_ready',
};
const CLAUDE_UP = { ...CLAUDE_DOWN, available: true, reason: null, code: null };

const listOf = (claude, extra = {}) => ({
  default: 'gemini',
  providers: [GEMINI, claude],
  ...extra,
});

function renderSelector(props) {
  return renderToStaticMarkup(
    createElement(ModelSelector, { status: 'ready', onChange: () => {}, locked: false, ...props })
  );
}

/** The <label> that holds one option, so assertions are about that option alone. */
function option(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `<label class="model-option">(?:(?!</label>).)*${escaped}.*?</label>`,
    's'
  ).exec(html);
  assert.ok(match, `no option labelled ${label}`);
  return match[0];
}

describe('the model selector', () => {
  it('selects Gemini by default and offers it as available', () => {
    const html = renderSelector({ list: listOf(CLAUDE_DOWN), choice: 'gemini' });
    const gemini = option(html, 'Gemini');

    assert.match(gemini, /checked/);
    assert.doesNotMatch(gemini, /disabled/);
    assert.match(gemini, /Available/);
  });

  it('shows Claude disabled, with the backend’s reason, while it is unavailable', () => {
    const html = renderSelector({ list: listOf(CLAUDE_DOWN), choice: 'gemini' });
    const claude = option(html, 'Claude via Apayee');

    assert.match(claude, /disabled/);
    assert.doesNotMatch(claude, /checked/);
    assert.match(claude, /Unavailable/);
    assert.match(claude, /Apayee is running with the mock provider, so Claude is not available\./);
  });

  it('makes Claude selectable once the backend reports it available - with no code change', () => {
    const html = renderSelector({ list: listOf(CLAUDE_UP), choice: 'claude' });
    const claude = option(html, 'Claude via Apayee');

    assert.doesNotMatch(claude, /disabled/);
    assert.match(claude, /checked/);
    assert.match(claude, /Available/);
    assert.doesNotMatch(option(html, 'Gemini'), /checked/);
  });

  it('shows whatever reason the backend gives, not text of its own', () => {
    const reason = 'A reason this file has never seen.';
    const html = renderSelector({
      list: listOf({ ...CLAUDE_DOWN, reason }),
      choice: 'gemini',
    });
    assert.match(option(html, 'Claude via Apayee'), /A reason this file has never seen\./);
  });

  it('never offers a mock option, and no field for a URL or a credential', () => {
    for (const list of [listOf(CLAUDE_DOWN), listOf(CLAUDE_UP), null]) {
      const html = renderSelector({ list, choice: list ? 'gemini' : null });

      // The backend’s reason may say "mock"; what must not exist is a mock CHOICE.
      assert.doesNotMatch(html, /value="mock"/i);
      assert.doesNotMatch(html, /<span class="model-name">[^<]*mock/i);
      assert.doesNotMatch(html, /type="(text|password|url)"/);
      assert.doesNotMatch(html, /<input(?![^>]*type="radio")/);
    }
  });

  it('locks every choice while a run is in progress, and says why', () => {
    const html = renderSelector({ list: listOf(CLAUDE_UP), choice: 'claude', locked: true });

    assert.match(html, /<fieldset class="model-options" disabled="">/);
    assert.match(html, /A run is in progress\. The model cannot be changed until it ends\./);
  });

  it('leaves the choice open when no run is going', () => {
    const html = renderSelector({ list: listOf(CLAUDE_UP), choice: 'gemini' });

    assert.doesNotMatch(html, /<fieldset[^>]*disabled/);
    assert.doesNotMatch(html, /A run is in progress/);
  });

  it('offers the server default only when there is no list, or the server’s own is outside it', () => {
    const noList = renderSelector({ status: 'error', list: null, choice: null });
    assert.match(noList, /Server default/);
    assert.match(noList, /Could not check which models are available/);

    const legacy = renderSelector({
      list: listOf(CLAUDE_DOWN, { default: null, default_note: 'Set by the operator.' }),
      choice: null,
    });
    assert.match(option(legacy, 'Server default'), /checked/);
    assert.match(legacy, /Set by the operator\./);

    const gateway = renderSelector({
      list: listOf(CLAUDE_DOWN, {
        default: null,
        default_label: 'Server default (Apayee gateway)',
        default_note: 'Every call goes to the Apayee gateway.',
      }),
      choice: null,
    });
    assert.match(option(gateway, 'Server default (Apayee gateway)'), /checked/);

    const normal = renderSelector({ list: listOf(CLAUDE_UP), choice: 'gemini' });
    assert.doesNotMatch(normal, /Server default/);
  });

  it('says it is checking while the list loads', () => {
    const html = renderSelector({ status: 'loading', list: null, choice: null });
    assert.match(html, /Checking which models are available/);
  });
});

describe('the Upload page', () => {
  const render = (initialRun) =>
    renderToStaticMarkup(
      createElement(
        CanonicalProvider,
        { initialRun },
        createElement(UploadStage, {
          onAdvance: () => {},
          onStartRun: () => {},
          files: [{ name: 'prd.pdf', size: 10 }],
          onFilesChange: () => {},
          modelChoice: undefined,
          onModelChoice: () => {},
        })
      )
    );

  it('puts the model card between the project and the documents', () => {
    const html = render(null);
    const at = (text) => html.indexOf(text);

    assert.ok(at('Project name') < at('AI model'));
    assert.ok(at('AI model') < at('Source documents'));
  });

  it('cannot start a second run, or change the model, while one is going', () => {
    const run = Object.freeze({
      id: 1,
      provider: 'claude',
      label: 'Claude via Apayee',
      active: true,
    });
    const html = render(run);

    assert.match(html, /<fieldset class="model-options" disabled="">/);
    assert.match(html, /A run is still in progress; wait for it to finish\./);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Process 1 document\(s\)<\/button>/);
  });

  it('lets a new run start, with a different model, once the last one has ended', () => {
    const ended = Object.freeze({
      id: 1,
      provider: 'claude',
      label: 'Claude via Apayee',
      active: false,
    });
    const html = render(ended);

    assert.doesNotMatch(html, /<fieldset[^>]*disabled/);
    assert.doesNotMatch(html, /A run is still in progress/);
  });
});

describe('the Processing page', () => {
  it('shows the model the run was started with and that it will not change', () => {
    const run = Object.freeze({
      id: 3,
      provider: 'claude',
      label: 'Claude via Apayee',
      active: true,
    });
    const html = renderToStaticMarkup(
      createElement(
        CanonicalProvider,
        { initialRun: run },
        createElement(ProcessingStage, { files: [], onAdvance: () => {}, onBack: () => {} })
      )
    );

    assert.match(html, /Model for this run: <span class="badge">Claude via Apayee<\/span>/);
    assert.match(html, /fixed for every\s*step and every retry/);
  });

  it('names the server default honestly when no model was chosen', () => {
    const run = Object.freeze({ id: 1, provider: null, label: 'Server default', active: true });
    const html = renderToStaticMarkup(
      createElement(
        CanonicalProvider,
        { initialRun: run },
        createElement(ProcessingStage, { files: [], onAdvance: () => {}, onBack: () => {} })
      )
    );

    assert.match(html, /<span class="badge">Server default<\/span>/);
  });
});
