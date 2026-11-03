import { BUNDLED_DATASET } from '../../src/bundled';
import { decimateAudioStream } from '../../src/dsp/decimate';
import { extractDopplerObservations } from '../../src/dsp/ridge-tracker';
import { detectEnfSignature } from '../../src/dsp/side-channels';
import { computeDopplerSpectrogram } from '../../src/dsp/spectrogram';
import type { DopplerDataset, DopplerObservation, LocationSession, SearchConstraints } from '../../src/schemas';
import { DopplerSessionEngine } from '../../src/solver/session';

export {};

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown) => void;
}
const ctx = self as unknown as WorkerScope;

let engine: DopplerSessionEngine | null = null;
let currentDataset: DopplerDataset = BUNDLED_DATASET;

interface WorkerRequest {
  readonly id: string;
  readonly type: 'init_session' | 'process_audio' | 'ingest_observation' | 'update_constraints' | 'set_dataset';
  readonly payload: unknown;
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    switch (req.type) {
      case 'set_dataset': {
        currentDataset = req.payload as DopplerDataset;
        if (engine !== null) {
          engine = new DopplerSessionEngine({
            dataset: currentDataset,
            initialSession: engine.getSession(),
          });
        }
        ctx.postMessage({ id: req.id, success: true, data: { status: 'dataset_updated' } });

        return;
      }

      case 'init_session': {
        const p = (req.payload ?? {}) as { initialSession?: LocationSession; constraints?: SearchConstraints; tempCelsius?: number };
        engine = new DopplerSessionEngine({
          dataset: currentDataset,
          ...(p.initialSession !== undefined ? { initialSession: p.initialSession } : {}),
          ...(p.constraints !== undefined ? { constraints: p.constraints } : {}),
          ambientTempCelsius: p.tempCelsius ?? 20.0,
        });
        ctx.postMessage({ id: req.id, success: true, data: engine.getSession() });

        return;
      }

      case 'update_constraints': {
        engine ??= new DopplerSessionEngine({ dataset: currentDataset });
        const updated = engine.updateConstraints(req.payload as SearchConstraints);
        ctx.postMessage({ id: req.id, success: true, data: updated });

        return;
      }

      case 'ingest_observation': {
        engine ??= new DopplerSessionEngine({ dataset: currentDataset });
        const updated = engine.ingestObservation(req.payload as DopplerObservation);
        ctx.postMessage({ id: req.id, success: true, data: updated });

        return;
      }

      case 'process_audio': {
        const p = req.payload as {
          rawSamples: Float32Array;
          sampleRateHz: number;
          startEpochSec: number;
          episodeId: string;
        };

        const decimated = decimateAudioStream(p.rawSamples, p.sampleRateHz, 2000);
        const enf = detectEnfSignature(decimated.samples, decimated.sampleRateHz);

        const spectrogram = computeDopplerSpectrogram(decimated.samples, {
          sampleRateHz: decimated.sampleRateHz,
          startTimeSec: p.startEpochSec,
          fftSize: 2048,
          hopSamples: 500,
          minFreqHz: 65,
          maxFreqHz: 400,
        });

        const observations = extractDopplerObservations(spectrogram, {
          episodeId: p.episodeId,
          minSnrDb: 6.0,
        });

        engine ??= new DopplerSessionEngine({
          dataset: currentDataset,
          constraints: enf.detected ? { enfNominalHz: enf.nominalHz === '50' ? '50' : '60' } : {},
        });

        engine.startEpisode(p.startEpochSec);
        for (const obs of observations) {
          engine.ingestObservation(obs);
        }

        const session = engine.getSession();
        ctx.postMessage({
          id: req.id,
          success: true,
          data: {
            session,
            observations,
            enf,
            spectrogramSummary: {
              frameCount: spectrogram.frames.length,
              quietIntervalsCount: spectrogram.quietIntervals.length,
              medianNoiseDb: spectrogram.overallMedianNoiseDb,
            },
          },
        });

        return;
      }

      default: {
        throw new Error('Unknown worker message type');
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ id: req.id, success: false, error: message });
  }
};
