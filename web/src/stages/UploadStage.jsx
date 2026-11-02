import { useRef, useState } from 'react';
import { api } from '../api.js';
import { ModelSelector } from '../components/ModelSelector.jsx';
import { effectiveChoice, labelFor, startBlocker } from '../providers.js';
import { useProviders } from '../useProviders.js';
import { useCanonical } from '../state/canonical.jsx';

const ACCEPT = '.pdf,.docx,.xlsx';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadStage({
  onAdvance,
  onStartRun,
  files,
  onFilesChange,
  modelChoice,
  onModelChoice,
}) {
  const { canonical, run, actions } = useCanonical();
  const { status, list } = useProviders();

  // A run still going, started from this page earlier: its model is fixed, so
  // the picker is locked and a second run cannot be started beside it.
  const runInProgress = run?.active === true;
  const choice = effectiveChoice(list, modelChoice);
  const blocker = startBlocker({ status, list, choice });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const hasName = canonical.project.project_name.trim() !== '';

  function addFiles(fileList) {
    const incoming = [...fileList];
    if (incoming.length === 0) return;

    // Same name and size twice is a double-click, not two documents.
    const key = (file) => `${file.name}:${file.size}`;
    const existing = new Set(files.map(key));
    onFilesChange([...files, ...incoming.filter((file) => !existing.has(key(file)))]);
    setError(null);
  }

  async function loadSample() {
    setLoading(true);
    try {
      actions.replaceAll(await api.sampleCanonical());
      setError(null);
      onAdvance('results');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {error && <div className="notice error">{error}</div>}

      <div className="card">
        <h2>Project</h2>
        <label className="field">
          <span>Project name</span>
          <input
            type="text"
            value={canonical.project.project_name}
            placeholder="e.g. Bulk Credit Transfer Phase 2"
            onChange={(event) => actions.patchProject({ project_name: event.target.value })}
          />
        </label>
      </div>

      <ModelSelector
        status={status}
        list={list}
        choice={choice}
        onChange={onModelChoice}
        locked={runInProgress}
      />

      <div className="card">
        <h2>Source documents</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          PDF, DOCX and XLSX. Files are parsed in memory and discarded &mdash; nothing is written to
          disk, and only the filename is kept as metadata.
        </p>

        <div
          className="dropzone"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            addFiles(event.dataTransfer.files);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          Drop PRD, RFC or supporting documents here, or click to choose.
        </div>

        {files.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Filename</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {files.map((file, index) => (
                <tr key={`${file.name}:${file.size}`}>
                  <td>{file.name}</td>
                  <td className="muted">{formatSize(file.size)}</td>
                  <td>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => onFilesChange(files.filter((unused, i) => i !== index))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button
            type="button"
            disabled={files.length === 0 || !hasName || blocker !== null || runInProgress}
            onClick={() => onStartRun({ provider: choice, label: labelFor(list, choice) })}
          >
            Process {files.length > 0 ? `${files.length} document(s)` : 'documents'}
          </button>
          {!hasName && files.length > 0 && (
            <span className="muted">Give the project a name first.</span>
          )}
          {blocker && files.length > 0 && hasName && <span className="muted">{blocker}</span>}
          {runInProgress && (
            <span className="muted">A run is still in progress; wait for it to finish.</span>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Or try it without documents</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          Load a fixed sample workflow to see the Results page and download a real SIT Script from
          the office template. It uses canned content and makes no LLM call.
        </p>
        <button type="button" className="secondary" onClick={loadSample} disabled={loading}>
          {loading ? 'Loading...' : 'Load sample workflow'}
        </button>
      </div>
    </>
  );
}
