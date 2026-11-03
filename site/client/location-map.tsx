import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BUNDLED_GROUND_TRUTH } from '../../src/bundled';
import { ellipseOutline } from '../../src/physics/geo';
import type { LocationSession } from '../../src/schemas';
import * as styles from '../styles.css';
import { isSimulatedSession } from './demo';
import { describeEstimate, formatCoordinates } from './result-summary';
import { TILE_URL_TEMPLATE } from './tiles';

/** Zoom level a located observer is shown at, close enough to read streets. */
const LOCATED_ZOOM = 13;

/** Zoom level before any estimate exists, showing the area of the bundled reference data. */
const INITIAL_ZOOM = 12;

/** Properties of the map. */
export interface LocationMapProps {
  readonly session: Readonly<LocationSession> | null;
  /** Called when the estimate chip over the map is chosen. */
  readonly onOpenResult: () => void;
}

/**
 * The map of candidate locations: the leading estimate, its 95% ellipse and, for the simulated recording only, the true observer.
 * Leaflet measures its container once, so a resize observer keeps tiles placed through a rotation or a layout change.
 * @param props - What the component draws and the handlers it calls: session, onOpenResult.
 * @returns The map and, once an estimate exists, a chip that states it.
 */
export function LocationMap(props: Readonly<LocationMapProps>): React.JSX.Element {
  const { session, onOpenResult } = props;
  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (mapRef.current === null || leafletMap.current !== null) {
      return undefined;
    }
    const map = L.map(mapRef.current, { center: [BUNDLED_GROUND_TRUTH.lat, BUNDLED_GROUND_TRUTH.lon], zoom: INITIAL_ZOOM, zoomControl: true });
    L.tileLayer(TILE_URL_TEMPLATE, {
      maxZoom: 19,
      // CORS tile requests give the service worker inspectable responses it can cache for offline use.
      crossOrigin: true,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    layer.current = L.layerGroup().addTo(map);
    leafletMap.current = map;

    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(mapRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      leafletMap.current = null;
      layer.current = null;
    };
  }, []);

  const topHypothesis = session?.hypotheses[0];
  const showTruth = isSimulatedSession(session);

  useEffect(() => {
    const map = leafletMap.current;
    const group = layer.current;
    if (map === null || group === null) {
      return;
    }
    group.clearLayers();

    if (showTruth) {
      L.circleMarker([BUNDLED_GROUND_TRUTH.lat, BUNDLED_GROUND_TRUTH.lon], { radius: 6, color: '#10b981', fillColor: '#10b981', fillOpacity: 0.9 })
        .bindPopup(`<b>True observer of the simulated recording</b><br>${formatCoordinates(BUNDLED_GROUND_TRUTH.lat, BUNDLED_GROUND_TRUTH.lon)}`)
        .addTo(group);
    }
    if (topHypothesis === undefined) {
      return;
    }
    L.circleMarker([topHypothesis.lat, topHypothesis.lon], { radius: 7, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.8 })
      .bindPopup(`<b>Estimated location</b><br>${describeEstimate(topHypothesis)}`)
      .addTo(group);
    // The outline is computed in true metres on the ground, so its width is right at any latitude.
    L.polygon(
      ellipseOutline(topHypothesis, topHypothesis).map((point): [number, number] => [point.lat, point.lon]),
      { color: '#3b82f6', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.15, dashArray: '4, 4' },
    ).addTo(group);
    map.setView([topHypothesis.lat, topHypothesis.lon], LOCATED_ZOOM);
  }, [topHypothesis, showTruth]);

  return (
    <div className={styles.mapContainer}>
      <div ref={mapRef} className={styles.mapCanvas} role="region" aria-label="Map of the estimated location" />
      {topHypothesis !== undefined && (
        <button type="button" className={styles.mapChip} onClick={onOpenResult}>
          {describeEstimate(topHypothesis)}
        </button>
      )}
    </div>
  );
}
