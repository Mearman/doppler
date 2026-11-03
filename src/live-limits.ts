/** Largest search radius the live relay forwards, in nautical miles. A wider one costs the upstream more per request than a browser's view needs. Shared by the relay Worker and the page so the two cannot disagree. */
export const MAX_RADIUS_NM = 250;

/** Kilometres in a nautical mile, for turning the map's radius into the upstream's unit. */
export const KM_PER_NM = 1.852;
