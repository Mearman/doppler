import { describe, expect, it } from 'vitest';
import { confidenceOf, describeEstimate, formatCoordinates, formatDistance, mapLink } from './result-summary';
import type { LocationHypothesis } from '../../src/schemas';

describe('confidenceOf', () => {
  it('is high only when the candidate is both likely and tight', () => {
    expect(confidenceOf({ probability: 0.9, ellipseSemiMajorMeters: 200 })).toBe('high');
    expect(confidenceOf({ probability: 0.9, ellipseSemiMajorMeters: 2000 })).toBe('moderate');
    expect(confidenceOf({ probability: 0.6, ellipseSemiMajorMeters: 200 })).toBe('moderate');
  });

  it('is low when the candidate is unlikely or vague', () => {
    expect(confidenceOf({ probability: 0.3, ellipseSemiMajorMeters: 100 })).toBe('low');
    expect(confidenceOf({ probability: 0.95, ellipseSemiMajorMeters: 20_000 })).toBe('low');
  });
});

describe('formatDistance', () => {
  it('switches from metres to kilometres at a kilometre', () => {
    expect(formatDistance(340.4)).toBe('340 m');
    expect(formatDistance(999)).toBe('999 m');
    expect(formatDistance(1000)).toBe('1.0 km');
    expect(formatDistance(12_340)).toBe('12.3 km');
  });
});

describe('formatCoordinates', () => {
  it('names the hemisphere instead of printing a sign', () => {
    expect(formatCoordinates(51.752, -1.2577)).toBe('51.75200° N, 1.25770° W');
    expect(formatCoordinates(-33.8688, 151.2093)).toBe('33.86880° S, 151.20930° E');
  });
});

describe('describeEstimate', () => {
  it('states the 95% radius and the position', () => {
    const hypothesis = { lat: 51.752, lon: -1.2577, ellipseSemiMajorMeters: 340 } as LocationHypothesis;

    expect(describeEstimate(hypothesis)).toBe('About 95% likely to be within 340 m of 51.75200° N, 1.25770° W.');
  });
});

describe('mapLink', () => {
  it('marks and centres the position', () => {
    expect(mapLink(51.752, -1.2577)).toBe('https://www.openstreetmap.org/?mlat=51.752000&mlon=-1.257700#map=15/51.752000/-1.257700');
  });
});
