import { useEffect, useRef, useState } from "react";
import Feature from "ol/Feature.js";
import type Map from "ol/Map.js";
import Attribution from "ol/control/Attribution.js";
import ScaleLine from "ol/control/ScaleLine.js";
import { defaults as defaultControls } from "ol/control/defaults.js";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj.js";
import OSM from "ol/source/OSM.js";
import ImageTileSource from "ol/source/ImageTile.js";
import ImageWMS from "ol/source/ImageWMS.js";
import type DataTile from "ol/DataTile.js";
import type { TileSourceEvent } from "ol/source/Tile.js";
import OlMap from "ol/Map.js";
import LayerGroup from "ol/layer/Group.js";
import WebGLTileLayer from "ol/layer/WebGLTile.js";
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
import {
  ABSOLUTE_ELEVATION_MAX_M,
  ABSOLUTE_ELEVATION_MIN_M,
  ABSOLUTE_ELEVATION_STOPS,
  ADAPTIVE_LAND_STOPS,
  EXPLORATION_TERRAIN,
  OCEAN_ELEVATION_STOPS,
  absoluteElevationScale,
  adaptiveElevationScale,
  type ExplorationElevationMode,
  type ExplorationElevationScale,
  type ExplorationTerrainStatus,
} from "@/lib/exploration-terrain";

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
  explorationTerrain: WebGLTileLayer | null;
  regionalTerrains: LayerGroup;
};
type RegionalTerrainLayerGroup = {
  group: LayerGroup;
  layers: Partial<Record<TopographicLayerId, ImageLayer<ImageWMS>>>;
  geometry: Polygon;
  layerNamesKey: string;
  cleanup: () => void;
};
export type QgisStatus = "idle" | "loading" | "available" | "error";
type VectorTileListenerCleanup = () => void;

