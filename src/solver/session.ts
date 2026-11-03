import { speedOfSoundAtTempMps } from '../physics/atmosphere';
import {
  decodeSpatialCellCenter,
  interpolateTerrainElevationMeters,
} from '../physics/geo';
import { computeSegmentCpa } from '../physics/retarded-time';
import type {
  DopplerDataset,
  DopplerObservation,
  GeoPoint3D,
  LinearFlightSegment,
  ListeningEpisode,
  LocationHypothesis,
  LocationSession,
  SearchConstraints,
} from '../schemas';
import {
  expandConstellationQueryKeys,
  matchesSearchConstraints,
} from './constellation';
import {
  fisherToConfidenceEllipse95,
  refineObserverCoordinateGaussNewton,
} from './gauss-newton';

/**
 * Options for configuring or resuming a Doppler geolocation session.
 */
export interface SessionEngineOptions {
  readonly initialSession?: Readonly<LocationSession> | undefined;
  readonly dataset: Readonly<DopplerDataset>;
  readonly ambientTempCelsius?: number | undefined;
  readonly constraints?: Readonly<SearchConstraints> | undefined;
}

/**
 * Continuous & Episodic Bayesian Refinement Engine.
 *
 * Supports leaving the microphone running continuously, or pausing and resuming across hours, days,
 * or device reboots. Ingests observations sequentially and computes an accumulating log-posterior
 * surface and Fisher Information covariance matrix across surviving candidate hypotheses.
 */
export class DopplerSessionEngine {
  private session: LocationSession;

  private readonly dataset: Readonly<DopplerDataset>;

  private readonly segmentsById: ReadonlyMap<string, LinearFlightSegment>;

  constructor(options: Readonly<SessionEngineOptions>) {
    this.dataset = options.dataset;
    const segMap = new Map<string, LinearFlightSegment>();
    for (const seg of options.dataset.segments) {
      segMap.set(seg.id, seg);
    }
    this.segmentsById = segMap;

    if (options.initialSession !== undefined) {
      this.session = { ...options.initialSession };
    } else {
      const now = Math.floor(Date.now() / 1000);
      this.session = {
        id: `sess_${String(now)}_${Math.random().toString(36).slice(2, 8)}`,
        createdAtEpochSec: now,
        updatedAtEpochSec: now,
        ambientTempCelsius: options.ambientTempCelsius ?? 20.0,
        constraints: options.constraints ?? {},
        enfSignature: {
          detected: false,
          nominalHz: 'unknown',
          measuredFreqHz: 0,
          snrDb: 0,
          regionHint: 'No ENF analysis performed yet',
        },
        episodes: [],
        observations: [],
        hypotheses: [],
      };
    }
  }

  /**
   * Returns an immutable snapshot of the current session state.
   */
  public getSession(): LocationSession {
    return this.session;
  }

  /**
   * Updates multi-axis user constraints (bounding box, date range, hour window, ENF grid) and prunes incompatible hypotheses.
   */
  public updateConstraints(constraints: Readonly<SearchConstraints>): LocationSession {
    const updatedHypotheses = this.session.hypotheses.filter((h) =>
      matchesSearchConstraints(
        { lat: h.lat, lon: h.lon, dateIso: h.dateIso, epochSec: h.estimatedStartEpochSec },
        constraints,
      ),
    );
    this.session = {
      ...this.session,
      updatedAtEpochSec: Math.floor(Date.now() / 1000),
      constraints: { ...this.session.constraints, ...constraints },
      hypotheses: updatedHypotheses,
    };

    return this.session;
  }

  /**
   * Starts a new listening episode (e.g. user clicks "Start Listening" or device boots up).
   */
  public startEpisode(startedAtEpochSec: number): ListeningEpisode {
    const episodeId = `ep_${String(startedAtEpochSec)}_${String(this.session.episodes.length + 1)}`;
    const newEpisode: ListeningEpisode = {
      id: episodeId,
      startedAtSec: startedAtEpochSec,
      endedAtSec: startedAtEpochSec,
      status: 'active',
      currentNoiseFloorDb: -80,
      noisePolluted: false,
      quietIntervals: [],
    };

    this.session = {
      ...this.session,
      updatedAtEpochSec: Math.floor(Date.now() / 1000),
      episodes: [...this.session.episodes, newEpisode],
    };

    return newEpisode;
  }

