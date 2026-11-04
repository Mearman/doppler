import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSessionsFromStorage, saveSessionToStorage } from '../../src/browser/storage';
import { loadDataset } from '../../src/browser/dataset-store';
import { type DatasetInfo, type DopplerDataset, type DopplerObservation, type LocationSession, LocationSessionSchema } from '../../src/schemas';
import { type AnalysisStage, WorkerReplySchema } from './worker-protocol';
import type { ClipSpectrogramData } from './spectrogram-viewer';

/** What the page knows about an analysis while the worker runs it. */
export interface RunningAnalysis {
  readonly id: string;
  /** The sentence that says what is being analysed, such as "Analyzing notes.wav". */
  readonly label: string;
  /** The stage the worker reported last, or null before its first report. */
  readonly stage: AnalysisStage | null;
}

/** What an analysed clip adds to the session, kept beside the spectrogram it produced. */
export interface ClipSummary {
  readonly observationCount: number;
  readonly medianNoiseDb: number;
}

/** A request to analyse audio, as the worker takes it. */
export type AnalysisRequest = Readonly<{ id: string; type: 'process_audio' | 'process_wav'; payload: Readonly<Record<string, unknown>> }>;

/** The solver worker as the page drives it. */
export interface Solver {
  readonly session: LocationSession | null;
  readonly clip: ClipSpectrogramData | null;
  readonly clipSummary: ClipSummary | null;
  readonly analysis: RunningAnalysis | null;
  /** What the worker matches flyovers against, or null before it has said. */
  readonly datasetInfo: DatasetInfo | null;
  readonly error: string | null;
  readonly dismissError: () => void;
  readonly reportError: (message: string) => void;
  readonly startAnalysis: (request: AnalysisRequest, label: string, transfer: readonly Transferable[]) => void;
  readonly ingestObservation: (observation: Readonly<DopplerObservation>) => void;
  readonly setDataset: (dataset: Readonly<DopplerDataset>) => void;
}

/**
 * Owns the solver worker and everything it returns: the session, the analysed clip and the state of a running analysis.
 * A saved session that still matches the current schema is resumed, and every new session is saved.
 * @returns The solver's state and the actions that drive it.
 */
export function useSolver(): Solver {
  const [session, setSession] = useState<LocationSession | null>(() => {
    return loadSessionsFromStorage()
      .map((candidate) => LocationSessionSchema.safeParse(candidate))
      .find((result) => result.success)?.data ?? null;
  });
  const [clip, setClip] = useState<ClipSpectrogramData | null>(null);
  const [clipSummary, setClipSummary] = useState<ClipSummary | null>(null);
  const [analysis, setAnalysis] = useState<RunningAnalysis | null>(null);
  const [datasetInfo, setDatasetInfo] = useState<DatasetInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    // Only autosave session if it has new content or was mutated from worker/live action
    if (session !== null && session.episodes.length > 0) {
      saveSessionToStorage(session);
    }
  }, [session]);

  useEffect(() => {
    const worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const parsed = WorkerReplySchema.safeParse(event.data);
      if (!parsed.success) {
        return;
      }
      const reply = parsed.data;
      if (reply.success && reply.type === 'progress') {
        setAnalysis((current) => (current !== null && current.id === reply.id ? { ...current, stage: reply.stage } : current));

        return;
      }
      setAnalysis((current) => (current !== null && current.id === reply.id ? null : current));
      if (!reply.success) {
        setError(`Analysis failed: ${reply.error}`);

        return;
      }
      if (reply.type === 'audio_analysed') {
        setError(null);
      }
      if (reply.type === 'session') {
        setSession(reply.data);
      } else if (reply.type === 'dataset_updated') {
        setDatasetInfo(reply.info);
        // Note: do NOT overwrite session with null when dataset is updated
        setDatasetInfo(reply.info);
      } else {
        setClip(reply.data.spectrogram);
        setClipSummary({ observationCount: reply.data.observations.length, medianNoiseDb: reply.data.spectrogramSummary.medianNoiseDb });
        setSession(reply.data.session);
      }
    };

    worker.onerror = (event) => {
      setAnalysis(null);
      setError(`The analysis worker stopped: ${event.message}`);
    };

    // The flight data a person loaded on an earlier visit comes back with the session.
    loadDataset()
      .then((stored) => {
        const saved = loadSessionsFromStorage()
          .map((candidate) => LocationSessionSchema.safeParse(candidate))
          .find((result) => result.success)?.data;
        if (saved !== undefined) {
          setSession(saved);
        }
        if (stored !== undefined) {
          worker.postMessage({ id: 'stored_dataset', type: 'set_dataset', payload: stored });
        }
        worker.postMessage({ id: 'init', type: 'init_session', payload: saved === undefined ? {} : { initialSession: saved } });
      })
      .catch((err: unknown) => {
        setError(`Stored flight data could not be read: ${err instanceof Error ? err.message : String(err)}`);
        const saved = loadSessionsFromStorage()
          .map((candidate) => LocationSessionSchema.safeParse(candidate))
          .find((result) => result.success)?.data;
        if (saved !== undefined) {
          setSession(saved);
        }
        worker.postMessage({ id: 'init', type: 'init_session', payload: saved === undefined ? {} : { initialSession: saved } });
      });

    return () => {
      worker.terminate();
    };
  }, []);

  const startAnalysis = useCallback((request: AnalysisRequest, label: string, transfer: readonly Transferable[]): void => {
    setAnalysis({ id: request.id, label, stage: null });
    setError(null);
    workerRef.current?.postMessage(request, [...transfer]);
  }, []);

  const ingestObservation = useCallback((observation: Readonly<DopplerObservation>): void => {
    workerRef.current?.postMessage({ id: `obs_${String(Date.now())}`, type: 'ingest_observation', payload: observation });
  }, []);

  const setDataset = useCallback((dataset: Readonly<DopplerDataset>): void => {
    workerRef.current?.postMessage({ id: `dataset_${String(Date.now())}`, type: 'set_dataset', payload: dataset });
  }, []);

  const dismissError = useCallback((): void => {
    setError(null);
  }, []);

  return { session, clip, clipSummary, analysis, datasetInfo, error, dismissError, reportError: setError, startAnalysis, ingestObservation, setDataset };
}
