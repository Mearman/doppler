import { useCallback, useEffect, useRef, useState } from 'react';
import { MicMonitor } from '../../src/browser/mic-monitor';
import type { ComputedSingleFrame } from '../../src/dsp/spectrogram';
import type { DopplerObservation } from '../../src/schemas';

/** Frames the rolling waterfall keeps; at the capture hop this is the window the live spectrogram shows. */
const LIVE_FRAME_LIMIT = 350;

/** Noise floor shown before any audio has been analysed, in decibels. */
const INITIAL_NOISE_FLOOR_DB = -82;

/** Callbacks the page gives the microphone. */
export interface MicrophoneHandlers {
  readonly onObservation: (observation: Readonly<DopplerObservation>) => void;
  readonly onError: (message: string) => void;
}

/** The live microphone as the page drives it. */
export interface Microphone {
  readonly isListening: boolean;
  readonly isPaused: boolean;
  readonly noiseFloorDb: number;
  readonly isNoisePolluted: boolean;
  readonly liveFrames: readonly ComputedSingleFrame[];
  readonly toggle: () => Promise<void>;
  readonly togglePause: () => void;
  readonly clearFrames: () => void;
}

/**
 * Owns the microphone monitor and the rolling waterfall it feeds.
 * @param handlers - Receives each detected flyover and each failure; read at call time, so the latest closure is used.
 * @returns The monitor's state and the actions that drive it.
 */
export function useMicrophone(handlers: Readonly<MicrophoneHandlers>): Microphone {
  const [isListening, setIsListening] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [noiseFloorDb, setNoiseFloorDb] = useState(INITIAL_NOISE_FLOOR_DB);
  const [isNoisePolluted, setIsNoisePolluted] = useState(false);
  const [liveFrames, setLiveFrames] = useState<readonly ComputedSingleFrame[]>([]);
  const monitorRef = useRef<MicMonitor | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const monitor = new MicMonitor({
      onSpectrogramFrame: (frame) => {
        setLiveFrames((previous) => [...previous.slice(-(LIVE_FRAME_LIMIT - 1)), frame]);
      },
      onNoiseUpdate: (noiseDb, isPolluted) => {
        setNoiseFloorDb(noiseDb);
        setIsNoisePolluted(isPolluted);
      },
      onObservationDetected: (observation) => {
        handlersRef.current.onObservation(observation);
      },
      onError: (err) => {
        handlersRef.current.onError(`Microphone error: ${err.message}`);
        setIsListening(false);
      },
    });
    monitorRef.current = monitor;

    return () => {
      monitor.stop();
    };
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    if (isListening) {
      monitorRef.current?.stop();
      setIsListening(false);
      setIsPaused(false);

      return;
    }
    try {
      await monitorRef.current?.start(`live_${String(Date.now())}`);
      setLiveFrames([]);
      setIsListening(true);
      setIsPaused(false);
    } catch (err) {
      setIsListening(false);
      const message = err instanceof Error ? err.message : String(err);
      handlersRef.current.onError(`The microphone could not be started: ${message}. Allow microphone access for this site in the browser settings and try again.`);
    }
  }, [isListening]);

  const togglePause = useCallback((): void => {
    if (!isListening) {
      return;
    }
    if (isPaused) {
      monitorRef.current?.resume();
    } else {
      monitorRef.current?.pause();
    }
    setIsPaused(!isPaused);
  }, [isListening, isPaused]);

  const clearFrames = useCallback((): void => {
    setLiveFrames([]);
  }, []);

  return { isListening, isPaused, noiseFloorDb, isNoisePolluted, liveFrames, toggle, togglePause, clearFrames };
}
