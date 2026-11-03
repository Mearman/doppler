import type { BuildIdentity } from '@exadev/build-identity';

/** Replaced with the identity of the commit being built by esbuild's `define` in `site/build.ts`. */
declare const BUILD_IDENTITY: BuildIdentity;

/** The release, or the commit, this copy of the page was built from. */
export const buildIdentity: BuildIdentity = BUILD_IDENTITY;
