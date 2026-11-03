import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Anchor, Badge, Button, Card, Group, MantineProvider, Progress, Stack, Tabs, Text } from '@mantine/core';
import '@mantine/core/styles.css';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { decodeAudioFile } from '../../src/browser/decode-audio';
import { MicMonitor } from '../../src/browser/mic-monitor';
import { loadSessionsFromStorage, saveSessionToStorage } from '../../src/browser/storage';
import { BUNDLED_GROUND_TRUTH, generateBundledReferenceAudio } from '../../src/bundled';
import { ellipseOutline } from '../../src/physics/geo';
import type { ComputedSingleFrame } from '../../src/dsp/spectrogram';
import { type LocationHypothesis, type LocationSession, LocationSessionSchema } from '../../src/schemas';
import { WorkerReplySchema } from './worker-protocol';
import * as styles from '../styles.css';
import { buildIdentity } from './build-info';
import { describeBuild } from '../describe-build';
import { useOfflineStatus, type OfflineStatus } from './offline-status';
import { SpectrogramViewer, type ClipSpectrogramData } from './spectrogram-viewer';
import { TILE_URL_TEMPLATE } from './tiles';

function formatCpaTimestamp(cpaTimeSec: number): string {
  if (cpaTimeSec > 1_000_000_000) {
    return new Date(cpaTimeSec * 1000).toLocaleTimeString();
  }
  const mins = Math.floor(cpaTimeSec / 60);
  const secs = (cpaTimeSec % 60).toFixed(1);

  return mins > 0 ? `${String(mins)}m ${secs}s` : `${secs}s`;
}

interface OfflineBadge {
  readonly label: string;
  readonly color: string;
}

function describeOffline(status: Readonly<OfflineStatus>): OfflineBadge {
  if (status.support === 'unavailable') {
    return { label: 'Offline use unavailable', color: 'red' };
  }
  if (status.support === 'preparing') {
    return { label: 'Preparing offline use', color: 'yellow' };
  }

  return status.online
    ? { label: 'Offline ready', color: 'green' }
    : { label: 'Offline: stored map tiles only', color: 'orange' };
}

/** Median noise floor threshold in dB above which audio is flagged as noise polluted. */
const NOISE_POLLUTED_THRESHOLD_DB = -65;

