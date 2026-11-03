import { describe, expect, it } from 'vitest';
import { extractAsymptoticKinematics } from './algebra';

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

    expect(res.inferredSpeedMps).toBeCloseTo(68.6, 1);
    expect(res.baseFreqHz).toBeCloseTo(120.0, 1);
    expect(res.inferredSlantMeters).toBeCloseTo(1500.0, 0);
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
