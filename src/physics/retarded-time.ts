import type { GeoPoint3D, LinearFlightSegment } from '../schemas';
import { geoToLocalEnu } from './geo';

/**
 * Evaluated acoustic state of an aircraft at a specific observer reception timestamp.
 */
export interface RetardedAcousticPoint {
  readonly obsTimeSec: number;
  readonly emitTimeSec: number;
  readonly delaySec: number;
  readonly slantDistanceMeters: number;
  readonly radialVelocityMps: number;
  readonly observedFreqHz: number;
}

/**
 * Solves the exact subsonic Liénard-Wiechert retarded-time propagation delay `Δt = t_obs - t_emit` in closed form for a uniform linear trajectory segment.
 *
 * Given an aircraft position `r(t_emit) = r(t_obs) - v * Δt`, the acoustic propagation condition
 * `c^2 * Δt^2 = || r(t_obs) - x_obs - v * Δt ||^2` is a quadratic equation in `Δt`:
 * `(c^2 - v^2) * Δt^2 + 2 * (Δr · v) * Δt - ||Δr||^2 = 0`
 * @param deltaPosEnu - Displacement vector `r(t_obs) - x_obs` in local ENU meters at reception time `t_obs`.
 * @param velocityEnu - Aircraft velocity vector in local ENU meters per second.
 * @param soundSpeedMps - Local speed of sound in meters per second.
 * @returns Exact retarded propagation delay `Δt >= 0` in seconds.
 */
export function solveRetardedDelaySec(
  deltaPosEnu: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>,
  velocityEnu: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>,
  soundSpeedMps: number,
): number {
  const vSq = velocityEnu.x * velocityEnu.x + velocityEnu.y * velocityEnu.y + velocityEnu.z * velocityEnu.z;
  const cSq = soundSpeedMps * soundSpeedMps;
  const cSqMinusVSq = cSq - vSq;
  if (cSqMinusVSq <= 1e-3) {
    throw new Error(`Supersonic or sonic source speed (v^2=${String(vSq)}, c^2=${String(cSq)}) is outside subsonic domain`);
  }

  const rSq = deltaPosEnu.x * deltaPosEnu.x + deltaPosEnu.y * deltaPosEnu.y + deltaPosEnu.z * deltaPosEnu.z;
  const vDotR = velocityEnu.x * deltaPosEnu.x + velocityEnu.y * deltaPosEnu.y + velocityEnu.z * deltaPosEnu.z;

  const discriminant = cSqMinusVSq * rSq + vDotR * vDotR;

  return (-vDotR + Math.sqrt(Math.max(0, discriminant))) / cSqMinusVSq;
}

/**
 * Computes the analytical Closest Point of Approach (CPA) emission time, delayed reception time, and 3D slant distance for an observer relative to a linear flight segment.
 * @param observer - Candidate ground observer 3D coordinate.
 * @param segment - Linear flight segment.
 * @param soundSpeedMps - Effective speed of sound in m/s.
 * @returns Emission CPA timestamp, delayed observer CPA timestamp, and minimum 3D slant distance in meters.
 */
export function computeSegmentCpa(
  observer: Readonly<GeoPoint3D>,
  segment: Readonly<LinearFlightSegment>,
  soundSpeedMps = 343.0,
): {
  readonly cpaEmitEpochSec: number;
  readonly cpaDelayedEpochSec: number;
  readonly cpaSlantMeters: number;
} {
  const duration = Math.max(1e-3, segment.endEpochSec - segment.startEpochSec);
  const startEnu = geoToLocalEnu(observer, segment.startGeo);
  const endEnu = geoToLocalEnu(observer, segment.endGeo);

  const vx = (endEnu.x - startEnu.x) / duration;
  const vy = (endEnu.y - startEnu.y) / duration;
  const vz = (endEnu.z - startEnu.z) / duration;
  const vSq = vx * vx + vy * vy + vz * vz;

  const unclampedOffsetSec = vSq > 1e-6 ? -(startEnu.x * vx + startEnu.y * vy + startEnu.z * vz) / vSq : 0;
  const cpaOffsetSec = Math.max(0, Math.min(duration, unclampedOffsetSec));

  const cpaPosX = startEnu.x + vx * cpaOffsetSec;
  const cpaPosY = startEnu.y + vy * cpaOffsetSec;
  const cpaPosZ = startEnu.z + vz * cpaOffsetSec;

  const cpaSlantMeters = Math.hypot(cpaPosX, cpaPosY, cpaPosZ);
  const cpaEmitEpochSec = segment.startEpochSec + cpaOffsetSec;
  const cpaDelayedEpochSec = cpaEmitEpochSec + cpaSlantMeters / soundSpeedMps;

  return {
    cpaEmitEpochSec,
    cpaDelayedEpochSec,
    cpaSlantMeters,
  };
}

