import { describe, expect, it } from 'vitest';
import { describeDataset, emptyDataset } from './dataset';
import { DopplerDatasetSchema } from './schemas';
import { SYNTHETIC_DATASET } from './test-support/synthetic-reference';

describe('emptyDataset', () => {
  it('is a valid dataset holding no flights', () => {
    const dataset = DopplerDatasetSchema.parse(emptyDataset());

    expect(dataset.segments).toHaveLength(0);
    expect(dataset.constellations).toHaveLength(0);
  });
});

describe('describeDataset', () => {
  it('reports the version, generation time and segment count', () => {
    expect(describeDataset(SYNTHETIC_DATASET)).toEqual({
      version: SYNTHETIC_DATASET.version,
      generatedAtIso: SYNTHETIC_DATASET.generatedAtIso,
      segmentCount: SYNTHETIC_DATASET.segments.length,
    });
  });
});
