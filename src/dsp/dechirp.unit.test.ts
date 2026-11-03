import { describe, expect, it } from 'vitest';
import { BUNDLED_GROUND_TRUTH, BUNDLED_SEGMENTS } from '../bundled';
import { scoreByEmissionDechirping } from './dechirp';
import { synthesizeMultiFlyoverAudio } from './side-channels';

describe('scoreByEmissionDechirping', () => {
  it('achieves strong coherent SNR gain at true observer coordinate and collapses tone to base frequency', () => {
    const sampleRateHz = 2000;
    const durationSec = 180;
    const seg = BUNDLED_SEGMENTS[0]!;
    const audio = synthesizeMultiFlyoverAudio({
      sampleRateHz,
      startEpochSec: 1788900000,
      durationSec,
      observer: BUNDLED_GROUND_TRUTH,
      flyovers: [{ segment: seg, baseFreqHz: 110.0, amplitude: 0.8 }],
      noiseStd: 0.005,
    });

    const score = scoreByEmissionDechirping(audio, {
      sampleRateHz,
      bufferStartEpochSec: 1788900000,
      observer: BUNDLED_GROUND_TRUTH,
      segment: seg,
      expectedBaseFreqHz: 110.0,
      soundSpeedMps: 343.0,
    });

    expect(score.coherentSnrDb).toBeGreaterThan(15.0);
    expect(score.recoveredBaseFreqHz).toBeCloseTo(110.0, 0);
  });
});
