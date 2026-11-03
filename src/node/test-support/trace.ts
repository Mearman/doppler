/** Builders for raw ADS-B traces used by the ingestion tests. */
import type { RawAdsbTraceFile } from '../stream-adsb';

/** One trace sample of a raw `adsb.lol` trace. */
export type TracePing = RawAdsbTraceFile['trace'][number];

/** A latitude and longitude in degrees. */
export interface Origin {
  readonly lat: number;
  readonly lon: number;
}

/** The later fields of a sample, which the reader ignores. */
export interface PingMotion {
  /** Ground speed in knots. */
  readonly groundSpeedKt: number;
  /** Track in degrees clockwise from north. */
  readonly trackDeg: number;
}

/** What a sample records. */
export interface PingSpec extends Origin {
  /** Seconds since the trace's `timestamp`. */
  readonly offsetSec: number;
  /** Barometric altitude in feet, `ground` on the ground and null when unreported. */
  readonly altitudeFt: number | 'ground' | null;
  readonly motion?: Readonly<PingMotion>;
}

/**
 * Builds one trace sample in the order `adsb.lol` writes it.
 * @param spec - The sample's fields.
 * @returns The sample tuple, with the motion fields appended when given.
 */
export function ping(spec: Readonly<PingSpec>): TracePing {
  const motion = spec.motion === undefined ? [] : [spec.motion.groundSpeedKt, spec.motion.trackDeg];

  return [spec.offsetSec, spec.lat, spec.lon, spec.altitudeFt, ...motion];
}

/** Samples in a flight leg. */
export const LEG_PINGS = 12;

/** Seconds between consecutive samples of a flight leg. */
export const LEG_INTERVAL_SEC = 10;

/** Degrees of latitude and of longitude that each sample of a leg advances, which is about 590 m of ground track at latitude 51.5 degrees. */
export const LEG_STEP_DEGREES = 0.0045;

/** Barometric altitude of every sample of a leg, in feet: well below the 20,000 ft audibility ceiling. */
export const LEG_ALTITUDE_FT = 3000;

/** Motion fields of every sample of a leg: a light aircraft heading north-east. */
const LEG_MOTION: PingMotion = { groundSpeedKt: 130, trackDeg: 45 };

/**
 * Builds a light-aircraft leg flying north-east at 3,000 ft: `LEG_PINGS` samples `LEG_INTERVAL_SEC` seconds apart.
 * @param startSec - Offset of the first sample, in seconds.
 * @param origin - Position of the first sample.
 * @param withMotion - Whether samples carry the ground speed and track fields.
 * @returns The samples.
 */
export function flightLeg(startSec: number, origin: Readonly<Origin>, withMotion = true): TracePing[] {
  return Array.from({ length: LEG_PINGS }, (_, index) =>
    ping({
      offsetSec: startSec + index * LEG_INTERVAL_SEC,
      lat: origin.lat + index * LEG_STEP_DEGREES,
      lon: origin.lon + index * LEG_STEP_DEGREES,
      altitudeFt: LEG_ALTITUDE_FT,
      ...(withMotion ? { motion: LEG_MOTION } : {}),
    }),
  );
}
