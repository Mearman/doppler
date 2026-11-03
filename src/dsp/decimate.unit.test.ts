import { describe, expect, it } from 'vitest';
import { ANALYSIS_SAMPLE_RATE_HZ } from './constants';
import { decimateAudioStream } from './decimate';

/** Sample rate in Hz of the source audio, a common recording rate. */
const SOURCE_RATE_HZ = 48_000;

/** Whole number of input samples consumed per output sample. */
const DECIMATION_RATIO = SOURCE_RATE_HZ / ANALYSIS_SAMPLE_RATE_HZ;

/** Length in seconds of the short tone used to check the output length. */
const SHORT_TONE_SEC = 0.1;

/** Length in seconds of the tones used to measure steady-state gain, long enough to outlast the filter's start-up transient. */
const LONG_TONE_SEC = 2;

/** Frequency in Hz of the low-frequency test tone. */
const LOW_TONE_HZ = 100;

/** Frequency in Hz of a tone inside the analysis band. */
const IN_BAND_TONE_HZ = 300;

/** Frequencies in Hz of tones above the output Nyquist limit that would fold into the analysis band. */
const FOLDING_TONE_LOW_HZ = 1500;
const FOLDING_TONE_MID_HZ = 1700;
const FOLDING_TONE_HIGH_HZ = 1900;

/** Decibel factor that converts an amplitude ratio to dB. */
const AMPLITUDE_DB_FACTOR = 20;

/** Greatest level in dB that folded content may keep relative to a full-level tone. */
const MAX_FOLDED_LEVEL_DB = -50;

/** Length in samples of the buffers passed to the argument checks. */
const CHECK_BUFFER_SAMPLES = 10;

describe('decimateAudioStream', () => {
  it('decimates 48000 Hz to 2000 Hz while preserving low-frequency content', () => {
    const numSamples = Math.floor(SOURCE_RATE_HZ * SHORT_TONE_SEC);
    const input = new Float32Array(numSamples);

    // 100 Hz test tone
    for (let i = 0; i < numSamples; i += 1) {
      input[i] = Math.sin((2 * Math.PI * LOW_TONE_HZ * i) / SOURCE_RATE_HZ);
    }

    const output = decimateAudioStream(input, SOURCE_RATE_HZ, ANALYSIS_SAMPLE_RATE_HZ);
    expect(output.sampleRateHz).toBe(ANALYSIS_SAMPLE_RATE_HZ);
    expect(output.samples.length).toBe(Math.floor(numSamples / DECIMATION_RATIO));
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
    const output = decimateAudioStream(tone(IN_BAND_TONE_HZ, SOURCE_RATE_HZ, LONG_TONE_SEC), SOURCE_RATE_HZ, ANALYSIS_SAMPLE_RATE_HZ);

    expect(settledRms(output.samples)).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it.each([FOLDING_TONE_LOW_HZ, FOLDING_TONE_MID_HZ, FOLDING_TONE_HIGH_HZ])('removes %i Hz content that would fold into the 65 to 500 Hz band', (hz) => {
    const output = decimateAudioStream(tone(hz, SOURCE_RATE_HZ, LONG_TONE_SEC), SOURCE_RATE_HZ, ANALYSIS_SAMPLE_RATE_HZ);
    const attenuationDb = AMPLITUDE_DB_FACTOR * Math.log10(settledRms(output.samples) / Math.SQRT1_2);

    // The recordings this analyses have a signal-to-noise ratio of tens of decibels, so folded content must sit well below that: the previous 97-tap filter left 1500 Hz only 23 dB down.
    expect(attenuationDb).toBeLessThan(MAX_FOLDED_LEVEL_DB);
  });

  it('rejects a non-positive sample rate instead of dividing by it', () => {
    expect(() => decimateAudioStream(new Float32Array(CHECK_BUFFER_SAMPLES), 0, ANALYSIS_SAMPLE_RATE_HZ)).toThrow('positive');
    expect(() => decimateAudioStream(new Float32Array(CHECK_BUFFER_SAMPLES), SOURCE_RATE_HZ, 0)).toThrow('positive');
  });
});
