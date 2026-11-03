import { readFileSync, writeFileSync } from 'node:fs';
import { simplifyTrajectory4D } from '../physics/rdp';
import type { AdsbPing, AircraftCategory, GeoPoint3D, LinearFlightSegment } from '../schemas';
import { DopplerDataset } from '../schemas';
import { buildConstellationIndex } from '../solver/constellation';

/**
 * Raw trace format from `adsb.lol` or `tar1090` JSON exports.
 */
export interface RawAdsbTraceFile {
  readonly icao: string;
  readonly r?: string;
  readonly t?: string;
  readonly desc?: string;
  readonly trace: readonly (readonly [number, number, number, number])[];
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
 * Discards segments above 20,000 ft (6,096 m) and jet categories.
 * @param trace - Raw ADS-B trace record.
 * @param dateIso - ISO calendar date (`YYYY-MM-DD`).
 * @param baseEpochSec - Day start UTC epoch in seconds.
 * @returns Array of linear flight segments.
 */
export function processRawAdsbTrace(
  trace: Readonly<RawAdsbTraceFile>,
  dateIso: string,
  baseEpochSec: number,
): LinearFlightSegment[] {
  const typeCode = trace.t ?? 'unknown';
  const category = classifyAircraftCategory(typeCode);
  if (category === 'jet') {
    return [];
  }

  const pings: AdsbPing[] = [];
  for (const [dt, lat, lon, altFeet] of trace.trace) {
    const altMeters = altFeet * 0.3048;
    // Skip high-altitude cruise
    if (altMeters > 6096) {
      continue;
    }
    pings.push({
      epochSec: baseEpochSec + dt,
      lat,
      lon,
      altMeters,
    });
  }

  if (pings.length < 2) {
    return [];
  }

  return simplifyTrajectory4D(pings, {
    flightId: trace.r ?? trace.icao,
    icao24: trace.icao,
    typeCode,
    category,
    dateIso,
  });
}

/**
 * Loads and parses a DopplerDataset JSON file from disk.
 * @param filePath - Path to `.json` dataset file.
 * @returns Parsed `DopplerDataset`.
 */
export function loadDatasetFile(filePath: string): DopplerDataset {
  const raw = readFileSync(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  return DopplerDataset.parse(parsed);
}

/**
 * Serializes and saves a DopplerDataset to disk with built constellation index.
 * @param filePath - Output path.
 * @param segments - Array of linear flight segments.
 * @param demGrid - Optional DEM elevation grid points.
 * @returns The saved `DopplerDataset`.
 */
export function saveDatasetBundle(
  filePath: string,
  segments: readonly LinearFlightSegment[],
  demGrid: readonly GeoPoint3D[] = [],
): DopplerDataset {
  const constellations = buildConstellationIndex(segments, { demGrid });
  const dataset: DopplerDataset = {
    version: '1.0.0',
    generatedAtIso: new Date().toISOString(),
    segments,
    constellations,
    elevationGrid: demGrid,
  };

  writeFileSync(filePath, JSON.stringify(dataset, null, 2), 'utf8');

  return dataset;
}
