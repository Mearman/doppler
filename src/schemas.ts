import { z } from 'zod';
import { define } from './define';

/**
 * Northern limit of geodetic latitude in degrees: the North Pole.
 */
const MAX_LATITUDE_DEGREES = 90;

/**
 * Southern limit of geodetic latitude in degrees: the South Pole, symmetric with the northern limit.
 */
const MIN_LATITUDE_DEGREES = -MAX_LATITUDE_DEGREES;

/**
 * Eastern limit of geodetic longitude in degrees: the antimeridian, half a full turn of 360 degrees from the prime meridian.
 */
const MAX_LONGITUDE_DEGREES = 180;

/**
 * Western limit of geodetic longitude in degrees, symmetric with the eastern limit.
 */
const MIN_LONGITUDE_DEGREES = -MAX_LONGITUDE_DEGREES;

/**
 * Lowest accepted altitude above the WGS84 ellipsoid in metres: a design margin below the deepest exposed land depression (the Dead Sea shore, about 430 m below sea level) so that real terrain-level observers are never rejected.
 */
const MIN_ALTITUDE_METERS = -500;

/**
 * Highest accepted altitude above the WGS84 ellipsoid in metres: a design ceiling of 60 km, well above any aircraft service ceiling and so a safe bound that still rejects corrupt altitude values.
 */
const MAX_ALTITUDE_METERS = 60_000;

/**
 * Hours in a UTC day: the upper bound of a time-of-day hour value, where 24 denotes the end of the day.
 */
const HOURS_PER_DAY = 24;

/**
 * Geodetic 3D coordinate on or above the WGS84 reference ellipsoid.
 */
export const GeoPoint3DSchema = define(
  z.object({
    lat: z.number().min(MIN_LATITUDE_DEGREES).max(MAX_LATITUDE_DEGREES),
    lon: z.number().min(MIN_LONGITUDE_DEGREES).max(MAX_LONGITUDE_DEGREES),
    altMeters: z.number().min(MIN_ALTITUDE_METERS).max(MAX_ALTITUDE_METERS),
  }),
);
export type GeoPoint3D = z.infer<typeof GeoPoint3DSchema>;

/**
 * 3D Cartesian vector in Earth-Centered, Earth-Fixed (ECEF) or local East-North-Up (ENU) coordinates.
 */
export const Vector3DSchema = define(
  z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
);
export type Vector3D = z.infer<typeof Vector3DSchema>;

/**
 * Aircraft propulsion category used to filter acoustic candidates.
 */
export const AircraftCategorySchema = define(z.enum(['piston', 'turboprop', 'helicopter', 'jet', 'unknown']));
export type AircraftCategory = z.infer<typeof AircraftCategorySchema>;

/**
 * Raw 1 Hz ADS-B state vector prior to 4D Ramer-Douglas-Peucker simplification.
 */
export const AdsbPingSchema = define(
  z.object({
    epochSec: z.number(),
    lat: z.number().min(MIN_LATITUDE_DEGREES).max(MAX_LATITUDE_DEGREES),
    lon: z.number().min(MIN_LONGITUDE_DEGREES).max(MAX_LONGITUDE_DEGREES),
    altMeters: z.number(),
  }),
);
export type AdsbPing = z.infer<typeof AdsbPingSchema>;

/**
 * Piecewise-linear 4D aircraft trajectory segment produced by Ramer-Douglas-Peucker compression.
 */
export const LinearFlightSegmentSchema = define(
  z.object({
    id: z.string().min(1),
    flightId: z.string().min(1),
    icao24: z.string().min(1),
    typeCode: z.string(),
    category: AircraftCategorySchema,
    dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startEpochSec: z.number(),
    endEpochSec: z.number(),
    startGeo: GeoPoint3DSchema,
    endGeo: GeoPoint3DSchema,
    groundspeedMps: z.number().nonnegative(),
    h3Cell: z.string().min(1),
  }),
);
export type LinearFlightSegment = z.infer<typeof LinearFlightSegmentSchema>;

/**
 * Single time-frequency point along an extracted spectrogram Doppler ridge.
 */
export const DopplerRidgePointSchema = define(
  z.object({
    timeSec: z.number(),
    freqHz: z.number().positive(),
    snrDb: z.number(),
  }),
);
export type DopplerRidgePoint = z.infer<typeof DopplerRidgePointSchema>;

/**
 * Closed-form kinematic parameters extracted algebraically from a single Doppler S-curve.
 */
