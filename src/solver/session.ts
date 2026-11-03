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
  HypothesisMatch,
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
  MAX_ALONG_TRACK_WIND_MPS,
  refineObserverCoordinateGaussNewton,
  unmatchedObservationLogPenalty,
} from './gauss-newton';

/** Hypotheses kept after ranking, which bounds the work each further flyover costs. */
const MAX_HYPOTHESES = 15;

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
   * Ingests an extracted DopplerObservation and performs sequential Bayesian refinement.
   *
   * - First flyover: creates candidate hypotheses along matching flight track cylinders.
   * - Second flyover: queries constellation hash index or pairs with existing observation to collapse candidates to curve intersections.
   * - Third+ flyovers: refits each surviving hypothesis on every flyover it explains, so the Fisher Information matrix is that of the joint fit (shrinking O(1/sqrt(N))) and no flyover is counted twice.
   *
   * An observation whose id was ingested before replaces it, and the hypotheses are rebuilt from the whole list: a live listener re-reports a growing flyover under one id, and the latest report must not stack on the earlier ones.
   */
  public ingestObservation(obs: Readonly<DopplerObservation>): LocationSession {
    const index = this.session.observations.findIndex((existing) => existing.id === obs.id);
    if (index === -1) {
      return this.applyObservation(obs);
    }
    const observations = this.session.observations.map((existing, position) => (position === index ? obs : existing));
    this.session = { ...this.session, observations: [], hypotheses: [] };
    for (const observation of observations) {
      this.applyObservation(observation);
    }

    return this.session;
  }

  private applyObservation(obs: Readonly<DopplerObservation>): LocationSession {
    const soundSpeedMps = speedOfSoundAtTempMps(this.session.ambientTempCelsius);
    const existingObs = this.session.observations;
    const allObs = [...existingObs, obs];

    let newHypotheses: LocationHypothesis[] = [];

    if (existingObs.length === 0) {
      // Single flyover observation: find candidate segments whose speed and altitude profile match inferred kinematics
      newHypotheses = this.spawnInitialHypotheses(obs, soundSpeedMps);
    } else if (this.session.hypotheses.length === 0) {
      // Re-seed from the constellation hash table, pairing with the latest flyover on the same clock: a time gap is meaningful only within one episode.
      const prevObs = existingObs.findLast((candidate) => candidate.episodeId === obs.episodeId);
      newHypotheses =
        prevObs === undefined
          ? this.spawnInitialHypotheses(obs, soundSpeedMps)
          : this.matchConstellations({ obsA: prevObs, obsB: obs, allObs }, soundSpeedMps);
    } else {
      // Sequentially refine existing hypotheses by fusing the new observation
      newHypotheses = this.refineExistingHypotheses(obs, soundSpeedMps);
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
   * Log-posterior of a hypothesis: the joint fit of the flyovers it explains, less the cost of every flyover it leaves unexplained.
   */
  private static scoreHypothesis(
    fitLogLikelihood: number,
    allObs: readonly Readonly<DopplerObservation>[],
    matches: readonly Readonly<HypothesisMatch>[],
  ): number {
    const unexplained = allObs.filter((obs) => !matches.some((match) => match.observationId === obs.id));

    return fitLogLikelihood - unexplained.reduce((total, obs) => total + unmatchedObservationLogPenalty(obs), 0);
  }

  /**
   * Allowed speed difference between a measured Doppler speed and a segment's ground speed, which differ by the along-track wind.
   */
  private static speedTolerance(kinematics: Readonly<DopplerObservation['kinematics']>): number {
    return Math.max(MAX_ALONG_TRACK_WIND_MPS, kinematics.speedStdMps * 2.5);
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
    const speedTolerance = DopplerSessionEngine.speedTolerance(obs.kinematics);

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
        matches: [{ observationId: obs.id, segmentId: seg.id }],
      });
    }

    return DopplerSessionEngine.keepBest(candidates);
  }

  /**
   * Keeps the best-scoring hypotheses. Ranking comes before the cut: dataset order says nothing about fit, so cutting first can discard the true track.
   */
  private static keepBest(candidates: readonly LocationHypothesis[]): LocationHypothesis[] {
    return [...candidates].sort((a, b) => b.logPosterior - a.logPosterior).slice(0, MAX_HYPOTHESES);
  }

  /**
   * Matches candidate constellations from the Shazam-style hash table.
   */
  private matchConstellations(
    flyovers: { readonly obsA: Readonly<DopplerObservation>; readonly obsB: Readonly<DopplerObservation>; readonly allObs: readonly Readonly<DopplerObservation>[] },
    soundSpeedMps: number,
  ): LocationHypothesis[] {
    const { obsA, obsB, allObs } = flyovers;
    const keys = expandConstellationQueryKeys(
      obsA.kinematics.inferredSpeedMps,
      obsB.kinematics.inferredSpeedMps,
      obsB.cpaTimeSec - obsA.cpaTimeSec,
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
      const matches: HypothesisMatch[] = [
        { observationId: obsA.id, segmentId: segA.id },
        { observationId: obsB.id, segmentId: segB.id },
      ];

      candidates.push({
        id: `hyp_${entry.segmentIdA}_${entry.segmentIdB}`,
        h3Cell: entry.h3Cell,
        dateIso: entry.dateIso,
        lat: refined.lat,
        lon: refined.lon,
        altMeters: refined.altMeters,
        estimatedStartEpochSec: refined.estimatedStartEpochSec,
        logPosterior: DopplerSessionEngine.scoreHypothesis(refined.logLikelihood, allObs, matches),
        probability: 0,
        rmsFreqResidualHz: refined.rmsFreqResidualHz,
        fisherInfo: refined.fisherInfo,
        ellipseSemiMajorMeters: refined.ellipseSemiMajorMeters,
        ellipseSemiMinorMeters: refined.ellipseSemiMinorMeters,
        ellipseBearingDeg: refined.ellipseBearingDeg,
        matches,
      });
    }

    return DopplerSessionEngine.keepBest(candidates);
  }

  /**
   * Sequentially refines existing candidate hypotheses by refitting each on every flyover it explains, the new one included.
   */
  private refineExistingHypotheses(
    newObs: Readonly<DopplerObservation>,
    soundSpeedMps: number,
  ): LocationHypothesis[] {
    const refinedList: LocationHypothesis[] = [];
    const allObs = [...this.session.observations, newObs];
    const observationsById = new Map(allObs.map((obs) => [obs.id, obs]));

    for (const hyp of this.session.hypotheses) {
      // Find matching segment for newObs in the candidate's vicinity
      const hypCoord: GeoPoint3D = { lat: hyp.lat, lon: hyp.lon, altMeters: hyp.altMeters };
      let bestSeg: LinearFlightSegment | null = null;
      let minSlantDiff = Infinity;

      const firstMatch = hyp.matches[0];
      const firstSeg = firstMatch === undefined ? undefined : this.segmentsById.get(firstMatch.segmentId);
      const firstObs = firstMatch === undefined ? undefined : observationsById.get(firstMatch.observationId);
      const firstCpa = firstSeg === undefined ? null : computeSegmentCpa(hypCoord, firstSeg, soundSpeedMps);
      // The arrival-time gap is checkable only against a flyover recorded on the same clock.
      const timingReference = firstCpa !== null && firstObs?.episodeId === newObs.episodeId ? { firstCpa, firstObs } : null;
      const speedTolerance = DopplerSessionEngine.speedTolerance(newObs.kinematics);

      for (const seg of this.dataset.segments) {
        if (seg.dateIso !== hyp.dateIso || seg.category === 'jet') {
          continue;
        }
        if (hyp.matches.some((match) => match.segmentId === seg.id)) {
          continue;
        }
        if (Math.abs(seg.groundspeedMps - newObs.kinematics.inferredSpeedMps) > speedTolerance) {
          continue;
        }
        const cpa = computeSegmentCpa(hypCoord, seg, soundSpeedMps);
        if (timingReference !== null) {
          const expectedDeltaSec = newObs.cpaTimeSec - timingReference.firstObs.cpaTimeSec;
          const actualDeltaSec = cpa.cpaDelayedEpochSec - timingReference.firstCpa.cpaDelayedEpochSec;
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
        // The hypothesis does not explain the new flyover: it pays the cost of leaving it unexplained.
        refinedList.push({
          ...hyp,
          logPosterior: hyp.logPosterior - unmatchedObservationLogPenalty(newObs),
        });
        continue;
      }

      // Refit on every flyover the hypothesis explains, found by observation id
      const matches: HypothesisMatch[] = [...hyp.matches, { observationId: newObs.id, segmentId: bestSeg.id }];
      const pairs = matches.flatMap((match) => {
        const observation = observationsById.get(match.observationId);
        const segment = this.segmentsById.get(match.segmentId);

        return observation !== undefined && segment !== undefined ? [{ observation, segment }] : [];
      });

      // The refit is over all pairs, so its log-likelihood and Fisher Information replace the hypothesis's earlier ones: adding them would count each earlier flyover again.
      const refined = refineObserverCoordinateGaussNewton(
        hypCoord,
        pairs,
        { demGrid: this.dataset.elevationGrid, soundSpeedMps },
      );

      refinedList.push({
        ...hyp,
        lat: refined.lat,
        lon: refined.lon,
        altMeters: refined.altMeters,
        estimatedStartEpochSec: refined.estimatedStartEpochSec,
        logPosterior: DopplerSessionEngine.scoreHypothesis(refined.logLikelihood, allObs, matches),
        rmsFreqResidualHz: refined.rmsFreqResidualHz,
        fisherInfo: refined.fisherInfo,
        ellipseSemiMajorMeters: refined.ellipseSemiMajorMeters,
        ellipseSemiMinorMeters: refined.ellipseSemiMinorMeters,
        ellipseBearingDeg: refined.ellipseBearingDeg,
        matches,
      });
    }

    return refinedList;
  }
}
