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
/** Offset of the 16-bit channel count inside a `fmt ` chunk body, after the 16-bit tag. */
const FMT_CHANNELS_OFFSET = 2;
/** Offset of the 32-bit sample rate inside a `fmt ` chunk body. */
const FMT_SAMPLE_RATE_OFFSET = 4;
/** Offset of the 32-bit byte rate inside a `fmt ` chunk body. */
const FMT_BYTE_RATE_OFFSET = 8;
/** Offset of the 16-bit block align inside a `fmt ` chunk body. */
const FMT_BLOCK_ALIGN_OFFSET = 12;
/** Offset of the 16-bit bits per sample inside a `fmt ` chunk body. */
const FMT_BITS_PER_SAMPLE_OFFSET = 14;
/** Bytes of a four-character code: a chunk id or the RIFF form type. */
const FOUR_CC_BYTES = 4;
/** Bytes of a chunk header: four-character id and a 32-bit size. */
const CHUNK_HEADER_BYTES = FOUR_CC_BYTES + FOUR_CC_BYTES;
/** Bytes of the RIFF preamble: `RIFF`, size and `WAVE`. */
const RIFF_PREAMBLE_BYTES = CHUNK_HEADER_BYTES + FOUR_CC_BYTES;
/** Offset of the `fmt ` chunk body in the files this encoder writes: the first chunk follows the RIFF preamble. */
const FMT_BODY_OFFSET = RIFF_PREAMBLE_BYTES + CHUNK_HEADER_BYTES;
/** Offset of the `data` chunk, which follows the minimal `fmt ` chunk. */
const DATA_CHUNK_OFFSET = FMT_BODY_OFFSET + MIN_FMT_BODY_BYTES;
/** Bytes of the header this encoder writes before the first sample: the RIFF preamble, the `fmt ` chunk and the `data` chunk header. */
const WAV_HEADER_BYTES = DATA_CHUNK_OFFSET + CHUNK_HEADER_BYTES;
/** Bits in a byte. */
const BITS_PER_BYTE = 8;

/** Bit depth of unsigned 8-bit PCM. */
const PCM_BITS_UINT8 = 8;
/** Bit depth of signed 16-bit PCM. */
const PCM_BITS_INT16 = 16;
/** Bit depth of signed 24-bit PCM. */
const PCM_BITS_INT24 = 24;
/** Bit depth of signed 32-bit PCM. */
const PCM_BITS_INT32 = 32;
/** Bit depth of single-precision float samples. */
const FLOAT_BITS_SINGLE = 32;
/** Bit depth of double-precision float samples. */
const FLOAT_BITS_DOUBLE = 64;

/** Magnitude of the most negative signed integer of a bit depth, which maps to -1.0. */
const signedFullScale = (bits: number): number => 2 ** (bits - 1);
/** Unsigned 8-bit PCM value that is silence, and the divisor that maps its offset from silence to `[-1, 1)`. */
const UINT8_MIDPOINT = signedFullScale(PCM_BITS_UINT8);
/** Divisor that maps a signed 16-bit sample to `[-1, 1)`. */
const INT16_FULL_SCALE = signedFullScale(PCM_BITS_INT16);
/** Divisor that maps a signed 24-bit sample to `[-1, 1)`. */
const INT24_FULL_SCALE = signedFullScale(PCM_BITS_INT24);
/** Divisor that maps a signed 32-bit sample to `[-1, 1)`. */
const INT32_FULL_SCALE = signedFullScale(PCM_BITS_INT32);

/** Bytes of one sample written by `encodeWavPcm16`. */
const PCM16_BYTES_PER_SAMPLE = PCM_BITS_INT16 / BITS_PER_BYTE;
/** Channel count written by `encodeWavPcm16`. */
const ENCODED_CHANNELS = 1;

interface WavFormat {
  readonly tag: number;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bitsPerSample: number;
}