/**
 * Options for synthesizing retarded-time Doppler curves.
 */
export interface SynthesizeCurveOptions {
  readonly baseFreqHz: number;
  readonly obsEpochTimesSec: readonly number[];
  readonly soundSpeedMps?: number;
}

/**
 * Synthesizes the exact retarded-time Doppler curve observed on the ground for a linear flight segment at specified reception timestamps.
 * @param observer - Ground observer 3D coordinate.
 * @param segment - Linear flight segment.
 * @param options - Base frequency, observation timestamps, and optional sound speed.
 * @returns Evaluated retarded acoustic trajectory at each reception timestamp.
 */
export function synthesizeRetardedDopplerCurve(
  observer: Readonly<GeoPoint3D>,
  segment: Readonly<LinearFlightSegment>,
  options: Readonly<SynthesizeCurveOptions>,
): RetardedAcousticPoint[] {
  const { baseFreqHz, obsEpochTimesSec, soundSpeedMps = 343.0 } = options;
  const duration = Math.max(1e-3, segment.endEpochSec - segment.startEpochSec);
  const startEnu = geoToLocalEnu(observer, segment.startGeo);
  const endEnu = geoToLocalEnu(observer, segment.endGeo);

  const velocityEnu = {
    x: (endEnu.x - startEnu.x) / duration,
    y: (endEnu.y - startEnu.y) / duration,
    z: (endEnu.z - startEnu.z) / duration,
  };

  return obsEpochTimesSec.map((obsTimeSec) => {
    const dtFromStart = obsTimeSec - segment.startEpochSec;
    const posAtObsEnu = {
      x: startEnu.x + velocityEnu.x * dtFromStart,
      y: startEnu.y + velocityEnu.y * dtFromStart,
      z: startEnu.z + velocityEnu.z * dtFromStart,
    };

    const delaySec = solveRetardedDelaySec(posAtObsEnu, velocityEnu, soundSpeedMps);
    const emitTimeSec = obsTimeSec - delaySec;
    const emitDtFromStart = emitTimeSec - segment.startEpochSec;

    const emitPosEnu = {
      x: startEnu.x + velocityEnu.x * emitDtFromStart,
      y: startEnu.y + velocityEnu.y * emitDtFromStart,
      z: startEnu.z + velocityEnu.z * emitDtFromStart,
    };

    const slantDistanceMeters = Math.hypot(emitPosEnu.x, emitPosEnu.y, emitPosEnu.z);
    // Radial velocity approaching the observer is positive when ( -emitPosEnu · velocityEnu ) > 0
    const radialVelocityMps =
      slantDistanceMeters > 1e-3
        ? -(emitPosEnu.x * velocityEnu.x + emitPosEnu.y * velocityEnu.y + emitPosEnu.z * velocityEnu.z) / slantDistanceMeters
        : 0;

    const observedFreqHz = baseFreqHz * (soundSpeedMps / (soundSpeedMps - radialVelocityMps));

    return {
      obsTimeSec,
      emitTimeSec,
      delaySec,
      slantDistanceMeters,
      radialVelocityMps,
      observedFreqHz,
    };
  });
}
