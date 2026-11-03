import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_WINDOW_SEC, LiveTrackBook, type LivePing, fetchLivePings, liveDataset, livePingsFromResponse } from './live-adsb';
import { DopplerDatasetSchema } from './schemas';

/** Epoch seconds of 2026-09-08T10:00:00Z, an arbitrary fixed poll time. */
const NOW = 1788861600;

/** A light aircraft flying due east at a steady 300 m above the origin of the test frame. */
function eastboundPings(icao: string, count: number, stepSec: number, typeCode: string | undefined = 'C172'): LivePing[] {
  return Array.from({ length: count }, (_, index) => ({
    icao,
    registration: 'G-TEST',
    typeCode,
    epochSec: NOW + index * stepSec,
    lat: 51.75,
    lon: -1.3 + index * 0.001,
    altitudeFt: 1000,
  }));
}

describe('livePingsFromResponse', () => {
  it('dates each ping by when its position was last updated and skips aircraft without one', () => {
    const pings = livePingsFromResponse({
      now: NOW,
      ac: [
        { hex: 'abc123', r: 'G-ABCD', t: 'C172', lat: 51.75, lon: -1.3, alt_baro: 1500, seen_pos: 4 },
        { hex: 'def456', lat: 51.8, lon: -1.2, alt_baro: 'ground' },
        { hex: 'nopos1', t: 'PA28' },
      ],
    });

    expect(pings).toEqual([
      { icao: 'abc123', registration: 'G-ABCD', typeCode: 'C172', epochSec: NOW - 4, lat: 51.75, lon: -1.3, altitudeFt: 1500 },
      { icao: 'def456', registration: undefined, typeCode: undefined, epochSec: NOW, lat: 51.8, lon: -1.2, altitudeFt: 'ground' },
    ]);
  });

  it('rejects a response of another shape', () => {
    expect(() => livePingsFromResponse({ message: 'nope' })).toThrow();
  });
});

describe('LiveTrackBook', () => {
  it('forms a segment from several reports of one aircraft but none from a single report', () => {
    const book = new LiveTrackBook();
    book.add(eastboundPings('one', 1, 10));
    expect(book.segments()).toHaveLength(0);

    book.add(eastboundPings('one', 6, 10));
    const segments = book.segments();

    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0]?.icao24).toBe('one');
    expect(segments[0]?.category).toBe('piston');
  });

  it('ignores a report it already holds for the same aircraft and time', () => {
    const book = new LiveTrackBook();
    book.add(eastboundPings('one', 6, 10));
    const once = book.segments();
    book.add(eastboundPings('one', 6, 10));

    expect(book.segments()).toEqual(once);
  });

  it('drops reports older than the window, measured from the newest report', () => {
    const book = new LiveTrackBook();
    book.add(eastboundPings('old', 6, 10));
    book.add(eastboundPings('new', 6, 10).map((ping) => ({ ...ping, epochSec: ping.epochSec + LIVE_WINDOW_SEC + 100 })));

    expect(book.aircraftCount).toBe(1);
    expect(book.segments().every((segment) => segment.icao24 === 'new')).toBe(true);
  });

  it('leaves out jets, as an archive trace does', () => {
    const book = new LiveTrackBook();
    book.add(eastboundPings('jet', 6, 10, 'B738'));

    expect(book.segments()).toHaveLength(0);
  });
});

describe('liveDataset', () => {
  it('wraps segments as a valid dataset labelled live', () => {
    const book = new LiveTrackBook();
    book.add(eastboundPings('one', 6, 10));
    const dataset = DopplerDatasetSchema.parse(liveDataset(book.segments(), NOW));

    expect(dataset.version).toBe('live');
    expect(dataset.segments.length).toBeGreaterThanOrEqual(1);
    expect(dataset.generatedAtIso).toBe('2026-09-08T10:00:00.000Z');
  });
});

describe('fetchLivePings', () => {
  const query = { apiKey: 'test-key', lat: 51.75, lon: -1.26, radiusKm: 120.2 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the area with the key in a header and reads the answer', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ now: NOW, ac: [{ hex: 'abc123', lat: 51.7, lon: -1.2, alt_baro: 900 }] }));
    vi.stubGlobal('fetch', fetchMock);

    const pings = await fetchLivePings(query, new AbortController().signal);

    expect(pings).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.flyitalyadsb.com/v2/lat/51.7500/lon/-1.2600/dist/121');
    expect(new Headers(init?.headers).get('X-Api-Key')).toBe('test-key');
  });

  it('treats a refused key as fatal', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 })));

    await expect(fetchLivePings(query, new AbortController().signal)).rejects.toMatchObject({ fatal: true });
  });

  it('treats a rate limit as retryable after the time it names', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '7' } })));

    await expect(fetchLivePings(query, new AbortController().signal)).rejects.toMatchObject({ fatal: false, retryAfterSec: 7 });
  });
});
