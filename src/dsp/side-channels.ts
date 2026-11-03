import { synthesizeRetardedDopplerCurve } from '../physics/retarded-time';
import type { EnfSignature, GeoPoint3D, LinearFlightSegment } from '../schemas';
import { computeHannPowerSpectrumDb } from './fft';

/**
 * Detects passive 50.00 Hz vs 60.00 Hz Electrical Network Frequency (ENF) mains hum in an audio buffer to split the global search space by power-grid hemisphere.
 * @param samples - Audio samples.
 * @param sampleRateHz - Sample rate in Hz.
 * @returns Detected ENF nominal grid (50 Hz, 60 Hz, or unknown), SNR, and geographic region hint.
 */
export function detectEnfSignature(samples: Readonly<Float32Array>, sampleRateHz: number): EnfSignature {
  let fftSize = 4096;
  while (fftSize * 2 <= samples.length && fftSize < 16384) {
    fftSize <<= 1;
  }
  if (samples.length < 512) {
    return {
      detected: false,
      nominalHz: 'unknown',
      measuredFreqHz: 0,
      snrDb: 0,
      regionHint: 'Insufficient audio length for ENF analysis',
    };
  }

  const spectrumDb = computeHannPowerSpectrumDb(samples, fftSize);
  const binStepHz = sampleRateHz / fftSize;

  const bin50 = Math.round(50 / binStepHz);
  const bin60 = Math.round(60 / binStepHz);

  const power50Db = Math.max(
    spectrumDb[bin50 - 1] ?? -120,
    spectrumDb[bin50] ?? -120,
    spectrumDb[bin50 + 1] ?? -120,
  );
  const power60Db = Math.max(
    spectrumDb[bin60 - 1] ?? -120,
    spectrumDb[bin60] ?? -120,
    spectrumDb[bin60 + 1] ?? -120,
  );

  // Measure surrounding background between 42 Hz and 68 Hz excluding 50 Hz and 60 Hz notches
  const bgValues: number[] = [];
  const startBin = Math.max(1, Math.floor(42 / binStepHz));
  const endBin = Math.min((fftSize >> 1) - 1, Math.ceil(68 / binStepHz));
  for (let b = startBin; b <= endBin; b += 1) {
    const hz = b * binStepHz;
    if (Math.abs(hz - 50) > 1.8 && Math.abs(hz - 60) > 1.8) {
      const val = spectrumDb[b];
      if (val !== undefined) {
        bgValues.push(val);
      }
    }
  }
  bgValues.sort((a, b) => a - b);
  const noiseFloorDb = bgValues.length > 0 ? (bgValues[bgValues.length >> 1] ?? -100) : -100;

  const snr50 = power50Db - noiseFloorDb;
  const snr60 = power60Db - noiseFloorDb;

  if (snr50 >= 6.0 && snr50 > snr60 + 2.0) {
    return {
      detected: true,
      nominalHz: '50',
      measuredFreqHz: 50.0,
      snrDb: snr50,
      regionHint: '50 Hz Grid (Europe, UK, Asia, Africa, Australia, E. Japan)',
    };
  }

  if (snr60 >= 6.0 && snr60 > snr50 + 2.0) {
    return {
      detected: true,
      nominalHz: '60',
      measuredFreqHz: 60.0,
      snrDb: snr60,
      regionHint: '60 Hz Grid (North America, South Korea, Taiwan, W. Japan)',
    };
  }

  return {
    detected: false,
    nominalHz: 'unknown',
    measuredFreqHz: 0,
    snrDb: Math.max(0, snr50, snr60),
    regionHint: 'No dominant 50/60 Hz mains hum detected',
  };
}

/**
 * Estimates ambient air temperature in degrees Celsius from cricket stridulation rate using Dolbear's Law (`T_C = 10 + (N_60 - 40) / 7`).
 * @param chirpsPerMinute - Measured insect stridulation modulation pulses per minute.
 * @returns Estimated ambient temperature in degrees Celsius.
 */
export function estimateTempFromCricketChirpsCelsius(chirpsPerMinute: number): number {
  return 10 + (chirpsPerMinute - 40) / 7;
}

/**
 * Parameters for synthesizing a realistic acoustic recording containing aircraft Doppler flyovers, optional 50/60 Hz ENF hum, and optional transient noise pollution bursts.
 */
export interface SyntheticAudioConfig {
  readonly sampleRateHz: number;
  readonly startEpochSec: number;
  readonly durationSec: number;
  readonly observer: Readonly<GeoPoint3D>;
  readonly flyovers: readonly {
    readonly segment: Readonly<LinearFlightSegment>;
    readonly baseFreqHz: number;
    readonly amplitude: number;
  }[];
  readonly enfNominalHz?: 50 | 60;
  readonly enfAmplitude?: number;
  readonly noiseStd?: number;
  readonly noisePollutionBursts?: readonly {
    readonly startOffsetSec: number;
    readonly endOffsetSec: number;
    readonly burstNoiseStd: number;
  }[];
}

/**
 * Synthesizes a realistic time-domain waveform (continuous phase integration of retarded Doppler frequencies + harmonics + ENF hum + deterministic pseudo-random noise) for testing, simulation, and verification.
 * @param config - Simulation configuration.
 * @returns Synthesized mono `Float32Array` audio buffer.
 */
