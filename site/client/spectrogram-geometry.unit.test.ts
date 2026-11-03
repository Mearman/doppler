import { describe, expect, it } from 'vitest';
import { binIndexAt, formatElapsed, frameIndexAt, niceTicks } from './spectrogram-geometry';

describe('niceTicks', () => {
  it('steps by 1, 2 or 5 times a power of ten inside the range', () => {
    expect(niceTicks(50, 500, 9)).toEqual([50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(50, 250, 4)).toEqual([50, 100, 150, 200, 250]);
  });

  it('follows a narrower range down to fractions of a hertz', () => {
    expect(niceTicks(49, 51, 4)).toEqual([49, 49.5, 50, 50.5, 51]);
  });

  it('returns nothing for an empty or inverted range', () => {
    expect(niceTicks(10, 10, 5)).toEqual([]);
    expect(niceTicks(10, 5, 5)).toEqual([]);
  });
});

describe('frameIndexAt', () => {
  it('clamps both edges to the frames that exist', () => {
    expect(frameIndexAt(0, 10)).toBe(0);
    expect(frameIndexAt(0.55, 10)).toBe(5);
    expect(frameIndexAt(1, 10)).toBe(9);
    expect(frameIndexAt(-0.2, 10)).toBe(0);
  });
});

describe('binIndexAt', () => {
  it('finds the bin holding a frequency and clamps outside the band', () => {
    expect(binIndexAt(100, 50, 0.5, 900)).toBe(100);
    expect(binIndexAt(10, 50, 0.5, 900)).toBe(0);
    expect(binIndexAt(900, 50, 0.5, 900)).toBe(899);
  });
});

describe('formatElapsed', () => {
  it('uses seconds under a minute and minutes beyond, keeping the sign', () => {
    expect(formatElapsed(42.4)).toBe('42 s');
    expect(formatElapsed(125)).toBe('2 m 05 s');
    expect(formatElapsed(-30)).toBe('-30 s');
  });
});
