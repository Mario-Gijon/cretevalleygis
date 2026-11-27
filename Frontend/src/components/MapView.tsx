import { useEffect, useRef, useState } from "react";
import Feature from "ol/Feature.js";
import type Map from "ol/Map.js";
import Attribution from "ol/control/Attribution.js";
import ScaleLine from "ol/control/ScaleLine.js";
import { defaults as defaultControls } from "ol/control/defaults.js";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj.js";
import OSM from "ol/source/OSM.js";
import ImageWMS from "ol/source/ImageWMS.js";
import OlMap from "ol/Map.js";
import LayerGroup from "ol/layer/Group.js";
import VectorTileLayer from "ol/layer/VectorTile.js";
import type VectorLayer from "ol/layer/Vector.js";
import type Geometry from "ol/geom/Geometry.js";
import TileLayer from "ol/layer/Tile.js";
import ImageLayer from "ol/layer/Image.js";
import type VectorSource from "ol/source/Vector.js";
import type Polygon from "ol/geom/Polygon.js";
import { getVectorContext } from "ol/render.js";
import type RenderEvent from "ol/render/Event.js";
import Fill from "ol/style/Fill.js";
import Style from "ol/style/Style.js";
import View from "ol/View.js";
import {
  OPEN_FREE_MAP_ATTRIBUTION_HTML,
  OPEN_FREE_MAP_STYLES,
  type BaseMapId,
  type OpenFreeMapId,
  type OpenFreeMapStatus,
} from "@/lib/base-maps";
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
import type { PreparedTerrainMapEntry } from "@/lib/prepared-terrain";
import { CRETE_CENTER } from "@/lib/map-config";

export type MapStatus = {
  ready: boolean;
  loading: boolean;
  error: boolean;
};

type MutableRef<T> = { current: T };

export type OverlayLayers = Record<GeographicOverlayId, ImageLayer<ImageWMS>>;
export type TopographicLayers = Record<TopographicLayerId, ImageLayer<ImageWMS>>;
export type VectorBaseMapLayers = Record<OpenFreeMapId, LayerGroup>;
export type BaseMapLayers = {
  osm: TileLayer<OSM>;
  qgis: ImageLayer<ImageWMS>;
  vector: VectorBaseMapLayers;
  overlays: OverlayLayers;
  topography: TopographicLayers;
  regionalTerrains: LayerGroup;
};
type RegionalTerrainLayerGroup = {
  group: LayerGroup;
  layers: Partial<Record<TopographicLayerId, ImageLayer<ImageWMS>>>;
  geometry: Polygon;
  cleanup: () => void;
};
export type QgisStatus = "idle" | "loading" | "available" | "error";
type VectorTileListenerCleanup = () => void;

type MapViewProps = {
  baseMap: BaseMapId;
  mapRef: MutableRef<Map | null>;
  baseLayersRef: MutableRef<BaseMapLayers | null>;
  drawingsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  measurementsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  preparedTerrains: PreparedTerrainMapEntry[];
  onStatusChange: (status: MapStatus) => void;
  onQgisStatusChange: (status: QgisStatus) => void;
  onOpenFreeMapStatusChange: (id: OpenFreeMapId, status: OpenFreeMapStatus) => void;
  onOverlayAvailabilityChange: (id: GeographicOverlayId, available: boolean) => void;
  onTopographicAvailabilityChange: (id: TopographicLayerId, available: boolean) => void;
  onPreparedTerrainAvailabilityChange: (elementId: string, id: TopographicLayerId, available: boolean) => void;
  onMapReady: (map: Map) => (() => void) | void;
  onCenterChange: (
    center: [number, number],
    extent: [number, number, number, number],
    resolution: number,
  ) => void;
};

