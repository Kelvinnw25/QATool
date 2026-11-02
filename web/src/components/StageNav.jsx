export const STEPS = [
  { key: 'upload', label: 'Upload' },
  { key: 'processing', label: 'Processing' },
  { key: 'results', label: 'Results' },
  { key: 'download', label: 'Download' },
];

/**
 * A linear progress indicator, not navigation.
 *
 * This is a batch pipeline: each step consumes the previous one's output, so
 * there is nothing to jump to. Steps already completed are clickable so a user
 * can look back at the results after downloading; steps ahead are not.
 */
export function StageNav({ current, onSelect, reachable }) {
  const currentIndex = STEPS.findIndex((step) => step.key === current);

  return (
    <nav className="stage-nav" aria-label="Workflow progress">
      {STEPS.map((step, index) => {
        const isCurrent = step.key === current;
        const isComplete = index < currentIndex;
        const canVisit = reachable.includes(step.key) && !isCurrent;

        return (
          <button
            key={step.key}
            type="button"
            className={`stage-step${isCurrent ? ' current' : ''}${isComplete ? ' done' : ''}`}
            aria-current={isCurrent ? 'step' : undefined}
            disabled={!canVisit}
            onClick={() => canVisit && onSelect(step.key)}
          >
            <span className="stage-index">{isComplete ? '✓' : index + 1}</span>
            <span>{step.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
