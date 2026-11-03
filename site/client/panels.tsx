import React, { useRef } from 'react';
import { Badge, Button, Progress } from '@mantine/core';
import type { LocationSession } from '../../src/schemas';
import * as styles from '../styles.css';
import { describeBuild } from '../describe-build';
import { buildIdentity } from './build-info';
import { FlyoverList } from './flyover-list';
import { type Confidence, confidenceOf, describeEstimate, formatCoordinates, formatDistance, mapLink } from './result-summary';
import type { Microphone } from './use-microphone';

/** Width, in decibels, of the range the noise meter spans, from the quietest room to a loud street. */
const METER_FLOOR_DB = -100;
const METER_CEILING_DB = -50;

const CONFIDENCE_COLOURS: Readonly<Record<Confidence, string>> = { high: 'teal', moderate: 'yellow', low: 'orange' };

/** Properties of the listen panel. */
export interface ListenPanelProps {
  readonly microphone: Microphone;
  readonly busy: boolean;
  readonly flyoverCount: number;
  readonly hypothesisCount: number;
  readonly onSimulate: () => void;
}

/**
 * Live listening: start and pause the microphone, run the built-in simulation and see the acoustic environment.
 * @param props - What the component draws and the handlers it calls: microphone, busy, flyoverCount, hypothesisCount, onSimulate.
 * @returns The panel body.
 */
export function ListenPanel(props: Readonly<ListenPanelProps>): React.JSX.Element {
  const { microphone, busy, flyoverCount, hypothesisCount, onSimulate } = props;
  const meter = ((microphone.noiseFloorDb - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)) * 100;

  return (
    <div className={styles.panelStack}>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Microphone</h2>
        <div className={styles.buttonRow}>
          <Button
            color={microphone.isListening ? 'red' : 'blue'}
            onClick={() => {
              void microphone.toggle();
            }}
          >
            {microphone.isListening ? 'Stop Mic' : 'Start Mic'}
          </Button>
          <Button variant="light" disabled={!microphone.isListening} onClick={microphone.togglePause}>
            {microphone.isPaused ? 'Resume' : 'Pause'}
          </Button>
        </div>
        <p className={styles.hint} role="status">
          {microphone.isListening
            ? microphone.isPaused
              ? 'Paused. The silence interval is kept.'
              : 'Listening. Silence gating and the Doppler ridge tracker are running.'
            : 'Raw audio is captured with automatic gain and noise suppression off.'}
        </p>
        <Button fullWidth variant="outline" color="teal" disabled={busy} onClick={onSimulate}>
          Simulate Flyover Stream
        </Button>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Acoustic environment</h2>
        <div className={styles.row}>
          <span>Noise floor</span>
          <strong>{`${microphone.noiseFloorDb.toFixed(1)} dB`}</strong>
        </div>
        <Progress value={Math.max(0, Math.min(100, meter))} size="sm" mt="xs" aria-label="Noise floor level" />
        <Badge mt="xs" fullWidth variant="light" color={microphone.isNoisePolluted ? 'orange' : 'teal'}>
          {microphone.isNoisePolluted ? 'High noise (silence masked)' : 'Quiet band (silence gating active)'}
        </Badge>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Detection</h2>
        <div className={styles.row}>
          <span>Flyovers captured</span>
          <strong>{flyoverCount}</strong>
        </div>
        <div className={styles.row}>
          <span>Candidate locations</span>
          <strong>{hypothesisCount}</strong>
        </div>
      </section>
    </div>
  );
}

/** Properties of the file panel. */
export interface FilePanelProps {
  readonly busy: boolean;
  readonly onFile: (file: Readonly<File>) => Promise<void>;
  readonly session: Readonly<LocationSession> | null;
}

/**
 * Analysing a recording: a drop zone for any audio or video file and the flyovers found so far.
 * @param props - What the component draws and the handlers it calls: busy, onFile, session.
 * @returns The panel body.
 */
