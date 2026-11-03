import { describe, expect, it } from 'vitest';
import { SYNTHETIC_GROUND_TRUTH, SYNTHETIC_SEGMENTS } from '../test-support/synthetic-reference';
import { ANALYSIS_SAMPLE_RATE_HZ, SPEED_OF_SOUND_MPS } from './constants';
import { scoreByEmissionDechirping } from './dechirp';
import { synthesizeMultiFlyoverAudio } from './side-channels';

/** Length in seconds of the synthetic recording, long enough to hold the whole flyover. */
const RECORDING_DURATION_SEC = 180;

/** Arbitrary fixed epoch in seconds at which the synthetic recording starts. */
const RECORDING_START_EPOCH_SEC = 1_788_900_000;

/** Base frequency in Hz of the synthetic aircraft tone. */
const FLYOVER_BASE_FREQ_HZ = 110;

/** Amplitude of the synthetic aircraft tone in full-scale sample units. */
const FLYOVER_AMPLITUDE = 0.8;

/** Standard deviation of the synthetic background noise in full-scale sample units. */
const BACKGROUND_NOISE_STD = 0.005;

/** Coherent SNR in dB that de-chirping at the true observer must exceed. */
const MIN_COHERENT_SNR_DB = 15;

describe('scoreByEmissionDechirping', () => {
  it('achieves strong coherent SNR gain at true observer coordinate and collapses tone to base frequency', () => {
    const [seg] = SYNTHETIC_SEGMENTS;
    if (seg === undefined) {
      throw new Error('SYNTHETIC_SEGMENTS holds no segment');
    }
    const audio = synthesizeMultiFlyoverAudio({
      sampleRateHz: ANALYSIS_SAMPLE_RATE_HZ,
      startEpochSec: RECORDING_START_EPOCH_SEC,
      durationSec: RECORDING_DURATION_SEC,
      observer: SYNTHETIC_GROUND_TRUTH,
      flyovers: [{ segment: seg, baseFreqHz: FLYOVER_BASE_FREQ_HZ, amplitude: FLYOVER_AMPLITUDE }],
      noiseStd: BACKGROUND_NOISE_STD,
    });

    const score = scoreByEmissionDechirping(audio, {
      sampleRateHz: ANALYSIS_SAMPLE_RATE_HZ,
      bufferStartEpochSec: RECORDING_START_EPOCH_SEC,
      observer: SYNTHETIC_GROUND_TRUTH,
      segment: seg,
      expectedBaseFreqHz: FLYOVER_BASE_FREQ_HZ,
      soundSpeedMps: SPEED_OF_SOUND_MPS,
    });

    expect(score.coherentSnrDb).toBeGreaterThan(MIN_COHERENT_SNR_DB);
    expect(score.recoveredBaseFreqHz).toBeCloseTo(FLYOVER_BASE_FREQ_HZ, 0);
  });
});
