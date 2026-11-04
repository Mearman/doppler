import { z } from 'zod';
import { DatasetInfoSchema, DopplerDatasetSchema, DopplerObservationSchema, EnfSignatureSchema, LocationSessionSchema, SearchConstraintsSchema } from '../../src/schemas';

/**
 * The messages between the page and the solver worker, defined once so that both sides parse the same shapes.
 * A request is `{ id, type, payload }` and every reply echoes the request's `id`.
 */

/** A `Float32Array` of any backing buffer: `z.instanceof` would infer the narrower `Float32Array<ArrayBuffer>`, which the decoder's samples are not typed as. */
const Float32ArraySchema = z.custom<Float32Array>((value) => value instanceof Float32Array);

/** A `Float64Array` of any backing buffer, for the same reason as `Float32ArraySchema`. */
const Float64ArraySchema = z.custom<Float64Array>((value) => value instanceof Float64Array);

/** The `id` every request carries, which a reply echoes. Parsed alone so that a malformed request can still be answered. */
export const RequestEnvelopeSchema = z.object({ id: z.string() });

/** Replaces the worker's dataset. */
const SetDatasetRequestSchema = z.object({ id: z.string(), type: z.literal('set_dataset'), payload: DopplerDatasetSchema });

/** Starts a session, optionally resuming a saved one. */
const InitSessionRequestSchema = z.object({
  id: z.string(),
  type: z.literal('init_session'),
  payload: z.object({
    initialSession: LocationSessionSchema.optional(),
    constraints: SearchConstraintsSchema.optional(),
    tempCelsius: z.number().optional(),
  }),
});

/** Changes the search constraints of the session. */
const UpdateConstraintsRequestSchema = z.object({ id: z.string(), type: z.literal('update_constraints'), payload: SearchConstraintsSchema });

/** Updates the ambient temperature of the session in degrees Celsius. */
const SetTemperatureRequestSchema = z.object({ id: z.string(), type: z.literal('set_temperature'), payload: z.number() });

/** Adds one observation, for example from the live microphone, to the session. */
const IngestObservationRequestSchema = z.object({ id: z.string(), type: z.literal('ingest_observation'), payload: DopplerObservationSchema });

/** Analyses decoded audio. `rawSamples` is transferred to the worker rather than copied. */
const ProcessAudioRequestSchema = z.object({
  id: z.string(),
  type: z.literal('process_audio'),
  payload: z.object({
    rawSamples: Float32ArraySchema,
    sampleRateHz: z.number(),
    startEpochSec: z.number(),
    episodeId: z.string(),
  }),
});

/** Analyses a WAV file's bytes, decoding them in the worker so that a long recording does not block the page. `bytes` is transferred to the worker rather than copied. */
const ProcessWavRequestSchema = z.object({
  id: z.string(),
  type: z.literal('process_wav'),
  payload: z.object({
    bytes: z.custom<ArrayBuffer>((value) => value instanceof ArrayBuffer),
    startEpochSec: z.number(),
    episodeId: z.string(),
  }),
});

/** A request from the page to the worker. */
export const WorkerRequestSchema = z.discriminatedUnion('type', [
  SetDatasetRequestSchema,
  InitSessionRequestSchema,
  UpdateConstraintsRequestSchema,
  SetTemperatureRequestSchema,
  IngestObservationRequestSchema,
  ProcessAudioRequestSchema,
  ProcessWavRequestSchema,
]);
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

/** One short-time Fourier transform frame of the analysed clip. */
const SpectrogramFrameSchema = z.object({
  timeSec: z.number(),
  powerDb: Float64ArraySchema,
  medianNoiseFloorDb: z.number(),
  peakFreqHz: z.number(),
  peakPowerDb: z.number(),
  peakSnrDb: z.number(),
  noisePolluted: z.boolean(),
});

/** What the worker returns for analysed audio: the session, the observations found, the grid mains frequency and the spectrogram to draw. */
const AudioAnalysisSchema = z.object({
  session: LocationSessionSchema,
  observations: z.array(DopplerObservationSchema),
  enf: EnfSignatureSchema,
  spectrogram: z.object({
    minFreqHz: z.number(),
    maxFreqHz: z.number(),
    binStepHz: z.number(),
    minBin: z.number(),
    maxBin: z.number(),
    overallMedianNoiseDb: z.number(),
    frames: z.array(SpectrogramFrameSchema).readonly(),
  }),
  spectrogramSummary: z.object({
    frameCount: z.number(),
    quietIntervalsCount: z.number(),
    medianNoiseDb: z.number(),
  }),
});
export type AudioAnalysis = z.infer<typeof AudioAnalysisSchema>;

/** The stages of an audio analysis in the order the worker runs them, so a reply names how far along it is. */
export const ANALYSIS_STAGES = ['decoding', 'decimating', 'spectrogram', 'tracking', 'locating'] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

/** A reply from the worker to the page. */
export const WorkerReplySchema = z.union([
  z.object({ id: z.string(), success: z.literal(true), type: z.literal('progress'), stage: z.enum(ANALYSIS_STAGES) }),
  z.object({ id: z.string(), success: z.literal(true), type: z.literal('dataset_updated'), info: DatasetInfoSchema }),
  z.object({ id: z.string(), success: z.literal(true), type: z.literal('session'), data: LocationSessionSchema }),
  z.object({ id: z.string(), success: z.literal(true), type: z.literal('audio_analysed'), data: AudioAnalysisSchema }),
  z.object({ id: z.string(), success: z.literal(false), error: z.string() }),
]);
export type WorkerReply = z.infer<typeof WorkerReplySchema>;
