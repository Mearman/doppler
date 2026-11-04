import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Button, MantineProvider, Progress } from '@mantine/core';
import '@mantine/core/styles.css';
import { decodeAudioFile, isWav } from '../../src/browser/decode-audio';
import { ANALYSIS_STAGES, type AnalysisStage } from './worker-protocol';
import * as styles from '../styles.css';
import { MapIcon, WaveIcon } from './icons';
import { LocationMap } from './location-map';
import { useOfflineStatus } from './offline-status';
import { SpectrogramViewer } from './spectrogram-viewer';
import { TopBar } from './top-bar';
import { useFlightData } from './use-flight-data';
import { type SearchArea, useLiveFeed } from './use-live-feed';
import { useMicrophone } from './use-microphone';
import { useSolver } from './use-solver';
import { UnifiedSidebar } from './unified-sidebar';

/** What each stage of an analysis is doing, as the progress line says it. */
const STAGE_LABELS: Readonly<Record<AnalysisStage, string>> = {
  decoding: 'Reading the recording',
  decimating: 'Filtering and downsampling',
  spectrogram: 'Computing the spectrogram',
  tracking: 'Tracking flyovers',
  locating: 'Locating the observer',
};

/** Bytes at the start of a file that the WAV check reads: the RIFF tag, its size field and the WAVE form type. */
const WAV_SNIFF_BYTES = 12;

type StageView = 'map' | 'spectrogram';

export function App(): React.JSX.Element {
  const solver = useSolver();
  const { session, analysis } = solver;
  const flightData = useFlightData(solver);
  const [searchArea, setSearchArea] = useState<SearchArea>({ lat: 0, lon: 0, radiusKm: 0 });
  const liveFeed = useLiveFeed(solver, searchArea);
  const microphone = useMicrophone({ onObservation: solver.ingestObservation, onError: solver.reportError });
  // A release installs by itself only while nothing is running; the session is autosaved, so the reload keeps the results.
  const offline = useOfflineStatus({ safeToReload: analysis === null && !microphone.isListening });
  const [stageView, setStageView] = useState<StageView>('map');
  const busy = analysis !== null;

  const analyseFile = async (file: Readonly<File>): Promise<void> => {
    try {
      const bytes = await file.arrayBuffer();
      const id = `file_${String(Date.now())}`;
      const startEpochSec = Math.floor(Date.now() / 1000);
      const label = `Analyzing ${file.name}`;
      // A WAV file decodes in the worker, so a long recording does not freeze the page while it is read into samples; other formats need the browser's decoder, which exists only on the page.
      if (isWav(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, WAV_SNIFF_BYTES)))) {
        solver.startAnalysis({ id, type: 'process_wav', payload: { bytes, startEpochSec, episodeId: file.name } }, label, [bytes]);

        return;
      }

      const { samples, sampleRateHz } = await decodeAudioFile(bytes);
      solver.startAnalysis({ id, type: 'process_audio', payload: { rawSamples: samples, sampleRateHz, startEpochSec, episodeId: file.name } }, label, [samples.buffer]);
    } catch (err) {
      solver.reportError(`${file.name} could not be read as audio: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={styles.app}>
      <TopBar offline={offline} enf={session?.enfSignature} />

      {offline.updateAvailable && (
        <Alert className={styles.banner} color="blue" title="Update available" role="status">
          <div className={styles.bannerBody}>
            <span>A newer version is ready. It installs when the current analysis or listening stops, and your session returns after the reload.</span>
            <Button size="compact-sm" onClick={offline.applyUpdate}>
              Reload to update
            </Button>
          </div>
        </Alert>
      )}

      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <div className={styles.panel}>
            {busy && (
              <div className={styles.busy}>
                <Progress
                  value={analysis.stage === null ? 100 : ((ANALYSIS_STAGES.indexOf(analysis.stage) + 1) / ANALYSIS_STAGES.length) * 100}
                  animated
                  size="sm"
                  aria-label="Analysing audio"
                />
                <p className={styles.busyText} role="status" aria-live="polite">
                  <strong>{analysis.label}</strong>
                  <span>{analysis.stage === null ? 'Starting analysis' : STAGE_LABELS[analysis.stage]}</span>
                </p>
              </div>
            )}
            {solver.error !== null && (
              <Alert color="red" role="alert" withCloseButton onClose={solver.dismissError}>
                {solver.error}
              </Alert>
            )}
            <UnifiedSidebar
              microphone={microphone}
              busy={busy}
              onFile={analyseFile}
              session={session}
              datasetInfo={solver.datasetInfo}
              flightData={flightData}
              liveFeed={liveFeed}
              searchArea={searchArea}
              onUpdateConstraints={solver.updateConstraints}
              onSetTemperature={solver.setTemperature}
              onResetSession={solver.resetSession}
            />
          </div>
        </aside>

        <main className={styles.stage}>
          <div className={styles.stageSwitch} role="group" aria-label="Show">
            <button type="button" aria-pressed={stageView === 'map'} onClick={() => { setStageView('map'); }}>
              <MapIcon size={16} />
              Map
            </button>
            <button type="button" aria-pressed={stageView === 'spectrogram'} onClick={() => { setStageView('spectrogram'); }}>
              <WaveIcon size={16} />
              Spectrogram
            </button>
          </div>
          <div className={styles.stagePane} data-hidden={stageView !== 'map'}>
            <LocationMap session={session} onOpenResult={() => { /* no-op in unified layout */ }} onAreaChange={setSearchArea} onError={solver.reportError} />
          </div>
          <div className={`${styles.stagePane} ${styles.spectrogramPane}`} data-hidden={stageView !== 'spectrogram'}>
            <SpectrogramViewer
              clipSpectrogram={solver.clip}
              isListening={microphone.isListening}
              liveFrames={microphone.liveFrames}
              observations={session?.observations ?? []}
              onClearLive={microphone.clearFrames}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

const rootElem = document.getElementById('root');
if (rootElem !== null) {
  createRoot(rootElem).render(
    <MantineProvider defaultColorScheme="dark">
      <App />
    </MantineProvider>,
  );
}
