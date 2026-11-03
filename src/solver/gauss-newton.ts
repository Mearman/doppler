import {
  interpolateTerrainElevationMeters,
  localEnuToGeo,
} from '../physics/geo';
import {
  computeSegmentCpa,
  synthesizeRetardedDopplerCurve,
} from '../physics/retarded-time';
import type {
  DopplerObservation,
  GeoPoint3D,
  LinearFlightSegment,
} from '../schemas';

/**
 * Residual size, in standard deviations, at which the score stops growing: a measurement further out than this is an outlier whatever its distance, so one gross mismatch cannot outweigh the rest of the evidence. Five sigma keeps a gross mismatch (ten sigma) costlier than a modest one (three sigma), which a three-sigma cap would score alike.
 */
const OUTLIER_SIGMAS = 5;

/**
 * Residual size, in standard deviations, beyond which a candidate is not admitted for a measurement: the conventional three-sigma gate.
 */
const ADMISSION_SIGMAS = 3;

/**
 * Standard deviation, in m/s, of the along-track wind. The Doppler fit measures speed through the air and ADS-B reports speed over the ground, so the two differ by the wind component along the track; a 5 m/s (about 10 knot) spread covers ordinary conditions.
 */
const WIND_SIGMA_MPS = 5;

/**
 * Largest speed difference, in m/s, that a segment may have from a measured Doppler speed and still be a candidate: the admission gate applied to the wind spread.
 */
export const MAX_ALONG_TRACK_WIND_MPS = ADMISSION_SIGMAS * WIND_SIGMA_MPS;

/**
 * Log-likelihood cost of leaving an observation unmatched. An observation that no segment explains contributes every residual term it would have had (one slant residual, one speed residual and one frequency residual per ridge point) at the outlier gate, so a hypothesis cannot outscore a rival by ignoring evidence: a poor fit costs at most this much, and an omission costs exactly this much.
 * @param observation - The observation a hypothesis does not explain.
 * @returns A non-negative amount to subtract from the hypothesis's log-posterior.
 */
export function unmatchedObservationLogPenalty(observation: Readonly<DopplerObservation>): number {
  return 0.5 * (2 + observation.ridgePoints.length) * OUTLIER_SIGMAS ** 2;
}

/**
 * Paired observation and flight segment constraint used during Gauss-Newton coordinate refinement.
 */
export interface ObservationSegmentPair {
  readonly observation: Readonly<DopplerObservation>;
  readonly segment: Readonly<LinearFlightSegment>;
}

/**
 * Output of the damped Gauss-Newton / Levenberg-Marquardt coordinate refinement and Fisher Information covariance estimator.
 */
export interface RefinedLocationResult {
  readonly lat: number;
  readonly lon: number;
  readonly altMeters: number;
  readonly estimatedStartEpochSec: number;
  readonly rmsFreqResidualHz: number;
  readonly logLikelihood: number;
  readonly fisherInfo: readonly [number, number, number, number];
  readonly ellipseSemiMajorMeters: number;
  readonly ellipseSemiMinorMeters: number;
  readonly ellipseBearingDeg: number;
}

/**
 * Evaluates the frequency + CPA timing residual vector and log-likelihood at a local East-North offset `(eastMeters, northMeters)` from `referenceOrigin`.
 */
