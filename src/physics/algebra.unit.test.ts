import { describe, expect, it } from 'vitest';
import { extractAsymptoticKinematics } from './algebra';

/** Ground-truth groundspeed in m/s of the worked example: Mach 0.2 at 343 m/s. */
const TRUE_SPEED_MPS = 68.6;
/** Ground-truth unshifted engine fundamental in Hz of the worked example. */
const TRUE_BASE_FREQ_HZ = 120;
/** Ground-truth slant distance in metres at closest approach of the worked example. */
const TRUE_SLANT_METERS = 1500;
/** Decimal places `toBeCloseTo` compares the speed and frequency to (a tolerance of 0.05). */
const FINE_COMPARE_DIGITS = 1;
/** Decimal places `toBeCloseTo` compares the slant distance to (a tolerance of 0.5 m), looser because the slope is given to five significant figures. */
const SLANT_COMPARE_DIGITS = 0;

describe('extractAsymptoticKinematics', () => {
  it('algebraically recovers exact speed, base frequency, and slant distance', () => {
    /* True values: f0 = 120 Hz, v = 68.6 m/s, c = 343 m/s (Mach 0.2)
       f+ = 120 / (1 - 0.2) = 150 Hz
       f- = 120 / (1 + 0.2) = 100 Hz
       d_slant = 1500 m
       df/dt|_CPA = - (120 * 68.6^2) / (343 * 1500) = -1.0978 Hz/s */
    const res = extractAsymptoticKinematics({
      asymptoticHighHz: 150.0,
      asymptoticLowHz: 100.0,
      inflectionSlopeHzPerSec: -1.0978,
      soundSpeedMps: 343.0,
    });

    expect(res.inferredSpeedMps).toBeCloseTo(TRUE_SPEED_MPS, FINE_COMPARE_DIGITS);
    expect(res.baseFreqHz).toBeCloseTo(TRUE_BASE_FREQ_HZ, FINE_COMPARE_DIGITS);
    expect(res.inferredSlantMeters).toBeCloseTo(TRUE_SLANT_METERS, SLANT_COMPARE_DIGITS);
  });

  it('rejects invalid non-decreasing or positive slopes', () => {
    expect(() =>
      extractAsymptoticKinematics({
        asymptoticHighHz: 100,
        asymptoticLowHz: 120,
        inflectionSlopeHzPerSec: -1.0,
      }),
    ).toThrow();

    expect(() =>
      extractAsymptoticKinematics({
        asymptoticHighHz: 150,
        asymptoticLowHz: 100,
        inflectionSlopeHzPerSec: 0.5,
      }),
    ).toThrow();
  });
});
