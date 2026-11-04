import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdsbCoreUrl, loadParquetHistoryDataset, PARQUET_COLUMNS } from './adsb-parquet';

const fakeMetadata = {
  row_groups: [
    {
      num_rows: 2,
      columns: [
        {
          meta_data: {
            path_in_schema: ['timestamp'],
            statistics: { min_value: '2026-08-29T10:00:00Z', max_value: '2026-08-29T10:02:00Z' },
          },
        },
        {
          meta_data: {
            path_in_schema: ['latitude'],
            statistics: { min_value: 51.0, max_value: 52.0 },
          },
        },
        {
          meta_data: {
            path_in_schema: ['longitude'],
            statistics: { min_value: -1.5, max_value: -0.5 },
          },
        },
      ],
    },
  ],
};

const fakeRows = [
  ['G-TEST', new Date('2026-08-29T10:00:00Z'), 51.5, -1.0, 3000, false, 120],
  ['G-TEST', new Date('2026-08-29T10:01:00Z'), 51.52, -0.98, 3000, false, 120],
];

vi.mock('hyparquet', () => ({
  asyncBufferFromUrl: vi.fn(async () => Promise.resolve({ byteLength: 1000 })),
  parquetMetadataAsync: vi.fn(async () => Promise.resolve(fakeMetadata)),
  parquetRead: vi.fn(async (opts: Readonly<{ onComplete: (rows: readonly (readonly unknown[])[]) => void }>) => {
    opts.onComplete(fakeRows);

    return Promise.resolve();
  }),
}));

describe('adsb-parquet', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('formats Hugging Face adsb-core Parquet file URL by date', () => {
    const url = getAdsbCoreUrl('2026-08-29');
    expect(url).toBe(
      'https://huggingface.co/datasets/juliangehring/adsb-core/resolve/main/data/core/year=2026/date=2026-08-29/adsb_core.parquet',
    );
  });

  it('includes mandatory ADS-B trajectory columns', () => {
    expect(PARQUET_COLUMNS).toContain('icao');
    expect(PARQUET_COLUMNS).toContain('timestamp');
    expect(PARQUET_COLUMNS).toContain('latitude');
    expect(PARQUET_COLUMNS).toContain('longitude');
    expect(PARQUET_COLUMNS).toContain('altitude_ft');
  });

  it('filters row groups and records into 4D flight segments', async () => {
    const dataset = await loadParquetHistoryDataset({
      dateIso: '2026-08-29',
      bbox: { minLat: 51.0, maxLat: 52.0, minLon: -2.0, maxLon: 0.0 },
      startEpochSec: 1787997500,
      endEpochSec: 1787998000,
      urlOverride: 'mock://adsb.parquet',
    });

    expect(dataset.version).toBe('adsb-core-2026-08-29');
    expect(dataset.segments.length).toBeGreaterThanOrEqual(1);
    expect(dataset.segments[0]?.icao24).toBe('G-TEST');
  });
});
