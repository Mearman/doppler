import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDataset } from '../../src/browser/dataset-store';
import { emptyDataset } from '../../src/dataset';
import { MAX_RADIUS_KM, LiveFeedError, LiveTrackBook, fetchLivePings, liveDataset } from '../../src/live-adsb';
import { MS_PER_SECOND } from '../../src/time';
import type { Solver } from './use-solver';

/** Seconds between polls. The relay shares each answer between callers for 5 seconds, so a poll every 10 seconds is cheap for the upstream however many pages are open. */
const POLL_INTERVAL_SEC = 10;

/** The area the live feed is asked about: a centre and a radius. */
export interface SearchArea {
  readonly lat: number;
  readonly lon: number;
  readonly radiusKm: number;
}

/** What the live feed is doing. */
export interface LiveFeedState {
  readonly active: boolean;
  /** Aircraft with a report in the window, or 0 before the first answer. */
  readonly aircraftCount: number;
  /** Flight segments the tracks form so far; an aircraft needs more than one report to form one. */
  readonly segmentCount: number;
  /** Epoch seconds of the last answer, or null before one. */
  readonly updatedAtEpochSec: number | null;
}

/** The live feed as the page drives it. */
export interface LiveFeed extends LiveFeedState {
  /** Radius actually asked for: the area's, limited to what the relay forwards. */
  readonly radiusKm: number;
  /** Whether the visible map area fits inside what the relay forwards; when it does not, the feed follows only the circle around the map's centre. */
  readonly coversView: boolean;
  readonly start: () => void;
  readonly stop: () => void;
}

const IDLE: LiveFeedState = { active: false, aircraftCount: 0, segmentCount: 0, updatedAtEpochSec: null };

/**
 * Polls the live ADS-B relay around the search area and keeps the worker's flight data to the last few minutes of tracks.
 * While it runs it owns the worker's dataset; stopping it puts back the dataset the person loaded, or none.
 * @param solver - Receives each new dataset and reports failures.
 * @param area - The area to ask about, which follows the map.
 * @returns The feed's state and controls.
 */
export function useLiveFeed(solver: Readonly<Pick<Solver, 'setDataset' | 'reportError'>>, area: Readonly<SearchArea>): LiveFeed {
  const [state, setState] = useState<LiveFeedState>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);
  const areaRef = useRef(area);
  areaRef.current = area;
  const { setDataset, reportError } = solver;
  const radiusKm = Math.min(area.radiusKm, MAX_RADIUS_KM);

  const stop = useCallback((): void => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(IDLE);
    // Put back what the person had loaded before the feed took over.
    loadDataset()
      .then((stored) => {
        setDataset(stored ?? emptyDataset());
      })
      .catch((err: unknown) => {
        reportError(`Stored flight data could not be read: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, [reportError, setDataset]);

  const start = useCallback((): void => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const book = new LiveTrackBook();
    setState({ ...IDLE, active: true });

    /** Asks the feed once, then schedules the next ask; each ask follows the previous answer, so polls never overlap. */
    const poll = async (): Promise<void> => {
      let waitSec = POLL_INTERVAL_SEC;
      try {
        const { lat, lon, radiusKm: requested } = areaRef.current;
        const pings = await fetchLivePings({ lat, lon, radiusKm: requested }, controller.signal);
        book.add(pings);
        const segments = book.segments();
        const nowSec = Math.floor(Date.now() / MS_PER_SECOND);
        setDataset(liveDataset(segments, nowSec));
        setState({ active: true, aircraftCount: book.aircraftCount, segmentCount: segments.length, updatedAtEpochSec: nowSec });
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (err instanceof LiveFeedError && err.fatal) {
          // A query the relay refuses repeats on every poll, so the feed stops and says why.
          reportError(err.message);
          controller.abort();
          setState(IDLE);

          return;
        }
        if (err instanceof LiveFeedError && err.retryAfterSec !== undefined) {
          waitSec = err.retryAfterSec;
        } else {
          reportError(`The live feed could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const timer = setTimeout(() => {
        void poll();
      }, waitSec * MS_PER_SECOND);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
      });
    };
    void poll();
  }, [reportError, setDataset]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  return { ...state, radiusKm, coversView: area.radiusKm <= MAX_RADIUS_KM, start, stop };
}
