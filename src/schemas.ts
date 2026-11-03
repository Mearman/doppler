import { z } from 'zod';
import { define } from './define';

/**
 * Geodetic 3D coordinate on or above the WGS84 reference ellipsoid.
 */
export const GeoPoint3D = define(
  z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    altMeters: z.number().min(-500).max(60000),
  }),
);
export type GeoPoint3D = z.infer<typeof GeoPoint3D>;

/**
 * 3D Cartesian vector in Earth-Centered, Earth-Fixed (ECEF) or local East-North-Up (ENU) coordinates.
 */
export const Vector3D = define(
  z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
);
export type Vector3D = z.infer<typeof Vector3D>;

/**
 * Aircraft propulsion category used to filter acoustic candidates.
 */
export const AircraftCategory = define(z.enum(['piston', 'turboprop', 'helicopter', 'jet', 'unknown']));
export type AircraftCategory = z.infer<typeof AircraftCategory>;

/**
 * Raw 1 Hz ADS-B state vector prior to 4D Ramer-Douglas-Peucker simplification.
 */
export const AdsbPing = define(
  z.object({
    epochSec: z.number(),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    altMeters: z.number(),
  }),
);
export type AdsbPing = z.infer<typeof AdsbPing>;

/**
 * Piecewise-linear 4D aircraft trajectory segment produced by Ramer-Douglas-Peucker compression.
 */
export const LinearFlightSegment = define(
  z.object({
    id: z.string().min(1),
    flightId: z.string().min(1),
    icao24: z.string().min(1),
    typeCode: z.string(),
    category: AircraftCategory,
    dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startEpochSec: z.number(),
    endEpochSec: z.number(),
    startGeo: GeoPoint3D,
    endGeo: GeoPoint3D,
    groundspeedMps: z.number().nonnegative(),
    h3Cell: z.string().min(1),
  }),
);
export type LinearFlightSegment = z.infer<typeof LinearFlightSegment>;

/**
 * Single time-frequency point along an extracted spectrogram Doppler ridge.
 */
export const DopplerRidgePoint = define(
  z.object({
    timeSec: z.number(),
    freqHz: z.number().positive(),
    snrDb: z.number(),
  }),
);
export type DopplerRidgePoint = z.infer<typeof DopplerRidgePoint>;

/**
 * Closed-form kinematic parameters extracted algebraically from a single Doppler S-curve.
 */
export const AsymptoticKinematics = define(
  z.object({
    asymptoticHighHz: z.number().positive(),
    asymptoticLowHz: z.number().positive(),
    baseFreqHz: z.number().positive(),
    inflectionSlopeHzPerSec: z.number().negative(),
    inferredSpeedMps: z.number().positive(),
    inferredSlantMeters: z.number().positive(),
    speedStdMps: z.number().nonnegative(),
    slantStdMeters: z.number().nonnegative(),
  }),
);
export type AsymptoticKinematics = z.infer<typeof AsymptoticKinematics>;

/**
 * Complete acoustic observation of an aircraft flyover extracted from an audio stream or file.
 */
export const DopplerObservation = define(
  z.object({
    id: z.string().min(1),
    episodeId: z.string().min(1),
    cpaTimeSec: z.number(),
    kinematics: AsymptoticKinematics,
    snrDb: z.number(),
    harmonicCount: z.number().int().min(1),
    ridgePoints: z.array(DopplerRidgePoint).readonly(),
  }),
);
export type DopplerObservation = z.infer<typeof DopplerObservation>;

/**
 * Quantized Shazam-style constellation hash entry linking two flyovers at a shared H3 cell.
 */
export const ConstellationEntry = define(
  z.object({
    hashKey: z.string().min(1),
    dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    h3Cell: z.string().min(1),
    centerLat: z.number().min(-90).max(90),
    centerLon: z.number().min(-180).max(180),
    segmentIdA: z.string().min(1),
    segmentIdB: z.string().min(1),
    speedAMps: z.number().positive(),
    speedBMps: z.number().positive(),
    cpaDelayedEpochSecA: z.number(),
    cpaDelayedEpochSecB: z.number(),
    deltaSec: z.number().positive(),
  }),
);
export type ConstellationEntry = z.infer<typeof ConstellationEntry>;