export function App(): React.JSX.Element {
  const [session, setSession] = useState<LocationSession | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>('live');
  const [isListening, setIsListening] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [noiseFloorDb, setNoiseFloorDb] = useState(-82);
  const [isNoisePolluted, setIsNoisePolluted] = useState(false);
  const [activeFlyoverCount, setActiveFlyoverCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('Select an audio file or start live listening.');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Id of the audio analysis the worker is running, or null when idle. Only one runs at a time, because a second would race the first for the session.
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  // A release installs by itself only while nothing is running; the session is autosaved, so the reload keeps the results.
  const offline = useOfflineStatus({ safeToReload: analysisId === null && !isListening });
  const [liveFrames, setLiveFrames] = useState<ComputedSingleFrame[]>([]);
  const [clipSpectrogram, setClipSpectrogram] = useState<ClipSpectrogramData | null>(null);


  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const markersLayer = useRef<L.LayerGroup | null>(null);
  const ellipseLayer = useRef<L.LayerGroup | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const micMonitorRef = useRef<MicMonitor | null>(null);

  useEffect(() => {
    const monitor = new MicMonitor({
      onSpectrogramFrame: (frame) => {
        setLiveFrames((prev) => {
          const next = prev.length >= 350 ? prev.slice(prev.length - 349) : [...prev];
          next.push(frame);

          return next;
        });
      },
      onNoiseUpdate: (noiseDb, isPolluted) => {
        setNoiseFloorDb(noiseDb);
        setIsNoisePolluted(isPolluted);
      },
      onObservationDetected: (observation) => {
        const timeLabel = formatCpaTimestamp(observation.cpaTimeSec);
        setStatusMessage(
          `Captured aircraft flyover at ${timeLabel} (${observation.kinematics.baseFreqHz.toFixed(1)} Hz, ${observation.kinematics.inferredSpeedMps.toFixed(0)} m/s)! Refining location...`,
        );
        workerRef.current?.postMessage({
          id: `obs_${String(Date.now())}`,
          type: 'ingest_observation',
          payload: observation,
        });
      },
      onError: (err) => {
        setErrorMessage(`Microphone error: ${err.message}`);
        setIsListening(false);
      },
    });
    micMonitorRef.current = monitor;

    return () => {
      monitor.stop();
    };
  }, []);

  useEffect(() => {
    if (session !== null) {
      saveSessionToStorage(session);
    }
  }, [session]);

  useEffect(() => {
    // Instantiate background solver worker
    const worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const parsed = WorkerReplySchema.safeParse(event.data);
      if (!parsed.success) {
        return;
      }
      const res = parsed.data;
      setAnalysisId((current) => (current === res.id ? null : current));
      if (!res.success) {
        setErrorMessage(`Analysis failed: ${res.error}`);

        return;
      }
      setErrorMessage(null);
      if (res.type === 'session') {
        setSession(res.data);
        if (res.data.hypotheses.length > 0) {
          setStatusMessage(`Identified observer location with ${String(res.data.hypotheses.length)} candidate(s).`);
        }
      } else if (res.type === 'audio_analysed') {
        setClipSpectrogram(res.data.spectrogram);
        setSession(res.data.session);
        setActiveFlyoverCount(res.data.observations.length);
        setNoiseFloorDb(res.data.spectrogramSummary.medianNoiseDb);
        setIsNoisePolluted(res.data.spectrogramSummary.medianNoiseDb > NOISE_POLLUTED_THRESHOLD_DB);
        if (res.data.session.hypotheses.length > 0) {
          setStatusMessage(`Identified observer location with ${String(res.data.session.hypotheses.length)} candidate(s).`);
        }
      }
    };

    worker.onerror = (e) => {
      setAnalysisId(null);
      setErrorMessage(`The analysis worker stopped: ${e.message}`);
    };

    // Resume the most recent saved session that still matches the current schema; an older shape is ignored rather than guessed at.
    const saved = loadSessionsFromStorage()
      .map((candidate) => LocationSessionSchema.safeParse(candidate))
      .find((result) => result.success)?.data;
    if (saved !== undefined) {
      setSession(saved);
    }
    worker.postMessage({ id: 'init', type: 'init_session', payload: saved === undefined ? {} : { initialSession: saved } });

    return () => {
      worker.terminate();
    };
  }, []);

  // Initialize Leaflet Map
  useEffect(() => {
    if (mapRef.current === null || leafletMap.current !== null) {
      return undefined;
    }

    const map = L.map(mapRef.current, {
      center: [BUNDLED_GROUND_TRUTH.lat, BUNDLED_GROUND_TRUTH.lon],
      zoom: 12,
      zoomControl: true,
    });

    L.tileLayer(TILE_URL_TEMPLATE, {
      maxZoom: 19,
      // CORS tile requests give the service worker inspectable responses it can cache for offline use.
      crossOrigin: true,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);

    markersLayer.current = L.layerGroup().addTo(map);
    ellipseLayer.current = L.layerGroup().addTo(map);
    leafletMap.current = map;

    // Leaflet measures its container once, so a rotation or the layout stacking would otherwise leave tiles missing or misplaced.
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(mapRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      leafletMap.current = null;
    };
  }, []);

  // Update Map Markers and Confidence Ellipse when hypotheses change
  useEffect(() => {
    if (leafletMap.current === null || markersLayer.current === null || ellipseLayer.current === null) {
      return;
    }
    markersLayer.current.clearLayers();
    ellipseLayer.current.clearLayers();

    // Plot ground truth marker
    L.circleMarker([BUNDLED_GROUND_TRUTH.lat, BUNDLED_GROUND_TRUTH.lon], {
      radius: 6,
      color: '#10b981',
      fillColor: '#10b981',
      fillOpacity: 0.9,
    })
      .bindPopup('<b>Ground Truth Observer</b><br>Oxford, UK (51.7520° N, 1.2577° W)')
      .addTo(markersLayer.current);

    if (session === null || session.hypotheses.length === 0) {
      return;
    }

    const topHyp = session.hypotheses[0];
    if (topHyp === undefined) {
      return;
    }

    // Plot top candidate marker
    L.circleMarker([topHyp.lat, topHyp.lon], {
      radius: 7,
      color: '#3b82f6',
      fillColor: '#3b82f6',
      fillOpacity: 0.8,
    })
      .bindPopup(
        `<b>Estimated Location (${(topHyp.probability * 100).toFixed(0)}%)</b><br>` +
          `${topHyp.lat.toFixed(5)}° N, ${topHyp.lon.toFixed(5)}° E<br>` +
          `95% Ellipse: ±${topHyp.ellipseSemiMajorMeters.toFixed(0)}m × ±${topHyp.ellipseSemiMinorMeters.toFixed(0)}m`,
      )
      .addTo(markersLayer.current);

    // Draw the 95% confidence ellipse around the top hypothesis, in true metres on the ground.
    const ellipsePoints = ellipseOutline(topHyp, topHyp).map((point): [number, number] => [point.lat, point.lon]);

    L.polygon(ellipsePoints, {
      color: '#3b82f6',
      weight: 2,
      fillColor: '#3b82f6',
      fillOpacity: 0.15,
      dashArray: '4, 4',
    }).addTo(ellipseLayer.current);

    leafletMap.current.setView([topHyp.lat, topHyp.lon], 13);
  }, [session]);

  const handleToggleMic = async (): Promise<void> => {
    if (isListening) {
      micMonitorRef.current?.stop();
      setIsListening(false);
      setIsPaused(false);
      setStatusMessage('Microphone stopped.');
    } else {
      setStatusMessage('Requesting microphone permissions (raw acoustics, AGC/noise-suppression disabled)...');
      setErrorMessage(null);
      try {
        setClipSpectrogram(null);
        const episodeId = `live_${String(Date.now())}`;
        await micMonitorRef.current?.start(episodeId);
        setIsListening(true);
        setIsPaused(false);
        setStatusMessage('Live microphone listening active. Silence gating and Doppler ridge tracker running.');
      } catch (err) {
        setIsListening(false);
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(`The microphone could not be started: ${msg}. Allow microphone access for this site in the browser settings and try again.`);
      }
    }
  };

  const handleTogglePause = (): void => {
    if (!isListening) {
      return;
    }
    if (isPaused) {
      micMonitorRef.current?.resume();
      setIsPaused(false);
      setStatusMessage('Microphone resumed.');
    } else {
      micMonitorRef.current?.pause();
      setIsPaused(true);
      setStatusMessage('Microphone paused (silence interval preserved).');
    }
  };

  /**
   * Hands decoded audio to the worker and marks the analysis as running until its reply arrives.
   * @param id - Request id; the worker echoes it in its reply.
   * @param payload - The `process_audio` payload.
   * @param transfer - Buffers to move to the worker rather than copy.
   */
  const startAnalysis = (id: string, payload: Readonly<Record<string, unknown>>, transfer: readonly Transferable[]): void => {
    setAnalysisId(id);
    setErrorMessage(null);
    workerRef.current?.postMessage({ id, type: 'process_audio', payload }, [...transfer]);
  };

  // Simulate a live flyover stream for testing/demonstration without physical mic
  const handleSimulateFlyoverStream = (): void => {
    setStatusMessage('Synthesizing & analyzing 1,120s multi-flyover stream (Doppler ridges + 50Hz ENF)...');
    const audio = generateBundledReferenceAudio(2000);
    startAnalysis(
      `sim_${String(Date.now())}`,
      { rawSamples: audio, sampleRateHz: 2000, startEpochSec: 1788900000, episodeId: 'simulated_episode_1' },
      [audio.buffer],
    );
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const input = e.target;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    setErrorMessage(null);
    setStatusMessage(`Reading ${file.name}...`);
    file
      .arrayBuffer()
      .then(decodeAudioFile)
      .then(({ samples, sampleRateHz }) => {
        setStatusMessage(`Analyzing ${file.name} (${String(samples.length)} samples @ ${String(sampleRateHz)}Hz)...`);
        startAnalysis(
          `file_${String(Date.now())}`,
          { rawSamples: samples, sampleRateHz, startEpochSec: Math.floor(Date.now() / 1000), episodeId: file.name },
          [samples.buffer],
        );
      })
      .catch((err: unknown) => {
        setStatusMessage('Select an audio file or start live listening.');
        setErrorMessage(`${file.name} could not be read as audio: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        // Clearing the input lets the same file be chosen again after a failure.
        input.value = '';
      });
  };

  const topHypothesis: LocationHypothesis | undefined = session?.hypotheses[0];
  const offlineBadge = describeOffline(offline);
  const { label: buildLabel, title: buildTitle } = describeBuild(buildIdentity);

  return (
    <div className={styles.appContainer}>
      <header className={styles.header}>
        <Group>
          <Text size="lg" fw={700} c="blue.4">
            Doppler
          </Text>
          <Text size="sm" c="dimmed" className={styles.tagline}>
            Aircraft Acoustic Geolocation
          </Text>
        </Group>
        <Group>
          <Badge color={session?.enfSignature.detected === true ? 'teal' : 'gray'} variant="light">
            {session?.enfSignature.detected === true ? `ENF ${session.enfSignature.nominalHz}Hz Grid` : 'ENF Undetected'}
          </Badge>
          <Badge color={offlineBadge.color} variant="light">
            {offlineBadge.label}
          </Badge>
          <Anchor size="sm" href={buildIdentity.url} target="_blank" rel="noopener noreferrer" title={buildTitle}>
            {buildLabel}
          </Anchor>
        </Group>
      </header>

      {offline.updateAvailable && (
        <Alert color="blue" title="Update available" role="status">
          <Group justify="space-between">
            <Text size="sm">A newer version is ready. It installs when the current analysis or listening stops. Your session is saved and returns after the reload.</Text>
            <Button size="compact-sm" onClick={offline.applyUpdate}>
              Reload to update
            </Button>
          </Group>
        </Alert>
      )}

      <div className={styles.mainContent}>
        <aside className={styles.sidebar}>
          <Tabs value={activeTab} onChange={setActiveTab}>
            <Tabs.List grow>
              <Tabs.Tab value="live">Live Monitor</Tabs.Tab>
              <Tabs.Tab value="file">File Analyzer</Tabs.Tab>
              <Tabs.Tab value="session">Session</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="live" pt="md">
              <Stack gap="sm">
                <Card withBorder padding="sm" radius="md">
                  <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                    Microphone & Streaming
                  </Text>
                  <Group justify="space-between" mt="xs">
                    <Button
                      size="xs"
                      color={isListening ? 'red' : 'blue'}
                      onClick={() => { void handleToggleMic(); }}
                    >
                      {isListening ? 'Stop Mic' : 'Start Mic'}
                    </Button>
                    <Button
                      size="xs"
                      variant="light"
                      disabled={!isListening}
                      onClick={handleTogglePause}
                    >
                      {isPaused ? 'Resume' : 'Pause'}
                    </Button>
                  </Group>

                  <Button
                    mt="sm"
                    fullWidth
                    size="xs"
                    variant="outline"
                    color="teal"
                    disabled={analysisId !== null}
                    onClick={handleSimulateFlyoverStream}
                  >
                    Simulate Flyover Stream
                  </Button>
                </Card>

                <Card withBorder padding="sm" radius="md">
                  <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                    Acoustic Environment
                  </Text>
                  <Group justify="space-between" mt="xs">
                    <Text size="sm">Noise Floor:</Text>
                    <Text size="sm" fw={600}>
                      {noiseFloorDb.toFixed(1)} dB
                    </Text>
                  </Group>
                  <Progress value={Math.max(0, Math.min(100, (noiseFloorDb + 100) * 2))} mt="xs" size="sm" />
                  <Badge mt="xs" color={isNoisePolluted ? 'orange' : 'teal'} fullWidth variant="light">
                    {isNoisePolluted ? 'High Noise Pollution (Silence Masked)' : 'Quiet Band (Silence Gating Active)'}
                  </Badge>
                </Card>

                <Card withBorder padding="sm" radius="md">
                  <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                    Detection Telemetry
                  </Text>
                  <Text size="sm" mt="xs">
                    Captured Flyovers: <b>{activeFlyoverCount}</b>
                  </Text>
                  <Text size="sm">
                    Candidate Hypotheses: <b>{session?.hypotheses.length ?? 0}</b>
                  </Text>
                </Card>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="file" pt="md">
              <Stack gap="sm">
                <Card withBorder padding="sm" radius="md">
                  <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                    Upload Audio / Video
                  </Text>
                  <input
                    type="file"
                    accept="audio/*,video/*,.wav,.mp3,.m4a,.mp4,.mov"
                    aria-label="Audio or video file to analyse"
                    disabled={analysisId !== null}
                    onChange={handleFileUpload}
                    style={{ marginTop: '8px', fontSize: '13px' }}
                  />
                  <Text size="xs" c="dimmed" mt="xs">
                    WAV is read directly; other formats are decoded by your browser, so any format it can play works. Audio is decimated to 2,000 Hz and mixed to mono.
                  </Text>
                </Card>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="session" pt="md">
              <Stack gap="sm">
                <Card withBorder padding="sm" radius="md">
                  <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                    Session Checkpoint
                  </Text>
                  <Text size="xs" c="dimmed" mt="xs">
                    ID: {session?.id ?? 'none'}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Episodes: {session?.episodes.length ?? 0}
                  </Text>
                  <Button
                    mt="sm"
                    size="xs"
                    variant="light"
                    fullWidth
                    onClick={() => {
                      if (session !== null) {
                        const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `doppler_session_${session.id}.json`;
                        a.click();
                      }
                    }}
                  >
                    Export Session JSON
                  </Button>
                </Card>
              </Stack>
            </Tabs.Panel>
          </Tabs>

          {topHypothesis !== undefined && (
            <Card withBorder padding="sm" radius="md" mt="auto" bg="dark.7" className={styles.resultCard}>
              <Text size="xs" fw={700} c="blue.4" tt="uppercase">
                Estimated Location ({(topHypothesis.probability * 100).toFixed(0)}%)
              </Text>
              <Text size="sm" fw={600} mt="xs">
                {topHypothesis.lat.toFixed(5)}° N, {topHypothesis.lon.toFixed(5)}° E
              </Text>
              <Text size="xs" c="dimmed">
                Altitude: {topHypothesis.altMeters.toFixed(0)}m AMSL
              </Text>
              <Text size="xs" c="teal.3" mt="xs">
                95% Ellipse: ±{topHypothesis.ellipseSemiMajorMeters.toFixed(0)}m × ±
                {topHypothesis.ellipseSemiMinorMeters.toFixed(0)}m
              </Text>
              <Text size="xs" c="dimmed">
                Residual: {topHypothesis.rmsFreqResidualHz.toFixed(2)} Hz RMS
              </Text>
            </Card>
          )}

          {analysisId !== null && <Progress value={100} animated size="sm" mt="xs" aria-label="Analysing audio" />}
          {errorMessage !== null && (
            <Alert
              color="red"
              mt="xs"
              role="alert"
              withCloseButton
              onClose={() => {
                setErrorMessage(null);
              }}
            >
              <Text size="xs">{errorMessage}</Text>
            </Alert>
          )}
          <Text size="xs" c="dimmed" mt="xs" role="status" aria-live="polite">
            {statusMessage}
          </Text>
        </aside>

        <main className={styles.visualizerPanel}>
          <div className={styles.mapContainer}>
            <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
          </div>
          <SpectrogramViewer
            clipSpectrogram={clipSpectrogram}
            isListening={isListening}
            liveFrames={liveFrames}
            observations={session?.observations ?? []}
            onClearLive={() => {
              setLiveFrames([]);
            }}
          />
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
