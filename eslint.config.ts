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
    // Subpath exports @mearman/doppler/node and @mearman/doppler/browser export their public surface.
    rules: {
      'exadev/barrel-policy': ['error', { mode: 'single', entries: ['src/node/entry.ts', 'src/browser/entry.ts'] }],
    },
  },
  {
    // A tar stream is consumed strictly in order: each header's size says where the next begins, so reads cannot be issued concurrently.
    files: ['src/node/tar-stream.ts', 'src/node/adsb-archive.ts'],
    rules: { 'no-await-in-loop': 'off' },
  },
  {
    // Numerical algorithms, UI and test suites use mathematical equations, sample rates, coordinates, and physical constants.
    files: ['src/node/**', 'src/browser/**', '**/*.test.ts', 'site/**', 'cli/**'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
    },
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
