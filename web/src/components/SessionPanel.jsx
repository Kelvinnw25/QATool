import { useEffect, useRef, useState } from 'react';

import { useConfig } from '../state/appConfig.js';
import { useSession } from '../session/SessionProvider.jsx';
import { loadTurnstile, renderWidget } from '../session/turnstile.js';

/**
 * Whether this page load is a reload, which is how a visitor loses a session without meaning to.
 * Read from the browser's navigation timing; nothing is stored to know it.
 */
export function wasReloaded(performanceApi = globalThis.performance) {
  try {
    return performanceApi?.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
  } catch {
    return false;
  }
}

/** The Turnstile widget. Rebuilt (by `key`) whenever a spent token must be replaced. */
function TurnstileWidget({ siteKey, action, onToken }) {
  const container = useRef(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [problem, setProblem] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let widget = null;
    let cancelled = false;
    setProblem(null);

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widget = renderWidget(container.current, {
          turnstile,
          siteKey,
          action,
          onToken: (token) => onTokenRef.current(token),
          onError: () =>
            setProblem('The verification widget reported an error. Reload the page or try again.'),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setProblem(
            'The verification widget could not be loaded. Check your connection (or a blocker ' +
              'that stops challenges.cloudflare.com), then try again.'
          );
        }
      });

    return () => {
      cancelled = true;
      widget?.remove();
    };
  }, [siteKey, action, attempt]);

  return (
    <>
      <div ref={container} className="turnstile-box" />
      {problem && (
        <div className="notice error">
          {problem}{' '}
          <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
    </>
  );
}

const WHY = {
  expired: 'Your session expired. Verify again to keep going.',
  rejected: 'The demo no longer accepts your session. Verify again to keep going.',
  reset: 'Verify again to keep going.',
};

/**
 * The visitor's session, always visible in the demo.
 *
 * Ready: one quiet line. Anything else: the explanation and the Turnstile widget, because nothing
 * that talks to the backend works without a ticket. The session lives only in this tab's memory,
 * and the page says so.
 */
export function SessionPanel() {
  const { demo, problems, turnstileSiteKey, turnstileAction } = useConfig();
  const session = useSession();

  if (!demo) return null;

  if (problems.length > 0) {
    return (
      <div className="notice error" role="alert">
        <strong>The public demo is not configured.</strong>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      </div>
    );
  }

  const { state, manager } = session;

  if (state.status === 'ready') {
    return (
      <div className="notice ok session-line">
        <strong>Session ready.</strong> Valid until{' '}
        {new Date(state.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
        It lives only in this tab&rsquo;s memory &mdash; reloading the page starts a new one.
      </div>
    );
  }

  const busy = state.status === 'verifying';
  const reloaded = state.status === 'unverified' && wasReloaded();

  return (
    <div className="card session-card">
      <h2>{state.status === 'expired' ? 'Session ended' : 'Verify to start'}</h2>

      {reloaded && (
        <div className="notice">
          This page was reloaded, so your previous session was reset. Any job you had running could
          not be reattached &mdash; it stops by itself within about a minute &mdash; and your
          documents and results in this page are gone. Verify again to start over.
        </div>
      )}
      {state.status === 'expired' && <div className="notice">{WHY[state.reason] ?? WHY.reset}</div>}
      {state.status === 'failed' && state.error && (
        <div className="notice error" role="alert">
          {state.error.message}
          {state.error.retryAfterSeconds
            ? ` (Try again in about ${state.error.retryAfterSeconds} seconds.)`
            : ''}
        </div>
      )}

      <p className="muted" style={{ marginTop: -4 }}>
        A quick check that you are a person, so the demo&rsquo;s limited capacity is shared fairly.
        No account is needed and nothing is stored in your browser.
      </p>

      {busy ? (
        <p className="muted">Verifying&hellip;</p>
      ) : (
        <TurnstileWidget
          key={state.challenge}
          siteKey={turnstileSiteKey}
          action={turnstileAction}
          onToken={(token) => manager.start(token)}
        />
      )}
    </div>
  );
}
