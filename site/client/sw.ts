import { SKIP_WAITING_MESSAGE } from './sw-protocol';
import { TILE_HOST } from './tiles';

export {};
declare const self: ServiceWorkerGlobalScope;

/** Name of the cache holding map tiles. It is not versioned: tiles outlive builds, so activation must not delete it. */
const TILE_CACHE = 'map-tiles';

/** Upper bound on stored tiles, so the passive tile cache cannot grow without limit. */
const TILE_CACHE_MAX_ENTRIES = 400;

interface Precache {
  readonly version: string;
  readonly urls: readonly string[];
}

function isPrecache(value: unknown): value is Precache {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string' &&
    'urls' in value &&
    Array.isArray(value.urls) &&
    value.urls.every((url) => typeof url === 'string')
  );
}

async function precache(): Promise<Precache> {
  const response = await fetch('precache.json', { cache: 'no-store' });
  const parsed: unknown = await response.json();
  if (!isPrecache(parsed)) {
    throw new Error('precache.json is not a precache manifest');
  }

  return parsed;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precache().then(async ({ version, urls }) => {
      const cache = await caches.open(version);
      await cache.addAll(urls.map((url) => new Request(url, { cache: 'reload' })));
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    precache().then(async ({ version }) => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== version && name !== TILE_CACHE).map(async (name) => caches.delete(name)));
      await self.clients.claim();
    }),
  );
});

self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (typeof data === 'object' && data !== null && 'type' in data && data.type === SKIP_WAITING_MESSAGE) {
    void self.skipWaiting();
  }
});

/**
 * Serves a map tile from the network and keeps a bounded copy, falling back to the stored copy when the network fails.
 * @param request - The tile request. It must be CORS-enabled, because an opaque response cannot be inspected and is padded heavily in storage quotas.
 * @returns The tile response.
 */
async function tileResponse(request: Request): Promise<Response> {
  const cache = await caches.open(TILE_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      const keys = await cache.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - TILE_CACHE_MAX_ENTRIES)).map(async (key) => cache.delete(key)));
    }

    return response;
  } catch (error: unknown) {
    const stored = await cache.match(request);
    if (stored !== undefined) {
      return stored;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.hostname === TILE_HOST) {
    event.respondWith(tileResponse(request));

    return;
  }
  if (url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached !== undefined) {
        return cached;
      }
      const response = await fetch(request);
      if (response.ok) {
        const { version } = await precache();
        await (await caches.open(version)).put(request, response.clone());
      }

      return response;
    })(),
  );
});
