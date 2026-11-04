import { type Page, expect } from '@playwright/test';
import { encodeWavPcm16 } from '../../src/dsp/wav';
import { SYNTHETIC_DATASET, generateSyntheticReferenceAudio } from '../../src/test-support/synthetic-reference';

/** Sample rate of the synthetic recording the tests upload, in hertz. */
const SAMPLE_RATE_HZ = 2000;

/** The synthetic flyover recording as a WAV file, built here so no test needs a fixture file, which are gitignored and absent in CI. */
export const SYNTHETIC_WAV = {
  name: 'synthetic-flyovers.wav',
  mimeType: 'audio/wav',
  buffer: Buffer.from(encodeWavPcm16(generateSyntheticReferenceAudio(SAMPLE_RATE_HZ), SAMPLE_RATE_HZ)),
};

/** The synthetic flight dataset as a JSON file. */
export const SYNTHETIC_DATA_FILE = { name: 'flights.dataset.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SYNTHETIC_DATASET)) };

/**
 * Loads the synthetic flight dataset through the Data section's file chooser and waits for the app to report it.
 * @param page - The page under test.
 */
export async function loadSyntheticFlightData(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: /data/i });
  if (await tab.count() > 0) {
    await tab.click();
  }
  await page.getByLabel('Flight data file').setInputFiles(SYNTHETIC_DATA_FILE);
  await expect(page.getByText(/Flight Trajectory Data|Flight segments/i)).toBeVisible({ timeout: 10000 });
}

/**
 * Analyses the synthetic recording through the File section and waits for the estimate.
 * @param page - The page under test.
 */
export async function analyseSyntheticClip(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: /file/i });
  if (await tab.count() > 0) {
    await tab.click();
  }
  await page.getByLabel('Audio or video file to analyse').setInputFiles(SYNTHETIC_WAV);
  await expect(page.getByText('Open in OpenStreetMap')).toBeVisible({ timeout: 30000 });
}
