import type { DatasetInfo, DopplerDataset } from './schemas';

/**
 * A dataset with no flights, the state before any real flight data is loaded: flyovers are detected but nothing can be matched to them.
 * @returns A valid, empty dataset.
 */
export function emptyDataset(): DopplerDataset {
  return { version: 'empty', generatedAtIso: new Date(0).toISOString(), segments: [], constellations: [], elevationGrid: [] };
}

/**
 * Summarises a dataset for display.
 * @param dataset - The dataset to describe.
 * @returns Its version, generation time and the number of flight segments.
 */
export function describeDataset(dataset: Readonly<DopplerDataset>): DatasetInfo {
  return { version: dataset.version, generatedAtIso: dataset.generatedAtIso, segmentCount: dataset.segments.length };
}
