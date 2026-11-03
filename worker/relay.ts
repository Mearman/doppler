import { CACHE_SECONDS, upstreamUrl } from './route';

/** HTTP statuses the relay answers with itself. */
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_NO_CONTENT = 204;

/** Headers that let any web page read the answer. The data is public and keyless, so no origin needs excluding. */
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } as const;

/**
 * Relays adsb.lol's keyless point API with CORS headers, so a web page can poll live aircraft without a key.
 * Responses are cached at the edge for a few seconds and shared between callers.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: HTTP_NO_CONTENT, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: HTTP_METHOD_NOT_ALLOWED, headers: CORS_HEADERS });
    }
    const target = upstreamUrl(new URL(request.url).pathname);
    if (target === undefined) {
      return new Response('Not found: only /v2/point/<lat>/<lon>/<radius in nm, at most 250> is relayed', { status: HTTP_NOT_FOUND, headers: CORS_HEADERS });
    }
    const upstream = await fetch(target, { cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS } });
    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json');
    headers.set('Cache-Control', `public, max-age=${String(CACHE_SECONDS)}`);

    return new Response(upstream.body, { status: upstream.status, headers });
  },
} satisfies ExportedHandler;