function evaluateResidualsAtEnuOffset(
  referenceOrigin: Readonly<GeoPoint3D>,
  offsetEnu: { readonly eastMeters: number; readonly northMeters: number },
  pairs: readonly ObservationSegmentPair[],
  context: { readonly demGrid: readonly GeoPoint3D[]; readonly soundSpeedMps: number },
): {
  readonly point: GeoPoint3D;
  readonly estimatedStartEpochSec: number;
  readonly residuals: number[];
  readonly rmsFreqResidualHz: number;
} {
  const { eastMeters, northMeters } = offsetEnu;
  const { demGrid, soundSpeedMps } = context;
  const shiftedGeo = localEnuToGeo(referenceOrigin, { x: eastMeters, y: northMeters, z: 0 });
  const groundAlt = interpolateTerrainElevationMeters(shiftedGeo.lat, shiftedGeo.lon, demGrid);
  const point: GeoPoint3D = { lat: shiftedGeo.lat, lon: shiftedGeo.lon, altMeters: groundAlt };

  const firstPair = pairs[0];
  if (firstPair === undefined) {
    return { point, estimatedStartEpochSec: 0, residuals: [], rmsFreqResidualHz: 0 };
  }

  // Observation times are relative to their own episode's clock, and episodes (separate files, resumed sessions) share none. Timing therefore links only observations within one episode, each measured against the first pair of its own episode.
  const episodeReference = new Map<string, ObservationSegmentPair>();
  for (const pair of pairs) {
    if (!episodeReference.has(pair.observation.episodeId)) {
      episodeReference.set(pair.observation.episodeId, pair);
    }
  }
  const sameClockPairs = pairs.filter((pair) => pair.observation.episodeId === firstPair.observation.episodeId);

  // Estimate recording start epoch `T_0` as the mean of (cpaDelayedEpochSec - obs.cpaTimeSec) over the pairs on that clock
  let sumStartEpoch = 0;
  for (const pair of sameClockPairs) {
    const cpa = computeSegmentCpa(point, pair.segment, soundSpeedMps);
    sumStartEpoch += cpa.cpaDelayedEpochSec - pair.observation.cpaTimeSec;
  }
  const estimatedStartEpochSec = sumStartEpoch / sameClockPairs.length;

  const residuals: number[] = [];
  let freqSqSum = 0;
  let freqCount = 0;

  for (const pair of pairs) {
    const { observation, segment } = pair;
    const cpa = computeSegmentCpa(point, segment, soundSpeedMps);

    // 1. Slant distance residual (normalized by slant std)
    const slantDiff = cpa.cpaSlantMeters - observation.kinematics.inferredSlantMeters;
    const slantSigma = Math.max(40, observation.kinematics.slantStdMeters);
    residuals.push(slantDiff / slantSigma);

    // 1b. Speed residual: the observer position does not change it, so it carries no gradient, but it scores how well each segment's ground speed explains the measured speed, which ranks rival segments for the same flyover.
    const speedSigma = Math.hypot(WIND_SIGMA_MPS, observation.kinematics.speedStdMps);
    residuals.push((segment.groundspeedMps - observation.kinematics.inferredSpeedMps) / speedSigma);

    // 2. Relative CPA arrival time residual across flyovers of one episode (preserving purely physics-derived temporal offset)
    const reference = episodeReference.get(observation.episodeId);
    if (reference !== undefined && reference !== pair) {
      const firstCpa = computeSegmentCpa(point, reference.segment, soundSpeedMps);
      const modeledOffsetSec = cpa.cpaDelayedEpochSec - firstCpa.cpaDelayedEpochSec;
      const observedOffsetSec = observation.cpaTimeSec - reference.observation.cpaTimeSec;
      const timeDiff = modeledOffsetSec - observedOffsetSec;
      residuals.push(timeDiff / 0.8);
    }

    // 3. Full retarded-time Doppler ridge frequency residuals centered at each event's own delayed CPA
    const sampleEpochs = observation.ridgePoints.map(
      (pt) => cpa.cpaDelayedEpochSec + (pt.timeSec - observation.cpaTimeSec),
    );
    const modeledCurve = synthesizeRetardedDopplerCurve(point, segment, {
      baseFreqHz: observation.kinematics.baseFreqHz,
      obsEpochTimesSec: sampleEpochs,
      soundSpeedMps,
    });

    // Allow a small per-aircraft fundamental pitch offset `deltaF0` (locked CPA time, free small RPM trim)
    let meanFreqOffset = 0;
    const nPts = Math.min(observation.ridgePoints.length, modeledCurve.length);
    for (let k = 0; k < nPts; k += 1) {
      const obsPt = observation.ridgePoints[k];
      const modPt = modeledCurve[k];
      if (obsPt !== undefined && modPt !== undefined) {
        meanFreqOffset += obsPt.freqHz - modPt.observedFreqHz;
      }
    }
    meanFreqOffset = nPts > 0 ? meanFreqOffset / nPts : 0;
    // Clamp allowed RPM trim to ±2.5 Hz so bad trajectories cannot overfit
    const clampedF0Trim = Math.max(-2.5, Math.min(2.5, meanFreqOffset));

    for (let k = 0; k < nPts; k += 1) {
      const obsPt = observation.ridgePoints[k];
      const modPt = modeledCurve[k];
      if (obsPt !== undefined && modPt !== undefined) {
        const freqErr = obsPt.freqHz - (modPt.observedFreqHz + clampedF0Trim);
        freqSqSum += freqErr * freqErr;
        freqCount += 1;
        residuals.push(freqErr / 0.35);
      }
    }
  }

  const rmsFreqResidualHz = freqCount > 0 ? Math.sqrt(freqSqSum / freqCount) : 0;

  return {
    point,
    estimatedStartEpochSec,
    residuals,
    rmsFreqResidualHz,
  };
}