export default function MapView({
  baseMap,
  mapRef,
  baseLayersRef,
  drawingsLayer,
  measurementsLayer,
  preparedTerrains,
  onStatusChange,
  onQgisStatusChange,
  onOpenFreeMapStatusChange,
  onOverlayAvailabilityChange,
  onTopographicAvailabilityChange,
  onPreparedTerrainAvailabilityChange,
  onMapReady,
  onCenterChange,
}: MapViewProps) {
  const targetRef = useRef<HTMLDivElement>(null);
  const [mapGeneration, setMapGeneration] = useState(0);
  const baseMapRef = useRef(baseMap);
  const vectorLoadedRef = useRef(new Set<OpenFreeMapId>());
  const vectorPromisesRef = useRef(new globalThis.Map<OpenFreeMapId, Promise<void>>());
  const vectorTileListenersRef = useRef(new globalThis.Map<OpenFreeMapId, VectorTileListenerCleanup[]>());
  const regionalTerrainGroupsRef = useRef(new globalThis.Map<string, RegionalTerrainLayerGroup>());
  const preparedAvailabilityRef = useRef(onPreparedTerrainAvailabilityChange);
  const activeBaseMapRef = useRef<BaseMapId | null>(null);
  const disposedRef = useRef(false);
  baseMapRef.current = baseMap;
  preparedAvailabilityRef.current = onPreparedTerrainAvailabilityChange;

  useEffect(() => {
    if (!targetRef.current) return;
    disposedRef.current = false;

    let pendingTiles = 0;
    let mapReady = false;
    let hasTileError = false;
    let qgisFailed = false;
    let qgisLoadedOnce = false;
    let initialQgisFailureTimer: ReturnType<typeof setTimeout> | undefined;
    const osmSource = new OSM();
    const osmLayer = new TileLayer({ source: osmSource, visible: false });
    const naturalEarthAttribution = '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Made with Natural Earth</a>';
    const qgisSource = new ImageWMS({
      url: "/qgis/ogc/world",
      ratio: 1,
      hidpi: true,
      interpolate: true,
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
    const vectorBaseMapLayers = Object.fromEntries(
      Object.keys(OPEN_FREE_MAP_STYLES).map((id) => [
        id,
        new LayerGroup({ visible: false, layers: [] }),
      ]),
    ) as VectorBaseMapLayers;
    const overlaySources = Object.fromEntries(
      Object.entries(GEOGRAPHIC_OVERLAYS).map(([id, overlay]) => [
        id,
        new ImageWMS({
          url: "/qgis/ogc/world",
          ratio: 1,
          hidpi: true,
          interpolate: true,
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
        new ImageLayer({ source, visible: ["boundaries", "localities"].includes(id), zIndex: 6 }),
      ]),
    ) as OverlayLayers;
    const topographicSources = Object.fromEntries(
      Object.entries(TOPOGRAPHIC_LAYERS).map(([id]) => [
        id,
        new ImageWMS({
          url: "/qgis/ogc/world",
          ratio: 1,
          hidpi: true,
          interpolate: id !== "slope" && id !== "aspect",
          params: {
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
    const regionalTerrains = new LayerGroup({ layers: [] });
    const map = new OlMap({
      target: targetRef.current,
      pixelRatio: window.devicePixelRatio || 1,
      layers: [
        osmLayer,
        qgisLayer,
        ...Object.values(vectorBaseMapLayers),
        topographicLayers.elevation,
        topographicLayers.hillshade,
        topographicLayers.slope,
        topographicLayers.aspect,
        regionalTerrains,
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
        new ScaleLine({ units: "metric", bar: true, text: true, minWidth: 112, steps: 4 }),
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
    const topographicListeners = [
      ...Object.entries(topographicSources).map(([id, source]) => ({
        id: id as TopographicLayerId,
        source,
        layer: topographicLayers[id as TopographicLayerId],
      })),
    ].map(({ id: layerId, source, layer }) => {
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
    baseLayersRef.current = {
      osm: osmLayer,
      qgis: qgisLayer,
      vector: vectorBaseMapLayers,
      overlays: overlayLayers,
      topography: topographicLayers,
      regionalTerrains,
    };
    setMapGeneration((generation) => generation + 1);
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
      disposedRef.current = true;
      activeBaseMapRef.current = null;
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
      vectorTileListenersRef.current.forEach((cleanups) => cleanups.forEach((cleanup) => cleanup()));
      vectorTileListenersRef.current.clear();
      vectorPromisesRef.current.clear();
      vectorLoadedRef.current.clear();
      map.un("rendercomplete", firstRender);
      map.un("moveend", updateCenter);
      map.un("change:size", updateCenter);
      detachDrawingTools?.();
      regionalTerrainGroupsRef.current.forEach((terrain) => terrain.cleanup());
      regionalTerrainGroupsRef.current.clear();
      map.setTarget(undefined);
      mapRef.current = null;
      baseLayersRef.current = null;
    };
  }, [baseLayersRef, drawingsLayer, mapRef, measurementsLayer, onCenterChange, onMapReady, onOverlayAvailabilityChange, onQgisStatusChange, onStatusChange, onTopographicAvailabilityChange]);

  useEffect(() => {
    const layers = baseLayersRef.current;
    if (!layers) return;

    const activate = (id: BaseMapId) => {
      layers.osm.setVisible(id === "osm");
      layers.qgis.setVisible(id === "qgis");
      (Object.keys(layers.vector) as OpenFreeMapId[]).forEach((vectorId) => {
        layers.vector[vectorId].setVisible(vectorId === id);
      });
      activeBaseMapRef.current = id;
      mapRef.current?.render();
    };

    if (baseMap === "osm" || baseMap === "qgis") {
      activate(baseMap);
      return;
    }

    const group = layers.vector[baseMap];
    if (vectorLoadedRef.current.has(baseMap)) {
      activate(baseMap);
      onOpenFreeMapStatusChange(baseMap, "available");
      return;
    }

    onOpenFreeMapStatusChange(baseMap, "loading");
    if (vectorPromisesRef.current.has(baseMap)) return;

    const styleId = baseMap;
    const styleUrl = OPEN_FREE_MAP_STYLES[styleId].url;
    let loadPromise: Promise<void>;
    loadPromise = import("ol-mapbox-style")
      .then(({ apply }) => apply(group, styleUrl))
      .then(() => {
        if (disposedRef.current || baseLayersRef.current?.vector[styleId] !== group) {
          if (vectorPromisesRef.current.get(styleId) === loadPromise) {
            vectorPromisesRef.current.delete(styleId);
          }
          return;
        }
        vectorLoadedRef.current.add(styleId);

        const cleanups: VectorTileListenerCleanup[] = [];
        group.getLayers().forEach((layer) => {
          if (!(layer instanceof VectorTileLayer)) return;
          const source = layer.getSource();
          if (!source) return;
          source.setAttributions(OPEN_FREE_MAP_ATTRIBUTION_HTML);

          let failedTiles = 0;
          let errorTimer: ReturnType<typeof setTimeout> | undefined;
          const onLoad = () => {
            failedTiles = 0;
            if (errorTimer) clearTimeout(errorTimer);
            errorTimer = undefined;
            if (activeBaseMapRef.current === styleId) {
              onOpenFreeMapStatusChange(styleId, "available");
            }
          };
          const onError = () => {
            failedTiles += 1;
            if (errorTimer) return;
            errorTimer = setTimeout(() => {
              errorTimer = undefined;
              if (failedTiles > 0 && activeBaseMapRef.current === styleId) {
                onOpenFreeMapStatusChange(styleId, "error");
              }
            }, 2500);
          };
          source.on("tileloadend", onLoad);
          source.on("tileloaderror", onError);
          cleanups.push(() => {
            if (errorTimer) clearTimeout(errorTimer);
            source.un("tileloadend", onLoad);
            source.un("tileloaderror", onError);
          });
        });
        vectorTileListenersRef.current.set(styleId, cleanups);

        onOpenFreeMapStatusChange(styleId, "available");
        if (baseMapRef.current === styleId) activate(styleId);
      })
      .catch(() => {
        group.getLayers().clear();
        if (baseLayersRef.current?.vector[styleId] !== group) {
          if (vectorPromisesRef.current.get(styleId) === loadPromise) {
            vectorPromisesRef.current.delete(styleId);
          }
          return;
        }
        vectorLoadedRef.current.delete(styleId);
        vectorPromisesRef.current.delete(styleId);
        if (!disposedRef.current) onOpenFreeMapStatusChange(styleId, "error");
      });
    vectorPromisesRef.current.set(styleId, loadPromise);
  }, [baseLayersRef, baseMap, mapGeneration, mapRef, onOpenFreeMapStatusChange]);

  useEffect(() => {
    const map = mapRef.current;
    const root = baseLayersRef.current?.regionalTerrains;
    if (!map || !root) return;
    const currentGroups = regionalTerrainGroupsRef.current;
    const wantedIds = new Set(preparedTerrains.map((terrain) => terrain.elementId));

    currentGroups.forEach((terrain, id) => {
      if (wantedIds.has(id)) return;
      terrain.cleanup();
      root.getLayers().remove(terrain.group);
      currentGroups.delete(id);
    });

    const projection = map.getView().getProjection();
    preparedTerrains.forEach((terrain) => {
      let layerGroup = currentGroups.get(terrain.elementId);
      const needsRebuild = !layerGroup || layerGroup.geometry !== terrain.geometry;
      if (needsRebuild) {
        if (layerGroup) {
          layerGroup.cleanup();
          root.getLayers().remove(layerGroup.group);
        }
        const extent = transformExtent(
          terrain.result.coverage.extent_wgs84,
          "EPSG:4326",
          projection,
          8,
        );
        const layers: Partial<Record<TopographicLayerId, ImageLayer<ImageWMS>>> = {};
        const disposers: Array<() => void> = [];
        (Object.keys(TOPOGRAPHIC_LAYERS) as TopographicLayerId[]).forEach((id) => {
          const layerName = terrain.result.cartography.layers[id];
          if (!layerName) return;
          const source = new ImageWMS({
            url: "/qgis/ogc/world",
            ratio: 1,
            hidpi: true,
            interpolate: id !== "slope" && id !== "aspect",
            params: {
              MAP: terrain.result.cartography.map_parameter,
              LAYERS: layerName,
              VERSION: "1.3.0",
              FORMAT: "image/png",
              TRANSPARENT: true,
            },
            serverType: "qgis",
          });
          const layer = new ImageLayer({
            className: `terrain-clip-${terrain.elementId}-${id}`,
            source,
            extent,
            visible: false,
            opacity: terrain.opacity[id] / 100,
          });
          const maskFeature = new Feature({ geometry: terrain.geometry });
          const maskStyle = new Style({ fill: new Fill({ color: "#ffffff" }) });
          const clipLayer = (event: RenderEvent) => {
            const context = event.context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined;
            if (!context || !("globalCompositeOperation" in context)) return;
            context.save();
            context.globalCompositeOperation = "destination-in";
            getVectorContext(event).drawFeature(maskFeature, maskStyle);
            context.restore();
          };
          const geometryChanged = () => map.render();
          const onLoad = () => preparedAvailabilityRef.current(terrain.elementId, id, true);
          const onError = () => {
            if (layer.getVisible()) preparedAvailabilityRef.current(terrain.elementId, id, false);
          };
          layer.on("postrender", clipLayer);
          terrain.geometry.on("change", geometryChanged);
          source.on("imageloadend", onLoad);
          source.on("imageloaderror", onError);
          disposers.push(() => {
            layer.un("postrender", clipLayer);
            terrain.geometry.un("change", geometryChanged);
            source.un("imageloadend", onLoad);
            source.un("imageloaderror", onError);
          });
          layers[id] = layer;
        });
        const group = new LayerGroup({ layers: Object.values(layers) });
        group.setExtent(extent);
        layerGroup = {
          group,
          layers,
          geometry: terrain.geometry,
          cleanup: () => disposers.forEach((dispose) => dispose()),
        };
        currentGroups.set(terrain.elementId, layerGroup);
        root.getLayers().push(layerGroup.group);
      }
      if (!layerGroup) return;

      layerGroup.group.setVisible(terrain.visible);
      (Object.keys(TOPOGRAPHIC_LAYERS) as TopographicLayerId[]).forEach((id) => {
        const layer = layerGroup!.layers[id];
        if (!layer) return;
        layer.setOpacity(terrain.opacity[id] / 100);
        layer.setVisible(terrain.visible && terrain.visibility[id]);
      });
      layerGroup.group.setZIndex(terrain.selected ? 5 : 4);
    });
    map.render();
  }, [baseLayersRef, mapGeneration, mapRef, preparedTerrains]);

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
