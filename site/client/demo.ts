import type { LocationSession } from '../../src/schemas';

/** Episode id the "Simulate flyover" action gives its synthetic recording, so the page can tell a demonstration from a real session. */
export const SIMULATED_EPISODE_ID = 'simulated_episode_1';

/**
 * Whether any observation in the session came from the synthetic reference recording, whose true observer is the bundled Oxford point.
 * @param session - The session to inspect, or null before one exists.
 * @returns True when the bundled ground-truth marker describes this session.
 */
export function isSimulatedSession(session: Readonly<LocationSession> | null): boolean {
  return session?.observations.some((observation) => observation.episodeId === SIMULATED_EPISODE_ID) ?? false;
}
