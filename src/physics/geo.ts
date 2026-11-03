import type { GeoPoint3D, Vector3D } from '../schemas';

/** WGS84 equatorial radius in meters. */
const WGS84_A = 6378137.0;
/** WGS84 first eccentricity squared. */
const WGS84_E2 = 6.69437999014e-3;
/** Degrees to radians conversion factor. */
const DEG_TO_RAD = Math.PI / 180;
/** Radians to degrees conversion factor. */
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Converts a geodetic coordinate (latitude, longitude, altitude) to Earth-Centered, Earth-Fixed (ECEF) Cartesian coordinates in meters.
 * @param point - Geodetic coordinate on or above WGS84.
 * @returns ECEF vector in meters.
 */
export function geoToEcef(point: Readonly<GeoPoint3D>): Vector3D {
  const latRad = point.lat * DEG_TO_RAD;
  const lonRad = point.lon * DEG_TO_RAD;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);

  const primeVerticalRadius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const x = (primeVerticalRadius + point.altMeters) * cosLat * cosLon;
  const y = (primeVerticalRadius + point.altMeters) * cosLat * sinLon;
  const z = (primeVerticalRadius * (1 - WGS84_E2) + point.altMeters) * sinLat;

  return { x, y, z };
}

/**
 * Converts a global displacement between two geodetic points into local East-North-Up (ENU) meters relative to the origin point.
 * @param origin - Reference observer coordinate.
 * @param target - Target aircraft or ground coordinate.
 * @returns Local tangent-plane ENU vector in meters (x = East, y = North, z = Up).
 */
export function geoToLocalEnu(origin: Readonly<GeoPoint3D>, target: Readonly<GeoPoint3D>): Vector3D {
  const originEcef = geoToEcef(origin);
  const targetEcef = geoToEcef(target);
  const dx = targetEcef.x - originEcef.x;
  const dy = targetEcef.y - originEcef.y;
  const dz = targetEcef.z - originEcef.z;

  const latRad = origin.lat * DEG_TO_RAD;
  const lonRad = origin.lon * DEG_TO_RAD;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);

  const east = -sinLon * dx + cosLon * dy;
  const north = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;

  return { x: east, y: north, z: up };
}

/**
 * Projects a local East-North-Up (ENU) offset in meters from a reference geodetic origin back to geodetic coordinates.
 * @param origin - Reference coordinate.
 * @param enuOffset - Offset in local meters (x = East, y = North, z = Up).
 * @returns Resulting geodetic coordinate.
 */
export function localEnuToGeo(origin: Readonly<GeoPoint3D>, enuOffset: Readonly<Vector3D>): GeoPoint3D {
  const latRad = origin.lat * DEG_TO_RAD;
  const metersPerDegLat = 111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad);
  const metersPerDegLon = Math.max(1e-3, 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad));

  const lat = Math.max(-90, Math.min(90, origin.lat + enuOffset.y / metersPerDegLat));
  const rawLon = origin.lon + enuOffset.x / metersPerDegLon;
  const lon = ((((rawLon + 180) % 360) + 360) % 360) - 180;
  const altMeters = origin.altMeters + enuOffset.z;

  return { lat, lon, altMeters };
}

/** Boundary vertices used to approximate an ellipse outline when the caller does not choose a count. */
export const DEFAULT_ELLIPSE_SEGMENTS = 72;

/** A horizontal ellipse on the ground: semi-axes in metres and the compass bearing of the major axis. */
export interface HorizontalEllipse {
  readonly ellipseSemiMajorMeters: number;
  readonly ellipseSemiMinorMeters: number;
  readonly ellipseBearingDeg: number;
}

/**
 * Samples the outline of a horizontal confidence ellipse as geodetic points. The axes are metric distances on the local tangent plane, so the outline keeps its true shape at any latitude, where a degree of longitude is shorter than a degree of latitude.
 * @param center - Ellipse centre; every returned point keeps its altitude.
 * @param ellipse - Semi-axes in metres and the compass bearing of the semi-major axis in degrees clockwise from north, as `fisherToConfidenceEllipse95` returns them.
 * @param segments - Number of boundary segments. The returned ring repeats its first point, so it holds `segments + 1` points.
 * @returns Closed ring of boundary points, starting due along the major axis.
 */
