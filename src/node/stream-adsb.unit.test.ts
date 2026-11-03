import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_DEM_GRID, SYNTHETIC_SEGMENTS } from '../test-support/synthetic-reference';
import { DopplerDatasetSchema } from '../schemas';
import { flightLeg, LEG_ALTITUDE_FT, LEG_STEP_DEGREES, type Origin, ping } from './test-support/trace';
import { classifyAircraftCategory, processRawAdsbTrace, type RawAdsbTraceFile } from '../adsb-traces';
import { loadDatasetFile, readAdsbSegments, saveDatasetBundle } from './stream-adsb';

/** Epoch seconds of 2026-09-08T00:00:00Z, the date that traces carrying their own `timestamp` are given. */
const DAY_START_EPOCH_SEC = 1788825600;

/** Epoch seconds, on 2026-09-08, from which traces without a `timestamp` count their sample offsets. */
const TRACE_BASE_EPOCH_SEC = 1788900000;

/** The region of the segment-compression tests, north-west of Oxford. */
const LEG_ORIGIN: Origin = { lat: 51.7, lon: -1.3 };

/** A point in central London. */
const LONDON: Origin = { lat: 51.5, lon: -0.1 };

/** Altitude of a sample above the 20,000 ft audibility ceiling, in feet. */
const CRUISE_ALTITUDE_FT = 25000;

/** Barometric altitude of a commercial jet in the discarded-jet test, in feet. */
const JET_ALTITUDE_FT = 5000;

/** Offset of a second leg that follows the first after a gap longer than the reader bridges, in seconds. */
const LATER_LEG_START_SEC = 400;

/** Offset of a second leg that starts soon after the first ends, within the reader's bridging gap, in seconds. */
const ADJACENT_LEG_START_SEC = 130;

/** Offset of a leg flown after the aircraft landed and took off again, in seconds. */
const AFTER_LANDING_LEG_START_SEC = 600;

/** Offsets of the two samples recorded on the ground and with no altitude between the legs of the landing test, in seconds. */
const GROUND_PING_OFFSET_SEC = 120;
const NO_ALTITUDE_PING_OFFSET_SEC = 130;

/** Position of the landing in the landing test. */
const LANDING_POSITION: Origin = { lat: 51.75, lon: -1.25 };

/** Upper bound on the duration of any segment when a gap or landing must split the trace: below the shortest gap between legs, in seconds. */
const MAX_SPLIT_SEGMENT_SEC = 200;

/** Ping index at which the bounding box of the region test begins and ends, so that it covers the second half of the first leg. */
const BOX_FIRST_PING = 6;
const BOX_LAST_PING = 11;

/** Margin added after the last boxed sample, in degrees. */
const BOX_MARGIN_DEGREES = 0.001;

/** Samples, interval, step and wobble of the tolerance test's winding trace. */
const WOBBLE_PINGS = 200;
const WOBBLE_INTERVAL_SEC = 2;
const WOBBLE_LAT_STEP_DEGREES = 0.0009;
const WOBBLE_LON_AMPLITUDE_DEGREES = 0.0004;
const WOBBLE_PINGS_PER_RADIAN = 3;
const WOBBLE_GROUND_SPEED_KT = 130;
const WOBBLE_TRACK_DEG = 45;

