import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { SYNTHETIC_DATASET } from '../test-support/synthetic-reference';
import { clearDataset, loadDataset, saveDataset } from './dataset-store';

describe('dataset store', () => {
  it('returns nothing before a dataset is saved', async () => {
    await clearDataset();

    expect(await loadDataset()).toBeUndefined();
  });

  it('round-trips a dataset and replaces it on the next save', async () => {
    await saveDataset(SYNTHETIC_DATASET);
    expect((await loadDataset())?.segments).toHaveLength(SYNTHETIC_DATASET.segments.length);

    await saveDataset({ ...SYNTHETIC_DATASET, version: 'second', segments: [] });
    const second = await loadDataset();

    expect(second?.version).toBe('second');
    expect(second?.segments).toHaveLength(0);
  });

  it('treats a stored value that is not a dataset as absent', async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('doppler', 1);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('open failed'));
      };
    });
    await new Promise<void>((resolve, reject) => {
      const put = database.transaction('datasets', 'readwrite').objectStore('datasets').put({ version: 'x' }, 'flight-data');
      put.onsuccess = () => {
        resolve();
      };
      put.onerror = () => {
        reject(put.error ?? new Error('put failed'));
      };
    });
    database.close();

    expect(await loadDataset()).toBeUndefined();
  });

  it('removes the stored dataset', async () => {
    await saveDataset(SYNTHETIC_DATASET);
    await clearDataset();

    expect(await loadDataset()).toBeUndefined();
  });
});
