import { z } from 'zod';
import { BUNDLED_DATASET } from '../../src/bundled';
import { decimateAudioStream } from '../../src/dsp/decimate';
import { extractDopplerObservations } from '../../src/dsp/ridge-tracker';
import { detectEnfSignature } from '../../src/dsp/side-channels';
import { computeDopplerSpectrogram } from '../../src/dsp/spectrogram';
import type { DopplerDataset } from '../../src/schemas';
import { DopplerSessionEngine } from '../../src/solver/session';
import { RequestEnvelopeSchema, type WorkerReply, WorkerRequestSchema } from './worker-protocol';

/** Sample rate that analysed audio is decimated to, in Hz. The aircraft Doppler band lies far below its Nyquist frequency of 1,000 Hz. */
const ANALYSIS_RATE_HZ = 2000;

/** FFT length of the analysis spectrogram: a power of two giving about 1 Hz of resolution at the analysis rate. */
const FFT_SIZE = 2048;

/** Hop of the analysis spectrogram, in samples at the analysis rate. */
const HOP_SAMPLES = 500;

/** Passband of the analysis spectrogram, in Hz. */
const MIN_FREQ_HZ = 65;
const MAX_FREQ_HZ = 400;

/** Smallest signal-to-noise ratio, in dB, at which a spectrogram ridge counts as an observation. */
const MIN_RIDGE_SNR_DB = 6;

/** Ambient air temperature assumed for the speed of sound when the page gives none, in degrees Celsius. */
const DEFAULT_AMBIENT_TEMP_CELSIUS = 20;

let engine: DopplerSessionEngine | null = null;
let currentDataset: DopplerDataset = BUNDLED_DATASET;

/**
 * Sends a reply to the page.
 * @param message - The reply, which echoes the id of the request it answers.
 */
function reply(message: Readonly<WorkerReply>): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<unknown>) => {
  const parsed = WorkerRequestSchema.safeParse(event.data);
  if (!parsed.success) {
    const envelope = RequestEnvelopeSchema.safeParse(event.data);
    reply({ id: envelope.success ? envelope.data.id : '', success: false, error: z.prettifyError(parsed.error) });

    return;
  }
  const req = parsed.data;
  try {
    switch (req.type) {
      case 'set_dataset': {
        currentDataset = req.payload;
        if (engine !== null) {
          engine = new DopplerSessionEngine({
            dataset: currentDataset,
            initialSession: engine.getSession(),
          });
        }
        reply({ id: req.id, success: true, type: 'dataset_updated' });

        return;
      }

      case 'init_session': {
        const p = req.payload;
        engine = new DopplerSessionEngine({
          dataset: currentDataset,
          ...(p.initialSession !== undefined ? { initialSession: p.initialSession } : {}),
          ...(p.constraints !== undefined ? { constraints: p.constraints } : {}),
          ambientTempCelsius: p.tempCelsius ?? DEFAULT_AMBIENT_TEMP_CELSIUS,
        });
        reply({ id: req.id, success: true, type: 'session', data: engine.getSession() });

        return;
      }

      case 'update_constraints': {
        engine ??= new DopplerSessionEngine({ dataset: currentDataset });
        const updated = engine.updateConstraints(req.payload);
        reply({ id: req.id, success: true, type: 'session', data: updated });

        return;
      }

      case 'ingest_observation': {
        engine ??= new DopplerSessionEngine({ dataset: currentDataset });
        const updated = engine.ingestObservation(req.payload);
        reply({ id: req.id, success: true, type: 'session', data: updated });

        return;
      }

      case 'process_audio': {
        const p = req.payload;

        const decimated = decimateAudioStream(p.rawSamples, p.sampleRateHz, ANALYSIS_RATE_HZ);
        const enf = detectEnfSignature(decimated.samples, decimated.sampleRateHz);

        const spectrogram = computeDopplerSpectrogram(decimated.samples, {
          sampleRateHz: decimated.sampleRateHz,
          startTimeSec: p.startEpochSec,
          fftSize: FFT_SIZE,
          hopSamples: HOP_SAMPLES,
          minFreqHz: MIN_FREQ_HZ,
          maxFreqHz: MAX_FREQ_HZ,
        });

        const observations = extractDopplerObservations(spectrogram, {
          episodeId: p.episodeId,
          minSnrDb: MIN_RIDGE_SNR_DB,
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
        reply({
          id: req.id,
          success: true,
          type: 'audio_analysed',
          data: {
            session,
            observations,
            enf,
            spectrogram: {
              minFreqHz: spectrogram.minFreqHz,
              maxFreqHz: spectrogram.maxFreqHz,
              binStepHz: spectrogram.binStepHz,
              minBin: spectrogram.minBin,
              maxBin: spectrogram.maxBin,
              overallMedianNoiseDb: spectrogram.overallMedianNoiseDb,
              frames: spectrogram.frames,
            },
            spectrogramSummary: {
              frameCount: spectrogram.frames.length,
              quietIntervalsCount: spectrogram.quietIntervals.length,
              medianNoiseDb: spectrogram.overallMedianNoiseDb,
            },
          },
        });

        return;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply({ id: req.id, success: false, error: message });
  }
};
