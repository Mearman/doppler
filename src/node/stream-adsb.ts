import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { define } from '../define';
import { simplifyTrajectory4D } from '../physics/rdp';
import type { AdsbPing, AircraftCategory, GeoPoint3D } from '../schemas';
import { DopplerDataset, LinearFlightSegment } from '../schemas';
import { buildConstellationIndex } from '../solver/constellation';
import { SLANT_SIGMA_FLOOR_METERS } from '../solver/gauss-newton';

/**
 * One trace sample as `adsb.lol` and `tar1090` write it: seconds since the trace's `timestamp`, latitude, longitude and barometric altitude in feet, which is the string `ground` on the ground and null when unreported. Later fields (ground speed, track, flags) are ignored.
 */
const RawTracePoint = z.tuple([z.number(), z.number(), z.number(), z.union([z.number(), z.literal('ground'), z.null()])]).rest(z.unknown());

/**
 * Raw trace format from `adsb.lol` or `tar1090` JSON exports.
 */
export const RawAdsbTraceFile = define(
  z.object({
    icao: z.string().min(1),
    r: z.string().optional(),
    t: z.string().optional(),
    desc: z.string().optional(),
    /** Epoch seconds that each point's offset is counted from. */
    timestamp: z.number().optional(),
    trace: z.array(RawTracePoint),
  }),
);
export type RawAdsbTraceFile = z.infer<typeof RawAdsbTraceFile>;

/** A latitude and longitude rectangle. */
export interface BoundingBox {
  readonly minLat: number;
  readonly minLon: number;
  readonly maxLat: number;
  readonly maxLon: number;
}

/** Options for turning raw traces into segments. */
export interface AdsbTraceOptions {
  /** Pings outside the box end the current run and are dropped, so memory and work follow the region rather than the whole archive. A flight audible from inside the box but flying outside it is lost, so the box should include the acoustic range (about 10 km) as margin. */
  readonly bbox?: Readonly<BoundingBox>;
  /** Largest 3D deviation, in metres, of a dropped ping from its segment. Defaults to half the solver's slant-distance sigma floor, so compression error cannot dominate the solver's own uncertainty. */
  readonly toleranceMeters?: number;
}

/** Altitude above which a ping is cruise traffic that the microphone is not expected to hear: 20,000 ft. */
const MAX_AUDIBLE_ALTITUDE_METERS = 6096;

/** Metres in a foot. */
const METERS_PER_FOOT = 0.3048;

/**
 * Longest gap between pings that is still bridged by a straight line. Across a longer gap the aircraft can have turned, landed or left coverage, and at light-aircraft speeds (about 70 m/s) a two-minute gap is already about 8 km, comparable to the acoustic range, so the run is split instead.
 */
const MAX_PING_GAP_SEC = 120;

function inBox(lat: number, lon: number, box: Readonly<BoundingBox>): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

/**
 * Classifies an ICAO aircraft type code into a propulsion category.
 * @param typeCode - 4-character ICAO aircraft type designator (e.g. `C172`, `B738`, `DA42`, `EC35`).
 * @returns Propulsion category.
 */
export function classifyAircraftCategory(typeCode?: string): AircraftCategory {
  if (typeCode === undefined || typeCode === '') {
    return 'unknown';
  }
  const code = typeCode.toUpperCase().trim();

  // Known helicopters
  if (['R22', 'R44', 'R66', 'EC20', 'EC30', 'EC35', 'EC45', 'B06', 'B206', 'B407', 'AS50', 'A109', 'S76', 'H125', 'H135', 'H145', 'G2CA'].includes(code)) {
    return 'helicopter';
  }
  // Common piston / light propeller aircraft
  if (['C150', 'C152', 'C172', 'C182', 'C206', 'C210', 'PA28', 'PA32', 'PA34', 'PA44', 'SR20', 'SR22', 'DA20', 'DA40', 'DA42', 'P28A', 'AA5', 'BE36', 'BE58', 'M20T', 'RV7', 'RV8', 'RV10'].includes(code)) {
    return 'piston';
  }
  // Common turboprop aircraft
  if (['B350', 'BE20', 'PC12', 'TBM7', 'TBM8', 'TBM9', 'DH8D', 'AT72', 'AT76', 'AT45', 'C208', 'SW4', 'D228'].includes(code)) {
    return 'turboprop';
  }
  // Common commercial and business jet types
  if (['A319', 'A320', 'A321', 'A332', 'A333', 'A359', 'B737', 'B738', 'B739', 'B772', 'B77W', 'B788', 'B789', 'E190', 'E195', 'CRJ7', 'CRJ9', 'C56X', 'C680', 'GL5T', 'GLEX', 'FA7X', 'CL30'].includes(code)) {
    return 'jet';
  }

  return 'unknown';
}

/**
 * Converts a raw `adsb.lol` / `tar1090` trace object into compressed 4D piecewise-linear segments.
 * Jet categories are discarded. A ping on the ground, with no altitude, or above 20,000 ft ends the current run, and so does a gap of more than two minutes, so a segment never spans a landing, a climb to cruise or a loss of coverage.
 * @param trace - Raw ADS-B trace record.
 * @param dateIso - ISO calendar date (`YYYY-MM-DD`).
 * @param baseEpochSec - Epoch seconds that the trace's point offsets are counted from.
 * @param options - Region filter and compression tolerance.
 * @returns Array of linear flight segments.
 */