function supportsWebGL(): boolean {
  if (typeof document === "undefined") return false;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl");
  if (!context) return false;
  (context as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}

function colorChannel(color: string, channel: number): number {
  return Number.parseInt(color.slice(1 + channel * 2, 3 + channel * 2), 16);
}

function interpolateChannel(input: unknown[], stops: Array<{ value: number; color: string }>, channel: number) {
  return [
    "interpolate",
    ["linear"],
    input,
    ...stops.flatMap((stop) => [stop.value, colorChannel(stop.color, channel)]),
  ];
}

function createShadedReliefStyle() {
  const elevation = (xOffset: number, yOffset: number) => [
    "+",
    ["*", 255 * 256, ["band", 1, xOffset, yOffset]],
    ["*", 255, ["band", 2, xOffset, yOffset]],
    ["*", 255 / 256, ["band", 3, xOffset, yOffset]],
    -32768,
  ];
  const pixelDistance = ["*", 2, ["var", "groundResolution"]];
  const z0x = ["*", ["var", "verticalExaggeration"], elevation(-1, 0)];
  const z1x = ["*", ["var", "verticalExaggeration"], elevation(1, 0)];
  const dzdx = ["/", ["-", z1x, z0x], pixelDistance];
  const z0y = ["*", ["var", "verticalExaggeration"], elevation(0, -1)];
  const z1y = ["*", ["var", "verticalExaggeration"], elevation(0, 1)];
  const dzdy = ["/", ["-", z1y, z0y], pixelDistance];
  const slope = ["atan", ["sqrt", ["+", ["^", dzdx, 2], ["^", dzdy, 2]]]];
  const aspect = ["clamp", ["atan", ["-", 0, dzdx], dzdy], -Math.PI, Math.PI];
  const sunElevation = ["*", Math.PI / 180, ["var", "sunElevation"]];
  const sunAzimuth = ["*", Math.PI / 180, ["var", "sunAzimuth"]];
  const incidence = [
    "+",
    ["*", ["sin", sunElevation], ["cos", slope]],
    ["*", ["cos", sunElevation], ["sin", slope], ["cos", ["-", sunAzimuth, aspect]]],
  ];
  const landElevation = ["clamp", elevation(0, 0), 0, ABSOLUTE_ELEVATION_MAX_M];
  const oceanElevation = ["clamp", elevation(0, 0), ABSOLUTE_ELEVATION_MIN_M, 0];
  const adaptiveElevation = [
    "clamp",
    ["/", ["-", landElevation, ["var", "adaptiveMin"]], ["-", ["var", "adaptiveMax"], ["var", "adaptiveMin"]]],
    0,
    1,
  ];
  const oceanColor = [0, 1, 2].map((channel) => interpolateChannel(
    oceanElevation,
    OCEAN_ELEVATION_STOPS.map((stop) => ({ value: stop.valueM, color: stop.color })),
    channel,
  ));
  const absoluteLandColor = [0, 1, 2].map((channel) => interpolateChannel(
    landElevation,
    ABSOLUTE_ELEVATION_STOPS.map((stop) => ({ value: stop.valueM, color: stop.color })),
    channel,
  ));
  const adaptiveLandColor = [0, 1, 2].map((channel) => interpolateChannel(
    adaptiveElevation,
    ADAPTIVE_LAND_STOPS.map((stop) => ({ value: stop.position, color: stop.color })),
    channel,
  ));
  const landColor = [0, 1, 2].map((channel) => [
    "case",
    [">", ["var", "adaptiveScale"], 0.5],
    adaptiveLandColor[channel],
    absoluteLandColor[channel],
  ]);
  const elevationColor = [0, 1, 2].map((channel) => [
    "case",
    [">=", elevation(0, 0), 0],
    landColor[channel],
    oceanColor[channel],
  ]);
  const shadeAmount = ["*", ["var", "showHillshade"], ["var", "hillshadeOpacity"]];
  const elevationAmount = ["*", ["var", "showElevation"], ["var", "elevationOpacity"]];
  const lightFactor = ["clamp", ["+", 0.9, ["*", 0.25, incidence]], 0.72, 1.12];
  const terrainLighting = ["+", 1, ["*", shadeAmount, ["-", lightFactor, 1]]];
  const shadedElevationColor = elevationColor.map((channel) => ["clamp", ["*", channel, terrainLighting], 0, 255]);
  const grayHillshade = ["clamp", ["*", 255, incidence], 0, 255];
  const colorizedTerrain = [">", elevationAmount, 0];
  const tileAlpha = ["band", 4];
  const outputAlpha = ["*", tileAlpha, ["case", colorizedTerrain, elevationAmount, shadeAmount]];
  const colorizedOutput = ["color", ...shadedElevationColor, outputAlpha];
  const shadedOutput = ["color", grayHillshade, outputAlpha];

  return {
    variables: {
      groundResolution: 1,
      showHillshade: 1,
      showElevation: 1,
      hillshadeOpacity: EXPLORATION_TERRAIN.defaultHillshadeOpacity / 100,
      elevationOpacity: EXPLORATION_TERRAIN.defaultElevationOpacity / 100,
      adaptiveScale: 0,
      adaptiveMin: 0,
      adaptiveMax: EXPLORATION_TERRAIN.minimumDisplayRangeM,
      verticalExaggeration: EXPLORATION_TERRAIN.verticalExaggeration,
      sunElevation: EXPLORATION_TERRAIN.sunElevationDegrees,
      sunAzimuth: EXPLORATION_TERRAIN.sunAzimuthDegrees,
    },
    color: ["case", colorizedTerrain, colorizedOutput, shadedOutput],
  };
}

function sampleTerrariumTile(tile: DataTile): Float32Array | null {
  const image = tile.getData();
  if (!image) return null;
  const dimensions = image as unknown as CanvasImageSource & {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
  };
  const width = dimensions.naturalWidth || dimensions.videoWidth || dimensions.width || 0;
  const height = dimensions.naturalHeight || dimensions.videoHeight || dimensions.height || 0;
  if (!width || !height) return null;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(dimensions, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const axis = EXPLORATION_TERRAIN.samplesPerTileAxis;
    const samples = new Float32Array(axis * axis);
    let count = 0;
    for (let row = 0; row < axis; row += 1) {
      const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / axis));
      for (let column = 0; column < axis; column += 1) {
        const x = Math.min(width - 1, Math.floor(((column + 0.5) * width) / axis));
        const offset = (y * width + x) * 4;
        if (pixels[offset + 3] < 16) continue;
        samples[count] = pixels[offset] * 256 + pixels[offset + 1] + pixels[offset + 2] / 256 - 32768;
        count += 1;
      }
    }
    return samples.slice(0, count);
  } catch {
    // Cross-origin, tainted or unsupported images keep the absolute fallback available.
    return null;
  }
}

