/**
 * Designs a normalized Blackman-windowed sinc low-pass FIR filter kernel.
 * @param cutoffHz - Low-pass cutoff frequency in Hz.
 * @param sampleRateHz - Input sample rate in Hz.
 * @param numTaps - Odd number of FIR filter taps.
 * @returns Normalized FIR filter coefficients.
 */
export function designLowPassFirKernel(cutoffHz: number, sampleRateHz: number, numTaps = 97): Float64Array {
  const taps = numTaps % 2 === 1 ? numTaps : numTaps + 1;
  const kernel = new Float64Array(taps);
  const center = (taps - 1) / 2;
  const normalizedCutoff = cutoffHz / sampleRateHz;
  let sum = 0;

  for (let i = 0; i < taps; i += 1) {
    const n = i - center;
    const sinc = n === 0 ? 2 * normalizedCutoff : Math.sin(2 * Math.PI * normalizedCutoff * n) / (Math.PI * n);
    const blackman =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    const coeff = sinc * blackman;
    kernel[i] = coeff;
    sum += coeff;
  }

  if (Math.abs(sum) > 1e-12) {
    for (let i = 0; i < taps; i += 1) {
      kernel[i] = (kernel[i] ?? 0) / sum;
    }
  }

  return kernel;
}

/**
 * Decimates a high-sample-rate audio buffer (e.g. 48,000 Hz) down to a target sub-kilohertz/low-kilohertz rate (e.g. 2,000 Hz) after applying an anti-aliasing FIR low-pass filter.
 * @param input - Input mono audio samples.
 * @param inputRateHz - Original sample rate in Hz (e.g. 48000).
 * @param targetRateHz - Decimated sample rate in Hz (default 2000).
 * @returns Decimated mono audio samples and actual output sample rate.
 */
export function decimateAudioStream(
  input: Readonly<Float32Array>,
  inputRateHz: number,
  targetRateHz = 2000,
): { readonly samples: Float32Array; readonly sampleRateHz: number } {
  if (inputRateHz <= targetRateHz) {
    return { samples: new Float32Array(input), sampleRateHz: inputRateHz };
  }

  const ratio = Math.max(1, Math.round(inputRateHz / targetRateHz));
  const actualRateHz = inputRateHz / ratio;
  const cutoffHz = 0.4 * actualRateHz;
  const kernel = designLowPassFirKernel(cutoffHz, inputRateHz, Math.min(97, ratio * 4 + 1));
  const halfKernel = (kernel.length - 1) >> 1;

  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);

  for (let outIdx = 0; outIdx < outLength; outIdx += 1) {
    const centerInIdx = outIdx * ratio;
    let acc = 0;
    for (let k = 0; k < kernel.length; k += 1) {
      const sampleIdx = centerInIdx + k - halfKernel;
      if (sampleIdx >= 0 && sampleIdx < input.length) {
        acc += (input[sampleIdx] ?? 0) * (kernel[k] ?? 0);
      }
    }
    output[outIdx] = acc;
  }

  return { samples: output, sampleRateHz: actualRateHz };
}
