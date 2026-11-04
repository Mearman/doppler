import React, { useRef, useState } from 'react';
import { Badge, Button, Progress, Text } from '@mantine/core';
import type { DatasetInfo, LocationSession } from '../../src/schemas';
import * as styles from '../styles.css';
import { describeBuild } from '../describe-build';
import { buildIdentity } from './build-info';
import { FlyoverList } from './flyover-list';
import { fitsInBrowser, formatBytes } from './flight-data-sources';
import type { FlightData } from './use-flight-data';
import type { LiveFeed, SearchArea } from './use-live-feed';
import { type Confidence, confidenceOf, describeEstimate, formatCoordinates, formatDistance, mapLink } from './result-summary';
import type { Microphone } from './use-microphone';

const METER_FLOOR_DB = -100;
const METER_CEILING_DB = -50;
const CONFIDENCE_COLOURS: Readonly<Record<Confidence, string>> = { high: 'teal', moderate: 'yellow', low: 'orange' };

/** Approximate kilometres per degree of latitude. */
const KM_PER_LAT_DEG = 111.0;

/** Default date for adsb-core Parquet historical data. */
const DEFAULT_HISTORY_DATE = '2026-08-29';

export interface UnifiedSidebarProps {
  readonly microphone: Microphone;
  readonly busy: boolean;
  readonly onFile: (file: Readonly<File>) => Promise<void>;
  readonly session: Readonly<LocationSession> | null;
  readonly datasetInfo: Readonly<DatasetInfo> | null;
  readonly flightData: Readonly<FlightData>;
  readonly liveFeed: Readonly<LiveFeed>;
  readonly searchArea: Readonly<SearchArea>;
  readonly onOpenResult?: () => void;
}

