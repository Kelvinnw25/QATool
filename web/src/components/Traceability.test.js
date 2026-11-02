import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The traceability chain, and specifically what it does with references a
 * reader cannot tell apart.
 *
 * Structuring builds one source reference per block the model cited, so a
 * requirement assembled from eight blocks carries eight references. Only the
 * document, page and section are rendered, and section is the nearest heading -
 * so bullets sharing a heading used to arrive as a column of identical lines.
 * These tests pin the collapse, and pin the thing the collapse must never do:
 * hide that several passages back the requirement.
 */

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let vite;
let Traceability;

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

  ({ Traceability } = await vite.ssrLoadModule('/src/components/Traceability.jsx'));
});

after(async () => {
  await vite?.close();
});

const documents = () => new Map([['DOC-001', { filename: 'PRD_Settlement.pdf' }]]);

/** One heading, six bullets under it - each its own block, each its own quote. */
function wrappedCriteria() {
  const section = 'WHEN a transaction status has successfully achieved Settled or Released';
  return [
    {
      document_id: 'DOC-001',
      page: 4,
      section: 'Scenario Acceptance Criteria Jira Link',
      quote: 'link',
    },
    { document_id: 'DOC-001', page: 4, section: 'Settlement Report menu', quote: 'menu' },
    ...[
      'add column',
      'display column',
      'include timestamp',
      'sort by date',
      'format date',
      'persist',
    ].map((quote) => ({ document_id: 'DOC-001', page: 4, section, quote })),
  ];
}

function render(references) {
  return renderToStaticMarkup(
    createElement(Traceability, {
      testCase: { requirement_ids: ['REQ-003'], source_references: [] },
      requirements: new Map([
        ['REQ-003', { title: 'Add Release Date and Time Column', source_references: references }],
      ]),
      documents: documents(),
    })
  );
}

describe('source references a reader cannot tell apart', () => {
  it('shows one line per distinct document, page and section', () => {
    const html = render(wrappedCriteria());
    const lines = html.match(/<li>/g) ?? [];

    assert.equal(lines.length, 3, 'eight references, three distinguishable places');
  });

  it('says how many passages were collapsed, rather than dropping them', () => {
    const html = render(wrappedCriteria());

    assert.match(html, /6 passages/, 'the six bullets are still accounted for');
  });

  it('does not count a place that appeared once', () => {
    const html = render(wrappedCriteria());

    assert.doesNotMatch(html, /1 passages/, 'a single reference reads as a plain line');
  });

  it('keeps references apart when only the section differs', () => {
    const html = render([
      { document_id: 'DOC-001', page: 4, section: 'Settlement Report menu', quote: 'a' },
      { document_id: 'DOC-001', page: 4, section: 'Scenario Acceptance Criteria', quote: 'b' },
    ]);

    assert.equal((html.match(/<li>/g) ?? []).length, 2);
    assert.doesNotMatch(html, /passages/);
  });

  it('keeps references apart when only the page differs', () => {
    const html = render([
      { document_id: 'DOC-001', page: 4, section: 'Settlement Report menu', quote: 'a' },
      { document_id: 'DOC-001', page: 6, section: 'Settlement Report menu', quote: 'b' },
    ]);

    assert.equal((html.match(/<li>/g) ?? []).length, 2);
  });

  /**
   * A DOCX has no pagination, so page is legitimately null there. Null must
   * group with null rather than being treated as a difference.
   */
  it('groups references from a document with no pagination', () => {
    const html = render([
      { document_id: 'DOC-001', page: null, section: 'Ketentuan', quote: 'a' },
      { document_id: 'DOC-001', page: null, section: 'Ketentuan', quote: 'b' },
    ]);

    assert.equal((html.match(/<li>/g) ?? []).length, 1);
    assert.match(html, /2 passages/);
  });

  it('still reports a requirement with no source reference at all', () => {
    assert.match(render([]), /No source reference recorded/);
  });
});

describe("a test case's own source references", () => {
  /**
   * They are a subset of the requirement's, so listing them again produced a
   * second block of lines the reader had just read directly above.
   */
  it('are not rendered as a separate list', () => {
    const html = renderToStaticMarkup(
      createElement(Traceability, {
        testCase: {
          requirement_ids: ['REQ-003'],
          source_references: [
            { document_id: 'DOC-001', page: 5, section: 'Report', quote: 'already shown above' },
          ],
        },
        requirements: new Map([
          [
            'REQ-003',
            {
              title: 'Auto-Generate Daily Settlement Report',
              source_references: [
                { document_id: 'DOC-001', page: 5, section: 'Report', quote: 'a' },
              ],
            },
          ],
        ]),
        documents: documents(),
      })
    );

    assert.doesNotMatch(html, /Cited directly/);
    assert.equal((html.match(/<li>/g) ?? []).length, 1, 'the place is listed once, not twice');
  });

  it('does not stop the requirement chain being shown', () => {
    const html = renderToStaticMarkup(
      createElement(Traceability, {
        testCase: { requirement_ids: ['REQ-003'], source_references: [] },
        requirements: new Map([
          [
            'REQ-003',
            {
              title: 'Auto-Generate Daily Settlement Report',
              source_references: [
                { document_id: 'DOC-001', page: 5, section: 'Report', quote: 'a' },
              ],
            },
          ],
        ]),
        documents: documents(),
      })
    );

    assert.match(html, /REQ-003/);
    assert.match(html, /PRD_Settlement\.pdf/);
    assert.match(html, /page 5/);
  });
});
