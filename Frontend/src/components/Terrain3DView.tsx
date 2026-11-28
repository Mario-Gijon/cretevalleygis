import { useEffect, useMemo, useRef, useState } from "react";
import { Compass, LoaderCircle, Mountain } from "lucide-react";
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapMouseEvent,
  type ErrorEvent as MapLibreErrorEvent,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { OPEN_FREE_MAP_STYLES, type OpenFreeMapId } from "@/lib/base-maps";
import { subscribeTerrariumDemTiles, TERRARIUM_DEM_TILE_TEMPLATE, type TerrariumDemTileEvent } from "@/lib/terrarium-dem-protocol";
import { EXPLORATION_TERRAIN } from "@/lib/exploration-terrain";
import type { DrawnElement } from "@/hooks/useDrawingTools";
import type { Feature, FeatureCollection, Geometry } from "geojson";

export type Terrain3DCamera = {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
};

type Terrain3DViewProps = {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  styleId: OpenFreeMapId;
  exaggeration: number;
  theme: "light" | "dark";
  navigationRevision: number;
  onCameraChange: (camera: Terrain3DCamera) => void;
  onCameraReaderChange: (reader: (() => Terrain3DCamera) | null) => void;
  onLocateElementReaderChange: (reader: ((element: DrawnElement) => void) | null) => void;
  elements: DrawnElement[];
  selectedIds: string[];
  onSelectElement: (id: string) => void;
  onStyleChange: (style: OpenFreeMapId) => void;
  onExaggerationChange: (value: number) => void;
};

const TERRAIN_SOURCE_ID = "crete-valley-terrain";
const HILLSHADE_LAYER_ID = "crete-valley-hillshade";
const GEOMETRIES_SOURCE_ID = "crete-valley-user-geometries";
const GEOMETRY_FILL_LAYER_ID = "crete-valley-user-geometry-fill";
const GEOMETRY_OUTLINE_LAYER_ID = "crete-valley-user-geometry-outline";
const GEOMETRY_LINE_LAYER_ID = "crete-valley-user-lines";
const GEOMETRY_POINT_LAYER_ID = "crete-valley-user-points";
const GEOMETRY_LAYER_IDS = [GEOMETRY_FILL_LAYER_ID, GEOMETRY_OUTLINE_LAYER_ID, GEOMETRY_LINE_LAYER_ID, GEOMETRY_POINT_LAYER_ID];
const MAX_MAP_ZOOM = 18;
const MIN_MAP_ZOOM = 1;
const MAX_MAP_PITCH = 82;
const MIN_MAP_PITCH = 0;

type GeometryProperties = {
  elementId: string;
  name: string;
  geometryKind: "surface" | "line" | "point";
  selected: boolean;
};

type GeometryFeature = Feature<Geometry, GeometryProperties>;
type GeometryCollection = FeatureCollection<Geometry, GeometryProperties>;

function createGeometryCollection(elements: DrawnElement[], selectedIds: string[]): GeometryCollection {
  const selected = new Set(selectedIds);
  const features: GeometryFeature[] = [];
  for (const element of elements) {
    const geometry = element.geoJsonGeometry ?? element.geoJsonLineString ?? element.geoJsonPoint;
    if (!geometry) continue;
    const geometryKind: GeometryProperties["geometryKind"] = element.geoJsonGeometry
      ? "surface"
      : element.geoJsonLineString ? "line" : "point";
    features.push({
      type: "Feature",
      id: element.id,
      properties: {
        elementId: element.id,
        name: element.name,
        geometryKind,
        selected: selected.has(element.id),
      },
      geometry: geometry as Geometry,
    });
  }
  return { type: "FeatureCollection", features };
}

function geometryBounds(element: DrawnElement): [[number, number], [number, number]] | null {
  if (element.bboxWgs84) {
    const [west, south, east, north] = element.bboxWgs84;
    return [[west, south], [east, north]];
  }

  const coordinates = element.geoJsonPoint?.coordinates
    ?? element.geoJsonLineString?.coordinates
    ?? element.geoJsonGeometry?.coordinates;
  if (!coordinates) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      west = Math.min(west, value[0]);
      east = Math.max(east, value[0]);
      south = Math.min(south, value[1]);
      north = Math.max(north, value[1]);
      return;
    }
    value.forEach(visit);
  };
  visit(coordinates);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  const minimumSpan = 0.002;
  const spanX = east - west;
  if (spanX < minimumSpan) {
    const padding = (minimumSpan - spanX) / 2;
    west -= padding;
    east += padding;
  }
  const spanY = north - south;
  if (spanY < minimumSpan) {
    const padding = (minimumSpan - spanY) / 2;
    south -= padding;
    north += padding;
  }
  return [[west, south], [east, north]];
}

