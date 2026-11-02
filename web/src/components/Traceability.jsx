/**
 * The traceability chain, rendered wherever a test case is shown:
 *
 *   Test Case -> Requirement -> Source Document -> Page / Section
 *
 * This is the reason the canonical model exists. The exported workbook cannot
 * carry any of it, so if it is not visible here it is not visible anywhere.
 *
 * A test case carries its own source references too, and they are deliberately
 * not rendered as a second list. In practice they are a subset of the
 * references on the requirement it cites - measured on the real PRD, all three
 * of a case's own references already appeared in the list directly above it -
 * so the second list restated lines the reader had just read. The chain is
 * unchanged; what was removed is the repetition of it.
 */
export function Traceability({ testCase, requirements, documents }) {
  const linked = testCase.requirement_ids
    .map((requirementId) => ({ requirementId, requirement: requirements.get(requirementId) }))
    .filter(Boolean);

  if (linked.length === 0) {
    return (
      <p className="trace-empty">
        No requirement linked. This test case traces back to nothing &mdash; validation will flag
        it.
      </p>
    );
  }

  return (
    <div className="trace">
      {linked.map(({ requirementId, requirement }) => (
        <div key={requirementId} className="trace-req">
          <div>
            <span className="badge mono">{requirementId}</span>{' '}
            {requirement ? (
              requirement.title
            ) : (
              <span className="danger-text">Unknown requirement &mdash; no longer present</span>
            )}
          </div>

          {requirement && (
            <SourceList references={requirement.source_references} documents={documents} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Groups references a reader cannot tell apart.
 *
 * These are not duplicates in the data. Structuring builds one reference per
 * block the model cited, so a requirement assembled from eight blocks carries
 * eight references, each with its own verbatim quote. But only the document,
 * page and section are shown, and `section` is the nearest heading - so six
 * separate criterion bullets under one WHEN heading arrive as six identical
 * lines, and a reviewer reads the same sentence six times for no information.
 *
 * Collapsing to what is actually distinct, and counting what was collapsed,
 * keeps the provenance honest: the count says six passages back this, so
 * nothing is quietly dropped from the chain.
 */
function groupReferences(references) {
  const groups = new Map();

  for (const reference of references) {
    const key = [reference.document_id, reference.page ?? '', reference.section ?? ''].join('|');
    const existing = groups.get(key);

    if (existing) existing.count += 1;
    else groups.set(key, { key, reference, count: 1 });
  }

  return [...groups.values()];
}

function SourceList({ references, documents }) {
  if (references.length === 0) {
    return <div className="trace-source muted">No source reference recorded.</div>;
  }

  return (
    <ul className="trace-sources">
      {groupReferences(references).map(({ key, reference, count }) => {
        const document = documents.get(reference.document_id);
        return (
          <li key={key}>
            <span className="badge mono">{reference.document_id}</span>{' '}
            {document ? document.filename : <span className="danger-text">unknown document</span>}
            {/* DOCX has no fixed pagination, so page is legitimately absent
                there and section carries the traceability instead. */}
            {reference.page !== null && reference.page !== undefined && (
              <span className="muted"> &middot; page {reference.page}</span>
            )}
            {reference.section && <span className="muted"> &middot; {reference.section}</span>}
            {count > 1 && <span className="muted"> &middot; {count} passages</span>}
          </li>
        );
      })}
    </ul>
  );
}
