import { describe, expect, it } from 'vitest';
import {
  decodeSpatialCellCenter,
  encodeSpatialCell,
  geoToEcef,
  geoToLocalEnu,
  interpolateTerrainElevationMeters,
  localEnuToGeo,
  slantDistanceMeters,
} from './geo';

describe('WGS84 Geodesy and Spatial Cell Indexing', () => {
  it('converts geodetic points to ECEF coordinates', () => {
    // Equator / Prime Meridian: x = a, y = 0, z = 0
    const equator = geoToEcef({ lat: 0, lon: 0, altMeters: 0 });
    expect(equator.x).toBeCloseTo(6378137.0, 0);
    expect(equator.y).toBeCloseTo(0.0, 1);
    expect(equator.z).toBeCloseTo(0.0, 1);

    // North pole: x = 0, y = 0, z = b (~6356752.3m)
    const northPole = geoToEcef({ lat: 90, lon: 0, altMeters: 0 });
    expect(northPole.x).toBeCloseTo(0.0, 1);
    expect(northPole.y).toBeCloseTo(0.0, 1);
    expect(northPole.z).toBeCloseTo(6356752.3, 0);

    // 90 degrees East on equator
    const eastEquator = geoToEcef({ lat: 0, lon: 90, altMeters: 100 });
    expect(eastEquator.x).toBeCloseTo(0.0, 1);
    expect(eastEquator.y).toBeCloseTo(6378237.0, 0);
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
    const ground = { lat: 51.752, lon: -1.257, altMeters: 60 };
    const aircraft = { lat: 51.752, lon: -1.257, altMeters: 1560 };

    expect(slantDistanceMeters(ground, ground)).toBeCloseTo(0, 3);
    expect(slantDistanceMeters(ground, aircraft)).toBeCloseTo(1500, 0);
  });

  it('encodes and decodes hierarchical spatial cell identifiers', () => {
    const lat = 51.752;
    const lon = -1.257;

    const cellRes6 = encodeSpatialCell(lat, lon, 6);
    expect(cellRes6).toMatch(/^h3r6_\d+_\d+$/);

    const center6 = decodeSpatialCellCenter(cellRes6);
    expect(Math.abs(center6.lat - lat)).toBeLessThanOrEqual(0.032);
    expect(Math.abs(center6.lon - lon)).toBeLessThanOrEqual(0.032);

    const cellRes4 = encodeSpatialCell(lat, lon, 4);
    expect(cellRes4).toMatch(/^h3r4_\d+_\d+$/);
    const center4 = decodeSpatialCellCenter(cellRes4);
    expect(Math.abs(center4.lat - lat)).toBeLessThanOrEqual(0.2);

    expect(() => decodeSpatialCellCenter('invalid_cell')).toThrow('Invalid spatial cell identifier');
  });

  it('interpolates terrain elevation from digital elevation models', () => {
    expect(interpolateTerrainElevationMeters(51.0, 0.0, [])).toBe(0);

    const dem = [
      { lat: 51.0, lon: 0.0, altMeters: 100 },
      { lat: 51.1, lon: 0.0, altMeters: 200 },
      { lat: 51.0, lon: 0.1, altMeters: 150 },
      { lat: 51.1, lon: 0.1, altMeters: 250 },
    ];

    // Exact hit
    expect(interpolateTerrainElevationMeters(51.0, 0.0, dem)).toBe(100);

    // Midpoint interpolation
    const midElev = interpolateTerrainElevationMeters(51.05, 0.05, dem);
    expect(midElev).toBeGreaterThan(100);
    expect(midElev).toBeLessThan(250);
    expect(midElev).toBeCloseTo(175, 0);
  });
});
