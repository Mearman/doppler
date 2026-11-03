import { type DopplerDataset, DopplerDatasetSchema } from '../schemas';

const DATABASE_NAME = 'doppler';
const STORE_NAME = 'datasets';
const DATASET_KEY = 'flight-data';
const DATABASE_VERSION = 1;

/**
 * Wraps an IndexedDB request in a promise.
 * @param request - The request to wait for.
 * @returns The request's result, or a rejection with its error.
 */
async function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => {
      resolve(request.result);
    });
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    });
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener('upgradeneeded', () => {
    request.result.createObjectStore(STORE_NAME);
  });

  return settle(request);
}

/**
 * Runs one operation against the dataset store and closes the connection afterwards.
 * @param mode - Whether the operation writes.
 * @param operation - Receives the object store and returns the request to wait for.
 * @returns The request's result.
 */
async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await settle(operation(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
  } finally {
    database.close();
  }
}

/**
 * Stores the flight dataset in IndexedDB, which holds a structured clone and so has no string-length ceiling, unlike `localStorage`.
 * @param dataset - A validated dataset; it replaces any stored one.
 * @returns Resolves once the write is committed; rejects when storage is full or unavailable.
 */
export async function saveDataset(dataset: Readonly<DopplerDataset>): Promise<void> {
  await withStore('readwrite', (store) => store.put(dataset, DATASET_KEY));
}

/**
 * Reads the stored flight dataset.
 * @returns The dataset, or undefined when none is stored or the stored value no longer matches the schema.
 */
export async function loadDataset(): Promise<DopplerDataset | undefined> {
  const stored: unknown = await withStore('readonly', (store) => store.get(DATASET_KEY));
  const parsed = DopplerDatasetSchema.safeParse(stored);

  return parsed.success ? parsed.data : undefined;
}

/**
 * Removes the stored flight dataset.
 * @returns Resolves once the removal is committed.
 */
export async function clearDataset(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(DATASET_KEY));
}
