import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildSiteOptions {
  readonly outDir: string;
  readonly packageVersion: string;
}

export function buildSite(options: Readonly<BuildSiteOptions>): Set<string> {
  const { outDir, packageVersion } = options;
  const written = new Set<string>();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Doppler - Offline Aircraft Acoustic Geolocation</title>
  <link rel="icon" type="image/svg+xml" href="icon.svg">
  <link rel="stylesheet" href="app.css">
  <link rel="manifest" href="manifest.webmanifest">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="app.js"></script>
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js');
      });
    }
  </script>
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
    ],
  };

  writeFileSync(join(outDir, 'manifest.webmanifest'), JSON.stringify(webmanifest, null, 2), 'utf8');
  written.add('manifest.webmanifest');

  const precache = {
    version: packageVersion,
    urls: ['./', 'index.html', 'app.js', 'app.css', 'icon.svg', 'manifest.webmanifest'],
  };

  writeFileSync(join(outDir, 'precache.json'), JSON.stringify(precache, null, 2), 'utf8');
  written.add('precache.json');

  return written;
}
