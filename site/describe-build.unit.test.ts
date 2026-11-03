import type { BuildIdentity } from '@exadev/build-identity';
import { describe, expect, it } from 'vitest';
import { describeBuild } from './describe-build';

const COMMIT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const DATE = '2026-09-08T09:12:03+01:00';

describe('describeBuild', () => {
  it('labels a release with its version and says so in the tooltip', () => {
    const identity: BuildIdentity = { kind: 'release', version: '1.4.0', url: 'https://github.com/Mearman/doppler/releases/tag/v1.4.0', date: DATE, commit: COMMIT };

    expect(describeBuild(identity)).toEqual({ label: 'v1.4.0', title: `Release 1.4.0, built ${DATE}` });
  });

  it('labels any other build with its short commit hash and calls it unreleased', () => {
    const identity: BuildIdentity = { kind: 'commit', version: 'a1b2c3d', url: `https://github.com/Mearman/doppler/commit/${COMMIT}`, date: DATE, commit: COMMIT };

    expect(describeBuild(identity)).toEqual({ label: 'a1b2c3d', title: `Unreleased build of commit a1b2c3d, built ${DATE}` });
  });
});
