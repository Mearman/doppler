import { describe, expect, it } from 'vitest';
import { BUNDLED_DATASET, BUNDLED_GROUND_TRUTH } from '../bundled';
import type { DopplerObservation } from '../schemas';
import { refineObserverCoordinateGaussNewton, unmatchedObservationLogPenalty } from './gauss-newton';
import { DopplerSessionEngine } from './session';

/** Start of the first listening episode in epoch seconds: the start time of the bundled alpha segment. */
const SESSION_START_EPOCH_SEC = 1788900000;
/** Pause and resume times in epoch seconds of the first episode in the pause and resume test. */
const EPISODE_PAUSE_EPOCH_SEC = 1788900500;
const EPISODE_RESUME_EPOCH_SEC = 1788900900;
/** Start in epoch seconds of a second recording that shares no clock with the first. */
const SEPARATE_RECORDING_START_EPOCH_SEC = 1788950000;
/** Time in seconds on the recording's own clock at which the bravo flyover peaks in the multi-flyover tests. */
const BRAVO_CPA_TIME_SEC = 1015.3;
/** Time in seconds on the recording's own clock at which a second bravo-shaped flyover peaks in the joint-fit test. */
const SECOND_BRAVO_CPA_TIME_SEC = 1944;
/** Time in seconds on the second recording's own clock at which its flyover peaks. */
const SEPARATE_RECORDING_CPA_TIME_SEC = 41;
/** Groundspeed in m/s of the bundled alpha segment, and the speed its observation measures. */
const ALPHA_SPEED_MPS = 66.8;
/** Speed offset in m/s that keeps a decoy or a measurement inside `MAX_ALONG_TRACK_WIND_MPS` of the alpha segment. */
const WITHIN_WIND_ALLOWANCE_MPS = 12;
/** Metres per degree of latitude, rounded, to convert the position error of the pause and resume test. */
const APPROX_METERS_PER_DEG_LAT = 111132;
/** Metres per degree of longitude at Oxford's latitude, rounded, for the same conversion. */
const APPROX_METERS_PER_DEG_LON = 68000;
/** Largest position error in metres of the best hypothesis after the second flyover. */
const MAX_POSITION_ERROR_METERS = 150;
/** Largest semi-major axis in metres of the best hypothesis's 95% ellipse after the third flyover. */
const MAX_ELLIPSE_SEMI_MAJOR_METERS = 120;
/** Episode start in epoch seconds, a quiet noise floor and a loud one in decibels, and the epoch seconds of their updates in the noise test. */
const NOISE_EPISODE_START_EPOCH_SEC = 1000;
const QUIET_NOISE_FLOOR_DB = -82;
const QUIET_UPDATE_EPOCH_SEC = 1010;
const LOUD_NOISE_FLOOR_DB = -55;
const LOUD_UPDATE_EPOCH_SEC = 1025;
/** Seconds either side of a flyover's peak at which its first and last ridge points sit. */
const RIDGE_HALF_SPAN_SEC = 5;
/** Number of times the same observation id is reported to the engine in the replacement test. */
const REPEATED_REPORT_COUNT = 5;
/** Decimal places `toBeCloseTo` compares log-posteriors to (a tolerance of 5e-10). */
const LOG_POSTERIOR_DIGITS = 9;

