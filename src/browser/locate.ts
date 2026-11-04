/** A position in degrees. */
export interface Position {
  readonly lat: number;
  readonly lon: number;
}

/**
 * Asks the browser for the device's position. The browser shows its own permission prompt, so this is called only from a person's action, never on load.
 * @returns The position.
 * @throws When geolocation is unavailable, the person declines or the position cannot be found, with the browser's reason.
 */
export async function locateDevice(): Promise<Position> {
  return new Promise<Position>((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser has no location service'));

      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({ lat: position.coords.latitude, lon: position.coords.longitude });
      },
      (error) => {
        reject(new Error(error.message));
      },
    );
  });
}
