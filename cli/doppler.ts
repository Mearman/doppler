#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { decimateAudioStream } from '../src/dsp/decimate';
import { extractDopplerObservations } from '../src/dsp/ridge-tracker';
import { detectEnfSignature } from '../src/dsp/side-channels';
import { computeDopplerSpectrogram } from '../src/dsp/spectrogram';
import { type BoundingBox, loadDatasetFile, readAdsbArchiveSegments, readAdsbSegments, readWavFile, saveDatasetBundle } from '../src/node/entry';
import { type DopplerDataset, LocationSessionSchema } from '../src/schemas';
import { DopplerSessionEngine } from '../src/solver/session';

const PackageManifest = z.object({
  version: z.string(),
});

/** The package version, read from the package.json that sits one directory above both `cli/` and `dist-cli/`. */
function getCliVersion(): string {
  return PackageManifest.parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))).version;
}

/**
 * Parses `minLat,minLon,maxLat,maxLon`.
 * @param text - The option value.
 * @returns The box.
 * @throws When the value is not four numbers with the minimums below the maximums.
 */
function parseBoundingBox(text: string | undefined): BoundingBox {
  const parts = (text ?? '').split(',').map(Number);
  const [minLat, minLon, maxLat, maxLon] = parts;
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || minLat === undefined || minLon === undefined || maxLat === undefined || maxLon === undefined || minLat >= maxLat || minLon >= maxLon) {
    throw new Error(`--bbox needs minLat,minLon,maxLat,maxLon with each minimum below its maximum, got ${text ?? 'nothing'}`);
  }

  return { minLat, minLon, maxLat, maxLon };
}

function formatCpaTime(cpaTimeSec: number): string {
  if (cpaTimeSec > 1_000_000_000) {
    return new Date(cpaTimeSec * 1000).toLocaleTimeString();
  }
  const mins = Math.floor(cpaTimeSec / 60);
  const secs = (cpaTimeSec % 60).toFixed(1);

  return mins > 0 ? `${String(mins)}m ${secs}s` : `${secs}s`;
}

/**
 * Loads the flight dataset named by `--dataset`, which locating needs and which has no default: a location is only as real as the flight data behind it.
 * @param args - The command line arguments after the program name.
 * @returns The parsed dataset; the process exits with an error when the option is missing.
 */
function requireDataset(args: readonly string[]): DopplerDataset {
  const index = args.indexOf('--dataset');
  const datasetPath = index === -1 ? undefined : args[index + 1];
  if (datasetPath === undefined || datasetPath.startsWith('--')) {
    console.error('Error: --dataset <dataset.json> is required. Build one with `doppler ingest` or download a day from https://huggingface.co/datasets/Mearman/doppler-adsb');
    process.exit(1);
  }

  return loadDatasetFile(datasetPath);
}

function printHelp(): void {
  console.log(`
doppler - Offline and real-time aircraft Doppler audio geolocation

Usage:
  doppler locate <audio.wav> --dataset <dataset.json> [options]
  doppler session <session.json> --add-audio <audio.wav> --dataset <dataset.json>
  doppler ingest --input <adsb.json|directory|-> --out <dataset.json> [--date <YYYY-MM-DD>] [--bbox <minLat,minLon,maxLat,maxLon>]

Options:
  --dataset <path>    Path to a DopplerDataset .json file, from 'doppler ingest' or the Hugging Face dataset (required by locate and session)
  --date <YYYY-MM-DD> For ingest: date of raw traces that carry no timestamp
  --bbox <a,b,c,d>    For ingest: keep segments touching minLat,minLon,maxLat,maxLon
                      (--input - reads an adsb.lol globe_history tar from stdin)
  --temp <celsius>    Ambient air temperature in Celsius (default 20.0)
  --json              Output raw JSON results
  --version, -v       Show version
  --help, -h          Show help
`);
}

async function run(): Promise<void> {
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

    const tempIdx = args.indexOf('--temp');
    const ambientTemp = tempIdx !== -1 ? Number(args[tempIdx + 1]) : 20.0;
    if (!Number.isFinite(ambientTemp)) {
      console.error(`Error: --temp needs a number of degrees Celsius, got ${args[tempIdx + 1] ?? 'nothing'}`);
      process.exit(1);
    }
    const isJson = args.includes('--json');

    const dataset = requireDataset(args);
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
      console.log(`  Matched Segs:  ${topHyp.matches.map((match) => match.segmentId).join(', ')}`);
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
      console.error('Usage: doppler session <session.json> --add-audio <file.wav> --dataset <dataset.json>');
      process.exit(1);
    }

    const sessionRaw = readFileSync(sessionPath, 'utf8');
    const initialSession = LocationSessionSchema.parse(JSON.parse(sessionRaw));
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
      dataset: requireDataset(args),
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
      console.error('Usage: doppler ingest --input <adsb.json|directory|-> --out <dataset.json> [--date <YYYY-MM-DD>] [--bbox <minLat,minLon,maxLat,maxLon>]');
      process.exit(1);
    }

    const dateIdx = args.indexOf('--date');
    const dateIso = dateIdx !== -1 ? args[dateIdx + 1] : undefined;
    const bboxIdx = args.indexOf('--bbox');
    const bbox = bboxIdx !== -1 ? parseBoundingBox(args[bboxIdx + 1]) : undefined;
    // `-` reads an `adsb.lol` globe_history tar from standard input, so the daily archive streams through without touching disk.
    const options = { ...(bbox === undefined ? {} : { bbox }), ...(dateIso === undefined ? {} : { dateIso }) };
    const segments = inputPath === '-' ? await readAdsbArchiveSegments(process.stdin, options) : readAdsbSegments(inputPath, options);
    saveDatasetBundle(outputPath, segments);
    console.log(`Saved dataset bundle with ${String(segments.length)} segments to ${outputPath}`);

    return;
  }

  console.error(`Unknown command: ${command ?? 'none'}`);
  printHelp();
  process.exit(1);
}

await run();
