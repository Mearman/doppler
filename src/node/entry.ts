import { readFileSync, writeFileSync } from 'node:fs';
import { decodeWavBytes, encodeWavPcm16 } from '../dsp/wav';

export * from '../index';
export * from './adsb-archive';
export * from './stream-adsb';
export * from './tar-stream';

/**
 * Reads and decodes a WAV audio file from disk into mono `Float32Array` samples and sample rate.
 * @param filePath - Path to `.wav` file.
 * @returns Decoded mono audio samples and sample rate in Hz.
 */
export function readWavFile(filePath: string): { readonly samples: Float32Array; readonly sampleRateHz: number } {
  const bytes = new Uint8Array(readFileSync(filePath));

  return decodeWavBytes(bytes);
}

/**
 * Encodes and writes a mono `Float32Array` audio buffer to disk as a 16-bit PCM WAV file.
 * @param filePath - Output path.
 * @param samples - Audio samples in range `[-1, 1]`.
 * @param sampleRateHz - Audio sample rate in Hz.
 */
export function writeWavFile(filePath: string, samples: Readonly<Float32Array>, sampleRateHz: number): void {
  const bytes = encodeWavPcm16(samples, sampleRateHz);
  writeFileSync(filePath, bytes);
}