export const AsymptoticKinematicsSchema = define(
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
export type AsymptoticKinematics = z.infer<typeof AsymptoticKinematicsSchema>;

/**
 * Complete acoustic observation of an aircraft flyover extracted from an audio stream or file.
 */
export const DopplerObservationSchema = define(
  z.object({
    id: z.string().min(1),
    episodeId: z.string().min(1),
    cpaTimeSec: z.number(),
    kinematics: AsymptoticKinematicsSchema,
    snrDb: z.number(),
    harmonicCount: z.number().int().min(1),
    ridgePoints: z.array(DopplerRidgePointSchema).readonly(),
  }),
);
export type DopplerObservation = z.infer<typeof DopplerObservationSchema>;

/**
 * Quantized Shazam-style constellation hash entry linking two flyovers at a shared H3 cell.
 */
export const ConstellationEntrySchema = define(
  z.object({
    hashKey: z.string().min(1),
    dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    h3Cell: z.string().min(1),
    centerLat: z.number().min(MIN_LATITUDE_DEGREES).max(MAX_LATITUDE_DEGREES),
    centerLon: z.number().min(MIN_LONGITUDE_DEGREES).max(MAX_LONGITUDE_DEGREES),
    segmentIdA: z.string().min(1),
    segmentIdB: z.string().min(1),
    speedAMps: z.number().positive(),
    speedBMps: z.number().positive(),
    cpaDelayedEpochSecA: z.number(),
    cpaDelayedEpochSecB: z.number(),
    deltaSec: z.number().positive(),
  }),
);
export type ConstellationEntry = z.infer<typeof ConstellationEntrySchema>;

/**
 * Time interval within a listening episode where ambient noise was below the silence-gating threshold.
 */
export const QuietIntervalSchema = define(
  z.object({
    startSec: z.number(),
    endSec: z.number(),
    medianNoiseFloorDb: z.number(),
  }),
);
export type QuietInterval = z.infer<typeof QuietIntervalSchema>;

/**
 * Continuous listening window within a multi-episode pause/resume geolocation session.
 */
export const ListeningEpisodeSchema = define(
  z.object({
    id: z.string().min(1),
    startedAtSec: z.number(),
    endedAtSec: z.number(),
    status: z.enum(['active', 'paused', 'completed']),
    currentNoiseFloorDb: z.number(),
    noisePolluted: z.boolean(),
    quietIntervals: z.array(QuietIntervalSchema).readonly(),
  }),
);
export type ListeningEpisode = z.infer<typeof ListeningEpisodeSchema>;

/**
 * Passive Electrical Network Frequency (ENF) side-channel signature (50 Hz vs 60 Hz power grid).
 */
export const EnfSignatureSchema = define(
  z.object({
    detected: z.boolean(),
    nominalHz: z.enum(['50', '60', 'unknown']),
    measuredFreqHz: z.number().nonnegative(),
    snrDb: z.number(),
    regionHint: z.string(),
  }),
);
export type EnfSignature = z.infer<typeof EnfSignatureSchema>;

/**
 * Optional user or side-channel constraints over Space, Date, Time of Day, and Power Grid.
 */
export const SearchConstraintsSchema = define(
  z.object({
    minLat: z.number().min(MIN_LATITUDE_DEGREES).max(MAX_LATITUDE_DEGREES).optional(),
    maxLat: z.number().min(MIN_LATITUDE_DEGREES).max(MAX_LATITUDE_DEGREES).optional(),
    minLon: z.number().min(MIN_LONGITUDE_DEGREES).max(MAX_LONGITUDE_DEGREES).optional(),
    maxLon: z.number().min(MIN_LONGITUDE_DEGREES).max(MAX_LONGITUDE_DEGREES).optional(),
    dateFromIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateToIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    utcHourStart: z.number().min(0).max(HOURS_PER_DAY).optional(),
    utcHourEnd: z.number().min(0).max(HOURS_PER_DAY).optional(),
    enfNominalHz: z.enum(['50', '60']).optional(),
  }),
);
export type SearchConstraints = z.infer<typeof SearchConstraintsSchema>;

/**
 * A flyover observation attributed to a flight segment under a location hypothesis. Matches are keyed by observation id, never by position, because an observation that fits no segment is absent from a hypothesis and would shift every later index.
 */
export const HypothesisMatchSchema = define(
  z.object({
    observationId: z.string().min(1),
    segmentId: z.string().min(1),
  }),
);
export type HypothesisMatch = z.infer<typeof HypothesisMatchSchema>;

/**
 * Candidate observer location hypothesis with cumulative Bayesian log-posterior and 95% confidence ellipse.
 */
export const LocationHypothesisSchema = define(
  z.object({
    id: z.string().min(1),
    h3Cell: z.string().min(1),
    dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lat: z.number().min(MIN_LATITUDE_DEGREES).max(MAX_LATITUDE_DEGREES),
    lon: z.number().min(MIN_LONGITUDE_DEGREES).max(MAX_LONGITUDE_DEGREES),
    altMeters: z.number(),
    estimatedStartEpochSec: z.number(),
    logPosterior: z.number(),
    probability: z.number().min(0).max(1),
    rmsFreqResidualHz: z.number().nonnegative(),
    fisherInfo: z.tuple([z.number(), z.number(), z.number(), z.number()]).readonly(),
    ellipseSemiMajorMeters: z.number().positive(),
    ellipseSemiMinorMeters: z.number().positive(),
    ellipseBearingDeg: z.number(),
    matches: z.array(HypothesisMatchSchema).readonly(),
  }),
);
export type LocationHypothesis = z.infer<typeof LocationHypothesisSchema>;

/**
 * Persistent, serializable geolocation session supporting continuous and episodic pause/resume refinement.
 */
export const LocationSessionSchema = define(
  z.object({
    id: z.string().min(1),
    createdAtEpochSec: z.number(),
    updatedAtEpochSec: z.number(),
    ambientTempCelsius: z.number(),
    constraints: SearchConstraintsSchema,
    enfSignature: EnfSignatureSchema,
    episodes: z.array(ListeningEpisodeSchema).readonly(),
    observations: z.array(DopplerObservationSchema).readonly(),
    hypotheses: z.array(LocationHypothesisSchema).readonly(),
  }),
);
export type LocationSession = z.infer<typeof LocationSessionSchema>;

/**
 * Portable dataset bundle containing 4D-RDP trajectory segments, constellation hash index, and elevation tiles.
 */
export const DopplerDatasetSchema = define(
  z.object({
    version: z.string().min(1),
    generatedAtIso: z.string().min(1),
    segments: z.array(LinearFlightSegmentSchema).readonly(),
    constellations: z.array(ConstellationEntrySchema).readonly(),
    elevationGrid: z.array(GeoPoint3DSchema).readonly(),
  }),
);
export type DopplerDataset = z.infer<typeof DopplerDatasetSchema>;
