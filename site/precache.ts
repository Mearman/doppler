import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Precache } from './client/sw-protocol';

function fileOf(url: string): string {
  if (url === './') {
    return 'index.html';
  }

  return url.endsWith('/') ? `${url}index.html` : url;
}

/**
 * Builds the precache manifest the service worker embeds. The version is the package version plus a digest of every listed file's bytes, so it changes whenever any precached byte changes. The service worker script carries this version, which is what makes a content-only release change the script and so reach installed copies.
 * @param outDir - The built site directory, holding every file in `urls`.
 * @param packageVersion - The package version the build is for.
 * @param urls - Every URL to precache, relative to `outDir`; duplicates are removed.
 * @returns The manifest.
 */
export function computePrecache(outDir: string, packageVersion: string, urls: readonly string[]): Precache {
  const unique = [...new Set(urls)];
  const digest = createHash('sha256');
  for (const url of [...unique].sort()) {
    digest.update(url).update('\0').update(readFileSync(join(outDir, fileOf(url)))).update('\0');
  }

  return { version: `${packageVersion}+${digest.digest('hex')}`, urls: unique };
}
