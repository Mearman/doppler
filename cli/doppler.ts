#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { BUNDLED_DATASET } from '../src/bundled';
import { decimateAudioStream } from '../src/dsp/decimate';
import { extractDopplerObservations } from '../src/dsp/ridge-tracker';
import { detectEnfSignature } from '../src/dsp/side-channels';
import { computeDopplerSpectrogram } from '../src/dsp/spectrogram';
import { loadDatasetFile, readWavFile, saveDatasetBundle } from '../src/node/entry';
import { LinearFlightSegment, LocationSession } from '../src/schemas';
import { DopplerSessionEngine } from '../src/solver/session';

const PackageManifest = z.object({
  version: z.string(),
});

/** The package version, read from the package.json that sits one directory above both `cli/` and `dist-cli/`. */
function getCliVersion(): string {
  return PackageManifest.parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))).version;
}

function formatCpaTime(cpaTimeSec: number): string {
  if (cpaTimeSec > 1_000_000_000) {
    return new Date(cpaTimeSec * 1000).toLocaleTimeString();
  }
  const mins = Math.floor(cpaTimeSec / 60);
  const secs = (cpaTimeSec % 60).toFixed(1);

  return mins > 0 ? `${String(mins)}m ${secs}s` : `${secs}s`;
}

function printHelp(): void {
  console.log(`
doppler - Offline and real-time aircraft Doppler audio geolocation

Usage:
  doppler locate <audio.wav> [options]
  doppler session <session.json> --add-audio <audio.wav>
  doppler ingest --input <raw-adsb.json> --out <dataset.json>

Options:
  --dataset <path>    Path to a custom DopplerDataset .json file (defaults to bundled dataset)
  --temp <celsius>    Ambient air temperature in Celsius (default 20.0)
  --json              Output raw JSON results
  --version, -v       Show version
  --help, -h          Show help
`);
}

