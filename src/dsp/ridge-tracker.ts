import { extractAsymptoticKinematics } from '../physics/algebra';
import type { DopplerObservation, DopplerRidgePoint } from '../schemas';
import type { DopplerSpectrogram } from './spectrogram';

/**
 * Options for extracting Doppler S-curve observations from a spectrogram.
 */
export interface RidgeTrackerOptions {
  readonly episodeId: string;
  readonly minSnrDb?: number;
  readonly minDurationSec?: number;
  readonly minFreqDropHz?: number;
  readonly soundSpeedMps?: number;
}

/**
 * Extracts Doppler S-curve observations from a spectrogram, down-weighting noise-polluted frames and computing closed-form kinematics for each detected flyover.
 * @param spectrogram - Computed spectrogram with noise-pollution flags.
 * @param options - Tracker thresholds and episode context.
 * @returns Array of detected aircraft Doppler observations.
 */
export function extractDopplerObservations(
  spectrogram: Readonly<DopplerSpectrogram>,
  options: Readonly<RidgeTrackerOptions>,
): DopplerObservation[] {
  const minSnrDb = options.minSnrDb ?? 6.0;
  const minDurationSec = options.minDurationSec ?? 6.0;
  const minFreqDropHz = options.minFreqDropHz ?? 3.5;
  const soundSpeedMps = options.soundSpeedMps ?? 343.0;

  const candidatePoints: DopplerRidgePoint[] = [];
  for (const frame of spectrogram.frames) {
    // Allow high-SNR peaks even in mildly elevated noise, or standard SNR in quiet frames
    const effectiveThreshold = frame.noisePolluted ? minSnrDb + 4.0 : minSnrDb;
    if (frame.peakSnrDb >= effectiveThreshold) {
      candidatePoints.push({
        timeSec: frame.timeSec,
        freqHz: frame.peakFreqHz,
        snrDb: frame.peakSnrDb,
      });
    }
  }

  if (candidatePoints.length < 5) {
    return [];
  }

  // Group candidate points into frequency-continuous trajectory tracks
  const clusters: DopplerRidgePoint[][] = [];
  let currentCluster: DopplerRidgePoint[] = [];

  for (const pt of candidatePoints) {
    if (currentCluster.length === 0) {
      currentCluster.push(pt);
      continue;
    }
    const prev = currentCluster[currentCluster.length - 1];
    if (prev === undefined) {
      continue;
    }
    const dt = pt.timeSec - prev.timeSec;
    const df = Math.abs(pt.freqHz - prev.freqHz);
    // Allow up to 1.5 seconds between frames and up to 15 Hz/sec maximum frequency derivative
    if (dt <= 1.5 && df <= Math.max(10.0, 15.0 * dt)) {
      currentCluster.push(pt);
    } else {
      if (currentCluster.length >= 8) {
        clusters.push(currentCluster);
      }
      currentCluster = [pt];
    }
  }
  if (currentCluster.length >= 8) {
    clusters.push(currentCluster);
  }

  const observations: DopplerObservation[] = [];

  for (let idx = 0; idx < clusters.length; idx += 1) {
    const cluster = clusters[idx];
    if (cluster === undefined || cluster.length < 5) {
      continue;
    }
    const firstPt = cluster[0];
    const lastPt = cluster[cluster.length - 1];
    if (firstPt === undefined || lastPt === undefined) {
      continue;
    }

    const durationSec = lastPt.timeSec - firstPt.timeSec;
    if (durationSec < minDurationSec) {
      continue;
    }

    // Compute robust asymptotic high (median of first 20% of points) and low (median of last 20% of points)
    const edgeCount = Math.max(2, Math.floor(cluster.length * 0.22));
    const headFreqs = cluster
      .slice(0, edgeCount)
      .map((p) => p.freqHz)
      .sort((a, b) => a - b);
    const tailFreqs = cluster
      .slice(cluster.length - edgeCount)
      .map((p) => p.freqHz)
      .sort((a, b) => a - b);

    const fHigh = headFreqs[headFreqs.length >> 1] ?? firstPt.freqHz;
    const fLow = tailFreqs[tailFreqs.length >> 1] ?? lastPt.freqHz;
    if (fHigh - fLow < minFreqDropHz) {
      continue;
    }

    const targetBaseFreq = (2 * fHigh * fLow) / (fHigh + fLow);

    // Find CPA inflection time (closest point to targetBaseFreq with steepest negative local slope)
    let cpaIdx = cluster.length >> 1;
    let minFreqDiff = Infinity;
    for (let i = 1; i < cluster.length - 1; i += 1) {
      const pt = cluster[i];
      if (pt !== undefined) {
        const diff = Math.abs(pt.freqHz - targetBaseFreq);
        if (diff < minFreqDiff) {
          minFreqDiff = diff;
          cpaIdx = i;
        }
      }
    }

    const cpaPoint = cluster[cpaIdx] ?? firstPt;
    const span = Math.max(1, Math.min(3, Math.floor(cluster.length / 6)));
    const leftPt = cluster[Math.max(0, cpaIdx - span)] ?? firstPt;
    const rightPt = cluster[Math.min(cluster.length - 1, cpaIdx + span)] ?? lastPt;
    const dtSlope = Math.max(0.25, rightPt.timeSec - leftPt.timeSec);
    const rawSlope = (rightPt.freqHz - leftPt.freqHz) / dtSlope;
    const inflectionSlopeHzPerSec = rawSlope < -0.02 ? rawSlope : -(fHigh - fLow) / durationSec;

    // Asymptotic extrapolation factor (since finite audio windows truncate the infinite asymptote by ~4-8%)
    const halfDur = Math.max(1, 0.5 * durationSec);
    const tauEst = Math.max(1.5, -(targetBaseFreq * ((fHigh - fLow) / (fHigh + fLow))) / inflectionSlopeHzPerSec);
    const cosThetaMax = halfDur / Math.hypot(halfDur, tauEst);
    const halfSpread = (0.5 * (fHigh - fLow)) / Math.max(0.5, cosThetaMax);
    const midFreq = 0.5 * (fHigh + fLow);
    const asymptoticHighHz = midFreq + halfSpread;
    const asymptoticLowHz = Math.max(10, midFreq - halfSpread);

    const kinematics = extractAsymptoticKinematics({
      asymptoticHighHz,
      asymptoticLowHz,
      inflectionSlopeHzPerSec,
      soundSpeedMps,
    });

    const snrValues = cluster.map((p) => p.snrDb).sort((a, b) => a - b);
    const medianSnrDb = snrValues[snrValues.length >> 1] ?? minSnrDb;

    observations.push({
      id: `${options.episodeId}_obs${String(idx)}`,
      episodeId: options.episodeId,
      cpaTimeSec: cpaPoint.timeSec,
      kinematics,
      snrDb: medianSnrDb,
      harmonicCount: 1,
      ridgePoints: cluster,
    });
  }

  return observations;
}
