import { describe, expect, it } from 'vitest';
import { effectiveRaySoundSpeedMps, speedOfSoundAtTempMps } from './atmosphere';

describe('Atmosphere Acoustic Propagation Models', () => {
  it('computes dry air speed of sound at standard temperature levels', () => {
    // Standard ISA sea-level temperature (15 C): ~340.3 m/s
    expect(speedOfSoundAtTempMps(15.0)).toBeCloseTo(340.29, 1);

    // Warm summer day (25 C): ~346.1 m/s
    expect(speedOfSoundAtTempMps(25.0)).toBeCloseTo(346.13, 1);

    // Freezing point (0 C): ~331.3 m/s
    expect(speedOfSoundAtTempMps(0.0)).toBeCloseTo(331.3, 1);

    // Sub-zero winter temperature (-20 C): ~319.0 m/s
    expect(speedOfSoundAtTempMps(-20.0)).toBeCloseTo(319.0, 1);
  });

  it('computes path-integrated ray propagation speed with tropospheric lapse and wind advection', () => {
    const atmosphere = {
      groundTempCelsius: 20.0,
      groundAltitudeMeters: 50.0,
      windEnuMps: { x: 10.0, y: 0.0, z: 0.0 },
    };

    // Thermal-only path speed at 1,550m altitude (midpoint temp = 20 - 0.5 * 0.0065 * 1500 = 15.125 C)
    const thermalSpeed = effectiveRaySoundSpeedMps(
      { groundTempCelsius: atmosphere.groundTempCelsius, groundAltitudeMeters: atmosphere.groundAltitudeMeters },
      1550,
    );
    expect(thermalSpeed).toBeCloseTo(340.36, 1);

    // With 10 m/s tailwind along line of sight (propagation along +x)
    const withTailwind = effectiveRaySoundSpeedMps(atmosphere, 1550, { x: 1.0, y: 0.0, z: 0.0 });
    expect(withTailwind).toBeCloseTo(thermalSpeed + 10.0, 1);

    // With 10 m/s headwind along line of sight (propagation along -x)
    const withHeadwind = effectiveRaySoundSpeedMps(atmosphere, 1550, { x: -1.0, y: 0.0, z: 0.0 });
    expect(withHeadwind).toBeCloseTo(thermalSpeed - 10.0, 1);
  });
});