/**
 * Time interval within a listening episode where ambient noise was below the silence-gating threshold.
 */
export const QuietInterval = define(
  z.object({
    startSec: z.number(),
    endSec: z.number(),
    medianNoiseFloorDb: z.number(),
  }),
);
export type QuietInterval = z.infer<typeof QuietInterval>;

/**
 * Continuous listening window within a multi-episode pause/resume geolocation session.
 */
export const ListeningEpisode = define(
  z.object({
    id: z.string().min(1),
    startedAtSec: z.number(),
    endedAtSec: z.number(),
    status: z.enum(['active', 'paused', 'completed']),
    currentNoiseFloorDb: z.number(),
    noisePolluted: z.boolean(),
    quietIntervals: z.array(QuietInterval).readonly(),
  }),
);
export type ListeningEpisode = z.infer<typeof ListeningEpisode>;

/**
 * Passive Electrical Network Frequency (ENF) side-channel signature (50 Hz vs 60 Hz power grid).
 */
export const EnfSignature = define(
  z.object({
    detected: z.boolean(),
    nominalHz: z.enum(['50', '60', 'unknown']),
    measuredFreqHz: z.number().nonnegative(),
    snrDb: z.number(),
    regionHint: z.string(),
  }),
);
export type EnfSignature = z.infer<typeof EnfSignature>;

/**
 * Optional user or side-channel constraints over Space, Date, Time of Day, and Power Grid.
 */
export const SearchConstraints = define(
  z.object({
    minLat: z.number().min(-90).max(90).optional(),
    maxLat: z.number().min(-90).max(90).optional(),
    minLon: z.number().min(-180).max(180).optional(),
    maxLon: z.number().min(-180).max(180).optional(),
    dateFromIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateToIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    utcHourStart: z.number().min(0).max(24).optional(),
    utcHourEnd: z.number().min(0).max(24).optional(),
    enfNominalHz: z.enum(['50', '60']).optional(),
  }),
);
export type SearchConstraints = z.infer<typeof SearchConstraints>;

/**
 * Candidate observer location hypothesis with cumulative Bayesian log-posterior and 95% confidence ellipse.
 */
export const LocationHypothesis = define(
  z.object({
    id: z.string().min(1),
    h3Cell: z.string().min(1),
    dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    altMeters: z.number(),
    estimatedStartEpochSec: z.number(),
    logPosterior: z.number(),
    probability: z.number().min(0).max(1),
    rmsFreqResidualHz: z.number().nonnegative(),
    fisherInfo: z.tuple([z.number(), z.number(), z.number(), z.number()]).readonly(),
    ellipseSemiMajorMeters: z.number().positive(),
    ellipseSemiMinorMeters: z.number().positive(),
    ellipseBearingDeg: z.number(),
    matchedSegmentIds: z.array(z.string()).readonly(),
  }),
);
export type LocationHypothesis = z.infer<typeof LocationHypothesis>;

/**
 * Persistent, serializable geolocation session supporting continuous and episodic pause/resume refinement.
 */
export const LocationSession = define(
  z.object({
    id: z.string().min(1),
    createdAtEpochSec: z.number(),
    updatedAtEpochSec: z.number(),
    ambientTempCelsius: z.number(),
    constraints: SearchConstraints,
    enfSignature: EnfSignature,
    episodes: z.array(ListeningEpisode).readonly(),
    observations: z.array(DopplerObservation).readonly(),
    hypotheses: z.array(LocationHypothesis).readonly(),
  }),
);
export type LocationSession = z.infer<typeof LocationSession>;

/**
 * Portable dataset bundle containing 4D-RDP trajectory segments, constellation hash index, and elevation tiles.
 */
export const DopplerDataset = define(
  z.object({
    version: z.string().min(1),
    generatedAtIso: z.string().min(1),
    segments: z.array(LinearFlightSegment).readonly(),
    constellations: z.array(ConstellationEntry).readonly(),
    elevationGrid: z.array(GeoPoint3D).readonly(),
  }),
);
export type DopplerDataset = z.infer<typeof DopplerDataset>;
