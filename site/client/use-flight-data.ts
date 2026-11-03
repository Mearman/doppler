import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { clearDataset, saveDataset } from '../../src/browser/dataset-store';
import { emptyDataset } from '../../src/dataset';
import { DopplerDatasetSchema } from '../../src/schemas';
import { type FlightDataFile, MAX_JSON_CHARS, downloadFlightDataFile, fitsInBrowser, listFlightDataFiles } from './flight-data-sources';
import type { Solver } from './use-solver';

/** The flight data sources the page offers and what it is doing with them. */
export interface FlightData {
  /** The sentence describing the transfer in progress, or null when idle. */
  readonly working: string | null;
  /** Dataset files in the Hugging Face repository, or null until listed. */
  readonly catalogue: readonly FlightDataFile[] | null;
  readonly fromFile: (file: Readonly<File>) => Promise<void>;
  readonly fromCatalogue: (file: Readonly<FlightDataFile>) => Promise<void>;
  readonly clear: () => Promise<void>;
}

/**
 * Loads flight data from a local file or the Hugging Face repository, validates it, hands it to the worker and keeps it for the next visit.
 * @param solver - The solver, which receives the dataset and reports failures.
 * @returns The sources and their state.
 */
export function useFlightData(solver: Readonly<Pick<Solver, 'setDataset' | 'reportError'>>): FlightData {
  const [working, setWorking] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<readonly FlightDataFile[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { setDataset, reportError } = solver;

  useEffect(() => {
    const controller = new AbortController();
    listFlightDataFiles(controller.signal)
      .then(setCatalogue)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          reportError(`The list of published flight data could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

    return () => {
      controller.abort();
    };
  }, [reportError]);

  const adopt = useCallback(
    async (text: string, source: string): Promise<void> => {
      const parsed = DopplerDatasetSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new Error(`${source} is not flight data this app can read: ${z.prettifyError(parsed.error)}`);
      }
      setDataset(parsed.data);
      await saveDataset(parsed.data);
    },
    [setDataset],
  );

  const run = useCallback(
    async (label: string, action: () => Promise<void>): Promise<void> => {
      setWorking(label);
      try {
        await action();
      } catch (err) {
        reportError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setWorking(null);
      }
    },
    [reportError],
  );

  const fromFile = useCallback(
    async (file: Readonly<File>): Promise<void> => {
      await run(`Loading ${file.name}`, async () => {
        if (!fitsInBrowser(file.size)) {
          throw new Error(`${file.name} is larger than the ${String(MAX_JSON_CHARS)} characters a browser can parse in one piece`);
        }
        await adopt(await file.text(), file.name);
      });
    },
    [adopt, run],
  );

  const fromCatalogue = useCallback(
    async (file: Readonly<FlightDataFile>): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      await run(`Downloading ${file.path}`, async () => {
        await adopt(await downloadFlightDataFile(file.path, controller.signal), file.path);
      });
    },
    [adopt, run],
  );

  const clear = useCallback(async (): Promise<void> => {
    await run('Removing flight data', async () => {
      setDataset(emptyDataset());
      await clearDataset();
    });
  }, [run, setDataset]);

  return { working, catalogue, fromFile, fromCatalogue, clear };
}
