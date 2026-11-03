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

  /** Root-mean-square of the output after the filter's start-up transient. */
  const settledRms = (samples: Readonly<Float32Array>): number => {
    const tail = samples.subarray(samples.length >> 1);
    let sum = 0;
    for (const value of tail) {
      sum += value * value;
    }

    return Math.sqrt(sum / tail.length);
  };

  const tone = (hz: number, rateHz: number, seconds: number): Float32Array =>
    Float32Array.from({ length: Math.floor(rateHz * seconds) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rateHz));

  it('keeps a tone inside the analysis band at full level', () => {
    const output = decimateAudioStream(tone(300, 48000, 2), 48000, 2000);

    expect(settledRms(output.samples)).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it.each([1500, 1700, 1900])('removes %i Hz content that would fold into the 65 to 500 Hz band', (hz) => {
    const output = decimateAudioStream(tone(hz, 48000, 2), 48000, 2000);
    const attenuationDb = 20 * Math.log10(settledRms(output.samples) / Math.SQRT1_2);

    // The recordings this analyses have a signal-to-noise ratio of tens of decibels, so folded content must sit well below that: the previous 97-tap filter left 1500 Hz only 23 dB down.
    expect(attenuationDb).toBeLessThan(-50);
  });

  it('rejects a non-positive sample rate instead of dividing by it', () => {
    expect(() => decimateAudioStream(new Float32Array(10), 0, 2000)).toThrow('positive');
    expect(() => decimateAudioStream(new Float32Array(10), 48000, 0)).toThrow('positive');
  });
});
