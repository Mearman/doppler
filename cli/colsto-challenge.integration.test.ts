import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decimateAudioStream } from '../src/dsp/decimate';
import { extractDopplerObservations } from '../src/dsp/ridge-tracker';
import { detectEnfSignature } from '../src/dsp/side-channels';
import { computeDopplerSpectrogram } from '../src/dsp/spectrogram';
import { readWavFile } from '../src/node/entry';
import { LocationSession } from '../src/schemas';

describe('Colsto YouTube Geolocation Challenge Audio Verification', { timeout: 60000 }, () => {
  const fullAudioPath = join(import.meta.dirname, '../fixtures/colsto-unknown-location-raw-audio.wav');
  const snippetAudioPath = join(import.meta.dirname, '../fixtures/colsto-flyover-36m.wav');

  it('detects 60 Hz ENF power grid hum signature from colsto challenge recording', () => {
    if (!existsSync(fullAudioPath)) {
      // Skip if full 300MB fixture is absent in environment
      return;
    }

    const { samples, sampleRateHz } = readWavFile(fullAudioPath);
    expect(sampleRateHz).toBe(44100);
    expect(samples.length / sampleRateHz).toBeGreaterThanOrEqual(3600);

    // Analyze first 5 minutes for passive power grid mains hum
    const decimated = decimateAudioStream(samples.subarray(0, sampleRateHz * 300), sampleRateHz, 2000);
    const enf = detectEnfSignature(decimated.samples, 2000);

    expect(enf.detected).toBe(true);
    expect(enf.nominalHz).toBe('60');
    expect(enf.snrDb).toBeGreaterThanOrEqual(8.0);
    expect(enf.regionHint).toContain('60 Hz Grid');
  });

  it('detects the primary aircraft flyover S-curve at 36:00 from the colsto audio clip', () => {
    if (!existsSync(snippetAudioPath)) {
      return;
    }

    const { samples, sampleRateHz } = readWavFile(snippetAudioPath);
    const decimated = decimateAudioStream(samples, sampleRateHz, 2000);
    const spec = computeDopplerSpectrogram(decimated.samples, {
      sampleRateHz: 2000,
      startTimeSec: 2130,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 65,
      maxFreqHz: 450,
    });

    const observations = extractDopplerObservations(spec, { episodeId: 'colsto_snippet', minSnrDb: 6.0 });
    expect(observations.length).toBeGreaterThanOrEqual(1);

    const primary = observations.find((o) => o.kinematics.baseFreqHz > 105 && o.kinematics.baseFreqHz < 120);
    expect(primary).toBeDefined();

    if (primary !== undefined) {
      expect(primary.cpaTimeSec).toBeCloseTo(2156.0, 0);
      expect(primary.kinematics.baseFreqHz).toBeCloseTo(111.6, 0);
      expect(primary.kinematics.inferredSpeedMps).toBeGreaterThan(30.0);
      expect(primary.kinematics.inferredSpeedMps).toBeLessThan(50.0);
      expect(primary.snrDb).toBeGreaterThan(25.0);
    }
  });

  it('runs doppler CLI locate on the colsto flyover snippet and outputs valid JSON session', () => {
    if (!existsSync(snippetAudioPath)) {
      return;
    }

    const jsonOut = execSync(`npx tsx cli/doppler.ts locate "${snippetAudioPath}" --json`, { encoding: 'utf8' });
    const session = LocationSession.parse(JSON.parse(jsonOut));
    expect(session.observations.length).toBeGreaterThanOrEqual(1);
  });
});
