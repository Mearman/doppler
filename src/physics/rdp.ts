import type { AdsbPing, AircraftCategory, LinearFlightSegment } from '../schemas';
import { encodeSpatialCell, geoToEcef, slantDistanceMeters } from './geo';

/**
 * Metadata describing an aircraft trace being compressed into 4D linear segments.
 */
export interface TraceMetadata {
  readonly flightId: string;
  readonly icao24: string;
  readonly typeCode: string;
  readonly category: AircraftCategory;
  readonly dateIso: string;
}

/**
 * Selects the indices of key vertices using 4D Ramer-Douglas-Peucker simplification over `(X, Y, Z, t)`: the end points are kept, and a range is split at its worst-fitting ping while that ping lies further than `toleranceMeters` from the straight, constant-speed segment joining the range's ends.
 * The ranges are processed from an explicit stack rather than by recursion, because a trace of tens of thousands of pings can split unevenly enough to exhaust the call stack, and each ping's ECEF position is computed once.
 * @param pings - Chronologically ordered pings.
 * @param toleranceMeters - Largest allowed 3D deviation of a dropped ping.
 * @returns Ascending indices of the kept pings, always including the first and last.
 */
function rdpIndices(pings: readonly AdsbPing[], toleranceMeters: number): number[] {
  const count = pings.length;
  const ecef = pings.map((ping) => geoToEcef(ping));
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const ranges: [number, number][] = [[0, count - 1]];

  for (let range = ranges.pop(); range !== undefined; range = ranges.pop()) {
    const [startIdx, endIdx] = range;
    const first = pings[startIdx];
    const last = pings[endIdx];
    const firstEcef = ecef[startIdx];
    const lastEcef = ecef[endIdx];
    if (endIdx <= startIdx + 1 || first === undefined || last === undefined || firstEcef === undefined || lastEcef === undefined) {
      continue;
    }
    const totalDt = last.epochSec - first.epochSec;
    let maxError = -1;
    let splitIdx = startIdx;
    for (let i = startIdx + 1; i < endIdx; i += 1) {
      const ping = pings[i];
      const position = ecef[i];
      if (ping === undefined || position === undefined) {
        continue;
      }
      const fraction = totalDt > 1e-6 ? Math.max(0, Math.min(1, (ping.epochSec - first.epochSec) / totalDt)) : 0;
      const error = Math.hypot(
        position.x - (firstEcef.x + (lastEcef.x - firstEcef.x) * fraction),
        position.y - (firstEcef.y + (lastEcef.y - firstEcef.y) * fraction),
        position.z - (firstEcef.z + (lastEcef.z - firstEcef.z) * fraction),
      );
      if (error > maxError) {
        maxError = error;
        splitIdx = i;
      }
    }
    if (maxError > toleranceMeters && splitIdx > startIdx && splitIdx < endIdx) {
      keep[splitIdx] = 1;
      ranges.push([startIdx, splitIdx], [splitIdx, endIdx]);
    }
  }

  return Array.from(keep.entries(), ([index, kept]) => (kept === 1 ? index : -1)).filter((index) => index !== -1);
}

/**
 * Compresses a sequence of raw 1 Hz ADS-B pings into piecewise-linear 4D segments (`LinearFlightSegment`) with bounded spatiotemporal error.
 * @param pings - Chronologically ordered raw ADS-B pings.
 * @param meta - Flight and aircraft metadata.
 * @param toleranceMeters - Maximum allowed 3D interpolation error in meters (default 5 m).
 * @returns Array of compressed linear trajectory segments.
 */
export function simplifyTrajectory4D(
  pings: readonly AdsbPing[],
  meta: Readonly<TraceMetadata>,
  toleranceMeters = 5.0,
): LinearFlightSegment[] {
  if (pings.length < 2) {
    return [];
  }
  const sorted = [...pings].sort((a, b) => a.epochSec - b.epochSec);
  const keyIndices = rdpIndices(sorted, toleranceMeters);
  const segments: LinearFlightSegment[] = [];

  for (let k = 0; k < keyIndices.length - 1; k += 1) {
    const idxA = keyIndices[k];
    const idxB = keyIndices[k + 1];
    if (idxA === undefined || idxB === undefined) {
      continue;
    }
    const startPing = sorted[idxA];
    const endPing = sorted[idxB];
    if (startPing === undefined || endPing === undefined) {
      continue;
    }
    const dt = endPing.epochSec - startPing.epochSec;
    if (dt <= 0.1) {
      continue;
    }

    const dist3d = slantDistanceMeters(startPing, endPing);
    const groundspeedMps = dist3d / dt;
    const midLat = 0.5 * (startPing.lat + endPing.lat);
    const midLon = 0.5 * (startPing.lon + endPing.lon);

    segments.push({
      // The start time makes the id unique across a flight's runs and legs, which restart their index at zero.
      id: `${meta.flightId}_${String(Math.floor(startPing.epochSec))}`,
      flightId: meta.flightId,
      icao24: meta.icao24,
      typeCode: meta.typeCode,
      category: meta.category,
      dateIso: meta.dateIso,
      startEpochSec: startPing.epochSec,
      endEpochSec: endPing.epochSec,
      startGeo: { lat: startPing.lat, lon: startPing.lon, altMeters: startPing.altMeters },
      endGeo: { lat: endPing.lat, lon: endPing.lon, altMeters: endPing.altMeters },
      groundspeedMps,
      h3Cell: encodeSpatialCell(midLat, midLon, 6),
    });
  }

  return segments;
}
