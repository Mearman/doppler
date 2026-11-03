import { describe, expect, it } from 'vitest';
import { SYNTHETIC_GROUND_TRUTH, SYNTHETIC_SEGMENTS } from '../test-support/synthetic-reference';
import { ANALYSIS_SAMPLE_RATE_HZ, SPECTROGRAM_FFT_SIZE, SPECTROGRAM_HOP_SAMPLES } from './constants';
import { extractDopplerObservations } from './ridge-tracker';
import { synthesizeMultiFlyoverAudio } from './side-channels';
import { computeDopplerSpectrogram } from './spectrogram';

/** Length in seconds of the synthetic recording, long enough to hold the whole flyover. */
const RECORDING_DURATION_SEC = 180;

/** Arbitrary fixed epoch in seconds at which the synthetic recording starts. */
const RECORDING_START_EPOCH_SEC = 1_788_900_000;

/** Base frequency in Hz of the synthetic aircraft tone. */
const FLYOVER_BASE_FREQ_HZ = 110;

/** Amplitude of the synthetic aircraft tone in full-scale sample units. */
const FLYOVER_AMPLITUDE = 0.9;

/** Standard deviation of the synthetic background noise in full-scale sample units. */
const BACKGROUND_NOISE_STD = 0.003;

/** Lower edge in Hz of the band the spectrogram is limited to, below the tone. */
const BAND_MIN_FREQ_HZ = 60;

/** Upper edge in Hz of the band the spectrogram is limited to, above the tone's Doppler excursion. */
const BAND_MAX_FREQ_HZ = 200;

/** Fewest spectrogram frames the recording must yield: it holds hundreds of hop intervals. */
const MIN_FRAME_COUNT = 100;

/** Ridge-tracker SNR threshold in dB, lower than the default so that the synthetic ridge qualifies. */
const TRACKER_MIN_SNR_DB = 4;

/** Ridge-tracker minimum ridge duration in seconds, lower than the default so that the synthetic ridge qualifies. */
const TRACKER_MIN_DURATION_SEC = 5;

/** Bounds in metres per second on the speed inferred for the synthetic aircraft. */
const MIN_INFERRED_SPEED_MPS = 50;
const MAX_INFERRED_SPEED_MPS = 80;

/** Bounds in seconds on the closest-point-of-approach time inferred for the synthetic flyover. */
const MIN_CPA_TIME_SEC = 60;
const MAX_CPA_TIME_SEC = 120;

/** A hop that is not an integer, which the spectrogram must reject. */
const FRACTIONAL_HOP_SAMPLES = 2.5;

describe('Spectrogram and Ridge Tracking', () => {
  it('detects Doppler flyover S-curves from synthesized audio and extracts observations', () => {
    const [segment] = SYNTHETIC_SEGMENTS;
    if (segment === undefined) {
      throw new Error('SYNTHETIC_SEGMENTS holds no segment');
    }
    const audio = synthesizeMultiFlyoverAudio({
      sampleRateHz: ANALYSIS_SAMPLE_RATE_HZ,
      startEpochSec: RECORDING_START_EPOCH_SEC,
      durationSec: RECORDING_DURATION_SEC,
      observer: SYNTHETIC_GROUND_TRUTH,
      flyovers: [{ segment, baseFreqHz: FLYOVER_BASE_FREQ_HZ, amplitude: FLYOVER_AMPLITUDE }],
      noiseStd: BACKGROUND_NOISE_STD,
    });

    const spec = computeDopplerSpectrogram(audio, {
      sampleRateHz: ANALYSIS_SAMPLE_RATE_HZ,
      startTimeSec: 0,
      fftSize: SPECTROGRAM_FFT_SIZE,
      hopSamples: SPECTROGRAM_HOP_SAMPLES,
      minFreqHz: BAND_MIN_FREQ_HZ,
      maxFreqHz: BAND_MAX_FREQ_HZ,
    });

    expect(spec.frames.length).toBeGreaterThan(MIN_FRAME_COUNT);
    expect(spec.quietIntervals.length).toBeGreaterThan(0);

    const observations = extractDopplerObservations(spec, {
      episodeId: 'test_ep',
      minSnrDb: TRACKER_MIN_SNR_DB,
      minDurationSec: TRACKER_MIN_DURATION_SEC,
    });

    expect(observations.length).toBeGreaterThanOrEqual(1);
    const [obs] = observations;
    if (obs === undefined) {
      throw new Error('No observation was extracted');
    }
    expect(obs.kinematics.baseFreqHz).toBeCloseTo(FLYOVER_BASE_FREQ_HZ, 0);
    expect(obs.kinematics.inferredSpeedMps).toBeGreaterThan(MIN_INFERRED_SPEED_MPS);
    expect(obs.kinematics.inferredSpeedMps).toBeLessThan(MAX_INFERRED_SPEED_MPS);
    expect(obs.cpaTimeSec).toBeGreaterThan(MIN_CPA_TIME_SEC);
    expect(obs.cpaTimeSec).toBeLessThan(MAX_CPA_TIME_SEC);
  });

  it('rejects a hop that would never advance and a non-positive sample rate', () => {
    const audio = new Float32Array(SPECTROGRAM_FFT_SIZE * 2);

    expect(() => computeDopplerSpectrogram(audio, { sampleRateHz: ANALYSIS_SAMPLE_RATE_HZ, hopSamples: 0 })).toThrow('hopSamples');
    expect(() => computeDopplerSpectrogram(audio, { sampleRateHz: ANALYSIS_SAMPLE_RATE_HZ, hopSamples: FRACTIONAL_HOP_SAMPLES })).toThrow('hopSamples');
    expect(() => computeDopplerSpectrogram(audio, { sampleRateHz: 0 })).toThrow('Sample rate');
  });
});