describe('DopplerSessionEngine Bayesian Continuous & Episodic Refinement', () => {
  it('sequentially fuses observations and shrinks the 95% confidence ellipse across pause/resume episodes', () => {
    const engine = new DopplerSessionEngine({
      dataset: BUNDLED_DATASET,
      ambientTempCelsius: 20.0,
    });

    // Episode 1: Initial active listening window
    const ep1 = engine.startEpisode(SESSION_START_EPOCH_SEC);
    expect(ep1.status).toBe('active');

    // Observation 1: Cessna 172 flyover (66.8 m/s, ~1385m slant)
    const obs1: DopplerObservation = {
      id: 'obs_1',
      episodeId: ep1.id,
      cpaTimeSec: 94.5,
      kinematics: {
        asymptoticHighHz: 133.0,
        asymptoticLowHz: 89.0,
        baseFreqHz: 110.0,
        inflectionSlopeHzPerSec: -0.75,
        inferredSpeedMps: 66.8,
        inferredSlantMeters: 1385.0,
        speedStdMps: 2.0,
        slantStdMeters: 100.0,
      },
      snrDb: 18.0,
      harmonicCount: 1,
      ridgePoints: [
        { timeSec: 89.5, freqHz: 113.8, snrDb: 18.0 },
        { timeSec: 94.5, freqHz: 110.0, snrDb: 22.0 },
        { timeSec: 99.5, freqHz: 106.2, snrDb: 17.5 },
      ],
    };

    engine.ingestObservation(obs1);
    let session = engine.getSession();
    expect(session.hypotheses.length).toBeGreaterThan(0);
    const hypAfterObs1 = session.hypotheses[0];
    expect(hypAfterObs1).toBeDefined();

    // Pause Episode 1 (e.g. user pauses or device enters sleep)
    engine.pauseEpisode(ep1.id, EPISODE_PAUSE_EPOCH_SEC);
    session = engine.getSession();
    expect(session.episodes[0]?.status).toBe('paused');

    // Resume later: Episode 2 starts
    const ep2 = engine.resumeEpisode(ep1.id, EPISODE_RESUME_EPOCH_SEC);
    expect(ep2.status).toBe('active');

    // Observation 2: Piper PA-28 flyover (77.9 m/s, ~1643m slant, ~921s later)
    const obs2: DopplerObservation = {
      id: 'obs_2',
      episodeId: ep2.id,
      cpaTimeSec: 1015.3,
      kinematics: {
        asymptoticHighHz: 182.0,
        asymptoticLowHz: 118.0,
        baseFreqHz: 145.0,
        inflectionSlopeHzPerSec: -1.2,
        inferredSpeedMps: 77.9,
        inferredSlantMeters: 1643.0,
        speedStdMps: 2.5,
        slantStdMeters: 90.0,
      },
      snrDb: 21.0,
      harmonicCount: 1,
      ridgePoints: [
        { timeSec: 1010.3, freqHz: 151.0, snrDb: 20.0 },
        { timeSec: 1015.3, freqHz: 145.0, snrDb: 25.0 },
        { timeSec: 1020.3, freqHz: 139.0, snrDb: 19.0 },
      ],
    };

    engine.ingestObservation(obs2);
    session = engine.getSession();
    const hypAfterObs2 = session.hypotheses[0];
    expect(hypAfterObs2).toBeDefined();
    if (hypAfterObs2 !== undefined) {
      // Coordinates should be close to ground truth (< 150m)
      const dLat = (hypAfterObs2.lat - BUNDLED_GROUND_TRUTH.lat) * APPROX_METERS_PER_DEG_LAT;
      const dLon = (hypAfterObs2.lon - BUNDLED_GROUND_TRUTH.lon) * APPROX_METERS_PER_DEG_LON;
      const errMeters = Math.hypot(dLat, dLon);
      expect(errMeters).toBeLessThan(MAX_POSITION_ERROR_METERS);
    }

    // Observation 3: Third aircraft flyover (DA42) further tightens the confidence ellipse
    const obs3: DopplerObservation = {
      id: 'obs_3',
      episodeId: ep2.id,
      cpaTimeSec: 1944.0,
      kinematics: {
        asymptoticHighHz: 152.0,
        asymptoticLowHz: 98.0,
        baseFreqHz: 120.0,
        inflectionSlopeHzPerSec: -0.85,
        inferredSpeedMps: 78.5,
        inferredSlantMeters: 1371.0,
        speedStdMps: 2.0,
        slantStdMeters: 80.0,
      },
      snrDb: 19.5,
      harmonicCount: 1,
      ridgePoints: [
        { timeSec: 1939.0, freqHz: 124.2, snrDb: 19.0 },
        { timeSec: 1944.0, freqHz: 120.0, snrDb: 23.0 },
        { timeSec: 1949.0, freqHz: 115.8, snrDb: 18.0 },
      ],
    };

    engine.ingestObservation(obs3);
    session = engine.getSession();
    const hypAfterObs3 = session.hypotheses[0];
    expect(hypAfterObs3).toBeDefined();

    if (hypAfterObs2 !== undefined && hypAfterObs3 !== undefined) {
      // 95% confidence ellipse shrinks with additional observation
      expect(hypAfterObs3.ellipseSemiMajorMeters).toBeLessThanOrEqual(hypAfterObs2.ellipseSemiMajorMeters);
      expect(hypAfterObs3.ellipseSemiMajorMeters).toBeLessThan(MAX_ELLIPSE_SEMI_MAJOR_METERS);
    }
  });

  it('updates noise floor and flags noise pollution during transient loud bursts', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(NOISE_EPISODE_START_EPOCH_SEC);

    // Normal quiet background: -82 dB
    engine.updateEpisodeNoise(ep.id, QUIET_NOISE_FLOOR_DB, false, QUIET_UPDATE_EPOCH_SEC);
    let epState = engine.getSession().episodes[0];
    expect(epState?.noisePolluted).toBe(false);

    // Transient loud noise burst (truck passing): -55 dB
    engine.updateEpisodeNoise(ep.id, LOUD_NOISE_FLOOR_DB, true, LOUD_UPDATE_EPOCH_SEC);
    epState = engine.getSession().episodes[0];
    expect(epState?.noisePolluted).toBe(true);
    expect(epState?.currentNoiseFloorDb).toBe(LOUD_NOISE_FLOOR_DB);
  });
});

