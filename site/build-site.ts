import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_SPECS } from './icons';

/** The page shell the service worker stores up front. Bundle outputs, whose names the bundler picks, are added by the build. */
export const SHELL_URLS: readonly string[] = [
  './',
  'index.html',
  'app.js',
  'app.css',
  'icon.svg',
  'manifest.webmanifest',
  ...ICON_SPECS.map((spec) => spec.file),
];

/**
 * Writes the HTML shell and web manifest.
 * @param outDir - Directory the files are written to.
 * @returns The files written, relative to `outDir`.
 */
export function buildSite(outDir: string): Set<string> {
  const written = new Set<string>();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Doppler - Offline Aircraft Acoustic Geolocation</title>
  <meta name="description" content="Locate where an audio recording was made from the Doppler shifts of aircraft flyovers. Works offline.">
  <meta name="theme-color" content="#18181c">
  <link rel="icon" type="image/svg+xml" href="icon.svg">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">
  <link rel="stylesheet" href="app.css">
  <link rel="manifest" href="manifest.webmanifest">
</head>
<body>
  <div id="root"></div>
  <noscript>Doppler needs JavaScript to analyse audio and draw the map.</noscript>
  <script type="module" src="app.js"></script>
</body>
</html>`;

  writeFileSync(join(outDir, 'index.html'), html, 'utf8');
  written.add('index.html');

  const webmanifest = {
    name: 'Doppler Geolocation',
    short_name: 'Doppler',
    description: 'Offline and real-time aircraft Doppler audio geolocation',
    start_url: './',
    display: 'standalone',
    background_color: '#121214',
    theme_color: '#18181c',
    icons: [
      {
        src: 'icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
      ...ICON_SPECS.filter((spec) => spec.file !== 'apple-touch-icon.png').map((spec) => ({
        src: spec.file,
        sizes: `${String(spec.size)}x${String(spec.size)}`,
        type: 'image/png',
        purpose: spec.purpose,
      })),
    ],
  };

  writeFileSync(join(outDir, 'manifest.webmanifest'), JSON.stringify(webmanifest, null, 2), 'utf8');
  written.add('manifest.webmanifest');

  return written;
}
