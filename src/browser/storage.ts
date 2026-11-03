import { z } from 'zod';
import { type LocationSession, LocationSessionSchema } from '../schemas';

const SESSIONS_KEY = 'doppler_sessions_v1';

/**
 * Saves a LocationSession snapshot into local browser storage.
 * @param session - The LocationSession to save.
 */
export function saveSessionToStorage(session: Readonly<LocationSession>): void {
  try {
    const list = loadSessionsFromStorage().filter((s) => s.id !== session.id);
    list.unshift(session);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('Failed to save session to localStorage:', err);
  }
}

/**
 * Loads all saved sessions from browser storage.
 * @returns The stored sessions, or an empty array when nothing is stored or the stored value is not a list of valid sessions.
 */
export function loadSessionsFromStorage(): LocationSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);

    return z.array(LocationSessionSchema).parse(parsed);
  } catch {
    return [];
  }
}

/**
 * Loads a specific session by ID from browser storage.
 * @param sessionId - Session identifier string.
 * @returns Found LocationSession or undefined.
 */
export function loadSessionById(sessionId: string): LocationSession | undefined {
  return loadSessionsFromStorage().find((s) => s.id === sessionId);
}

/**
 * Deletes a session from browser storage.
 * @param sessionId - Session identifier string.
 */
export function deleteSessionFromStorage(sessionId: string): void {
  try {
    const list = loadSessionsFromStorage().filter((s) => s.id !== sessionId);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('Failed to delete session from localStorage:', err);
  }
}

/**
 * Exports a LocationSession as a downloadable JSON string.
 * @param session - LocationSession to export.
 * @returns Pretty-printed JSON string.
 */
export function exportSessionJson(session: Readonly<LocationSession>): string {
  return JSON.stringify(session, null, 2);
}

/**
 * Parses and validates an imported session JSON string.
 * @param jsonText - Raw imported JSON text.
 * @returns Parsed `LocationSession`.
 * @throws When the text is not JSON or not a valid session.
 */
export function importSessionJson(jsonText: string): LocationSession {
  const parsed: unknown = JSON.parse(jsonText);

  return LocationSessionSchema.parse(parsed);
}
