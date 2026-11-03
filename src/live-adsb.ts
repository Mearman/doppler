import { z } from 'zod';
import { type AdsbTraceOptions, type RawAdsbTraceFile, processRawAdsbTrace } from './adsb-traces';
import { define } from './define';
import type { DopplerDataset, LinearFlightSegment } from './schemas';
import { buildConstellationIndex } from './solver/constellation';
import { KM_PER_NM, MAX_RADIUS_NM } from './live-limits';
import { MS_PER_SECOND } from './time';

/** Base URL of the project's relay Worker, which serves adsb.lol's keyless point API with CORS headers (no ADS-B service sends them to browsers itself). */
export const RELAY_BASE_URL = 'https://doppler-adsb-relay.joseph-b4f.workers.dev';

/** Largest search radius, in kilometres, the relay forwards. */
export const MAX_RADIUS_KM = MAX_RADIUS_NM * KM_PER_NM;

/** Seconds of tracks the live book keeps. A listening episode lasts minutes, so a window several times that keeps every aircraft that passed during one, while older traffic stays out of the match. */
export const LIVE_WINDOW_SEC = 1200;

/** HTTP statuses that mean the relay will not serve this query (a path or radius it refuses), which a retry cannot fix, and that the upstream is over its rate, which a wait does. */
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;

/** Decimal places of a coordinate in the query: 1e-2 degrees is about 1 km, far finer than the search radius needs, and the relay rounds to the same so that nearby pages share a cached answer. */
const COORDINATE_DECIMALS = 2;

/** Characters of the ISO 8601 calendar date (`YYYY-MM-DD`) at the start of a `Date.toISOString()` string. */
const ISO_DATE_LENGTH = 'YYYY-MM-DD'.length;

/** One aircraft in a readsb `aircraft.json` style response, which tar1090 and adsb.lol use. Altitude is barometric in feet, or the string `ground`. */
const ReadsbAircraftSchema = define(
  z.object({
    hex: z.string().min(1),
    r: z.string().optional(),
    t: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    alt_baro: z.union([z.number(), z.literal('ground')]).optional(),
    /** Seconds since the position was last updated. */
    seen_pos: z.number().optional(),
  }),
);

/** The response of a point query: the time it describes in epoch milliseconds (adsb.lol's unit) and the aircraft in range. */
const ReadsbResponseSchema = define(z.object({ now: z.number(), ac: z.array(ReadsbAircraftSchema) }));

/** One position report of one aircraft. */
export interface LivePing {
  readonly icao: string;
  readonly registration: string | undefined;
  readonly typeCode: string | undefined;
  readonly epochSec: number;
  readonly lat: number;
  readonly lon: number;
  /** Barometric altitude in feet, `ground` on the ground and null when unreported. */
  readonly altitudeFt: number | 'ground' | null;
}

/**
 * Reads the position reports out of a point query response, dating each by when the position was last updated rather than when the answer was sent.
 * @param response - The parsed JSON of a point query.
 * @returns One ping per aircraft that reported a position.
 * @throws When the value is not a readsb style response.
 */
export function livePingsFromResponse(response: unknown): LivePing[] {
  const { now, ac } = ReadsbResponseSchema.parse(response);

  return ac.flatMap((aircraft) =>
    aircraft.lat === undefined || aircraft.lon === undefined
      ? []
      : [{ icao: aircraft.hex, registration: aircraft.r, typeCode: aircraft.t, epochSec: now / MS_PER_SECOND - (aircraft.seen_pos ?? 0), lat: aircraft.lat, lon: aircraft.lon, altitudeFt: aircraft.alt_baro ?? null }],
  );
}

/** Accumulates position reports into a rolling window of tracks and turns them into the same flight segments an archive trace gives. */
export class LiveTrackBook {
  private readonly pingsByAircraft = new Map<string, LivePing[]>();

  private newestEpochSec = 0;

  public constructor(private readonly windowSec: number = LIVE_WINDOW_SEC) {}

  /**
   * Adds position reports and drops those older than the window, measured from the newest report seen.
   * @param pings - Reports from one poll; a report already held for the same aircraft and time is ignored.
   */
  public add(pings: readonly LivePing[]): void {
    for (const ping of pings) {
      this.newestEpochSec = Math.max(this.newestEpochSec, ping.epochSec);
      const held = this.pingsByAircraft.get(ping.icao) ?? [];
      if (!held.some((existing) => existing.epochSec === ping.epochSec)) {
        held.push(ping);
        this.pingsByAircraft.set(ping.icao, held);
      }
    }
    const oldest = this.newestEpochSec - this.windowSec;
    for (const [icao, held] of this.pingsByAircraft) {
      const recent = held.filter((ping) => ping.epochSec >= oldest);
      if (recent.length === 0) {
        this.pingsByAircraft.delete(icao);
      } else {
        this.pingsByAircraft.set(icao, recent);
      }
    }
  }

