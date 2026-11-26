import { useEffect, useRef } from "react";
import type Feature from "ol/Feature.js";
import type Map from "ol/Map.js";
import Attribution from "ol/control/Attribution.js";
import { defaults as defaultControls } from "ol/control/defaults.js";
import { fromLonLat, toLonLat } from "ol/proj.js";
import OSM from "ol/source/OSM.js";
import OlMap from "ol/Map.js";
import type VectorLayer from "ol/layer/Vector.js";
import type Geometry from "ol/geom/Geometry.js";
import TileLayer from "ol/layer/Tile.js";
import type VectorSource from "ol/source/Vector.js";
import View from "ol/View.js";
import { CRETE_CENTER } from "@/lib/map-config";

export type MapStatus = {
  ready: boolean;
  loading: boolean;
  error: boolean;
};

type MutableRef<T> = { current: T };

type MapViewProps = {
  mapRef: MutableRef<Map | null>;
  baseLayerRef: MutableRef<TileLayer<OSM> | null>;
  drawingsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  measurementsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  onStatusChange: (status: MapStatus) => void;
  onMapReady: (map: Map) => (() => void) | void;
  onCenterChange: (center: [number, number]) => void;
};

export default function MapView({
  mapRef,
  baseLayerRef,
  drawingsLayer,
  measurementsLayer,
  onStatusChange,
  onMapReady,
  onCenterChange,
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
      layers: [baseLayer, drawingsLayer, measurementsLayer],
      controls: defaultControls({
        attribution: false,
        rotate: false,
        zoom: false,
      }).extend([
        new Attribution({ collapsible: false }),
      ]),
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
    const updateCenter = () => {
      const center = map.getView().getCenter();
      if (!center) return;
      const [longitude, latitude] = toLonLat(center);
      onCenterChange([longitude, latitude]);
    };
    map.on("moveend", updateCenter);
    updateCenter();
    const detachDrawingTools = onMapReady(map);

    return () => {
      source.un("tileloadstart", tileStarted);
      source.un("tileloadend", tileLoaded);
      source.un("tileloaderror", tileFailed);
      map.un("rendercomplete", firstRender);
      map.un("moveend", updateCenter);
      detachDrawingTools?.();
      map.setTarget(undefined);
      mapRef.current = null;
      baseLayerRef.current = null;
    };
  }, [baseLayerRef, drawingsLayer, mapRef, measurementsLayer, onCenterChange, onMapReady, onStatusChange]);

  return (
    <div
      ref={targetRef}
      className="map-canvas"
      role="application"
      aria-label="Mapa interactivo"
      tabIndex={0}
    />
  );
}
