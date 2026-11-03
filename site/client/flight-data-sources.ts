import { z } from 'zod';

/** Hugging Face dataset repository the daily ADS-B pipeline publishes flight data to. */
export const FLIGHT_DATA_REPOSITORY = 'Mearman/doppler-adsb';

/** Suffix of the files in that repository that hold a `DopplerDataset`. */
const DATASET_FILE_SUFFIX = '.dataset.json';

/** Longest string V8 can hold, in UTF-16 code units (2^29 - 24), which bounds the JSON text a page can parse in one piece. */
export const MAX_JSON_CHARS = 2 ** 29 - 24;

/** One dataset file in the repository. */
export interface FlightDataFile {
  readonly path: string;
  readonly sizeBytes: number;
}

const TreeSchema = z.array(z.object({ type: z.string(), path: z.string(), size: z.number() }));

/**
 * Picks the dataset files out of a Hugging Face repository tree listing.
 * @param tree - The parsed JSON of `/api/datasets/<repo>/tree/main`.
 * @returns The dataset files, newest name first, which for date-named files is the most recent day.
 */
export function parseDatasetFiles(tree: unknown): readonly FlightDataFile[] {
  return TreeSchema.parse(tree)
    .filter((entry) => entry.type === 'file' && entry.path.endsWith(DATASET_FILE_SUFFIX))
    .map((entry) => ({ path: entry.path, sizeBytes: entry.size }))
    .sort((a, b) => b.path.localeCompare(a.path));
}

/**
 * Whether a file of this size can be read as one JSON string. UTF-8 JSON is at least one byte per character, so a file larger than the string limit cannot fit.
 * @param sizeBytes - The file size in bytes.
 * @returns True when the file is within the string limit.
 */
export function fitsInBrowser(sizeBytes: number): boolean {
  return sizeBytes <= MAX_JSON_CHARS;
}

/** Bytes in a megabyte and in a gigabyte, for choosing the unit a size is shown in. */
const BYTES_PER_MB = 1_000_000;
const BYTES_PER_GB = 1_000_000_000;

/**
 * Formats a file size in the unit a person reads it in.
 * @param bytes - The size in bytes.
 * @returns Megabytes below a gigabyte, otherwise gigabytes, to one decimal place.
 */
export function formatBytes(bytes: number): string {
  return bytes < BYTES_PER_GB ? `${(bytes / BYTES_PER_MB).toFixed(1)} MB` : `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
}

/**
 * Lists the dataset files the repository holds.
 * @param signal - Cancels the request.
 * @returns The dataset files, newest first.
 */
export async function listFlightDataFiles(signal: AbortSignal): Promise<readonly FlightDataFile[]> {
  const response = await fetch(`https://huggingface.co/api/datasets/${FLIGHT_DATA_REPOSITORY}/tree/main`, { signal });
  if (!response.ok) {
    throw new Error(`Hugging Face answered ${String(response.status)} when listing ${FLIGHT_DATA_REPOSITORY}`);
  }

  return parseDatasetFiles(await response.json());
}

/**
 * Downloads one dataset file as text.
 * @param path - A path from `listFlightDataFiles`.
 * @param signal - Cancels the download.
 * @returns The file's JSON text.
 */
export async function downloadFlightDataFile(path: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(`https://huggingface.co/datasets/${FLIGHT_DATA_REPOSITORY}/resolve/main/${path}`, { signal });
  if (!response.ok) {
    throw new Error(`Hugging Face answered ${String(response.status)} for ${path}`);
  }

  return response.text();
}