  /**
   * Updates episode telemetry with real-time in-band noise floor and pollution gating.
   */
  public updateEpisodeNoise(
    episodeId: string,
    currentNoiseFloorDb: number,
    noisePolluted: boolean,
    currentEpochSec: number,
  ): void {
    const episodes = this.session.episodes.map((ep) => {
      if (ep.id !== episodeId || ep.status !== 'active') {
        return ep;
      }

      return {
        ...ep,
        endedAtSec: currentEpochSec,
        currentNoiseFloorDb,
        noisePolluted,
      };
    });

    this.session = {
      ...this.session,
      updatedAtEpochSec: Math.floor(Date.now() / 1000),
      episodes,
    };
  }

  /**
   * Pauses an active listening episode (e.g. user pauses, device enters sleep, or ambient noise exceeds threshold).
   */
  public pauseEpisode(episodeId: string, pausedAtEpochSec: number): void {
    const episodes = this.session.episodes.map((ep) => {
      if (ep.id !== episodeId) {
        return ep;
      }

      return {
        ...ep,
        endedAtSec: pausedAtEpochSec,
        status: 'paused' as const,
      };
    });

    this.session = {
      ...this.session,
      updatedAtEpochSec: Math.floor(Date.now() / 1000),
      episodes,
    };
  }

  /**
   * Resumes a paused episode or starts a follow-up active episode within the session.
   */
  public resumeEpisode(episodeId: string, resumedAtEpochSec: number): ListeningEpisode {
    const existing = this.session.episodes.find((ep) => ep.id === episodeId);
    if (existing?.status === 'paused') {
      const episodes = this.session.episodes.map((ep) => {
        if (ep.id !== episodeId) {
          return ep;
        }

        return {
          ...ep,
          status: 'active' as const,
          endedAtSec: resumedAtEpochSec,
        };
      });
      this.session = {
        ...this.session,
        updatedAtEpochSec: Math.floor(Date.now() / 1000),
        episodes,
      };

      return { ...existing, status: 'active', endedAtSec: resumedAtEpochSec };
    }

    return this.startEpisode(resumedAtEpochSec);
  }

  /**
   * Ingests a new extracted DopplerObservation and performs sequential Bayesian refinement.
   *
   * - First flyover: creates candidate hypotheses along matching flight track cylinders.
   * - Second flyover: queries constellation hash index or pairs with existing observation to collapse candidates to curve intersections.
   * - Third+ flyovers: accumulates Fisher Information matrix (I_total = sum I_k) and tightens confidence ellipses (shrinking O(1/sqrt(N))).
   */
  public ingestObservation(obs: Readonly<DopplerObservation>): LocationSession {
    const soundSpeedMps = speedOfSoundAtTempMps(this.session.ambientTempCelsius);
    const existingObs = this.session.observations;
    const allObs = [...existingObs, obs];

    let newHypotheses: LocationHypothesis[] = [];

    if (existingObs.length === 0) {
      // Single flyover observation: find candidate segments whose speed and altitude profile match inferred kinematics
      newHypotheses = this.spawnInitialHypotheses(obs, soundSpeedMps);
    } else {
      // Pair with the most recent flyover to form a 2-event constellation
      const prevObs = existingObs[existingObs.length - 1];
      if (prevObs !== undefined) {
        const deltaSec = obs.cpaTimeSec - prevObs.cpaTimeSec;
        if (this.session.hypotheses.length === 0) {
          // Re-seed from constellation hash table
          newHypotheses = this.matchConstellations(prevObs, obs, deltaSec, soundSpeedMps);
        } else {
          // Sequentially refine existing hypotheses by fusing the new observation
          newHypotheses = this.refineExistingHypotheses(obs, soundSpeedMps);
        }
      }
    }

    // Apply active constraints
    newHypotheses = newHypotheses.filter((h) =>
      matchesSearchConstraints(
        { lat: h.lat, lon: h.lon, dateIso: h.dateIso, epochSec: h.estimatedStartEpochSec },
        this.session.constraints,
      ),
    );

    // Normalize probabilities using softmax over logPosterior
    if (newHypotheses.length > 0) {
      const maxLog = Math.max(...newHypotheses.map((h) => h.logPosterior));
      const expSum = newHypotheses.reduce((acc, h) => acc + Math.exp(h.logPosterior - maxLog), 0);
      newHypotheses = newHypotheses.map((h) => ({
        ...h,
        probability: expSum > 0 ? Math.exp(h.logPosterior - maxLog) / expSum : 1 / newHypotheses.length,
      }));
      newHypotheses.sort((a, b) => b.logPosterior - a.logPosterior);
    }

    this.session = {
      ...this.session,
      updatedAtEpochSec: Math.floor(Date.now() / 1000),
      observations: allObs,
      hypotheses: newHypotheses,
    };

    return this.session;
  }

