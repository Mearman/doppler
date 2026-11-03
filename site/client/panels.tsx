import React, { useRef } from 'react';
import { Badge, Button, Progress } from '@mantine/core';
import type { DatasetInfo, LocationSession } from '../../src/schemas';
import * as styles from '../styles.css';
import { describeBuild } from '../describe-build';
import { buildIdentity } from './build-info';
import { FlyoverList } from './flyover-list';
import { type FlightDataFile, MAX_JSON_CHARS, fitsInBrowser, formatBytes } from './flight-data-sources';
import type { FlightData } from './use-flight-data';
import type { LiveFeed } from './use-live-feed';
import { FREE_PLAN_MAX_RADIUS_KM } from '../../src/live-adsb';
import { type Confidence, confidenceOf, describeEstimate, formatCoordinates, formatDistance, mapLink } from './result-summary';
import type { Microphone } from './use-microphone';

/** Width, in decibels, of the range the noise meter spans, from the quietest room to a loud street. */
const METER_FLOOR_DB = -100;
const METER_CEILING_DB = -50;

const CONFIDENCE_COLOURS: Readonly<Record<Confidence, string>> = { high: 'teal', moderate: 'yellow', low: 'orange' };

/** Properties of the notice that no flight data is loaded. */
interface NoFlightDataProps {
  readonly onOpenData: () => void;
}

/**
 * Says that flyovers cannot be placed on the map without flight data, and where to load it.
 * @param props - The handler that opens the data section.
 * @returns The notice card.
 */
function NoFlightData(props: Readonly<NoFlightDataProps>): React.JSX.Element {
  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>No flight data</h2>
      <p className={styles.hint}>Flyovers are detected from the audio, but placing the listener on the map needs the flights that were in the air. Load flight data to get a location.</p>
      <Button variant="light" fullWidth onClick={props.onOpenData}>
        Load flight data
      </Button>
    </section>
  );
}

/** Properties of the listen panel. */
export interface ListenPanelProps {
  readonly microphone: Microphone;
  readonly flyoverCount: number;
  readonly hypothesisCount: number;
  readonly hasFlightData: boolean;
  readonly onOpenData: () => void;
}

/**
 * Live listening: start and pause the microphone and see the acoustic environment.
 * @param props - The microphone, the counts to show, whether flight data is loaded and the handler that opens the data section.
 * @returns The panel body.
 */
