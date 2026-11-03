import { describe, expect, it } from 'vitest';
import { ANALYSIS_SAMPLE_RATE_HZ, GRID_50_NOMINAL_HZ } from './constants';
import { detectEnfSignature } from './side-channels';

/** Length in seconds of the synthetic hum recording. */
const RECORDING_DURATION_SEC = 3;

/** Amplitude of the synthetic 50 Hz hum in full-scale sample units. */
const HUM_AMPLITUDE = 0.2;

/** Amplitude of the uniform noise added to the hum, in full-scale sample units. */
const NOISE_AMPLITUDE = 0.01;

/** Offset that centres `Math.random()` on zero. */
const RANDOM_CENTRE = 0.5;

/** SNR in dB that a clearly present hum must exceed. */
const MIN_HUM_SNR_DB = 10;

describe('side-channels', () => {
  it('detects 50 Hz European ENF hum', () => {
    const n = Math.floor(ANALYSIS_SAMPLE_RATE_HZ * RECORDING_DURATION_SEC);
    const audio = new Float32Array(n);

    // Add 50 Hz tone with noise
    for (let i = 0; i < n; i += 1) {
      audio[i] =
        HUM_AMPLITUDE * Math.sin((2 * Math.PI * GRID_50_NOMINAL_HZ * i) / ANALYSIS_SAMPLE_RATE_HZ) +
        NOISE_AMPLITUDE * (Math.random() - RANDOM_CENTRE);
    }

    const enf = detectEnfSignature(audio, ANALYSIS_SAMPLE_RATE_HZ);
    expect(enf.detected).toBe(true);
    expect(enf.nominalHz).toBe('50');
    expect(enf.snrDb).toBeGreaterThan(MIN_HUM_SNR_DB);
  });
});
