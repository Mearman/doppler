import { synthesizeRetardedDopplerCurve } from '../physics/retarded-time';
import type { EnfSignature, GeoPoint3D, LinearFlightSegment } from '../schemas';
import {
  ENF_BACKGROUND_MAX_HZ,
  ENF_BACKGROUND_MIN_HZ,
  ENF_DOMINANCE_MARGIN_DB,
  ENF_MAX_FFT_SIZE,
  ENF_MIN_FFT_SIZE,
  ENF_MIN_SAMPLES,
  ENF_MIN_SNR_DB,
  ENF_NOTCH_HALF_WIDTH_HZ,
  GRID_50_NOMINAL_HZ,
  GRID_60_NOMINAL_HZ,
  MISSING_BIN_POWER_DB,
  NO_BACKGROUND_NOISE_FLOOR_DB,
  type NominalGridHz,
} from './constants';
import { computeHannPowerSpectrumDb } from './fft';

/**
 * Dolbear's Law temperature in degrees Celsius at the reference chirp rate.
 */
const DOLBEAR_BASE_TEMP_CELSIUS = 10;

/**
 * Dolbear's Law reference stridulation rate in chirps per minute, at which the temperature equals the base temperature.
 */
const DOLBEAR_REFERENCE_CHIRPS_PER_MINUTE = 40;

/**
 * Dolbear's Law rise in stridulation rate, in chirps per minute, for each degree Celsius.
 */
const DOLBEAR_CHIRPS_PER_MINUTE_PER_CELSIUS = 7;

/**
 * Seed of the deterministic pseudo-random generator behind the synthetic noise, fixed so that tests reproduce.
 */
const SYNTHETIC_NOISE_SEED = 133_742;

/**
 * Multiplier of the linear congruential generator (Numerical Recipes parameters, modulus 2^32).
 */
const LCG_MULTIPLIER = 1_664_525;

/**
 * Increment of the linear congruential generator (Numerical Recipes parameters, modulus 2^32).
 */
const LCG_INCREMENT = 1_013_904_223;

/**
 * Largest 32-bit unsigned integer, the divisor that maps a generator state to a uniform value in `[0, 1]`.
 */
const UINT32_MAX = 0xff_ff_ff_ff;

/**
 * Smallest uniform value passed to the logarithm of the Box-Muller transform, which is undefined at zero.
 */
const MIN_BOX_MULLER_UNIFORM = 1e-7;

/**
 * Default standard deviation of the synthetic background noise, in full-scale sample units.
 */
const DEFAULT_SYNTHETIC_NOISE_STD = 0.005;

/**
 * Spacing in seconds of the grid on which the retarded Doppler frequency is evaluated; samples between grid points are linearly interpolated.
 */
const DOPPLER_GRID_STEP_SEC = 0.1;

/**
 * Slant range in metres beyond which a flyover is not synthesised: it is too distant to be audible.
 */
const MAX_AUDIBLE_SLANT_METERS = 6500;

/**
 * Slant range in metres at which the synthesised flyover has unit attenuation, the numerator of the inverse-distance envelope.
 */
const REFERENCE_SLANT_METERS = 1200;

/**
 * Smallest slant range in metres used by the envelope, which bounds the gain of a very close pass.
 */
const MIN_ENVELOPE_SLANT_METERS = 300;

/**
 * Amplitude of the second harmonic relative to the fundamental of a synthesised engine tone.
 */
const SECOND_HARMONIC_GAIN = 0.35;

/**
 * Detects passive 50.00 Hz vs 60.00 Hz Electrical Network Frequency (ENF) mains hum in an audio buffer to split the global search space by power-grid hemisphere.
 * @param samples - Audio samples.
 * @param sampleRateHz - Sample rate in Hz.
 * @returns Detected ENF nominal grid (50 Hz, 60 Hz, or unknown), SNR, and geographic region hint.
 */
