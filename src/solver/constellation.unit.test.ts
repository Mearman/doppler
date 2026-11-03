import { describe, expect, it } from 'vitest';
import { BUNDLED_CONSTELLATIONS, BUNDLED_SEGMENTS } from '../bundled';
import { expandConstellationQueryKeys, formatConstellationKey, matchesSearchConstraints } from './constellation';

describe('Constellation Hashing and Multi-Axis Filtering', () => {
  it('formats deterministic constellation keys and expands query neighborhood', () => {
    const key = formatConstellationKey(66.8, 77.9, 920);
    expect(key).toBe('v22_v26_dt184');

    const expanded = expandConstellationQueryKeys(66.8, 77.9, 920);
    expect(expanded.has(key)).toBe(true);
    // 5 x 5 x 5 neighborhood
    expect(expanded.size).toBe(125);
  });

  it('filters candidates correctly against multi-axis space, date, and hour constraints', () => {
    // Oxford: 51.752, -1.2577, date: 2026-09-08, epoch: 1788900000 (around 20:40 UTC)
    const lat = 51.752;
    const lon = -1.2577;
    const date = '2026-09-08';
    const epoch = 1788900000;

    const target = { lat, lon, dateIso: date, epochSec: epoch };

    // Satisfies matching UK/Europe bounding box
    expect(matchesSearchConstraints(target, { minLat: 50, maxLat: 55, minLon: -3, maxLon: 1 })).toBe(true);

    // Rejects incompatible Americas bounding box
    expect(matchesSearchConstraints(target, { minLat: 25, maxLat: 49, minLon: -125, maxLon: -65 })).toBe(false);

    // Rejects incompatible date
    expect(matchesSearchConstraints(target, { dateFromIso: '2026-10-01' })).toBe(false);

    // Accepts 50 Hz European grid, rejects 60 Hz
    expect(matchesSearchConstraints(target, { enfNominalHz: '50' })).toBe(true);
    expect(matchesSearchConstraints(target, { enfNominalHz: '60' })).toBe(false);
  });

  it('contains indexed constellation entries for bundled flyovers', () => {
    expect(BUNDLED_CONSTELLATIONS.length).toBeGreaterThan(0);
    const entry = BUNDLED_CONSTELLATIONS[0];
    expect(entry).toBeDefined();
    expect(entry?.segmentIdA).toBe(BUNDLED_SEGMENTS[0]?.id);
  });
});
