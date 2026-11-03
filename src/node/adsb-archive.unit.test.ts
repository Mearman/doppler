import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readAdsbArchiveSegments } from './adsb-archive';
import { TAR_END, tarEntry } from './test-support/tar';

const DAY_START = 1788825600;

/** A light-aircraft trace flying north-east at about 70 m/s below 20,000 ft, `legs` sample points 10 s apart. */
function trace(icao: string, lat: number, lon: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const points = Array.from({ length: 12 }, (_, index) => [index * 10, lat + index * 0.0045, lon + index * 0.0045, 3000, 130, 45]);

  return { icao, r: `G-${icao.toUpperCase()}`, t: 'C172', timestamp: DAY_START, trace: points, ...extra };
}

const once = (bytes: Buffer): AsyncIterable<Uint8Array> => Readable.from([bytes], { objectMode: false });

describe('readAdsbArchiveSegments', () => {
  it('reads plain and gzip-compressed trace files and ignores everything else', async () => {
    const archive = Buffer.concat([
      tarEntry('./heatmap/0.bin.ttf', Buffer.alloc(2048, 1)),
      tarEntry('./traces/aa/trace_full_aa0001.json', Buffer.from(JSON.stringify(trace('aa0001', 51.5, -1.2)))),
      tarEntry('./traces/bb/trace_full_bb0002.json', gzipSync(JSON.stringify(trace('bb0002', 52.5, -1.2)))),
      tarEntry('./traces/bb/readme.txt', Buffer.from('not a trace')),
      TAR_END,
    ]);
    const segments = await readAdsbArchiveSegments(once(archive));

    expect(new Set(segments.map((segment) => segment.icao24))).toEqual(new Set(['aa0001', 'bb0002']));
    expect(segments.every((segment) => segment.dateIso === '2026-09-08')).toBe(true);
    expect(segments.every((segment) => segment.groundspeedMps > 50 && segment.groundspeedMps < 90)).toBe(true);
  });

  it('keeps only segments touching the bounding box', async () => {
    const archive = Buffer.concat([
      tarEntry('./traces/aa/trace_full_aa0001.json', Buffer.from(JSON.stringify(trace('aa0001', 51.5, -1.2)))),
      tarEntry('./traces/bb/trace_full_bb0002.json', Buffer.from(JSON.stringify(trace('bb0002', 40.0, -3.0)))),
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
