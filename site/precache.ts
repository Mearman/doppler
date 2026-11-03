import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Precache {
  readonly version: string;
  readonly urls: readonly string[];
}

function isPrecache(value: unknown): value is Precache {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string' &&
    'urls' in value &&
    Array.isArray(value.urls) &&
    value.urls.every((url) => typeof url === 'string')
  );
}

function fileOf(url: string): string {
  if (url === './') {
    return 'index.html';
  }

  return url.endsWith('/') ? `${url}index.html` : url;
}

/**
 * Adds the bundle outputs to the manifest's URL list and appends a digest of every precached file's bytes to its version, in place.
 * @param outDir - The built site directory, holding precache.json and every file it names.
 * @param bundleUrls - Bundle outputs relative to `outDir` (the worker, its shared chunks and the stylesheet), which the shell list cannot name because the bundler picks their file names.
 * @returns The version written.
 */
export function finalisePrecache(outDir: string, bundleUrls: readonly string[]): string {
  const manifestPath = join(outDir, 'precache.json');
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isPrecache(parsed)) {
    throw new Error('precache.json is not a precache manifest');
  }
  const urls = [...new Set([...parsed.urls, ...bundleUrls])];
  const digest = createHash('sha256');
  for (const url of [...urls].sort()) {
    digest.update(url).update('\0').update(readFileSync(join(outDir, fileOf(url)))).update('\0');
  }
  const version = `${parsed.version}+${digest.digest('hex')}`;
  writeFileSync(manifestPath, JSON.stringify({ version, urls }));

  return version;
}
