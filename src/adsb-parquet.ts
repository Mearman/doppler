import { asyncBufferFromUrl, parquetMetadataAsync, parquetRead } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import type { BoundingBox } from './adsb-traces';
import { classifyAircraftCategory } from './adsb-traces';
import { simplifyTrajectory4D } from './physics/rdp';
import type { AdsbPing, DopplerDataset, LinearFlightSegment } from './schemas';
import { buildConstellationIndex } from './solver/constellation';
import { MS_PER_SECOND } from './time';

/** Remote URL template for daily adsb-core Parquet files on Hugging Face (CC0, ungated). */
export const ADSB_CORE_URL_TEMPLATE =
  'https://huggingface.co/datasets/juliangehring/adsb-core/resolve/main/data/core/year={YEAR}/date={DATE}/adsb_core.parquet';

/** Columns required to build flight segments. */
export const PARQUET_COLUMNS = [
  'icao',
  'timestamp',
  'latitude',
  'longitude',
  'altitude_ft',
  'on_ground',
  'ground_speed_kt',
] as const;

/** Feet to metres conversion factor. */
const METERS_PER_FOOT = 0.3048;

/** Length of year string (4 digits). */
const YEAR_LENGTH = 4;

/** Max audible altitude in feet (20,000 ft). */
const MAX_AUDIBLE_ALTITUDE_FT = 20_000;

/** Spatial tolerance in metres for 4D Ramer-Douglas-Peucker trajectory simplification. */
const TRAJECTORY_TOLERANCE_METERS = 10.0;

/** Minimum column count required in a raw row tuple. */
const MIN_ROW_ELEMENT_COUNT = 6;

export interface ParquetHistoryOptions {
  readonly dateIso: string;
  readonly bbox: Readonly<BoundingBox>;
  readonly startEpochSec: number;
  readonly endEpochSec: number;
  readonly urlOverride?: string;
  readonly onProgress?: (progress: Readonly<ParquetProgress>) => void;
}

export interface ParquetProgress {
  readonly rowGroup: number;
  readonly totalRowGroups: number;
  readonly matchingPings: number;
  readonly segments: number;
}

interface ParsedPingRow {
  readonly icao: string;
  readonly epochSec: number;
  readonly lat: number;
  readonly lon: number;
  readonly altFt: number;
}

/** Formats date into adsb-core dataset file URL. */
export function getAdsbCoreUrl(dateIso: string): string {
  const year = dateIso.slice(0, YEAR_LENGTH);

  return ADSB_CORE_URL_TEMPLATE.replace('{YEAR}', year).replace('{DATE}', dateIso);
}

/** Type guard for raw parquet row values. */
function parseRawRow(row: unknown): ParsedPingRow | undefined {
  const items: readonly unknown[] = Array.isArray(row) ? row : [];
  if (items.length < MIN_ROW_ELEMENT_COUNT) {
    return undefined;
  }
  const rawIcao = items[0];
  const rawTs = items[1];
  const rawLat = items[2];
  const rawLon = items[3];
  const rawAlt = items[4];
  const rawGround = items[5];
  if (
    typeof rawIcao !== 'string' ||
    typeof rawLat !== 'number' ||
    typeof rawLon !== 'number' ||
    typeof rawAlt !== 'number' ||
    rawGround === true ||
    rawAlt > MAX_AUDIBLE_ALTITUDE_FT
  ) {
    return undefined;
  }

  let epochSec: number;
  if (rawTs instanceof Date) {
    epochSec = Math.floor(rawTs.getTime() / MS_PER_SECOND);
  } else if (typeof rawTs === 'number') {
    epochSec = Math.floor(rawTs / MS_PER_SECOND);
  } else {
    return undefined;
  }

  return { icao: rawIcao, epochSec, lat: rawLat, lon: rawLon, altFt: rawAlt };
}

/**
 * Reads historical ADS-B data from an adsb-core Parquet file over HTTP range requests, filtering row groups and records to the requested bounding box and time window.
 */
