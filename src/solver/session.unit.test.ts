import { describe, expect, it } from 'vitest';
import { BUNDLED_DATASET, BUNDLED_GROUND_TRUTH } from '../bundled';
import type { DopplerObservation } from '../schemas';
import { refineObserverCoordinateGaussNewton } from './gauss-newton';
import { DopplerSessionEngine } from './session';

describe('DopplerSessionEngine Bayesian Continuous & Episodic Refinement', () => {
  it('sequentially fuses observations and shrinks the 95% confidence ellipse across pause/resume episodes', () => {
    const engine = new DopplerSessionEngine({
      dataset: BUNDLED_DATASET,
      ambientTempCelsius: 20.0,
    });

    // Episode 1: Initial active listening window
    const ep1 = engine.startEpisode(1788900000);
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
    engine.pauseEpisode(ep1.id, 1788900500);
    session = engine.getSession();
    expect(session.episodes[0]?.status).toBe('paused');

    // Resume later: Episode 2 starts
    const ep2 = engine.resumeEpisode(ep1.id, 1788900900);
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
      const dLat = (hypAfterObs2.lat - BUNDLED_GROUND_TRUTH.lat) * 111132;
      const dLon = (hypAfterObs2.lon - BUNDLED_GROUND_TRUTH.lon) * 68000;
      const errMeters = Math.hypot(dLat, dLon);
      expect(errMeters).toBeLessThan(150);
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
      expect(hypAfterObs3.ellipseSemiMajorMeters).toBeLessThan(120);
    }
  });

  it('updates noise floor and flags noise pollution during transient loud bursts', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(1000);

    // Normal quiet background: -82 dB
    engine.updateEpisodeNoise(ep.id, -82, false, 1010);
    let epState = engine.getSession().episodes[0];
    expect(epState?.noisePolluted).toBe(false);

    // Transient loud noise burst (truck passing): -55 dB
    engine.updateEpisodeNoise(ep.id, -55, true, 1025);
    epState = engine.getSession().episodes[0];
    expect(epState?.noisePolluted).toBe(true);
    expect(epState?.currentNoiseFloorDb).toBe(-55);
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
      { timeSec: cpaTimeSec - 5, freqHz: 151.0, snrDb: 20.0 },
      { timeSec: cpaTimeSec, freqHz: 145.0, snrDb: 25.0 },
      { timeSec: cpaTimeSec + 5, freqHz: 139.0, snrDb: 19.0 },
    ],
  });