function isOpenFreeMapId(value: string): value is OpenFreeMapId {
  return value in OPEN_FREE_MAP_STYLES;
}

function terrainStyleUrl(styleId: OpenFreeMapId): string {
  return OPEN_FREE_MAP_STYLES[styleId].url;
}

function tileIntersectsBounds(
  key: string,
  bounds: ReturnType<MapLibreMap["getBounds"]>,
  centerLongitude: number,
): boolean {
  const [zoom, rawX, y] = key.split("/").map(Number);
  const count = 2 ** zoom;
  if (![zoom, rawX, y].every(Number.isFinite) || zoom < 0 || y < 0 || y >= count) return false;
  const x = ((rawX % count) + count) % count;
  const west = x / count * 360 - 180;
  const east = (x + 1) / count * 360 - 180;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / count))) * 180 / Math.PI;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / count))) * 180 / Math.PI;
  if (north < bounds.getSouth() || south > bounds.getNorth()) return false;
  if (bounds.getEast() - bounds.getWest() >= 360) return true;
  const shift = Math.round((centerLongitude - (west + east) / 2) / 360) * 360;
  return east + shift >= bounds.getWest() && west + shift <= bounds.getEast();
}

export default function Terrain3DView({
  center,
  zoom,
  bearing,
  pitch,
  styleId,
  exaggeration,
  theme,
  navigationRevision,
  onCameraChange,
  onCameraReaderChange,
  onLocateElementReaderChange,
  elements,
  selectedIds,
  onSelectElement,
  onStyleChange,
  onExaggerationChange,
}: Terrain3DViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const exaggerationRef = useRef(exaggeration);
  const themeRef = useRef(theme);
  const currentStyleRef = useRef(styleId);
  const navigationRef = useRef({ center, zoom, bearing, pitch });
  const elementsRef = useRef(elements);
  const onSelectElementRef = useRef(onSelectElement);
  const geometryCollection = useMemo(() => createGeometryCollection(elements, selectedIds), [elements, selectedIds]);
  const geometryCollectionRef = useRef<GeometryCollection>(geometryCollection);
  const [terrainTiles, setTerrainTiles] = useState({ available: 0, missing: 0 });
  const [loadError, setLoadError] = useState<string | null>(null);

  exaggerationRef.current = exaggeration;
  themeRef.current = theme;
  navigationRef.current = { center, zoom, bearing, pitch };
  elementsRef.current = elements;
  onSelectElementRef.current = onSelectElement;
  geometryCollectionRef.current = geometryCollection;

  useEffect(() => {
    if (!containerRef.current) return;
    setWorkerUrl(workerUrl);

    setLoadError(null);
    setTerrainTiles({ available: 0, missing: 0 });
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: containerRef.current,
        style: terrainStyleUrl(styleId),
        center,
        zoom: Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, zoom)),
        bearing,
        pitch: Math.max(MIN_MAP_PITCH, Math.min(MAX_MAP_PITCH, pitch)),
        minZoom: MIN_MAP_ZOOM,
        maxZoom: MAX_MAP_ZOOM,
        maxPitch: 82,
        attributionControl: { compact: true },
        canvasContextAttributes: { antialias: false, powerPreference: "low-power" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Este navegador no dispone de WebGL compatible.";
      setLoadError(message);
      return;
    }
    mapRef.current = map;
    const navigation = new NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true });
    const scale = new ScaleControl({ unit: "metric" });
    map.addControl(navigation, "top-right");
    map.addControl(scale, "bottom-left");

    const tileStates = new Map<string, TerrariumDemTileEvent["status"]>();
    const updateVisibleTerrain = () => {
      if (!map.isStyleLoaded()) return;
      const bounds = map.getBounds();
      const longitude = map.getCenter().lng;
      const visibleStates = Array.from(tileStates.entries())
        .filter(([key]) => tileIntersectsBounds(key, bounds, longitude))
        .map(([, status]) => status);
      const available = visibleStates.filter((status) => status === "available").length;
      const missing = visibleStates.filter((status) => status === "no-data").length;
      const errored = visibleStates.filter((status) => status === "error").length;
      setTerrainTiles({ available, missing });
      if (errored > 0) {
        setLoadError("Algunas elevaciones no están disponibles; el resto del terreno se conserva.");
      } else if (available > 0 && missing > 0) {
        setLoadError(null);
      } else if (available > 0) {
        setLoadError(null);
      } else if (missing > 0) {
        setLoadError("Sin elevación válida en esta vista; no se asignan alturas ficticias.");
      } else {
        setLoadError(null);
      }
    };
    const unsubscribeTerrainTiles = subscribeTerrariumDemTiles((event) => {
      tileStates.delete(event.key);
      tileStates.set(event.key, event.status);
      while (tileStates.size > 128) {
        const first = tileStates.keys().next().value;
        if (first === undefined) break;
        tileStates.delete(first);
      }
      updateVisibleTerrain();
    });

    const applyTerrain = () => {
      try {
        if (!map.getSource(TERRAIN_SOURCE_ID)) {
          map.addSource(TERRAIN_SOURCE_ID, {
            type: "raster-dem",
            tiles: [TERRARIUM_DEM_TILE_TEMPLATE],
            tileSize: 256,
            minzoom: EXPLORATION_TERRAIN.mapMinimumZoom,
            maxzoom: EXPLORATION_TERRAIN.maxDataZoom,
            encoding: "terrarium",
            attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">Mapzen Terrain Tiles · fuentes y atribución</a>',
          });
        }
        map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: exaggerationRef.current });
        if (!map.getSource(GEOMETRIES_SOURCE_ID)) {
          map.addSource(GEOMETRIES_SOURCE_ID, {
            type: "geojson",
            data: geometryCollectionRef.current,
            promoteId: "elementId",
          });
        } else {
          (map.getSource(GEOMETRIES_SOURCE_ID) as GeoJSONSource).setData(geometryCollectionRef.current);
        }
        const firstSymbolLayer = map.getStyle().layers.find((layer) => layer.type === "symbol");
        if (!map.getLayer(GEOMETRY_FILL_LAYER_ID)) {
          map.addLayer({
            id: GEOMETRY_FILL_LAYER_ID,
            type: "fill",
            source: GEOMETRIES_SOURCE_ID,
            filter: ["==", ["get", "geometryKind"], "surface"],
            paint: {
              "fill-color": ["case", ["boolean", ["get", "selected"], false], "#45C5C5", "#45C5C5"],
              "fill-opacity": ["case", ["boolean", ["get", "selected"], false], 0.38, 0.23],
              "fill-antialias": true,
            },
          }, firstSymbolLayer?.id);
        }
        if (!map.getLayer(GEOMETRY_OUTLINE_LAYER_ID)) {
          map.addLayer({
            id: GEOMETRY_OUTLINE_LAYER_ID,
            type: "line",
            source: GEOMETRIES_SOURCE_ID,
            filter: ["==", ["get", "geometryKind"], "surface"],
            paint: {
              "line-color": ["case", ["boolean", ["get", "selected"], false], "#C2E812", "#134F8A"],
              "line-width": ["case", ["boolean", ["get", "selected"], false], 4, 2.5],
              "line-opacity": 0.98,
            },
          }, firstSymbolLayer?.id);
        }
        if (!map.getLayer(GEOMETRY_LINE_LAYER_ID)) {
          map.addLayer({
            id: GEOMETRY_LINE_LAYER_ID,
            type: "line",
            source: GEOMETRIES_SOURCE_ID,
            filter: ["==", ["get", "geometryKind"], "line"],
            paint: {
              "line-color": ["case", ["boolean", ["get", "selected"], false], "#C2E812", "#134F8A"],
              "line-width": ["case", ["boolean", ["get", "selected"], false], 4, 3],
              "line-opacity": 0.98,
            },
          }, firstSymbolLayer?.id);
        }
        if (!map.getLayer(GEOMETRY_POINT_LAYER_ID)) {
          map.addLayer({
            id: GEOMETRY_POINT_LAYER_ID,
            type: "circle",
            source: GEOMETRIES_SOURCE_ID,
            filter: ["==", ["get", "geometryKind"], "point"],
            paint: {
              "circle-radius": ["case", ["boolean", ["get", "selected"], false], 8, 6],
              "circle-color": ["case", ["boolean", ["get", "selected"], false], "#C2E812", "#134F8A"],
              "circle-stroke-color": ["case", ["boolean", ["get", "selected"], false], "#05294C", "#ffffff"],
              "circle-stroke-width": 2,
            },
          }, firstSymbolLayer?.id);
        }
        if (!map.getLayer(HILLSHADE_LAYER_ID)) {
          map.addLayer({
            id: HILLSHADE_LAYER_ID,
            type: "hillshade",
            source: TERRAIN_SOURCE_ID,
            paint: {
              "hillshade-exaggeration": 0.28,
              "hillshade-shadow-color": themeRef.current === "dark" ? "#17212c" : "#394637",
              "hillshade-highlight-color": themeRef.current === "dark" ? "#d4d2c2" : "#f4f1df",
              "hillshade-illumination-direction": EXPLORATION_TERRAIN.sunAzimuthDegrees,
              "hillshade-illumination-anchor": "map",
            },
          }, map.getLayer(GEOMETRY_FILL_LAYER_ID)?.id ?? firstSymbolLayer?.id);
        }
        map.resize();
        setLoadError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "No se pudo activar el terreno 3D.";
        setLoadError(message);
      }
    };

    const readCamera = (): Terrain3DCamera => {
      const mapCenter = map.getCenter();
      return {
        center: [mapCenter.lng, mapCenter.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
    };
    const locateElement = (element: DrawnElement) => {
      const bounds = geometryBounds(element);
      if (!bounds) return;
      const currentBearing = map.getBearing();
      const currentPitch = map.getPitch();
      if (element.geometryType === "Point" && element.geoJsonPoint) {
        map.flyTo({
          center: element.geoJsonPoint.coordinates as [number, number],
          zoom: Math.min(14, Math.max(11, map.getZoom())),
          bearing: currentBearing,
          pitch: currentPitch,
          duration: 650,
        });
        return;
      }
      map.fitBounds(bounds, {
        padding: 92,
        maxZoom: 14,
        bearing: currentBearing,
        pitch: currentPitch,
        duration: 650,
      });
    };
    const handleGeometryClick = (event: MapMouseEvent) => {
      if (!map.isStyleLoaded() || GEOMETRY_LAYER_IDS.some((id) => !map.getLayer(id))) return;
      const hits = map.queryRenderedFeatures(event.point, { layers: GEOMETRY_LAYER_IDS });
      const hitIds = new Set(hits.map((feature) => String(feature.properties?.elementId ?? feature.id ?? "")));
      if (hitIds.size === 0) return;
      const priority = (element: DrawnElement) => element.geometryType === "Point" ? 0 : element.geometryType === "LineString" ? 1 : 2;
      const order = new Map(elementsRef.current.map((element, index) => [element.id, index]));
      const target = elementsRef.current
        .filter((element) => hitIds.has(element.id))
        .sort((a, b) => priority(a) - priority(b) || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0))[0];
      if (target) onSelectElementRef.current(target.id);
    };
    onCameraReaderChange(readCamera);
    onLocateElementReaderChange(locateElement);

    const handleMoveEnd = () => {
      updateVisibleTerrain();
      onCameraChange(readCamera());
    };
    const handleError = (event: MapLibreErrorEvent) => {
      const message = event.error.message || "No se pudo cargar la cartografía o el relieve 3D.";
      const sourceId = (event as MapLibreErrorEvent & { sourceId?: string }).sourceId;
      // MapLibre aborts requests that are no longer visible after a pan, zoom, or style change.
      // Those cancellations are expected and should not be shown as terrain failures.
      if ((event.error as Error & { name?: string }).name === "AbortError" || /signal is aborted|aborterror/i.test(message)) return;
      if (sourceId === TERRAIN_SOURCE_ID || /webgl|context/i.test(message)) {
        setLoadError(message);
      }
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      const message = "Se perdió el contexto gráfico WebGL. Vuelve a 2D y prueba de nuevo.";
      setLoadError(message);
    };
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    map.on("style.load", applyTerrain);
    map.on("click", handleGeometryClick);
    map.on("moveend", handleMoveEnd);
    map.on("error", handleError);
    map.getCanvas().addEventListener("webglcontextlost", handleContextLost);
    map.once("load", handleMoveEnd);

    return () => {
      resizeObserver.disconnect();
      unsubscribeTerrainTiles();
      map.off("style.load", applyTerrain);
      map.off("click", handleGeometryClick);
      map.off("moveend", handleMoveEnd);
      map.off("error", handleError);
      map.getCanvas().removeEventListener("webglcontextlost", handleContextLost);
      onCameraReaderChange(null);
      onLocateElementReaderChange(null);
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [onCameraChange, onCameraReaderChange, onLocateElementReaderChange]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const source = map.getSource(GEOMETRIES_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(geometryCollectionRef.current);
  }, [geometryCollection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (!map.getSource(TERRAIN_SOURCE_ID)) return;
    try {
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo ajustar la exageración vertical.";
      setLoadError(message);
    }
  }, [exaggeration]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer(HILLSHADE_LAYER_ID)) return;
    map.setPaintProperty(HILLSHADE_LAYER_ID, "hillshade-shadow-color", theme === "dark" ? "#17212c" : "#394637");
    map.setPaintProperty(HILLSHADE_LAYER_ID, "hillshade-highlight-color", theme === "dark" ? "#d4d2c2" : "#f4f1df");
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || currentStyleRef.current === styleId) return;
    currentStyleRef.current = styleId;
    map.setStyle(terrainStyleUrl(styleId));
  }, [styleId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || navigationRevision === 0) return;
    const target = navigationRef.current;
    map.flyTo({
      center: target.center,
      zoom: Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, target.zoom)),
      bearing: target.bearing,
      pitch: Math.max(MIN_MAP_PITCH, Math.min(MAX_MAP_PITCH, target.pitch)),
      essential: true,
    });
  }, [navigationRevision]);

  const resetCamera = () => {
    mapRef.current?.easeTo({ bearing: 0, pitch: 58, duration: 500 });
  };

  return (
    <>
      <div ref={containerRef} className="terrain-3d-canvas" role="application" aria-label="Terreno 3D interactivo" />
      <div className="terrain-3d-toolbar" data-theme={theme}>
        <label className="terrain-3d-style-control">
          <span>Mapa 3D</span>
          <select value={styleId} onChange={(event) => {
            const nextStyle = event.currentTarget.value;
            if (isOpenFreeMapId(nextStyle)) onStyleChange(nextStyle);
          }} aria-label="Estilo cartográfico 3D">
            <option value="positron">Minimalista</option>
            <option value="liberty">Detallado</option>
            <option value="dark">Oscuro</option>
          </select>
        </label>
        <details className="terrain-3d-settings">
          <summary>Ajustes</summary>
          <label htmlFor="terrain-3d-exaggeration">Exageración vertical · {exaggeration.toFixed(1)}×</label>
          <input
            id="terrain-3d-exaggeration"
            type="range"
            min="0.5"
            max="2.5"
            step="0.1"
            value={exaggeration}
            onChange={(event) => onExaggerationChange(Number(event.currentTarget.value))}
          />
          <span>Solo cambia la representación visual.</span>
        </details>
        <button type="button" className="terrain-3d-reset" onClick={resetCamera} title="Restablecer norte y perspectiva">
          <Compass size={15} aria-hidden="true" /> Norte y perspectiva
        </button>
      </div>
      <div className={`terrain-3d-status${loadError ? " terrain-3d-status--warning" : ""}`} role={loadError ? "status" : "status"} aria-live="polite">
        {terrainTiles.available === 0 && !loadError && <LoaderCircle size={14} className="spinner" aria-hidden="true" />}
        {loadError ? <span>{loadError}</span> : terrainTiles.available > 0 ? (
          <span><Mountain size={14} aria-hidden="true" /> Relieve 3D activo{terrainTiles.missing > 0 ? " · cobertura parcial" : ""}</span>
        ) : <span><Mountain size={14} aria-hidden="true" /> Cargando relieve…</span>}
      </div>
    </>
  );
}
