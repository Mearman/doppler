import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type AdsbTraceOptions, RawAdsbTraceFileSchema, processRawAdsbTrace } from '../adsb-traces';
import type { GeoPoint3D } from '../schemas';
import { type DopplerDataset, DopplerDatasetSchema, type LinearFlightSegment, LinearFlightSegmentSchema } from '../schemas';
import { buildConstellationIndex } from '../solver/constellation';
import { MS_PER_SECOND } from '../time';

/** Characters of the ISO 8601 calendar date (`YYYY-MM-DD`) at the start of a `Date.toISOString()` string. */
const ISO_DATE_LENGTH = 'YYYY-MM-DD'.length;

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
    return z.array(LinearFlightSegmentSchema).parse(parsed.segments);
  }
  if (LinearFlightSegmentSchema.is(parsed)) {
    return [parsed];
  }
  const trace = RawAdsbTraceFileSchema.parse(parsed);
  if (trace.timestamp !== undefined) {
    return processRawAdsbTrace(trace, new Date(trace.timestamp * MS_PER_SECOND).toISOString().slice(0, ISO_DATE_LENGTH), trace.timestamp, options);
  }
  if (options.dateIso === undefined) {
    throw new Error(`trace ${trace.icao} has no timestamp, so its date is unknown; pass the date`);
  }

  return processRawAdsbTrace(trace, options.dateIso, Date.parse(`${options.dateIso}T00:00:00Z`) / MS_PER_SECOND, options);
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

  return DopplerDatasetSchema.parse(parsed);
}

/** Items serialised per write, so no single string approaches the engine's string length limit however large the dataset. */
const WRITE_BATCH_ITEMS = 5000;

function writeJsonArray(fd: number, items: readonly unknown[]): void {
  writeSync(fd, '[');
  for (let start = 0; start < items.length; start += WRITE_BATCH_ITEMS) {
    const batch = items.slice(start, start + WRITE_BATCH_ITEMS).map((item) => JSON.stringify(item)).join(',');
    writeSync(fd, start === 0 ? batch : `,${batch}`);
  }
  writeSync(fd, ']');
}

/**
 * Serializes and saves a DopplerDataset to disk with built constellation index. The file is compact JSON written in batches, because a day of real traffic is hundreds of thousands of segments and one `JSON.stringify` of that overflows the string length limit.
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

  const fd = openSync(filePath, 'w');
  try {
    writeSync(fd, `{"version":${JSON.stringify(dataset.version)},"generatedAtIso":${JSON.stringify(dataset.generatedAtIso)},"segments":`);
    writeJsonArray(fd, segments);
    writeSync(fd, ',"constellations":');
    writeJsonArray(fd, constellations);
    writeSync(fd, ',"elevationGrid":');
    writeJsonArray(fd, demGrid);
    writeSync(fd, '}');
  } finally {
    closeSync(fd);
  }

  return dataset;
}
