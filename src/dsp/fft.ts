/**
 * Computes an in-place Radix-2 Cooley-Tukey Complex Fast Fourier Transform.
 * @param real - Real components array of power-of-two length N (mutated in place).
 * @param imag - Imaginary components array of power-of-two length N (mutated in place).
 */
export function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n === 0 || (n & (n - 1)) !== 0 || imag.length !== n) {
    throw new Error(`FFT length must be a positive power of two with matching real/imag lengths, got ${String(n)}`);
  }

  let j = 0;
  for (let i = 0; i < n; i += 1) {
    if (i < j) {
      const tr = real[i] ?? 0;
      const ti = imag[i] ?? 0;
      real[i] = real[j] ?? 0;
      imag[i] = imag[j] ?? 0;
      real[j] = tr;
      imag[j] = ti;
    }
    let bit = n >> 1;
    while (bit >= 1 && (j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j |= bit;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angleStep = (-2 * Math.PI) / len;
    const wStepR = Math.cos(angleStep);
    const wStepI = Math.sin(angleStep);

    for (let i = 0; i < n; i += len) {
      let wR = 1.0;
      let wI = 0.0;
      for (let k = 0; k < halfLen; k += 1) {
        const evenIdx = i + k;
        const oddIdx = evenIdx + halfLen;
        const oddR = real[oddIdx] ?? 0;
        const oddI = imag[oddIdx] ?? 0;

        const tR = wR * oddR - wI * oddI;
        const tI = wR * oddI + wI * oddR;

        const evenR = real[evenIdx] ?? 0;
        const evenI = imag[evenIdx] ?? 0;

        real[oddIdx] = evenR - tR;
        imag[oddIdx] = evenI - tI;
        real[evenIdx] = evenR + tR;
        imag[evenIdx] = evenI + tI;

        const nextWR = wR * wStepR - wI * wStepI;
        wI = wR * wStepI + wI * wStepR;
        wR = nextWR;
      }
    }
  }
}

/**
 * Computes the one-sided Hann-windowed power spectrum in decibels for a real-valued frame.
 * @param samples - Input time-domain samples.
 * @param fftSize - Power-of-two FFT size (zero-padded if `samples.length < fftSize`).
 * @returns One-sided power spectrum in dB (`length = fftSize / 2 + 1`).
 */
export function computeHannPowerSpectrumDb(samples: Readonly<Float32Array>, fftSize: number): Float64Array {
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  const winLen = Math.min(samples.length, fftSize);

  for (let i = 0; i < winLen; i += 1) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, winLen - 1)));
    real[i] = (samples[i] ?? 0) * hann;
  }

  fftInPlace(real, imag);

  const numBins = (fftSize >> 1) + 1;
  const powerDb = new Float64Array(numBins);
  const norm = 1 / Math.max(1, winLen);

  for (let bin = 0; bin < numBins; bin += 1) {
    const r = (real[bin] ?? 0) * norm;
    const im = (imag[bin] ?? 0) * norm;
    const magSq = Math.max(1e-20, r * r + im * im);
    powerDb[bin] = 10 * Math.log10(magSq);
  }

  return powerDb;
}
