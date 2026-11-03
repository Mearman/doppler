import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDataset } from '../../src/browser/dataset-store';
import { loadLiveFeedKey, saveLiveFeedKey } from '../../src/browser/storage';
import { emptyDataset } from '../../src/dataset';
import { FREE_PLAN_MAX_RADIUS_KM, LiveFeedError, LiveTrackBook, fetchLivePings, liveDataset } from '../../src/live-adsb';
import { MS_PER_SECOND } from '../../src/time';
import type { Solver } from './use-solver';

/** Seconds between polls. The free plan allows 30 requests a minute per key, so a poll every 10 seconds uses a fifth of that and leaves room for a second tab. */
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
  readonly apiKey: string;
  readonly setApiKey: (apiKey: string) => void;
  /** Radius actually asked for: the area's, limited to what the free plan allows. */
  readonly radiusKm: number;
  readonly start: () => void;
  readonly stop: () => void;
}

const IDLE: LiveFeedState = { active: false, aircraftCount: 0, segmentCount: 0, updatedAtEpochSec: null };

/**
 * Polls the live ADS-B feed around the search area and keeps the worker's flight data to the last few minutes of tracks.
 * While it runs it owns the worker's dataset; stopping it puts back the dataset the person loaded, or none.
 * @param solver - Receives each new dataset and reports failures.
 * @param area - The area to ask about, which follows the map.
 * @returns The feed's state and controls.
 */
export function useLiveFeed(solver: Readonly<Pick<Solver, 'setDataset' | 'reportError'>>, area: Readonly<SearchArea>): LiveFeed {
  const [apiKey, setApiKeyState] = useState(loadLiveFeedKey);
  const [state, setState] = useState<LiveFeedState>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);
  const areaRef = useRef(area);
  areaRef.current = area;
  const { setDataset, reportError } = solver;
  const radiusKm = Math.min(area.radiusKm, FREE_PLAN_MAX_RADIUS_KM);

  const setApiKey = useCallback(
    (next: string): void => {
      setApiKeyState(next);
      try {
        saveLiveFeedKey(next);
      } catch (err) {
        reportError(`The key could not be kept in this browser: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [reportError],
  );

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
        const pings = await fetchLivePings({ apiKey, lat, lon, radiusKm: Math.min(requested, FREE_PLAN_MAX_RADIUS_KM) }, controller.signal);
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
          // A bad key or radius repeats on every poll, so the feed stops and says why.
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
  }, [apiKey, reportError, setDataset]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  return { ...state, apiKey, setApiKey, radiusKm, start, stop };
}
