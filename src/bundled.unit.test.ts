import { describe, expect, it } from 'vitest';
import {
  BUNDLED_CONSTELLATIONS,
  BUNDLED_DATASET,
  BUNDLED_DEM_GRID,
  BUNDLED_GROUND_TRUTH,
  BUNDLED_SEGMENTS,
  generateBundledReferenceAudio,
  generateBundledReferenceWavBytes,
} from './bundled';
import { decodeWavBytes } from './dsp/wav';
import { DopplerDataset } from './schemas';

describe('Bundled Reference Dataset and Audio Synthesis', () => {
  it('validates bundled ground truth coordinates and DEM elevation grid', () => {
    expect(BUNDLED_GROUND_TRUTH.lat).toBeCloseTo(51.752, 3);
    expect(BUNDLED_GROUND_TRUTH.lon).toBeCloseTo(-1.2577, 3);
    expect(BUNDLED_GROUND_TRUTH.altMeters).toBe(64);

    expect(BUNDLED_DEM_GRID.length).toBeGreaterThan(0);
    for (const point of BUNDLED_DEM_GRID) {
      expect(point.lat).toBeGreaterThan(51.0);
      expect(point.lon).toBeLessThan(0);
      expect(point.altMeters).toBeGreaterThan(0);
    }
  });

  it('validates schema compliance and constellations of the bundled dataset', () => {
    // Validates against Zod schema
    const parsed = DopplerDataset.parse(BUNDLED_DATASET);
    expect(parsed.version).toBe('1.0.0-bundled');
    expect(parsed.segments.length).toBe(BUNDLED_SEGMENTS.length);
    expect(parsed.constellations.length).toBe(BUNDLED_CONSTELLATIONS.length);
    expect(parsed.elevationGrid.length).toBe(BUNDLED_DEM_GRID.length);

    for (const seg of BUNDLED_SEGMENTS) {
      expect(seg.groundspeedMps).toBeGreaterThan(50);
      expect(seg.endEpochSec).toBeGreaterThan(seg.startEpochSec);
    }
  });

  it('generates synthetic bundled reference audio and encodes valid WAV bytes', () => {
    const sampleRateHz = 2000;
    const audio = generateBundledReferenceAudio(sampleRateHz);

    // Audio duration is 1120s at 2000 Hz = 2,240,000 samples
    expect(audio.length).toBe(1120 * sampleRateHz);
    expect(audio).toBeInstanceOf(Float32Array);

    // Verify non-zero content
    let nonZeroCount = 0;
    for (let i = 0; i < 10000; i += 1) {
      if (audio[i] !== 0) {
        nonZeroCount += 1;
      }
    }
    expect(nonZeroCount).toBeGreaterThan(0);

    // Verify WAV bytes generation and round-trip decoding
    const wavBytes = generateBundledReferenceWavBytes(sampleRateHz);
    expect(wavBytes.length).toBeGreaterThan(44);

    // Check RIFF header
    const headerStr = String.fromCharCode(...wavBytes.subarray(0, 4));
    expect(headerStr).toBe('RIFF');

    const decoded = decodeWavBytes(wavBytes);
    expect(decoded.sampleRateHz).toBe(sampleRateHz);
    expect(decoded.samples.length).toBe(audio.length);
  });
});
