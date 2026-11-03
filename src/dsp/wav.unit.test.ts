import { describe, expect, it } from 'vitest';
import { decodeWavBytes, encodeWavPcm16 } from './wav';

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

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
  const size = extensibleTag === undefined ? 16 : 40;
  const body = new Uint8Array(size);
  const view = new DataView(body.buffer);
  view.setUint16(0, extensibleTag === undefined ? tag : FORMAT_EXTENSIBLE, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRateHz, true);
  view.setUint32(8, (sampleRateHz * channels * bits) / 8, true);
  view.setUint16(12, (channels * bits) / 8, true);
  view.setUint16(14, bits, true);
  if (extensibleTag !== undefined) {
    view.setUint16(16, 22, true);
    view.setUint16(18, bits, true);
    view.setUint16(24, extensibleTag, true);
  }

  return body;
}

/** Assembles a RIFF/WAVE file from chunks, padding odd-sized bodies as the format requires. */
function wav(chunks: readonly Chunk[]): Uint8Array {
  const padded = chunks.map((c) => c.body.length + 8 + (c.body.length % 2));
  const out = new Uint8Array(12 + padded.reduce((a, b) => a + b, 0));
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46]);
  view.setUint32(4, out.length - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  let at = 12;
  for (const c of chunks) {
    for (let i = 0; i < 4; i += 1) {
      out[at + i] = c.id.charCodeAt(i);
    }
    view.setUint32(at + 4, c.body.length, true);
    out.set(c.body, at + 8);
    at += 8 + c.body.length + (c.body.length % 2);
  }

  return out;
}

function int24(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 3);
  values.forEach((value, index) => {
    const unsigned = value < 0 ? value + 0x1000000 : value;
    out[index * 3] = unsigned & 0xff;
    out[index * 3 + 1] = (unsigned >> 8) & 0xff;
    out[index * 3 + 2] = (unsigned >> 16) & 0xff;
  });

  return out;
}

describe('encodeWavPcm16 and decodeWavBytes', () => {
  it('round-trips WAV encoding and decoding losslessly', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.99, -0.99]);
    const decoded = decodeWavBytes(encodeWavPcm16(samples, 2000));

    expect(decoded.sampleRateHz).toBe(2000);
    expect(decoded.samples.length).toBe(samples.length);
    samples.forEach((expected, index) => {
      expect(decoded.samples[index]).toBeCloseTo(expected, 2);
    });
  });
});

describe('decodeWavBytes sample formats', () => {
  it('decodes 24-bit PCM', () => {
    const { samples } = decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 1, sampleRateHz: 8000, bits: 24 })), chunk('data', int24([4194304, -4194304, 0]))]));

    expect([...samples]).toEqual([0.5, -0.5, 0]);
  });

  it('decodes 8-bit PCM as unsigned centred on 128', () => {
    const { samples } = decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 1, sampleRateHz: 8000, bits: 8 })), chunk('data', new Uint8Array([128, 192, 64, 0]))]));

    expect([...samples]).toEqual([0, 0.5, -0.5, -1]);
  });

  it('decodes 32-bit integer PCM, which is not float', () => {
    const body = new Uint8Array(8);
    new DataView(body.buffer).setInt32(0, 1073741824, true);
    new DataView(body.buffer).setInt32(4, -1073741824, true);
    const { samples } = decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 1, sampleRateHz: 8000, bits: 32 })), chunk('data', body)]));

    expect([...samples]).toEqual([0.5, -0.5]);
  });

  it('decodes 32-bit and 64-bit float', () => {
    const f32 = new Uint8Array(8);
    new DataView(f32.buffer).setFloat32(0, 0.25, true);
    new DataView(f32.buffer).setFloat32(4, -0.75, true);
    const f64 = new Uint8Array(16);
    new DataView(f64.buffer).setFloat64(0, 0.25, true);
    new DataView(f64.buffer).setFloat64(8, -0.75, true);

    expect([...decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_FLOAT, channels: 1, sampleRateHz: 8000, bits: 32 })), chunk('data', f32)])).samples]).toEqual([0.25, -0.75]);
    expect([...decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_FLOAT, channels: 1, sampleRateHz: 8000, bits: 64 })), chunk('data', f64)])).samples]).toEqual([0.25, -0.75]);
  });

  it('reads the real format from an extensible header', () => {
    const body = int24([4194304]);
    const { samples } = decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: 0, channels: 1, sampleRateHz: 8000, bits: 24, extensibleTag: FORMAT_PCM })), chunk('data', body)]));

    expect([...samples]).toEqual([0.5]);
  });

  it('averages stereo to mono', () => {
    const body = new Uint8Array(8);
    const view = new DataView(body.buffer);
    view.setInt16(0, 16384, true);
    view.setInt16(2, -16384, true);
    view.setInt16(4, 16384, true);
    view.setInt16(6, 16384, true);
    const { samples } = decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 2, sampleRateHz: 8000, bits: 16 })), chunk('data', body)]));

    expect([...samples]).toEqual([0, 0.5]);
  });

  it('rejects a bit depth it cannot read instead of returning noise', () => {
    expect(() => decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 1, sampleRateHz: 8000, bits: 12 })), chunk('data', new Uint8Array(4))]))).toThrow('Unsupported WAV sample format');
  });
});

describe('decodeWavBytes chunk layout', () => {
  const pcm16 = (...values: readonly number[]): Uint8Array => {
    const body = new Uint8Array(values.length * 2);
    values.forEach((value, index) => {
      new DataView(body.buffer).setInt16(index * 2, value, true);
    });

    return body;
  };

  it('skips metadata chunks before fmt and data, including an odd-sized one', () => {
    const file = wav([
      chunk('JUNK', new Uint8Array(27)),
      chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 1, sampleRateHz: 22050, bits: 16 })),
      chunk('LIST', new Uint8Array(5)),
      chunk('data', pcm16(16384, -16384)),
    ]);
    const decoded = decodeWavBytes(file);

    expect(decoded.sampleRateHz).toBe(22050);
    expect([...decoded.samples]).toEqual([0.5, -0.5]);
  });

  it('accepts a data chunk that declares more bytes than the file holds', () => {
    const file = wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 1, sampleRateHz: 8000, bits: 16 })), chunk('data', pcm16(16384, 16384, 16384))]);
    const truncated = file.slice(0, file.length - 2);

    expect(decodeWavBytes(truncated).samples).toHaveLength(2);
  });

  it('names what is missing instead of failing on a bad offset', () => {
    expect(() => decodeWavBytes(wav([chunk('data', pcm16(1))]))).toThrow('no fmt chunk');
    expect(() => decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 1, sampleRateHz: 8000, bits: 16 }))]))).toThrow('no data chunk');
    expect(() => decodeWavBytes(new Uint8Array(4))).toThrow('shorter than the 12-byte RIFF preamble');
    expect(() => decodeWavBytes(wav([chunk('fmt ', fmtBody({ tag: FORMAT_PCM, channels: 0, sampleRateHz: 8000, bits: 16 })), chunk('data', pcm16(1))]))).toThrow('no channels');
  });
});
