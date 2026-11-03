import { describe, expect, it } from 'vitest';
import { MAX_RADIUS_NM } from '../src/live-limits';
import { upstreamUrl } from './route';

describe('upstreamUrl', () => {
  it('maps a point query to the upstream, rounding coordinates so nearby callers share a cache entry', () => {
    expect(upstreamUrl('/v2/point/51.7523/-1.2577/50')).toBe('https://api.adsb.lol/v2/point/51.75/-1.26/50');
    expect(upstreamUrl('/v2/point/51.7549/-1.2551/50')).toBe('https://api.adsb.lol/v2/point/51.75/-1.26/50');
  });

  it('rounds a fractional radius up so the view stays covered', () => {
    expect(upstreamUrl('/v2/point/10/20/12.2')).toBe('https://api.adsb.lol/v2/point/10.00/20.00/13');
  });

  it('accepts the largest radius and refuses one beyond it', () => {
    expect(upstreamUrl(`/v2/point/0/0/${String(MAX_RADIUS_NM)}`)).toBeDefined();
    expect(upstreamUrl(`/v2/point/0/0/${String(MAX_RADIUS_NM + 1)}`)).toBeUndefined();
    expect(upstreamUrl('/v2/point/0/0/0')).toBeUndefined();
  });

  it('refuses coordinates outside the globe', () => {
    expect(upstreamUrl('/v2/point/90.1/0/50')).toBeUndefined();
    expect(upstreamUrl('/v2/point/0/-180.5/50')).toBeUndefined();
  });

  it('serves nothing but the point query', () => {
    for (const path of ['/', '/v2/all', '/v2/hex/abc123', '/v2/point/1/2', '/v2/point/1/2/3/4', '/v2/point/a/b/50', '/api/0/me', '/v2/point/../../etc/passwd']) {
      expect(upstreamUrl(path)).toBeUndefined();
    }
  });
});
