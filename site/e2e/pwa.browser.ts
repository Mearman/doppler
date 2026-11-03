import { expect, test } from '@playwright/test';

test.describe('Doppler PWA Offline Geolocation', () => {
  test('renders header, tabs, and Leaflet map', async ({ page }) => {
    page.on('console', (msg) => { console.log('PAGE LOG:', msg.text()); });
    page.on('pageerror', (err) => { console.error('PAGE ERROR:', err.message); });

    await page.goto('/');

    await expect(page.locator('text=Doppler')).toBeVisible();
    await expect(page.locator('text=Aircraft Acoustic Geolocation')).toBeVisible();
    await expect(page.locator('text=100% Offline')).toBeVisible();

    // Map container exists
    const map = page.locator('.leaflet-container');
    await expect(map).toBeVisible();

    // Live Monitor tab has simulation button
    const simButton = page.locator('button:has-text("Simulate Flyover Stream")');
    await expect(simButton).toBeVisible();

    // Click simulate flyover stream
    await simButton.click();

    // Expect status message or hypothesis card to appear
    await expect(page.locator('text=Estimated Location')).toBeVisible({ timeout: 30000 });
  });

  test('requests microphone permission when Start Mic is clicked', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await page.goto('/');

    const micButton = page.locator('button:has-text("Start Mic")');
    await expect(micButton).toBeVisible();
    await micButton.click();

    // Button transitions to "Stop Mic"
    await expect(page.locator('button:has-text("Stop Mic")')).toBeVisible({ timeout: 10000 });

    // Stop mic
    await page.locator('button:has-text("Stop Mic")').click();
    await expect(page.locator('button:has-text("Start Mic")')).toBeVisible({ timeout: 10000 });
  });
});
