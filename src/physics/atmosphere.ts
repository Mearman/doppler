import type { Vector3D } from '../schemas';

/** Adiabatic index of dry air. */
const GAMMA_DRY_AIR = 1.4;
/** Specific gas constant for dry air in J/(kg*K). */
const R_DRY_AIR = 287.058;
/** Standard tropospheric temperature lapse rate in K/m. */
const ISA_LAPSE_RATE_K_PER_M = 0.0065;
/** Absolute zero offset in Celsius. */
const KELVIN_OFFSET = 273.15;

/**
 * Atmospheric state for acoustic wave propagation.
 */
export interface AtmosphereState {
  readonly groundTempCelsius: number;
  readonly groundAltitudeMeters: number;
  readonly windEnuMps?: Readonly<Vector3D>;
}

/**
 * Computes the local phase speed of sound in meters per second at a given temperature in Celsius.
 * @param tempCelsius - Ambient air temperature in degrees Celsius.
 * @returns Speed of sound in m/s.
 */
export function speedOfSoundAtTempMps(tempCelsius: number): number {
  const tempKelvin = Math.max(180, tempCelsius + KELVIN_OFFSET);

  return Math.sqrt(GAMMA_DRY_AIR * R_DRY_AIR * tempKelvin);
}

/**
 * Computes the effective path-integrated speed of sound between an aircraft at altitude and a ground observer, accounting for the tropospheric temperature lapse rate and wind advection along the line of sight.
 * @param atmosphere - Ground temperature, elevation, and optional wind vector.
 * @param aircraftAltMeters - Aircraft altitude above sea level in meters.
 * @param unitPropagationDirEnu - Unit vector pointing from the aircraft to the observer in local ENU coordinates.
 * @returns Effective acoustic propagation speed in m/s along the ray path.
 */
export function effectiveRaySoundSpeedMps(
  atmosphere: Readonly<AtmosphereState>,
  aircraftAltMeters: number,
  unitPropagationDirEnu?: Readonly<Vector3D>,
): number {
  const deltaAlt = Math.max(0, aircraftAltMeters - atmosphere.groundAltitudeMeters);
  // Path-averaged temperature across a linear lapse-rate layer is the midpoint temperature.
  const midpointTempCelsius = atmosphere.groundTempCelsius - 0.5 * ISA_LAPSE_RATE_K_PER_M * deltaAlt;
  const thermalSpeed = speedOfSoundAtTempMps(midpointTempCelsius);

  if (atmosphere.windEnuMps === undefined || unitPropagationDirEnu === undefined) {
    return thermalSpeed;
  }

  const windProjection =
    atmosphere.windEnuMps.x * unitPropagationDirEnu.x +
    atmosphere.windEnuMps.y * unitPropagationDirEnu.y +
    atmosphere.windEnuMps.z * unitPropagationDirEnu.z;

  return Math.max(250, thermalSpeed + windProjection);
}
