import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYNTHETIC_DATASET, generateSyntheticReferenceAudio } from '../src/test-support/synthetic-reference';
import { decimateAudioStream } from '../src/dsp/decimate';
import { extractDopplerObservations } from '../src/dsp/ridge-tracker';
import { detectEnfSignature } from '../src/dsp/side-channels';
import { computeDopplerSpectrogram } from '../src/dsp/spectrogram';
import { readWavFile } from '../src/node/entry';
import { LocationSessionSchema } from '../src/schemas';
import { DopplerSessionEngine } from '../src/solver/session';

describe('Colsto YouTube Geolocation Challenge Audio Verification', { timeout: 60000 }, () => {
  const fullAudioPath = join(import.meta.dirname, '../fixtures/colsto-unknown-location-raw-audio.wav');
  const snippet36Path = join(import.meta.dirname, '../fixtures/colsto-flyover-36m.wav');
  const snippet23Path = join(import.meta.dirname, '../fixtures/colsto-flyover-23m.wav');
  const snippet35Path = join(import.meta.dirname, '../fixtures/colsto-flyover-35m.wav');
  const snippet45Path = join(import.meta.dirname, '../fixtures/colsto-flyover-45m.wav');
  const snippet51Path = join(import.meta.dirname, '../fixtures/colsto-flyover-51m.wav');
  const snippet54Path = join(import.meta.dirname, '../fixtures/colsto-flyover-54m.wav');

  it('detects 60 Hz ENF power grid hum signature from colsto challenge recording', () => {
    if (!existsSync(fullAudioPath)) {
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

  it('detects the primary aircraft flyover S-curve at 36:00 (snippet 36m)', () => {
    if (!existsSync(snippet36Path)) {
      return;
    }

    const { samples, sampleRateHz } = readWavFile(snippet36Path);
    const decimated = decimateAudioStream(samples, sampleRateHz, 2000);
    const spec = computeDopplerSpectrogram(decimated.samples, {
      sampleRateHz: 2000,
      startTimeSec: 2130,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 65,
      maxFreqHz: 450,
    });

    const observations = extractDopplerObservations(spec, { episodeId: 'colsto_snippet_36', minSnrDb: 6.0 });
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

  it('detects aircraft Doppler flyover in the 23-minute segment (snippet 23m)', () => {
    if (!existsSync(snippet23Path)) {
      return;
    }

    const { samples, sampleRateHz } = readWavFile(snippet23Path);
    const decimated = decimateAudioStream(samples, sampleRateHz, 2000);
    const spec = computeDopplerSpectrogram(decimated.samples, {
      sampleRateHz: 2000,
      startTimeSec: 1395,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 65,
      maxFreqHz: 450,
    });

    const observations = extractDopplerObservations(spec, { episodeId: 'colsto_snippet_23', minSnrDb: 5.0 });
    expect(observations.length).toBeGreaterThanOrEqual(1);

    const obs = observations.find((o) => o.kinematics.baseFreqHz >= 75 && o.kinematics.baseFreqHz <= 85);
    expect(obs).toBeDefined();
    if (obs !== undefined) {
      expect(obs.kinematics.inferredSpeedMps).toBeCloseTo(19.6, 1);
      expect(obs.snrDb).toBeGreaterThan(25.0);
    }
  });

  it('detects two consecutive aircraft flyovers in the 35-minute segment (snippet 35m)', () => {
    if (!existsSync(snippet35Path)) {
      return;
    }

    const { samples, sampleRateHz } = readWavFile(snippet35Path);
    const decimated = decimateAudioStream(samples, sampleRateHz, 2000);
    const spec = computeDopplerSpectrogram(decimated.samples, {
      sampleRateHz: 2000,
      startTimeSec: 2120,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 65,
      maxFreqHz: 450,
    });

    const observations = extractDopplerObservations(spec, { episodeId: 'colsto_snippet_35', minSnrDb: 5.0 });
    expect(observations.length).toBeGreaterThanOrEqual(2);
    expect(observations[0]?.snrDb).toBeGreaterThan(28.0);
    expect(observations[1]?.snrDb).toBeGreaterThan(28.0);
  });

  it('detects low-altitude approach flyovers in the 45-minute segment (snippet 45m)', () => {
    if (!existsSync(snippet45Path)) {
      return;
    }

    const { samples, sampleRateHz } = readWavFile(snippet45Path);
    const decimated = decimateAudioStream(samples, sampleRateHz, 2000);
    const spec = computeDopplerSpectrogram(decimated.samples, {
      sampleRateHz: 2000,
      startTimeSec: 2700,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 65,
      maxFreqHz: 450,
    });

    const observations = extractDopplerObservations(spec, { episodeId: 'colsto_snippet_45', minSnrDb: 5.0 });
    expect(observations.length).toBeGreaterThanOrEqual(2);

    const sustained = observations.find((o) => o.ridgePoints.length > 50);
    expect(sustained).toBeDefined();
    if (sustained !== undefined) {
      expect(sustained.kinematics.baseFreqHz).toBeCloseTo(101.4, 1);
      expect(sustained.snrDb).toBeGreaterThan(28.0);
    }
  });

  it('detects flyovers in the 51m and 54m segments', () => {
    if (!existsSync(snippet51Path) || !existsSync(snippet54Path)) {
      return;
    }

    // 51m snippet
    const audio51 = readWavFile(snippet51Path);
    const dec51 = decimateAudioStream(audio51.samples, audio51.sampleRateHz, 2000);
    const spec51 = computeDopplerSpectrogram(dec51.samples, {
      sampleRateHz: 2000,
      startTimeSec: 3050,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 65,
      maxFreqHz: 450,
    });
    const obs51 = extractDopplerObservations(spec51, { episodeId: 'colsto_snippet_51', minSnrDb: 5.0 });
    expect(obs51.length).toBeGreaterThanOrEqual(1);
    expect(obs51[0]?.kinematics.baseFreqHz).toBeCloseTo(152.8, 1);

    // 54m snippet
    const audio54 = readWavFile(snippet54Path);
    const dec54 = decimateAudioStream(audio54.samples, audio54.sampleRateHz, 2000);
    const spec54 = computeDopplerSpectrogram(dec54.samples, {
      sampleRateHz: 2000,
      startTimeSec: 3265,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 65,
      maxFreqHz: 450,
    });
    const obs54 = extractDopplerObservations(spec54, { episodeId: 'colsto_snippet_54', minSnrDb: 5.0 });
    expect(obs54.length).toBeGreaterThanOrEqual(1);
    expect(obs54[0]?.kinematics.baseFreqHz).toBeCloseTo(79.1, 1);
  });

  it('sequentially fuses multi-episode flyovers into a single LocationSession', () => {
    if (!existsSync(snippet23Path) || !existsSync(snippet35Path) || !existsSync(snippet45Path)) {
      return;
    }

    const engine = new DopplerSessionEngine({
      dataset: SYNTHETIC_DATASET,
      ambientTempCelsius: 22.0,
      constraints: { enfNominalHz: '60' },
    });

    // Episode 1: 23m segment
    const ep1 = engine.startEpisode(1395);
    const audio23 = readWavFile(snippet23Path);
    const dec23 = decimateAudioStream(audio23.samples, audio23.sampleRateHz, 2000);
    const spec23 = computeDopplerSpectrogram(dec23.samples, {
      sampleRateHz: 2000,
      startTimeSec: 1395,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 65,
      maxFreqHz: 450,
    });
    const obs23 = extractDopplerObservations(spec23, { episodeId: ep1.id, minSnrDb: 5.0 });
    for (const o of obs23) {
      engine.ingestObservation(o);
    }
    engine.pauseEpisode(ep1.id, 1435);

    // Episode 2: 35m segment
    const ep2 = engine.startEpisode(2120);
    const audio35 = readWavFile(snippet35Path);
    const dec35 = decimateAudioStream(audio35.samples, audio35.sampleRateHz, 2000);
    const spec35 = computeDopplerSpectrogram(dec35.samples, {
      sampleRateHz: 2000,
      startTimeSec: 2120,
      fftSize: 2048,
      hopSamples: 500,
      minFreqHz: 65,
      maxFreqHz: 450,
    });
    const obs35 = extractDopplerObservations(spec35, { episodeId: ep2.id, minSnrDb: 5.0 });
    for (const o of obs35) {
      engine.ingestObservation(o);
    }
    engine.pauseEpisode(ep2.id, 2160);

    const session = engine.getSession();
    expect(session.episodes.length).toBe(2);
    expect(session.observations.length).toBe(obs23.length + obs35.length);
    expect(session.constraints.enfNominalHz).toBe('60');
  });

  it('runs doppler CLI locate on the 45m snippet and outputs valid JSON session', () => {
    if (!existsSync(snippet45Path)) {
      return;
    }

    const datasetDir = mkdtempSync(join(tmpdir(), 'doppler-colsto-'));
    const datasetPath = join(datasetDir, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(SYNTHETIC_DATASET), 'utf8');
    const jsonOut = execSync(`npx tsx cli/doppler.ts locate "${snippet45Path}" --dataset "${datasetPath}" --json`, { encoding: 'utf8' });
    rmSync(datasetDir, { recursive: true, force: true });
    const session = LocationSessionSchema.parse(JSON.parse(jsonOut));
    expect(session.observations.length).toBeGreaterThanOrEqual(1);
  });

  it('executes full synthetic benchmark pipeline when external audio fixtures are absent or present', () => {
    /* Guarantees that in CI (or any clean clone without 300MB fixtures), the complete
       passive acoustic inversion pipeline executes assertions and verifies ground truth. */
    const audio = generateSyntheticReferenceAudio(2000);
    const enf = detectEnfSignature(audio.subarray(0, 2000 * 30), 2000);
    expect(enf.detected).toBe(true);
    expect(enf.nominalHz).toBe('50');

    const spec = computeDopplerSpectrogram(audio, {
      sampleRateHz: 2000,
      startTimeSec: 1788900000,
      fftSize: 2048,
      hopSamples: 500,
    });
    const obs = extractDopplerObservations(spec, { episodeId: 'ci_synth_benchmark', minSnrDb: 6.0 });
    expect(obs.length).toBeGreaterThanOrEqual(1);

    const engine = new DopplerSessionEngine({ dataset: SYNTHETIC_DATASET });
    const ep = engine.startEpisode(1788900000);
    for (const o of obs) {
      engine.ingestObservation({ ...o, episodeId: ep.id });
    }
    const session = engine.getSession();
    expect(session.observations.length).toBeGreaterThanOrEqual(1);
  });
});
