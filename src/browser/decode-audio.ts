import { downmixToMono } from '../dsp/channels';
import { decodeWavBytes } from '../dsp/wav';

/** Rate the browser decodes compressed audio at. Analysis decimates to a far lower rate, so the exact value only has to cover the aircraft band. */
const COMPRESSED_DECODE_RATE_HZ = 44100;

/** Bytes of a RIFF four-character code, such as `RIFF` or `WAVE`. */
const FOUR_CC_BYTES = 4;

/** Bytes of the RIFF chunk size field. */
const RIFF_SIZE_FIELD_BYTES = 4;

/** Bytes of the RIFF header's tag plus size field that precede the WAVE form type. */
const RIFF_FORM_OFFSET = FOUR_CC_BYTES + RIFF_SIZE_FIELD_BYTES;

function isWav(bytes: Readonly<Uint8Array>): boolean {
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + FOUR_CC_BYTES));

  return bytes.length >= RIFF_FORM_OFFSET + FOUR_CC_BYTES && tag(0) === 'RIFF' && tag(RIFF_FORM_OFFSET) === 'WAVE';
}

/**
 * Decodes an audio or video file's soundtrack into mono samples. WAV decodes in-process at its own sample rate; every other container goes through the browser's decoder, so the supported formats are the ones the browser plays.
 * @param buffer - The file's bytes. A browser decode detaches this buffer.
 * @returns Mono samples and their sample rate in Hz.
 * @throws When the bytes are not a WAV file and the browser cannot decode them.
 */
export async function decodeAudioFile(buffer: Readonly<ArrayBuffer>): Promise<{ readonly samples: Float32Array; readonly sampleRateHz: number }> {
  if (isWav(new Uint8Array(buffer))) {
    return decodeWavBytes(new Uint8Array(buffer));
  }
  const context = new OfflineAudioContext(1, 1, COMPRESSED_DECODE_RATE_HZ);
  const decoded = await context.decodeAudioData(buffer);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));

  return { samples: downmixToMono(channels), sampleRateHz: decoded.sampleRate };
}
