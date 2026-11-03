/**
 * One full turn in radians (a complete circle, 2 pi): the phase span of the twiddle factors of a transform and of the Hann window.
 */
const FULL_TURN_RADIANS = 2 * Math.PI;

/**
 * Hann window coefficient scale: the window is `0.5 * (1 - cos(2 pi i / (N - 1)))`, a raised cosine that tapers both ends of the frame to zero.
 */
const HANN_SCALE = 0.5;

/**
 * Smallest squared magnitude passed to the logarithm, so that an all-zero bin reports -200 dB instead of negative infinity. Squared magnitude is a power, so the floor is 10 * log10(1e-20) = -200 dB.
 */
const POWER_FLOOR = 1e-20;

/**
 * Decibels per decade of a power ratio: `10 * log10(power)`.
 */
const DB_PER_POWER_DECADE = 10;

/**
 * A complex sequence stored as separate real and imaginary component arrays of equal length.
 */
export interface ComplexSpectrum {
  readonly real: Float64Array;
  readonly imag: Float64Array;
}

/**
 * Computes a Radix-2 Cooley-Tukey Complex Fast Fourier Transform without modifying its inputs: the samples are gathered into freshly allocated arrays in bit-reversed order and the butterflies run on those arrays.
 * @param real - Real components array of power-of-two length N.
 * @param imag - Imaginary components array of the same length N.
 * @returns The forward transform (negative-exponent convention, unnormalised) as new arrays.
 * @throws When N is not a positive power of two or the two arrays differ in length.
 */
export function fft(real: Readonly<Float64Array>, imag: Readonly<Float64Array>): ComplexSpectrum {
  const n = real.length;
  if (n === 0 || (n & (n - 1)) !== 0 || imag.length !== n) {
    throw new Error(`FFT length must be a positive power of two with matching real/imag lengths, got ${String(n)}`);
  }

  const outReal = new Float64Array(n);
  const outImag = new Float64Array(n);

  // j walks the bit-reversal of i, so output slot i receives the input sample at index j.
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    outReal[i] = real[j] ?? 0;
    outImag[i] = imag[j] ?? 0;
    let bit = n >> 1;
    while (bit >= 1 && (j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j |= bit;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angleStep = -FULL_TURN_RADIANS / len;
    const wStepR = Math.cos(angleStep);
    const wStepI = Math.sin(angleStep);

    for (let i = 0; i < n; i += len) {
      let wR = 1.0;
      let wI = 0.0;
      for (let k = 0; k < halfLen; k += 1) {
        const evenIdx = i + k;
        const oddIdx = evenIdx + halfLen;
        const oddR = outReal[oddIdx] ?? 0;
        const oddI = outImag[oddIdx] ?? 0;

        const tR = wR * oddR - wI * oddI;
        const tI = wR * oddI + wI * oddR;

        const evenR = outReal[evenIdx] ?? 0;
        const evenI = outImag[evenIdx] ?? 0;

        outReal[oddIdx] = evenR - tR;
        outImag[oddIdx] = evenI - tI;
        outReal[evenIdx] = evenR + tR;
        outImag[evenIdx] = evenI + tI;

        const nextWR = wR * wStepR - wI * wStepI;
        wI = wR * wStepI + wI * wStepR;
        wR = nextWR;
      }
    }
  }

  return { real: outReal, imag: outImag };
}

/**
 * Computes the one-sided Hann-windowed power spectrum in decibels for a real-valued frame.
 * @param samples - Input time-domain samples.
 * @param fftSize - Power-of-two FFT size (zero-padded if `samples.length < fftSize`).
 * @returns One-sided power spectrum in dB (`length = fftSize / 2 + 1`).
 */
export function computeHannPowerSpectrumDb(samples: Readonly<Float32Array>, fftSize: number): Float64Array {
  const windowed = new Float64Array(fftSize);
  const winLen = Math.min(samples.length, fftSize);

  for (let i = 0; i < winLen; i += 1) {
    const hann = HANN_SCALE * (1 - Math.cos((FULL_TURN_RADIANS * i) / Math.max(1, winLen - 1)));
    windowed[i] = (samples[i] ?? 0) * hann;
  }

  const { real, imag } = fft(windowed, new Float64Array(fftSize));

  const numBins = (fftSize >> 1) + 1;
  const powerDb = new Float64Array(numBins);
  const norm = 1 / Math.max(1, winLen);

  for (let bin = 0; bin < numBins; bin += 1) {
    const r = (real[bin] ?? 0) * norm;
    const im = (imag[bin] ?? 0) * norm;
    const magSq = Math.max(POWER_FLOOR, r * r + im * im);
    powerDb[bin] = DB_PER_POWER_DECADE * Math.log10(magSq);
  }

  return powerDb;
}
