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
import { DopplerDatasetSchema } from './schemas';

/** Seconds of audio the bundled generator renders, and the rate the test renders it at. */
const BUNDLED_DURATION_SEC = 1120;
const SYNTHESIS_RATE_HZ = 2000;
/** The synthesis test renders the audio twice (once directly, once through the WAV helper). */
const SYNTHESISED_SAMPLES = 2 * BUNDLED_DURATION_SEC * SYNTHESIS_RATE_HZ;
/** Budget per rendered sample, in microseconds: far above the uncontended rate so that coverage instrumentation and a busy machine do not turn a slow run into a failure, while still scaling with the work. */
const BUDGET_MICROSECONDS_PER_SAMPLE = 10;
const SYNTHESIS_TEST_TIMEOUT_MS = (SYNTHESISED_SAMPLES * BUDGET_MICROSECONDS_PER_SAMPLE) / 1000;

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
    const parsed = DopplerDatasetSchema.parse(BUNDLED_DATASET);
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
    
    const audio = generateBundledReferenceAudio(SYNTHESIS_RATE_HZ);

    expect(audio.length).toBe(BUNDLED_DURATION_SEC * SYNTHESIS_RATE_HZ);
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
    const wavBytes = generateBundledReferenceWavBytes(SYNTHESIS_RATE_HZ);
    expect(wavBytes.length).toBeGreaterThan(44);

    // Check RIFF header
    const headerStr = String.fromCharCode(...wavBytes.subarray(0, 4));
    expect(headerStr).toBe('RIFF');

    const decoded = decodeWavBytes(wavBytes);
    expect(decoded.sampleRateHz).toBe(SYNTHESIS_RATE_HZ);
    expect(decoded.samples.length).toBe(audio.length);
  }, SYNTHESIS_TEST_TIMEOUT_MS);
});
