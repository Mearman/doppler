import type { LocationHypothesis } from '../../src/schemas';

/** How far the estimate can be trusted, as a reader would put it. */
export type Confidence = 'high' | 'moderate' | 'low';

/** Probability at or above which the leading candidate clearly beats the rest of the field. */
const HIGH_PROBABILITY = 0.8;

/** Probability below which the leading candidate is little better than the alternatives. */
const LOW_PROBABILITY = 0.5;

/** Semi-major axis, in metres, at or below which the estimate pins the observer to a few streets. */
const PRECISE_RADIUS_M = 500;

/** Semi-major axis, in metres, above which the estimate covers a whole district or more. */
const VAGUE_RADIUS_M = 5000;

/** Metres in a kilometre, for switching the unit of a distance. */
const METRES_PER_KM = 1000;

/**
 * Grades an estimate from how likely the leading candidate is and how tightly its ellipse bounds it.
 * @param hypothesis - The leading candidate.
 * @returns High when the candidate is both likely and tight, low when it is unlikely or vague, otherwise moderate.
 */
export function confidenceOf(hypothesis: Readonly<Pick<LocationHypothesis, 'probability' | 'ellipseSemiMajorMeters'>>): Confidence {
  if (hypothesis.probability < LOW_PROBABILITY || hypothesis.ellipseSemiMajorMeters > VAGUE_RADIUS_M) {
    return 'low';
  }

  return hypothesis.probability >= HIGH_PROBABILITY && hypothesis.ellipseSemiMajorMeters <= PRECISE_RADIUS_M ? 'high' : 'moderate';
}

/**
 * Formats a distance in the unit a person reads it in.
 * @param metres - The distance in metres.
 * @returns Whole metres below a kilometre, otherwise kilometres to one decimal place.
 */
export function formatDistance(metres: number): string {
  return metres < METRES_PER_KM ? `${String(Math.round(metres))} m` : `${(metres / METRES_PER_KM).toFixed(1)} km`;
}

/**
 * Formats a position with hemisphere letters, so that a negative longitude reads as west rather than as a minus sign beside "E".
 * @param lat - Latitude in degrees, north positive.
 * @param lon - Longitude in degrees, east positive.
 * @returns The position, such as `51.75200° N, 1.25770° W`.
 */
export function formatCoordinates(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/**
 * Says what the leading candidate means in plain words.
 * @param hypothesis - The leading candidate.
 * @returns A sentence stating the radius that holds the observer with 95% probability.
 */
export function describeEstimate(hypothesis: Readonly<LocationHypothesis>): string {
  return `About 95% likely to be within ${formatDistance(hypothesis.ellipseSemiMajorMeters)} of ${formatCoordinates(hypothesis.lat, hypothesis.lon)}.`;
}

/**
 * Builds a link that shows a position on OpenStreetMap with a marker.
 * @param lat - Latitude in degrees.
 * @param lon - Longitude in degrees.
 * @returns The URL of the map page centred on the position.
 */
export function mapLink(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=15/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}
