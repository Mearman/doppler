import { type Page, expect, test } from '@playwright/test';
import { MAX_RADIUS_NM } from '../../src/live-limits';
import { SYNTHETIC_DATA_FILE, SYNTHETIC_WAV, analyseSyntheticClip, loadSyntheticFlightData } from './support';

/** Seconds between live feed polls, as the page schedules them. */
const POLL_SEC = 10;

/** Epoch seconds the mocked feed starts counting from. */
const FEED_START_EPOCH_SEC = 1788861600;

/** Polls needed for a track to form a flight segment: a segment needs two reports far enough apart in time, and the first poll gives one. */
const MIN_POLLS = 4;

test.describe('flight data', () => {
  test('has no built-in demonstration data and says so before any flight data is loaded', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: /simulate/i })).toHaveCount(0);
    await expect(page.getByText('No flight data', { exact: true })).toBeVisible();

    await page.getByLabel('Audio or video file to analyse').setInputFiles(SYNTHETIC_WAV);
    await expect(page.getByRole('list', { name: 'Detected flyovers' })).toBeVisible({ timeout: 30000 });
    // Flyovers are found, but with no flights to match them against there is no location.
    await expect(page.getByText('No estimate yet')).toBeVisible();
  });

  test('locates the listener once flight data is loaded and drops back to none when it is removed', async ({ page }) => {
    await page.goto('/');
    await loadSyntheticFlightData(page);
    await analyseSyntheticClip(page);

    await page.getByRole('button', { name: /Remove flight data|Clear/i }).click();
    await expect(page.getByText('None loaded.')).toBeVisible({ timeout: 10000 });
  });

  test('rejects a file that is not flight data and keeps what was loaded', async ({ page }) => {
    await page.goto('/');
    await loadSyntheticFlightData(page);
    await page.getByLabel('Flight data file').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"version":"1"}') });

    await expect(page.getByRole('alert')).toContainText('not flight data this app can read');
    await expect(page.getByText('Flight segments')).toBeVisible();
  });

  test('offers published data and refuses one too large to read in a browser', async ({ page }) => {
    await page.route('https://huggingface.co/api/datasets/**', async (route) =>
      route.fulfill({
        json: [
          { type: 'file', path: '2025-12-29.dataset.json', size: 3_000_000 },
          { type: 'file', path: '2025-12-30.dataset.json', size: 1_849_124_275 },
        ],
        headers: { 'access-control-allow-origin': '*' },
      }),
    );
    await page.goto('/');
    const list = page.getByRole('list', { name: 'Published flight data' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByRole('listitem').first()).toContainText('too large for a browser');
    await expect(list.getByRole('button', { name: 'Load' }).first()).toBeDisabled();
    await expect(list.getByRole('button', { name: 'Load' }).last()).toBeEnabled();
  });

  test.describe('live feed', () => {
    /** Answers each poll with one light aircraft a little further east, so that the tracks form a segment after a few polls. Returns the requested URLs. */
    async function mockRelay(page: Page): Promise<string[]> {
      const requested: string[] = [];
      await page.route('https://doppler-adsb-relay.joseph-b4f.workers.dev/**', async (route) => {
        requested.push(route.request().url());
        const step = requested.length;
        await route.fulfill({
          json: { now: (FEED_START_EPOCH_SEC + step * POLL_SEC) * 1000, ac: [{ hex: 'abc123', r: 'G-TEST', t: 'C172', lat: 51.75, lon: -1.3 + step * 0.002, alt_baro: 1000, seen_pos: 0 }] },
          headers: { 'access-control-allow-origin': '*' },
        });
      });

      return requested;
    }

    test('needs no key: polls the relay, builds tracks and puts the stored flight data back when stopped', async ({ page }) => {
      const requested = await mockRelay(page);
      await page.clock.install();
      await page.goto('/');
      await expect(page.getByLabel(/key/i)).toHaveCount(0);
      await page.getByRole('button', { name: /Start live feed|Start Live ADS-B Feed/i }).click();

      // The clock moves one poll at a time and each answer needs real time to arrive, so the test advances it until enough polls have been answered.
      await expect
        .poll(async () => {
          await page.clock.runFor(POLL_SEC * 1000);

          return requested.length;
        })
        .toBeGreaterThanOrEqual(MIN_POLLS);

      await expect(page.getByText(/Tracking 1 aircraft/)).toBeVisible();
      await expect(page.getByText(/[1-9]\d* flight segments/)).toBeVisible();
      expect(requested[0]).toMatch(/^https:\/\/doppler-adsb-relay\.joseph-b4f\.workers\.dev\/v2\/point\/-?[\d.]+\/-?[\d.]+\/\d+$/);

      await page.getByRole('button', { name: /Stop live feed|Stop Live Feed/i }).click();
      await expect(page.getByText('None loaded.')).toBeVisible({ timeout: 10000 });
    });

    test('asks for no more than the relay forwards when the map is zoomed far out', async ({ page }) => {
      const requested = await mockRelay(page);
      await page.goto('/');
      await page.getByRole('button', { name: /Start live feed|Start Live ADS-B Feed/i }).click();

      await expect.poll(() => requested.length).toBeGreaterThanOrEqual(1);
      const radiusNm = Number(requested[0]?.split('/').pop());
      expect(radiusNm).toBeGreaterThan(0);
      expect(radiusNm).toBeLessThanOrEqual(MAX_RADIUS_NM);
    });

    test('says so when the map shows more than the feed covers', async ({ page }) => {
      await mockRelay(page);
      await page.goto('/');
      await page.getByRole('button', { name: /Start live feed|Start Live ADS-B Feed/i }).click();

      await expect(page.getByText('The map shows more than the feed covers')).toBeVisible();
    });

    test('stops and says why when the relay refuses the query', async ({ page }) => {
      await page.route('https://doppler-adsb-relay.joseph-b4f.workers.dev/**', async (route) => route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } }));
      await page.goto('/');
      await page.getByRole('button', { name: 'Start live feed' }).click();

      await expect(page.getByRole('alert')).toContainText('does not serve this query');
      await expect(page.getByRole('button', { name: 'Start live feed' })).toBeVisible({ timeout: 10000 });
    });
  });

  test('loads a dataset file given as the data file fixture', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Flight data file').setInputFiles(SYNTHETIC_DATA_FILE);

    await expect(page.getByText('Flight segments')).toBeVisible({ timeout: 10000 });
  });

  test('offers historical flight queries from adsb-core parquet without requiring tabs', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Historical Flights (adsb-core)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fetch Area' })).toBeVisible();
  });
});
