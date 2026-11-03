import { describe, expect, it } from 'vitest';
import type { AdsbPing } from '../schemas';
import { simplifyTrajectory4D } from './rdp';

describe('simplifyTrajectory4D', () => {
  it('compresses colinear pings down to a single segment within tolerance', () => {
    const pings: AdsbPing[] = [];
    // 60 seconds of pings moving uniformly at ~70 m/s
    for (let t = 0; t <= 60; t += 1) {
      pings.push({
        epochSec: 1000 + t,
        lat: 51.5 + t * 0.0006,
        lon: -0.1,
        altMeters: 1000,
      });
    }

    const segments = simplifyTrajectory4D(
      pings,
      {
        flightId: 'TEST1',
        icao24: 'a001',
        typeCode: 'C172',
        category: 'piston',
        dateIso: '2026-09-08',
      },
      5.0,
    );

    expect(segments.length).toBe(1);
    const seg = segments[0];
    expect(seg?.groundspeedMps).toBeGreaterThan(60);
    expect(seg?.groundspeedMps).toBeLessThan(75);
  });
});
