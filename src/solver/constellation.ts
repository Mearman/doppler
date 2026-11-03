import { DEFAULT_SOUND_SPEED_MPS } from '../physics/atmosphere';
import { computeSegmentCpa } from '../physics/retarded-time';
import {
  decodeSpatialCellCenter,
  interpolateTerrainElevationMeters,
} from '../physics/geo';
import type {
  ConstellationEntry,
  GeoPoint3D,
  LinearFlightSegment,
  SearchConstraints,
} from '../schemas';

/** Width in m/s of a groundspeed bucket in a constellation key. A design choice: a wider bucket tolerates more speed measurement error and admits more false pair matches. */
const SPEED_BUCKET_MPS = 3;
/** Width in seconds of a closest-approach time-offset bucket in a constellation key. A design choice with the same trade-off as the speed bucket. */
const DELTA_BUCKET_SEC = 5;
/** Number of buckets each side of the measured one that a query expands to on each key axis, so a measurement near a bucket boundary still finds its pair. */
export const QUERY_BUCKET_SPAN = 2;
/** Largest closest-approach slant distance in metres at which a segment is paired within a cell: the acoustic range of an aircraft. */
const MAX_PAIR_SLANT_METERS = 10000;
/** Shortest closest-approach time offset in seconds between two flyovers that forms a pair. */
const MIN_PAIR_DELTA_SEC = 10;
/** Longest closest-approach time offset in seconds between two flyovers that forms a pair (40 minutes). */
const MAX_PAIR_DELTA_SEC = 2400;
/** Seconds in a UTC day. */
const SECONDS_PER_DAY = 86400;
/** Seconds in an hour. */
const SECONDS_PER_HOUR = 3600;
/** Hours in a UTC day, the default end of an hour window. */
const HOURS_PER_DAY = 24;
/** Westernmost longitude in degrees of the region classed as 60 Hz mains (the Americas). */
const AMERICAS_MIN_LON_DEG = -170;
/** Easternmost longitude in degrees of the region classed as 60 Hz mains (the Americas). */
const AMERICAS_MAX_LON_DEG = -30;

/**
 * Quantises two groundspeeds and a time offset into the integer buckets of a constellation key.
 * @param speedAMps - Groundspeed of first flyover in m/s.
 * @param speedBMps - Groundspeed of second flyover in m/s.
 * @param deltaSec - Time offset `t_CPA_B - t_CPA_A` in seconds.
 * @returns The speed A, speed B and time-offset bucket indices.
 */
function quantiseConstellation(
  speedAMps: number,
  speedBMps: number,
  deltaSec: number,
): readonly [number, number, number] {
  return [
    Math.round(speedAMps / SPEED_BUCKET_MPS),
    Math.round(speedBMps / SPEED_BUCKET_MPS),
    Math.round(deltaSec / DELTA_BUCKET_SEC),
  ];
}

/**
 * Computes a quantized Shazam-style constellation hash key from two aircraft groundspeeds and their delayed CPA time offset.
 * @param speedAMps - Groundspeed of first flyover in m/s.
 * @param speedBMps - Groundspeed of second flyover in m/s.
 * @param deltaSec - Time offset `t_CPA_B - t_CPA_A` in seconds.
 * @returns Quantized constellation hash key string.
 */
export function formatConstellationKey(speedAMps: number, speedBMps: number, deltaSec: number): string {
  const [qSpeedA, qSpeedB, qDelta] = quantiseConstellation(speedAMps, speedBMps, deltaSec);

  return `v${String(qSpeedA)}_v${String(qSpeedB)}_dt${String(qDelta)}`;
}

/**
 * Generates neighbouring constellation hash keys within measurement tolerance (`QUERY_BUCKET_SPAN` buckets either side on each of the speed and time axes) to prevent boundary quantization misses.
 * @param speedAMps - Inferred speed of first flyover in m/s.
 * @param speedBMps - Inferred speed of second flyover in m/s.
 * @param deltaSec - Measured CPA offset in seconds.
 * @returns Set of candidate constellation hash keys.
 */
export function expandConstellationQueryKeys(speedAMps: number, speedBMps: number, deltaSec: number): Set<string> {
  const [baseA, baseB, baseDt] = quantiseConstellation(speedAMps, speedBMps, deltaSec);
  const keys = new Set<string>();

  for (let da = -QUERY_BUCKET_SPAN; da <= QUERY_BUCKET_SPAN; da += 1) {
    for (let db = -QUERY_BUCKET_SPAN; db <= QUERY_BUCKET_SPAN; db += 1) {
      for (let ddt = -QUERY_BUCKET_SPAN; ddt <= QUERY_BUCKET_SPAN; ddt += 1) {
        keys.add(`v${String(baseA + da)}_v${String(baseB + db)}_dt${String(baseDt + ddt)}`);
      }
    }
  }

  return keys;
}

/**
 * Options for indexing constellation pairs.
 */
export interface BuildConstellationOptions {
  readonly demGrid?: readonly GeoPoint3D[];
  readonly soundSpeedMps?: number;
}

/**
 * Builds the Shazam-style Constellation Index from a collection of 4D linear flight segments.
 * Pairs any two non-jet segments passing within acoustic range (`MAX_PAIR_SLANT_METERS`) of the same cell, with closest-approach times between `MIN_PAIR_DELTA_SEC` and `MAX_PAIR_DELTA_SEC` apart, on the same date.
 * @param segments - Linear flight segments.
 * @param options - DEM elevation grid samples and speed of sound.
 * @returns Array of indexed constellation pair entries.
 */
