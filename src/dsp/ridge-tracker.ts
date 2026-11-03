import { extractAsymptoticKinematics } from '../physics/algebra';
import type { DopplerObservation, DopplerRidgePoint } from '../schemas';
import { SPEED_OF_SOUND_MPS } from './constants';
import type { DopplerSpectrogram } from './spectrogram';

/**
 * Default minimum per-frame peak signal-to-noise ratio in dB for a frame to join a ridge.
 */
const DEFAULT_MIN_SNR_DB = 6;

/**
 * Default minimum time in seconds between the first and last point of a ridge for it to count as a flyover.
 */
const DEFAULT_MIN_DURATION_SEC = 6;

/**
 * Default minimum drop in Hz from the approaching to the receding asymptote for a ridge to count as a Doppler S-curve rather than a steady tone.
 */
const DEFAULT_MIN_FREQ_DROP_HZ = 3.5;

/**
 * Extra signal-to-noise ratio in dB demanded of a frame flagged as noise-polluted, so that only strong peaks survive elevated noise.
 */
const NOISE_POLLUTED_SNR_PENALTY_DB = 4;

/**
 * Fewest candidate points, and fewest points in a ridge, from which a Doppler S-curve can be fitted.
 */
const MIN_RIDGE_POINTS = 5;

/**
 * Fewest consecutive frequency-continuous points that form a ridge worth keeping.
 */
const MIN_CLUSTER_POINTS = 8;

/**
 * Longest gap in seconds between consecutive points of one ridge.
 */
const MAX_TRACK_GAP_SEC = 1.5;

/**
 * Smallest frequency jump in Hz allowed between consecutive ridge points however short the gap between them.
 */
const MIN_TRACK_FREQ_JUMP_HZ = 10;

/**
 * Greatest frequency slew rate in Hz per second allowed between consecutive ridge points.
 */
const MAX_TRACK_SLEW_HZ_PER_SEC = 15;

/**
 * Fraction of a ridge's points at each end whose median frequency estimates the approaching and receding asymptotes.
 */
const EDGE_FRACTION = 0.22;

/**
 * Fewest points at each end of a ridge that are used to estimate an asymptote.
 */
const MIN_EDGE_POINTS = 2;

/**
 * Number of ridge points that earn one point of half-span on each side of the closest point of approach when measuring the inflection slope.
 */
const RIDGE_POINTS_PER_SLOPE_SPAN_POINT = 6;

/**
 * Greatest half-span in points on each side of the closest point of approach when measuring the inflection slope.
 */
const MAX_SLOPE_SPAN_POINTS = 3;

/**
 * Shortest time in seconds across which the inflection slope is measured, so that a ridge sampled very densely does not divide by a near-zero interval.
 */
const MIN_SLOPE_WINDOW_SEC = 0.25;

/**
 * Magnitude in Hz per second of the shallowest descent the measured inflection slope may have; a flatter or rising slope is replaced by the mean slope across the whole ridge.
 */
const MIN_DESCENT_SLOPE_HZ_PER_SEC = 0.02;

/**
 * Shortest time-scale in seconds of the closest-approach geometry that is assumed when extrapolating the asymptotes.
 */
const MIN_TAU_SEC = 1.5;

/**
 * Smallest value of `cosThetaMax`, the cosine of the angle between the aircraft's course and its line of sight at the ridge ends, that the asymptotic extrapolation divides by; it bounds the correction a short ridge can apply.
 */
const MIN_COS_THETA_MAX = 0.5;

/**
 * Lowest frequency in Hz that the extrapolated receding asymptote may take.
 */
const MIN_ASYMPTOTIC_LOW_HZ = 10;

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
  const minSnrDb = options.minSnrDb ?? DEFAULT_MIN_SNR_DB;
  const minDurationSec = options.minDurationSec ?? DEFAULT_MIN_DURATION_SEC;
  const minFreqDropHz = options.minFreqDropHz ?? DEFAULT_MIN_FREQ_DROP_HZ;
  const soundSpeedMps = options.soundSpeedMps ?? SPEED_OF_SOUND_MPS;

  const candidatePoints: DopplerRidgePoint[] = [];
  for (const frame of spectrogram.frames) {
    // Allow high-SNR peaks even in mildly elevated noise, or standard SNR in quiet frames
    const effectiveThreshold = frame.noisePolluted ? minSnrDb + NOISE_POLLUTED_SNR_PENALTY_DB : minSnrDb;
    if (frame.peakSnrDb >= effectiveThreshold) {
      candidatePoints.push({
        timeSec: frame.timeSec,
        freqHz: frame.peakFreqHz,
        snrDb: frame.peakSnrDb,
      });
    }
  }

  if (candidatePoints.length < MIN_RIDGE_POINTS) {
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
    // Allow a bounded gap between frames and a bounded frequency slew rate, with a floor on the jump so that adjacent frames are never rejected for jitter
    if (dt <= MAX_TRACK_GAP_SEC && df <= Math.max(MIN_TRACK_FREQ_JUMP_HZ, MAX_TRACK_SLEW_HZ_PER_SEC * dt)) {
      currentCluster.push(pt);
    } else {
      if (currentCluster.length >= MIN_CLUSTER_POINTS) {
        clusters.push(currentCluster);
      }
      currentCluster = [pt];
    }
  }
  if (currentCluster.length >= MIN_CLUSTER_POINTS) {
    clusters.push(currentCluster);
  }

  const observations: DopplerObservation[] = [];

  for (let idx = 0; idx < clusters.length; idx += 1) {
    const cluster = clusters[idx];
    if (cluster === undefined || cluster.length < MIN_RIDGE_POINTS) {
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

    // Compute robust asymptotic high (median of the first `EDGE_FRACTION` of points) and low (median of the last `EDGE_FRACTION` of points)
    const edgeCount = Math.max(MIN_EDGE_POINTS, Math.floor(cluster.length * EDGE_FRACTION));
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
    const span = Math.max(1, Math.min(MAX_SLOPE_SPAN_POINTS, Math.floor(cluster.length / RIDGE_POINTS_PER_SLOPE_SPAN_POINT)));
    const leftPt = cluster[Math.max(0, cpaIdx - span)] ?? firstPt;
    const rightPt = cluster[Math.min(cluster.length - 1, cpaIdx + span)] ?? lastPt;
    const dtSlope = Math.max(MIN_SLOPE_WINDOW_SEC, rightPt.timeSec - leftPt.timeSec);
    const rawSlope = (rightPt.freqHz - leftPt.freqHz) / dtSlope;
    const inflectionSlopeHzPerSec = rawSlope < -MIN_DESCENT_SLOPE_HZ_PER_SEC ? rawSlope : -(fHigh - fLow) / durationSec;

    // Asymptotic extrapolation factor (since finite audio windows truncate the infinite asymptote by ~4-8%)
    const halfDur = Math.max(1, durationSec / 2);
    const tauEst = Math.max(MIN_TAU_SEC, -(targetBaseFreq * ((fHigh - fLow) / (fHigh + fLow))) / inflectionSlopeHzPerSec);
    const cosThetaMax = halfDur / Math.hypot(halfDur, tauEst);
    const halfSpread = ((fHigh - fLow) / 2) / Math.max(MIN_COS_THETA_MAX, cosThetaMax);
    const midFreq = (fHigh + fLow) / 2;
    const asymptoticHighHz = midFreq + halfSpread;
    const asymptoticLowHz = Math.max(MIN_ASYMPTOTIC_LOW_HZ, midFreq - halfSpread);

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
