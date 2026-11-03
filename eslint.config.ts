import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import exadev from '@exadev/eslint-config';

export default defineConfig(
  { ignores: ['dist', 'dist-cli', 'site-dist', 'coverage', 'node_modules', 'reports', 'test-results', 'playwright-report'] },
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.node.json', './tsconfig.site.json', './tsconfig.sw.json', './tsconfig.e2e.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  { ...js.configs.recommended, files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'] },
  ...exadev,
  {
    // The one reasoned exception to the Object.assign ban, made as a files-scoped override rather than an inline disable: src/define.ts is the schema-attached guard helper, which augments a Zod schema object in place because object spread would drop the prototype's parse/refine methods.
    files: ['src/define.ts'],
    rules: { 'exadev/no-object-assign': 'off' },
  },
  {
    // The package entry points (doppler/node, doppler/browser) are the barrels of their platform surfaces.
    files: ['src/node/entry.ts', 'src/browser/entry.ts'],
    rules: { 'exadev/barrel-policy': 'off' },
  },
  {
    // Schema definitions export matching value-type pairs and validation boundaries (min/max geodetic ranges).
    files: ['src/schemas.ts', 'src/node/stream-adsb.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-redeclare': 'off',
    },
  },
  {
    // High-performance in-place in-situ FFT algorithm transforms preallocated real/imag float arrays.
    files: ['src/dsp/fft.ts'],
    rules: {
      'no-param-reassign': 'off',
    },
  },
  {
    // Web Audio mic capture uses ScriptProcessorNode for synchronous sample chunking across environments.
    files: ['src/browser/mic-monitor.ts'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off',
    },
  },
  {
    // Numerical DSP algorithms, physical models, site UI and test suites use mathematical equations, sample rates, coordinates, and physical constants.
    files: ['src/physics/**', 'src/dsp/**', 'src/solver/**', 'src/node/**', 'src/browser/**', 'src/bundled.ts', '**/*.test.ts', 'site/**', 'cli/**'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },
  {
    // A tar stream is consumed strictly in order: each header's size says where the next begins, so reads cannot be issued concurrently.
    files: ['src/node/tar-stream.ts', 'src/node/adsb-archive.ts'],
    rules: { 'no-await-in-loop': 'off' },
  },
  {
    // Test assertions and fixtures frequently check known array elements and mock data.
    files: ['**/*.test.ts', 'site/e2e/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Browser DOM and Web Worker event targets require message boundary type assertions.
    files: ['site/**', 'src/browser/**'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },
);
