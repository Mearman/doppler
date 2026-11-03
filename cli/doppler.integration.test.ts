import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SYNTHETIC_DATASET, SYNTHETIC_GROUND_TRUTH, SYNTHETIC_SEGMENTS } from '../src/test-support/synthetic-reference';
import { synthesizeMultiFlyoverAudio } from '../src/dsp/side-channels';
import { writeWavFile } from '../src/node/entry';
import { DopplerDatasetSchema, LocationSessionSchema } from '../src/schemas';
import { DopplerSessionEngine } from '../src/solver/session';

describe('CLI Integration Suite (cli/doppler.ts)', { timeout: 30000 }, () => {
  let tempDir: string;
  let audioPath: string;
  let sessionPath: string;
  let rawAdsbPath: string;
  let datasetOutputPath: string;
  let datasetPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doppler-cli-test-'));
    audioPath = join(tempDir, 'test-flyover.wav');
    sessionPath = join(tempDir, 'test-session.json');
    rawAdsbPath = join(tempDir, 'raw-adsb.json');
    datasetOutputPath = join(tempDir, 'dataset-out.json');
    datasetPath = join(tempDir, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(SYNTHETIC_DATASET), 'utf8');

    // Synthesize a realistic 120-second flyover WAV
    const sampleRateHz = 2000;
    const durationSec = 120;
    const seg = SYNTHETIC_SEGMENTS[0]!;
    const audio = synthesizeMultiFlyoverAudio({
      sampleRateHz,
      startEpochSec: 1788900000,
      durationSec,
      observer: SYNTHETIC_GROUND_TRUTH,
      flyovers: [{ segment: seg, baseFreqHz: 115.0, amplitude: 0.9 }],
      noiseStd: 0.005,
    });
    writeWavFile(audioPath, audio, sampleRateHz);

    // Save initial valid session
    const engine = new DopplerSessionEngine({
      dataset: SYNTHETIC_DATASET,
      ambientTempCelsius: 20.0,
    });
    const initialSession = engine.getSession();
    writeFileSync(sessionPath, JSON.stringify(initialSession, null, 2), 'utf8');

    // Save raw flight segments for ingest test
    writeFileSync(rawAdsbPath, JSON.stringify(SYNTHETIC_SEGMENTS.slice(0, 3), null, 2), 'utf8');
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  it('prints version and help documentation', () => {
    const versionOut = execSync('npx tsx cli/doppler.ts -v', { encoding: 'utf8' });
    // The version comes from package.json, which a release rewrites in the working tree before the tag is pushed, so the expectation reads it instead of repeating a number that changes with every release.
    const manifest: unknown = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'));
    const { version } = z.object({ version: z.string() }).parse(manifest);
    expect(versionOut).toContain(`doppler v${version}`);

    const helpOut = execSync('npx tsx cli/doppler.ts --help', { encoding: 'utf8' });
    expect(helpOut).toContain('Usage:');
    expect(helpOut).toContain('doppler locate');
    expect(helpOut).toContain('doppler session');
    expect(helpOut).toContain('doppler ingest');
  });

  it('executes locate command with human-readable and JSON output formats', () => {
    const humanOut = execSync(`npx tsx cli/doppler.ts locate "${audioPath}" --dataset "${datasetPath}"`, { encoding: 'utf8' });
    expect(humanOut).toContain('Doppler Geolocation Results');
    expect(humanOut).toContain('Flyovers Found:');

    const jsonOut = execSync(`npx tsx cli/doppler.ts locate "${audioPath}" --dataset "${datasetPath}" --json`, { encoding: 'utf8' });
    const parsed = LocationSessionSchema.parse(JSON.parse(jsonOut));
    expect(parsed.observations.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses to locate without a dataset, since no flight data is built in', () => {
    const run = (): Buffer => execSync(`npx tsx cli/doppler.ts locate "${audioPath}"`, { stdio: 'pipe' });

    expect(run).toThrow(/--dataset <dataset\.json> is required/);
  });

  it('executes ingest command to generate DopplerDataset bundle', () => {
    const ingestOut = execSync(`npx tsx cli/doppler.ts ingest --input "${rawAdsbPath}" --out "${datasetOutputPath}"`, {
      encoding: 'utf8',
    });
    expect(ingestOut).toContain('Saved dataset bundle');

    const datasetRaw: unknown = JSON.parse(readFileSync(datasetOutputPath, 'utf8'));
    const dataset = DopplerDatasetSchema.parse(datasetRaw);
    expect(dataset.segments.length).toBe(3);
  });

  it('executes session command to incrementally append audio observations', () => {
    const sessionOut = execSync(`npx tsx cli/doppler.ts session "${sessionPath}" --add-audio "${audioPath}" --dataset "${datasetPath}"`, {
      encoding: 'utf8',
    });
    expect(sessionOut).toContain('Updated session');
    expect(sessionOut).toContain('Total Observations:');

    const updatedRaw: unknown = JSON.parse(readFileSync(sessionPath, 'utf8'));
    const updated = LocationSessionSchema.parse(updatedRaw);
    expect(updated.episodes.length).toBe(1);
    expect(updated.observations.length).toBeGreaterThanOrEqual(1);
  });
});
