import { describe, expect, it } from 'vitest';
import { BUNDLED_DATASET, BUNDLED_GROUND_TRUTH } from '../bundled';
import type { DopplerObservation } from '../schemas';
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
