import { geoToLocalEnu } from '../physics/geo';
import type { GeoPoint3D, LinearFlightSegment } from '../schemas';
import { NO_BACKGROUND_NOISE_FLOOR_DB, SPEED_OF_SOUND_MPS } from './constants';
import { computeHannPowerSpectrumDb } from './fft';

/**
 * Length in samples of the emission-time grid that the audio is resampled onto and transformed. At the analysis rate it spans 2.048 s, twice the default spectrogram window, so that the collapsed stationary tone integrates over more cycles.
 */
const DECHIRP_FFT_SIZE = 4096;

/**
 * Shortest flight-segment duration in seconds used as a divisor when deriving the segment's velocity, so that a degenerate zero-length segment cannot divide by zero.
 */
const MIN_SEGMENT_DURATION_SEC = 1e-3;

/**
 * Half-width in Hz of the band around the expected base frequency in which the stationary peak is searched for, and from which the background level is taken.
 */
const PEAK_SEARCH_HALF_WIDTH_HZ = 15;

/**
 * Number of bins either side of the peak that are excluded from the background estimate because the peak's main lobe spreads into them.
 */
const PEAK_EXCLUSION_BINS = 3;

/**
 * Result of 1D emission-time de-chirping matched-filter evaluation.
 */
export interface DechirpScoreResult {
  readonly coherentSnrDb: number;
  readonly recoveredBaseFreqHz: number;
  readonly resampledSamples: Float32Array;
}

/**
 * Options for emission-domain de-chirping analysis.
 */
export interface DechirpOptions {
  readonly sampleRateHz: number;
  readonly bufferStartEpochSec: number;
  readonly observer: Readonly<GeoPoint3D>;
  readonly segment: Readonly<LinearFlightSegment>;
  readonly expectedBaseFreqHz: number;
  readonly soundSpeedMps?: number;
}

/**
 * Evaluates a candidate observer coordinate and aircraft segment by resampling the raw 1D audio signal onto uniform aircraft emission times `t_emit`.
 *
 * Because `t_obs(t_emit) = t_emit + || r(t_emit) - x_obs || / c`, sampling the microphone waveform at `t_obs(t_emit)` undoes the Doppler time-dilation and collapses the curved 2-minute Doppler S-curve into a single stationary sinusoid at `f0`, providing ~20 dB of coherent FFT integration gain.
 * @param samples - Decimated mono audio buffer.
 * @param options - Dechirp options including observer, segment, and expected frequency.
 * @returns Coherent FFT SNR in dB, recovered stationary peak frequency, and de-warped waveform.
 */
export function scoreByEmissionDechirping(
  samples: Readonly<Float32Array>,
  options: Readonly<DechirpOptions>,
): DechirpScoreResult {
  const { sampleRateHz, bufferStartEpochSec, observer, segment, expectedBaseFreqHz, soundSpeedMps = SPEED_OF_SOUND_MPS } = options;
  const resampled = new Float32Array(DECHIRP_FFT_SIZE);
  const segDuration = Math.max(MIN_SEGMENT_DURATION_SEC, segment.endEpochSec - segment.startEpochSec);
  const startEnu = geoToLocalEnu(observer, segment.startGeo);
  const endEnu = geoToLocalEnu(observer, segment.endGeo);

  const vx = (endEnu.x - startEnu.x) / segDuration;
  const vy = (endEnu.y - startEnu.y) / segDuration;
  const vz = (endEnu.z - startEnu.z) / segDuration;

  const bufferDurationSec = samples.length / sampleRateHz;
  const midObsEpochSec = bufferStartEpochSec + bufferDurationSec / 2;
  const approxDelaySec = Math.hypot(startEnu.x, startEnu.y, startEnu.z) / soundSpeedMps;
  const centerEmitEpochSec = midObsEpochSec - approxDelaySec;
  const windowDurationSec = DECHIRP_FFT_SIZE / sampleRateHz;
  const emitStartEpochSec = centerEmitEpochSec - windowDurationSec / 2;

  for (let i = 0; i < DECHIRP_FFT_SIZE; i += 1) {
    const emitEpochSec = emitStartEpochSec + i / sampleRateHz;
    const dtSeg = emitEpochSec - segment.startEpochSec;
    const rx = startEnu.x + vx * dtSeg;
    const ry = startEnu.y + vy * dtSeg;
    const rz = startEnu.z + vz * dtSeg;
    const slantDist = Math.hypot(rx, ry, rz);

    const obsEpochSec = emitEpochSec + slantDist / soundSpeedMps;
    const samplePos = (obsEpochSec - bufferStartEpochSec) * sampleRateHz;
    const idx0 = Math.floor(samplePos);
    const frac = samplePos - idx0;

    if (idx0 >= 0 && idx0 + 1 < samples.length) {
      const s0 = samples[idx0] ?? 0;
      const s1 = samples[idx0 + 1] ?? 0;
      resampled[i] = s0 + frac * (s1 - s0);
    }
  }

  const spectrumDb = computeHannPowerSpectrumDb(resampled, DECHIRP_FFT_SIZE);
  const binStepHz = sampleRateHz / DECHIRP_FFT_SIZE;
  const minSearchBin = Math.max(2, Math.floor((expectedBaseFreqHz - PEAK_SEARCH_HALF_WIDTH_HZ) / binStepHz));
  const maxSearchBin = Math.min((DECHIRP_FFT_SIZE >> 1) - 2, Math.ceil((expectedBaseFreqHz + PEAK_SEARCH_HALF_WIDTH_HZ) / binStepHz));

  let peakBin = minSearchBin;
  let peakDb = -Infinity;
  const backgroundBins: number[] = [];

  for (let b = minSearchBin; b <= maxSearchBin; b += 1) {
    const val = spectrumDb[b] ?? -Infinity;
    if (val > peakDb) {
      peakDb = val;
      peakBin = b;
    }
  }

  for (let b = minSearchBin; b <= maxSearchBin; b += 1) {
    if (Math.abs(b - peakBin) > PEAK_EXCLUSION_BINS) {
      const val = spectrumDb[b];
      if (val !== undefined) {
        backgroundBins.push(val);
      }
    }
  }

  backgroundBins.sort((a, b) => a - b);
  const noiseFloorDb = backgroundBins.length > 0 ? (backgroundBins[backgroundBins.length >> 1] ?? NO_BACKGROUND_NOISE_FLOOR_DB) : NO_BACKGROUND_NOISE_FLOOR_DB;

  return {
    coherentSnrDb: peakDb - noiseFloorDb,
    recoveredBaseFreqHz: peakBin * binStepHz,
    resampledSamples: resampled,
  };
}
