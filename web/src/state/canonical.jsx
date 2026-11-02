import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { mergeCanonical } from './merge.js';
import { RunLedger, withActivity } from './run.js';

/**
 * The temporary working state for one workflow.
 *
 * QATOOL V1 is a batch generator, not a review system: documents go in, outputs
 * come out, and the user reviews the result in Excel afterwards. So this holds
 * only what is needed to produce the outputs, it lives in React memory alone -
 * no database, no server session, no browser storage - and it is cleared only
 * by an explicit "Start New Workflow" after a confirmed download.
 *
 * Nothing here edits generated content. A failed step leaves everything in
 * place so the user can retry without re-uploading or re-processing.
 */
export function createEmptyCanonical() {
  return {
    project: {
      project_name: '',
      project_description: null,
      project_summary: null,
      qa_guidance: null,
      project_background: null,
      sit_scope: [],
    },
    documents: [],
    requirements: [],
    test_cases: [],
  };
}

const CanonicalContext = createContext(null);

/**
 * `initialCanonical` and `initialValidation` seed the starting state. The app
 * always starts empty; tests use them to render a specific point in the
 * workflow through the real provider rather than a stand-in for it.
 */
export function CanonicalProvider({
  children,
  initialCanonical,
  initialValidation = null,
  initialGeneration = null,
  initialRun = null,
}) {
  const [canonical, setCanonical] = useState(() => initialCanonical ?? createEmptyCanonical());

  /** Validation and coverage metadata. Derived, so it sits beside the canonical
   *  object rather than inside it. */
  const [validation, setValidation] = useState(initialValidation);

  /** What the last generation run reported about itself: warnings the canonical
   *  object has no field for, and which provider produced it. Derived like
   *  validation, so it sits beside the canonical object rather than inside it -
   *  canonicalProjectSchema is strict and would reject an extra key. */
  const [generation, setGeneration] = useState(initialGeneration);

  /** The current run: its model, frozen when it began, and whether it is still going.
   *  Beside the canonical object for the same reason as validation: it is about
   *  the run, not the project, and the canonical schema is strict. */
  const ledger = useRef(null);
  ledger.current ??= new RunLedger();
  const [run, setRun] = useState(initialRun);

  const startRun = useCallback((choice) => {
    const next = ledger.current.begin(choice);
    setRun(next);
    return next;
  }, []);

  const isCurrentRun = useCallback((id) => ledger.current.isCurrent(id), []);

  const setRunActive = useCallback((id, active) => {
    if (!ledger.current.isCurrent(id)) return;
    setRun((current) => (current?.id === id ? withActivity(current, active) : current));
  }, []);

  const patchProject = useCallback((patch) => {
    setCanonical((current) => ({ ...current, project: { ...current.project, ...patch } }));
  }, []);

  /** Merges one pipeline phase's output in, leaving earlier phases intact so a
   *  later failure never costs the work already done. */
  const mergePhase = useCallback((partial) => {
    setCanonical((current) => mergeCanonical(current, partial));
  }, []);

  const replaceAll = useCallback((next) => {
    ledger.current.retire();
    setRun(null);
    setCanonical(next);
    setValidation(null);
    setGeneration(null);
  }, []);

  const reset = useCallback(() => {
    ledger.current.retire();
    setRun(null);
    setCanonical(createEmptyCanonical());
    setValidation(null);
    setGeneration(null);
  }, []);

  const actions = useMemo(
    () => ({
      patchProject,
      mergePhase,
      replaceAll,
      setValidation,
      setGeneration,
      reset,
      startRun,
      isCurrentRun,
      setRunActive,
    }),
    [patchProject, mergePhase, replaceAll, reset, startRun, isCurrentRun, setRunActive]
  );

  const value = useMemo(
    () => ({ canonical, validation, generation, run, actions }),
    [canonical, validation, generation, run, actions]
  );

  return <CanonicalContext.Provider value={value}>{children}</CanonicalContext.Provider>;
}

export function useCanonical() {
  const context = useContext(CanonicalContext);
  if (!context) throw new Error('useCanonical must be used inside a CanonicalProvider.');
  return context;
}

/** Requirement lookup by REQ id, for rendering the traceability chain. */
export function indexRequirements(requirements) {
  return new Map(requirements.map((requirement) => [requirement.requirement_id, requirement]));
}

/** Document lookup by DOC id, for resolving a source reference to a filename. */
export function indexDocuments(documents) {
  return new Map(documents.map((document) => [document.document_id, document]));
}
