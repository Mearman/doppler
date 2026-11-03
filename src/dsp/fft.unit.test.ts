import { describe, expect, it } from 'vitest';
import { computeHannPowerSpectrumDb, fft } from './fft';

/** Transform length of the reference comparisons: a power of two large enough to exercise several butterfly stages. */
const SIZE = 16;

/** Allowed absolute difference between the fast transform and the direct sum of the same length: a few double-precision roundings per output. */
const TOLERANCE = 1e-12;

/** Spectral bin that carries the test tone, an integer so the tone has no leakage. */
const TONE_BIN = 3;

/** Power spectrum floor in dB reported for an all-zero frame: 10 * log10(1e-20). */
const SILENCE_FLOOR_DB = -200;

/** One full turn in radians, the phase span of the direct transform's complex exponential. */
const FULL_TURN_RADIANS = 2 * Math.PI;

/** Real part of the single-sample transform test value. */
const SAMPLE_REAL = 2.5;

/** Imaginary part of the single-sample transform test value. */
const SAMPLE_IMAG = -1.5;

/** A deterministic, non-symmetric complex test sequence. */
const sequence = (length: number): { readonly real: Float64Array; readonly imag: Float64Array } => ({
  real: Float64Array.from({ length }, (_, i) => Math.sin(i * i + 1)),
  imag: Float64Array.from({ length }, (_, i) => Math.cos(i + 2)),
});

describe('fft', () => {
  it('matches the direct discrete Fourier transform', () => {
    const { real, imag } = sequence(SIZE);
    const out = fft(real, imag);

    for (let bin = 0; bin < SIZE; bin += 1) {
      let sumR = 0;
      let sumI = 0;
      for (let t = 0; t < SIZE; t += 1) {
        const angle = (-FULL_TURN_RADIANS * bin * t) / SIZE;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        sumR += (real[t] ?? 0) * cos - (imag[t] ?? 0) * sin;
        sumI += (real[t] ?? 0) * sin + (imag[t] ?? 0) * cos;
      }

      expect(Math.abs((out.real[bin] ?? 0) - sumR)).toBeLessThan(TOLERANCE);
      expect(Math.abs((out.imag[bin] ?? 0) - sumI)).toBeLessThan(TOLERANCE);
    }
  });

  it('leaves its inputs untouched and returns new arrays', () => {
    const { real, imag } = sequence(SIZE);
    const realBefore = Float64Array.from(real);
    const imagBefore = Float64Array.from(imag);
    const out = fft(real, imag);

    expect(real).toEqual(realBefore);
    expect(imag).toEqual(imagBefore);
    expect(out.real).not.toBe(real);
    expect(out.imag).not.toBe(imag);
  });

  it('transforms a single sample to itself', () => {
    const out = fft(Float64Array.of(SAMPLE_REAL), Float64Array.of(SAMPLE_IMAG));

    expect(out.real).toEqual(Float64Array.of(SAMPLE_REAL));
    expect(out.imag).toEqual(Float64Array.of(SAMPLE_IMAG));
  });

  it('rejects empty, non power-of-two and mismatched inputs', () => {
    expect(() => fft(new Float64Array(0), new Float64Array(0))).toThrow('power of two');
    expect(() => fft(new Float64Array(SIZE - 1), new Float64Array(SIZE - 1))).toThrow('power of two');
    expect(() => fft(new Float64Array(SIZE), new Float64Array(SIZE / 2))).toThrow('matching real/imag lengths');
  });
});

describe('computeHannPowerSpectrumDb', () => {
  it('returns a one-sided spectrum of fftSize / 2 + 1 bins', () => {
    expect(computeHannPowerSpectrumDb(new Float32Array(SIZE), SIZE)).toHaveLength(SIZE / 2 + 1);
  });

  it('peaks at the bin of a pure tone', () => {
    const samples = Float32Array.from({ length: SIZE }, (_, i) => Math.sin((FULL_TURN_RADIANS * TONE_BIN * i) / SIZE));
    const spectrum = computeHannPowerSpectrumDb(samples, SIZE);
    const peak = spectrum.indexOf(Math.max(...spectrum));

    expect(peak).toBe(TONE_BIN);
  });

  it('floors an all-zero frame at the power floor', () => {
    const spectrum = computeHannPowerSpectrumDb(new Float32Array(SIZE), SIZE);

    expect(spectrum.every((value) => value === SILENCE_FLOOR_DB)).toBe(true);
  });

  it('zero-pads a frame shorter than the transform', () => {
    const spectrum = computeHannPowerSpectrumDb(Float32Array.of(1, 1, 1, 1), SIZE);

    expect(spectrum).toHaveLength(SIZE / 2 + 1);
    expect(Math.max(...spectrum)).toBeGreaterThan(SILENCE_FLOOR_DB);
  });
});
