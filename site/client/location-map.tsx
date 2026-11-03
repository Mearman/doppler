import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ellipseOutline } from '../../src/physics/geo';
import type { LocationSession } from '../../src/schemas';
import * as styles from '../styles.css';
import { describeEstimate } from './result-summary';
import { TILE_URL_TEMPLATE } from './tiles';
import type { SearchArea } from './use-live-feed';

/** Metres in a kilometre. */
const METRES_PER_KM = 1000;

/** Zoom level a located observer is shown at, close enough to read streets. */
const LOCATED_ZOOM = 13;

/** View before any estimate exists: the whole world, since nothing yet says where the listener is. */
const INITIAL_CENTRE: L.LatLngTuple = [20, 0];
const INITIAL_ZOOM = 2;

/** Properties of the map. */
export interface LocationMapProps {
  readonly session: Readonly<LocationSession> | null;
  /** Called when the estimate chip over the map is chosen. */
  readonly onOpenResult: () => void;
  /** Called with the visible area after the map is first laid out and after every move or zoom. */
  readonly onAreaChange: (area: Readonly<SearchArea>) => void;
}

/**
 * The map of candidate locations: the leading estimate and its 95% ellipse.
 * Leaflet measures its container once, so a resize observer keeps tiles placed through a rotation or a layout change.
 * @param props - The session to draw, the handler for the estimate chip and the handler told which area is visible.
 * @returns The map and, once an estimate exists, a chip that states it.
 */
export function LocationMap(props: Readonly<LocationMapProps>): React.JSX.Element {
  const { session, onOpenResult, onAreaChange } = props;
  const onAreaChangeRef = useRef(onAreaChange);
  onAreaChangeRef.current = onAreaChange;
  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (mapRef.current === null || leafletMap.current !== null) {
      return undefined;
    }
    const map = L.map(mapRef.current, { center: INITIAL_CENTRE, zoom: INITIAL_ZOOM, zoomControl: true });
    L.tileLayer(TILE_URL_TEMPLATE, {
      maxZoom: 19,
      // CORS tile requests give the service worker inspectable responses it can cache for offline use.
      crossOrigin: true,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    layer.current = L.layerGroup().addTo(map);
    leafletMap.current = map;

    // The visible area, as a centre and the distance from it to the corner, which is the circle that covers the view.
    const reportArea = (): void => {
      const centre = map.getCenter();
      onAreaChangeRef.current({ lat: centre.lat, lon: centre.lng, radiusKm: map.distance(centre, map.getBounds().getNorthEast()) / METRES_PER_KM });
    };
    map.on('moveend', reportArea);
    reportArea();

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

  useEffect(() => {
    const map = leafletMap.current;
    const group = layer.current;
    if (map === null || group === null) {
      return;
    }
    group.clearLayers();

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
  }, [topHypothesis]);

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
