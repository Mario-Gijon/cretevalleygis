import { useEffect, useRef } from "react";
import type Feature from "ol/Feature.js";
import type Map from "ol/Map.js";
import Attribution from "ol/control/Attribution.js";
import { defaults as defaultControls } from "ol/control/defaults.js";
import { fromLonLat, toLonLat } from "ol/proj.js";
import OSM from "ol/source/OSM.js";
import TileWMS from "ol/source/TileWMS.js";
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

export type BaseMapId = "osm" | "qgis";
export type BaseMapLayers = {
  osm: TileLayer<OSM>;
  qgis: TileLayer<TileWMS>;
};
export type QgisStatus = "idle" | "loading" | "available" | "error";

type MapViewProps = {
  mapRef: MutableRef<Map | null>;
  baseLayersRef: MutableRef<BaseMapLayers | null>;
  drawingsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  measurementsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  onStatusChange: (status: MapStatus) => void;
  onQgisStatusChange: (status: QgisStatus) => void;
  onMapReady: (map: Map) => (() => void) | void;
  onCenterChange: (center: [number, number]) => void;
};

export default function MapView({
  mapRef,
  baseLayersRef,
  drawingsLayer,
  measurementsLayer,
  onStatusChange,
  onQgisStatusChange,
  onMapReady,
  onCenterChange,
}: MapViewProps) {
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!targetRef.current) return;

    let pendingTiles = 0;
    let mapReady = false;
    let hasTileError = false;
    let qgisResponded = false;
    let qgisFailed = false;
    const osmSource = new OSM();
    const osmLayer = new TileLayer({ source: osmSource });
    const qgisSource = new TileWMS({
      url: "/qgis/ogc/world",
      params: {
        LAYERS: "land,countries,boundaries",
        VERSION: "1.3.0",
        FORMAT: "image/png",
        TRANSPARENT: false,
        BGCOLOR: "0xe5edf0",
      },
      serverType: "qgis",
      transition: 0,
      attributions: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Made with Natural Earth</a>',
    });
    const qgisLayer = new TileLayer({ source: qgisSource, visible: false });
    const map = new OlMap({
      target: targetRef.current,
      layers: [osmLayer, qgisLayer, drawingsLayer, measurementsLayer],
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

    const qgisTileStarted = () => {
      if (!qgisFailed) onQgisStatusChange("loading");
    };
    const qgisTileLoaded = () => {
      qgisResponded = true;
      if (!qgisFailed) onQgisStatusChange("available");
    };
    const qgisTileFailed = () => {
      if (qgisResponded || qgisFailed) return;
      qgisFailed = true;
      onQgisStatusChange("error");
    };
    const qgisVisibilityChanged = () => {
      if (!qgisLayer.getVisible()) return;
      qgisResponded = false;
      qgisFailed = false;
      onQgisStatusChange("loading");
      qgisSource.refresh();
    };

    osmSource.on("tileloadstart", tileStarted);
    osmSource.on("tileloadend", tileLoaded);
    osmSource.on("tileloaderror", tileFailed);
    qgisSource.on("tileloadstart", qgisTileStarted);
    qgisSource.on("tileloadend", qgisTileLoaded);
    qgisSource.on("tileloaderror", qgisTileFailed);
    qgisLayer.on("change:visible", qgisVisibilityChanged);
    map.once("rendercomplete", firstRender);
    mapRef.current = map;
    baseLayersRef.current = { osm: osmLayer, qgis: qgisLayer };
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
      osmSource.un("tileloadstart", tileStarted);
      osmSource.un("tileloadend", tileLoaded);
      osmSource.un("tileloaderror", tileFailed);
      qgisSource.un("tileloadstart", qgisTileStarted);
      qgisSource.un("tileloadend", qgisTileLoaded);
      qgisSource.un("tileloaderror", qgisTileFailed);
      qgisLayer.un("change:visible", qgisVisibilityChanged);
      map.un("rendercomplete", firstRender);
      map.un("moveend", updateCenter);
      detachDrawingTools?.();
      map.setTarget(undefined);
      mapRef.current = null;
      baseLayersRef.current = null;
    };
  }, [baseLayersRef, drawingsLayer, mapRef, measurementsLayer, onCenterChange, onMapReady, onQgisStatusChange, onStatusChange]);

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
