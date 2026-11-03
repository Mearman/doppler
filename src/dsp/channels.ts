/**
 * Averages equal-length audio channels into one mono signal.
 * @param channels - One sample array per channel; at least one, all of the same length.
 * @returns The mono signal. A single channel is returned as a copy, never the caller's array.
 */
export function downmixToMono(channels: readonly Readonly<Float32Array>[]): Float32Array {
  const [first] = channels;
  if (first === undefined) {
    throw new Error('downmixToMono needs at least one channel');
  }
  const mono = new Float32Array(first.length);
  for (const channel of channels) {
    if (channel.length !== first.length) {
      throw new Error('downmixToMono needs channels of equal length');
    }
    for (let index = 0; index < channel.length; index += 1) {
      mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0);
    }
  }
  const count = channels.length;
  if (count > 1) {
    for (let index = 0; index < mono.length; index += 1) {
      mono[index] = (mono[index] ?? 0) / count;
    }
  }

  return mono;
}
