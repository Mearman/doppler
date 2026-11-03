import { describe, expect, it } from 'vitest';
import type { AdsbPing } from '../schemas';
import { geoToEcef } from './geo';
import { simplifyTrajectory4D } from './rdp';

/** Simplification tolerance in metres passed to every test: the library default. */
const TOLERANCE_METERS = 5;
/** Floating-point slack in metres allowed on top of the tolerance when the test recomputes a dropped ping's error. */
const ERROR_ROUNDING_MARGIN_METERS = 1e-6;
/** Epoch second at which every generated track starts. */
const TRACK_START_EPOCH_SEC = 1000;
/** Latitude in degrees at which every generated track starts. */
const TRACK_START_LAT_DEG = 51.5;
/** Latitude advance in degrees per ping of a track heading due north: about 66.7 m at 1 Hz. */
const LAT_STEP_DEG = 0.0006;
/** Longitude advance in degrees per ping of a track heading due east: 0.0009 degrees is about 62 m at 51.5 degrees North. */
const LON_STEP_DEG = 0.0009;
/** Duration in seconds of the uniform-speed track. */
const UNIFORM_TRACK_DURATION_SEC = 60;
/** Bounds in m/s around the uniform track's speed of `LAT_STEP_DEG` per second (about 66.7 m/s). */
const UNIFORM_SPEED_MIN_MPS = 60;
const UNIFORM_SPEED_MAX_MPS = 75;
/** Constants of the Numerical Recipes linear congruential generator (`state * multiplier + increment` modulo `2^32`) that makes the wandering tracks reproducible. */
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const LCG_MODULUS_BITS = 32;
const LCG_MODULUS = 2 ** LCG_MODULUS_BITS;
/** Offset that centres a unit-interval random value on zero. */
const UNIT_INTERVAL_CENTRE = 0.5;
/** Width in radians of the random heading change per ping. */
const HEADING_STEP_RAD = 0.35;
/** Width in metres of the random altitude change per ping. */
const ALTITUDE_STEP_METERS = 12;
/** Number of distinct time steps (1, 2 and 3 s) between pings of a wandering track. */
const TIME_STEP_CHOICES = 3;
/** Pings in the tolerance track, and the number of seeds it is generated from. */
const TOLERANCE_TRACK_PINGS = 3000;
const TOLERANCE_SEED_COUNT = 3;
/** Pings and seed of the chaining track. */
const CHAIN_TRACK_PINGS = 2000;
const CHAIN_TRACK_SEED = 7;
/** Pings and seed of the long track: as many pings as seconds in a day, enough to split unevenly and exhaust a recursive implementation's call stack. */
const DAY_TRACK_PINGS = 86400;
const DAY_TRACK_SEED = 11;

describe('simplifyTrajectory4D', () => {
  it('compresses colinear pings down to a single segment within tolerance', () => {
    const pings: AdsbPing[] = [];
    // A minute of pings moving uniformly at about 67 m/s
    for (let t = 0; t <= UNIFORM_TRACK_DURATION_SEC; t += 1) {
      pings.push({
        epochSec: TRACK_START_EPOCH_SEC + t,
        lat: TRACK_START_LAT_DEG + t * LAT_STEP_DEG,
        lon: -0.1,
        altMeters: 1000,
      });
    }

    const segments = simplifyTrajectory4D(
      pings,
      {
        flightId: 'TEST1',
        icao24: 'a001',
        typeCode: 'C172',
        category: 'piston',
        dateIso: '2026-09-08',
      },
      TOLERANCE_METERS,
    );

    expect(segments.length).toBe(1);
    const seg = segments[0];
    expect(seg?.groundspeedMps).toBeGreaterThan(UNIFORM_SPEED_MIN_MPS);
    expect(seg?.groundspeedMps).toBeLessThan(UNIFORM_SPEED_MAX_MPS);
  });

  const META = { flightId: 'T', icao24: 'a001', typeCode: 'C172', category: 'piston', dateIso: '2026-09-08' } as const;

  /** A deterministic pseudo-random track that turns, climbs and varies its speed, so splits fall unevenly. */
  function wanderingTrack(count: number, seed: number): AdsbPing[] {
    let state = seed;
    const next = (): number => {
      state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;

      return state / LCG_MODULUS;
    };
    let lat = TRACK_START_LAT_DEG;
    let lon = -1.2;
    let heading = 0;
    let altMeters = 800;
    let epochSec = TRACK_START_EPOCH_SEC;

    return Array.from({ length: count }, () => {
      heading += (next() - UNIT_INTERVAL_CENTRE) * HEADING_STEP_RAD;
      lat += Math.cos(heading) * LAT_STEP_DEG;
      lon += Math.sin(heading) * LON_STEP_DEG;
      altMeters += (next() - UNIT_INTERVAL_CENTRE) * ALTITUDE_STEP_METERS;
      epochSec += 1 + Math.floor(next() * TIME_STEP_CHOICES);

      return { epochSec, lat, lon, altMeters };
    });
  }

  it.each(Array.from(Array(TOLERANCE_SEED_COUNT).keys(), (index) => index + 1))('keeps every dropped ping within tolerance of its segment (seed %i)', (seed) => {
    const pings = wanderingTrack(TOLERANCE_TRACK_PINGS, seed);
    const segments = simplifyTrajectory4D(pings, META, TOLERANCE_METERS);

    for (const ping of pings) {
      const segment = segments.find((candidate) => ping.epochSec >= candidate.startEpochSec && ping.epochSec <= candidate.endEpochSec);
      expect(segment).toBeDefined();
      if (segment === undefined) {
        continue;
      }
      const fraction = (ping.epochSec - segment.startEpochSec) / (segment.endEpochSec - segment.startEpochSec);
      const a = geoToEcef(segment.startGeo);
      const b = geoToEcef(segment.endGeo);
      const p = geoToEcef(ping);
      const error = Math.hypot(p.x - (a.x + (b.x - a.x) * fraction), p.y - (a.y + (b.y - a.y) * fraction), p.z - (a.z + (b.z - a.z) * fraction));
      expect(error).toBeLessThanOrEqual(TOLERANCE_METERS + ERROR_ROUNDING_MARGIN_METERS);
    }
  });

  it('chains segments end to end and gives each a distinct id', () => {
    const segments = simplifyTrajectory4D(wanderingTrack(CHAIN_TRACK_PINGS, CHAIN_TRACK_SEED), META, TOLERANCE_METERS);

    segments.slice(1).forEach((segment, index) => {
      expect(segment.startEpochSec).toBe(segments[index]?.endEpochSec);
    });
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(segments.length);
  });

  it('simplifies a day-long trace without exhausting the call stack or the heap', () => {
    const segments = simplifyTrajectory4D(wanderingTrack(DAY_TRACK_PINGS, DAY_TRACK_SEED), META, TOLERANCE_METERS);

    expect(segments.length).toBeGreaterThan(1);
  });
});

