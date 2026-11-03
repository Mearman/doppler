/** Candidate step sizes within a decade, as multiples of its power of ten, in the order a reader finds natural. */
const NICE_STEP_MULTIPLES = [1, 2, 5, 10] as const;

/** Seconds in a minute, for splitting an elapsed time. */
const SECONDS_PER_MINUTE = 60;

/**
 * Chooses axis ticks at round values.
 * @param min - Lowest value on the axis.
 * @param max - Highest value on the axis.
 * @param target - How many ticks to aim for; the result has about this many.
 * @returns Ascending tick values inside the range, at a step of 1, 2 or 5 times a power of ten.
 */
export function niceTicks(min: number, max: number, target: number): readonly number[] {
  const span = max - min;
  if (!(span > 0) || target < 1) {
    return [];
  }
  const rawStep = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const multiple = NICE_STEP_MULTIPLES.find((candidate) => normalised <= candidate) ?? 10;
  const step = multiple * magnitude;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }

  return ticks;
}

/**
 * Maps a horizontal position to the frame drawn there.
 * @param fraction - Position across the plot, 0 at the left edge and 1 at the right.
 * @param frameCount - Number of frames in the plot, at least one.
 * @returns The index of the frame under that position, clamped to the frames that exist.
 */
export function frameIndexAt(fraction: number, frameCount: number): number {
  return Math.max(0, Math.min(frameCount - 1, Math.floor(fraction * frameCount)));
}

/**
 * Maps a frequency to the bin that holds it.
 * @param freqHz - The frequency in hertz.
 * @param minFreqHz - Frequency of the first bin.
 * @param binStepHz - Width of a bin in hertz.
 * @param binCount - Number of bins in a frame, at least one.
 * @returns The index of the bin, clamped to the bins that exist.
 */
export function binIndexAt(freqHz: number, minFreqHz: number, binStepHz: number, binCount: number): number {
  return Math.max(0, Math.min(binCount - 1, Math.floor((freqHz - minFreqHz) / binStepHz)));
}

/**
 * Formats a length of time for an axis or readout.
 * @param seconds - The time in seconds, which may be negative.
 * @returns Whole seconds under a minute, otherwise minutes and seconds, with the sign kept.
 */
export function formatElapsed(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const whole = Math.round(Math.abs(seconds));
  if (whole < SECONDS_PER_MINUTE) {
    return `${sign}${String(whole)} s`;
  }

  return `${sign}${String(Math.floor(whole / SECONDS_PER_MINUTE))} m ${String(whole % SECONDS_PER_MINUTE).padStart(2, '0')} s`;
}
