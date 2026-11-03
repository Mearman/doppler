import { MAX_RADIUS_NM } from '../src/live-limits';

/** Origin of the upstream service the Worker relays: adsb.lol's keyless point API, which is public but sends no CORS headers. */
export const UPSTREAM_ORIGIN = 'https://api.adsb.lol';

/** Seconds a response is shared between every caller: all pages asking about the same point in the same moment cost the upstream one request. */
export const CACHE_SECONDS = 5;

/** Decimal places the relay keeps of a coordinate, so that nearby callers share a cache entry: 1e-2 degrees is about 1 km, far finer than a radius of tens of kilometres. */
const COORDINATE_DECIMALS = 2;

/** The one path shape the relay accepts: `/v2/point/<lat>/<lon>/<radius in nautical miles>`. */
const POINT_PATH = /^\/v2\/point\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/;

/** Largest absolute latitude and longitude, in degrees. */
const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;

/**
 * Maps a request path to the upstream URL it may fetch, or undefined when the relay does not serve the path.
 * Only the point query is relayed, with a bounded radius and coordinates rounded to share cache entries, so the Worker cannot be used to reach anything else on the upstream.
 * @param pathname - The request URL's path.
 * @returns The upstream URL, or undefined for any other path or an out-of-range value.
 */
export function upstreamUrl(pathname: string): string | undefined {
  const match = POINT_PATH.exec(pathname);
  if (match === null) {
    return undefined;
  }
  const [, latText = '', lonText = '', radiusText = ''] = match;
  const lat = Number(latText);
  const lon = Number(lonText);
  const radius = Number(radiusText);
  if (Math.abs(lat) > MAX_LATITUDE || Math.abs(lon) > MAX_LONGITUDE || radius <= 0 || radius > MAX_RADIUS_NM) {
    return undefined;
  }

  return `${UPSTREAM_ORIGIN}/v2/point/${lat.toFixed(COORDINATE_DECIMALS)}/${lon.toFixed(COORDINATE_DECIMALS)}/${String(Math.ceil(radius))}`;
}
