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
/** Microseconds in a millisecond, to convert the per-sample budget to the millisecond timeout Vitest takes. */
const MICROSECONDS_PER_MILLISECOND = 1000;
const SYNTHESIS_TEST_TIMEOUT_MS = (SYNTHESISED_SAMPLES * BUDGET_MICROSECONDS_PER_SAMPLE) / MICROSECONDS_PER_MILLISECOND;

/** Latitude of the bundled observer (Oxford) in degrees, as documented on `BUNDLED_GROUND_TRUTH`. */
const OXFORD_LAT_DEG = 51.752;
/** Longitude of the bundled observer (Oxford) in degrees, as documented on `BUNDLED_GROUND_TRUTH`. */
const OXFORD_LON_DEG = -1.2577;
/** Elevation of the bundled observer (Oxford) in metres, as documented on `BUNDLED_GROUND_TRUTH`. */
const OXFORD_ALT_METERS = 64;
/** Decimal places `toBeCloseTo` compares the coordinates to: a tolerance of half a thousandth of a degree. */
const COORDINATE_COMPARE_DIGITS = 3;
/** Southern bound in degrees of latitude of the bundled DEM grid, which lies north of it. */
const DEM_GRID_SOUTH_BOUND_DEG = 51;
/** Lower bound in m/s on the groundspeed of every bundled segment, below the slowest aircraft in the set. */
const MIN_BUNDLED_GROUNDSPEED_MPS = 50;
/** Samples at the start of the audio that the non-silence check inspects. */
const NON_ZERO_SCAN_SAMPLES = 10000;
/** Bytes in the canonical PCM WAV header; a valid file is longer because it carries samples after it. */
const WAV_HEADER_BYTES = 44;
/** Length in bytes of the RIFF chunk tag that opens a WAV file. */
const RIFF_TAG_BYTES = 4;

describe('Bundled Reference Dataset and Audio Synthesis', () => {
  it('validates bundled ground truth coordinates and DEM elevation grid', () => {
    expect(BUNDLED_GROUND_TRUTH.lat).toBeCloseTo(OXFORD_LAT_DEG, COORDINATE_COMPARE_DIGITS);
    expect(BUNDLED_GROUND_TRUTH.lon).toBeCloseTo(OXFORD_LON_DEG, COORDINATE_COMPARE_DIGITS);
    expect(BUNDLED_GROUND_TRUTH.altMeters).toBe(OXFORD_ALT_METERS);

    expect(BUNDLED_DEM_GRID.length).toBeGreaterThan(0);
    for (const point of BUNDLED_DEM_GRID) {
      expect(point.lat).toBeGreaterThan(DEM_GRID_SOUTH_BOUND_DEG);
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
      expect(seg.groundspeedMps).toBeGreaterThan(MIN_BUNDLED_GROUNDSPEED_MPS);
      expect(seg.endEpochSec).toBeGreaterThan(seg.startEpochSec);
    }
  });

  it('generates synthetic bundled reference audio and encodes valid WAV bytes', () => {
    
    const audio = generateBundledReferenceAudio(SYNTHESIS_RATE_HZ);

    expect(audio.length).toBe(BUNDLED_DURATION_SEC * SYNTHESIS_RATE_HZ);
    expect(audio).toBeInstanceOf(Float32Array);

    // Verify non-zero content
    let nonZeroCount = 0;
    for (let i = 0; i < NON_ZERO_SCAN_SAMPLES; i += 1) {
      if (audio[i] !== 0) {
        nonZeroCount += 1;
      }
    }
    expect(nonZeroCount).toBeGreaterThan(0);

    // Verify WAV bytes generation and round-trip decoding
    const wavBytes = generateBundledReferenceWavBytes(SYNTHESIS_RATE_HZ);
    expect(wavBytes.length).toBeGreaterThan(WAV_HEADER_BYTES);

    // Check RIFF header
    const headerStr = String.fromCharCode(...wavBytes.subarray(0, RIFF_TAG_BYTES));
    expect(headerStr).toBe('RIFF');

    const decoded = decodeWavBytes(wavBytes);
    expect(decoded.sampleRateHz).toBe(SYNTHESIS_RATE_HZ);
    expect(decoded.samples.length).toBe(audio.length);
  }, SYNTHESIS_TEST_TIMEOUT_MS);
});
