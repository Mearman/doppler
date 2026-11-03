import { describe, expect, it } from 'vitest';
import { downmixToMono } from './channels';

/** Sample amplitudes as fractions of full scale. */
const HALF_SCALE = 0.5;
const QUARTER_SCALE = 0.25;

/** A channel length that differs from the two-sample channels it is paired with. */
const MISMATCHED_LENGTH = 3;

describe('downmixToMono', () => {
  it('averages the channels sample by sample', () => {
    const mono = downmixToMono([new Float32Array([1, 0, -1]), new Float32Array([0, HALF_SCALE, 1])]);

    expect([...mono]).toEqual([HALF_SCALE, QUARTER_SCALE, 0]);
  });

  it('copies a single channel instead of aliasing it', () => {
    const channel = new Float32Array([QUARTER_SCALE, -HALF_SCALE]);
    const mono = downmixToMono([channel]);

    expect(mono).not.toBe(channel);
    expect([...mono]).toEqual([QUARTER_SCALE, -HALF_SCALE]);
  });

  it('rejects no channels and channels of unequal length', () => {
    expect(() => downmixToMono([])).toThrow('at least one channel');
    expect(() => downmixToMono([new Float32Array(2), new Float32Array(MISMATCHED_LENGTH)])).toThrow('equal length');
  });
});
