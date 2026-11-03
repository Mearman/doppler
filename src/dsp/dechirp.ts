import { geoToLocalEnu } from '../physics/geo';
import type { GeoPoint3D, LinearFlightSegment } from '../schemas';
import { computeHannPowerSpectrumDb } from './fft';

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
  const { sampleRateHz, bufferStartEpochSec, observer, segment, expectedBaseFreqHz, soundSpeedMps = 343.0 } = options;
  const fftSize = 4096;
  const resampled = new Float32Array(fftSize);
  const segDuration = Math.max(1e-3, segment.endEpochSec - segment.startEpochSec);
  const startEnu = geoToLocalEnu(observer, segment.startGeo);
  const endEnu = geoToLocalEnu(observer, segment.endGeo);

  const vx = (endEnu.x - startEnu.x) / segDuration;
  const vy = (endEnu.y - startEnu.y) / segDuration;
  const vz = (endEnu.z - startEnu.z) / segDuration;

  const bufferDurationSec = samples.length / sampleRateHz;
  const midObsEpochSec = bufferStartEpochSec + 0.5 * bufferDurationSec;
  const approxDelaySec = Math.hypot(startEnu.x, startEnu.y, startEnu.z) / soundSpeedMps;
  const centerEmitEpochSec = midObsEpochSec - approxDelaySec;
  const windowDurationSec = fftSize / sampleRateHz;
  const emitStartEpochSec = centerEmitEpochSec - 0.5 * windowDurationSec;

  for (let i = 0; i < fftSize; i += 1) {
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

  const spectrumDb = computeHannPowerSpectrumDb(resampled, fftSize);
  const binStepHz = sampleRateHz / fftSize;
  const minSearchBin = Math.max(2, Math.floor((expectedBaseFreqHz - 15) / binStepHz));
  const maxSearchBin = Math.min((fftSize >> 1) - 2, Math.ceil((expectedBaseFreqHz + 15) / binStepHz));

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
    if (Math.abs(b - peakBin) > 3) {
      const val = spectrumDb[b];
      if (val !== undefined) {
        backgroundBins.push(val);
      }
    }
  }

  backgroundBins.sort((a, b) => a - b);
  const noiseFloorDb = backgroundBins.length > 0 ? (backgroundBins[backgroundBins.length >> 1] ?? -100) : -100;

  return {
    coherentSnrDb: peakDb - noiseFloorDb,
    recoveredBaseFreqHz: peakBin * binStepHz,
    resampledSamples: resampled,
  };
}
