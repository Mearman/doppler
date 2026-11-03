import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildIdentity } from '@exadev/build-identity';
import { vanillaExtractPlugin } from '@vanilla-extract/esbuild-plugin';
import { build, type BuildOptions } from 'esbuild';
import { buildSite, SHELL_URLS } from './build-site';
import { writeIcons } from './icons';
import { computePrecache } from './precache';

/** The GitHub repository the release and commit links point at. */
const REPOSITORY_SLUG = 'Mearman/doppler';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outDir = join(repoRoot, 'site-dist');

const packageJson: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
if (typeof packageJson !== 'object' || packageJson === null || !('version' in packageJson) || typeof packageJson.version !== 'string') {
  throw new Error('package.json has no string version');
}

// The identity is read from git state at build time: a release only when its tag provably points at this commit, otherwise the commit itself, so the link never names a release that does not exist yet.
const buildIdentity = resolveBuildIdentity(repoRoot, REPOSITORY_SLUG);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const files = buildSite(outDir);
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
  define: { BUILD_IDENTITY: JSON.stringify(buildIdentity) },
});

// The audio worklet module is a build of its own, without code splitting, so that it is one self-contained file: the page loads it through audioWorklet.addModule, outside the app's chunk graph.
const workletBuild = await build({
  ...common,
  metafile: true,
  entryPoints: {
    'mic-capture.worklet': join(repoRoot, 'src/browser/mic-capture.worklet.ts'),
  },
});

// The app and worklet builds hold every file the page loads at runtime (entry, workers, shared chunks, stylesheet). The service worker is excluded: the browser fetches it outside the cache, and listing it here would pin an old copy.
const bundleUrls = [...Object.keys(appBuild.metafile.outputs), ...Object.keys(workletBuild.metafile.outputs)].map((output) => relative(outDir, join(repoRoot, output)));
const precache = computePrecache(outDir, packageJson.version, [...SHELL_URLS, ...bundleUrls]);

// The service worker is built last because it embeds the precache version: its bytes must change whenever any precached byte does, or browsers never see a new worker for a content-only release and installed copies keep their old files.
await build({
  ...common,
  entryPoints: {
    sw: join(here, 'client/sw.ts'),
  },
  define: { PRECACHE: JSON.stringify(precache) },
});
console.log(`Wrote ${String(files.size)} generated files and bundles to site-dist/`);
