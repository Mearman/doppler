import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_DATASET } from '../bundled';
import type { DopplerDataset, LocationSession } from '../schemas';
import { DopplerSessionEngine } from '../solver/session';
import {
  deleteSessionFromStorage,
  exportSessionJson,
  importSessionJson,
  loadCustomDataset,
  loadSessionById,
  loadSessionsFromStorage,
  saveCustomDataset,
  saveSessionToStorage,
} from './storage';

/** Epoch seconds of 2023-11-14T22:13:20Z, an arbitrary fixed episode start. */
const EPISODE_START_EPOCH_SEC = 1700000000;

describe('Browser Storage and Session Serialization', () => {
  let memoryStore: Record<string, string> = {};

  beforeEach(() => {
    memoryStore = {};
    const mockStorage = {
      getItem: (key: string): string | null => memoryStore[key] ?? null,
      setItem: (key: string, value: string): void => {
        memoryStore[key] = value;
      },
      removeItem: (key: string): void => {
        Reflect.deleteProperty(memoryStore, key);
      },
      clear: (): void => {
        memoryStore = {};
      },
      length: 0,
      key: () => null,
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    memoryStore = {};
  });

  const getValidTestSession = (): LocationSession => {
    const engine = new DopplerSessionEngine({
      dataset: BUNDLED_DATASET,
      ambientTempCelsius: 20.0,
    });
    engine.startEpisode(EPISODE_START_EPOCH_SEC);

    return engine.getSession();
  };

  it('saves, loads, and retrieves sessions by ID', () => {
    expect(loadSessionsFromStorage()).toEqual([]);
    expect(loadSessionById('test_session_1')).toBeUndefined();

    const mockSession = getValidTestSession();
    saveSessionToStorage(mockSession);

    const loaded = loadSessionsFromStorage();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe(mockSession.id);

    const byId = loadSessionById(mockSession.id);
    expect(byId?.id).toBe(mockSession.id);
  });

  it('deletes sessions by ID', () => {
    const mockSession = getValidTestSession();
    saveSessionToStorage(mockSession);
    expect(loadSessionsFromStorage()).toHaveLength(1);

    deleteSessionFromStorage(mockSession.id);
    expect(loadSessionsFromStorage()).toHaveLength(0);
    expect(loadSessionById(mockSession.id)).toBeUndefined();
  });

  it('saves and loads custom datasets', () => {
    expect(loadCustomDataset()).toBeNull();

    const mockDataset: DopplerDataset = {
      version: '1.0.0',
      generatedAtIso: '2026-03-31T12:00:00Z',
      segments: [],
      constellations: [],
      elevationGrid: [],
    };

    saveCustomDataset(mockDataset);
    const loaded = loadCustomDataset();
    expect(loaded?.version).toBe('1.0.0');
  });

  it('exports and imports sessions cleanly as JSON', () => {
    const mockSession = getValidTestSession();
    const jsonStr = exportSessionJson(mockSession);
    expect(jsonStr).toContain(mockSession.id);

    const imported = importSessionJson(jsonStr);
    expect(imported.id).toBe(mockSession.id);
    expect(imported.episodes[0]?.status).toBe('active');
  });

  it('treats stored values that are not valid sessions or datasets as absent', () => {
    localStorage.setItem('doppler_sessions_v1', JSON.stringify([{ id: 'not-a-session' }]));
    localStorage.setItem('doppler_custom_dataset_v1', JSON.stringify({ version: '1.0.0' }));

    expect(loadSessionsFromStorage()).toEqual([]);
    expect(loadCustomDataset()).toBeNull();
  });

  it('rejects an imported session that does not match the schema', () => {
    expect(() => importSessionJson(JSON.stringify({ id: 'not-a-session' }))).toThrow();
  });
});
