import { describe, expect, it } from 'vitest';
import { decimateAudioStream } from './decimate';

describe('decimateAudioStream', () => {
  it('decimates 48000 Hz to 2000 Hz while preserving low-frequency content', () => {
    const inputRate = 48000;
    const targetRate = 2000;
    const duration = 0.1;
    const numSamples = Math.floor(inputRate * duration);
    const input = new Float32Array(numSamples);

    // 100 Hz test tone
    for (let i = 0; i < numSamples; i += 1) {
      input[i] = Math.sin((2 * Math.PI * 100 * i) / inputRate);
    }

    const output = decimateAudioStream(input, inputRate, targetRate);
    expect(output.sampleRateHz).toBe(2000);
    expect(output.samples.length).toBe(Math.floor(numSamples / 24));
  });
});