function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(...Array.from({ length: FOUR_CC_BYTES }, (_, index) => view.getUint8(offset + index)));
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
    channels: view.getUint16(bodyOffset + FMT_CHANNELS_OFFSET, true),
    sampleRateHz: view.getUint32(bodyOffset + FMT_SAMPLE_RATE_OFFSET, true),
    bitsPerSample: view.getUint16(bodyOffset + FMT_BITS_PER_SAMPLE_OFFSET, true),
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
    if (bitsPerSample === FLOAT_BITS_SINGLE) {
      return view.getFloat32(position, true);
    }
    if (bitsPerSample === FLOAT_BITS_DOUBLE) {
      return view.getFloat64(position, true);
    }
  } else if (tag === FORMAT_PCM) {
    // 8-bit PCM is unsigned and centred on its midpoint; every wider depth is signed two's complement.
    switch (bitsPerSample) {
      case PCM_BITS_UINT8:
        return (view.getUint8(position) - UINT8_MIDPOINT) / UINT8_MIDPOINT;
      case PCM_BITS_INT16:
        return view.getInt16(position, true) / INT16_FULL_SCALE;
      case PCM_BITS_INT24:
        // Little-endian: the top byte is read signed so that the shifted value carries the sign.
        return (
          ((view.getInt8(position + 2) << (2 * BITS_PER_BYTE)) |
            (view.getUint8(position + 1) << BITS_PER_BYTE) |
            view.getUint8(position)) /
          INT24_FULL_SCALE
        );
      case PCM_BITS_INT32:
        return view.getInt32(position, true) / INT32_FULL_SCALE;
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
    throw new Error(`WAV buffer is shorter than the ${String(RIFF_PREAMBLE_BYTES)}-byte RIFF preamble`);
  }
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const riff = fourCc(view, 0);
  if (riff !== 'RIFF') {
    throw new Error(`Expected RIFF header, got ${riff}`);
  }
  // The form type follows the `RIFF` id and the size, so it sits where a chunk body would.
  const form = fourCc(view, CHUNK_HEADER_BYTES);
  if (form !== 'WAVE') {
    throw new Error(`Expected WAVE form, got ${form}`);
  }

  let format: WavFormat | undefined;
  let dataOffset: number | undefined;
  let dataLength = 0;
  let cursor = RIFF_PREAMBLE_BYTES;
  while (cursor + CHUNK_HEADER_BYTES <= wavBytes.byteLength) {
    const chunkId = fourCc(view, cursor);
    const chunkSize = view.getUint32(cursor + FOUR_CC_BYTES, true);
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

  const bytesPerSample = format.bitsPerSample / BITS_PER_BYTE;
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
  const dataBytes = samples.length * PCM16_BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  // The RIFF size counts every byte after the `RIFF` id and the size field itself.
  view.setUint32(FOUR_CC_BYTES, WAV_HEADER_BYTES - CHUNK_HEADER_BYTES + dataBytes, true);
  writeAscii(CHUNK_HEADER_BYTES, 'WAVE');
  writeAscii(RIFF_PREAMBLE_BYTES, 'fmt ');
  view.setUint32(RIFF_PREAMBLE_BYTES + FOUR_CC_BYTES, MIN_FMT_BODY_BYTES, true);
  view.setUint16(FMT_BODY_OFFSET, FORMAT_PCM, true);
  view.setUint16(FMT_BODY_OFFSET + FMT_CHANNELS_OFFSET, ENCODED_CHANNELS, true);
  view.setUint32(FMT_BODY_OFFSET + FMT_SAMPLE_RATE_OFFSET, sampleRateHz, true);
  view.setUint32(FMT_BODY_OFFSET + FMT_BYTE_RATE_OFFSET, sampleRateHz * PCM16_BYTES_PER_SAMPLE, true);
  view.setUint16(FMT_BODY_OFFSET + FMT_BLOCK_ALIGN_OFFSET, PCM16_BYTES_PER_SAMPLE, true);
  view.setUint16(FMT_BODY_OFFSET + FMT_BITS_PER_SAMPLE_OFFSET, PCM_BITS_INT16, true);
  writeAscii(DATA_CHUNK_OFFSET, 'data');
  view.setUint32(DATA_CHUNK_OFFSET + FOUR_CC_BYTES, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = clamped < 0 ? Math.round(clamped * INT16_FULL_SCALE) : Math.round(clamped * (INT16_FULL_SCALE - 1));
    view.setInt16(WAV_HEADER_BYTES + i * PCM16_BYTES_PER_SAMPLE, int16, true);
  }

  return new Uint8Array(buffer);
}
