import type { QuietInterval } from '../schemas';
import {
  ANALYSIS_MAX_FREQ_HZ,
  ANALYSIS_MIN_FREQ_HZ,
  MISSING_BIN_POWER_DB,
  SPECTROGRAM_FFT_SIZE,
  SPECTROGRAM_HOP_SAMPLES,
} from './constants';
import { computeHannPowerSpectrumDb } from './fft';

/**
 * Default margin in dB by which a frame's median noise floor may exceed the reference floor before the frame is flagged as noise-polluted.
 */
const NOISE_POLLUTION_MARGIN_DB = 12;

/**
 * Default reference noise floor in dB against which a single isolated frame is judged for noise pollution when the caller supplies no baseline.
 */
const DEFAULT_BASELINE_NOISE_DB = -80;

/**
 * Overall median noise floor in dB reported for a spectrogram that holds no frames.
 */
const EMPTY_SPECTROGRAM_NOISE_DB = -90;

/**
 * Smallest absolute second difference in dB across a peak for which parabolic interpolation is attempted; a flatter peak keeps its integer bin.
 */
const MIN_PARABOLA_CURVATURE_DB = 1e-9;

/**
 * Largest sub-bin offset in bins that parabolic interpolation may apply to a peak: a true maximum lies within half a bin of the sampled one.
 */
const MAX_SUB_BIN_OFFSET = 0.5;

/**
 * Single Short-Time Fourier Transform (STFT) frame in the aircraft Doppler band (65 to 500 Hz by default).
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
    return MISSING_BIN_POWER_DB;
  }
  slice.sort((a, b) => a - b);
  const mid = slice.length >> 1;

  return slice[mid] ?? MISSING_BIN_POWER_DB;
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
  const fftSize = options.fftSize ?? SPECTROGRAM_FFT_SIZE;
  const minFreqHz = options.minFreqHz ?? ANALYSIS_MIN_FREQ_HZ;
  const maxFreqHz = options.maxFreqHz ?? ANALYSIS_MAX_FREQ_HZ;
  const timeSec = options.timeSec ?? 0;
  const pollutionMarginDb = options.noisePollutionThresholdDb ?? NOISE_POLLUTION_MARGIN_DB;
  const baselineNoiseDb = options.baselineNoiseDb ?? DEFAULT_BASELINE_NOISE_DB;

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
  const deltaBin = Math.abs(denom) > MIN_PARABOLA_CURVATURE_DB
      ? Math.max(-MAX_SUB_BIN_OFFSET, Math.min(MAX_SUB_BIN_OFFSET, ((leftDb - rightDb) / 2) / denom))
      : 0;
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
 * Computes a high-resolution spectrogram focused on the aircraft acoustic Doppler band (65 to 500 Hz by default), with parabolic sub-bin peak interpolation and continuous noise-pollution gating.
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
  const fftSize = options.fftSize ?? SPECTROGRAM_FFT_SIZE;
  const hopSamples = options.hopSamples ?? SPECTROGRAM_HOP_SAMPLES;
  const minFreqHz = options.minFreqHz ?? ANALYSIS_MIN_FREQ_HZ;
  const maxFreqHz = options.maxFreqHz ?? ANALYSIS_MAX_FREQ_HZ;
  const pollutionMarginDb = options.noisePollutionThresholdDb ?? NOISE_POLLUTION_MARGIN_DB;

  if (!(sampleRateHz > 0)) {
    throw new Error(`Sample rate must be positive, got ${String(sampleRateHz)} Hz`);
  }
  if (!Number.isInteger(hopSamples) || hopSamples < 1) {
    throw new Error(`hopSamples must be a positive integer, got ${String(hopSamples)}`);
  }

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
  const overallMedianNoiseDb = floorList.length > 0 ? (floorList[floorList.length >> 1] ?? EMPTY_SPECTROGRAM_NOISE_DB) : EMPTY_SPECTROGRAM_NOISE_DB;
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
      currentStart ??= frame.timeSec - frameDurationSec / 2;
      noiseAccum.push(frame.medianNoiseFloorDb);
    } else if (currentStart !== null) {
      const sortedNoise = [...noiseAccum].sort((a, b) => a - b);
      quietIntervals.push({
        startSec: currentStart,
        endSec: frame.timeSec - frameDurationSec / 2,
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
        endSec: lastFrame.timeSec + frameDurationSec / 2,
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
