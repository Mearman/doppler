import { afterEach, describe, expect, it, vi } from 'vitest';
import { locateDevice } from './locate';

describe('locateDevice', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves with the device position', async () => {
    vi.stubGlobal('navigator', {
      geolocation: { getCurrentPosition: (ok: (position: { coords: { latitude: number; longitude: number } }) => void) => { ok({ coords: { latitude: 51.5, longitude: -0.1 } }); } },
    });

    await expect(locateDevice()).resolves.toEqual({ lat: 51.5, lon: -0.1 });
  });

  it('rejects with the browser reason when the person declines', async () => {
    vi.stubGlobal('navigator', {
      geolocation: { getCurrentPosition: (_ok: unknown, fail: (error: Readonly<{ message: string }>) => void) => { fail({ message: 'User denied Geolocation' }); } },
    });

    await expect(locateDevice()).rejects.toThrow('User denied Geolocation');
  });

  it('rejects when the browser has no location service', async () => {
    vi.stubGlobal('navigator', {});

    await expect(locateDevice()).rejects.toThrow('no location service');
  });
});
