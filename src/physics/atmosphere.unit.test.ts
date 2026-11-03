import { describe, expect, it } from 'vitest';
import { effectiveRaySoundSpeedMps, speedOfSoundAtTempMps } from './atmosphere';

/** Temperatures in degrees Celsius at which the speed of sound is checked: the ISA sea-level temperature, a warm summer day, freezing point and a winter day. */
const ISA_SEA_LEVEL_CELSIUS = 15;
const WARM_DAY_CELSIUS = 25;
const WINTER_DAY_CELSIUS = -20;
/** Speeds of sound in m/s at those temperatures (and at 0 degrees Celsius), from `sqrt(1.4 * 287.058 * T)` with `T` in kelvin. */
const SOUND_SPEED_ISA_MPS = 340.29;
const SOUND_SPEED_WARM_MPS = 346.13;
const SOUND_SPEED_FREEZING_MPS = 331.3;
const SOUND_SPEED_WINTER_MPS = 319;
/** Decimal places `toBeCloseTo` compares speeds to (a tolerance of 0.05 m/s). */
const SPEED_COMPARE_DIGITS = 1;
/** Aircraft altitude in metres above sea level of the ray test, 1500 m above the 50 m ground. */
const RAY_AIRCRAFT_ALTITUDE_METERS = 1550;
/** Thermal-only effective speed in m/s at that altitude: the midpoint temperature is 15.125 degrees Celsius. */
const RAY_THERMAL_SPEED_MPS = 340.36;
/** Wind speed in m/s along the line of sight in the ray test. */
const RAY_WIND_MPS = 10;

describe('Atmosphere Acoustic Propagation Models', () => {
  it('computes dry air speed of sound at standard temperature levels', () => {
    // Standard ISA sea-level temperature (15 C): ~340.3 m/s
    expect(speedOfSoundAtTempMps(ISA_SEA_LEVEL_CELSIUS)).toBeCloseTo(SOUND_SPEED_ISA_MPS, SPEED_COMPARE_DIGITS);

    // Warm summer day (25 C): ~346.1 m/s
    expect(speedOfSoundAtTempMps(WARM_DAY_CELSIUS)).toBeCloseTo(SOUND_SPEED_WARM_MPS, SPEED_COMPARE_DIGITS);

    // Freezing point (0 C): ~331.3 m/s
    expect(speedOfSoundAtTempMps(0)).toBeCloseTo(SOUND_SPEED_FREEZING_MPS, SPEED_COMPARE_DIGITS);

    // Sub-zero winter temperature (-20 C): ~319.0 m/s
    expect(speedOfSoundAtTempMps(WINTER_DAY_CELSIUS)).toBeCloseTo(SOUND_SPEED_WINTER_MPS, SPEED_COMPARE_DIGITS);
  });

  it('computes path-integrated ray propagation speed with tropospheric lapse and wind advection', () => {
    const atmosphere = {
      groundTempCelsius: 20.0,
      groundAltitudeMeters: 50.0,
      windEnuMps: { x: RAY_WIND_MPS, y: 0.0, z: 0.0 },
    };

    // Thermal-only path speed at 1,550m altitude (midpoint temp = 20 - 0.5 * 0.0065 * 1500 = 15.125 C)
    const thermalSpeed = effectiveRaySoundSpeedMps(
      { groundTempCelsius: atmosphere.groundTempCelsius, groundAltitudeMeters: atmosphere.groundAltitudeMeters },
      RAY_AIRCRAFT_ALTITUDE_METERS,
    );
    expect(thermalSpeed).toBeCloseTo(RAY_THERMAL_SPEED_MPS, SPEED_COMPARE_DIGITS);

    // With 10 m/s tailwind along line of sight (propagation along +x)
    const withTailwind = effectiveRaySoundSpeedMps(atmosphere, RAY_AIRCRAFT_ALTITUDE_METERS, { x: 1.0, y: 0.0, z: 0.0 });
    expect(withTailwind).toBeCloseTo(thermalSpeed + RAY_WIND_MPS, SPEED_COMPARE_DIGITS);

    // With 10 m/s headwind along line of sight (propagation along -x)
    const withHeadwind = effectiveRaySoundSpeedMps(atmosphere, RAY_AIRCRAFT_ALTITUDE_METERS, { x: -1.0, y: 0.0, z: 0.0 });
    expect(withHeadwind).toBeCloseTo(thermalSpeed - RAY_WIND_MPS, SPEED_COMPARE_DIGITS);
  });
});