  /** Number of aircraft with at least one report in the window. */
  public get aircraftCount(): number {
    return this.pingsByAircraft.size;
  }

  /**
   * Builds segments from the tracks held, with the filters an archive trace gets: no jets, nothing on the ground or above audible altitude, no run across a long gap.
   * @param options - Compression tolerance and region filter.
   * @returns The segments of every aircraft with enough reports to form one; an aircraft seen once gives none.
   */
  public segments(options: Readonly<AdsbTraceOptions> = {}): LinearFlightSegment[] {
    return [...this.pingsByAircraft.values()].flatMap((held) => {
      const sorted = [...held].sort((a, b) => a.epochSec - b.epochSec);
      const first = sorted[0];
      if (first === undefined) {
        return [];
      }
      const trace: RawAdsbTraceFile = {
        icao: first.icao,
        ...(first.registration === undefined ? {} : { r: first.registration }),
        ...(first.typeCode === undefined ? {} : { t: first.typeCode }),
        timestamp: first.epochSec,
        trace: sorted.map((ping): RawAdsbTraceFile['trace'][number] => [ping.epochSec - first.epochSec, ping.lat, ping.lon, ping.altitudeFt]),
      };

      return processRawAdsbTrace(trace, new Date(first.epochSec * MS_PER_SECOND).toISOString().slice(0, ISO_DATE_LENGTH), first.epochSec, options);
    });
  }
}

/**
 * Wraps segments as a dataset, with the constellation index the solver matches against and no terrain.
 * @param segments - Flight segments.
 * @param generatedAtEpochSec - When the segments were assembled.
 * @returns A dataset whose version is `live`.
 */
export function liveDataset(segments: readonly LinearFlightSegment[], generatedAtEpochSec: number): DopplerDataset {
  return {
    version: 'live',
    generatedAtIso: new Date(generatedAtEpochSec * MS_PER_SECOND).toISOString(),
    segments,
    constellations: buildConstellationIndex(segments),
    elevationGrid: [],
  };
}

/** A point query: aircraft within a radius of a position. */
export interface LiveQuery {
  readonly lat: number;
  readonly lon: number;
  readonly radiusKm: number;
}

/** Why a poll did not return aircraft. */
export class LiveFeedError extends Error {
  /** Seconds the service asked the caller to wait before asking again, from `Retry-After`, when it sent one. */
  public readonly retryAfterSec: number | undefined;

  /** Whether asking again with the same query will fail the same way, as it does for a radius the relay refuses. */
  public readonly fatal: boolean;

  public constructor(message: string, options: Readonly<{ retryAfterSec: number | undefined; fatal: boolean }>) {
    super(message);
    this.name = 'LiveFeedError';
    this.retryAfterSec = options.retryAfterSec;
    this.fatal = options.fatal;
  }
}

/**
 * Asks the relay for the aircraft within a radius of a point.
 * @param query - The centre and the radius, which is limited to what the relay forwards.
 * @param signal - Cancels the request.
 * @returns The position reports in the answer.
 * @throws LiveFeedError when the relay refuses the query (404) or the upstream is over its rate (429), or answers with anything but success.
 */
export async function fetchLivePings(query: Readonly<LiveQuery>, signal: AbortSignal): Promise<LivePing[]> {
  const radiusNm = Math.min(Math.ceil(query.radiusKm / KM_PER_NM), MAX_RADIUS_NM);
  const response = await fetch(`${RELAY_BASE_URL}/v2/point/${query.lat.toFixed(COORDINATE_DECIMALS)}/${query.lon.toFixed(COORDINATE_DECIMALS)}/${String(radiusNm)}`, { signal });
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new LiveFeedError(describeRefusal(response.status), {
      retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      fatal: response.status === HTTP_NOT_FOUND,
    });
  }

  return livePingsFromResponse(await response.json());
}

/**
 * Says what an HTTP status from the relay means to the person using the feed.
 * @param status - The response status.
 * @returns A sentence naming the likely cause.
 */
function describeRefusal(status: number): string {
  switch (status) {
    case HTTP_NOT_FOUND:
      return 'The live relay does not serve this query. The page and the relay disagree about what is allowed, so the feed stopped.';
    case HTTP_TOO_MANY_REQUESTS:
      return 'The live relay is being rate limited and will be asked again shortly.';
    default:
      return `The live relay answered with status ${String(status)}.`;
  }
}
