import { useState } from 'react';

/**
 * Copies generated text to the clipboard.
 *
 * The outputs are meant to be pasted into a ticket, an email or the SIT
 * circulation, so copying is the whole delivery mechanism for four of the five.
 * navigator.clipboard needs a secure context and can be blocked by policy, so
 * there is a fallback and a visible failure rather than a silent no-op.
 */
export function CopyButton({ value, label = 'Copy' }) {
  const [state, setState] = useState('idle');

  async function copy() {
    const text = String(value ?? '');
    if (text === '') return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        legacyCopy(text);
      }
      setState('copied');
    } catch {
      try {
        legacyCopy(text);
        setState('copied');
      } catch {
        setState('failed');
      }
    }

    setTimeout(() => setState('idle'), 1800);
  }

  return (
    <button type="button" className="secondary copy" onClick={copy} disabled={!value}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy blocked' : label}
    </button>
  );
}

/** For browsers or policies where the async clipboard API is unavailable. */
function legacyCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('Copy command was rejected.');
}