export function buildConstellationIndex(
  segments: readonly LinearFlightSegment[],
  options: Readonly<BuildConstellationOptions> = {},
): ConstellationEntry[] {
  const { demGrid = [], soundSpeedMps = DEFAULT_SOUND_SPEED_MPS } = options;
  const nonJet = segments.filter((s) => s.category !== 'jet');
  const byCellAndDate = new Map<string, LinearFlightSegment[]>();

  for (const seg of nonJet) {
    const groupKey = `${seg.dateIso}|${seg.h3Cell}`;
    const existing = byCellAndDate.get(groupKey);
    if (existing !== undefined) {
      existing.push(seg);
    } else {
      byCellAndDate.set(groupKey, [seg]);
    }
  }

  const entries: ConstellationEntry[] = [];

  for (const [, group] of byCellAndDate) {
    if (group.length < 2) {
      continue;
    }
    const firstSeg = group[0];
    if (firstSeg === undefined) {
      continue;
    }
    const center = decodeSpatialCellCenter(firstSeg.h3Cell);
    const groundAlt = interpolateTerrainElevationMeters(center.lat, center.lon, demGrid);
    const cellObserver: GeoPoint3D = { lat: center.lat, lon: center.lon, altMeters: groundAlt };

    const cpas = group
      .map((seg) => ({
        seg,
        cpa: computeSegmentCpa(cellObserver, seg, soundSpeedMps),
      }))
      .filter((item) => item.cpa.cpaSlantMeters <= MAX_PAIR_SLANT_METERS)
      .sort((a, b) => a.cpa.cpaDelayedEpochSec - b.cpa.cpaDelayedEpochSec);

    for (let i = 0; i < cpas.length; i += 1) {
      for (let j = i + 1; j < cpas.length; j += 1) {
        const a = cpas[i];
        const b = cpas[j];
        if (a === undefined || b === undefined || a.seg.flightId === b.seg.flightId) {
          continue;
        }
        const deltaSec = b.cpa.cpaDelayedEpochSec - a.cpa.cpaDelayedEpochSec;
        if (deltaSec < MIN_PAIR_DELTA_SEC || deltaSec > MAX_PAIR_DELTA_SEC) {
          continue;
        }

        const hashKey = formatConstellationKey(a.seg.groundspeedMps, b.seg.groundspeedMps, deltaSec);
        entries.push({
          hashKey,
          dateIso: a.seg.dateIso,
          h3Cell: a.seg.h3Cell,
          centerLat: center.lat,
          centerLon: center.lon,
          segmentIdA: a.seg.id,
          segmentIdB: b.seg.id,
          speedAMps: a.seg.groundspeedMps,
          speedBMps: b.seg.groundspeedMps,
          cpaDelayedEpochSecA: a.cpa.cpaDelayedEpochSec,
          cpaDelayedEpochSecB: b.cpa.cpaDelayedEpochSec,
          deltaSec,
        });
      }
    }
  }

  return entries;
}

/**
 * Candidate observer target coordinates and epoch timestamp tested against search constraints.
 */
export interface CandidateConstraintTarget {
  readonly lat: number;
  readonly lon: number;
  readonly dateIso: string;
  readonly epochSec: number;
}

/**
 * Checks whether a geographic coordinate and UTC epoch timestamp satisfy all active multi-axis user and side-channel constraints (Space, Date, Time of Day, and 50/60 Hz ENF power grid).
 * @param target - Candidate coordinate, date, and epoch timestamp.
 * @param constraints - Active multi-axis search constraints (any undefined field is treated as unconstrained `*`).
 * @returns `true` if the candidate satisfies all specified constraints.
 */
export function matchesSearchConstraints(
  target: Readonly<CandidateConstraintTarget>,
  constraints: Readonly<SearchConstraints>,
): boolean {
  const { lat, lon, dateIso, epochSec } = target;
  if (constraints.minLat !== undefined && lat < constraints.minLat) {
    return false;
  }
  if (constraints.maxLat !== undefined && lat > constraints.maxLat) {
    return false;
  }
  if (constraints.minLon !== undefined && lon < constraints.minLon) {
    return false;
  }
  if (constraints.maxLon !== undefined && lon > constraints.maxLon) {
    return false;
  }
  if (constraints.dateFromIso !== undefined && dateIso < constraints.dateFromIso) {
    return false;
  }
  if (constraints.dateToIso !== undefined && dateIso > constraints.dateToIso) {
    return false;
  }
  if (constraints.utcHourStart !== undefined || constraints.utcHourEnd !== undefined) {
    const secondsInDay = ((epochSec % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
    const utcHour = secondsInDay / SECONDS_PER_HOUR;
    const startH = constraints.utcHourStart ?? 0;
    const endH = constraints.utcHourEnd ?? HOURS_PER_DAY;
    if (startH <= endH) {
      if (utcHour < startH || utcHour > endH) {
        return false;
      }
    } else if (utcHour < startH && utcHour > endH) {
      return false;
    }
  }
  if (constraints.enfNominalHz !== undefined) {
    // 60 Hz grid primarily covers the Americas (-170 <= lon <= -30) and NE Asia pockets; 50 Hz covers Europe/UK/Africa/Oceania/Asia
    const isAmericasLon = lon >= AMERICAS_MIN_LON_DEG && lon <= AMERICAS_MAX_LON_DEG;
    if (constraints.enfNominalHz === '60' && !isAmericasLon) {
      return false;
    }
    if (constraints.enfNominalHz === '50' && isAmericasLon) {
      return false;
    }
  }

  return true;
}