/**
 * Converts a 2x2 Fisher Information matrix `[I_xx, I_xy, I_yx, I_yy]` in inverse-square meters into a 95% confidence ellipse (`chi2_2(0.95) = 5.991`).
 * @param fisher - 2x2 symmetric Fisher Information matrix entries `[I_xx, I_xy, I_yx, I_yy]`.
 * @returns Semi-major axis (m), semi-minor axis (m), and compass bearing of semi-major axis (degrees).
 */
export function fisherToConfidenceEllipse95(
  fisher: readonly [number, number, number, number],
): {
  readonly ellipseSemiMajorMeters: number;
  readonly ellipseSemiMinorMeters: number;
  readonly ellipseBearingDeg: number;
} {
  // Add weak prior regularization (1 / (3000m)^2) so single-flyover ribbons remain numerically invertible
  const priorReg = 1 / (2500 * 2500);
  const ixx = fisher[0] + priorReg;
  const ixy = 0.5 * (fisher[1] + fisher[2]);
  const iyy = fisher[3] + priorReg;

  const trace = ixx + iyy;
  const diff = ixx - iyy;
  const disc = Math.hypot(diff, 2 * ixy);

  // Eigenvalues of Fisher Information matrix (larger eigenvalue = tighter precision = smaller axis)
  const lambdaMax = Math.max(1e-9, 0.5 * (trace + disc));
  const lambdaMin = Math.max(1e-9, 0.5 * (trace - disc));

  const chi2Scale = Math.sqrt(5.99146);
  const ellipseSemiMajorMeters = Math.min(15000, Math.max(2.0, chi2Scale / Math.sqrt(lambdaMin)));
  const ellipseSemiMinorMeters = Math.min(15000, Math.max(1.5, chi2Scale / Math.sqrt(lambdaMax)));

  // Angle of minimum-information eigenvector (major axis of uncertainty) in East-North plane
  const angleRad = 0.5 * Math.atan2(2 * ixy, ixx - iyy) + 0.5 * Math.PI;
  const bearingDeg = ((90 - (angleRad * 180) / Math.PI) % 360 + 360) % 360;

  return {
    ellipseSemiMajorMeters,
    ellipseSemiMinorMeters,
    ellipseBearingDeg: bearingDeg,
  };
}

/**
 * Options for Levenberg-Marquardt coordinate refinement.
 */
export interface RefineCoordinateOptions {
  readonly demGrid?: readonly GeoPoint3D[];
  readonly soundSpeedMps?: number;
}

/**
 * Refines a candidate observer coordinate `(lat, lon)` without spatial grids using damped Levenberg-Marquardt nonlinear least squares and computes the 2x2 Fisher Information matrix and 95% confidence ellipse.
 * @param seedGeo - Coarse initial coordinate (e.g. H3 cell center or cylinder intersection).
 * @param pairs - Matched observation-to-segment pairs (1 or more flyovers).
 * @param options - Terrain elevation grid and sound speed.
 * @returns Optimized coordinate, log-likelihood, Fisher Information matrix, and 95% error ellipse.
 */
