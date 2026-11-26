import { useEffect, useRef } from "react";
import type Feature from "ol/Feature.js";
import type Map from "ol/Map.js";
import Attribution from "ol/control/Attribution.js";
import { defaults as defaultControls } from "ol/control/defaults.js";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj.js";
import OSM from "ol/source/OSM.js";
import ImageWMS from "ol/source/ImageWMS.js";
import OlMap from "ol/Map.js";
import type VectorLayer from "ol/layer/Vector.js";
import type Geometry from "ol/geom/Geometry.js";
import TileLayer from "ol/layer/Tile.js";
import ImageLayer from "ol/layer/Image.js";
import type VectorSource from "ol/source/Vector.js";
import View from "ol/View.js";
import {
  BASE_MAP_WMS_LAYERS,
  GEOGRAPHIC_OVERLAYS,
  type GeographicOverlayId,
} from "@/lib/cartographic-layers";
import {
  DEFAULT_TOPOGRAPHIC_OPACITY,
  TOPOGRAPHIC_LAYERS,
  type TopographicLayerId,
} from "@/lib/topographic-layers";
import { CRETE_CENTER } from "@/lib/map-config";

export type MapStatus = {
  ready: boolean;
  loading: boolean;
  error: boolean;
};

type MutableRef<T> = { current: T };

export type BaseMapId = "osm" | "qgis";
export type OverlayLayers = Record<GeographicOverlayId, ImageLayer<ImageWMS>>;
export type TopographicLayers = Record<TopographicLayerId, ImageLayer<ImageWMS>>;
export type BaseMapLayers = {
  osm: TileLayer<OSM>;
  qgis: ImageLayer<ImageWMS>;
  overlays: OverlayLayers;
  topography: TopographicLayers;
};
export type QgisStatus = "idle" | "loading" | "available" | "error";

type MapViewProps = {
  mapRef: MutableRef<Map | null>;
  baseLayersRef: MutableRef<BaseMapLayers | null>;
  drawingsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  measurementsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  onStatusChange: (status: MapStatus) => void;
  onQgisStatusChange: (status: QgisStatus) => void;
  onOverlayAvailabilityChange: (id: GeographicOverlayId, available: boolean) => void;
  onTopographicAvailabilityChange: (id: TopographicLayerId, available: boolean) => void;
  onMapReady: (map: Map) => (() => void) | void;
  onCenterChange: (
    center: [number, number],
    extent: [number, number, number, number],
    resolution: number,
  ) => void;
};