export function detectEnfSignature(samples: Readonly<Float32Array>, sampleRateHz: number): EnfSignature {
  let fftSize = ENF_MIN_FFT_SIZE;
  while (fftSize * 2 <= samples.length && fftSize < ENF_MAX_FFT_SIZE) {
    fftSize <<= 1;
  }
  if (samples.length < ENF_MIN_SAMPLES) {
    return {
      detected: false,
      nominalHz: 'unknown',
      measuredFreqHz: 0,
      snrDb: 0,
      regionHint: 'Insufficient audio length for ENF analysis',
    };
  }

  const spectrumDb = computeHannPowerSpectrumDb(samples, fftSize);
  const binStepHz = sampleRateHz / fftSize;

  const bin50 = Math.round(GRID_50_NOMINAL_HZ / binStepHz);
  const bin60 = Math.round(GRID_60_NOMINAL_HZ / binStepHz);

  const power50Db = Math.max(
    spectrumDb[bin50 - 1] ?? MISSING_BIN_POWER_DB,
    spectrumDb[bin50] ?? MISSING_BIN_POWER_DB,
    spectrumDb[bin50 + 1] ?? MISSING_BIN_POWER_DB,
  );
  const power60Db = Math.max(
    spectrumDb[bin60 - 1] ?? MISSING_BIN_POWER_DB,
    spectrumDb[bin60] ?? MISSING_BIN_POWER_DB,
    spectrumDb[bin60 + 1] ?? MISSING_BIN_POWER_DB,
  );

  // Measure surrounding background across the ENF background band, excluding a notch around each nominal grid frequency
  const bgValues: number[] = [];
  const startBin = Math.max(1, Math.floor(ENF_BACKGROUND_MIN_HZ / binStepHz));
  const endBin = Math.min((fftSize >> 1) - 1, Math.ceil(ENF_BACKGROUND_MAX_HZ / binStepHz));
  for (let b = startBin; b <= endBin; b += 1) {
    const hz = b * binStepHz;
    if (Math.abs(hz - GRID_50_NOMINAL_HZ) > ENF_NOTCH_HALF_WIDTH_HZ && Math.abs(hz - GRID_60_NOMINAL_HZ) > ENF_NOTCH_HALF_WIDTH_HZ) {
      const val = spectrumDb[b];
      if (val !== undefined) {
        bgValues.push(val);
      }
    }
  }
  bgValues.sort((a, b) => a - b);
  const noiseFloorDb = bgValues.length > 0 ? (bgValues[bgValues.length >> 1] ?? NO_BACKGROUND_NOISE_FLOOR_DB) : NO_BACKGROUND_NOISE_FLOOR_DB;

  const snr50 = power50Db - noiseFloorDb;
  const snr60 = power60Db - noiseFloorDb;

  if (snr50 >= ENF_MIN_SNR_DB && snr50 > snr60 + ENF_DOMINANCE_MARGIN_DB) {
    return {
      detected: true,
      nominalHz: '50',
      measuredFreqHz: GRID_50_NOMINAL_HZ,
      snrDb: snr50,
      regionHint: '50 Hz Grid (Europe, UK, Asia, Africa, Australia, E. Japan)',
    };
  }

  if (snr60 >= ENF_MIN_SNR_DB && snr60 > snr50 + ENF_DOMINANCE_MARGIN_DB) {
    return {
      detected: true,
      nominalHz: '60',
      measuredFreqHz: GRID_60_NOMINAL_HZ,
      snrDb: snr60,
      regionHint: '60 Hz Grid (North America, South Korea, Taiwan, W. Japan)',
    };
  }

  return {
    detected: false,
    nominalHz: 'unknown',
    measuredFreqHz: 0,
    snrDb: Math.max(0, snr50, snr60),
    regionHint: 'No dominant 50/60 Hz mains hum detected',
  };
}

/**
 * Estimates ambient air temperature in degrees Celsius from cricket stridulation rate using Dolbear's Law (`T_C = 10 + (N_60 - 40) / 7`).
 * @param chirpsPerMinute - Measured insect stridulation modulation pulses per minute.
 * @returns Estimated ambient temperature in degrees Celsius.
 */
export function estimateTempFromCricketChirpsCelsius(chirpsPerMinute: number): number {
  return (
    DOLBEAR_BASE_TEMP_CELSIUS +
    (chirpsPerMinute - DOLBEAR_REFERENCE_CHIRPS_PER_MINUTE) / DOLBEAR_CHIRPS_PER_MINUTE_PER_CELSIUS
  );
}

/**
 * Parameters for synthesizing a realistic acoustic recording containing aircraft Doppler flyovers, optional 50/60 Hz ENF hum, and optional transient noise pollution bursts.
 */
export interface SyntheticAudioConfig {
  readonly sampleRateHz: number;
  readonly startEpochSec: number;
  readonly durationSec: number;
  readonly observer: Readonly<GeoPoint3D>;
  readonly flyovers: readonly {
    readonly segment: Readonly<LinearFlightSegment>;
    readonly baseFreqHz: number;
    readonly amplitude: number;
  }[];
  readonly enfNominalHz?: NominalGridHz;
  readonly enfAmplitude?: number;
  readonly noiseStd?: number;
  readonly noisePollutionBursts?: readonly {
    readonly startOffsetSec: number;
    readonly endOffsetSec: number;
    readonly burstNoiseStd: number;
  }[];
}

