import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSessionsFromStorage, saveSessionToStorage } from '../../src/browser/storage';
import { type LocationSession, LocationSessionSchema } from '../../src/schemas';
import type { DopplerObservation } from '../../src/schemas';
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
  readonly error: string | null;
  readonly dismissError: () => void;
  readonly reportError: (message: string) => void;
  readonly startAnalysis: (request: AnalysisRequest, label: string, transfer: readonly Transferable[]) => void;
  readonly ingestObservation: (observation: Readonly<DopplerObservation>) => void;
}

/**
 * Owns the solver worker and everything it returns: the session, the analysed clip and the state of a running analysis.
 * A saved session that still matches the current schema is resumed, and every new session is saved.
 * @returns The solver's state and the actions that drive it.
 */
export function useSolver(): Solver {
  const [session, setSession] = useState<LocationSession | null>(null);
  const [clip, setClip] = useState<ClipSpectrogramData | null>(null);
  const [clipSummary, setClipSummary] = useState<ClipSummary | null>(null);
  const [analysis, setAnalysis] = useState<RunningAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    if (session !== null) {
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
      setError(null);
      if (reply.type === 'session') {
        setSession(reply.data);
      } else if (reply.type === 'audio_analysed') {
        setClip(reply.data.spectrogram);
        setClipSummary({ observationCount: reply.data.observations.length, medianNoiseDb: reply.data.spectrogramSummary.medianNoiseDb });
        setSession(reply.data.session);
      }
    };

    worker.onerror = (event) => {
      setAnalysis(null);
      setError(`The analysis worker stopped: ${event.message}`);
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

  const startAnalysis = useCallback((request: AnalysisRequest, label: string, transfer: readonly Transferable[]): void => {
    setAnalysis({ id: request.id, label, stage: null });
    setError(null);
    workerRef.current?.postMessage(request, [...transfer]);
  }, []);

  const ingestObservation = useCallback((observation: Readonly<DopplerObservation>): void => {
    workerRef.current?.postMessage({ id: `obs_${String(Date.now())}`, type: 'ingest_observation', payload: observation });
  }, []);

  const dismissError = useCallback((): void => {
    setError(null);
  }, []);

  return { session, clip, clipSummary, analysis, error, dismissError, reportError: setError, startAnalysis, ingestObservation };
}