describe('DopplerSessionEngine hypothesis scoring', () => {
  it('replaces an observation re-reported under the same id instead of stacking it', () => {
    const once = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = once.startEpisode(1788900000);
    once.ingestObservation(alphaObservation({ id: 'live', episodeId: ep.id }));

    const repeated = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const epRepeated = repeated.startEpisode(1788900000);
    for (let report = 0; report < 5; report += 1) {
      repeated.ingestObservation(alphaObservation({ id: 'live', episodeId: epRepeated.id }));
    }

    const expected = once.getSession().hypotheses[0];
    const actual = repeated.getSession().hypotheses[0];
    expect(repeated.getSession().observations).toHaveLength(1);
    expect(actual?.logPosterior).toBeCloseTo(expected?.logPosterior ?? Number.NaN, 9);
    expect(actual?.fisherInfo).toEqual(expected?.fisherInfo);
  });

  it('keeps each match bound to its own observation when a flyover in between fits no segment', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(1788900000);
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
    engine.ingestObservation(bravoObservation('third', ep.id, 1015.3));

    const top = engine.getSession().hypotheses[0];
    expect(top?.matches).toEqual([
      { observationId: 'first', segmentId: 'flyover_alpha' },
      { observationId: 'third', segmentId: 'flyover_bravo' },
    ]);
  });

  it('does not require episodes recorded separately to share a clock', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const first = engine.startEpisode(1788900000);
    engine.ingestObservation(alphaObservation({ id: 'file_a', episodeId: first.id }));
    // A second file's times start from its own zero, unrelated to the first file's.
    const second = engine.startEpisode(1788950000);
    engine.ingestObservation(bravoObservation('file_b', second.id, 41.0));

    // Timing cannot rank the segments across clocks, but the second file must still be matched: a shared-clock gate would reject every segment for it.
    expect(engine.getSession().hypotheses[0]?.matches.map((match) => match.observationId)).toEqual(['file_a', 'file_b']);
  });

  it('ranks candidates before the cut so the best fit survives a long candidate list', () => {
    const alpha = BUNDLED_DATASET.segments.find((segment) => segment.id === 'flyover_alpha');
    if (alpha === undefined) {
      throw new Error('bundled dataset lost flyover_alpha');
    }
    // Twenty decoys within the wind allowance come before the segment whose speed matches exactly.
    const decoys = Array.from({ length: 20 }, (_, index) => ({ ...alpha, id: `decoy_${String(index)}`, groundspeedMps: alpha.groundspeedMps + 12 }));
    const engine = new DopplerSessionEngine({ dataset: { ...BUNDLED_DATASET, segments: [...decoys, alpha] } });
    const ep = engine.startEpisode(1788900000);
    engine.ingestObservation(alphaObservation({ id: 'one', episodeId: ep.id }));

    expect(engine.getSession().hypotheses[0]?.matches[0]?.segmentId).toBe('flyover_alpha');
  });

  it('admits a segment whose ground speed differs from the Doppler speed by an ordinary wind', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(1788900000);
    const base = alphaObservation({ id: 'x', episodeId: ep.id });
    engine.ingestObservation({ ...base, kinematics: { ...base.kinematics, inferredSpeedMps: 66.8 - 12 } });

    expect(engine.getSession().hypotheses.map((hypothesis) => hypothesis.matches[0]?.segmentId)).toContain('flyover_alpha');
  });

  it('ranks the hypothesis that explains every flyover above one that skips one', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(1788900000);
    engine.ingestObservation(alphaObservation({ id: 'a', episodeId: ep.id }));
    engine.ingestObservation(bravoObservation('b', ep.id, 1015.3));

    const [top, ...rest] = engine.getSession().hypotheses;
    expect(top?.matches).toHaveLength(2);
    for (const other of rest) {
      expect(other.logPosterior).toBeLessThan(top?.logPosterior ?? Number.NEGATIVE_INFINITY);
    }
  });

  it('scores a hypothesis by the joint fit of its flyovers, counting each once', () => {
    const engine = new DopplerSessionEngine({ dataset: BUNDLED_DATASET });
    const ep = engine.startEpisode(1788900000);
    const observations = [alphaObservation({ id: 'a', episodeId: ep.id }), bravoObservation('b', ep.id, 1015.3), bravoObservation('c', ep.id, 1944.0)];
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

    expect(top.matches).toHaveLength(3);
    // Summing each step's refit would count the first flyover three times and drift far from the single joint fit.
    expect(Math.abs(top.logPosterior - joint.logLikelihood)).toBeLessThan(1);
  });

  it('seeds a new flyover from the segments when the constellation index has no pair for it', () => {
    // A dataset built from traffic holds no precomputed pairs.
    const engine = new DopplerSessionEngine({ dataset: { ...BUNDLED_DATASET, constellations: [] } });
    const ep = engine.startEpisode(1788900000);
    // The first flyover matches no segment, so nothing survives it and the second must start from scratch.
    const base = alphaObservation({ id: 'stray', episodeId: ep.id });
    engine.ingestObservation({ ...base, kinematics: { ...base.kinematics, inferredSpeedMps: 20 } });
    expect(engine.getSession().hypotheses).toHaveLength(0);
    engine.ingestObservation(alphaObservation({ id: 'real', episodeId: ep.id, cpaTimeSec: 600 }));

    const top = engine.getSession().hypotheses[0];
    expect(top?.matches).toEqual([{ observationId: 'real', segmentId: 'flyover_alpha' }]);
    // The earlier flyover that nothing explains still costs the hypothesis.
    expect(top?.logPosterior).toBeLessThan(-18);
  });
});