  /**
   * Generates initial candidate hypotheses along flight tracks matching a single flyover.
   */
  private spawnInitialHypotheses(
    obs: Readonly<DopplerObservation>,
    soundSpeedMps: number,
  ): LocationHypothesis[] {
    const candidates: LocationHypothesis[] = [];
    const targetSpeed = obs.kinematics.inferredSpeedMps;
    const speedTolerance = Math.max(5.0, obs.kinematics.speedStdMps * 2.5);

    for (const seg of this.dataset.segments) {
      if (seg.category === 'jet') {
        continue;
      }
      if (Math.abs(seg.groundspeedMps - targetSpeed) > speedTolerance) {
        continue;
      }

      const center = decodeSpatialCellCenter(seg.h3Cell);
      const groundAlt = interpolateTerrainElevationMeters(center.lat, center.lon, this.dataset.elevationGrid);
      const seed: GeoPoint3D = { lat: center.lat, lon: center.lon, altMeters: groundAlt };

      const cpa = computeSegmentCpa(seed, seg, soundSpeedMps);
      if (Math.abs(cpa.cpaSlantMeters - obs.kinematics.inferredSlantMeters) > 3500) {
        continue;
      }

      const refined = refineObserverCoordinateGaussNewton(
        seed,
        [{ observation: obs, segment: seg }],
        { demGrid: this.dataset.elevationGrid, soundSpeedMps },
      );

      candidates.push({
        id: `hyp_${seg.id}_${String(candidates.length + 1)}`,
        h3Cell: seg.h3Cell,
        dateIso: seg.dateIso,
        lat: refined.lat,
        lon: refined.lon,
        altMeters: refined.altMeters,
        estimatedStartEpochSec: refined.estimatedStartEpochSec,
        logPosterior: refined.logLikelihood,
        probability: 0,
        rmsFreqResidualHz: refined.rmsFreqResidualHz,
        fisherInfo: refined.fisherInfo,
        ellipseSemiMajorMeters: refined.ellipseSemiMajorMeters,
        ellipseSemiMinorMeters: refined.ellipseSemiMinorMeters,
        ellipseBearingDeg: refined.ellipseBearingDeg,
        matchedSegmentIds: [seg.id],
      });
    }

    return candidates.slice(0, 15);
  }

  /**
   * Matches candidate constellations from the Shazam-style hash table.
   */
  private matchConstellations(
    obsA: Readonly<DopplerObservation>,
    obsB: Readonly<DopplerObservation>,
    deltaSec: number,
    soundSpeedMps: number,
  ): LocationHypothesis[] {
    const keys = expandConstellationQueryKeys(
      obsA.kinematics.inferredSpeedMps,
      obsB.kinematics.inferredSpeedMps,
      deltaSec,
    );

    const matchedEntries = this.dataset.constellations.filter((c) => keys.has(c.hashKey));
    const candidates: LocationHypothesis[] = [];

    for (const entry of matchedEntries) {
      const segA = this.segmentsById.get(entry.segmentIdA);
      const segB = this.segmentsById.get(entry.segmentIdB);
      if (segA === undefined || segB === undefined) {
        continue;
      }

      const groundAlt = interpolateTerrainElevationMeters(entry.centerLat, entry.centerLon, this.dataset.elevationGrid);
      const seed: GeoPoint3D = { lat: entry.centerLat, lon: entry.centerLon, altMeters: groundAlt };

      const refined = refineObserverCoordinateGaussNewton(
        seed,
        [
          { observation: obsA, segment: segA },
          { observation: obsB, segment: segB },
        ],
        { demGrid: this.dataset.elevationGrid, soundSpeedMps },
      );

      candidates.push({
        id: `hyp_${entry.segmentIdA}_${entry.segmentIdB}`,
        h3Cell: entry.h3Cell,
        dateIso: entry.dateIso,
        lat: refined.lat,
        lon: refined.lon,
        altMeters: refined.altMeters,
        estimatedStartEpochSec: refined.estimatedStartEpochSec,
        logPosterior: refined.logLikelihood,
        probability: 0,
        rmsFreqResidualHz: refined.rmsFreqResidualHz,
        fisherInfo: refined.fisherInfo,
        ellipseSemiMajorMeters: refined.ellipseSemiMajorMeters,
        ellipseSemiMinorMeters: refined.ellipseSemiMinorMeters,
        ellipseBearingDeg: refined.ellipseBearingDeg,
        matchedSegmentIds: [segA.id, segB.id],
      });
    }

    return candidates.slice(0, 15);
  }