export default function MapView({
  mapRef,
  baseLayersRef,
  drawingsLayer,
  measurementsLayer,
  onStatusChange,
  onQgisStatusChange,
  onOverlayAvailabilityChange,
  onTopographicAvailabilityChange,
  onMapReady,
  onCenterChange,
}: MapViewProps) {
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!targetRef.current) return;

    let pendingTiles = 0;
    let mapReady = false;
    let hasTileError = false;
    let qgisFailed = false;
    let qgisLoadedOnce = false;
    let initialQgisFailureTimer: ReturnType<typeof setTimeout> | undefined;
    const osmSource = new OSM();
    const osmLayer = new TileLayer({ source: osmSource });
    const naturalEarthAttribution = '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Made with Natural Earth</a>';
    const qgisSource = new ImageWMS({
      url: "/qgis/ogc/world",
      params: {
        LAYERS: BASE_MAP_WMS_LAYERS.join(","),
        VERSION: "1.3.0",
        FORMAT: "image/png",
        TRANSPARENT: false,
        BGCOLOR: "0xe5edf0",
      },
      serverType: "qgis",
      attributions: naturalEarthAttribution,
    });
    const qgisLayer = new ImageLayer({ source: qgisSource, visible: false });
    const overlaySources = Object.fromEntries(
      Object.entries(GEOGRAPHIC_OVERLAYS).map(([id, overlay]) => [
        id,
        new ImageWMS({
          url: "/qgis/ogc/world",
          params: {
            LAYERS: overlay.layers.join(","),
            VERSION: "1.3.0",
            FORMAT: "image/png",
            TRANSPARENT: true,
          },
          serverType: "qgis",
          attributions: naturalEarthAttribution,
        }),
      ]),
    ) as Record<GeographicOverlayId, ImageWMS>;
    const overlayLayers = Object.fromEntries(
      Object.entries(overlaySources).map(([id, source]) => [
        id,
        new ImageLayer({ source, visible: ["boundaries", "localities"].includes(id) }),
      ]),
    ) as OverlayLayers;
    const topographicSources = Object.fromEntries(
      Object.entries(TOPOGRAPHIC_LAYERS).map(([id, layer]) => [
        id,
        new ImageWMS({
          url: "/qgis/ogc/world",
          params: {
            LAYERS: `${layer.globalWmsLayer},${layer.wmsLayer}`,
            VERSION: "1.3.0",
            FORMAT: "image/png",
            TRANSPARENT: true,
          },
          serverType: "qgis",
        }),
      ]),
    ) as Record<TopographicLayerId, ImageWMS>;
    const topographicLayers = Object.fromEntries(
      Object.entries(topographicSources).map(([id, source]) => {
        const layerId = id as TopographicLayerId;
        return [layerId, new ImageLayer({
          source,
          visible: false,
          opacity: DEFAULT_TOPOGRAPHIC_OPACITY[layerId] / 100,
        })];
      }),
    ) as TopographicLayers;
    const map = new OlMap({
      target: targetRef.current,
      layers: [
        osmLayer,
        qgisLayer,
        topographicLayers.elevation,
        topographicLayers.hillshade,
        overlayLayers.boundaries,
        overlayLayers.localities,
        overlayLayers.rivers,
        overlayLayers.lakes,
        drawingsLayer,
        measurementsLayer,
      ],
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
      if (qgisLayer.getVisible() && !qgisFailed) onQgisStatusChange("loading");
    };
    const qgisTileLoaded = () => {
      if (!qgisLayer.getVisible() || qgisFailed) return;
      qgisLoadedOnce = true;
      if (initialQgisFailureTimer) clearTimeout(initialQgisFailureTimer);
      onQgisStatusChange("available");
    };
    const qgisTileFailed = () => {
      if (!qgisLayer.getVisible() || qgisFailed) return;
      if (qgisLoadedOnce) {
        qgisFailed = true;
        onQgisStatusChange("error");
        return;
      }
      // A single failed tile may be transient. Keep OSM available while QGIS
      // tries its other visible scale tiles, then fall back if none succeeds.
      if (!initialQgisFailureTimer) {
        initialQgisFailureTimer = setTimeout(() => {
          if (!qgisLoadedOnce && qgisLayer.getVisible()) {
            qgisFailed = true;
            onQgisStatusChange("error");
          }
        }, 1200);
      }
    };
    const qgisVisibilityChanged = () => {
      if (!qgisLayer.getVisible()) return;
      qgisFailed = false;
      qgisLoadedOnce = false;
      if (initialQgisFailureTimer) clearTimeout(initialQgisFailureTimer);
      initialQgisFailureTimer = undefined;
      onQgisStatusChange("loading");
      qgisSource.refresh();
      Object.entries(overlayLayers).forEach(([id, layer]) => {
        if (layer.getVisible()) overlaySources[id as GeographicOverlayId].refresh();
      });
    };
    const overlayListeners = Object.entries(overlaySources).map(([id, source]) => {
      const overlayId = id as GeographicOverlayId;
      const layer = overlayLayers[overlayId];
      const onTileLoad = () => onOverlayAvailabilityChange(overlayId, true);
      const onTileError = () => {
        if (layer.getVisible()) onOverlayAvailabilityChange(overlayId, false);
      };
      const onVisibilityChange = () => {
        if (layer.getVisible()) source.refresh();
        else onOverlayAvailabilityChange(overlayId, true);
      };
      layer.on("change:visible", onVisibilityChange);
      return { id: overlayId, source, layer, onTileLoad, onTileError, onVisibilityChange };
    });
    const topographicListeners = Object.entries(topographicSources).map(([id, source]) => {
      const layerId = id as TopographicLayerId;
      const layer = topographicLayers[layerId];
      const onLoad = () => onTopographicAvailabilityChange(layerId, true);
      const onError = () => {
        if (layer.getVisible()) onTopographicAvailabilityChange(layerId, false);
      };
      const onVisibilityChange = () => {
        if (layer.getVisible()) source.refresh();
      };
      layer.on("change:visible", onVisibilityChange);
      return { id: layerId, source, layer, onLoad, onError, onVisibilityChange };
    });

    osmSource.on("tileloadstart", tileStarted);
    osmSource.on("tileloadend", tileLoaded);
    osmSource.on("tileloaderror", tileFailed);
    qgisSource.on("imageloadstart", qgisTileStarted);
    qgisSource.on("imageloadend", qgisTileLoaded);
    qgisSource.on("imageloaderror", qgisTileFailed);
    qgisLayer.on("change:visible", qgisVisibilityChanged);
    Object.entries(overlaySources).forEach(([id, source]) => {
      const listeners = overlayListeners.find((item) => item.id === id);
      if (!listeners) return;
      source.on("imageloadend", listeners.onTileLoad);
      source.on("imageloaderror", listeners.onTileError);
    });
    topographicListeners.forEach(({ source, onLoad, onError }) => {
      source.on("imageloadend", onLoad);
      source.on("imageloaderror", onError);
    });
    map.once("rendercomplete", firstRender);
    mapRef.current = map;
    baseLayersRef.current = { osm: osmLayer, qgis: qgisLayer, overlays: overlayLayers, topography: topographicLayers };
    const updateCenter = () => {
      const center = map.getView().getCenter();
      if (!center) return;
      const [longitude, latitude] = toLonLat(center);
      const size = map.getSize();
      const extent = size
        ? transformExtent(map.getView().calculateExtent(size), "EPSG:3857", "EPSG:4326") as [number, number, number, number]
        : [longitude, latitude, longitude, latitude] as [number, number, number, number];
      onCenterChange([longitude, latitude], extent, map.getView().getResolution() ?? 0);
    };
    map.on("moveend", updateCenter);
    map.on("change:size", updateCenter);
    updateCenter();
    const detachDrawingTools = onMapReady(map);

    return () => {
      osmSource.un("tileloadstart", tileStarted);
      osmSource.un("tileloadend", tileLoaded);
      osmSource.un("tileloaderror", tileFailed);
      qgisSource.un("imageloadstart", qgisTileStarted);
      qgisSource.un("imageloadend", qgisTileLoaded);
      qgisSource.un("imageloaderror", qgisTileFailed);
      qgisLayer.un("change:visible", qgisVisibilityChanged);
      if (initialQgisFailureTimer) clearTimeout(initialQgisFailureTimer);
      overlayListeners.forEach(({ source, layer, onTileLoad, onTileError, onVisibilityChange }) => {
        source.un("imageloadend", onTileLoad);
        source.un("imageloaderror", onTileError);
        layer.un("change:visible", onVisibilityChange);
      });
      topographicListeners.forEach(({ source, layer, onLoad, onError, onVisibilityChange }) => {
        source.un("imageloadend", onLoad);
        source.un("imageloaderror", onError);
        layer.un("change:visible", onVisibilityChange);
      });
      map.un("rendercomplete", firstRender);
      map.un("moveend", updateCenter);
      map.un("change:size", updateCenter);
      detachDrawingTools?.();
      map.setTarget(undefined);
      mapRef.current = null;
      baseLayersRef.current = null;
    };
  }, [baseLayersRef, drawingsLayer, mapRef, measurementsLayer, onCenterChange, onMapReady, onOverlayAvailabilityChange, onQgisStatusChange, onStatusChange, onTopographicAvailabilityChange]);

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
