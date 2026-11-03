import { describe, expect, it } from 'vitest';
import type { AdsbPing } from '../schemas';
import { geoToEcef } from './geo';
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

  const META = { flightId: 'T', icao24: 'a001', typeCode: 'C172', category: 'piston', dateIso: '2026-09-08' } as const;

  /** A deterministic pseudo-random track that turns, climbs and varies its speed, so splits fall unevenly. */
  function wanderingTrack(count: number, seed: number): AdsbPing[] {
    let state = seed;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;

      return state / 4294967296;
    };
    let lat = 51.5;
    let lon = -1.2;
    let heading = 0;
    let altMeters = 800;
    let epochSec = 1000;

    return Array.from({ length: count }, () => {
      heading += (next() - 0.5) * 0.35;
      lat += Math.cos(heading) * 0.0006;
      lon += Math.sin(heading) * 0.0009;
      altMeters += (next() - 0.5) * 12;
      epochSec += 1 + Math.floor(next() * 3);

      return { epochSec, lat, lon, altMeters };
    });
  }

  it.each([1, 2, 3])('keeps every dropped ping within tolerance of its segment (seed %i)', (seed) => {
    const pings = wanderingTrack(3000, seed);
    const segments = simplifyTrajectory4D(pings, META, 5.0);

    for (const ping of pings) {
      const segment = segments.find((candidate) => ping.epochSec >= candidate.startEpochSec && ping.epochSec <= candidate.endEpochSec);
      expect(segment).toBeDefined();
      if (segment === undefined) {
        continue;
      }
      const fraction = (ping.epochSec - segment.startEpochSec) / (segment.endEpochSec - segment.startEpochSec);
      const a = geoToEcef(segment.startGeo);
      const b = geoToEcef(segment.endGeo);
      const p = geoToEcef(ping);
      const error = Math.hypot(p.x - (a.x + (b.x - a.x) * fraction), p.y - (a.y + (b.y - a.y) * fraction), p.z - (a.z + (b.z - a.z) * fraction));
      expect(error).toBeLessThanOrEqual(5.0 + 1e-6);
    }
  });

  it('chains segments end to end and gives each a distinct id', () => {
    const segments = simplifyTrajectory4D(wanderingTrack(2000, 7), META, 5.0);

    segments.slice(1).forEach((segment, index) => {
      expect(segment.startEpochSec).toBe(segments[index]?.endEpochSec);
    });
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(segments.length);
  });

  it('simplifies a day-long trace without exhausting the call stack or the heap', () => {
    const segments = simplifyTrajectory4D(wanderingTrack(86400, 11), META, 5.0);

    expect(segments.length).toBeGreaterThan(1);
  });
});

