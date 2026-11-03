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

/**
 * Computes a quantized Shazam-style constellation hash key from two aircraft groundspeeds and their delayed CPA time offset.
 * @param speedAMps - Groundspeed of first flyover in m/s.
 * @param speedBMps - Groundspeed of second flyover in m/s.
 * @param deltaSec - Time offset `t_CPA_B - t_CPA_A` in seconds.
 * @returns Quantized constellation hash key string.
 */
export function formatConstellationKey(speedAMps: number, speedBMps: number, deltaSec: number): string {
  const qSpeedA = Math.round(speedAMps / 3);
  const qSpeedB = Math.round(speedBMps / 3);
  const qDelta = Math.round(deltaSec / 5);

  return `v${String(qSpeedA)}_v${String(qSpeedB)}_dt${String(qDelta)}`;
}

/**
 * Generates neighboring constellation hash keys within measurement tolerance `(±1 speed bucket, ±1 time bucket)` to prevent boundary quantization misses.
 * @param speedAMps - Inferred speed of first flyover in m/s.
 * @param speedBMps - Inferred speed of second flyover in m/s.
 * @param deltaSec - Measured CPA offset in seconds.
 * @returns Set of candidate constellation hash keys.
 */
export function expandConstellationQueryKeys(speedAMps: number, speedBMps: number, deltaSec: number): Set<string> {
  const baseA = Math.round(speedAMps / 3);
  const baseB = Math.round(speedBMps / 3);
  const baseDt = Math.round(deltaSec / 5);
  const keys = new Set<string>();

  for (let da = -2; da <= 2; da += 1) {
    for (let db = -2; db <= 2; db += 1) {
      for (let ddt = -2; ddt <= 2; ddt += 1) {
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
 * Pairs any two non-jet segments passing within acoustic range (&lt; 10 km) of the same H3 cell within 35 minutes on the same date.
 * @param segments - Linear flight segments.
 * @param options - DEM elevation grid samples and speed of sound.
 * @returns Array of indexed constellation pair entries.
 */
export function buildConstellationIndex(
  segments: readonly LinearFlightSegment[],
  options: Readonly<BuildConstellationOptions> = {},
): ConstellationEntry[] {
  const { demGrid = [], soundSpeedMps = 343.0 } = options;
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
      .filter((item) => item.cpa.cpaSlantMeters <= 10000)
      .sort((a, b) => a.cpa.cpaDelayedEpochSec - b.cpa.cpaDelayedEpochSec);

    for (let i = 0; i < cpas.length; i += 1) {
      for (let j = i + 1; j < cpas.length; j += 1) {
        const a = cpas[i];
        const b = cpas[j];
        if (a === undefined || b === undefined || a.seg.flightId === b.seg.flightId) {
          continue;
        }
        const deltaSec = b.cpa.cpaDelayedEpochSec - a.cpa.cpaDelayedEpochSec;
        if (deltaSec < 10 || deltaSec > 2400) {
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
    const secondsInDay = ((epochSec % 86400) + 86400) % 86400;
    const utcHour = secondsInDay / 3600;
    const startH = constraints.utcHourStart ?? 0;
    const endH = constraints.utcHourEnd ?? 24;
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
    const isAmericasLon = lon >= -170 && lon <= -30;
    if (constraints.enfNominalHz === '60' && !isAmericasLon) {
      return false;
    }
    if (constraints.enfNominalHz === '50' && isAmericasLon) {
      return false;
    }
  }

  return true;
}
