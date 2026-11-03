import type { DopplerDataset, LocationSession } from '../schemas';

const SESSIONS_KEY = 'doppler_sessions_v1';
const DATASET_KEY = 'doppler_custom_dataset_v1';

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
 * @returns Array of LocationSessions.
 */
export function loadSessionsFromStorage(): LocationSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? (parsed as LocationSession[]) : [];
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
 * Saves an uploaded or synced DopplerDataset into local browser storage.
 * @param dataset - The DopplerDataset to save.
 */
export function saveCustomDataset(dataset: Readonly<DopplerDataset>): void {
  try {
    localStorage.setItem(DATASET_KEY, JSON.stringify(dataset));
  } catch (err) {
    console.warn('Failed to save custom dataset to localStorage:', err);
  }
}

/**
 * Loads any custom saved dataset from browser storage.
 * @returns The saved DopplerDataset or null.
 */
export function loadCustomDataset(): DopplerDataset | null {
  try {
    const raw = localStorage.getItem(DATASET_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);

    return parsed as DopplerDataset;
  } catch {
    return null;
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
 */
export function importSessionJson(jsonText: string): LocationSession {
  const parsed: unknown = JSON.parse(jsonText);

  return parsed as LocationSession;
}
