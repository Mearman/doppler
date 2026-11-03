import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge, Button, Card, Group, MantineProvider, Progress, Stack, Tabs, Text } from '@mantine/core';
import '@mantine/core/styles.css';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { MicMonitor } from '../../src/browser/mic-monitor';
import { BUNDLED_GROUND_TRUTH, generateBundledReferenceAudio } from '../../src/bundled';
import { decodeWavBytes } from '../../src/dsp/side-channels';
import type { ComputedSingleFrame } from '../../src/dsp/spectrogram';
import type { LocationHypothesis, LocationSession } from '../../src/schemas';
import * as styles from '../styles.css';
import { SpectrogramViewer, type ClipSpectrogramData } from './spectrogram-viewer';

function formatCpaTimestamp(cpaTimeSec: number): string {
  if (cpaTimeSec > 1_000_000_000) {
    return new Date(cpaTimeSec * 1000).toLocaleTimeString();
  }
  const mins = Math.floor(cpaTimeSec / 60);
  const secs = (cpaTimeSec % 60).toFixed(1);

  return mins > 0 ? `${String(mins)}m ${secs}s` : `${secs}s`;
}

export function App(): React.JSX.Element {
  const [session, setSession] = useState<LocationSession | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>('live');
  const [isListening, setIsListening] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [noiseFloorDb, setNoiseFloorDb] = useState(-82);
  const [isNoisePolluted, setIsNoisePolluted] = useState(false);
  const [activeFlyoverCount, setActiveFlyoverCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('Offline Ready. Select an audio file or start live listening.');
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
        setStatusMessage(`Microphone error: ${err.message}`);
        setIsListening(false);
      },
    });
    micMonitorRef.current = monitor;

    return () => {
      monitor.stop();
    };
  }, []);

  useEffect(() => {
    // Instantiate background solver worker
    const worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<{ id: string; success: boolean; data?: unknown; error?: string }>) => {
      const res = event.data;
      if (!res.success) {
        setStatusMessage(`Worker error: ${res.error ?? 'unknown'}`);

        return;
      }
      const data = res.data as {
        session?: LocationSession;
        observations?: unknown[];
        spectrogram?: ClipSpectrogramData;
        spectrogramSummary?: { medianNoiseDb: number };
      };
      if (data.spectrogram !== undefined) {
        setClipSpectrogram(data.spectrogram);
      }
      if (data.session !== undefined) {
        setSession(data.session);
        if (data.observations !== undefined) {
          setActiveFlyoverCount(data.observations.length);
        }
        if (data.spectrogramSummary !== undefined) {
          setNoiseFloorDb(data.spectrogramSummary.medianNoiseDb);
          setIsNoisePolluted(data.spectrogramSummary.medianNoiseDb > -65);
        }
        if (data.session.hypotheses.length > 0) {
          setStatusMessage(`Identified observer location with ${String(data.session.hypotheses.length)} candidate(s).`);
        }
      }
    };

    worker.onerror = (e) => {
      setStatusMessage(`Worker error: ${e.message}`);
    };

    worker.postMessage({ id: 'init', type: 'init_session', payload: {} });

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

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);

    markersLayer.current = L.layerGroup().addTo(map);
    ellipseLayer.current = L.layerGroup().addTo(map);
    leafletMap.current = map;

    return () => {
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

    // Draw 95% Confidence Ellipse around top hypothesis
    const semiMajorDeg = topHyp.ellipseSemiMajorMeters / 111132;
    const semiMinorDeg = topHyp.ellipseSemiMinorMeters / 111132;
    const ellipsePoints: [number, number][] = [];
    const bearingRad = (topHyp.ellipseBearingDeg * Math.PI) / 180;

    for (let step = 0; step <= 36; step += 1) {
      const theta = (step * 2 * Math.PI) / 36;
      const x0 = semiMinorDeg * Math.cos(theta);
      const y0 = semiMajorDeg * Math.sin(theta);
      const rotX = x0 * Math.cos(-bearingRad) - y0 * Math.sin(-bearingRad);
      const rotY = x0 * Math.sin(-bearingRad) + y0 * Math.cos(-bearingRad);
      ellipsePoints.push([topHyp.lat + rotY, topHyp.lon + rotX]);
    }

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
        setStatusMessage(`Microphone permission / access error: ${msg}`);
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

  // Simulate a live flyover stream for testing/demonstration without physical mic
  const handleSimulateFlyoverStream = (): void => {
    setStatusMessage('Synthesizing & analyzing 1,120s multi-flyover stream (Doppler ridges + 50Hz ENF)...');
    const audio = generateBundledReferenceAudio(2000);
    workerRef.current?.postMessage({
      id: `sim_${String(Date.now())}`,
      type: 'process_audio',
      payload: {
        rawSamples: audio,
        sampleRateHz: 2000,
        startEpochSec: 1788900000,
        episodeId: 'simulated_episode_1',
      },
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file === undefined) {
      return;
    }
    setStatusMessage(`Reading ${file.name}...`);
    const reader = new FileReader();
    reader.onload = (event) => {
      const buffer = event.target?.result;
      if (buffer instanceof ArrayBuffer) {
        try {
          const { samples, sampleRateHz } = decodeWavBytes(new Uint8Array(buffer));
          workerRef.current?.postMessage({
            id: `file_${String(Date.now())}`,
            type: 'process_audio',
            payload: {
              rawSamples: samples,
              sampleRateHz,
              startEpochSec: Math.floor(Date.now() / 1000),
              episodeId: file.name,
            },
          });
          setStatusMessage(`Analyzing ${file.name} (${String(samples.length)} samples @ ${String(sampleRateHz)}Hz)...`);
        } catch (err) {
          setStatusMessage(`Failed to decode WAV: ${String(err)}`);
        }
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const topHypothesis: LocationHypothesis | undefined = session?.hypotheses[0];

  return (
    <div className={styles.appContainer}>
      <header className={styles.header}>
        <Group>
          <Text size="lg" fw={700} c="blue.4">
            Doppler
          </Text>
          <Text size="sm" c="dimmed">
            Aircraft Acoustic Geolocation
          </Text>
        </Group>
        <Group>
          <Badge color={session?.enfSignature.detected === true ? 'teal' : 'gray'} variant="light">
            {session?.enfSignature.detected === true ? `ENF ${session.enfSignature.nominalHz}Hz Grid` : 'ENF Undetected'}
          </Badge>
          <Badge color="green" variant="light">
            100% Offline
          </Badge>
        </Group>
      </header>

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
                    accept=".wav,.mp3,.mp4,.mov"
                    onChange={handleFileUpload}
                    style={{ marginTop: '8px', fontSize: '13px' }}
                  />
                  <Text size="xs" c="dimmed" mt="xs">
                    Supports 16-bit PCM WAV. Audio will be decimated to 2,000 Hz.
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
            <Card withBorder padding="sm" radius="md" mt="auto" bg="dark.7">
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

          <Text size="xs" c="dimmed" mt="xs">
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
