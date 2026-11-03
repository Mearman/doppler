import { describe, expect, it } from 'vitest';
import { ANALYSIS_SAMPLE_RATE_HZ } from './constants';
import { decodeWavBytes, encodeWavPcm16 } from './wav';

/** WAVE format tags written into the `fmt ` chunks of the fixtures. */
const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

const BITS_PER_BYTE = 8;

/** Bit depths of the sample formats under test. */
const BITS_UINT8 = 8;
const BITS_INT16 = 16;
const BITS_INT24 = 24;
const BITS_INT32 = 32;
const BITS_FLOAT32 = 32;
const BITS_FLOAT64 = 64;

/** A bit depth the decoder does not support. */
const UNSUPPORTED_BITS = 12;

/** Bytes of one sample at each integer depth, and of a double-precision float. */
const BYTES_INT16 = BITS_INT16 / BITS_PER_BYTE;
const BYTES_INT24 = BITS_INT24 / BITS_PER_BYTE;
const BYTES_INT32 = BITS_INT32 / BITS_PER_BYTE;
const BYTES_FLOAT32 = BITS_FLOAT32 / BITS_PER_BYTE;
const BYTES_FLOAT64 = BITS_FLOAT64 / BITS_PER_BYTE;

/** Layout of the RIFF container, from the WAVE specification. */
const FOUR_CC_BYTES = 4;
const CHUNK_HEADER_BYTES = 8;
const RIFF_PREAMBLE_BYTES = 12;

/** Size in bytes of the base and of the extensible `fmt ` chunk body. */
const BASE_FMT_BODY_BYTES = 16;
const EXTENSIBLE_FMT_BODY_BYTES = 40;

/** Offsets in bytes of the fields of a `fmt ` chunk body, from the WAVE specification. The tag is at offset 0. */
const FMT_CHANNELS_OFFSET = 2;
const FMT_SAMPLE_RATE_OFFSET = 4;
const FMT_BYTE_RATE_OFFSET = 8;
const FMT_BLOCK_ALIGN_OFFSET = 12;
const FMT_BITS_PER_SAMPLE_OFFSET = 14;
const FMT_EXTENSION_SIZE_OFFSET = 16;
const FMT_VALID_BITS_OFFSET = 18;
const FMT_SUBFORMAT_OFFSET = 24;

/** Size in bytes of the extension that follows the base fields of an extensible `fmt ` chunk body. */
const EXTENSIBLE_EXTENSION_BYTES = 22;

/** Sample rates in Hz of the fixtures. */
const SAMPLE_RATE_HZ = 8000;
const HALF_CD_SAMPLE_RATE_HZ = 22_050;

/** Sample amplitudes as fractions of full scale. */
const HALF_SCALE = 0.5;
const NEAR_FULL_SCALE = 0.99;
const FLOAT_SAMPLE_POSITIVE = 0.25;
const FLOAT_SAMPLE_NEGATIVE = -0.75;

/** Raw integer values that decode to half scale at each depth: half of the magnitude of the most negative value. */
const INT16_HALF_SCALE = 2 ** (BITS_INT16 - 2);
const INT24_HALF_SCALE = 2 ** (BITS_INT24 - 2);
const INT32_HALF_SCALE = 2 ** (BITS_INT32 - 2);

/** Unsigned 8-bit value that is silence, and the offset from it that decodes to half scale. */
const UINT8_SILENCE = 2 ** (BITS_UINT8 - 1);
const UINT8_HALF_SWING = UINT8_SILENCE / 2;

/** Modulus of 24-bit two's complement, added to a negative value to obtain its unsigned form. */
const INT24_MODULUS = 2 ** BITS_INT24;

/** Mask that selects the low byte of an integer: a structural bit mask. */
const BYTE_MASK = 0xff;

/** Sizes in bytes of metadata chunks, both odd so that each is followed by a pad byte. */
const ODD_JUNK_BYTES = 27;
const ODD_LIST_BYTES = 5;

/** Length in bytes of a buffer shorter than the RIFF preamble. */
const UNDERSIZED_BUFFER_BYTES = 4;

interface Chunk {
  readonly id: string;
  readonly body: Uint8Array;
}

function chunk(id: string, body: Uint8Array): Chunk {
  return { id, body };
}

interface FmtOptions {
  readonly tag: number;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bits: number;
  /** When set, the header is the 40-byte extensible form and this is the sub-format tag. */
  readonly extensibleTag?: number;
}