export function ellipseOutline(
  center: Readonly<GeoPoint3D>,
  ellipse: Readonly<HorizontalEllipse>,
  segments = DEFAULT_ELLIPSE_SEGMENTS,
): readonly GeoPoint3D[] {
  const bearingRad = ellipse.ellipseBearingDeg * DEG_TO_RAD;
  const majorEast = Math.sin(bearingRad);
  const majorNorth = Math.cos(bearingRad);
  const ring: GeoPoint3D[] = [];
  for (let step = 0; step <= segments; step += 1) {
    const theta = (step * 2 * Math.PI) / segments;
    const along = ellipse.ellipseSemiMajorMeters * Math.cos(theta);
    const across = ellipse.ellipseSemiMinorMeters * Math.sin(theta);
    // The minor axis points a quarter turn clockwise from the major axis: (north, -east) in (east, north) components.
    ring.push(
      localEnuToGeo(center, {
        x: along * majorEast + across * majorNorth,
        y: along * majorNorth - across * majorEast,
        z: 0,
      }),
    );
  }

  return ring;
}

/**
 * Computes the 3D Euclidean slant distance in meters between two geodetic coordinates.
 * @param a - First 3D point.
 * @param b - Second 3D point.
 * @returns Slant distance in meters.
 */
export function slantDistanceMeters(a: Readonly<GeoPoint3D>, b: Readonly<GeoPoint3D>): number {
  const ea = geoToEcef(a);
  const eb = geoToEcef(b);

  return Math.hypot(ea.x - eb.x, ea.y - eb.y, ea.z - eb.z);
}

/**
 * Encodes a latitude/longitude coordinate into a deterministic hierarchical spatial cell identifier at a given resolution step.
 * @param lat - Latitude in degrees.
 * @param lon - Longitude in degrees.
 * @param resolution - Grid resolution tier (4 = ~20km, 6 = ~3.5km, 8 = ~500m).
 * @returns Deterministic cell string identifier.
 */
export function encodeSpatialCell(lat: number, lon: number, resolution = 6): string {
  const stepDeg = resolution <= 4 ? 0.2 : resolution <= 6 ? 0.032 : 0.005;
  const latIdx = Math.floor((lat + 90) / stepDeg);
  const lonIdx = Math.floor((lon + 180) / stepDeg);

  return `h3r${String(resolution)}_${String(latIdx)}_${String(lonIdx)}`;
}

/**
 * Decodes a spatial cell identifier back to its center latitude and longitude in degrees.
 * @param cellId - Spatial cell identifier produced by `encodeSpatialCell`.
 * @returns Center latitude and longitude in degrees.
 */
export function decodeSpatialCellCenter(cellId: string): { readonly lat: number; readonly lon: number } {
  const match = /^h3r(\d+)_(-?\d+)_(-?\d+)$/.exec(cellId);
  if (match === null) {
    throw new Error(`Invalid spatial cell identifier: ${cellId}`);
  }
  const resolution = Number(match[1]);
  const latIdx = Number(match[2]);
  const lonIdx = Number(match[3]);
  const stepDeg = resolution <= 4 ? 0.2 : resolution <= 6 ? 0.032 : 0.005;

  return {
    lat: -90 + (latIdx + 0.5) * stepDeg,
    lon: -180 + (lonIdx + 0.5) * stepDeg,
  };
}

/**
 * Evaluates terrain elevation at a target coordinate via inverse-distance-weighted interpolation over a DEM grid.
 * @param lat - Target latitude in degrees.
 * @param lon - Target longitude in degrees.
 * @param demGrid - Sparse or regular grid of elevation samples.
 * @returns Interpolated terrain elevation in meters above sea level.
 */
export function interpolateTerrainElevationMeters(lat: number, lon: number, demGrid: readonly GeoPoint3D[]): number {
  if (demGrid.length === 0) {
    return 0;
  }
  let weightedSum = 0;
  let weightTotal = 0;
  for (const sample of demGrid) {
    const dLat = (lat - sample.lat) * RAD_TO_DEG;
    const dLon = (lon - sample.lon) * RAD_TO_DEG;
    const distSq = dLat * dLat + dLon * dLon;
    if (distSq < 1e-12) {
      return sample.altMeters;
    }
    const weight = 1 / distSq;
    weightedSum += sample.altMeters * weight;
    weightTotal += weight;
  }

  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}
