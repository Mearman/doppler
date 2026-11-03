import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readAdsbArchiveSegments } from './adsb-archive';
import { TAR_END, tarEntry } from './test-support/tar';
import { flightLeg, type Origin } from './test-support/trace';

/** Epoch seconds of 2026-09-08T00:00:00Z, the date the segments of these traces must carry. */
const DAY_START = 1788825600;

/** Bounds of the ground speed the compressed segments of these traces must stay within, in metres per second: a light aircraft's range around the 59 m/s of the sampled track. */
const MIN_GROUNDSPEED_MPS = 50;
const MAX_GROUNDSPEED_MPS = 90;

/** Bytes of non-trace archive content, which the reader must skip. */
const SKIPPED_ENTRY_BYTES = 2048;

/** Fill byte of the skipped entry. */
const SKIPPED_ENTRY_FILL = 1;

/** Near Oxford, inside the bounding box of the filter test. */
const OXFORD: Origin = { lat: 51.5, lon: -1.2 };

/** One degree of latitude north of Oxford, outside the filter test's bounding box. */
const NORTH_OF_OXFORD: Origin = { lat: 52.5, lon: -1.2 };

/** Central Spain, far outside the filter test's bounding box. */
const CENTRAL_SPAIN: Origin = { lat: 40, lon: -3 };

/** A light-aircraft trace flying north-east from `origin` at 3,000 ft. */
function trace(icao: string, origin: Readonly<Origin>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { icao, r: `G-${icao.toUpperCase()}`, t: 'C172', timestamp: DAY_START, trace: flightLeg(0, origin), ...extra };
}

const once = (bytes: Buffer): AsyncIterable<Uint8Array> => Readable.from([bytes], { objectMode: false });

describe('readAdsbArchiveSegments', () => {
  it('reads plain and gzip-compressed trace files and ignores everything else', async () => {
    const archive = Buffer.concat([
      tarEntry('./heatmap/0.bin.ttf', Buffer.alloc(SKIPPED_ENTRY_BYTES, SKIPPED_ENTRY_FILL)),
      tarEntry('./traces/aa/trace_full_aa0001.json', Buffer.from(JSON.stringify(trace('aa0001', OXFORD)))),
      tarEntry('./traces/bb/trace_full_bb0002.json', gzipSync(JSON.stringify(trace('bb0002', NORTH_OF_OXFORD)))),
      tarEntry('./traces/bb/readme.txt', Buffer.from('not a trace')),
      TAR_END,
    ]);
    const segments = await readAdsbArchiveSegments(once(archive));

    expect(new Set(segments.map((segment) => segment.icao24))).toEqual(new Set(['aa0001', 'bb0002']));
    expect(segments.every((segment) => segment.dateIso === '2026-09-08')).toBe(true);
    expect(segments.every((segment) => segment.groundspeedMps > MIN_GROUNDSPEED_MPS && segment.groundspeedMps < MAX_GROUNDSPEED_MPS)).toBe(true);
  });

  it('keeps only segments touching the bounding box', async () => {
    const archive = Buffer.concat([
      tarEntry('./traces/aa/trace_full_aa0001.json', Buffer.from(JSON.stringify(trace('aa0001', OXFORD)))),
      tarEntry('./traces/bb/trace_full_bb0002.json', Buffer.from(JSON.stringify(trace('bb0002', CENTRAL_SPAIN)))),
      TAR_END,
    ]);
    const segments = await readAdsbArchiveSegments(once(archive), { bbox: { minLat: 51, minLon: -2, maxLat: 52, maxLon: -1 } });

    expect(new Set(segments.map((segment) => segment.icao24))).toEqual(new Set(['aa0001']));
  });

  it('names the file when a trace is malformed', async () => {
    const archive = Buffer.concat([tarEntry('./traces/aa/trace_full_aa0001.json', Buffer.from('{"icao":"aa0001"}')), TAR_END]);

    await expect(readAdsbArchiveSegments(once(archive))).rejects.toThrow('trace_full_aa0001.json');
  });
});