function fmtBody(options: Readonly<FmtOptions>): Uint8Array {
  const { tag, channels, sampleRateHz, bits, extensibleTag } = options;
  const size = extensibleTag === undefined ? BASE_FMT_BODY_BYTES : EXTENSIBLE_FMT_BODY_BYTES;
  const body = new Uint8Array(size);
  const view = new DataView(body.buffer);
  view.setUint16(0, extensibleTag === undefined ? tag : FORMAT_EXTENSIBLE, true);
  view.setUint16(FMT_CHANNELS_OFFSET, channels, true);
  view.setUint32(FMT_SAMPLE_RATE_OFFSET, sampleRateHz, true);
  view.setUint32(FMT_BYTE_RATE_OFFSET, (sampleRateHz * channels * bits) / BITS_PER_BYTE, true);
  view.setUint16(FMT_BLOCK_ALIGN_OFFSET, (channels * bits) / BITS_PER_BYTE, true);
  view.setUint16(FMT_BITS_PER_SAMPLE_OFFSET, bits, true);
  if (extensibleTag !== undefined) {
    view.setUint16(FMT_EXTENSION_SIZE_OFFSET, EXTENSIBLE_EXTENSION_BYTES, true);
    view.setUint16(FMT_VALID_BITS_OFFSET, bits, true);
    view.setUint16(FMT_SUBFORMAT_OFFSET, extensibleTag, true);
  }

  return body;
}

/** Writes the four-character code at an offset. */
function writeFourCc(out: Uint8Array, at: number, code: string): void {
  out.set(Uint8Array.from(code.slice(0, FOUR_CC_BYTES), (character) => character.charCodeAt(0)), at);
}

/** Assembles a RIFF/WAVE file from chunks, padding odd-sized bodies as the format requires. */
function wav(chunks: readonly Chunk[]): Uint8Array {
  const padded = chunks.map((c) => c.body.length + CHUNK_HEADER_BYTES + (c.body.length % 2));
  const out = new Uint8Array(RIFF_PREAMBLE_BYTES + padded.reduce((a, b) => a + b, 0));
  const view = new DataView(out.buffer);
  writeFourCc(out, 0, 'RIFF');
  view.setUint32(FOUR_CC_BYTES, out.length - CHUNK_HEADER_BYTES, true);
  // The form type follows the `RIFF` id and the size, so it sits where a chunk body would.
  writeFourCc(out, CHUNK_HEADER_BYTES, 'WAVE');
  let at = RIFF_PREAMBLE_BYTES;
  for (const c of chunks) {
    writeFourCc(out, at, c.id);
    view.setUint32(at + FOUR_CC_BYTES, c.body.length, true);
    out.set(c.body, at + CHUNK_HEADER_BYTES);
    at += CHUNK_HEADER_BYTES + c.body.length + (c.body.length % 2);
  }

  return out;
}

/** Packs values into a little-endian sample body, each written by `write` at its byte offset. */
function packed(
  values: readonly number[],
  bytesPerSample: number,
  write: (view: DataView, offset: number, value: number) => void,
): Uint8Array {
  const body = new Uint8Array(values.length * bytesPerSample);
  const view = new DataView(body.buffer);
  values.forEach((value, index) => {
    write(view, index * bytesPerSample, value);
  });

  return body;
}

const pcm16 = (...values: readonly number[]): Uint8Array =>
  packed(values, BYTES_INT16, (view, offset, value) => {
    view.setInt16(offset, value, true);
  });

const pcm32 = (...values: readonly number[]): Uint8Array =>
  packed(values, BYTES_INT32, (view, offset, value) => {
    view.setInt32(offset, value, true);
  });

const float32 = (...values: readonly number[]): Uint8Array =>
  packed(values, BYTES_FLOAT32, (view, offset, value) => {
    view.setFloat32(offset, value, true);
  });

const float64 = (...values: readonly number[]): Uint8Array =>
  packed(values, BYTES_FLOAT64, (view, offset, value) => {
    view.setFloat64(offset, value, true);
  });

function int24(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * BYTES_INT24);
  values.forEach((value, index) => {
    const unsigned = value < 0 ? value + INT24_MODULUS : value;
    out[index * BYTES_INT24] = unsigned & BYTE_MASK;
    out[index * BYTES_INT24 + 1] = (unsigned >> BITS_PER_BYTE) & BYTE_MASK;
    out[index * BYTES_INT24 + 2] = (unsigned >> (2 * BITS_PER_BYTE)) & BYTE_MASK;
  });

  return out;
}

/** A single-channel file of the given format and sample body. */
function monoFile(tag: number, bits: number, body: Uint8Array): Uint8Array {
  return wav([chunk('fmt ', fmtBody({ tag, channels: 1, sampleRateHz: SAMPLE_RATE_HZ, bits })), chunk('data', body)]);
}

describe('encodeWavPcm16 and decodeWavBytes', () => {
  it('round-trips WAV encoding and decoding losslessly', () => {
    const samples = new Float32Array([0, HALF_SCALE, -HALF_SCALE, NEAR_FULL_SCALE, -NEAR_FULL_SCALE]);
    const decoded = decodeWavBytes(encodeWavPcm16(samples, ANALYSIS_SAMPLE_RATE_HZ));

    expect(decoded.sampleRateHz).toBe(ANALYSIS_SAMPLE_RATE_HZ);
    expect(decoded.samples.length).toBe(samples.length);
    samples.forEach((expected, index) => {
      expect(decoded.samples[index]).toBeCloseTo(expected, 2);
    });
  });
});

