import type { QuietInterval } from '../schemas';
import { computeHannPowerSpectrumDb } from './fft';

/**
 * Single Short-Time Fourier Transform (STFT) frame in the 30–600 Hz aircraft Doppler band.
 */
export interface SpectrogramFrame {
  readonly timeSec: number;
  readonly powerDb: Float64Array;
  readonly medianNoiseFloorDb: number;
  readonly peakFreqHz: number;
  readonly peakPowerDb: number;
  readonly peakSnrDb: number;
  readonly noisePolluted: boolean;
}

/**
 * Computed spectrogram grid and continuous noise-floor telemetry over an audio recording or episode window.
 */
export interface DopplerSpectrogram {
  readonly sampleRateHz: number;
  readonly fftSize: number;
  readonly minFreqHz: number;
  readonly maxFreqHz: number;
  readonly minBin: number;
  readonly maxBin: number;
  readonly binStepHz: number;
  readonly frames: readonly SpectrogramFrame[];
  readonly quietIntervals: readonly QuietInterval[];
  readonly overallMedianNoiseDb: number;
}

/**
 * Configuration options for computing a Doppler spectrogram.
 */
export interface SpectrogramOptions {
  readonly sampleRateHz: number;
  readonly startTimeSec?: number;
  readonly fftSize?: number;
  readonly hopSamples?: number;
  readonly minFreqHz?: number;
  readonly maxFreqHz?: number;
  readonly noisePollutionThresholdDb?: number;
}

/**
 * Options for computing an isolated single STFT frame.
 */
export interface SingleFrameOptions {
  readonly sampleRateHz: number;
  readonly fftSize?: number;
  readonly minFreqHz?: number;
  readonly maxFreqHz?: number;
  readonly timeSec?: number;
  readonly noisePollutionThresholdDb?: number;
  readonly baselineNoiseDb?: number;
}

/**
 * Result of computing an isolated single STFT frame, including bin boundaries and frequency step.
 */
export interface ComputedSingleFrame extends SpectrogramFrame {
  readonly minBin: number;
  readonly maxBin: number;
  readonly binStepHz: number;
}

/**
 * Computes the median value of a numeric slice without mutating the source buffer.
 */
function medianOfSlice(values: Readonly<Float64Array>, start: number, end: number): number {
  const slice: number[] = [];
  for (let i = start; i <= end; i += 1) {
    const val = values[i];
    if (val !== undefined) {
      slice.push(val);
    }
  }
  if (slice.length === 0) {
    return -120;
  }
  slice.sort((a, b) => a - b);
  const mid = slice.length >> 1;

  return slice[mid] ?? -120;
}

/**
 * Computes an isolated single STFT spectrogram frame over a single time window.
 * @param windowSlice - Time-domain audio slice (length must match fftSize).
 * @param options - Single frame computation options.
 * @returns Computed STFT frame, peak tracking values, and frequency bin parameters.
 */
export function computeSingleSpectrogramFrame(
  windowSlice: Readonly<Float32Array>,
  options: Readonly<SingleFrameOptions>,
): ComputedSingleFrame {
  const sampleRateHz = options.sampleRateHz;
  const fftSize = options.fftSize ?? 2048;
  const minFreqHz = options.minFreqHz ?? 65;
  const maxFreqHz = options.maxFreqHz ?? 500;
  const timeSec = options.timeSec ?? 0;
  const pollutionMarginDb = options.noisePollutionThresholdDb ?? 12;
  const baselineNoiseDb = options.baselineNoiseDb ?? -80;

  const binStepHz = sampleRateHz / fftSize;
  const minBin = Math.max(1, Math.floor(minFreqHz / binStepHz));
  const maxBin = Math.min((fftSize >> 1) - 1, Math.ceil(maxFreqHz / binStepHz));

  const fullSpectrumDb = computeHannPowerSpectrumDb(windowSlice, fftSize);
  const medianNoiseFloorDb = medianOfSlice(fullSpectrumDb, minBin, maxBin);

  let bestBin = minBin;
  let bestPowerDb = -Infinity;
  for (let b = minBin; b <= maxBin; b += 1) {
    const p = fullSpectrumDb[b] ?? -Infinity;
    if (p > bestPowerDb) {
      bestPowerDb = p;
      bestBin = b;
    }
  }

  // Parabolic sub-bin interpolation around bestBin
  const leftDb = fullSpectrumDb[bestBin - 1] ?? bestPowerDb;
  const rightDb = fullSpectrumDb[bestBin + 1] ?? bestPowerDb;
  const denom = leftDb - 2 * bestPowerDb + rightDb;
  const deltaBin = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (leftDb - rightDb)) / denom)) : 0;
  const peakFreqHz = (bestBin + deltaBin) * binStepHz;
  const peakSnrDb = bestPowerDb - medianNoiseFloorDb;
  const bandPowerDb = fullSpectrumDb.slice(minBin, maxBin + 1);

  return {
    timeSec,
    powerDb: bandPowerDb,
    medianNoiseFloorDb,
    peakFreqHz,
    peakPowerDb: bestPowerDb,
    peakSnrDb,
    noisePolluted: medianNoiseFloorDb > baselineNoiseDb + pollutionMarginDb,
    minBin,
    maxBin,
    binStepHz,
  };
}

