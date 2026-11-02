import { useState } from 'react';
import { api, downloadBlob } from '../api.js';
import { useCanonical } from '../state/canonical.jsx';

/**
 * Confirmation, and the only place working memory is cleared.
 *
 * Clearing is deliberately manual. A browser download can fail after the
 * request succeeds - blocked, cancelled, no disk space - and auto-clearing
 * would destroy a workflow that cost a full processing run to produce, with no
 * way to retry. So the session stays in memory, re-downloadable, until the user
 * says they have the file.
 */
export function DownloadStage({ result, onStartNew, onBack }) {
  const { canonical } = useCanonical();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function downloadAgain() {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await api.exportWorkbook(canonical);
      downloadBlob(blob, filename);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="notice error">{error}</div>}

      <div className="card">
        <h2>Download complete</h2>
        <div className="notice ok">
          <strong>{result?.filename}</strong> &mdash; {result?.rowCount} test case rows, generated
          from the office SIT template.
        </div>

        <ul className="checklist">
          <li>Existing sample rows cleared; the template file itself is unchanged.</li>
          <li>
            <strong>Status</strong> and <strong>Tested By</strong> left blank for SIT execution.
          </li>
          <li>Dropdown ranges extended to cover every generated row.</li>
          <li>
            Edge cases mapped to Positive/Negative and marked <code>[Edge Case] </code>.
          </li>
        </ul>

        <div className="row">
          <button type="button" className="secondary" onClick={downloadAgain} disabled={busy}>
            {busy ? 'Generating...' : 'Download again'}
          </button>
          <button type="button" className="secondary" onClick={onBack}>
            Back to results
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Finish</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          This workflow is still held in memory, so you can re-download or copy the text outputs.
          Starting a new workflow clears it permanently &mdash; nothing is stored anywhere, so it
          cannot be recovered afterwards.
        </p>
        <button type="button" onClick={onStartNew}>
          Start New Workflow
        </button>
      </div>
    </>
  );
}