export function UnifiedSidebar(props: Readonly<UnifiedSidebarProps>): React.JSX.Element {
  const { microphone, busy, onFile, session, datasetInfo, flightData, liveFeed, searchArea } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const datasetInputRef = useRef<HTMLInputElement | null>(null);
  const [historyDate, setHistoryDate] = useState(DEFAULT_HISTORY_DATE);

  const meter = ((microphone.noiseFloorDb - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)) * 100;
  const top = session?.hypotheses[0];
  const hasFlightData = datasetInfo !== null && datasetInfo.segmentCount > 0;
  const workingData = flightData.working !== null;
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

  const handleQueryParquetHistory = (): void => {
    const latRadius = searchArea.radiusKm > 0 ? searchArea.radiusKm / KM_PER_LAT_DEG : 1.0;
    const cosLat = Math.cos((searchArea.lat * Math.PI) / 180);
    const lonRadius = cosLat > 0 ? latRadius / cosLat : latRadius;

    const bbox = {
      minLat: searchArea.lat - latRadius,
      maxLat: searchArea.lat + latRadius,
      minLon: searchArea.lon - lonRadius,
      maxLon: searchArea.lon + lonRadius,
    };

    // Full 24-hour UTC window for the selected date
    const dayStartSec = Math.floor(new Date(`${historyDate}T00:00:00Z`).getTime() / 1000);
    const dayEndSec = dayStartSec + 86400;

    void flightData.fromParquetHistory(historyDate, bbox, dayStartSec, dayEndSec);
  };

  return (
    <div className={styles.panelStack} role="region" aria-label="Acoustic Geolocation Workflow">
      {/* 1. Results / Candidate Location */}
      <section className={styles.card} aria-label="Estimated Location">
        <h2 className={styles.cardTitle}>
          Estimated Location
          {top !== undefined && (
            <Badge variant="light" color={CONFIDENCE_COLOURS[confidenceOf(top)]}>
              {`${confidenceOf(top)} confidence`}
            </Badge>
          )}
        </h2>
        {top !== undefined ? (
          <>
            <p className={styles.headline}>{describeEstimate(top)}</p>
            <a className={styles.link} href={mapLink(top.lat, top.lon)} target="_blank" rel="noopener noreferrer">
              Open in OpenStreetMap
            </a>
            <dl className={styles.definitionList} style={{ marginTop: '12px' }}>
              <dt>Position</dt>
              <dd>{formatCoordinates(top.lat, top.lon)}</dd>
              <dt>Likelihood</dt>
              <dd>{`${(top.probability * 100).toFixed(0)}%`}</dd>
              <dt>95% ellipse</dt>
              <dd>{`${formatDistance(top.ellipseSemiMajorMeters)} × ${formatDistance(top.ellipseSemiMinorMeters)}`}</dd>
              <dt>Altitude</dt>
              <dd>{`${top.altMeters.toFixed(0)} m AMSL`}</dd>
              <dt>Residual</dt>
              <dd>{`${top.rmsFreqResidualHz.toFixed(2)} Hz RMS`}</dd>
            </dl>
          </>
        ) : (
          <>
            <p className={styles.headline}>No estimate yet</p>
            <p className={styles.hint}>
              {hasFlightData
                ? 'Start the microphone or upload an audio recording to identify location.'
                : 'Flyovers are detected from audio, but resolving the observer location requires flight data.'}
            </p>
            {!hasFlightData && (
              <section className={styles.card} style={{ marginTop: '8px', background: 'transparent', padding: 0, border: 'none' }}>
                <h3 className={styles.cardTitle}>No flight data</h3>
              </section>
            )}
          </>
        )}
      </section>

      {/* 2. Audio Input */}
      <section className={styles.card} aria-label="Audio Input">
        <h2 className={styles.cardTitle}>Audio Input</h2>
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
        <div className={styles.row}>
          <span>Noise Floor:</span>
          <Text size="sm" fw={600}>{microphone.noiseFloorDb.toFixed(1)} dB</Text>
          <Badge size="xs" variant="light" color={microphone.isNoisePolluted ? 'orange' : 'teal'}>
            {microphone.isNoisePolluted ? 'High Noise' : 'Quiet Band'}
          </Badge>
        </div>
        <Progress value={Math.max(0, Math.min(100, meter))} size="xs" mt="xs" mb="sm" aria-label="Noise floor level" />

        <label className={styles.dropZone} data-disabled={busy} style={{ minHeight: '80px', padding: '10px' }}>
          <span>{busy ? 'Analysing audio, please wait...' : 'Or drop / select an audio/video recording'}</span>
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

      {/* 3. Detected Flyovers */}
      <section className={styles.card} aria-label="Detected Flyovers">
        <h2 className={styles.cardTitle}>
          Detected Flyovers
          <Badge size="xs" variant="outline">
            {session?.observations.length ?? 0}
          </Badge>
        </h2>
        <FlyoverList observations={session?.observations ?? []} />
      </section>

      {/* 4. Flight Data */}
      <section className={styles.card} aria-label="Flight Data">
        <h2 className={styles.cardTitle}>
          Flight Data
          <Badge variant="light" color={liveFeed.active ? 'teal' : hasFlightData ? 'blue' : 'gray'}>
            {liveFeed.active ? 'Live Stream' : hasFlightData ? `${datasetInfo.segmentCount.toLocaleString()} segments` : 'None loaded.'}
          </Badge>
        </h2>

        {hasFlightData && (
          <div className={styles.row} style={{ marginBottom: '8px' }}>
            <span>Flight segments</span>
            <strong>{datasetInfo.segmentCount.toLocaleString()}</strong>
          </div>
        )}

        {/* Live ADS-B Stream Toggle */}
        <div style={{ marginBottom: '12px' }}>
          <Button fullWidth size="xs" color={liveFeed.active ? 'red' : 'blue'} onClick={liveFeed.active ? liveFeed.stop : liveFeed.start}>
            {liveFeed.active ? 'Stop live feed' : 'Start live feed'}
          </Button>
          {liveFeed.active && !liveFeed.coversView && (
            <p className={styles.hint} style={{ marginTop: '4px' }} role="status">The map shows more than the feed covers, so it follows only the circle around the middle of the map. Zoom in to where you are.</p>
          )}
          {liveFeed.active && (
            <p className={styles.hint} style={{ marginTop: '4px' }} role="status">
              {liveFeed.updatedAtEpochSec === null
                ? 'Waiting for the first answer.'
                : `Tracking ${String(liveFeed.aircraftCount)} aircraft within ${String(Math.round(liveFeed.radiusKm))} km, ${String(liveFeed.segmentCount)} flight segments. Segments need a few polls to form.`}
            </p>
          )}
          {!liveFeed.active && (
            <p className={styles.hint} style={{ marginTop: '6px' }}>
              Streams volunteer ADS-B receivers in the map view area without requiring an account or key.
            </p>
          )}
        </div>

        {/* Keyless Parquet Historical Query from adsb-core */}
        <div style={{ marginBottom: '12px', borderTop: '1px solid #2a2a34', paddingTop: '10px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>Historical Flights (adsb-core)</span>
          <p className={styles.hint} style={{ marginTop: '4px' }}>
            Fetch historical flight trajectories from the public CC0 adsb-core archive over range requests for the visible map area.
          </p>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
            <input
              type="date"
              className={styles.dropInput}
              style={{ position: 'relative', width: 'auto', padding: '4px 8px', fontSize: '12px' }}
              value={historyDate}
              onChange={(e) => { setHistoryDate(e.target.value); }}
              disabled={workingData}
            />
            <Button size="compact-xs" variant="light" disabled={workingData || !historyDate} onClick={handleQueryParquetHistory}>
              Fetch Area
            </Button>
          </div>
        </div>

        {/* Custom / Published Dataset Loading */}
        <div className={styles.row}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>Local / Published Datasets</span>
          {hasFlightData && !liveFeed.active && (
            <Button size="compact-xs" variant="subtle" color="gray" disabled={workingData} onClick={() => { void flightData.clear(); }}>
              Remove flight data
            </Button>
          )}
        </div>

        <label className={styles.dropZone} data-disabled={workingData} style={{ minHeight: '60px', padding: '8px', marginTop: '6px' }}>
          <span style={{ fontSize: '12px' }}>Choose a dataset file</span>
          <input
            type="file"
            className={styles.dropInput}
            accept=".json,application/json"
            aria-label="Flight data file"
            disabled={workingData}
            ref={datasetInputRef}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                void flightData.fromFile(file).finally(() => {
                  if (datasetInputRef.current !== null) {
                    datasetInputRef.current.value = '';
                  }
                });
              }
            }}
          />
        </label>

        {flightData.catalogue !== null && (
          <div style={{ marginTop: '10px' }}>
            <span style={{ fontSize: '12px', color: '#a3a3b8' }}>Published flight data:</span>
            {flightData.catalogue.length === 0 ? (
              <p className={styles.muted} style={{ fontSize: '12px' }}>No data is published yet.</p>
            ) : (
              <ul className={styles.catalogue} aria-label="Published flight data" style={{ marginTop: '6px' }}>
                {flightData.catalogue.map((file) => {
                  const fits = fitsInBrowser(file.sizeBytes);

                  return (
                    <li key={file.path} className={styles.catalogueItem}>
                      <span className={styles.catalogueName}>
                        <span>{file.path.replace('.dataset.json', '')}</span>
                        <span className={styles.muted}>{fits ? formatBytes(file.sizeBytes) : `${formatBytes(file.sizeBytes)}, too large for a browser`}</span>
                      </span>
                      <Button size="compact-xs" variant="light" disabled={workingData || !fits} onClick={() => { void flightData.fromCatalogue(file); }}>
                        Load
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* 5. Session Actions & Version */}
      <section className={styles.card} aria-label="Session">
        <div className={styles.row}>
          <span>Session ID: <code className={styles.mono}>{session?.id ?? 'none'}</code></span>
          <Button size="compact-xs" variant="light" disabled={session === null} onClick={exportSession}>
            Export JSON
          </Button>
        </div>
        <div className={styles.row} style={{ marginTop: '6px' }}>
          <span style={{ fontSize: '12px', color: '#a3a3b8' }}>Version</span>
          <a className={styles.link} href={buildIdentity.url} target="_blank" rel="noopener noreferrer" title={title}>
            {label}
          </a>
        </div>
      </section>
    </div>
  );
}
