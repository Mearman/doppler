import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vanillaExtractPlugin } from '@vanilla-extract/esbuild-plugin';
import { build, type BuildOptions } from 'esbuild';
import { buildSite } from './build-site';
import { writeIcons } from './icons';
import { finalisePrecache } from './precache';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outDir = join(repoRoot, 'site-dist');

const packageJson: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
if (typeof packageJson !== 'object' || packageJson === null || !('version' in packageJson) || typeof packageJson.version !== 'string') {
  throw new Error('package.json has no string version');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const files = buildSite({ outDir, packageVersion: packageJson.version });
copyFileSync(join(here, 'static', 'icon.svg'), join(outDir, 'icon.svg'));
writeIcons(outDir, readFileSync(join(here, 'static', 'icon.svg'), 'utf8'));

const common: BuildOptions = {
  absWorkingDir: repoRoot,
  outdir: outDir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  minify: true,
  outExtension: { '.js': '.js' },
  plugins: [vanillaExtractPlugin()],
  loader: { '.svg': 'dataurl', '.png': 'dataurl' },
};

const appBuild = await build({
  ...common,
  metafile: true,
  entryPoints: {
    app: join(here, 'client/app.tsx'),
    'solver-worker': join(here, 'client/solver-worker.ts'),
  },
  splitting: true,
});

await build({
  ...common,
  entryPoints: {
    sw: join(here, 'client/sw.ts'),
  },
});

// The app build holds every file the page loads at runtime (entry, worker, shared chunks, stylesheet). The service worker is excluded: the browser fetches it outside the cache, and listing it here would pin an old copy.
const bundleUrls = Object.keys(appBuild.metafile.outputs).map((output) => relative(outDir, join(repoRoot, output)));
finalisePrecache(outDir, bundleUrls);
console.log(`Wrote ${String(files.size)} generated files and bundles to site-dist/`);
