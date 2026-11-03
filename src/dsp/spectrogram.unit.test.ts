import { describe, expect, it } from 'vitest';
import { BUNDLED_GROUND_TRUTH, BUNDLED_SEGMENTS } from '../bundled';
import { extractDopplerObservations } from './ridge-tracker';
import { synthesizeMultiFlyoverAudio } from './side-channels';
import { computeDopplerSpectrogram } from './spectrogram';

describe('Spectrogram and Ridge Tracking', () => {
  it('detects Doppler flyover S-curves from synthesized audio and extracts observations', () => {
    const sampleRateHz = 2000;
    const durationSec = 180;
    const audio = synthesizeMultiFlyoverAudio({
      sampleRateHz,
      startEpochSec: 1788900000,
      durationSec,
      observer: BUNDLED_GROUND_TRUTH,
      flyovers: [{ segment: BUNDLED_SEGMENTS[0]!, baseFreqHz: 110.0, amplitude: 0.9 }],
      noiseStd: 0.003,
    });

    const spec = computeDopplerSpectrogram(audio, {
      sampleRateHz,
      startTimeSec: 0,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 60,
      maxFreqHz: 200,
    });

    expect(spec.frames.length).toBeGreaterThan(100);
    expect(spec.quietIntervals.length).toBeGreaterThan(0);

    const observations = extractDopplerObservations(spec, {
      episodeId: 'test_ep',
      minSnrDb: 4.0,
      minDurationSec: 5.0,
    });

    expect(observations.length).toBeGreaterThanOrEqual(1);
    const obs = observations[0]!;
    expect(obs.kinematics.baseFreqHz).toBeCloseTo(110.0, 0);
    expect(obs.kinematics.inferredSpeedMps).toBeGreaterThan(50);
    expect(obs.kinematics.inferredSpeedMps).toBeLessThan(80);
    expect(obs.cpaTimeSec).toBeGreaterThan(60);
    expect(obs.cpaTimeSec).toBeLessThan(120);
  });

  it('rejects a hop that would never advance and a non-positive sample rate', () => {
    const audio = new Float32Array(4096);

    expect(() => computeDopplerSpectrogram(audio, { sampleRateHz: 2000, hopSamples: 0 })).toThrow('hopSamples');
    expect(() => computeDopplerSpectrogram(audio, { sampleRateHz: 2000, hopSamples: 2.5 })).toThrow('hopSamples');
    expect(() => computeDopplerSpectrogram(audio, { sampleRateHz: 0 })).toThrow('Sample rate');
  });
});
