import type { Configuration } from 'lint-staged';

const config: Configuration = {
  // --max-warnings 0 matches `pnpm run lint:check`, which CI runs, so a warning that would fail CI fails the commit.
  '*.{ts,tsx}': 'eslint --fix --max-warnings 0',
};

export default config;
