import { SERVER_DEFAULT_LABEL } from '../providers.js';

/**
 * The model for the next run.
 *
 * Presentational: it shows what the backend reported and reports what the user
 * picked. An unavailable model is disabled with the backend's reason, never
 * hidden and never described by this file - so it becomes selectable the moment
 * the backend says it is, with no change here.
 *
 * @param {object} props
 * @param {'loading' | 'ready' | 'error'} props.status
 * @param {object | null} props.list      GET /api/llm/providers
 * @param {string | null} props.choice    selected id; null is the server default
 * @param {(id: string | null) => void} props.onChange
 * @param {boolean} props.locked          a run is in progress
 */
export function ModelSelector({ status, list, choice, onChange, locked }) {
  // Offered only when it is what the server will use anyway: no list to choose
  // from, or a server whose own default is not one of the listed models.
  const showServerDefault = !list || list.default === null;

  return (
    <div className="card">
      <h2>AI model</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        One model does all three steps of a run: reading the requirements, drafting the test cases
        and the meaning review. It is fixed when processing starts; to use a different one, start a
        new run.
      </p>

      {status === 'error' && (
        <div className="notice">
          Could not check which models are available, so only the server&rsquo;s default can be
          used. It will be retried automatically.
        </div>
      )}

      {locked && (
        <div className="notice">
          A run is in progress. The model cannot be changed until it ends.
        </div>
      )}

      <fieldset className="model-options" disabled={locked}>
        <legend className="visually-hidden">AI model</legend>

        {showServerDefault && (
          <label className="model-option">
            <input
              type="radio"
              name="ai-model"
              value=""
              checked={choice === null}
              onChange={() => onChange(null)}
            />
            <span className="model-name">{list?.default_label ?? SERVER_DEFAULT_LABEL}</span>
            {list?.default_note && <span className="muted">{list.default_note}</span>}
          </label>
        )}

        {list?.providers.map((provider) => (
          <label key={provider.id} className="model-option">
            <input
              type="radio"
              name="ai-model"
              value={provider.id}
              checked={choice === provider.id}
              disabled={!provider.available}
              onChange={() => onChange(provider.id)}
            />
            <span className="model-name">{provider.label}</span>
            <span className={`badge ${provider.available ? 'ok' : 'warn'}`}>
              {provider.available ? 'Available' : 'Unavailable'}
            </span>
            {!provider.available && <span className="muted">{provider.reason}</span>}
          </label>
        ))}

        {status === 'loading' && (
          <span className="muted">Checking which models are available...</span>
        )}
      </fieldset>
    </div>
  );
}
