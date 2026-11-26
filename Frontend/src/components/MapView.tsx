import { useEffect, useRef } from "react";
import type Map from "ol/Map.js";
import Attribution from "ol/control/Attribution.js";
import { defaults as defaultControls } from "ol/control/defaults.js";
import { fromLonLat } from "ol/proj.js";
import OSM from "ol/source/OSM.js";
import TileLayer from "ol/layer/Tile.js";
import OlMap from "ol/Map.js";
import View from "ol/View.js";

export type MapStatus = {
  ready: boolean;
  loading: boolean;
  error: boolean;
};

type MutableRef<T> = { current: T };

type MapViewProps = {
  mapRef: MutableRef<Map | null>;
  baseLayerRef: MutableRef<TileLayer<OSM> | null>;
  onStatusChange: (status: MapStatus) => void;
};

const CRETE_CENTER = [25.13, 35.22] as const;

export default function MapView({
  mapRef,
  baseLayerRef,
  onStatusChange,
}: MapViewProps) {
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!targetRef.current) return;

    let pendingTiles = 0;
    let mapReady = false;
    let hasTileError = false;
    const source = new OSM();
    const baseLayer = new TileLayer({ source });
    const map = new OlMap({
      target: targetRef.current,
      layers: [baseLayer],
      controls: defaultControls({
        attribution: false,
        rotate: false,
        zoom: false,
      }).extend([new Attribution({ collapsible: false })]),
      view: new View({
        center: fromLonLat([...CRETE_CENTER]),
        zoom: 7.6,
        minZoom: 2,
        maxZoom: 19,
        enableRotation: false,
      }),
    });

    const tileStarted = () => {
      pendingTiles += 1;
      onStatusChange({ ready: mapReady, loading: true, error: hasTileError });
    };
    const tileLoaded = () => {
      pendingTiles = Math.max(0, pendingTiles - 1);
      mapReady = true;
      onStatusChange({ ready: true, loading: pendingTiles > 0, error: hasTileError });
    };
    const tileFailed = () => {
      pendingTiles = Math.max(0, pendingTiles - 1);
      mapReady = true;
      hasTileError = true;
      onStatusChange({ ready: true, loading: pendingTiles > 0, error: true });
    };
    const firstRender = () => {
      mapReady = true;
      onStatusChange({ ready: true, loading: pendingTiles > 0, error: hasTileError });
    };

    source.on("tileloadstart", tileStarted);
    source.on("tileloadend", tileLoaded);
    source.on("tileloaderror", tileFailed);
    map.once("rendercomplete", firstRender);
    mapRef.current = map;
    baseLayerRef.current = baseLayer;

    return () => {
      source.un("tileloadstart", tileStarted);
      source.un("tileloadend", tileLoaded);
      source.un("tileloaderror", tileFailed);
      map.un("rendercomplete", firstRender);
      map.setTarget(undefined);
      mapRef.current = null;
      baseLayerRef.current = null;
    };
  }, [baseLayerRef, mapRef, onStatusChange]);

  return (
    <div
      ref={targetRef}
      className="map-canvas"
      role="application"
      aria-label="Mapa interactivo de Creta"
      tabIndex={0}
    />
  );
}

export { CRETE_CENTER };
