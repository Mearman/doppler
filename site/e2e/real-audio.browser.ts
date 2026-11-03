import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Real recordings run through the whole PWA: file input, WAV decoding in the worker, spectrogram, ridge tracking and the flyover list.
 * The recordings are gitignored (see the README), so each test skips with its reason where its file is absent.
 */
const FIXTURES = join(import.meta.dirname, '../../fixtures');

/** How far a flyover's base frequency may sit from the expected value, in hertz: the width of a spectrogram bin at the analysis settings. */
const BASE_FREQ_TOLERANCE_HZ = 0.5;

/** How far a flyover's inferred speed may sit from the expected value, in metres per second. */
const SPEED_TOLERANCE_MPS = 1.5;

interface ExpectedFlyover {
  readonly baseFreqHz: number;
  readonly speedMps: number;
}

/**
 * Flyovers each recording is known to contain, measured with the analysis the worker runs and agreeing with the pinned values in `cli/colsto-challenge.integration.test.ts`.
 * Other, weaker flyovers may also be reported; each recording must contain at least these.
 */
const CLIPS: readonly { readonly file: string; readonly expected: readonly ExpectedFlyover[] }[] = [
  { file: 'colsto-flyover-23m.wav', expected: [{ baseFreqHz: 80.3, speedMps: 19.6 }] },
  { file: 'colsto-flyover-35m.wav', expected: [{ baseFreqHz: 139.3, speedMps: 29.6 }, { baseFreqHz: 117.2, speedMps: 27.3 }] },
  { file: 'colsto-flyover-36m.wav', expected: [{ baseFreqHz: 111.9, speedMps: 39.3 }] },
  { file: 'colsto-flyover-45m.wav', expected: [{ baseFreqHz: 101.7, speedMps: 18.6 }] },
  { file: 'colsto-flyover-51m.wav', expected: [{ baseFreqHz: 153.2, speedMps: 12.7 }] },
  { file: 'colsto-flyover-54m.wav', expected: [{ baseFreqHz: 79.3, speedMps: 22.4 }] },
];

test.describe('real recordings', () => {
  for (const { file, expected } of CLIPS) {
    test(`finds the known flyovers in ${file}`, async ({ page }) => {
      const path = join(FIXTURES, file);
      test.skip(!existsSync(path), `${file} is not in fixtures/`);
      test.setTimeout(120_000);

      await page.goto('/');
      await page.getByRole('tab', { name: /file/i }).click();
      await page.locator('input[type="file"]').setInputFiles(path);

      const list = page.getByRole('list', { name: 'Detected flyovers' });
      await expect(list).toBeVisible({ timeout: 90_000 });
      const found = await list.getByRole('listitem').evaluateAll((items) =>
        items.map((item) => {
          const [, freq, speed] = [...item.querySelectorAll('span')].map((span) => Number.parseFloat(span.textContent));

          return { baseFreqHz: freq, speedMps: speed };
        }),
      );

      expect(found.length).toBeGreaterThanOrEqual(expected.length);
      for (const flyover of expected) {
        const match = found.find(
          (candidate) => Math.abs((candidate.baseFreqHz ?? Number.NaN) - flyover.baseFreqHz) <= BASE_FREQ_TOLERANCE_HZ && Math.abs((candidate.speedMps ?? Number.NaN) - flyover.speedMps) <= SPEED_TOLERANCE_MPS,
        );
        expect(match, `no flyover near ${String(flyover.baseFreqHz)} Hz at ${String(flyover.speedMps)} m/s among ${JSON.stringify(found)}`).toBeDefined();
      }

      // The spectrogram describes the same clip and the same number of flyovers as the list.
      await expect(page.getByRole('img', { name: new RegExp(`with ${String(found.length)} flyovers? detected`) })).toBeAttached();
    });
  }
});