export async function loadParquetHistoryDataset(
  options: Readonly<ParquetHistoryOptions>,
): Promise<DopplerDataset> {
  const { dateIso, bbox, startEpochSec, endEpochSec, urlOverride, onProgress } = options;
  const url = urlOverride ?? getAdsbCoreUrl(dateIso);
  const file = await asyncBufferFromUrl({ url });
  const meta = await parquetMetadataAsync(file);

  const startTimeMs = startEpochSec * MS_PER_SECOND;
  const endTimeMs = endEpochSec * MS_PER_SECOND;

  const pingsByIcao = new Map<string, AdsbPing[]>();
  let matchingPings = 0;
  const totalRowGroups = meta.row_groups.length;

  const validRowGroupRanges: { rowStart: number; rowEnd: number; rgIndex: number }[] = [];
  let currentRow = 0;

  for (let rgIndex = 0; rgIndex < totalRowGroups; rgIndex += 1) {
    const rg = meta.row_groups[rgIndex];
    if (rg === undefined) {
      continue;
    }

    const rowStart = currentRow;
    const rowEnd = currentRow + Number(rg.num_rows);
    currentRow = rowEnd;

    // Check row group statistics to see if we can skip this entire row group
    const colTime = rg.columns.find((c) => c.meta_data?.path_in_schema[0] === 'timestamp');
    const colLat = rg.columns.find((c) => c.meta_data?.path_in_schema[0] === 'latitude');
    const colLon = rg.columns.find((c) => c.meta_data?.path_in_schema[0] === 'longitude');

    if (
      colTime?.meta_data?.statistics?.min_value !== undefined &&
      colTime.meta_data.statistics.max_value !== undefined
    ) {
      const minTime = new Date(String(colTime.meta_data.statistics.min_value)).getTime();
      const maxTime = new Date(String(colTime.meta_data.statistics.max_value)).getTime();
      if (maxTime < startTimeMs || minTime > endTimeMs) {
        continue;
      }
    }

    if (
      colLat?.meta_data?.statistics?.min_value !== undefined &&
      colLat.meta_data.statistics.max_value !== undefined
    ) {
      const minLat = Number(colLat.meta_data.statistics.min_value);
      const maxLat = Number(colLat.meta_data.statistics.max_value);
      if (maxLat < bbox.minLat || minLat > bbox.maxLat) {
        continue;
      }
    }

    if (
      colLon?.meta_data?.statistics?.min_value !== undefined &&
      colLon.meta_data.statistics.max_value !== undefined
    ) {
      const minLon = Number(colLon.meta_data.statistics.min_value);
      const maxLon = Number(colLon.meta_data.statistics.max_value);
      if (maxLon < bbox.minLon || minLon > bbox.maxLon) {
        continue;
      }
    }

    validRowGroupRanges.push({ rowStart, rowEnd, rgIndex });
  }

  // Sequentially read row groups via a promise pipeline
  await validRowGroupRanges.reduce(async (prevPromise, range) => {
    await prevPromise;
    await parquetRead({
      file,
      compressors,
      columns: [...PARQUET_COLUMNS],
      rowStart: range.rowStart,
      rowEnd: range.rowEnd,
      onComplete: (rows) => {
        for (const row of rows) {
          const parsed = parseRawRow(row);
          if (parsed === undefined) {
            continue;
          }
          const { icao, epochSec, lat, lon, altFt } = parsed;
          if (
            lat < bbox.minLat ||
            lat > bbox.maxLat ||
            lon < bbox.minLon ||
            lon > bbox.maxLon ||
            epochSec < startEpochSec ||
            epochSec > endEpochSec
          ) {
            continue;
          }

          const ping: AdsbPing = {
            epochSec,
            lat,
            lon,
            altMeters: altFt * METERS_PER_FOOT,
          };

          const list = pingsByIcao.get(icao);
          if (list === undefined) {
            pingsByIcao.set(icao, [ping]);
          } else {
            list.push(ping);
          }
          matchingPings += 1;
        }
      },
    });

    onProgress?.({
      rowGroup: range.rgIndex + 1,
      totalRowGroups,
      matchingPings,
      segments: pingsByIcao.size,
    });
  }, Promise.resolve());

  // Convert pings into 4D trajectory segments
  const segments: LinearFlightSegment[] = [];
  for (const [icao, pings] of pingsByIcao) {
    if (pings.length < 2) {
      continue;
    }
    const simplified = simplifyTrajectory4D(
      pings,
      {
        flightId: icao,
        icao24: icao,
        typeCode: 'unknown',
        category: classifyAircraftCategory('unknown'),
        dateIso,
      },
      TRAJECTORY_TOLERANCE_METERS,
    );
    segments.push(...simplified);
  }

  return {
    version: `adsb-core-${dateIso}`,
    generatedAtIso: new Date().toISOString(),
    segments,
    constellations: buildConstellationIndex(segments),
    elevationGrid: [],
  };
}