export function synthesizeMultiFlyoverAudio(config: Readonly<SyntheticAudioConfig>): Float32Array {
  const numSamples = Math.floor(config.durationSec * config.sampleRateHz);
  const output = new Float32Array(numSamples);
  const dt = 1 / config.sampleRateHz;

  // Deterministic LCG PRNG for reproducible tests
  let seed = 133742;
  const nextGaussian = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const u1 = Math.max(1e-7, seed / 0xffffffff);
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const u2 = seed / 0xffffffff;

    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  // Add background noise, ENF mains hum, and optional noise-pollution bursts
  const baseNoiseStd = config.noiseStd ?? 0.005;
  const enfAmp = config.enfAmplitude ?? 0;
  const enfHz = config.enfNominalHz;

  for (let i = 0; i < numSamples; i += 1) {
    const tOffset = i * dt;
    let currentNoiseStd = baseNoiseStd;
    if (config.noisePollutionBursts !== undefined) {
      for (const burst of config.noisePollutionBursts) {
        if (tOffset >= burst.startOffsetSec && tOffset <= burst.endOffsetSec) {
          currentNoiseStd = Math.max(currentNoiseStd, burst.burstNoiseStd);
        }
      }
    }
    let sample = nextGaussian() * currentNoiseStd;
    if (enfHz !== undefined && enfAmp > 0) {
      sample += enfAmp * Math.sin(2 * Math.PI * enfHz * tOffset);
    }
    output[i] = sample;
  }

  // Synthesize each aircraft flyover with continuous phase accumulation
  for (const flyover of config.flyovers) {
    let phase = 0;
    // Evaluate retarded Doppler frequency every 0.1 seconds and linearly interpolate across samples
    const stepSec = 0.1;
    const numGrid = Math.ceil(config.durationSec / stepSec) + 1;
    const gridTimes: number[] = [];
    for (let k = 0; k < numGrid; k += 1) {
      gridTimes.push(config.startEpochSec + k * stepSec);
    }
    const curve = synthesizeRetardedDopplerCurve(config.observer, flyover.segment, {
      baseFreqHz: flyover.baseFreqHz,
      obsEpochTimesSec: gridTimes,
    });

    for (let i = 0; i < numSamples; i += 1) {
      const tOffset = i * dt;
      const gridPos = tOffset / stepSec;
      const gIdx = Math.min(curve.length - 2, Math.max(0, Math.floor(gridPos)));
      const frac = gridPos - gIdx;
      const pt0 = curve[gIdx];
      const pt1 = curve[gIdx + 1];
      if (pt0 === undefined || pt1 === undefined) {
        continue;
      }

      const instFreqHz = pt0.observedFreqHz + frac * (pt1.observedFreqHz - pt0.observedFreqHz);
      const slantMeters = pt0.slantDistanceMeters + frac * (pt1.slantDistanceMeters - pt0.slantDistanceMeters);

      // Inverse-distance spherical spreading envelope with smooth fade outside 6 km
      if (slantMeters < 6500) {
        const attenuation = 1200 / Math.max(300, slantMeters);
        phase += 2 * Math.PI * instFreqHz * dt;
        const fundamental = Math.sin(phase);
        const harmonic2 = 0.35 * Math.sin(2 * phase);
        output[i] = (output[i] ?? 0) + flyover.amplitude * attenuation * (fundamental + harmonic2);
      }
    }
  }

  return output;
}

/**
 * Encodes a mono `Float32Array` audio buffer into a standard 16-bit PCM RIFF WAVE byte array.
 * @param samples - Mono audio samples in `[-1, 1]`.
 * @param sampleRateHz - Sample rate in Hz.
 * @returns Complete `.wav` file bytes.
 */
export function encodeWavPcm16(samples: Readonly<Float32Array>, sampleRateHz: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    view.setInt16(44 + i * 2, int16, true);
  }

  return new Uint8Array(buffer);
}

/**
 * Decodes a 16-bit or 32-bit float PCM RIFF WAVE byte buffer into mono `Float32Array` samples and sample rate.
 * @param wavBytes - Raw `.wav` file bytes.
 * @returns Decoded mono samples and sample rate in Hz.
 */
export function decodeWavBytes(wavBytes: Readonly<Uint8Array>): {
  readonly samples: Float32Array;
  readonly sampleRateHz: number;
} {
  if (wavBytes.byteLength < 44) {
    throw new Error('WAV buffer is shorter than 44-byte RIFF header');
  }
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') {
    throw new Error(`Expected RIFF header, got ${riff}`);
  }

  const numChannels = Math.max(1, view.getUint16(22, true));
  const sampleRateHz = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const bytesPerSample = Math.max(2, bitsPerSample >> 3);

  let dataOffset = 12;
  let dataLength = wavBytes.byteLength - 44;
  while (dataOffset + 8 <= wavBytes.byteLength) {
    const chunkId = String.fromCharCode(
      view.getUint8(dataOffset),
      view.getUint8(dataOffset + 1),
      view.getUint8(dataOffset + 2),
      view.getUint8(dataOffset + 3),
    );
    const chunkSize = view.getUint32(dataOffset + 4, true);
    if (chunkId === 'data') {
      dataOffset += 8;
      dataLength = Math.min(chunkSize, wavBytes.byteLength - dataOffset);
      break;
    }
    dataOffset += 8 + chunkSize;
  }

  const frameStride = numChannels * bytesPerSample;
  const numFrames = Math.floor(dataLength / frameStride);
  const samples = new Float32Array(numFrames);

  for (let i = 0; i < numFrames; i += 1) {
    const pos = dataOffset + i * frameStride;
    if (bitsPerSample === 32) {
      samples[i] = view.getFloat32(pos, true);
    } else {
      samples[i] = view.getInt16(pos, true) / 32768;
    }
  }

  return { samples, sampleRateHz };
}
