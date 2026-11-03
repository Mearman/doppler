import { describe, expect, it } from 'vitest';
import { SYNTHETIC_CONSTELLATIONS, SYNTHETIC_SEGMENTS } from '../test-support/synthetic-reference';
import {
  expandConstellationQueryKeys,
  formatConstellationKey,
  matchesSearchConstraints,
  QUERY_BUCKET_SPAN,
} from './constellation';

/** Groundspeed in m/s of the synthetic alpha segment, the first flyover of the key. */
const ALPHA_SPEED_MPS = 66.8;
/** Groundspeed in m/s of the synthetic bravo segment, the second flyover of the key. */
const BRAVO_SPEED_MPS = 77.9;
/** Closest-approach time offset in seconds between the alpha and bravo flyovers: the 920 s between their start times. */
const ALPHA_BRAVO_DELTA_SEC = 920;
/** Axes of a constellation key (first speed, second speed, time offset), each expanded by a query. */
const KEY_AXES = 3;
/** Buckets per axis of an expanded query: the measured one and `QUERY_BUCKET_SPAN` either side. */
const BUCKETS_PER_AXIS = 2 * QUERY_BUCKET_SPAN + 1;

describe('Constellation Hashing and Multi-Axis Filtering', () => {
  it('formats deterministic constellation keys and expands query neighborhood', () => {
    const key = formatConstellationKey(ALPHA_SPEED_MPS, BRAVO_SPEED_MPS, ALPHA_BRAVO_DELTA_SEC);
    expect(key).toBe('v22_v26_dt184');

    const expanded = expandConstellationQueryKeys(ALPHA_SPEED_MPS, BRAVO_SPEED_MPS, ALPHA_BRAVO_DELTA_SEC);
    expect(expanded.has(key)).toBe(true);
    // One key per combination of buckets on every axis
    expect(expanded.size).toBe(BUCKETS_PER_AXIS ** KEY_AXES);
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

  it('contains indexed constellation entries for synthetic flyovers', () => {
    expect(SYNTHETIC_CONSTELLATIONS.length).toBeGreaterThan(0);
    const entry = SYNTHETIC_CONSTELLATIONS[0];
    expect(entry).toBeDefined();
    expect(entry?.segmentIdA).toBe(SYNTHETIC_SEGMENTS[0]?.id);
  });
});
