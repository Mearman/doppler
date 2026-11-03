import { synthesizeMultiFlyoverAudio } from '../dsp/side-channels';
import { encodeWavPcm16 } from '../dsp/wav';
import { DEFAULT_SPATIAL_RESOLUTION, encodeSpatialCell, localEnuToGeo } from '../physics/geo';
import { buildConstellationIndex } from '../solver/constellation';
import type { DopplerDataset, GeoPoint3D, LinearFlightSegment } from '../schemas';

// Test-only synthetic data: nothing here is exported from the package, the CLI or the site, so a located result always comes from real flight data.

/**
 * Reference ground truth observer location used for regression testing.
 * Oxford, UK (51.7520° N, 1.2577° W, elevation 64 m).
 */
export const SYNTHETIC_GROUND_TRUTH: GeoPoint3D = {
  lat: 51.752,
  lon: -1.2577,
  altMeters: 64,
};

const SEGMENT_ALPHA: LinearFlightSegment = {
  id: 'flyover_alpha',
  flightId: 'G-BOAC',
  icao24: '4009a1',
  typeCode: 'C172',
  category: 'piston',
  dateIso: '2026-09-08',
  startEpochSec: 1788900000,
  endEpochSec: 1788900180,
  startGeo: localEnuToGeo(SYNTHETIC_GROUND_TRUTH, { x: -6000, y: -1200, z: 950 }),
  endGeo: localEnuToGeo(SYNTHETIC_GROUND_TRUTH, { x: 6000, y: -800, z: 980 }),
  groundspeedMps: 66.8,
  h3Cell: encodeSpatialCell(SYNTHETIC_GROUND_TRUTH.lat, SYNTHETIC_GROUND_TRUTH.lon, DEFAULT_SPATIAL_RESOLUTION),
};

const SEGMENT_BRAVO: LinearFlightSegment = {
  id: 'flyover_bravo',
  flightId: 'G-KEST',
  icao24: '4011ef',
  typeCode: 'PA28',
  category: 'piston',
  dateIso: '2026-09-08',
  startEpochSec: 1788900920,
  endEpochSec: 1788901100,
  startGeo: localEnuToGeo(SYNTHETIC_GROUND_TRUTH, { x: 1400, y: -7000, z: 1200 }),
  endGeo: localEnuToGeo(SYNTHETIC_GROUND_TRUTH, { x: 800, y: 7000, z: 1250 }),
  groundspeedMps: 77.9,
  h3Cell: encodeSpatialCell(SYNTHETIC_GROUND_TRUTH.lat, SYNTHETIC_GROUND_TRUTH.lon, DEFAULT_SPATIAL_RESOLUTION),
};

const SEGMENT_CHARLIE: LinearFlightSegment = {
  id: 'flyover_charlie',
  flightId: 'G-ROTN',
  icao24: '4022bc',
  typeCode: 'DA42',
  category: 'turboprop',
  dateIso: '2026-09-08',
  startEpochSec: 1788901850,
  endEpochSec: 1788902030,
  startGeo: localEnuToGeo(SYNTHETIC_GROUND_TRUTH, { x: -5000, y: 5000, z: 1400 }),
  endGeo: localEnuToGeo(SYNTHETIC_GROUND_TRUTH, { x: 5000, y: -5000, z: 1350 }),
  groundspeedMps: 78.5,
  h3Cell: encodeSpatialCell(SYNTHETIC_GROUND_TRUTH.lat, SYNTHETIC_GROUND_TRUTH.lon, DEFAULT_SPATIAL_RESOLUTION),
};

/**
 * Realistic piecewise-linear flight segments crossing the synthetic reference region.
 */
export const SYNTHETIC_SEGMENTS: readonly LinearFlightSegment[] = [
  SEGMENT_ALPHA,
  SEGMENT_BRAVO,
  SEGMENT_CHARLIE,
];

/**
 * Regional DEM grid surrounding the reference location.
 */
export const SYNTHETIC_DEM_GRID: readonly GeoPoint3D[] = [
  { lat: 51.7, lon: -1.3, altMeters: 60 },
  { lat: 51.7, lon: -1.2, altMeters: 62 },
  { lat: 51.8, lon: -1.3, altMeters: 75 },
  { lat: 51.8, lon: -1.2, altMeters: 68 },
  { lat: 51.752, lon: -1.2577, altMeters: 64 },
];

/**
 * Pre-indexed constellation entries built from the synthetic reference segments.
 */
export const SYNTHETIC_CONSTELLATIONS = buildConstellationIndex(SYNTHETIC_SEGMENTS, { demGrid: SYNTHETIC_DEM_GRID });

/**
 * Complete synthetic DopplerDataset object available synchronously without network requests.
 */
export const SYNTHETIC_DATASET: DopplerDataset = {
  version: '1.0.0-synthetic',
  generatedAtIso: '2026-09-08T00:00:00Z',
  segments: SYNTHETIC_SEGMENTS,
  constellations: SYNTHETIC_CONSTELLATIONS,
  elevationGrid: SYNTHETIC_DEM_GRID,
};

/**
 * Synthesizes a realistic reference audio buffer containing the synthetic flyovers and a 50 Hz European ENF mains hum.
 * @param sampleRateHz - Audio sample rate (default 2000 Hz).
 * @returns Decimated mono `Float32Array` audio samples.
 */
export function generateSyntheticReferenceAudio(sampleRateHz = 2000): Float32Array {
  return synthesizeMultiFlyoverAudio({
    sampleRateHz,
    startEpochSec: 1788900000,
    durationSec: 1120,
    observer: SYNTHETIC_GROUND_TRUTH,
    flyovers: [
      { segment: SEGMENT_ALPHA, baseFreqHz: 110.0, amplitude: 0.8 },
      { segment: SEGMENT_BRAVO, baseFreqHz: 145.0, amplitude: 1.0 },
    ],
    enfNominalHz: 50,
    enfAmplitude: 0.04,
    noiseStd: 0.004,
  });
}

/**
 * Encodes the reference audio into a `.wav` byte array.
 * @param sampleRateHz - Audio sample rate.
 * @returns Raw `.wav` file bytes.
 */
export function generateSyntheticReferenceWavBytes(sampleRateHz = 2000): Uint8Array {
  const audio = generateSyntheticReferenceAudio(sampleRateHz);

  return encodeWavPcm16(audio, sampleRateHz);
}