export function processRawAdsbTrace(
  trace: Readonly<RawAdsbTraceFile>,
  dateIso: string,
  baseEpochSec: number,
  options: Readonly<AdsbTraceOptions> = {},
): LinearFlightSegment[] {
  const typeCode = trace.t ?? 'unknown';
  const category = classifyAircraftCategory(typeCode);
  if (category === 'jet') {
    return [];
  }

  const runs: AdsbPing[][] = [];
  let run: AdsbPing[] = [];
  const endRun = (): void => {
    if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  };
  for (const [offsetSec, lat, lon, altFeet] of trace.trace) {
    const altMeters = typeof altFeet === 'number' ? altFeet * METERS_PER_FOOT : undefined;
    const { bbox } = options;
    if (altMeters === undefined || altMeters > MAX_AUDIBLE_ALTITUDE_METERS || (bbox !== undefined && !inBox(lat, lon, bbox))) {
      endRun();
      continue;
    }
    const epochSec = baseEpochSec + offsetSec;
    const previous = run[run.length - 1];
    if (previous !== undefined && epochSec - previous.epochSec > MAX_PING_GAP_SEC) {
      endRun();
    }
    run.push({ epochSec, lat, lon, altMeters });
  }
  endRun();

  return runs.flatMap((pings) =>
    simplifyTrajectory4D(pings, { flightId: trace.r ?? trace.icao, icao24: trace.icao, typeCode, category, dateIso }, options.toleranceMeters ?? SLANT_SIGMA_FLOOR_METERS / 2),
  );
}

/** Options for reading ADS-B input. */
export interface AdsbInputOptions extends AdsbTraceOptions {
  /** Calendar date (`YYYY-MM-DD`) for raw traces that carry no `timestamp`; their offsets count from midnight UTC of this date. */
  readonly dateIso?: string;
}

/**
 * Converts parsed ADS-B JSON into segments: ready-made segments (an array, or an object with `segments`), a raw trace, or an array of raw traces.
 * @param parsed - The parsed JSON value.
 * @param options - Date for raw traces without a `timestamp`.
 * @returns The segments it holds.
 * @throws When the value matches none of the accepted shapes, or a raw trace has neither a `timestamp` nor a date option.
 */
export function segmentsFromAdsbJson(parsed: unknown, options: Readonly<AdsbInputOptions>): LinearFlightSegment[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((element: unknown) => segmentsFromAdsbJson(element, options));
  }
  if (typeof parsed === 'object' && parsed !== null && 'segments' in parsed) {
    return z.array(LinearFlightSegment).parse(parsed.segments);
  }
  if (LinearFlightSegment.is(parsed)) {
    return [parsed];
  }
  const trace = RawAdsbTraceFile.parse(parsed);
  if (trace.timestamp !== undefined) {
    return processRawAdsbTrace(trace, new Date(trace.timestamp * 1000).toISOString().slice(0, 10), trace.timestamp, options);
  }
  if (options.dateIso === undefined) {
    throw new Error(`trace ${trace.icao} has no timestamp, so its date is unknown; pass the date`);
  }

  return processRawAdsbTrace(trace, options.dateIso, Date.parse(`${options.dateIso}T00:00:00Z`) / 1000, options);
}

/**
 * Reads flight segments from ADS-B JSON on disk: a file or every `.json` file of a directory (not recursive). Each file may hold ready-made segments (an array, or an object with `segments`), a raw `adsb.lol` / `tar1090` trace, or an array of raw traces.
 * @param inputPath - A JSON file or a directory of them.
 * @param options - Date for raw traces without a `timestamp`.
 * @returns Segments from every file, in file-name order.
 * @throws When a file is not valid JSON or matches none of the accepted shapes, naming the file.
 */
export function readAdsbSegments(inputPath: string, options: Readonly<AdsbInputOptions> = {}): LinearFlightSegment[] {
  const files = statSync(inputPath).isDirectory()
    ? readdirSync(inputPath).filter((name) => name.endsWith('.json')).sort().map((name) => join(inputPath, name))
    : [inputPath];

  return files.flatMap((file) => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));

      return segmentsFromAdsbJson(parsed, options);
    } catch (error: unknown) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });
}

/**
 * Loads and parses a DopplerDataset JSON file from disk.
 * @param filePath - Path to `.json` dataset file.
 * @returns Parsed `DopplerDataset`.
 */
export function loadDatasetFile(filePath: string): DopplerDataset {
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  return DopplerDataset.parse(parsed);
}

/**
 * Serializes and saves a DopplerDataset to disk with built constellation index.
 * @param filePath - Output path.
 * @param segments - Array of linear flight segments.
 * @param demGrid - Optional DEM elevation grid points.
 * @returns The saved `DopplerDataset`.
 */
export function saveDatasetBundle(
  filePath: string,
  segments: readonly LinearFlightSegment[],
  demGrid: readonly GeoPoint3D[] = [],
): DopplerDataset {
  const constellations = buildConstellationIndex(segments, { demGrid });
  const dataset: DopplerDataset = {
    version: '1.0.0',
    generatedAtIso: new Date().toISOString(),
    segments,
    constellations,
    elevationGrid: demGrid,
  };

  writeFileSync(filePath, JSON.stringify(dataset, null, 2), 'utf8');

  return dataset;
}