export function refineObserverCoordinateGaussNewton(
  seedGeo: Readonly<GeoPoint3D>,
  pairs: readonly ObservationSegmentPair[],
  options: Readonly<RefineCoordinateOptions> = {},
): RefinedLocationResult {
  const { demGrid = [], soundSpeedMps = 343.0 } = options;
  const context = { demGrid, soundSpeedMps };
  let eastMeters = 0;
  let northMeters = 0;
  let damping = 1e-2;
  const fdStepMeters = 2.0;

  let currentEval = evaluateResidualsAtEnuOffset(seedGeo, { eastMeters, northMeters }, pairs, context);
  let currentCost = currentEval.residuals.reduce((acc, r) => acc + r * r, 0);

  let jtj00 = 0;
  let jtj01 = 0;
  let jtj11 = 0;

  for (let iter = 0; iter < 8; iter += 1) {
    const evalPlusE = evaluateResidualsAtEnuOffset(
      seedGeo,
      { eastMeters: eastMeters + fdStepMeters, northMeters },
      pairs,
      context,
    );
    const evalPlusN = evaluateResidualsAtEnuOffset(
      seedGeo,
      { eastMeters, northMeters: northMeters + fdStepMeters },
      pairs,
      context,
    );

    jtj00 = 0;
    jtj01 = 0;
    jtj11 = 0;
    let jtr0 = 0;
    let jtr1 = 0;

    const nRes = currentEval.residuals.length;
    for (let k = 0; k < nRes; k += 1) {
      const r0 = currentEval.residuals[k] ?? 0;
      const rE = evalPlusE.residuals[k] ?? r0;
      const rN = evalPlusN.residuals[k] ?? r0;

      const jE = (rE - r0) / fdStepMeters;
      const jN = (rN - r0) / fdStepMeters;

      jtj00 += jE * jE;
      jtj01 += jE * jN;
      jtj11 += jN * jN;
      jtr0 += jE * r0;
      jtr1 += jN * r0;
    }

    const a00 = jtj00 + damping * Math.max(1e-4, jtj00);
    const a11 = jtj11 + damping * Math.max(1e-4, jtj11);
    const det = a00 * a11 - jtj01 * jtj01;
    if (Math.abs(det) < 1e-12) {
      break;
    }

    const rawStepE = -(a11 * jtr0 - jtj01 * jtr1) / det;
    const rawStepN = -(-jtj01 * jtr0 + a00 * jtr1) / det;

    // Limit single iteration step to 1,500 meters for stability
    const stepNorm = Math.hypot(rawStepE, rawStepN);
    const scale = stepNorm > 1500 ? 1500 / stepNorm : 1;
    const stepE = rawStepE * scale;
    const stepN = rawStepN * scale;

    const candidateEval = evaluateResidualsAtEnuOffset(
      seedGeo,
      { eastMeters: eastMeters + stepE, northMeters: northMeters + stepN },
      pairs,
      context,
    );
    const candidateCost = candidateEval.residuals.reduce((acc, r) => acc + r * r, 0);

    if (candidateCost < currentCost) {
      eastMeters += stepE;
      northMeters += stepN;
      currentEval = candidateEval;
      currentCost = candidateCost;
      damping *= 0.3;
      if (Math.hypot(stepE, stepN) < 0.25) {
        break;
      }
    } else {
      damping *= 4.0;
    }
  }

  const fisherInfo: readonly [number, number, number, number] = [jtj00, jtj01, jtj01, jtj11];
  const ellipse = fisherToConfidenceEllipse95(fisherInfo);
  // The optimiser minimises plain squares, but the score caps each residual at the outlier gate so that a poor fit never costs more than leaving the flyover unexplained (`unmatchedObservationLogPenalty`).
  const logLikelihood = -0.5 * currentEval.residuals.reduce((acc, r) => acc + Math.min(r * r, OUTLIER_SIGMAS ** 2), 0);

  return {
    lat: currentEval.point.lat,
    lon: currentEval.point.lon,
    altMeters: currentEval.point.altMeters,
    estimatedStartEpochSec: currentEval.estimatedStartEpochSec,
    rmsFreqResidualHz: currentEval.rmsFreqResidualHz,
    logLikelihood,
    fisherInfo,
    ellipseSemiMajorMeters: ellipse.ellipseSemiMajorMeters,
    ellipseSemiMinorMeters: ellipse.ellipseSemiMinorMeters,
    ellipseBearingDeg: ellipse.ellipseBearingDeg,
  };
}