/** A flyover of the bundled alpha segment (66.8 m/s, about 1385 m slant) with overrides for the fields a test varies. */
function alphaObservation(overrides: Partial<DopplerObservation> & Pick<DopplerObservation, 'id' | 'episodeId'>): DopplerObservation {
  return {
    cpaTimeSec: 94.5,
    kinematics: {
      asymptoticHighHz: 133.0,
      asymptoticLowHz: 89.0,
      baseFreqHz: 110.0,
      inflectionSlopeHzPerSec: -0.75,
      inferredSpeedMps: 66.8,
      inferredSlantMeters: 1385.0,
      speedStdMps: 2.0,
      slantStdMeters: 100.0,
    },
    snrDb: 18.0,
    harmonicCount: 1,
    ridgePoints: [
      { timeSec: 89.5, freqHz: 113.8, snrDb: 18.0 },
      { timeSec: 94.5, freqHz: 110.0, snrDb: 22.0 },
      { timeSec: 99.5, freqHz: 106.2, snrDb: 17.5 },
    ],
    ...overrides,
  };
}

const bravoObservation = (id: string, episodeId: string, cpaTimeSec: number): DopplerObservation =>
  alphaObservation({
    id,
    episodeId,
    cpaTimeSec,
    kinematics: {
      asymptoticHighHz: 182.0,
      asymptoticLowHz: 118.0,
      baseFreqHz: 145.0,
      inflectionSlopeHzPerSec: -1.2,
      inferredSpeedMps: 77.9,
      inferredSlantMeters: 1643.0,
      speedStdMps: 2.5,
      slantStdMeters: 90.0,
    },
    ridgePoints: [
      { timeSec: cpaTimeSec - RIDGE_HALF_SPAN_SEC, freqHz: 151.0, snrDb: 20.0 },
      { timeSec: cpaTimeSec, freqHz: 145.0, snrDb: 25.0 },
      { timeSec: cpaTimeSec + RIDGE_HALF_SPAN_SEC, freqHz: 139.0, snrDb: 19.0 },
    ],
  });

