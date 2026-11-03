import { describe, expect, it } from 'vitest';
import {
  decodeSpatialCellCenter,
  ellipseOutline,
  encodeSpatialCell,
  geoToEcef,
  geoToLocalEnu,
  interpolateTerrainElevationMeters,
  localEnuToGeo,
  slantDistanceMeters,
  type HorizontalEllipse,
} from './geo';

/** WGS84 equatorial radius in metres. */
const WGS84_EQUATORIAL_RADIUS_METERS = 6378137;
/** WGS84 polar radius `b` in metres, to the decimetre that the published value gives. */
const WGS84_POLAR_RADIUS_METERS = 6356752.3;
/** Altitude in metres above the ellipsoid of the point on the equator at 90 degrees East. */
const EAST_EQUATOR_ALTITUDE_METERS = 100;
/** Decimal places `toBeCloseTo` compares to for values given to the metre (a tolerance of 0.5 m). */
const WHOLE_METER_DIGITS = 0;
/** Decimal places `toBeCloseTo` compares to for values given to a millimetre (a tolerance of 0.0005 m). */
const MILLIMETER_DIGITS = 3;
/** Altitude in metres of the ground point of the slant-distance test. */
const SLANT_TEST_GROUND_ALTITUDE_METERS = 60;
/** Vertical separation in metres between the ground and aircraft points of the slant-distance test. */
const SLANT_TEST_HEIGHT_METERS = 1500;
/** Resolution tiers under test: the medium tier (the default) and the coarse tier. */
const MEDIUM_RESOLUTION = 6;
const COARSE_RESOLUTION = 4;
/** Cell sides in degrees of the medium and coarse tiers, which bound the distance from a point to its cell centre. */
const MEDIUM_CELL_STEP_DEG = 0.032;
const COARSE_CELL_STEP_DEG = 0.2;
/** Latitude, longitude and elevations of the terrain-interpolation grid, whose four corners lie 0.1 degrees apart. */
const DEM_ORIGIN_LAT_DEG = 51;
const DEM_ORIGIN_LON_DEG = 0;
const DEM_SOUTH_WEST_ELEVATION_METERS = 100;
const DEM_NORTH_EAST_ELEVATION_METERS = 250;
/** Query at the centre of the four DEM corners, 0.05 degrees from each edge. */
const DEM_CENTRE_LAT_DEG = 51.05;
const DEM_CENTRE_LON_DEG = 0.05;
/** Mean elevation of the four DEM corners (100, 200, 150 and 250 m), which equal inverse-distance weights give at the centre. */
const DEM_CENTRE_ELEVATION_METERS = 175;
/** Mid-latitude, high-latitude and equatorial test latitudes in degrees. */
const MID_LATITUDE_DEG = 51.752;
const HIGH_LATITUDE_DEG = 70;
/** Compass bearing in degrees clockwise from north that points due east. */
const EAST_BEARING_DEG = 90;
/** Ring-closure test: semi-axes in metres, bearing in degrees, segment count, expected point count and altitude. */
const RING_SEMI_MAJOR_METERS = 100;
const RING_SEMI_MINOR_METERS = 50;
const RING_BEARING_DEG = 33;
const RING_SEGMENTS = 12;
const RING_POINTS = RING_SEGMENTS + 1;
const RING_ALTITUDE_METERS = 123;