export function ListenPanel(props: Readonly<ListenPanelProps>): React.JSX.Element {
  const { microphone, flyoverCount, hypothesisCount, hasFlightData, onOpenData } = props;
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
      </section>

      {!hasFlightData && <NoFlightData onOpenData={onOpenData} />}

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
 * @param props - Whether an analysis is running, the handler that analyses a chosen file and the session whose flyovers are listed.
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

/** Properties of the data panel. */
export interface DataPanelProps {
  readonly info: Readonly<DatasetInfo> | null;
  readonly flightData: Readonly<FlightData>;
  readonly liveFeed: Readonly<LiveFeed>;
}

/**
 * The flight data the app matches flyovers against: what is loaded, and where more comes from.
 * @param props - The loaded dataset's summary, the file and published data sources and the live feed.
 * @returns The panel body.
 */
export function DataPanel(props: Readonly<DataPanelProps>): React.JSX.Element {
  const { info, flightData, liveFeed } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loaded = info !== null && info.segmentCount > 0;
  const working = flightData.working !== null;

  return (
    <div className={styles.panelStack}>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Flight data</h2>
        {loaded ? (
          <>
            <div className={styles.row}>
              <span>Flight segments</span>
              <strong>{info.segmentCount.toLocaleString()}</strong>
            </div>
            <div className={styles.row}>
              <span>Generated</span>
              <span>{info.generatedAtIso.slice(0, 10)}</span>
            </div>
            <Button mt="sm" variant="subtle" color="gray" fullWidth disabled={working} onClick={() => { void flightData.clear(); }}>
              Remove flight data
            </Button>
          </>
        ) : (
          <p className={styles.hint}>None loaded. Flyovers are detected, but cannot be placed on the map.</p>
        )}
        {working && <p className={styles.hint} role="status">{flightData.working}</p>}
      </section>

      <LiveCard liveFeed={liveFeed} />

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Load from a file</h2>
        <p className={styles.hint}>A dataset JSON file from <code>doppler ingest</code> or downloaded from the published data.</p>
        <label className={styles.dropZone} data-disabled={working}>
          <span>Choose a dataset file</span>
          <input
            type="file"
            className={styles.dropInput}
            accept=".json,application/json"
            aria-label="Flight data file"
            disabled={working}
            ref={inputRef}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                void flightData.fromFile(file).finally(() => {
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
        <h2 className={styles.cardTitle}>Published data</h2>
        <p className={styles.hint}>
          Daily ADS-B datasets published by this project on Hugging Face. A file above {formatBytes(MAX_JSON_CHARS)} is more than a browser can parse in one piece.
        </p>
        {flightData.catalogue === null ? (
          <p className={styles.muted}>Loading the list.</p>
        ) : (
          <CatalogueList files={flightData.catalogue} disabled={working} onChoose={flightData.fromCatalogue} />
        )}
      </section>
    </div>
  );
}

/** Properties of the live feed card. */
interface LiveCardProps {
  readonly liveFeed: Readonly<LiveFeed>;
}

/**
 * The live ADS-B feed: the person's own free key, a start and stop control, and what the feed is tracking.
 * @param props - The live feed.
 * @returns The card.
 */
function LiveCard(props: Readonly<LiveCardProps>): React.JSX.Element {
  const { liveFeed } = props;

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>
        Live feed <Badge variant="light" color={liveFeed.active ? 'teal' : 'gray'}>{liveFeed.active ? 'on' : 'off'}</Badge>
      </h2>
      <p className={styles.hint}>
        Follows the aircraft in the area the map shows, as reported by the FlyItalyADSB community network. Zoom the map to where you are. The feed covers the visible area up to a {String(FREE_PLAN_MAX_RADIUS_KM)} km radius, which is the free plan limit. While it is on, it replaces the loaded flight data.
      </p>
      <label className={styles.field}>
        <span>FlyItalyADSB API key</span>
        <input
          type="password"
          className={styles.textInput}
          value={liveFeed.apiKey}
          autoComplete="off"
          spellCheck={false}
          disabled={liveFeed.active}
          onChange={(event) => {
            liveFeed.setApiKey(event.target.value);
          }}
        />
      </label>
      <p className={styles.hint}>
        <a className={styles.link} href="https://flyitalyadsb.com/en/data/api/" target="_blank" rel="noopener noreferrer">
          Get a free key
        </a>
        . It is kept in this browser and sent only to FlyItalyADSB.
      </p>
      <Button
        fullWidth
        color={liveFeed.active ? 'red' : 'blue'}
        disabled={!liveFeed.active && liveFeed.apiKey.trim() === ''}
        onClick={liveFeed.active ? liveFeed.stop : liveFeed.start}
      >
        {liveFeed.active ? 'Stop live feed' : 'Start live feed'}
      </Button>
      {liveFeed.active && (
        <p className={styles.hint} role="status">
          {liveFeed.updatedAtEpochSec === null
            ? 'Waiting for the first answer.'
            : `Tracking ${String(liveFeed.aircraftCount)} aircraft within ${String(Math.round(liveFeed.radiusKm))} km, ${String(liveFeed.segmentCount)} flight segments. Segments need a few polls to form.`}
        </p>
      )}
    </section>
  );
}

/** Properties of the list of published files. */
interface CatalogueListProps {
  readonly files: readonly FlightDataFile[];
  readonly disabled: boolean;
  readonly onChoose: (file: Readonly<FlightDataFile>) => Promise<void>;
}

/**
 * Lists the published dataset files, each with its size and a button that loads it unless it is too large.
 * @param props - The files, whether loading is blocked and the handler for a chosen file.
 * @returns The list, or a sentence saying none are published.
 */
function CatalogueList(props: Readonly<CatalogueListProps>): React.JSX.Element {
  const { files, disabled, onChoose } = props;
  if (files.length === 0) {
    return <p className={styles.muted}>No data is published yet.</p>;
  }

  return (
    <ul className={styles.catalogue} aria-label="Published flight data">
      {files.map((file) => {
        const fits = fitsInBrowser(file.sizeBytes);

        return (
          <li key={file.path} className={styles.catalogueItem}>
            <span className={styles.catalogueName}>
              <span>{file.path.replace('.dataset.json', '')}</span>
              <span className={styles.muted}>{fits ? formatBytes(file.sizeBytes) : `${formatBytes(file.sizeBytes)}, too large for a browser`}</span>
            </span>
            <Button size="compact-sm" variant="light" disabled={disabled || !fits} onClick={() => { void onChoose(file); }}>
              Load
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** Properties of the result panel. */
export interface ResultPanelProps {
  readonly session: Readonly<LocationSession> | null;
  readonly hasFlightData: boolean;
  readonly onOpenData: () => void;
}

/**
 * The estimate in plain words, then the figures behind it, each with what it means.
 * @param props - The session whose leading candidate is described, whether flight data is loaded and the handler that opens the data section.
 * @returns The panel body, or a prompt to produce an estimate when there is none.
 */
export function ResultPanel(props: Readonly<ResultPanelProps>): React.JSX.Element {
  const { session, hasFlightData, onOpenData } = props;
  const top = session?.hypotheses[0];
  if (top === undefined) {
    return (
      <div className={styles.panelStack}>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>No estimate yet</h2>
          <p className={styles.hint}>Start the microphone or choose a recording, and the most likely place appears here.</p>
        </section>
        {!hasFlightData && <NoFlightData onOpenData={onOpenData} />}
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