/** Compression tolerances of the tolerance test, in metres. */
const TIGHT_TOLERANCE_M = 2;
const LOOSE_TOLERANCE_M = 60;

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
        trace: [ping({ offsetSec: 0, ...LONDON, altitudeFt: JET_ALTITUDE_FT }), ping({ offsetSec: 10, lat: 51.51, lon: -0.11, altitudeFt: 5100 })],
      };
      const result = processRawAdsbTrace(jetTrace, '2026-09-08', TRACE_BASE_EPOCH_SEC);
      expect(result).toEqual([]);
    });

    it('discards traces with fewer than 2 pings', () => {
      const singlePingTrace: RawAdsbTraceFile = {
        icao: '4009a1',
        t: 'C172',
        trace: [ping({ offsetSec: 0, ...LONDON, altitudeFt: LEG_ALTITUDE_FT })],
      };
      const result = processRawAdsbTrace(singlePingTrace, '2026-09-08', TRACE_BASE_EPOCH_SEC);
      expect(result).toEqual([]);
    });

    it('discards high-altitude pings above 20,000 ft', () => {
      const highAltTrace: RawAdsbTraceFile = {
        icao: '4009a1',
        t: 'C172',
        trace: [ping({ offsetSec: 0, ...LONDON, altitudeFt: CRUISE_ALTITUDE_FT }), ping({ offsetSec: 10, lat: 51.51, lon: -0.11, altitudeFt: CRUISE_ALTITUDE_FT })],
      };
      const result = processRawAdsbTrace(highAltTrace, '2026-09-08', TRACE_BASE_EPOCH_SEC);
      expect(result).toEqual([]);
    });

    it('compresses and simplifies valid low-altitude piston traces', () => {
      const validTrace: RawAdsbTraceFile = {
        icao: '4009a1',
        r: 'G-BOAC',
        t: 'C172',
        trace: [
          ping({ offsetSec: 0, ...LEG_ORIGIN, altitudeFt: LEG_ALTITUDE_FT }),
          ping({ offsetSec: 30, lat: 51.72, lon: -1.28, altitudeFt: 3050 }),
          ping({ offsetSec: 60, lat: 51.74, lon: -1.26, altitudeFt: 3100 }),
          ping({ offsetSec: 90, lat: 51.76, lon: -1.24, altitudeFt: 3150 }),
        ],
      };
      const segments = processRawAdsbTrace(validTrace, '2026-09-08', TRACE_BASE_EPOCH_SEC);
      expect(segments.length).toBeGreaterThanOrEqual(1);

      const firstSeg = segments[0];
      if (firstSeg === undefined) {
        throw new Error('the valid trace produced no segment');
      }
      expect(firstSeg.icao24).toBe('4009a1');
      expect(firstSeg.flightId).toBe('G-BOAC');
      expect(firstSeg.category).toBe('piston');
      expect(firstSeg.dateIso).toBe('2026-09-08');
      expect(firstSeg.groundspeedMps).toBeGreaterThan(0);
    });
  });

  describe('processRawAdsbTrace on real trace shapes', () => {
    const leg = (startSec: number): RawAdsbTraceFile['trace'] => flightLeg(startSec, LEG_ORIGIN);

    it('does not bridge a landing: ground and missing altitudes end the run', () => {
      const trace: RawAdsbTraceFile = {
        icao: '4009a1',
        t: 'C172',
        trace: [
          ...leg(0),
          ping({ offsetSec: GROUND_PING_OFFSET_SEC, ...LANDING_POSITION, altitudeFt: 'ground' }),
          ping({ offsetSec: NO_ALTITUDE_PING_OFFSET_SEC, ...LANDING_POSITION, altitudeFt: null }),
          ...leg(AFTER_LANDING_LEG_START_SEC),
        ],
      };
      const segments = processRawAdsbTrace(trace, '2026-09-08', TRACE_BASE_EPOCH_SEC);

      expect(segments.length).toBeGreaterThanOrEqual(2);
      expect(segments.every((segment) => Number.isFinite(segment.startGeo.altMeters) && Number.isFinite(segment.endGeo.altMeters))).toBe(true);
      // No segment spans the gap between the two legs.
      expect(segments.every((segment) => segment.endEpochSec - segment.startEpochSec < MAX_SPLIT_SEGMENT_SEC)).toBe(true);
    });

    it('splits at a gap in coverage instead of drawing a straight line across it', () => {
      const trace: RawAdsbTraceFile = { icao: '4009a1', t: 'C172', trace: [...leg(0), ...leg(LATER_LEG_START_SEC)] };
      const segments = processRawAdsbTrace(trace, '2026-09-08', TRACE_BASE_EPOCH_SEC);

      expect(segments.every((segment) => segment.endEpochSec - segment.startEpochSec < MAX_SPLIT_SEGMENT_SEC)).toBe(true);
    });

    it('drops pings outside a region and does not bridge a flight that leaves and returns', () => {
      const trace: RawAdsbTraceFile = { icao: '4009a1', t: 'C172', trace: [...leg(0), ...leg(ADJACENT_LEG_START_SEC)] };
      const everything = processRawAdsbTrace(trace, '2026-09-08', TRACE_BASE_EPOCH_SEC);
      // The box covers only the second half of the first leg and nothing of the second.
      const bbox = {
        minLat: LEG_ORIGIN.lat + BOX_FIRST_PING * LEG_STEP_DEGREES,
        minLon: -2,
        maxLat: LEG_ORIGIN.lat + BOX_LAST_PING * LEG_STEP_DEGREES + BOX_MARGIN_DEGREES,
        maxLon: -1,
      };
      const inside = processRawAdsbTrace(trace, '2026-09-08', TRACE_BASE_EPOCH_SEC, { bbox });

      expect(inside.length).toBeGreaterThan(0);
      expect(inside.length).toBeLessThan(everything.length + 1);
      expect(inside.every((segment) => segment.startGeo.lat >= bbox.minLat && segment.endGeo.lat <= bbox.maxLat)).toBe(true);
    });

    it('compresses more at a looser tolerance', () => {
      const wobble: RawAdsbTraceFile['trace'] = Array.from({ length: WOBBLE_PINGS }, (_, index) =>
        ping({
          offsetSec: index * WOBBLE_INTERVAL_SEC,
          lat: LEG_ORIGIN.lat + index * WOBBLE_LAT_STEP_DEGREES,
          lon: LEG_ORIGIN.lon + Math.sin(index / WOBBLE_PINGS_PER_RADIAN) * WOBBLE_LON_AMPLITUDE_DEGREES,
          altitudeFt: LEG_ALTITUDE_FT,
          motion: { groundSpeedKt: WOBBLE_GROUND_SPEED_KT, trackDeg: WOBBLE_TRACK_DEG },
        }),
      );
      const tight = processRawAdsbTrace({ icao: '4009a1', t: 'C172', trace: wobble }, '2026-09-08', TRACE_BASE_EPOCH_SEC, { toleranceMeters: TIGHT_TOLERANCE_M });
      const loose = processRawAdsbTrace({ icao: '4009a1', t: 'C172', trace: wobble }, '2026-09-08', TRACE_BASE_EPOCH_SEC, { toleranceMeters: LOOSE_TOLERANCE_M });

      expect(loose.length).toBeLessThan(tight.length);
    });

    it('drops fast segments of unclassified types, which are mostly airliners, and keeps classified ones', () => {
      const FAST_MPS_PER_DEG = 111000;
      // 0.0014 degrees of latitude every 10 s is about 15 m/s; 0.0128 is about 142 m/s.
      const fastLeg = (step: number): RawAdsbTraceFile['trace'] => Array.from({ length: 12 }, (_, index) => [index * 10, 51.7 + index * step, -1.3, 3000, 0, 0]);
      const speedMps = (0.0128 * FAST_MPS_PER_DEG) / 10;
      const unclassified = processRawAdsbTrace({ icao: 'ae0001', t: 'A20N', trace: fastLeg(0.0128) }, '2026-09-08', TRACE_BASE_EPOCH_SEC);
      const piston = processRawAdsbTrace({ icao: 'ae0002', t: 'C172', trace: fastLeg(0.0128) }, '2026-09-08', TRACE_BASE_EPOCH_SEC);
      const slowUnclassified = processRawAdsbTrace({ icao: 'ae0003', t: 'ZZZZ', trace: fastLeg(0.0014) }, '2026-09-08', TRACE_BASE_EPOCH_SEC);

      expect(speedMps).toBeGreaterThan(100);
      expect(unclassified).toEqual([]);
      expect(piston.length).toBeGreaterThan(0);
      expect(slowUnclassified.length).toBeGreaterThan(0);
    });

    it('gives every segment of one flight a distinct id', () => {
      const trace: RawAdsbTraceFile = { icao: '4009a1', t: 'C172', trace: [...leg(0), ...leg(LATER_LEG_START_SEC)] };
      const ids = processRawAdsbTrace(trace, '2026-09-08', TRACE_BASE_EPOCH_SEC).map((segment) => segment.id);

      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('readAdsbSegments', () => {
    it('reads a raw trace with a timestamp, deriving its date, and a directory of files', () => {
      const dir = join(tempDir, 'traces');
      mkdirSync(dir);
      const points = flightLeg(0, LEG_ORIGIN, false);
      writeFileSync(join(dir, 'a.json'), JSON.stringify({ icao: 'aa0001', t: 'C172', timestamp: DAY_START_EPOCH_SEC, trace: points }));
      writeFileSync(join(dir, 'b.json'), JSON.stringify([{ icao: 'bb0002', t: 'PA28', timestamp: DAY_START_EPOCH_SEC, trace: points }]));
      writeFileSync(join(dir, 'ignored.txt'), 'not json');

      const segments = readAdsbSegments(dir);

      expect(new Set(segments.map((segment) => segment.icao24))).toEqual(new Set(['aa0001', 'bb0002']));
      expect(segments[0]?.dateIso).toBe('2026-09-08');
    });

    it('asks for a date when a raw trace has no timestamp, and uses it when given', () => {
      const file = join(tempDir, 'untimed.json');
      const points = flightLeg(0, LEG_ORIGIN, false);
      writeFileSync(file, JSON.stringify({ icao: 'cc0003', t: 'C172', trace: points }));

      expect(() => readAdsbSegments(file)).toThrow('has no timestamp');
      expect(readAdsbSegments(file, { dateIso: '2026-09-08' })[0]?.dateIso).toBe('2026-09-08');
    });

    it('passes ready-made segments through and names a file that matches no shape', () => {
      const ready = join(tempDir, 'ready.json');
      writeFileSync(ready, JSON.stringify({ segments: SYNTHETIC_SEGMENTS }));
      const bad = join(tempDir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ hello: 'world' }));

      expect(readAdsbSegments(ready)).toHaveLength(SYNTHETIC_SEGMENTS.length);
      expect(() => readAdsbSegments(bad)).toThrow('bad.json');
    });
  });

  describe('saveDatasetBundle batching', () => {
    /** Segments written: more than two batches of 5000, so the batch boundary is crossed twice. */
    const BATCHED_SEGMENTS = 12001;
    /** Index of the first segment of the second batch and of the last segment written. */
    const SECOND_BATCH_FIRST = 5000;
    /** Milliseconds of budget per segment. The write, read and validation of one segment take a small fraction of a millisecond when the machine is idle; the budget is generous so coverage instrumentation and a machine running many other jobs do not fail the test, while still growing with the work. */
    const BUDGET_MS_PER_SEGMENT = 2;

    it('round-trips more segments than one write batch holds', () => {
      const template = SYNTHETIC_SEGMENTS[0]!;
      // Each segment sits in its own spatial cell so the constellation index, which pairs segments within a cell, stays linear in this test.
      const segments = Array.from({ length: BATCHED_SEGMENTS }, (_, index) => ({ ...template, id: `batch_${String(index)}`, flightId: `F${String(index)}`, h3Cell: `h3r6_${String(index)}_${String(index)}` }));
      const filePath = join(tempDir, 'batched.json');

      saveDatasetBundle(filePath, segments, []);
      const loaded = loadDatasetFile(filePath);

      expect(loaded.segments).toHaveLength(segments.length);
      expect(loaded.segments[SECOND_BATCH_FIRST]?.id).toBe(`batch_${String(SECOND_BATCH_FIRST)}`);
      expect(loaded.segments[BATCHED_SEGMENTS - 1]?.id).toBe(`batch_${String(BATCHED_SEGMENTS - 1)}`);
    }, BATCHED_SEGMENTS * BUDGET_MS_PER_SEGMENT);
  });

  describe('saveDatasetBundle and loadDatasetFile', () => {
    it('serializes and deserializes a DopplerDataset with index and elevation grid', () => {
      const filePath = join(tempDir, 'test-bundle.json');
      const saved = saveDatasetBundle(filePath, SYNTHETIC_SEGMENTS, SYNTHETIC_DEM_GRID);

      expect(saved.version).toBe('1.0.0');
      expect(saved.segments.length).toBe(SYNTHETIC_SEGMENTS.length);
      expect(saved.constellations.length).toBeGreaterThan(0);
      expect(saved.elevationGrid.length).toBe(SYNTHETIC_DEM_GRID.length);

      const loaded = loadDatasetFile(filePath);
      const validated = DopplerDatasetSchema.parse(loaded);

      expect(validated.version).toBe('1.0.0');
      expect(validated.segments.length).toBe(SYNTHETIC_SEGMENTS.length);
      expect(validated.constellations.length).toBe(saved.constellations.length);
      expect(validated.elevationGrid.length).toBe(SYNTHETIC_DEM_GRID.length);
    });
  });
});