/**
 * Synthesizes a realistic time-domain waveform (continuous phase integration of retarded Doppler frequencies + harmonics + ENF hum + deterministic pseudo-random noise) for testing, simulation, and verification.
 * @param config - Simulation configuration.
 * @returns Synthesized mono `Float32Array` audio buffer.
 */
export function synthesizeMultiFlyoverAudio(config: Readonly<SyntheticAudioConfig>): Float32Array {
  const numSamples = Math.floor(config.durationSec * config.sampleRateHz);
  const output = new Float32Array(numSamples);
  const dt = 1 / config.sampleRateHz;

  // Deterministic LCG PRNG for reproducible tests
  let seed = SYNTHETIC_NOISE_SEED;
  const nextGaussian = (): number => {
    seed = (seed * LCG_MULTIPLIER + LCG_INCREMENT) >>> 0;
    const u1 = Math.max(MIN_BOX_MULLER_UNIFORM, seed / UINT32_MAX);
    seed = (seed * LCG_MULTIPLIER + LCG_INCREMENT) >>> 0;
    const u2 = seed / UINT32_MAX;

    return Math.sqrt(-(2 * Math.log(u1))) * Math.cos(2 * Math.PI * u2);
  };

  // Add background noise, ENF mains hum, and optional noise-pollution bursts
  const baseNoiseStd = config.noiseStd ?? DEFAULT_SYNTHETIC_NOISE_STD;
  const enfAmp = config.enfAmplitude ?? 0;
  const enfHz = config.enfNominalHz;

  for (let i = 0; i < numSamples; i += 1) {
    const tOffset = i * dt;
    let currentNoiseStd = baseNoiseStd;
    if (config.noisePollutionBursts !== undefined) {
      for (const burst of config.noisePollutionBursts) {
        if (tOffset >= burst.startOffsetSec && tOffset <= burst.endOffsetSec) {
          currentNoiseStd = Math.max(currentNoiseStd, burst.burstNoiseStd);
        }
      }
    }
    let sample = nextGaussian() * currentNoiseStd;
    if (enfHz !== undefined && enfAmp > 0) {
      sample += enfAmp * Math.sin(2 * Math.PI * enfHz * tOffset);
    }
    output[i] = sample;
  }

  // Synthesize each aircraft flyover with continuous phase accumulation
  for (const flyover of config.flyovers) {
    let phase = 0;
    // Evaluate the retarded Doppler frequency on a coarse grid and linearly interpolate across samples
    const numGrid = Math.ceil(config.durationSec / DOPPLER_GRID_STEP_SEC) + 1;
    const gridTimes: number[] = [];
    for (let k = 0; k < numGrid; k += 1) {
      gridTimes.push(config.startEpochSec + k * DOPPLER_GRID_STEP_SEC);
    }
    const curve = synthesizeRetardedDopplerCurve(config.observer, flyover.segment, {
      baseFreqHz: flyover.baseFreqHz,
      obsEpochTimesSec: gridTimes,
    });

    for (let i = 0; i < numSamples; i += 1) {
      const tOffset = i * dt;
      const gridPos = tOffset / DOPPLER_GRID_STEP_SEC;
      const gIdx = Math.min(curve.length - 2, Math.max(0, Math.floor(gridPos)));
      const frac = gridPos - gIdx;
      const pt0 = curve[gIdx];
      const pt1 = curve[gIdx + 1];
      if (pt0 === undefined || pt1 === undefined) {
        continue;
      }

      const instFreqHz = pt0.observedFreqHz + frac * (pt1.observedFreqHz - pt0.observedFreqHz);
      const slantMeters = pt0.slantDistanceMeters + frac * (pt1.slantDistanceMeters - pt0.slantDistanceMeters);

      // Inverse-distance spherical spreading envelope, cut off beyond the audible range
      if (slantMeters < MAX_AUDIBLE_SLANT_METERS) {
        const attenuation = REFERENCE_SLANT_METERS / Math.max(MIN_ENVELOPE_SLANT_METERS, slantMeters);
        phase += 2 * Math.PI * instFreqHz * dt;
        const fundamental = Math.sin(phase);
        const harmonic2 = SECOND_HARMONIC_GAIN * Math.sin(2 * phase);
        output[i] = (output[i] ?? 0) + flyover.amplitude * attenuation * (fundamental + harmonic2);
      }
    }
  }

  return output;
}