function wrappedTileX(x: number, zoom: number): number {
  const worldSize = 2 ** zoom;
  return ((x % worldSize) + worldSize) % worldSize;
}

type MapViewProps = {
  baseMap: BaseMapId;
  mapRef: MutableRef<Map | null>;
  baseLayersRef: MutableRef<BaseMapLayers | null>;
  drawingsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  measurementsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  preparedTerrains: PreparedTerrainMapEntry[];
  explorationTerrainEnabled: boolean;
  explorationTerrainOpacity: number;
  explorationElevationEnabled: boolean;
  explorationElevationOpacity: number;
  explorationElevationMode: ExplorationElevationMode;
  explorationElevationScale: ExplorationElevationScale;
  explorationElevationScaleRefresh: number;
  regionalHillshadeVisible: boolean;
  onStatusChange: (status: MapStatus) => void;
  onQgisStatusChange: (status: QgisStatus) => void;
  onOpenFreeMapStatusChange: (id: OpenFreeMapId, status: OpenFreeMapStatus) => void;
  onOverlayAvailabilityChange: (id: GeographicOverlayId, available: boolean) => void;
  onTopographicAvailabilityChange: (id: TopographicLayerId, available: boolean) => void;
  onExplorationTerrainStatusChange: (status: ExplorationTerrainStatus) => void;
  onExplorationTerrainVisibilityChange: (visible: boolean) => void;
  onExplorationElevationScaleChange: (scale: ExplorationElevationScale) => void;
  onPreparedTerrainAvailabilityChange: (elementId: string, id: TopographicLayerId, available: boolean) => void;
  onMapReady: (map: Map) => (() => void) | void;
  onCenterChange: (
    center: [number, number],
    extent: [number, number, number, number],
    resolution: number,
    zoom: number,
  ) => void;
};