describe('decodeWavBytes sample formats', () => {
  it('decodes 24-bit PCM', () => {
    const { samples } = decodeWavBytes(monoFile(FORMAT_PCM, BITS_INT24, int24([INT24_HALF_SCALE, -INT24_HALF_SCALE, 0])));

    expect([...samples]).toEqual([HALF_SCALE, -HALF_SCALE, 0]);
  });

  it('decodes 8-bit PCM as unsigned centred on silence', () => {
    const body = new Uint8Array([UINT8_SILENCE, UINT8_SILENCE + UINT8_HALF_SWING, UINT8_SILENCE - UINT8_HALF_SWING, 0]);
    const { samples } = decodeWavBytes(monoFile(FORMAT_PCM, BITS_UINT8, body));

    expect([...samples]).toEqual([0, HALF_SCALE, -HALF_SCALE, -1]);
  });

  it('decodes 32-bit integer PCM, which is not float', () => {
    const { samples } = decodeWavBytes(monoFile(FORMAT_PCM, BITS_INT32, pcm32(INT32_HALF_SCALE, -INT32_HALF_SCALE)));

    expect([...samples]).toEqual([HALF_SCALE, -HALF_SCALE]);
  });

  it('decodes 32-bit and 64-bit float', () => {
    const f32 = float32(FLOAT_SAMPLE_POSITIVE, FLOAT_SAMPLE_NEGATIVE);
    const f64 = float64(FLOAT_SAMPLE_POSITIVE, FLOAT_SAMPLE_NEGATIVE);

    expect([...decodeWavBytes(monoFile(FORMAT_FLOAT, BITS_FLOAT32, f32)).samples]).toEqual([FLOAT_SAMPLE_POSITIVE, FLOAT_SAMPLE_NEGATIVE]);
    expect([...decodeWavBytes(monoFile(FORMAT_FLOAT, BITS_FLOAT64, f64)).samples]).toEqual([FLOAT_SAMPLE_POSITIVE, FLOAT_SAMPLE_NEGATIVE]);
  });

  it('reads the real format from an extensible header', () => {
    const body = int24([INT24_HALF_SCALE]);
    const { samples } = decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: 0, channels: 1, sampleRateHz: SAMPLE_RATE_HZ, bits: BITS_INT24, extensibleTag: FORMAT_PCM })), chunk('data', body)]));

    expect([...samples]).toEqual([HALF_SCALE]);
  });

  it('averages stereo to mono', () => {
    const body = pcm16(INT16_HALF_SCALE, -INT16_HALF_SCALE, INT16_HALF_SCALE, INT16_HALF_SCALE);
    const { samples } = decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 2, sampleRateHz: SAMPLE_RATE_HZ, bits: BITS_INT16 })), chunk('data', body)]));

    expect([...samples]).toEqual([0, HALF_SCALE]);
  });

  it('rejects a bit depth it cannot read instead of returning noise', () => {
    expect(() => decodeWavBytes(monoFile(FORMAT_PCM, UNSUPPORTED_BITS, new Uint8Array(BYTES_INT32)))).toThrow('Unsupported WAV sample format');
  });
});

describe('decodeWavBytes chunk layout', () => {
  it('skips metadata chunks before fmt and data, including an odd-sized one', () => {
    const file = wav([
      chunk('JUNK', new Uint8Array(ODD_JUNK_BYTES)),
      chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 1, sampleRateHz: HALF_CD_SAMPLE_RATE_HZ, bits: BITS_INT16 })),
      chunk('LIST', new Uint8Array(ODD_LIST_BYTES)),
      chunk('data', pcm16(INT16_HALF_SCALE, -INT16_HALF_SCALE)),
    ]);
    const decoded = decodeWavBytes(file);

    expect(decoded.sampleRateHz).toBe(HALF_CD_SAMPLE_RATE_HZ);
    expect([...decoded.samples]).toEqual([HALF_SCALE, -HALF_SCALE]);
  });

  it('accepts a data chunk that declares more bytes than the file holds', () => {
    const file = monoFile(FORMAT_PCM, BITS_INT16, pcm16(INT16_HALF_SCALE, INT16_HALF_SCALE, INT16_HALF_SCALE));
    const truncated = file.slice(0, file.length - 2);

    expect(decodeWavBytes(truncated).samples).toHaveLength(2);
  });

  it('names what is missing instead of failing on a bad offset', () => {
    expect(() => decodeWavBytes(wav([chunk('data', pcm16(1))]))).toThrow('no fmt chunk');
    expect(() => decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 1, sampleRateHz: SAMPLE_RATE_HZ, bits: BITS_INT16 }))]))).toThrow('no data chunk');
    expect(() => decodeWavBytes(new Uint8Array(UNDERSIZED_BUFFER_BYTES))).toThrow('shorter than the 12-byte RIFF preamble');
    expect(() => decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 0, sampleRateHz: SAMPLE_RATE_HZ, bits: BITS_INT16 })), chunk('data', pcm16(1))]))).toThrow('no channels');
  });
});