/**
 * Computes a high-resolution spectrogram focused on the 30–600 Hz aircraft acoustic Doppler band, with parabolic sub-bin peak interpolation and continuous noise-pollution gating.
 * @param samples - Decimated mono audio samples (typically at 2,000 Hz).
 * @param options - Spectrogram configuration parameters.
 * @returns Spectrogram frames, sub-bin peak tracks, and quiet intervals where silence filtering is valid.
 */
export function computeDopplerSpectrogram(
  samples: Readonly<Float32Array>,
  options: Readonly<SpectrogramOptions>,
): DopplerSpectrogram {
  const sampleRateHz = options.sampleRateHz;
  const startTimeSec = options.startTimeSec ?? 0;
  const fftSize = options.fftSize ?? 2048;
  const hopSamples = options.hopSamples ?? 500;
  const minFreqHz = options.minFreqHz ?? 65;
  const maxFreqHz = options.maxFreqHz ?? 500;
  const pollutionMarginDb = options.noisePollutionThresholdDb ?? 12;

  const binStepHz = sampleRateHz / fftSize;
  const minBin = Math.max(1, Math.floor(minFreqHz / binStepHz));
  const maxBin = Math.min((fftSize >> 1) - 1, Math.ceil(maxFreqHz / binStepHz));

  const rawFrames: ComputedSingleFrame[] = [];

  for (let offset = 0; offset + fftSize <= samples.length; offset += hopSamples) {
    const windowSlice = samples.subarray(offset, offset + fftSize);
    const frameTimeSec = startTimeSec + (offset + fftSize / 2) / sampleRateHz;
    const frame = computeSingleSpectrogramFrame(windowSlice, {
      sampleRateHz,
      fftSize,
      minFreqHz,
      maxFreqHz,
      timeSec: frameTimeSec,
    });
    rawFrames.push(frame);
  }

  const floorList = rawFrames.map((f) => f.medianNoiseFloorDb).sort((a, b) => a - b);
  const overallMedianNoiseDb = floorList.length > 0 ? (floorList[floorList.length >> 1] ?? -90) : -90;
  const frameDurationSec = hopSamples / sampleRateHz;

  const frames: SpectrogramFrame[] = rawFrames.map((f) => ({
    timeSec: f.timeSec,
    powerDb: f.powerDb,
    medianNoiseFloorDb: f.medianNoiseFloorDb,
    peakFreqHz: f.peakFreqHz,
    peakPowerDb: f.peakPowerDb,
    peakSnrDb: f.peakSnrDb,
    noisePolluted: f.medianNoiseFloorDb > overallMedianNoiseDb + pollutionMarginDb,
  }));

  // Group contiguous non-polluted frames into QuietIntervals for episode-aware silence masking
  const quietIntervals: QuietInterval[] = [];
  let currentStart: number | null = null;
  let noiseAccum: number[] = [];

  for (const frame of frames) {
    if (!frame.noisePolluted) {
      currentStart ??= frame.timeSec - 0.5 * frameDurationSec;
      noiseAccum.push(frame.medianNoiseFloorDb);
    } else if (currentStart !== null) {
      const sortedNoise = [...noiseAccum].sort((a, b) => a - b);
      quietIntervals.push({
        startSec: currentStart,
        endSec: frame.timeSec - 0.5 * frameDurationSec,
        medianNoiseFloorDb: sortedNoise[sortedNoise.length >> 1] ?? overallMedianNoiseDb,
      });
      currentStart = null;
      noiseAccum = [];
    }
  }

  if (currentStart !== null && frames.length > 0) {
    const lastFrame = frames[frames.length - 1];
    const sortedNoise = [...noiseAccum].sort((a, b) => a - b);
    if (lastFrame !== undefined) {
      quietIntervals.push({
        startSec: currentStart,
        endSec: lastFrame.timeSec + 0.5 * frameDurationSec,
        medianNoiseFloorDb: sortedNoise[sortedNoise.length >> 1] ?? overallMedianNoiseDb,
      });
    }
  }

  return {
    sampleRateHz,
    fftSize,
    minFreqHz,
    maxFreqHz,
    minBin,
    maxBin,
    binStepHz,
    frames,
    quietIntervals,
    overallMedianNoiseDb,
  };
}
