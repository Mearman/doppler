import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/node/entry.ts', 'src/browser/entry.ts'],
    root: 'src',
    format: ['esm'],
    dts: true,
    platform: 'neutral',
    deps: { neverBundle: [/^node:/] },
    clean: true,
  },
  {
    entry: ['cli/doppler.ts'],
    format: ['esm'],
    dts: false,
    platform: 'node',
    outDir: 'dist-cli',
    deps: { neverBundle: ['doppler', 'doppler/node'] },
    clean: true,
  },
]);
