import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLED_DEM_GRID, BUNDLED_SEGMENTS } from '../bundled';
import { DopplerDataset } from '../schemas';
import {
  classifyAircraftCategory,
  loadDatasetFile,
  processRawAdsbTrace,
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
