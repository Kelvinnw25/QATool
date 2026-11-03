/**
 * Where a job is, in words a visitor can follow.
 *
 * Presentational. It shows what the backend reported and nothing it did not: the queue position and
 * the phase come from the job, the times are the job's own, and there is no percentage because the
 * backend does not give one.
 *
 * @param {object} props
 * @param {object | null} props.job  the latest job view from the backend, once accepted
 * @param {string} props.fromLabel  what is being sent while no job exists yet
 * @param {{ kind: string, seconds: number, attempt: number, of: number } | null} props.waiting
 * @param {boolean} props.submitting  the request is in flight (uploading and reading the files)
 * @param {number | null} props.leaseGapMs  the page went quiet for this long between answers
 * @param {{ failures: number, of: number } | null} props.trouble
 * @param {boolean} props.cancelling
 * @param {() => void} props.onCancel
 * @param {Record<string, string>} props.phaseLabels
 */
export function JobProgress({
  job,
  fromLabel = 'your documents',
  waiting = null,
  submitting = false,
  leaseGapMs = null,
  trouble = null,
  cancelling = false,
  onCancel,
  phaseLabels = {},
}) {
  const live = job && (job.state === 'queued' || job.state === 'processing');

  return (
    <div className="job-progress" aria-live="polite">
      {waiting && (
        <div className="notice">
          The demo is busy reading other uploads. Trying again in {waiting.seconds}s (attempt{' '}
          {waiting.attempt + 1} of {waiting.of}). Your files are kept.
        </div>
      )}

      {!job && submitting && !waiting && (
        <p className="job-line">
          <span className="job-state">Uploading</span> Sending {fromLabel} and reading them. This
          can take a few seconds.
        </p>
      )}

      {job?.state === 'queued' && (
        <p className="job-line">
          <span className="job-state">Waiting in line</span>
          {job.paused
            ? ' The AI service is paused for a short while; your place in line is kept and the job continues by itself.'
            : ` You are number ${job.position} in line. Jobs run first come, first served, and this page keeps checking for you.`}
        </p>
      )}

      {job?.state === 'processing' && (
        <p className="job-line">
          <span className="job-state">Processing</span>{' '}
          {job.phase ? `Now: ${phaseLabels[job.phase] ?? job.phase}.` : 'Starting.'}{' '}
          <span className="muted">
            Running for {Math.round(job.processing_ms / 1000)}s
            {job.queue_wait_ms > 1500
              ? `, after ${Math.round(job.queue_wait_ms / 1000)}s in line`
              : ''}
            .
          </span>
        </p>
      )}

      {job?.state === 'completed' && (
        <p className="job-line">
          <span className="job-state ok">Completed</span>
        </p>
      )}

      {trouble && (
        <div className="notice">
          Having trouble reaching the demo service &mdash; retrying ({trouble.failures} of{' '}
          {trouble.of}). Your job keeps running on the server.
        </div>
      )}

      {leaseGapMs !== null && (
        <div className="notice">
          This page did not check on the job for {Math.round(leaseGapMs / 1000)}s (browsers slow
          down tabs in the background). A job nobody checks on for 45s is stopped, so keep this tab
          in the foreground while it runs.
        </div>
      )}

      {live && (
        <div className="row">
          <button type="button" className="secondary" onClick={onCancel} disabled={cancelling}>
            {cancelling ? 'Cancelling...' : 'Cancel job'}
          </button>
          <span className="muted">Stops the job and frees its place for someone else.</span>
        </div>
      )}
    </div>
  );
}
