import type { AsymptoticKinematics } from '../schemas';
import { DEFAULT_SOUND_SPEED_MPS } from './atmosphere';

/** Default one-sigma frequency measurement uncertainty of an asymptote in Hz; a design default that callers with a known spectrogram resolution override. */
const DEFAULT_FREQ_MEASUREMENT_STD_HZ = 0.15;
/** Default one-sigma relative uncertainty of the measured inflection slope (dimensionless, 5 per cent). */
const DEFAULT_SLOPE_REL_STD = 0.05;
/** Floor on the inferred groundspeed in m/s used as the divisor of the relative speed uncertainty, so a near-zero speed cannot divide by zero. */
const MIN_INFERRED_SPEED_MPS = 1e-3;

/**
 * Input measurements from a spectrogram Doppler S-curve.
 */
export interface DopplerCurveMeasurement {
  readonly asymptoticHighHz: number;
  readonly asymptoticLowHz: number;
  readonly inflectionSlopeHzPerSec: number;
  readonly soundSpeedMps?: number;
  readonly freqMeasurementStdHz?: number;
  readonly slopeMeasurementRelStd?: number;
}

/**
 * Separates aircraft groundspeed `v`, unshifted engine fundamental `f0`, and 3D Closest Point of Approach (CPA) slant distance `d_slant` in O(1) closed-form algebra directly from a Doppler curve's asymptotes and inflection slope.
 *
 * Because `f+ / f- = (1 + v/c) / (1 - v/c)`, the unknown engine base pitch `f0` cancels out identically:
 * - `v = c * (f+ - f-) / (f+ + f-)`
 * - `f0 = 2 * f+ * f- / (f+ + f-)` (the harmonic mean)
 * - `d_slant = - (f0 * v^2) / (c * df/dt|_CPA)`
 * @param measurement - Measured approaching/receding frequencies and inflection slope.
 * @returns Closed-form kinematic parameters and propagated standard deviations.
 */
export function extractAsymptoticKinematics(measurement: Readonly<DopplerCurveMeasurement>): AsymptoticKinematics {
  const { asymptoticHighHz, asymptoticLowHz, inflectionSlopeHzPerSec } = measurement;
  const soundSpeedMps = measurement.soundSpeedMps ?? DEFAULT_SOUND_SPEED_MPS;
  const freqStd = measurement.freqMeasurementStdHz ?? DEFAULT_FREQ_MEASUREMENT_STD_HZ;
  const slopeRelStd = measurement.slopeMeasurementRelStd ?? DEFAULT_SLOPE_REL_STD;

  if (asymptoticHighHz <= asymptoticLowHz || asymptoticLowHz <= 0) {
    throw new Error(
      `Approaching frequency (${String(asymptoticHighHz)} Hz) must exceed positive receding frequency (${String(asymptoticLowHz)} Hz)`,
    );
  }
  if (inflectionSlopeHzPerSec >= 0) {
    throw new Error(`Doppler inflection slope at CPA must be negative, got ${String(inflectionSlopeHzPerSec)} Hz/s`);
  }

  const sumFreq = asymptoticHighHz + asymptoticLowHz;
  const diffFreq = asymptoticHighHz - asymptoticLowHz;
  const machRatio = diffFreq / sumFreq;
  const inferredSpeedMps = soundSpeedMps * machRatio;
  const baseFreqHz = (2 * asymptoticHighHz * asymptoticLowHz) / sumFreq;
  const inferredSlantMeters = -(baseFreqHz * inferredSpeedMps * inferredSpeedMps) / (soundSpeedMps * inflectionSlopeHzPerSec);

  // First-order error propagation for v = c * (f+ - f-) / (f+ + f-)
  const dvDfHigh = (2 * soundSpeedMps * asymptoticLowHz) / (sumFreq * sumFreq);
  const dvDfLow = -(2 * soundSpeedMps * asymptoticHighHz) / (sumFreq * sumFreq);
  const speedStdMps = Math.hypot(dvDfHigh * freqStd, dvDfLow * freqStd);

  // Relative uncertainty in d_slant combines relative speed uncertainty (weight 2) and slope uncertainty
  const relSpeedStd = speedStdMps / Math.max(MIN_INFERRED_SPEED_MPS, inferredSpeedMps);
  const relSlantStd = Math.hypot(2 * relSpeedStd, slopeRelStd);
  const slantStdMeters = inferredSlantMeters * relSlantStd;

  return {
    asymptoticHighHz,
    asymptoticLowHz,
    baseFreqHz,
    inflectionSlopeHzPerSec,
    inferredSpeedMps,
    inferredSlantMeters,
    speedStdMps,
    slantStdMeters,
  };
}
