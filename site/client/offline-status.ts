import { useCallback, useEffect, useState } from 'react';
import { SKIP_WAITING_MESSAGE } from './sw-protocol';

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

/**
 * Registers the service worker and tracks what the page can promise about offline use.
 * @returns Connectivity, offline-readiness and update state.
 */
export function useOfflineStatus(): OfflineStatus {
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
      return;
    }
    const { serviceWorker } = navigator;
    serviceWorker.register('sw.js').then(
      (registration) => {
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

  return { online, support, updateAvailable: waiting !== null, applyUpdate };
}
