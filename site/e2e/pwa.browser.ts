import { expect, test } from '@playwright/test';
import { SYNTHETIC_WAV, analyseSyntheticClip, loadSyntheticFlightData } from './support';

interface Box {
  readonly width: number;
  readonly height: number;
  readonly top: number;
}

test.describe('Doppler PWA Offline Geolocation', () => {
  test('renders header, tabs, and Leaflet map', async ({ page }) => {
    page.on('console', (msg) => { console.log('PAGE LOG:', msg.text()); });
    page.on('pageerror', (err) => { console.error('PAGE ERROR:', err.message); });

    await page.goto('/');

    await expect(page.locator('text=Doppler')).toBeVisible();
    await expect(page.locator('text=Aircraft Acoustic Geolocation')).toBeVisible();
    await expect(page.getByText('Offline ready', { exact: true })).toBeVisible({ timeout: 10000 });

    // Map container and Spectrogram canvas exist
    const map = page.locator('.leaflet-container');
    await expect(map).toBeVisible();
    await expect(page.getByRole('region', { name: 'Spectrogram' })).toBeVisible();
    await expect(page.locator('canvas')).toBeVisible();

    // Flight data and a recording give a located result.
    await loadSyntheticFlightData(page);
    await analyseSyntheticClip(page);
    await expect(page.getByText('Clip analysis', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/flyovers? detected/)).toBeVisible({ timeout: 10000 });
  });

  test('requests microphone permission when Start Mic is clicked and activates live spectrogram waterfall', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await page.goto('/');

    const micButton = page.locator('button:has-text("Start Mic")');
    await expect(micButton).toBeVisible();
    await expect(page.getByText('-82.0 dB', { exact: true })).toBeVisible();
    await micButton.click();

    // Button transitions to "Stop Mic" and live spectrogram badge is displayed
    await expect(page.locator('button:has-text("Stop Mic")')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Live microphone', { exact: true })).toBeVisible({ timeout: 10000 });

    // The audio worklet delivers chunks: the noise floor readout leaves its initial value once enough audio has been analysed.
    await expect(page.getByText('-82.0 dB', { exact: true })).toBeHidden({ timeout: 10000 });

    // Stop mic
    await page.locator('button:has-text("Stop Mic")').click();
    await expect(page.locator('button:has-text("Start Mic")')).toBeVisible({ timeout: 10000 });
  });

  test('analyses an uploaded WAV file in the File Analyzer', async ({ page }) => {
    await page.goto('/');

    // Switch to File Analyzer tab
    await page.getByLabel('Audio or video file to analyse').setInputFiles(SYNTHETIC_WAV);

    // The analysis ends on the result, and the spectrogram switches to the clip with its flyovers marked.
    await expect(page.getByRole('list', { name: 'Detected flyovers' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Clip analysis', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/flyovers? detected/)).toBeVisible({ timeout: 15000 });
  });

  test('reloads with the network off, keeps the loaded flight data and analyses audio', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByText('Offline ready', { exact: true })).toBeVisible({ timeout: 10000 });
    await loadSyntheticFlightData(page);
    // No intermediate reload: the worker and its chunks must come from the precache, not from runtime caching of an earlier controlled load.
    await context.setOffline(true);
    await page.reload();

    await expect(page.getByText('Offline: stored map tiles only', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Flight Trajectory Data|Flight segments/i)).toBeVisible({ timeout: 10000 });
    await analyseSyntheticClip(page);
  });

  test('reports a file the browser cannot decode as an alert and lets the same file be chosen again', async ({ page }) => {
    await page.goto('/');
    const fileInput = page.getByLabel('Audio or video file to analyse');
    const notAudio = { name: 'notes.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('this is not audio') };

    await fileInput.setInputFiles(notAudio);
    await expect(page.getByRole('alert')).toContainText('notes.mp3 could not be read as audio');

    await page.locator('.mantine-Alert-closeButton').click();
    await expect(page.getByRole('alert')).toBeHidden();
    await fileInput.setInputFiles(notAudio);
    await expect(page.getByRole('alert')).toContainText('notes.mp3 could not be read as audio');
  });

  test('embeds the precache version in the service worker script so content-only releases reach installed copies', async ({ request }) => {
    const script = await (await request.get('/sw.js')).text();

    expect(script).toMatch(/version:"\d+\.\d+\.\d+\+[0-9a-f]{64}"/);
  });

  test('resumes the saved session after a reload', async ({ page }) => {
    await page.goto('/');
    await loadSyntheticFlightData(page);
    await analyseSyntheticClip(page);

    await page.reload();

    await expect(page.getByText(/Estimated location|Location Result/i)).toBeVisible({ timeout: 10000 });
  });

  test('links the session panel to the release or commit this build came from', async ({ page }) => {
    await page.goto('/');
    const link = page.locator('a[title*="release" i], a[href*="releases"], a[href*="commit"]').first();

    // A build whose tag is on its commit links to the release; any other build links to its commit, never to a release that does not exist.
    await expect(link).toHaveAttribute('href', /^https:\/\/github\.com\/Mearman\/doppler\/(releases\/tag\/v\d+\.\d+\.\d+|commit\/[0-9a-f]{40})$/);
    await expect(link).toHaveText(/^(v\d+\.\d+\.\d+|[0-9a-f]{7,})$/);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test.describe('on a phone', () => {
    const PHONE = { width: 390, height: 844 };
    /** The smallest touch target WCAG 2.5.5 allows, in pixels. */
    const TOUCH_TARGET_PX = 44;
    /** The least width and height, in pixels, at which the map and the spectrogram are still usable. */
    const MIN_VISUALIZER_PX = 160;
    /** The tallest the top bar may be and still be a single row, in pixels. */
    const MAX_BAR_PX = 64;
    test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

    test('shows one of the map and spectrogram at a time, each filling the stage, with no sideways scroll', async ({ page }) => {
      await page.goto('/');
      await loadSyntheticFlightData(page);
      await analyseSyntheticClip(page);

      const measure = async (): Promise<{ scrollWidth: number; clientWidth: number; map: Box; canvas: Box; bar: Box }> =>
        page.evaluate(() => {
          const box = (selector: string): { width: number; height: number; top: number } => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();

            return { width: rect?.width ?? 0, height: rect?.height ?? 0, top: rect?.top ?? 0 };
          };

          return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, map: box('.leaflet-container'), canvas: box('canvas'), bar: box('header') };
        });

      const onMap = await measure();
      expect(onMap.scrollWidth).toBeLessThanOrEqual(onMap.clientWidth);
      expect(onMap.map.width).toBeGreaterThanOrEqual(PHONE.width - 1);
      expect(onMap.map.height).toBeGreaterThanOrEqual(MIN_VISUALIZER_PX);
      expect(onMap.map.top + onMap.map.height).toBeLessThanOrEqual(PHONE.height);
      // The top bar is one row.
      expect(onMap.bar.height).toBeLessThanOrEqual(MAX_BAR_PX);

      await page.getByRole('button', { name: 'Spectrogram', exact: true }).click();
      const onSpectrogram = await measure();
      expect(onSpectrogram.scrollWidth).toBeLessThanOrEqual(onSpectrogram.clientWidth);
      expect(onSpectrogram.canvas.width).toBeGreaterThanOrEqual(PHONE.width - 1);
      expect(onSpectrogram.canvas.height).toBeGreaterThanOrEqual(MIN_VISUALIZER_PX / 2);
    });

    test('keeps the empty spectrogram message inside the screen', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Spectrogram', exact: true }).click();
      const message = await page.getByText('No audio yet.').boundingBox();

      expect(message).not.toBeNull();
      expect(message?.x).toBeGreaterThanOrEqual(0);
      expect((message?.x ?? 0) + (message?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    });

    test('gives every control a touch target of at least 44 pixels', async ({ page }) => {
      await page.goto('/');
      await page.waitForSelector('header');
      const undersized = await page.evaluate((minimum) => {
        const attribution = '.leaflet-control-attribution a';

        return [...document.querySelectorAll('button, [role=tab], input')]
          .filter((element) => !element.matches(attribution))
          .map((element) => ({ name: element.textContent.trim().slice(0, 24), height: element.getBoundingClientRect().height }))
          .filter((target) => target.height > 0 && target.height < minimum);
      }, TOUCH_TARGET_PX);

      expect(undersized).toEqual([]);
    });
  });
});

