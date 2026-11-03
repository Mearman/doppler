import { gunzipSync } from 'node:zlib';
import type { LinearFlightSegment } from '../schemas';
import { segmentsFromAdsbJson } from './stream-adsb';
import { readTarFiles } from './tar-stream';

/** First two bytes of a gzip stream. `readsb` history files carry a `.json` name but are usually gzip-compressed. */
const GZIP_MAGIC = [0x1f, 0x8b];

/** Matches the per-aircraft trace files of an `adsb.lol` `globe_history` archive, for example `./traces/3a/trace_full_3a1b2c.json`. */
const TRACE_FILE = /(^|\/)trace_full_[0-9a-f~]+\.json$/;

/** A latitude and longitude rectangle. */
export interface BoundingBox {
  readonly minLat: number;
  readonly minLon: number;
  readonly maxLat: number;
  readonly maxLon: number;
}

/** Options for reading an archive. */
export interface AdsbArchiveOptions {
  /** Keeps only segments that start or end inside the box, which bounds the dataset for one region. */
  readonly bbox?: Readonly<BoundingBox>;
}

function inBox(lat: number, lon: number, box: Readonly<BoundingBox>): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

/**
 * Reads flight segments from a tar stream of `adsb.lol` `globe_history` traces, one aircraft at a time so memory holds a single trace and the segments kept.
 * A day is published as `.tar.aa` and `.tar.ab` parts that concatenate to one tar, so the two parts can be piped in one after the other.
 * @param source - The tar bytes.
 * @param options - Optional region filter.
 * @returns Segments from every trace file in the archive.
 * @throws When a trace file is not valid JSON of the trace shape, naming the file.
 */
export async function readAdsbArchiveSegments(source: Readonly<AsyncIterable<Uint8Array>>, options: Readonly<AdsbArchiveOptions> = {}): Promise<LinearFlightSegment[]> {
  const segments: LinearFlightSegment[] = [];
  for await (const file of readTarFiles(source, (name) => TRACE_FILE.test(name))) {
    const isGzip = GZIP_MAGIC.every((byte, index) => file.data[index] === byte);
    const text = (isGzip ? gunzipSync(file.data) : file.data).toString('utf8');
    let found: LinearFlightSegment[];
    try {
      found = segmentsFromAdsbJson(JSON.parse(text), {});
    } catch (error: unknown) {
      throw new Error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const { bbox } = options;
    for (const segment of found) {
      if (bbox === undefined || inBox(segment.startGeo.lat, segment.startGeo.lon, bbox) || inBox(segment.endGeo.lat, segment.endGeo.lon, bbox)) {
        segments.push(segment);
      }
    }
  }

  return segments;
}
