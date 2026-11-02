import { CopyButton } from './CopyButton.jsx';

/**
 * One generated text output, read-only, with a copy button.
 *
 * Read-only is the point: QATOOL prepares the material and the reviewer edits
 * it wherever it is going to be used. There is no in-app editing to keep in
 * sync with anything.
 */
export function OutputCard({ title, hint, value, children }) {
  const empty = value === null || value === undefined || value === '';

  return (
    <div className="card output">
      <div className="output-head">
        <h2>{title}</h2>
        <CopyButton value={empty ? '' : value} />
      </div>
      {hint && (
        <p className="muted output-hint" title={hint}>
          {hint}
        </p>
      )}
      {empty ? (
        <p className="muted">Not generated. Run Processing to produce this output.</p>
      ) : (
        (children ?? <p className="output-body">{value}</p>)
      )}
    </div>
  );
}
