import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLED_DEM_GRID, BUNDLED_SEGMENTS } from '../bundled';
import { DopplerDataset } from '../schemas';
import {
  classifyAircraftCategory,
  loadDatasetFile,
  processRawAdsbTrace,
  readAdsbSegments,
  type RawAdsbTraceFile,
  saveDatasetBundle,
} from './stream-adsb';

describe('ADS-B Ingestion and Trace Processing (src/node/stream-adsb.ts)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doppler-adsb-test-'));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  describe('classifyAircraftCategory', () => {
    it('classifies empty or undefined type codes as unknown', () => {
      expect(classifyAircraftCategory()).toBe('unknown');
      expect(classifyAircraftCategory('')).toBe('unknown');
      expect(classifyAircraftCategory('   ')).toBe('unknown');
    });

    it('classifies helicopters', () => {
      expect(classifyAircraftCategory('R44')).toBe('helicopter');
      expect(classifyAircraftCategory('EC35')).toBe('helicopter');
      expect(classifyAircraftCategory('H145')).toBe('helicopter');
      expect(classifyAircraftCategory('b206')).toBe('helicopter');
    });

    it('classifies light piston aircraft', () => {
      expect(classifyAircraftCategory('C172')).toBe('piston');
      expect(classifyAircraftCategory('pa28')).toBe('piston');
      expect(classifyAircraftCategory('DA40')).toBe('piston');
      expect(classifyAircraftCategory('SR22')).toBe('piston');
    });

    it('classifies turboprop aircraft', () => {
      expect(classifyAircraftCategory('B350')).toBe('turboprop');
      expect(classifyAircraftCategory('PC12')).toBe('turboprop');
      expect(classifyAircraftCategory('DH8D')).toBe('turboprop');
      expect(classifyAircraftCategory('AT72')).toBe('turboprop');
    });

    it('classifies jet aircraft', () => {
      expect(classifyAircraftCategory('B738')).toBe('jet');
      expect(classifyAircraftCategory('A320')).toBe('jet');
      expect(classifyAircraftCategory('CRJ7')).toBe('jet');
      expect(classifyAircraftCategory('CL30')).toBe('jet');
    });

    it('classifies unrecognised codes as unknown', () => {
      expect(classifyAircraftCategory('XYZ999')).toBe('unknown');
    });
  });

  describe('processRawAdsbTrace', () => {
    it('discards commercial jet traces', () => {
      const jetTrace: RawAdsbTraceFile = {
        icao: 'a00001',
        t: 'B738',
        trace: [
          [0, 51.5, -0.1, 5000],
          [10, 51.51, -0.11, 5100],
        ],
      };
      const result = processRawAdsbTrace(jetTrace, '2026-09-08', 1788900000);
      expect(result).toEqual([]);
    });

    it('discards traces with fewer than 2 pings', () => {
      const singlePingTrace: RawAdsbTraceFile = {
        icao: '4009a1',
        t: 'C172',
        trace: [[0, 51.5, -0.1, 3000]],
      };
      const result = processRawAdsbTrace(singlePingTrace, '2026-09-08', 1788900000);
      expect(result).toEqual([]);
    });

    it('discards high-altitude pings above 20,000 ft', () => {
      const highAltTrace: RawAdsbTraceFile = {
        icao: '4009a1',
        t: 'C172',
        trace: [
          [0, 51.5, -0.1, 25000],
          [10, 51.51, -0.11, 25000],
        ],
      };
      const result = processRawAdsbTrace(highAltTrace, '2026-09-08', 1788900000);
      expect(result).toEqual([]);
    });

    it('compresses and simplifies valid low-altitude piston traces', () => {
      const validTrace: RawAdsbTraceFile = {
        icao: '4009a1',
        r: 'G-BOAC',
        t: 'C172',
        trace: [
          [0, 51.7, -1.3, 3000],
          [30, 51.72, -1.28, 3050],
          [60, 51.74, -1.26, 3100],
          [90, 51.76, -1.24, 3150],
        ],
      };
      const segments = processRawAdsbTrace(validTrace, '2026-09-08', 1788900000);
      expect(segments.length).toBeGreaterThanOrEqual(1);

      const firstSeg = segments[0]!;
      expect(firstSeg.icao24).toBe('4009a1');
      expect(firstSeg.flightId).toBe('G-BOAC');
      expect(firstSeg.category).toBe('piston');
      expect(firstSeg.dateIso).toBe('2026-09-08');
      expect(firstSeg.groundspeedMps).toBeGreaterThan(0);
    });
  });

  describe('processRawAdsbTrace on real trace shapes', () => {
    const base = 1788900000;
    /** Twelve pings 10 s apart flying north-east at about 70 m/s and 3,000 ft. */
    const leg = (startSec: number): RawAdsbTraceFile['trace'] =>
      Array.from({ length: 12 }, (_, index) => [startSec + index * 10, 51.7 + index * 0.0045, -1.3 + index * 0.0045, 3000, 130, 45]);

    it('does not bridge a landing: ground and missing altitudes end the run', () => {
      const trace: RawAdsbTraceFile = {
        icao: '4009a1',
        t: 'C172',
        trace: [...leg(0), [120, 51.75, -1.25, 'ground'], [130, 51.75, -1.25, null], ...leg(600)],
      };
      const segments = processRawAdsbTrace(trace, '2026-09-08', base);

      expect(segments.length).toBeGreaterThanOrEqual(2);
      expect(segments.every((segment) => Number.isFinite(segment.startGeo.altMeters) && Number.isFinite(segment.endGeo.altMeters))).toBe(true);
      // No segment spans the 480 s between the two legs.
      expect(segments.every((segment) => segment.endEpochSec - segment.startEpochSec < 200)).toBe(true);
    });

    it('splits at a gap in coverage instead of drawing a straight line across it', () => {
      const trace: RawAdsbTraceFile = { icao: '4009a1', t: 'C172', trace: [...leg(0), ...leg(400)] };
      const segments = processRawAdsbTrace(trace, '2026-09-08', base);

      expect(segments.every((segment) => segment.endEpochSec - segment.startEpochSec < 200)).toBe(true);
    });

    it('drops pings outside a region and does not bridge a flight that leaves and returns', () => {
      const trace: RawAdsbTraceFile = { icao: '4009a1', t: 'C172', trace: [...leg(0), ...leg(130)] };
      const everything = processRawAdsbTrace(trace, '2026-09-08', base);
      // The box covers only the second half of the first leg and nothing of the second.
      const bbox = { minLat: 51.7 + 6 * 0.0045, minLon: -2, maxLat: 51.7 + 11 * 0.0045 + 0.001, maxLon: -1 };
      const inside = processRawAdsbTrace(trace, '2026-09-08', base, { bbox });

      expect(inside.length).toBeGreaterThan(0);
      expect(inside.length).toBeLessThan(everything.length + 1);
      expect(inside.every((segment) => segment.startGeo.lat >= bbox.minLat && segment.endGeo.lat <= bbox.maxLat)).toBe(true);
    });

    it('compresses more at a looser tolerance', () => {
      const wobble: RawAdsbTraceFile['trace'] = Array.from({ length: 200 }, (_, index) => [index * 2, 51.7 + index * 0.0009, -1.3 + Math.sin(index / 3) * 0.0004, 3000, 130, 45]);
      const tight = processRawAdsbTrace({ icao: '4009a1', t: 'C172', trace: wobble }, '2026-09-08', base, { toleranceMeters: 2 });
      const loose = processRawAdsbTrace({ icao: '4009a1', t: 'C172', trace: wobble }, '2026-09-08', base, { toleranceMeters: 60 });

      expect(loose.length).toBeLessThan(tight.length);
    });

    it('gives every segment of one flight a distinct id', () => {
      const trace: RawAdsbTraceFile = { icao: '4009a1', t: 'C172', trace: [...leg(0), ...leg(400)] };
      const ids = processRawAdsbTrace(trace, '2026-09-08', base).map((segment) => segment.id);

      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('readAdsbSegments', () => {
    it('reads a raw trace with a timestamp, deriving its date, and a directory of files', () => {
      const dir = join(tempDir, 'traces');
      mkdirSync(dir);
      const points = Array.from({ length: 12 }, (_, index) => [index * 10, 51.7 + index * 0.0045, -1.3 + index * 0.0045, 3000]);
      writeFileSync(join(dir, 'a.json'), JSON.stringify({ icao: 'aa0001', t: 'C172', timestamp: 1788825600, trace: points }));
      writeFileSync(join(dir, 'b.json'), JSON.stringify([{ icao: 'bb0002', t: 'PA28', timestamp: 1788825600, trace: points }]));
      writeFileSync(join(dir, 'ignored.txt'), 'not json');

      const segments = readAdsbSegments(dir);

      expect(new Set(segments.map((segment) => segment.icao24))).toEqual(new Set(['aa0001', 'bb0002']));
      expect(segments[0]?.dateIso).toBe('2026-09-08');
    });

    it('asks for a date when a raw trace has no timestamp, and uses it when given', () => {
      const file = join(tempDir, 'untimed.json');
      const points = Array.from({ length: 12 }, (_, index) => [index * 10, 51.7 + index * 0.0045, -1.3 + index * 0.0045, 3000]);
      writeFileSync(file, JSON.stringify({ icao: 'cc0003', t: 'C172', trace: points }));

      expect(() => readAdsbSegments(file)).toThrow('has no timestamp');
      expect(readAdsbSegments(file, { dateIso: '2026-09-08' })[0]?.dateIso).toBe('2026-09-08');
    });

    it('passes ready-made segments through and names a file that matches no shape', () => {
      const ready = join(tempDir, 'ready.json');
      writeFileSync(ready, JSON.stringify({ segments: BUNDLED_SEGMENTS }));
      const bad = join(tempDir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ hello: 'world' }));

      expect(readAdsbSegments(ready)).toHaveLength(BUNDLED_SEGMENTS.length);
      expect(() => readAdsbSegments(bad)).toThrow('bad.json');
    });
  });

  describe('saveDatasetBundle and loadDatasetFile', () => {
    it('serializes and deserializes a DopplerDataset with index and elevation grid', () => {
      const filePath = join(tempDir, 'test-bundle.json');
      const saved = saveDatasetBundle(filePath, BUNDLED_SEGMENTS, BUNDLED_DEM_GRID);

      expect(saved.version).toBe('1.0.0');
      expect(saved.segments.length).toBe(BUNDLED_SEGMENTS.length);
      expect(saved.constellations.length).toBeGreaterThan(0);
      expect(saved.elevationGrid.length).toBe(BUNDLED_DEM_GRID.length);

      const loaded = loadDatasetFile(filePath);
      const validated = DopplerDataset.parse(loaded);

      expect(validated.version).toBe('1.0.0');
      expect(validated.segments.length).toBe(BUNDLED_SEGMENTS.length);
      expect(validated.constellations.length).toBe(saved.constellations.length);
      expect(validated.elevationGrid.length).toBe(BUNDLED_DEM_GRID.length);
    });
  });
});
