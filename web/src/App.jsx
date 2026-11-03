import { useState } from 'react';
import { SessionPanel } from './components/SessionPanel.jsx';
import { SessionProvider } from './session/SessionProvider.jsx';
import { useConfig } from './state/appConfig.js';
import { CanonicalProvider, useCanonical } from './state/canonical.jsx';
import { StageNav } from './components/StageNav.jsx';
import { UploadStage } from './stages/UploadStage.jsx';
import { ProcessingStage } from './stages/ProcessingStage.jsx';
import { ResultsStage } from './stages/ResultsStage.jsx';
import { DownloadStage } from './stages/DownloadStage.jsx';

/**
 * A single-session batch workflow: Upload -> Processing -> Results -> Download.
 *
 * There is no project list and no routing, because there is nothing to route
 * to. One workflow lives in this tab until it is downloaded and cleared.
 */
function Wizard() {
  const { canonical, actions } = useCanonical();
  const [step, setStep] = useState('upload');
  const [download, setDownload] = useState(null);

  // The File objects the user chose. Held here rather than in the canonical
  // object because they are browser handles, not project data - and they are
  // what a retry re-reads without asking the user to pick them again.
  const [files, setFiles] = useState([]);

  // The user's pick for the NEXT run. undefined until they choose, so the
  // server's default applies. It is only a pick: a run takes a frozen copy of it
  // when it starts (actions.startRun), so changing it later cannot reach a run.
  const [modelChoice, setModelChoice] = useState(undefined);

  const hasResults = canonical.test_cases.length > 0 || canonical.requirements.length > 0;

  const reachable = ['upload'];
  if (hasResults) reachable.push('results');
  if (download) reachable.push('download');

  function startRun(choice) {
    actions.startRun(choice);
    setStep('processing');
  }

  function startNew() {
    actions.reset();
    setFiles([]);
    setModelChoice(undefined);
    setDownload(null);
    setStep('upload');
  }

  function handleDownloaded(result) {
    setDownload(result);
    setStep('download');
  }

  return (
    <div className="app">
      <header className="masthead">
        <h1>QATOOL</h1>
        <span className="tagline">AI drafts &middot; code validates &middot; QA decides</span>
        <span className="spacer" />
        {canonical.project.project_name && (
          <span className="badge">{canonical.project.project_name}</span>
        )}
      </header>

      <StageNav current={step} onSelect={setStep} reachable={reachable} />

      <main>
        <SessionPanel />

        {step === 'upload' && (
          <UploadStage
            onAdvance={setStep}
            onStartRun={startRun}
            files={files}
            onFilesChange={setFiles}
            modelChoice={modelChoice}
            onModelChoice={setModelChoice}
          />
        )}
        {step === 'processing' && (
          <ProcessingStage files={files} onAdvance={setStep} onBack={() => setStep('upload')} />
        )}
        {step === 'results' && <ResultsStage onDownloaded={handleDownloaded} />}
        {step === 'download' && (
          <DownloadStage
            result={download}
            onStartNew={startNew}
            onBack={() => setStep('results')}
          />
        )}
      </main>
    </div>
  );
}

export function App() {
  const { demo, problems } = useConfig();

  const workflow = (
    <CanonicalProvider>
      <Wizard />
    </CanonicalProvider>
  );

  // A demo build that is missing its settings shows what is missing instead of starting a session.
  if (!demo || problems.length > 0) return workflow;
  return <SessionProvider>{workflow}</SessionProvider>;
}