  /**
   * Sequentially refines existing candidate hypotheses by incorporating a new observation into their Fisher Information matrix and Gauss-Newton solver.
   */
  private refineExistingHypotheses(
    newObs: Readonly<DopplerObservation>,
    soundSpeedMps: number,
  ): LocationHypothesis[] {
    const refinedList: LocationHypothesis[] = [];

    for (const hyp of this.session.hypotheses) {
      // Find matching segment for newObs in the candidate's vicinity
      const hypCoord: GeoPoint3D = { lat: hyp.lat, lon: hyp.lon, altMeters: hyp.altMeters };
      let bestSeg: LinearFlightSegment | null = null;
      let minSlantDiff = Infinity;

      const firstSeg = this.segmentsById.get(hyp.matchedSegmentIds[0] ?? '');
      const firstCpa = firstSeg !== undefined ? computeSegmentCpa(hypCoord, firstSeg, soundSpeedMps) : null;
      const expectedDeltaSec = newObs.cpaTimeSec - (this.session.observations[0]?.cpaTimeSec ?? 0);

      for (const seg of this.dataset.segments) {
        if (seg.dateIso !== hyp.dateIso || seg.category === 'jet') {
          continue;
        }
        if (hyp.matchedSegmentIds.includes(seg.id)) {
          continue;
        }
        if (Math.abs(seg.groundspeedMps - newObs.kinematics.inferredSpeedMps) > 18) {
          continue;
        }
        const cpa = computeSegmentCpa(hypCoord, seg, soundSpeedMps);
        if (firstCpa !== null) {
          const actualDeltaSec = cpa.cpaDelayedEpochSec - firstCpa.cpaDelayedEpochSec;
          if (Math.abs(actualDeltaSec - expectedDeltaSec) > 30) {
            continue;
          }
        }
        const slantDiff = Math.abs(cpa.cpaSlantMeters - newObs.kinematics.inferredSlantMeters);
        if (slantDiff < minSlantDiff && slantDiff < 4000) {
          minSlantDiff = slantDiff;
          bestSeg = seg;
        }
      }

      if (bestSeg === null) {
        // Hyp does not match new flyover; down-weight likelihood
        refinedList.push({
          ...hyp,
          logPosterior: hyp.logPosterior - 8.0,
        });
        continue;
      }

      // Re-run Gauss-Newton with all paired observations
      const existingPairs = hyp.matchedSegmentIds
        .map((segId, i) => {
          const seg = this.segmentsById.get(segId);
          const obs = this.session.observations[i];
          if (seg !== undefined && obs !== undefined) {
            return { observation: obs, segment: seg };
          }

          return null;
        })
        .filter((p): p is { observation: DopplerObservation; segment: LinearFlightSegment } => p !== null);

      const allPairs = [...existingPairs, { observation: newObs, segment: bestSeg }];

      const refined = refineObserverCoordinateGaussNewton(
        hypCoord,
        allPairs,
        { demGrid: this.dataset.elevationGrid, soundSpeedMps },
      );

      // Accumulate Fisher Information matrices: I_total = I_old + I_new
      const totalFisher: readonly [number, number, number, number] = [
        hyp.fisherInfo[0] + refined.fisherInfo[0],
        hyp.fisherInfo[1] + refined.fisherInfo[1],
        hyp.fisherInfo[2] + refined.fisherInfo[2],
        hyp.fisherInfo[3] + refined.fisherInfo[3],
      ];
      const ellipse = fisherToConfidenceEllipse95(totalFisher);

      refinedList.push({
        ...hyp,
        lat: refined.lat,
        lon: refined.lon,
        altMeters: refined.altMeters,
        estimatedStartEpochSec: refined.estimatedStartEpochSec,
        logPosterior: hyp.logPosterior + refined.logLikelihood,
        rmsFreqResidualHz: refined.rmsFreqResidualHz,
        fisherInfo: totalFisher,
        ellipseSemiMajorMeters: ellipse.ellipseSemiMajorMeters,
        ellipseSemiMinorMeters: ellipse.ellipseSemiMinorMeters,
        ellipseBearingDeg: ellipse.ellipseBearingDeg,
        matchedSegmentIds: [...hyp.matchedSegmentIds, bestSeg.id],
      });
    }

    return refinedList;
  }
}