export default function MapView({
  baseMap,
  mapRef,
  baseLayersRef,
  drawingsLayer,
  measurementsLayer,
  preparedTerrains,
  explorationTerrainEnabled,
  explorationTerrainOpacity,
  explorationElevationEnabled,
  explorationElevationOpacity,
  explorationElevationMode,
  explorationElevationScale,
  explorationElevationScaleRefresh,
  regionalHillshadeVisible,
  onStatusChange,
  onQgisStatusChange,
  onOpenFreeMapStatusChange,
  onOverlayAvailabilityChange,
  onTopographicAvailabilityChange,
  onExplorationTerrainStatusChange,
  onExplorationTerrainVisibilityChange,
  onExplorationElevationScaleChange,
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
  const explorationStatusRef = useRef(onExplorationTerrainStatusChange);
  const explorationVisibilityRef = useRef(onExplorationTerrainVisibilityChange);
  const explorationTerrainRef = useRef<WebGLTileLayer | null>(null);
  const explorationHasLoadedRef = useRef(false);
  const explorationHasErrorRef = useRef(false);
  const explorationEnabledRef = useRef(explorationTerrainEnabled);
  const explorationOpacityRef = useRef(explorationTerrainOpacity);
  const explorationElevationEnabledRef = useRef(explorationElevationEnabled);
  const explorationElevationOpacityRef = useRef(explorationElevationOpacity);
  const explorationElevationModeRef = useRef(explorationElevationMode);
  const explorationElevationScaleRef = useRef(explorationElevationScale);
  const explorationScaleChangeRef = useRef(onExplorationElevationScaleChange);
  const regionalHillshadeRef = useRef(regionalHillshadeVisible);
  const mapZoomRef = useRef<number | null>(null);
  const updateExplorationRef = useRef<((zoom: number, latitude: number, resolution: number) => void) | null>(null);
  const scheduleElevationScaleRef = useRef<(() => void) | null>(null);
  const activeBaseMapRef = useRef<BaseMapId | null>(null);
  const disposedRef = useRef(false);
  baseMapRef.current = baseMap;
  preparedAvailabilityRef.current = onPreparedTerrainAvailabilityChange;
  explorationStatusRef.current = onExplorationTerrainStatusChange;
  explorationVisibilityRef.current = onExplorationTerrainVisibilityChange;
  explorationScaleChangeRef.current = onExplorationElevationScaleChange;
  explorationEnabledRef.current = explorationTerrainEnabled;
  explorationOpacityRef.current = explorationTerrainOpacity;
  explorationElevationEnabledRef.current = explorationElevationEnabled;
  explorationElevationOpacityRef.current = explorationElevationOpacity;
  explorationElevationModeRef.current = explorationElevationMode;
  explorationElevationScaleRef.current = explorationElevationScale;
  regionalHillshadeRef.current = regionalHillshadeVisible;

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
    const webglAvailable = supportsWebGL();
    const explorationSource = webglAvailable
      ? new ImageTileSource({
        url: EXPLORATION_TERRAIN.url,
        crossOrigin: "anonymous",
        maxZoom: EXPLORATION_TERRAIN.maxDataZoom,
        wrapX: true,
        transition: 180,
        interpolate: true,
        attributions: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">Mapzen Terrain Tiles · fuentes y atribución</a>',
      })
      : null;
    const explorationLayer = explorationSource
      ? new WebGLTileLayer({
        source: explorationSource,
        style: createShadedReliefStyle(),
        visible: false,
        opacity: 1,
        minZoom: EXPLORATION_TERRAIN.mapMinimumZoom - 0.001,
        cacheSize: EXPLORATION_TERRAIN.cacheSize,
        preload: 0,
        zIndex: 3,
      })
      : null;
    explorationTerrainRef.current = explorationLayer;
    explorationHasLoadedRef.current = false;
    explorationHasErrorRef.current = false;
    if (!explorationLayer) explorationStatusRef.current("unavailable");
    const regionalTerrains = new LayerGroup({ layers: [] });
    const map = new OlMap({
      target: targetRef.current,
      pixelRatio: window.devicePixelRatio || 1,
      layers: [
        osmLayer,
        qgisLayer,
        ...Object.values(vectorBaseMapLayers),
        ...(explorationLayer ? [explorationLayer] : []),
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
        center: fromLonLat([-4.6, 37.55]),
        zoom: 8.2,
        minZoom: EXPLORATION_TERRAIN.mapMinimumZoom,
        maxZoom: 19,
        enableRotation: false,
      }),
    });

    const sampledTiles = new globalThis.Map<string, Float32Array>();
    let elevationScaleTimer: ReturnType<typeof setTimeout> | undefined;
    let adaptiveCalculationPending = false;
    let adaptiveCalculationDeadline = 0;
    const updateExplorationStyle = (resolution: number, latitude: number) => {
      const layer = explorationTerrainRef.current;
      if (!layer) return;
      const scale = explorationElevationScaleRef.current;
      const isTopographicBasemap = activeBaseMapRef.current === "topographic";
      layer.updateStyleVariables({
        groundResolution: Math.max(0.1, resolution * Math.max(0.05, Math.cos((latitude * Math.PI) / 180))),
        showHillshade: isTopographicBasemap || explorationEnabledRef.current ? 1 : 0,
        showElevation: isTopographicBasemap || explorationElevationEnabledRef.current ? 1 : 0,
        hillshadeOpacity: explorationOpacityRef.current / 100,
        elevationOpacity: explorationElevationOpacityRef.current / 100,
        adaptiveScale: !isTopographicBasemap && scale.effectiveMode === "adaptive" ? 1 : 0,
        adaptiveMin: scale.minM,
        adaptiveMax: Math.max(scale.maxM, scale.minM + EXPLORATION_TERRAIN.minimumDisplayRangeM),
      });
    };
    const publishElevationScale = (scale: ExplorationElevationScale) => {
      const current = explorationElevationScaleRef.current;
      if (current.requestedMode === scale.requestedMode
        && current.effectiveMode === scale.effectiveMode
        && current.minM === scale.minM
        && current.maxM === scale.maxM
        && current.sampleCount === scale.sampleCount) return;
      explorationElevationScaleRef.current = scale;
      const center = map.getView().getCenter();
      const latitude = center ? toLonLat(center)[1] : 0;
      updateExplorationStyle(map.getView().getResolution() ?? 1, latitude);
      if (typeof explorationScaleChangeRef.current === "function") {
        explorationScaleChangeRef.current(scale);
      }
    };
    const getVisibleElevationSamples = () => {
      if (!explorationSource) return [] as number[];
      const view = map.getView();
      const size = map.getSize();
      const resolution = view.getResolution();
      if (!size || !resolution) return [] as number[];
      const grid = explorationSource.getTileGridForProjection(view.getProjection());
      const zoom = grid.getZForResolution(resolution);
      const extent = view.calculateExtent(size);
      const range = grid.getTileRangeForExtentAndZ(extent, zoom);
      const coordinates: Array<[number, number, number]> = [];
      for (let y = range.minY; y <= range.maxY; y += 1) {
        for (let x = range.minX; x <= range.maxX; x += 1) {
          coordinates.push([zoom, wrappedTileX(x, zoom), y]);
        }
      }
      const maximumVisibleTiles = EXPLORATION_TERRAIN.sampleCacheSize;
      const stride = Math.max(1, Math.ceil(coordinates.length / maximumVisibleTiles));
      const values: number[] = [];
      for (let index = 0; index < coordinates.length && values.length < maximumVisibleTiles * EXPLORATION_TERRAIN.samplesPerTileAxis ** 2; index += stride) {
        const samples = sampledTiles.get(coordinates[index].join("/"));
        if (!samples) continue;
        for (let sample = 0; sample < samples.length; sample += 1) values.push(samples[sample]);
      }
      return values;
    };
    const scheduleAdaptiveScaleAttempt = () => {
      if (!adaptiveCalculationPending) return;
      if (elevationScaleTimer) clearTimeout(elevationScaleTimer);
      elevationScaleTimer = setTimeout(() => {
        if (!adaptiveCalculationPending) return;
        const view = map.getView();
        if (view.getAnimating() || view.getInteracting()) {
          scheduleAdaptiveScaleAttempt();
          return;
        }
        const values = getVisibleElevationSamples();
        const scale = adaptiveElevationScale(values);
        if (scale) {
          adaptiveCalculationPending = false;
          publishElevationScale(scale);
          return;
        }
        if (Date.now() < adaptiveCalculationDeadline) {
          scheduleAdaptiveScaleAttempt();
          return;
        }
        adaptiveCalculationPending = false;
        publishElevationScale(absoluteElevationScale("adaptive", values.length));
      }, EXPLORATION_TERRAIN.sampleSettleDelayMs);
    };
    const requestElevationScaleUpdate = () => {
      if (activeBaseMapRef.current === "topographic") {
        adaptiveCalculationPending = false;
        if (elevationScaleTimer) clearTimeout(elevationScaleTimer);
        return;
      }
      if (explorationElevationModeRef.current === "absolute") {
        adaptiveCalculationPending = false;
        if (elevationScaleTimer) clearTimeout(elevationScaleTimer);
        publishElevationScale(absoluteElevationScale("absolute"));
        return;
      }
      adaptiveCalculationPending = true;
      adaptiveCalculationDeadline = Date.now() + EXPLORATION_TERRAIN.adaptiveCalculationTimeoutMs;
      scheduleAdaptiveScaleAttempt();
    };
    const sampleLoadedTile = (event: TileSourceEvent) => {
      const tile = event.tile as DataTile;
      const coordinate = tile.getTileCoord();
      const samples = sampleTerrariumTile(tile);
      if (samples) {
        const key = [coordinate[0], wrappedTileX(coordinate[1], coordinate[0]), coordinate[2]].join("/");
        sampledTiles.delete(key);
        sampledTiles.set(key, samples);
        while (sampledTiles.size > EXPLORATION_TERRAIN.sampleCacheSize) {
          const oldestKey = sampledTiles.keys().next().value;
          if (oldestKey === undefined) break;
          sampledTiles.delete(oldestKey);
        }
      }
      if (adaptiveCalculationPending) scheduleAdaptiveScaleAttempt();
    };
    const scaleTileFailed = () => {
      if (adaptiveCalculationPending) scheduleAdaptiveScaleAttempt();
    };
    explorationSource?.on("tileloadend", sampleLoadedTile);
    explorationSource?.on("tileloaderror", scaleTileFailed);
    requestElevationScaleUpdate();

    const updateExplorationVisibility = (zoom: number, latitude: number, resolution: number) => {
      const layer = explorationTerrainRef.current;
      const hasWebGL = layer !== null;
      const isTopographicBasemap = activeBaseMapRef.current === "topographic";
      const minimumZoom = isTopographicBasemap
        ? EXPLORATION_TERRAIN.topographicBasemapMinZoom
        : EXPLORATION_TERRAIN.overlayMinZoom;
      const scaleReady = zoom >= minimumZoom;
      const blockedByRegionalRelief = regionalHillshadeRef.current && !isTopographicBasemap;
      const hillshadeEnabled = isTopographicBasemap || explorationEnabledRef.current;
      const elevationEnabled = isTopographicBasemap || explorationElevationEnabledRef.current;
      const visible = Boolean(
        layer
        && (hillshadeEnabled || elevationEnabled)
        && scaleReady
        && !blockedByRegionalRelief,
      );
      if (layer) {
        layer.setVisible(visible);
        updateExplorationStyle(resolution, latitude);
      }
      if (typeof explorationVisibilityRef.current === "function") {
        explorationVisibilityRef.current(visible && hillshadeEnabled);
      }
      if (!hasWebGL) explorationStatusRef.current?.("unavailable");
      else if (!hillshadeEnabled && !elevationEnabled) explorationStatusRef.current?.("disabled");
      else if (blockedByRegionalRelief) explorationStatusRef.current?.("regional-priority");
      else if (!scaleReady) explorationStatusRef.current?.("scale");
      else if (explorationHasErrorRef.current) explorationStatusRef.current?.("error");
      else if (explorationHasLoadedRef.current) {
        explorationStatusRef.current?.(zoom > EXPLORATION_TERRAIN.maxDataZoom ? "overzoom" : "active");
      } else explorationStatusRef.current?.("loading");
    };
    updateExplorationRef.current = updateExplorationVisibility;
    scheduleElevationScaleRef.current = requestElevationScaleUpdate;
    const explorationTileStarted = () => {
      if (explorationLayer?.getVisible() && !explorationHasLoadedRef.current) {
        explorationStatusRef.current?.("loading");
      }
    };
    const explorationTileLoaded = () => {
      explorationHasLoadedRef.current = true;
      explorationHasErrorRef.current = false;
      if (!explorationLayer?.getVisible()) return;
      const zoom = mapZoomRef.current ?? EXPLORATION_TERRAIN.mapMinimumZoom;
      explorationStatusRef.current?.(zoom > EXPLORATION_TERRAIN.maxDataZoom ? "overzoom" : "active");
    };
    const explorationTileFailed = () => {
      if (!explorationLayer?.getVisible()) return;
      explorationHasErrorRef.current = true;
      explorationStatusRef.current?.("error");
    };
    explorationSource?.on("tileloadstart", explorationTileStarted);
    explorationSource?.on("tileloadend", explorationTileLoaded);
    explorationSource?.on("tileloaderror", explorationTileFailed);

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
      explorationTerrain: explorationLayer,
      regionalTerrains,
    };
    setMapGeneration((generation) => generation + 1);
    const updateCenter = () => {
      const center = map.getView().getCenter();
      if (!center) return;
      const [longitude, latitude] = toLonLat(center);
      const zoom = map.getView().getZoom() ?? 0;
      const size = map.getSize();
      const extent = size
        ? transformExtent(map.getView().calculateExtent(size), "EPSG:3857", "EPSG:4326") as [number, number, number, number]
        : [longitude, latitude, longitude, latitude] as [number, number, number, number];
      const resolution = map.getView().getResolution() ?? 0;
      mapZoomRef.current = zoom;
      updateExplorationVisibility(zoom, latitude, resolution);
      onCenterChange([longitude, latitude], extent, resolution, zoom);
      if (adaptiveCalculationPending) scheduleAdaptiveScaleAttempt();
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
      explorationSource?.un("tileloadstart", explorationTileStarted);
      explorationSource?.un("tileloadend", explorationTileLoaded);
      explorationSource?.un("tileloaderror", explorationTileFailed);
      explorationSource?.un("tileloadend", sampleLoadedTile);
      explorationSource?.un("tileloaderror", scaleTileFailed);
      if (elevationScaleTimer) clearTimeout(elevationScaleTimer);
      adaptiveCalculationPending = false;
      sampledTiles.clear();
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
      explorationTerrainRef.current = null;
      updateExplorationRef.current = null;
      scheduleElevationScaleRef.current = null;
    };
  }, [baseLayersRef, drawingsLayer, mapRef, measurementsLayer, onCenterChange, onMapReady, onOverlayAvailabilityChange, onQgisStatusChange, onStatusChange, onTopographicAvailabilityChange]);

  useEffect(() => {
    const view = mapRef.current?.getView();
    if (!view) return;
    const center = view.getCenter();
    const latitude = center ? toLonLat(center)[1] : CRETE_CENTER[1];
    updateExplorationRef.current?.(
      view.getZoom() ?? 0,
      latitude,
      view.getResolution() ?? 1,
    );
    mapRef.current?.render();
  }, [explorationTerrainEnabled, explorationTerrainOpacity, explorationElevationEnabled, explorationElevationOpacity, explorationElevationMode, mapGeneration, regionalHillshadeVisible]);

  useEffect(() => {
    scheduleElevationScaleRef.current?.();
  }, [explorationElevationMode, explorationElevationScaleRefresh, mapGeneration]);

  useEffect(() => {
    const layers = baseLayersRef.current;
    if (!layers) return;

    const activate = (id: BaseMapId, forceOsmUnderlay = false) => {
      const styleId: OpenFreeMapId | null = id === "topographic"
        ? "positron"
        : id === "osm" || id === "qgis" ? null : id;
      const useVectorUnderlay = Boolean(styleId && vectorLoadedRef.current.has(styleId) && !forceOsmUnderlay);
      layers.osm.setVisible(id === "osm" || (id === "topographic" && !useVectorUnderlay));
      layers.qgis.setVisible(id === "qgis");
      (Object.keys(layers.vector) as OpenFreeMapId[]).forEach((vectorId) => {
        layers.vector[vectorId].setVisible(vectorId === styleId && useVectorUnderlay);
      });
      activeBaseMapRef.current = id;
      const view = mapRef.current?.getView();
      const center = view?.getCenter();
      if (view) {
        updateExplorationRef.current?.(
          view.getZoom() ?? 0,
          center ? toLonLat(center)[1] : 0,
          view.getResolution() ?? 1,
        );
      }
      mapRef.current?.render();
    };

    if (baseMap === "osm" || baseMap === "qgis") {
      activate(baseMap);
      return;
    }

    const styleId: OpenFreeMapId = baseMap === "topographic" ? "positron" : baseMap;
    const group = layers.vector[styleId];
    if (baseMap === "topographic") activate(baseMap);
    if (vectorLoadedRef.current.has(styleId)) {
      activate(baseMap);
      onOpenFreeMapStatusChange(styleId, "available");
      return;
    }

    onOpenFreeMapStatusChange(styleId, "loading");
    if (vectorPromisesRef.current.has(styleId)) return;

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
            const isActiveBackground = activeBaseMapRef.current === styleId
              || (styleId === "positron" && activeBaseMapRef.current === "topographic");
            if (isActiveBackground) {
              onOpenFreeMapStatusChange(styleId, "available");
              if (activeBaseMapRef.current === "topographic") activate("topographic");
            }
          };
          const onError = () => {
            failedTiles += 1;
            if (errorTimer) return;
            errorTimer = setTimeout(() => {
              errorTimer = undefined;
              const isActiveBackground = activeBaseMapRef.current === styleId
                || (styleId === "positron" && activeBaseMapRef.current === "topographic");
              if (failedTiles > 0 && isActiveBackground) {
                onOpenFreeMapStatusChange(styleId, "error");
                if (activeBaseMapRef.current === "topographic") activate("topographic", true);
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
        if (baseMapRef.current === baseMap) activate(baseMap);
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
        if (!disposedRef.current) {
          onOpenFreeMapStatusChange(styleId, "error");
          if (baseMapRef.current === "topographic") activate("topographic", true);
        }
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
      const layerNamesKey = Object.entries(terrain.result.cartography.layers)
        .filter(([, layerName]) => Boolean(layerName))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, layerName]) => `${id}:${layerName}`)
        .join("|");
      const needsRebuild = !layerGroup
        || layerGroup.geometry !== terrain.geometry
        || layerGroup.layerNamesKey !== layerNamesKey;
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
          layerNamesKey,
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
