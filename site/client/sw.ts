import { SKIP_WAITING_MESSAGE, type Precache } from './sw-protocol';
import { TILE_HOST } from './tiles';

export {};
declare const self: ServiceWorkerGlobalScope;

/** Name of the cache holding map tiles. It is not versioned: tiles outlive builds, so activation must not delete it. */
const TILE_CACHE = 'map-tiles';

/** Upper bound on stored tiles, so the passive tile cache cannot grow without limit. */
const TILE_CACHE_MAX_ENTRIES = 400;

/** Replaced with the build's manifest by esbuild's `define`, so this script's bytes change with every content change. */
declare const PRECACHE: Precache;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE.version).then(async (cache) => {
      await cache.addAll(PRECACHE.urls.map((url) => new Request(url, { cache: 'reload' })));
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== PRECACHE.version && name !== TILE_CACHE).map(async (name) => caches.delete(name)));
      await self.clients.claim();
    })(),
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
        await (await caches.open(PRECACHE.version)).put(request, response.clone());
      }

      return response;
    })(),
  );
});
