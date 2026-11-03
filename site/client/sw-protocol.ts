/** Message the page sends a waiting service worker to make it take over. */
export const SKIP_WAITING_MESSAGE = 'SKIP_WAITING';

/** The files the service worker stores up front and the version that names their cache. */
export interface Precache {
  readonly version: string;
  readonly urls: readonly string[];
}
