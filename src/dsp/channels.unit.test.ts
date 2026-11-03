import { describe, expect, it } from 'vitest';
import { downmixToMono } from './channels';

describe('downmixToMono', () => {
  it('averages the channels sample by sample', () => {
    const mono = downmixToMono([new Float32Array([1, 0, -1]), new Float32Array([0, 0.5, 1])]);

    expect([...mono]).toEqual([0.5, 0.25, 0]);
  });

  it('copies a single channel instead of aliasing it', () => {
    const channel = new Float32Array([0.25, -0.5]);
    const mono = downmixToMono([channel]);

    expect(mono).not.toBe(channel);
    expect([...mono]).toEqual([0.25, -0.5]);
  });

  it('rejects no channels and channels of unequal length', () => {
    expect(() => downmixToMono([])).toThrow('at least one channel');
    expect(() => downmixToMono([new Float32Array(2), new Float32Array(3)])).toThrow('equal length');
  });
});