describe('DopplerSessionEngine hypothesis scoring', () => {
  it('replaces an observation re-reported under the same id instead of stacking it', () => {
    const once = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = once.startEpisode(SESSION_START_EPOCH_SEC);
    once.ingestObservation(alphaObservation({ id: 'live', episodeId: ep.id }));

    const repeated = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const epRepeated = repeated.startEpisode(SESSION_START_EPOCH_SEC);
    for (let report = 0; report < REPEATED_REPORT_COUNT; report += 1) {
      repeated.ingestObservation(alphaObservation({ id: 'live', episodeId: epRepeated.id }));
    }

    const expected = once.getSession().hypotheses[0];
    const actual = repeated.getSession().hypotheses[0];
    expect(repeated.getSession().observations).toHaveLength(1);
    expect(actual?.logPosterior).toBeCloseTo(expected?.logPosterior ?? Number.NaN, LOG_POSTERIOR_DIGITS);
    expect(actual?.fisherInfo).toEqual(expected?.fisherInfo);
  });

  it('keeps each match bound to its own observation when a flyover in between fits no segment', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(SESSION_START_EPOCH_SEC);
    engine.ingestObservation(alphaObservation({ id: 'first', episodeId: ep.id }));
    // 20 m/s is further from every bundled segment (66.8 to 78.5 m/s) than the wind allowance.
    engine.ingestObservation(
      alphaObservation({
        id: 'stray',
        episodeId: ep.id,
        cpaTimeSec: 500,
        kinematics: { ...alphaObservation({ id: 'x', episodeId: ep.id }).kinematics, inferredSpeedMps: 20 },
      }),
    );
    engine.ingestObservation(bravoObservation('third', ep.id, BRAVO_CPA_TIME_SEC));

    const top = engine.getSession().hypotheses[0];
    expect(top?.matches).toEqual([
      { observationId: 'first', segmentId: 'flyover_alpha' },
      { observationId: 'third', segmentId: 'flyover_bravo' },
    ]);
  });

  it('does not require episodes recorded separately to share a clock', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const first = engine.startEpisode(SESSION_START_EPOCH_SEC);
    engine.ingestObservation(alphaObservation({ id: 'file_a', episodeId: first.id }));
    // A second file's times start from its own zero, unrelated to the first file's.
    const second = engine.startEpisode(SEPARATE_RECORDING_START_EPOCH_SEC);
    engine.ingestObservation(bravoObservation('file_b', second.id, SEPARATE_RECORDING_CPA_TIME_SEC));

    // Timing cannot rank the segments across clocks, but the second file must still be matched: a shared-clock gate would reject every segment for it.
    expect(engine.getSession().hypotheses[0]?.matches.map((match) => match.observationId)).toEqual(['file_a', 'file_b']);
  });

  it('ranks candidates before the cut so the best fit survives a long candidate list', () => {
    const alpha = BUNDLED_DATASET.segments.find((segment) => segment.id === 'flyover_alpha');
    if (alpha === undefined) {
      throw new Error('bundled dataset lost flyover_alpha');
    }
    // Twenty decoys within the wind allowance come before the segment whose speed matches exactly.
    const decoys = Array.from({ length: 20 }, (_, index) => ({ ...alpha, id: `decoy_${String(index)}`, groundspeedMps: alpha.groundspeedMps + WITHIN_WIND_ALLOWANCE_MPS }));
    const engine = new DopplerSessionEngine({ dataset: { ...BUNDLED_DATASET, segments: [...decoys, alpha] } });
    const ep = engine.startEpisode(SESSION_START_EPOCH_SEC);
    engine.ingestObservation(alphaObservation({ id: 'one', episodeId: ep.id }));

    expect(engine.getSession().hypotheses[0]?.matches[0]?.segmentId).toBe('flyover_alpha');
  });

  it('admits a segment whose ground speed differs from the Doppler speed by an ordinary wind', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(SESSION_START_EPOCH_SEC);
    const base = alphaObservation({ id: 'x', episodeId: ep.id });
    engine.ingestObservation({ ...base, kinematics: { ...base.kinematics, inferredSpeedMps: ALPHA_SPEED_MPS - WITHIN_WIND_ALLOWANCE_MPS } });

    expect(engine.getSession().hypotheses.map((hypothesis) => hypothesis.matches[0]?.segmentId)).toContain('flyover_alpha');
  });

  it('ranks the hypothesis that explains every flyover above one that skips one', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(SESSION_START_EPOCH_SEC);
    engine.ingestObservation(alphaObservation({ id: 'a', episodeId: ep.id }));
    engine.ingestObservation(bravoObservation('b', ep.id, BRAVO_CPA_TIME_SEC));

    const [top, ...rest] = engine.getSession().hypotheses;
    expect(top?.matches).toHaveLength(2);
    for (const other of rest) {
      expect(other.logPosterior).toBeLessThan(top?.logPosterior ?? Number.NEGATIVE_INFINITY);
    }
  });

  it('scores a hypothesis by the joint fit of its flyovers, counting each once', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(SESSION_START_EPOCH_SEC);
    const observations = [alphaObservation({ id: 'a', episodeId: ep.id }), bravoObservation('b', ep.id, BRAVO_CPA_TIME_SEC), bravoObservation('c', ep.id, SECOND_BRAVO_CPA_TIME_SEC)];
    for (const observation of observations) {
      engine.ingestObservation(observation);
    }

    const top = engine.getSession().hypotheses[0];
    if (top === undefined) {
      throw new Error('no hypothesis survived three flyovers');
    }
    const pairs = top.matches.flatMap((match) => {
      const observation = observations.find((candidate) => candidate.id === match.observationId);
      const segment = BUNDLED_DATASET.segments.find((candidate) => candidate.id === match.segmentId);

      return observation !== undefined && segment !== undefined ? [{ observation, segment }] : [];
    });
    const joint = refineObserverCoordinateGaussNewton({ lat: top.lat, lon: top.lon, altMeters: top.altMeters }, pairs, { demGrid: BUNDLED_DATASET.elevationGrid });

    expect(top.matches).toHaveLength(observations.length);
    // Summing each step's refit would count the first flyover three times and drift far from the single joint fit.
    expect(Math.abs(top.logPosterior - joint.logLikelihood)).toBeLessThan(1);
  });

  it('seeds a new flyover from the segments when the constellation index has no pair for it', () => {
    // A dataset built from traffic holds no precomputed pairs.
    const engine = new DopplerSessionEngine({ dataset: { ...BUNDLED_DATASET, constellations: [] } });
    const ep = engine.startEpisode(SESSION_START_EPOCH_SEC);
    // The first flyover matches no segment, so nothing survives it and the second must start from scratch.
    const base = alphaObservation({ id: 'stray', episodeId: ep.id });
    const stray = { ...base, kinematics: { ...base.kinematics, inferredSpeedMps: 20 } };
    engine.ingestObservation(stray);
    expect(engine.getSession().hypotheses).toHaveLength(0);
    engine.ingestObservation(alphaObservation({ id: 'real', episodeId: ep.id, cpaTimeSec: 600 }));

    const top = engine.getSession().hypotheses[0];
    expect(top?.matches).toEqual([{ observationId: 'real', segmentId: 'flyover_alpha' }]);
    // The earlier flyover that nothing explains still costs the hypothesis its full penalty, and a fit's log-likelihood is never positive.
    expect(top?.logPosterior).toBeLessThan(-unmatchedObservationLogPenalty(stray));
  });
});