function run(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();

    return;
  }
  if (args.includes('-v') || args.includes('--version')) {
    console.log(`doppler v${getCliVersion()}`);

    return;
  }

  const command = args[0];

  if (command === 'locate') {
    const audioPath = args[1];
    if (audioPath === undefined || audioPath.startsWith('--')) {
      console.error('Error: specify an audio file path: doppler locate <file.wav>');
      process.exit(1);
    }

    const datasetIdx = args.indexOf('--dataset');
    const datasetPath = datasetIdx !== -1 ? args[datasetIdx + 1] : undefined;
    const tempIdx = args.indexOf('--temp');
    const ambientTemp = tempIdx !== -1 ? Number(args[tempIdx + 1]) : 20.0;
    const isJson = args.includes('--json');

    const dataset = datasetPath !== undefined ? loadDatasetFile(datasetPath) : BUNDLED_DATASET;
    const { samples, sampleRateHz } = readWavFile(audioPath);

    const decimated = decimateAudioStream(samples, sampleRateHz, 2000);
    const enf = detectEnfSignature(decimated.samples, decimated.sampleRateHz);

    const spectrogram = computeDopplerSpectrogram(decimated.samples, {
      sampleRateHz: decimated.sampleRateHz,
      startTimeSec: 0,
      fftSize: 2048,
      hopSamples: 500,
    });

    const observations = extractDopplerObservations(spectrogram, {
      episodeId: 'cli_file',
      minSnrDb: 5.0,
    });

    const engine = new DopplerSessionEngine({
      dataset,
      ambientTempCelsius: ambientTemp,
      constraints: enf.detected ? { enfNominalHz: enf.nominalHz === '50' ? '50' : '60' } : {},
    });

    engine.startEpisode(0);
    for (const obs of observations) {
      engine.ingestObservation(obs);
    }

    const session = engine.getSession();
    const topHyp = session.hypotheses[0];

    if (isJson) {
      console.log(JSON.stringify(session, null, 2));

      return;
    }

    console.log('\n--- Doppler Geolocation Results ---');
    console.log(`Audio File:      ${audioPath} (${(samples.length / sampleRateHz).toFixed(1)}s @ ${String(sampleRateHz)}Hz)`);
    console.log(`ENF Power Grid:  ${enf.detected ? `${enf.nominalHz} Hz (${enf.regionHint})` : 'Not detected'}`);
    console.log(`Flyovers Found:  ${String(observations.length)}`);

    for (let i = 0; i < observations.length; i += 1) {
      const o = observations[i];
      if (o !== undefined) {
        const timeLabel = formatCpaTime(o.cpaTimeSec);
        console.log(`  [#${String(i + 1)}] CPA: ${timeLabel}, Base: ${o.kinematics.baseFreqHz.toFixed(1)}Hz, Speed: ${o.kinematics.inferredSpeedMps.toFixed(1)}m/s, Slant: ${o.kinematics.inferredSlantMeters.toFixed(0)}m, SNR: ${o.snrDb.toFixed(1)}dB`);
      }
    }

    if (topHyp !== undefined) {
      console.log('\nTop Hypothesis:');
      console.log(`  Coordinates:   ${topHyp.lat.toFixed(5)}° N, ${topHyp.lon.toFixed(5)}° E (alt: ${topHyp.altMeters.toFixed(0)}m)`);
      console.log(`  H3 Cell:       ${topHyp.h3Cell}`);
      console.log(`  Date / Time:   ${topHyp.dateIso} ~${new Date(topHyp.estimatedStartEpochSec * 1000).toISOString()}`);
      console.log(`  Probability:   ${(topHyp.probability * 100).toFixed(1)}% (Log-Posterior: ${topHyp.logPosterior.toFixed(2)})`);
      console.log(`  95% Ellipse:   ${topHyp.ellipseSemiMajorMeters.toFixed(0)}m × ${topHyp.ellipseSemiMinorMeters.toFixed(0)}m (bearing ${topHyp.ellipseBearingDeg.toFixed(0)}°)`);
      console.log(`  Matched Segs:  ${topHyp.matchedSegmentIds.join(', ')}`);
    } else {
      console.log('\nNo matching flight trajectory found in dataset.');
    }

    return;
  }

  if (command === 'session') {
    const sessionPath = args[1];
    const addIdx = args.indexOf('--add-audio');
    const audioPath = addIdx !== -1 ? args[addIdx + 1] : undefined;

    if (sessionPath === undefined || audioPath === undefined) {
      console.error('Usage: doppler session <session.json> --add-audio <file.wav>');
      process.exit(1);
    }

    const sessionRaw = readFileSync(sessionPath, 'utf8');
    const initialSession = LocationSession.parse(JSON.parse(sessionRaw));
    const { samples, sampleRateHz } = readWavFile(audioPath);
    const decimated = decimateAudioStream(samples, sampleRateHz, 2000);

    const spectrogram = computeDopplerSpectrogram(decimated.samples, {
      sampleRateHz: decimated.sampleRateHz,
      startTimeSec: 0,
      fftSize: 2048,
      hopSamples: 500,
    });

    const observations = extractDopplerObservations(spectrogram, {
      episodeId: `episode_${String(initialSession.episodes.length + 1)}`,
      minSnrDb: 5.0,
    });

    const engine = new DopplerSessionEngine({
      initialSession,
      dataset: BUNDLED_DATASET,
    });

    const episode = engine.startEpisode(Math.floor(Date.now() / 1000));
    for (const obs of observations) {
      engine.ingestObservation(obs);
    }
    engine.pauseEpisode(episode.id, Math.floor(Date.now() / 1000));

    const updated = engine.getSession();
    writeFileSync(sessionPath, JSON.stringify(updated, null, 2), 'utf8');

    const top = updated.hypotheses[0];
    console.log(`\nUpdated session ${sessionPath}:`);
    console.log(`  Total Observations: ${String(updated.observations.length)}`);
    if (top !== undefined) {
      console.log(`  Current Estimate:   ${top.lat.toFixed(5)}° N, ${top.lon.toFixed(5)}° E`);
      console.log(`  95% Confidence:     ${top.ellipseSemiMajorMeters.toFixed(0)}m × ${top.ellipseSemiMinorMeters.toFixed(0)}m`);
    }

    return;
  }

  if (command === 'ingest') {
    const inIdx = args.indexOf('--input');
    const outIdx = args.indexOf('--out');
    const inputPath = inIdx !== -1 ? args[inIdx + 1] : undefined;
    const outputPath = outIdx !== -1 ? args[outIdx + 1] : undefined;

    if (inputPath === undefined || outputPath === undefined) {
      console.error('Usage: doppler ingest --input <raw-adsb.json> --out <dataset.json>');
      process.exit(1);
    }

    const raw = readFileSync(inputPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const parsedObj = typeof parsed === 'object' && parsed !== null ? parsed : {};
    const rawSegments = Array.isArray(parsed)
      ? parsed
      : ('segments' in parsedObj && Array.isArray(parsedObj.segments) ? parsedObj.segments : []);
    const segments = z.array(LinearFlightSegment).parse(rawSegments);
    saveDatasetBundle(outputPath, segments);
    console.log(`Saved dataset bundle with ${String(segments.length)} segments to ${outputPath}`);

    return;
  }

  console.error(`Unknown command: ${command ?? 'none'}`);
  printHelp();
  process.exit(1);
}

run();
