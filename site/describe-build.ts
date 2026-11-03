import type { BuildIdentity } from '@exadev/build-identity';

/**
 * Text and tooltip for the header link to the build.
 * @param identity - What the build resolved to.
 * @returns A label (`v1.0.0` for a release, the short commit hash otherwise) and a tooltip saying which it is.
 */
export function describeBuild(identity: Readonly<BuildIdentity>): { readonly label: string; readonly title: string } {
  return identity.kind === 'release'
    ? { label: `v${identity.version}`, title: `Release ${identity.version}, built ${identity.date}` }
    : { label: identity.version, title: `Unreleased build of commit ${identity.version}, built ${identity.date}` };
}
