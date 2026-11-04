import { expect, test } from '@playwright/test';
import { analyseSyntheticClip, loadSyntheticFlightData } from './support';

/** Where the mocked device is, in degrees. */
const DEVICE = { latitude: 51.5, longitude: -0.12 };

/** Tolerance, in degrees, between a centre read from the map and the position it was set to: a pixel at the closest zoom is far smaller. */
const CENTRE_TOLERANCE_DEG = 0.05;

test.describe('map view', () => {
  test('asks for no location on load and opens on the world on a first visit', async ({ page, context }) => {
    let asked = false;
    await context.exposeBinding('reportGeolocation', () => {
      asked = true;
    });
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = () => {
        (window as unknown as { reportGeolocation: () => void }).reportGeolocation();
      };
    });
    await page.goto('/');
    await expect(page.locator('.leaflet-container')).toBeVisible();

    expect(asked).toBe(false);
    await expect(page.getByRole('button', { name: 'Use my location' })).toBeVisible();
  });

  test('centres on the device when asked and reopens on that view after a reload', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation(DEVICE);
    await page.goto('/');
    await page.getByRole('button', { name: 'Use my location' }).click();

    await expect
      .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('doppler_map_view_v1') ?? 'null') as { lat: number; lon: number; zoom: number } | null))
      .toMatchObject({ zoom: 11 });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('doppler_map_view_v1') ?? 'null') as { lat: number; lon: number });
    expect(Math.abs(saved.lat - DEVICE.latitude)).toBeLessThan(CENTRE_TOLERANCE_DEG);
    expect(Math.abs(saved.lon - DEVICE.longitude)).toBeLessThan(CENTRE_TOLERANCE_DEG);

    await page.reload();

    await page.getByRole('button', { name: 'Start live feed' }).click();
    // Reopened on the device's view, the visible area is small enough for the relay to cover.
    await expect(page.getByText('The map shows more than the feed covers')).toHaveCount(0);
  });

  test('says why when the location cannot be found', async ({ page, context }) => {
    await context.clearPermissions();
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_ok, fail) => {
        fail?.({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Use my location' }).click();

    await expect(page.getByRole('alert')).toContainText('User denied Geolocation');
  });

  test('ignores a kept view that is not valid', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('doppler_map_view_v1', JSON.stringify({ lat: 500, lon: 0, zoom: 3 }));
    });
    await page.goto('/');

    await expect(page.locator('.leaflet-container')).toBeVisible();
  });

  test.describe('on a high-density screen', () => {
    test.use({ deviceScaleFactor: 2 });

    /** Stated ellipse size, in metres, written into the saved session so that it is large enough to measure: the real estimate is a few metres. */
    const STATED = { semiMajorM: 3000, semiMinorM: 1500 };

    /** Tolerance on the drawn size against the stated metres: Leaflet's integer pixel rounding at this zoom is under one percent of the extent. */
    const SIZE_TOLERANCE = 0.05;

    test('draws the confidence ellipse at its stated size in metres, not stretched by latitude', async ({ page }) => {
      await page.goto('/');
      await loadSyntheticFlightData(page);
      await analyseSyntheticClip(page);
// The saved session is edited to a measurable ellipse oriented north-south (bearing 0), then the page reopens on it.
      await page.evaluate((stated) => {
        const sessions = JSON.parse(localStorage.getItem('doppler_sessions_v1') ?? '[]') as { hypotheses: { lat: number; ellipseSemiMajorMeters: number; ellipseSemiMinorMeters: number; ellipseBearingDeg: number }[] }[];
        const top = sessions[0]?.hypotheses[0];
        if (top !== undefined) {
          top.ellipseSemiMajorMeters = stated.semiMajorM;
          top.ellipseSemiMinorMeters = stated.semiMinorM;
          top.ellipseBearingDeg = 0;
        }
        localStorage.setItem('doppler_sessions_v1', JSON.stringify(sessions));
      }, STATED);
      await page.reload();
await expect(page.locator('path.leaflet-interactive').first()).toBeAttached({ timeout: 15000 });

      const measured = await page.evaluate(() => {
        const mapElement = document.querySelector('.leaflet-container');
        const path = [...document.querySelectorAll('path.leaflet-interactive')].find((element) => element.getAttribute('stroke-dasharray') !== null) ?? document.querySelector('path.leaflet-interactive');
        if (mapElement === null || !path) {
          return null;
        }
        const box = path.getBoundingClientRect();
        const sessions = JSON.parse(localStorage.getItem('doppler_sessions_v1') ?? '[]') as { hypotheses: { lat: number }[] }[];

        return { widthPx: box.width, heightPx: box.height, lat: sessions[0]?.hypotheses[0]?.lat ?? 0, zoom: 13 };
      });
      expect(measured).not.toBeNull();
      if (measured === null) {
        return;
      }
      // Web Mercator metres per CSS pixel at this latitude and zoom; the device pixel ratio does not enter it.
      const metresPerPx = (156543.03392 * Math.cos((measured.lat * Math.PI) / 180)) / 2 ** measured.zoom;
      expect(measured.heightPx * metresPerPx).toBeGreaterThan(2 * STATED.semiMajorM * (1 - SIZE_TOLERANCE));
      expect(measured.heightPx * metresPerPx).toBeLessThan(2 * STATED.semiMajorM * (1 + SIZE_TOLERANCE));
      expect(measured.widthPx * metresPerPx).toBeGreaterThan(2 * STATED.semiMinorM * (1 - SIZE_TOLERANCE));
      expect(measured.widthPx * metresPerPx).toBeLessThan(2 * STATED.semiMinorM * (1 + SIZE_TOLERANCE));
    });
  });
});