describe('WGS84 Geodesy and Spatial Cell Indexing', () => {
  it('converts geodetic points to ECEF coordinates', () => {
    // Equator / Prime Meridian: x = a, y = 0, z = 0
    const equator = geoToEcef({ lat: 0, lon: 0, altMeters: 0 });
    expect(equator.x).toBeCloseTo(WGS84_EQUATORIAL_RADIUS_METERS, WHOLE_METER_DIGITS);
    expect(equator.y).toBeCloseTo(0.0, 1);
    expect(equator.z).toBeCloseTo(0.0, 1);

    // North pole: x = 0, y = 0, z = b (~6356752.3m)
    const northPole = geoToEcef({ lat: 90, lon: 0, altMeters: 0 });
    expect(northPole.x).toBeCloseTo(0.0, 1);
    expect(northPole.y).toBeCloseTo(0.0, 1);
    expect(northPole.z).toBeCloseTo(WGS84_POLAR_RADIUS_METERS, WHOLE_METER_DIGITS);

    // 90 degrees East on equator
    const eastEquator = geoToEcef({ lat: 0, lon: 90, altMeters: EAST_EQUATOR_ALTITUDE_METERS });
    expect(eastEquator.x).toBeCloseTo(0.0, 1);
    expect(eastEquator.y).toBeCloseTo(WGS84_EQUATORIAL_RADIUS_METERS + EAST_EQUATOR_ALTITUDE_METERS, WHOLE_METER_DIGITS);
    expect(eastEquator.z).toBeCloseTo(0.0, 1);
  });

  it('transforms between geodetic coordinates and local East-North-Up (ENU) coordinates', () => {
    const origin = { lat: 51.752, lon: -1.257, altMeters: 60 };
    const enuOffset = { x: 450.0, y: -320.0, z: 150.0 };

    const targetGeo = localEnuToGeo(origin, enuOffset);
    const roundtripEnu = geoToLocalEnu(origin, targetGeo);

    expect(roundtripEnu.x).toBeCloseTo(enuOffset.x, 0);
    expect(roundtripEnu.y).toBeCloseTo(enuOffset.y, 0);
    expect(roundtripEnu.z).toBeCloseTo(enuOffset.z, 0);
  });

  it('computes 3D Euclidean slant distance between geodetic coordinates', () => {
    const ground = { lat: 51.752, lon: -1.257, altMeters: SLANT_TEST_GROUND_ALTITUDE_METERS };
    const aircraft = {
      lat: 51.752,
      lon: -1.257,
      altMeters: SLANT_TEST_GROUND_ALTITUDE_METERS + SLANT_TEST_HEIGHT_METERS,
    };

    expect(slantDistanceMeters(ground, ground)).toBeCloseTo(0, MILLIMETER_DIGITS);
    expect(slantDistanceMeters(ground, aircraft)).toBeCloseTo(SLANT_TEST_HEIGHT_METERS, WHOLE_METER_DIGITS);
  });

  it('encodes and decodes hierarchical spatial cell identifiers', () => {
    const lat = 51.752;
    const lon = -1.257;

    const cellRes6 = encodeSpatialCell(lat, lon, MEDIUM_RESOLUTION);
    expect(cellRes6).toMatch(/^h3r6_\d+_\d+$/);

    const center6 = decodeSpatialCellCenter(cellRes6);
    expect(Math.abs(center6.lat - lat)).toBeLessThanOrEqual(MEDIUM_CELL_STEP_DEG);
    expect(Math.abs(center6.lon - lon)).toBeLessThanOrEqual(MEDIUM_CELL_STEP_DEG);

    const cellRes4 = encodeSpatialCell(lat, lon, COARSE_RESOLUTION);
    expect(cellRes4).toMatch(/^h3r4_\d+_\d+$/);
    const center4 = decodeSpatialCellCenter(cellRes4);
    expect(Math.abs(center4.lat - lat)).toBeLessThanOrEqual(COARSE_CELL_STEP_DEG);

    expect(() => decodeSpatialCellCenter('invalid_cell')).toThrow('Invalid spatial cell identifier');
  });

  it('interpolates terrain elevation from digital elevation models', () => {
    expect(interpolateTerrainElevationMeters(DEM_ORIGIN_LAT_DEG, DEM_ORIGIN_LON_DEG, [])).toBe(0);

    const dem = [
      { lat: 51.0, lon: 0.0, altMeters: 100 },
      { lat: 51.1, lon: 0.0, altMeters: 200 },
      { lat: 51.0, lon: 0.1, altMeters: 150 },
      { lat: 51.1, lon: 0.1, altMeters: 250 },
    ];

    // Exact hit
    expect(interpolateTerrainElevationMeters(DEM_ORIGIN_LAT_DEG, DEM_ORIGIN_LON_DEG, dem)).toBe(DEM_SOUTH_WEST_ELEVATION_METERS);

    // Midpoint interpolation
    const midElev = interpolateTerrainElevationMeters(DEM_CENTRE_LAT_DEG, DEM_CENTRE_LON_DEG, dem);
    expect(midElev).toBeGreaterThan(DEM_SOUTH_WEST_ELEVATION_METERS);
    expect(midElev).toBeLessThan(DEM_NORTH_EAST_ELEVATION_METERS);
    expect(midElev).toBeCloseTo(DEM_CENTRE_ELEVATION_METERS, WHOLE_METER_DIGITS);
  });

  describe('ellipseOutline', () => {
    const SEMI_MAJOR = 800;
    const SEMI_MINOR = 300;
    // Relative tolerance covering the linearisation of degrees over a few kilometres.
    const RELATIVE_TOLERANCE = 0.01;
    const axes = (major: number, minor: number, bearing: number): HorizontalEllipse => ({
      ellipseSemiMajorMeters: major,
      ellipseSemiMinorMeters: minor,
      ellipseBearingDeg: bearing,
    });

    it.each([0, MID_LATITUDE_DEG, HIGH_LATITUDE_DEG])('keeps true metric axes at latitude %f', (lat) => {
      const center = { lat, lon: -1.25, altMeters: 64 };
      const ring = ellipseOutline(center, axes(SEMI_MAJOR, SEMI_MINOR, 0));
      const enu = ring.map((point) => geoToLocalEnu(center, point));

      expect(Math.abs(Math.max(...enu.map((v) => v.y)) - SEMI_MAJOR)).toBeLessThan(SEMI_MAJOR * RELATIVE_TOLERANCE);
      expect(Math.abs(Math.max(...enu.map((v) => v.x)) - SEMI_MINOR)).toBeLessThan(SEMI_MINOR * RELATIVE_TOLERANCE);
    });

    it('orients the major axis along the compass bearing, clockwise from north', () => {
      const center = { lat: 51.752, lon: -1.25, altMeters: 64 };
      const [first] = ellipseOutline(center, axes(SEMI_MAJOR, SEMI_MINOR, EAST_BEARING_DEG));
      if (first === undefined) {
        throw new Error('The outline has no points');
      }
      const enu = geoToLocalEnu(center, first);

      expect(enu.x).toBeGreaterThan(SEMI_MAJOR * (1 - RELATIVE_TOLERANCE));
      expect(Math.abs(enu.y)).toBeLessThan(SEMI_MAJOR * RELATIVE_TOLERANCE);
    });

    it('returns a closed ring of segments plus one points at the centre altitude', () => {
      const center = { lat: 10, lon: 20, altMeters: RING_ALTITUDE_METERS };
      const ring = ellipseOutline(center, axes(RING_SEMI_MAJOR_METERS, RING_SEMI_MINOR_METERS, RING_BEARING_DEG), RING_SEGMENTS);

      expect(ring).toHaveLength(RING_POINTS);
      expect(ring[0]).toEqual(ring[RING_SEGMENTS]);
      expect(ring.every((point) => point.altMeters === RING_ALTITUDE_METERS)).toBe(true);
    });
  });
});
