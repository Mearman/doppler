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
 * Computes the 3D spatial interpolation deviation in meters of a raw ping from the linear segment connecting `first` and `last` at the ping's timestamp.
 */
function interpolatedSpatialErrorMeters(
  ping: Readonly<AdsbPing>,
  first: Readonly<AdsbPing>,
  last: Readonly<AdsbPing>,
): number {
  const totalDt = last.epochSec - first.epochSec;
  const fraction = totalDt > 1e-6 ? Math.max(0, Math.min(1, (ping.epochSec - first.epochSec) / totalDt)) : 0;

  const firstEcef = geoToEcef(first);
  const lastEcef = geoToEcef(last);
  const pingEcef = geoToEcef(ping);

  const interpX = firstEcef.x + (lastEcef.x - firstEcef.x) * fraction;
  const interpY = firstEcef.y + (lastEcef.y - firstEcef.y) * fraction;
  const interpZ = firstEcef.z + (lastEcef.z - firstEcef.z) * fraction;

  return Math.hypot(pingEcef.x - interpX, pingEcef.y - interpY, pingEcef.z - interpZ);
}

/**
 * Recursively selects indices of key vertices using 4D Ramer-Douglas-Peucker simplification over `(X, Y, Z, t)`.
 */
function rdpIndices(pings: readonly AdsbPing[], startIdx: number, endIdx: number, toleranceMeters: number): number[] {
  if (endIdx <= startIdx + 1) {
    return [startIdx, endIdx];
  }
  const first = pings[startIdx];
  const last = pings[endIdx];
  if (first === undefined || last === undefined) {
    return [startIdx, endIdx];
  }

  let maxError = -1;
  let splitIdx = startIdx;

  for (let i = startIdx + 1; i < endIdx; i += 1) {
    const candidate = pings[i];
    if (candidate !== undefined) {
      const err = interpolatedSpatialErrorMeters(candidate, first, last);
      if (err > maxError) {
        maxError = err;
        splitIdx = i;
      }
    }
  }

  if (maxError > toleranceMeters && splitIdx > startIdx && splitIdx < endIdx) {
    const left = rdpIndices(pings, startIdx, splitIdx, toleranceMeters);
    const right = rdpIndices(pings, splitIdx, endIdx, toleranceMeters);

    return [...left.slice(0, -1), ...right];
  }

  return [startIdx, endIdx];
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
  const keyIndices = rdpIndices(sorted, 0, sorted.length - 1, toleranceMeters);
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
      id: `${meta.flightId}_seg${String(k)}`,
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