export function FilePanel(props: Readonly<FilePanelProps>): React.JSX.Element {
  const { busy, onFile, session } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className={styles.panelStack}>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Upload audio or video</h2>
        <label className={styles.dropZone} data-disabled={busy}>
          <span>{busy ? 'Analysing, please wait' : 'Choose a recording, or drop one here'}</span>
          <span className={styles.hint}>WAV is read directly. Other formats are decoded by your browser, so any format it can play works. Audio is mixed to mono and reduced to 2,000 Hz.</span>
          <input
            type="file"
            className={styles.dropInput}
            accept="audio/*,video/*,.wav,.mp3,.m4a,.mp4,.mov"
            aria-label="Audio or video file to analyse"
            disabled={busy}
            ref={inputRef}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                // Clearing the input afterwards lets the same file be chosen again after a failure.
                void onFile(file).finally(() => {
                  if (inputRef.current !== null) {
                    inputRef.current.value = '';
                  }
                });
              }
            }}
          />
        </label>
      </section>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Detected flyovers</h2>
        <FlyoverList observations={session?.observations ?? []} />
      </section>
    </div>
  );
}

/** Properties of the result panel. */
export interface ResultPanelProps {
  readonly session: Readonly<LocationSession> | null;
}

/**
 * The estimate in plain words, then the figures behind it, each with what it means.
 * @param props - What the component draws and the handlers it calls: session.
 * @returns The panel body, or a prompt to produce an estimate when there is none.
 */
export function ResultPanel(props: Readonly<ResultPanelProps>): React.JSX.Element {
  const { session } = props;
  const top = session?.hypotheses[0];
  if (top === undefined) {
    return (
      <div className={styles.panelStack}>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>No estimate yet</h2>
          <p className={styles.hint}>Start the microphone, choose a recording or simulate a flyover, and the most likely place appears here.</p>
        </section>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Detected flyovers</h2>
          <FlyoverList observations={session?.observations ?? []} />
        </section>
      </div>
    );
  }
  const confidence = confidenceOf(top);

  return (
    <div className={styles.panelStack}>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          Estimated location <Badge variant="light" color={CONFIDENCE_COLOURS[confidence]}>{`${confidence} confidence`}</Badge>
        </h2>
        <p className={styles.headline}>{describeEstimate(top)}</p>
        <a className={styles.link} href={mapLink(top.lat, top.lon)} target="_blank" rel="noopener noreferrer">
          Open in OpenStreetMap
        </a>
      </section>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>The figures</h2>
        <dl className={styles.definitionList}>
          <dt>Position</dt>
          <dd>{formatCoordinates(top.lat, top.lon)}</dd>
          <dt>Likelihood</dt>
          <dd>{`${(top.probability * 100).toFixed(0)}% that this candidate is right, against the others the data allows.`}</dd>
          <dt>95% ellipse</dt>
          <dd>{`${formatDistance(top.ellipseSemiMajorMeters)} by ${formatDistance(top.ellipseSemiMinorMeters)}. The observer is inside it 95 times in 100.`}</dd>
          <dt>Altitude</dt>
          <dd>{`${top.altMeters.toFixed(0)} m above sea level.`}</dd>
          <dt>Pitch residual</dt>
          <dd>{`${top.rmsFreqResidualHz.toFixed(2)} Hz RMS. How far the heard pitch sits from the model's, so lower is better.`}</dd>
        </dl>
      </section>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Detected flyovers</h2>
        <FlyoverList observations={session?.observations ?? []} />
      </section>
    </div>
  );
}

/** Properties of the session panel. */
export interface SessionPanelProps {
  readonly session: Readonly<LocationSession> | null;
}

/**
 * The saved session and the build the page is running.
 * @param props - What the component draws and the handlers it calls: session.
 * @returns The panel body.
 */
export function SessionPanel(props: Readonly<SessionPanelProps>): React.JSX.Element {
  const { session } = props;
  const { label, title } = describeBuild(buildIdentity);
  const exportSession = (): void => {
    if (session === null) {
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `doppler_session_${session.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={styles.panelStack}>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Session</h2>
        <div className={styles.row}>
          <span>ID</span>
          <span className={styles.mono}>{session?.id ?? 'none'}</span>
        </div>
        <div className={styles.row}>
          <span>Episodes</span>
          <strong>{session?.episodes.length ?? 0}</strong>
        </div>
        <div className={styles.row}>
          <span>Observations</span>
          <strong>{session?.observations.length ?? 0}</strong>
        </div>
        <Button mt="sm" variant="light" fullWidth disabled={session === null} onClick={exportSession}>
          Export session JSON
        </Button>
      </section>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>About this build</h2>
        <div className={styles.row}>
          <span>Version</span>
          <a className={styles.link} href={buildIdentity.url} target="_blank" rel="noopener noreferrer" title={title}>
            {label}
          </a>
        </div>
      </section>
    </div>
  );
}
