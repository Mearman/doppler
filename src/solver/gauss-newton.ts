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

  // Estimate recording start epoch `T_0` as the weighted mean of (cpaDelayedEpochSec - obs.cpaTimeSec)
  let sumStartEpoch = 0;
  for (const pair of pairs) {
    const cpa = computeSegmentCpa(point, pair.segment, soundSpeedMps);
    sumStartEpoch += cpa.cpaDelayedEpochSec - pair.observation.cpaTimeSec;
  }
  const estimatedStartEpochSec = sumStartEpoch / pairs.length;

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

    // 2. Relative CPA arrival time residual across multiple flyovers (preserving purely physics-derived temporal offset)
    if (pairs.length > 1) {
      const firstCpa = computeSegmentCpa(point, firstPair.segment, soundSpeedMps);
      const modeledOffsetSec = cpa.cpaDelayedEpochSec - firstCpa.cpaDelayedEpochSec;
      const observedOffsetSec = observation.cpaTimeSec - firstPair.observation.cpaTimeSec;
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
  const logLikelihood = -0.5 * currentCost;

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
