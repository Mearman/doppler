import { downmixToMono } from './channels';

/** WAVE format tags (RIFF `fmt ` chunk) this decoder understands. */
const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
/** Extensible format: the real tag is the first two bytes of the sub-format GUID. */
const FORMAT_EXTENSIBLE = 0xfffe;

/** Offset of the sub-format tag inside an extensible `fmt ` chunk body (after the 16-byte base, size, valid bits and channel mask). */
const EXTENSIBLE_SUBFORMAT_OFFSET = 24;
/** Smallest `fmt ` chunk body: tag, channels, rate, byte rate, block align, bits. */
const MIN_FMT_BODY_BYTES = 16;
/** Bytes of a chunk header: four-character id and a 32-bit size. */
const CHUNK_HEADER_BYTES = 8;
/** Bytes of the RIFF preamble: `RIFF`, size and `WAVE`. */
const RIFF_PREAMBLE_BYTES = 12;

interface WavFormat {
  readonly tag: number;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bitsPerSample: number;
}

function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function readFormat(view: DataView, bodyOffset: number, bodySize: number): WavFormat {
  if (bodySize < MIN_FMT_BODY_BYTES) {
    throw new Error(`WAV fmt chunk is ${String(bodySize)} bytes, shorter than the ${String(MIN_FMT_BODY_BYTES)} required`);
  }
  let tag = view.getUint16(bodyOffset, true);
  if (tag === FORMAT_EXTENSIBLE) {
    if (bodySize < EXTENSIBLE_SUBFORMAT_OFFSET + 2) {
      throw new Error('WAV extensible fmt chunk is too short to name its sub-format');
    }
    tag = view.getUint16(bodyOffset + EXTENSIBLE_SUBFORMAT_OFFSET, true);
  }

  return {
    tag,
    channels: view.getUint16(bodyOffset + 2, true),
    sampleRateHz: view.getUint32(bodyOffset + 4, true),
    bitsPerSample: view.getUint16(bodyOffset + 14, true),
  };
}

/**
 * Reads one sample as a float in `[-1, 1]`.
 * @param view - The file bytes.
 * @param position - Byte offset of the sample.
 * @param format - The decoded `fmt ` chunk.
 * @returns The sample value.
 * @throws When the tag and bit depth are not a supported combination.
 */
function readSample(view: DataView, position: number, format: Readonly<WavFormat>): number {
  const { tag, bitsPerSample } = format;
  if (tag === FORMAT_FLOAT) {
    if (bitsPerSample === 32) {
      return view.getFloat32(position, true);
    }
    if (bitsPerSample === 64) {
      return view.getFloat64(position, true);
    }
  } else if (tag === FORMAT_PCM) {
    // 8-bit PCM is unsigned and centred on 128; every wider depth is signed two's complement.
    switch (bitsPerSample) {
      case 8:
        return (view.getUint8(position) - 128) / 128;
      case 16:
        return view.getInt16(position, true) / 32768;
      case 24:
        return ((view.getInt8(position + 2) << 16) | (view.getUint8(position + 1) << 8) | view.getUint8(position)) / 8388608;
      case 32:
        return view.getInt32(position, true) / 2147483648;
      default:
    }
  }
  throw new Error(`Unsupported WAV sample format: tag ${String(tag)}, ${String(bitsPerSample)} bits`);
}

/**
 * Decodes a RIFF WAVE byte buffer into mono samples and its sample rate. Chunks are located by walking the chunk list, so metadata chunks (`JUNK`, `bext`, `LIST`) before `fmt ` or `data` are skipped, and an odd-sized chunk's pad byte is honoured. Multi-channel audio is averaged to mono.
 * @param wavBytes - Raw `.wav` file bytes.
 * @returns Decoded mono samples in `[-1, 1]` and the sample rate in Hz.
 * @throws When the buffer is not RIFF/WAVE, has no `fmt ` or `data` chunk, declares no channels, or uses an unsupported tag or bit depth (8, 16, 24 and 32-bit integer PCM and 32 and 64-bit float are supported).
 */
export function decodeWavBytes(wavBytes: Readonly<Uint8Array>): {
  readonly samples: Float32Array;
  readonly sampleRateHz: number;
} {
  if (wavBytes.byteLength < RIFF_PREAMBLE_BYTES) {
    throw new Error('WAV buffer is shorter than the 12-byte RIFF preamble');
  }
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const riff = fourCc(view, 0);
  if (riff !== 'RIFF') {
    throw new Error(`Expected RIFF header, got ${riff}`);
  }
  const form = fourCc(view, 8);
  if (form !== 'WAVE') {
    throw new Error(`Expected WAVE form, got ${form}`);
  }

  let format: WavFormat | undefined;
  let dataOffset: number | undefined;
  let dataLength = 0;
  let cursor = RIFF_PREAMBLE_BYTES;
  while (cursor + CHUNK_HEADER_BYTES <= wavBytes.byteLength) {
    const chunkId = fourCc(view, cursor);
    const chunkSize = view.getUint32(cursor + 4, true);
    const bodyOffset = cursor + CHUNK_HEADER_BYTES;
    if (chunkId === 'fmt ') {
      format = readFormat(view, bodyOffset, Math.min(chunkSize, wavBytes.byteLength - bodyOffset));
    } else if (chunkId === 'data') {
      dataOffset = bodyOffset;
      // A streamed file can declare a size larger than what was written, so the declared size is capped at the bytes present.
      dataLength = Math.min(chunkSize, wavBytes.byteLength - bodyOffset);
    }
    if (format !== undefined && dataOffset !== undefined) {
      break;
    }
    // Chunks are word-aligned: an odd size is followed by one pad byte that the size does not count.
    cursor = bodyOffset + chunkSize + (chunkSize % 2);
  }
  if (format === undefined) {
    throw new Error('WAV file has no fmt chunk');
  }
  if (dataOffset === undefined) {
    throw new Error('WAV file has no data chunk');
  }
  if (format.channels < 1) {
    throw new Error('WAV file declares no channels');
  }

  const bytesPerSample = format.bitsPerSample / 8;
  const frameStride = format.channels * bytesPerSample;
  const numFrames = Math.floor(dataLength / frameStride);
  const channels = Array.from({ length: format.channels }, () => new Float32Array(numFrames));
  for (let frame = 0; frame < numFrames; frame += 1) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      const target = channels[channel];
      if (target !== undefined) {
        target[frame] = readSample(view, dataOffset + frame * frameStride + channel * bytesPerSample, format);
      }
    }
  }

  return { samples: downmixToMono(channels), sampleRateHz: format.sampleRateHz };
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
