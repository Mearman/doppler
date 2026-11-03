import { useCallback, useEffect, useState } from 'react';
import { SKIP_WAITING_MESSAGE } from './sw-protocol';

/**
 * How often a page that stays open checks for a new build. The browser checks on navigation only, and an installed app can stay open for days, so without this a long-lived session never learns of a release.
 */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type OfflineSupport = 'preparing' | 'ready' | 'unavailable';

export interface OfflineStatus {
  /** Whether the browser reports a network connection. */
  readonly online: boolean;
  /** `ready` once a service worker is active, which only happens after the whole precache list is stored. */
  readonly support: OfflineSupport;
  /** Whether a newer build is installed and waiting for the page to hand over. */
  readonly updateAvailable: boolean;
  /** Activates the waiting build and reloads the page once it controls it. */
  readonly applyUpdate: () => void;
}

export interface OfflineStatusOptions {
  /** Whether reloading now loses nothing the user is doing. A waiting build is applied automatically while this is true, and offered through `updateAvailable` otherwise. */
  readonly safeToReload: boolean;
}

/**
 * Registers the service worker and tracks what the page can promise about offline use.
 * @param options - When an update may be applied without asking.
 * @returns Connectivity, offline-readiness and update state.
 */
export function useOfflineStatus(options: Readonly<OfflineStatusOptions>): OfflineStatus {
  const [online, setOnline] = useState(navigator.onLine);
  const [support, setSupport] = useState<OfflineSupport>('serviceWorker' in navigator ? 'preparing' : 'unavailable');
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    const goOnline = (): void => {
      setOnline(true);
    };
    const goOffline = (): void => {
      setOnline(false);
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return undefined;
    }
    const { serviceWorker } = navigator;
    let stopChecking: (() => void) | undefined;
    // `updateViaCache: 'none'` makes the script check bypass the HTTP cache, so a release is seen as soon as it is deployed rather than after a cache lifetime the host chose.
    serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(
      (registration) => {
        const check = (): void => {
          registration.update().catch(() => {
            // Offline or the host is unreachable: the next trigger retries.
          });
        };
        const onVisible = (): void => {
          if (document.visibilityState === 'visible') {
            check();
          }
        };
        const timer = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('online', check);
        stopChecking = () => {
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
          window.removeEventListener('online', check);
        };
        if (registration.waiting !== null) {
          setWaiting(registration.waiting);
        }
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            // With no controller this is the first install, which activates by itself.
            if (installing.state === 'installed' && serviceWorker.controller !== null) {
              setWaiting(installing);
            }
          });
        });
      },
      () => {
        setSupport('unavailable');
      },
    );
    void serviceWorker.ready.then(() => {
      setSupport('ready');
    });

    return () => {
      stopChecking?.();
    };
  }, []);

  const applyUpdate = useCallback((): void => {
    if (waiting === null) {
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    }, { once: true });
    waiting.postMessage({ type: SKIP_WAITING_MESSAGE });
  }, [waiting]);

  const { safeToReload } = options;
  useEffect(() => {
    if (waiting !== null && safeToReload) {
      applyUpdate();
    }
  }, [waiting, safeToReload, applyUpdate]);

  return { online, support, updateAvailable: waiting !== null, applyUpdate };
}
