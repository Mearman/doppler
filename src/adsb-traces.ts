import { z } from 'zod';
import { define } from './define';
import { simplifyTrajectory4D } from './physics/rdp';
import type { AdsbPing, AircraftCategory, LinearFlightSegment } from './schemas';
import { SLANT_SIGMA_FLOOR_METERS } from './solver/gauss-newton';

/**
 * One trace sample as `adsb.lol` and `tar1090` write it: seconds since the trace's `timestamp`, latitude, longitude and barometric altitude in feet, which is the string `ground` on the ground and null when unreported. Later fields (ground speed, track, flags) are ignored.
 */
const RawTracePoint = z.tuple([z.number(), z.number(), z.number(), z.union([z.number(), z.literal('ground'), z.null()])]).rest(z.unknown());

/**
 * Raw trace format from `adsb.lol` or `tar1090` JSON exports.
 */
export const RawAdsbTraceFileSchema = define(
  z.object({
    icao: z.string().min(1),
    r: z.string().optional(),
    t: z.string().optional(),
    desc: z.string().optional(),
    /** Epoch seconds that each point's offset is counted from. */
    timestamp: z.number().optional(),
    trace: z.array(RawTracePoint),
  }),
);
export type RawAdsbTraceFile = z.infer<typeof RawAdsbTraceFileSchema>;

/** A latitude and longitude rectangle. */
export interface BoundingBox {
  readonly minLat: number;
  readonly minLon: number;
  readonly maxLat: number;
  readonly maxLon: number;
}

/** Options for turning raw traces into segments. */
export interface AdsbTraceOptions {
  /** Pings outside the box end the current run and are dropped, so memory and work follow the region rather than the whole archive. A flight audible from inside the box but flying outside it is lost, so the box should include the acoustic range (about 10 km) as margin. */
  readonly bbox?: Readonly<BoundingBox>;
  /** Largest 3D deviation, in metres, of a dropped ping from its segment. Defaults to half the solver's slant-distance sigma floor, so compression error cannot dominate the solver's own uncertainty. */
  readonly toleranceMeters?: number;
}

/** Altitude above which a ping is cruise traffic that the microphone is not expected to hear: 20,000 ft. */
const MAX_AUDIBLE_ALTITUDE_METERS = 6096;

/**
 * Ground speed, in m/s (about 195 knots), above which a segment of an aircraft whose type is not classified is dropped. Light propeller aircraft and helicopters seldom exceed it (about 2 percent of their segments in a sample of real traces), whereas most unclassified types are airliners that fly faster than this below 20,000 ft (about 56 percent of theirs) and have no narrowband propeller tone to match.
 */
const MAX_UNCLASSIFIED_SPEED_MPS = 100;

/** Metres in a foot. */
const METERS_PER_FOOT = 0.3048;

/**
 * Longest gap between pings that is still bridged by a straight line. Across a longer gap the aircraft can have turned, landed or left coverage, and at light-aircraft speeds (about 70 m/s) a two-minute gap is already about 8 km, comparable to the acoustic range, so the run is split instead.
 */
const MAX_PING_GAP_SEC = 120;

function inBox(lat: number, lon: number, box: Readonly<BoundingBox>): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

/**
 * Classifies an ICAO aircraft type code into a propulsion category.
 * @param typeCode - 4-character ICAO aircraft type designator (e.g. `C172`, `B738`, `DA42`, `EC35`).
 * @returns Propulsion category.
 */
export function classifyAircraftCategory(typeCode?: string): AircraftCategory {
  if (typeCode === undefined || typeCode === '') {
    return 'unknown';
  }
  const code = typeCode.toUpperCase().trim();

  // Known helicopters
  if (['R22', 'R44', 'R66', 'EC20', 'EC30', 'EC35', 'EC45', 'B06', 'B206', 'B407', 'AS50', 'A109', 'S76', 'H125', 'H135', 'H145', 'G2CA'].includes(code)) {
    return 'helicopter';
  }
  // Common piston / light propeller aircraft
  if (['C150', 'C152', 'C172', 'C182', 'C206', 'C210', 'PA28', 'PA32', 'PA34', 'PA44', 'SR20', 'SR22', 'DA20', 'DA40', 'DA42', 'P28A', 'AA5', 'BE36', 'BE58', 'M20T', 'RV7', 'RV8', 'RV10'].includes(code)) {
    return 'piston';
  }
  // Common turboprop aircraft
  if (['B350', 'BE20', 'PC12', 'TBM7', 'TBM8', 'TBM9', 'DH8D', 'AT72', 'AT76', 'AT45', 'C208', 'SW4', 'D228'].includes(code)) {
    return 'turboprop';
  }
  // Common commercial and business jet types
  if (['A319', 'A320', 'A321', 'A332', 'A333', 'A359', 'B737', 'B738', 'B739', 'B772', 'B77W', 'B788', 'B789', 'E190', 'E195', 'CRJ7', 'CRJ9', 'C56X', 'C680', 'GL5T', 'GLEX', 'FA7X', 'CL30'].includes(code)) {
    return 'jet';
  }

  return 'unknown';
}

/**
 * Converts a raw `adsb.lol` / `tar1090` trace object into compressed 4D piecewise-linear segments.
 * Jet categories are discarded. A ping on the ground, with no altitude, or above 20,000 ft ends the current run, and so does a gap of more than two minutes, so a segment never spans a landing, a climb to cruise or a loss of coverage.
 * @param trace - Raw ADS-B trace record.
 * @param dateIso - ISO calendar date (`YYYY-MM-DD`).
 * @param baseEpochSec - Epoch seconds that the trace's point offsets are counted from.
 * @param options - Region filter and compression tolerance.
 * @returns Array of linear flight segments.
 */
export function processRawAdsbTrace(
  trace: Readonly<RawAdsbTraceFile>,
  dateIso: string,
  baseEpochSec: number,
  options: Readonly<AdsbTraceOptions> = {},
): LinearFlightSegment[] {
  const typeCode = trace.t ?? 'unknown';
  const category = classifyAircraftCategory(typeCode);
  if (category === 'jet') {
    return [];
  }

  const runs: AdsbPing[][] = [];
  let run: AdsbPing[] = [];
  const endRun = (): void => {
    if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  };
  for (const [offsetSec, lat, lon, altFeet] of trace.trace) {
    const altMeters = typeof altFeet === 'number' ? altFeet * METERS_PER_FOOT : undefined;
    const { bbox } = options;
    if (altMeters === undefined || altMeters > MAX_AUDIBLE_ALTITUDE_METERS || (bbox !== undefined && !inBox(lat, lon, bbox))) {
      endRun();
      continue;
    }
    const epochSec = baseEpochSec + offsetSec;
    const previous = run[run.length - 1];
    if (previous !== undefined && epochSec - previous.epochSec > MAX_PING_GAP_SEC) {
      endRun();
    }
    run.push({ epochSec, lat, lon, altMeters });
  }
  endRun();

  return runs
    .flatMap((pings) =>
      simplifyTrajectory4D(pings, { flightId: trace.r ?? trace.icao, icao24: trace.icao, typeCode, category, dateIso }, options.toleranceMeters ?? SLANT_SIGMA_FLOOR_METERS / 2),
    )
    .filter((segment) => category !== 'unknown' || segment.groundspeedMps <= MAX_UNCLASSIFIED_SPEED_MPS);
}
