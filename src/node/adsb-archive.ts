import { gunzipSync } from 'node:zlib';
import type { LinearFlightSegment } from '../schemas';
import { type AdsbInputOptions, segmentsFromAdsbJson } from './stream-adsb';
import { readTarFiles } from './tar-stream';

/** First byte of the gzip magic number (RFC 1952, section 2.3.1). */
const GZIP_ID1 = 0x1f;

/** Second byte of the gzip magic number (RFC 1952, section 2.3.1). */
const GZIP_ID2 = 0x8b;

/** First two bytes of a gzip stream. `readsb` history files carry a `.json` name but are usually gzip-compressed. */
const GZIP_MAGIC = [GZIP_ID1, GZIP_ID2];

/** Matches the per-aircraft trace files of an `adsb.lol` `globe_history` archive, for example `./traces/3a/trace_full_3a1b2c.json`. */
const TRACE_FILE = /(^|\/)trace_full_[0-9a-f~]+\.json$/;

/**
 * Reads flight segments from a tar stream of `adsb.lol` `globe_history` traces, one aircraft at a time so memory holds a single trace and the segments kept.
 * A day is published as `.tar.aa` and `.tar.ab` parts that concatenate to one tar, so the two parts can be piped in one after the other.
 * @param source - The tar bytes.
 * @param options - Region filter and compression tolerance.
 * @returns Segments from every trace file in the archive.
 * @throws When a trace file is not valid JSON of the trace shape, naming the file.
 */
export async function readAdsbArchiveSegments(source: Readonly<AsyncIterable<Uint8Array>>, options: Readonly<AdsbInputOptions> = {}): Promise<LinearFlightSegment[]> {
  const segments: LinearFlightSegment[] = [];
  for await (const file of readTarFiles(source, (name) => TRACE_FILE.test(name))) {
    const isGzip = GZIP_MAGIC.every((byte, index) => file.data[index] === byte);
    const text = (isGzip ? gunzipSync(file.data) : file.data).toString('utf8');
    let found: LinearFlightSegment[];
    try {
      found = segmentsFromAdsbJson(JSON.parse(text), options);
    } catch (error: unknown) {
      throw new Error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    segments.push(...found);
  }

  return segments;
}
