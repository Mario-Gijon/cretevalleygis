import { useEffect, useRef, useState } from "react";
import type Feature from "ol/Feature.js";
import type Map from "ol/Map.js";
import Attribution from "ol/control/Attribution.js";
import ScaleLine from "ol/control/ScaleLine.js";
import { defaults as defaultControls } from "ol/control/defaults.js";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj.js";
import OSM from "ol/source/OSM.js";
import type DataTileSource from "ol/source/DataTile.js";
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
import View from "ol/View.js";
import {
  OPEN_FREE_MAP_ATTRIBUTION_HTML,
  OPEN_FREE_MAP_STYLES,
  isTerrainBaseMap,
  type BaseMapId,
  type OpenFreeMapId,
  type OpenFreeMapStatus,
} from "@/lib/base-maps";
import {
  BASE_MAP_WMS_LAYERS,
  GEOGRAPHIC_OVERLAYS,
  type GeographicOverlayId,
} from "@/lib/cartographic-layers";
import { CRETE_CENTER } from "@/lib/map-config";
import {
  ABSOLUTE_ELEVATION_MAX_M,
  ABSOLUTE_ELEVATION_MIN_M,
  ABSOLUTE_ELEVATION_STOPS,
  ADAPTIVE_LAND_STOPS,
  EXPLORATION_TERRAIN,
  ASPECT_CLASSES,
  ASPECT_FLAT_COLOR,
  SLOPE_CLASSES,
  OCEAN_ELEVATION_STOPS,
  absoluteElevationScale,
  adaptiveElevationScale,
  effectiveTerrainSourceZoom,
  terrainPixelGroundDistanceMeters,
  type ExplorationElevationMode,
  type ExplorationElevationScale,
  type ExplorationTerrainTheme,
  type ExplorationTerrainStatus,
} from "@/lib/exploration-terrain";
import { getSharedTerrariumDataTileSource, TERRARIUM_DATA_GUTTER } from "@/lib/terrarium-data-tile";

export type MapStatus = {
  ready: boolean;
  loading: boolean;
  error: boolean;
};

type MutableRef<T> = { current: T };

export type OverlayLayers = Record<GeographicOverlayId, ImageLayer<ImageWMS>>;
export type VectorBaseMapLayers = Record<OpenFreeMapId, LayerGroup>;
export type BaseMapLayers = {
  osm: TileLayer<OSM>;
  qgis: ImageLayer<ImageWMS>;
  vector: VectorBaseMapLayers;
  overlays: OverlayLayers;
  explorationTerrain: WebGLTileLayer | null;
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
  const elevation = (xOffset: number, yOffset: number) => ["band", 1, xOffset, yOffset];
  const pixelDistance = ["*", 2, ["var", "groundResolution"]];
  const z0x = ["*", ["var", "verticalExaggeration"], elevation(-1, 0)];
  const z1x = ["*", ["var", "verticalExaggeration"], elevation(1, 0)];
  const dzdx = ["/", ["-", z1x, z0x], pixelDistance];
  const z0y = ["*", ["var", "verticalExaggeration"], elevation(0, -1)];
  const z1y = ["*", ["var", "verticalExaggeration"], elevation(0, 1)];
  const dzdy = ["/", ["-", z1y, z0y], pixelDistance];
  // These derivatives use source-pixel ground distance and unexaggerated elevations.
  const terrainDzdx = ["/", ["-", elevation(1, 0), elevation(-1, 0)], pixelDistance];
  const terrainDzdy = ["/", ["-", elevation(0, 1), elevation(0, -1)], pixelDistance];
  const terrainSlopePercent = ["*", 100, ["sqrt", ["+", ["^", terrainDzdx, 2], ["^", terrainDzdy, 2]]]];
  // atan(y, x) is atan2. Signed degrees use 0° at north and increase clockwise.
  const terrainAspectDegrees = ["*", ["atan", ["-", 0, terrainDzdx], terrainDzdy], 180 / Math.PI];
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
  const channelValue = (color: string, channel: number) => colorChannel(color, channel);
  const slopeColor = [0, 1, 2].map((channel) => {
    let result: unknown[] | number = channelValue(SLOPE_CLASSES.at(-1)!.color, channel);
    for (let index = SLOPE_CLASSES.length - 2; index >= 0; index -= 1) {
      result = ["case", ["<=", terrainSlopePercent, SLOPE_CLASSES[index].maximumPercent], channelValue(SLOPE_CLASSES[index].color, channel), result];
    }
    return result;
  });
  const aspectColor = [0, 1, 2].map((channel) => {
    const colorForDirection = (direction: string) => channelValue(ASPECT_CLASSES.find((item) => item.direction === direction)!.color, channel);
    const north = colorForDirection("N");
    const northEast = colorForDirection("NE");
    const east = colorForDirection("E");
    const southEast = colorForDirection("SE");
    const south = colorForDirection("S");
    const southWest = colorForDirection("SO");
    const west = colorForDirection("O");
    const northWest = colorForDirection("NO");
    const flat = channelValue(ASPECT_FLAT_COLOR, channel);
    const sector = EXPLORATION_TERRAIN.aspectSectorHalfWidthDegrees;
    const positiveAspect: unknown[] = [
      "case", ["<=", terrainAspectDegrees, 3 * sector], northEast,
      ["case", ["<=", terrainAspectDegrees, 5 * sector], east,
        ["case", ["<=", terrainAspectDegrees, 7 * sector], southEast, south]],
    ];
    const negativeAspect: unknown[] = [
      "case", [">=", terrainAspectDegrees, -3 * sector], northWest,
      ["case", [">=", terrainAspectDegrees, -5 * sector], west,
        ["case", [">=", terrainAspectDegrees, -7 * sector], southWest, south]],
    ];
    return [
      "case",
      ["<=", terrainSlopePercent, EXPLORATION_TERRAIN.flatAspectThresholdPercent], flat,
      ["case", ["<=", ["abs", terrainAspectDegrees], sector], north,
        ["case", [">", terrainAspectDegrees, 0], positiveAspect, negativeAspect]],
    ];
  });
  const thematicColor = [0, 1, 2].map((channel) => [
    "case", [">", ["var", "showElevation"], 0.5], elevationColor[channel],
    ["case", [">", ["var", "showSlope"], 0.5], slopeColor[channel], aspectColor[channel]],
  ]);
  // Terrarium encodes elevation but no water mask. Require positive center and neighbor
  // elevations for derivatives; this conservatively removes bathymetry and low areas.
  const validDerivativeNeighbors = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]] as const;
  const derivativeValid = validDerivativeNeighbors.reduce<unknown>((valid, [x, y]) => [
    "case",
    ["<", ["band", 2, x, y], 0.99], 0,
    ["case", ["<=", elevation(x, y), 0], 0, valid],
  ], 1);
  const shadeAmount = ["*", ["var", "showHillshade"], ["var", "hillshadeOpacity"]];
  const themeOpacity = ["var", "themeOpacity"];
  const themeSelected = ["+", ["var", "showElevation"], ["var", "showSlope"], ["var", "showAspect"]];
  const themeAmount = ["*", ["case", [">", themeSelected, 0.5], 1, 0], themeOpacity];
  const lightFactor = ["clamp", ["+", 0.9, ["*", 0.25, incidence]], 0.72, 1.12];
  const terrainLighting = ["+", 1, ["*", shadeAmount, ["-", lightFactor, 1]]];
  const shadedThematicColor = thematicColor.map((channel) => ["clamp", ["*", channel, terrainLighting], 0, 255]);
  const grayHillshade = ["clamp", ["*", 255, incidence], 0, 255];
  const colorizedTerrain = [">", themeAmount, 0];
  const derivativeThemeValid = ["case", [">", ["var", "showElevation"], 0.5], 1, derivativeValid];
  const tileAlpha = ["band", 2];
  const outputAlpha = ["*", tileAlpha, ["case", colorizedTerrain,
    ["case", [">", derivativeThemeValid, 0.5], themeAmount, shadeAmount],
    shadeAmount,
  ]];
  const thematicOutputColor = shadedThematicColor.map((channel) => ["case", [">", derivativeThemeValid, 0.5], channel, grayHillshade]);
  const colorizedOutput = ["color", ...thematicOutputColor, outputAlpha];
  const shadedOutput = ["color", grayHillshade, outputAlpha];

  return {
    variables: {
      groundResolution: 1,
      showHillshade: 1,
      showElevation: 1,
      showSlope: 0,
      showAspect: 0,
      hillshadeOpacity: EXPLORATION_TERRAIN.defaultHillshadeOpacity / 100,
      themeOpacity: EXPLORATION_TERRAIN.defaultElevationOpacity / 100,
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
  const data = tile.getData();
  if (!(data instanceof Float32Array)) return null;
  const [width, height] = tile.getSize();
  const tileWidth = width + TERRARIUM_DATA_GUTTER * 2;
  const tileHeight = height + TERRARIUM_DATA_GUTTER * 2;
  if (data.length < tileWidth * tileHeight * 2) return null;
  const axis = EXPLORATION_TERRAIN.samplesPerTileAxis;
  const samples = new Float32Array(axis * axis);
  let count = 0;
  for (let row = 0; row < axis; row += 1) {
    const y = TERRARIUM_DATA_GUTTER + Math.min(height - 1, Math.floor(((row + 0.5) * height) / axis));
    for (let column = 0; column < axis; column += 1) {
      const x = TERRARIUM_DATA_GUTTER + Math.min(width - 1, Math.floor(((column + 0.5) * width) / axis));
      const offset = (y * tileWidth + x) * 2;
      if (data[offset + 1] < 0.99) continue;
      samples[count] = data[offset];
      count += 1;
    }
  }
  return samples.slice(0, count);
}

function wrappedTileX(x: number, zoom: number): number {
  const worldSize = 2 ** zoom;
  return ((x % worldSize) + worldSize) % worldSize;
}

function trimMapEntries<T>(entries: globalThis.Map<string, T>, maximumSize: number): void {
  while (entries.size > maximumSize) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) return;
    entries.delete(oldestKey);
  }
}

type MapViewProps = {
  active: boolean;
  center: [number, number];
  zoom: number;
  baseMap: BaseMapId;
  mapRef: MutableRef<Map | null>;
  baseLayersRef: MutableRef<BaseMapLayers | null>;
  drawingsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  measurementsLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  pointInspectorLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  placeSearchMarkerLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  elevationProfileMarkerLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  geometryBufferPreviewLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  geometryOperationPreviewLayer: VectorLayer<VectorSource<Feature<Geometry>>>;
  explorationTerrainEnabled: boolean;
  explorationTerrainOpacity: number;
  explorationTerrainTheme: ExplorationTerrainTheme;
  explorationThemeOpacity: number;
  explorationElevationMode: ExplorationElevationMode;
  explorationElevationScale: ExplorationElevationScale;
  explorationElevationScaleRefresh: number;
  onStatusChange: (status: MapStatus) => void;
  onQgisStatusChange: (status: QgisStatus) => void;
  onOpenFreeMapStatusChange: (id: OpenFreeMapId, status: OpenFreeMapStatus) => void;
  onOverlayAvailabilityChange: (id: GeographicOverlayId, available: boolean) => void;
  onExplorationTerrainStatusChange: (status: ExplorationTerrainStatus) => void;
  onExplorationElevationScaleChange: (scale: ExplorationElevationScale) => void;
  onMapReady: (map: Map) => (() => void) | void;
  onCenterChange: (
    center: [number, number],
    extent: [number, number, number, number],
    resolution: number,
    zoom: number,
  ) => void;
};

export default function MapView({
  active,
  center,
  zoom,
  baseMap,
  mapRef,
  baseLayersRef,
  drawingsLayer,
  measurementsLayer,
  pointInspectorLayer,
  placeSearchMarkerLayer,
  elevationProfileMarkerLayer,
  geometryBufferPreviewLayer,
  geometryOperationPreviewLayer,
  explorationTerrainEnabled,
  explorationTerrainOpacity,
  explorationTerrainTheme,
  explorationThemeOpacity,
  explorationElevationMode,
  explorationElevationScale,
  explorationElevationScaleRefresh,
  onStatusChange,
  onQgisStatusChange,
  onOpenFreeMapStatusChange,
  onOverlayAvailabilityChange,
  onExplorationTerrainStatusChange,
  onExplorationElevationScaleChange,
  onMapReady,
  onCenterChange,
}: MapViewProps) {
  const targetRef = useRef<HTMLDivElement>(null);
  const [mapGeneration, setMapGeneration] = useState(0);
  const baseMapRef = useRef(baseMap);
  const vectorLoadedRef = useRef(new Set<OpenFreeMapId>());
  const vectorPromisesRef = useRef(new globalThis.Map<OpenFreeMapId, Promise<void>>());
  const vectorTileListenersRef = useRef(new globalThis.Map<OpenFreeMapId, VectorTileListenerCleanup[]>());
  const explorationStatusRef = useRef(onExplorationTerrainStatusChange);
  const explorationTerrainRef = useRef<WebGLTileLayer | null>(null);
  const explorationEnabledRef = useRef(explorationTerrainEnabled);
  const explorationOpacityRef = useRef(explorationTerrainOpacity);
  const explorationTerrainThemeRef = useRef(explorationTerrainTheme);
  const explorationThemeOpacityRef = useRef(explorationThemeOpacity);
  const explorationElevationModeRef = useRef(explorationElevationMode);
  const explorationElevationScaleRef = useRef(explorationElevationScale);
  const explorationScaleChangeRef = useRef(onExplorationElevationScaleChange);
  const mapZoomRef = useRef<number | null>(null);
  const updateExplorationRef = useRef<((zoom: number, latitude: number, resolution: number) => void) | null>(null);
  const scheduleElevationScaleRef = useRef<(() => void) | null>(null);
  const activeBaseMapRef = useRef<BaseMapId | null>(null);
  const disposedRef = useRef(false);
  const suspendedRef = useRef(false);
  const centerRef = useRef(center);
  const zoomRef = useRef(zoom);
  centerRef.current = center;
  zoomRef.current = zoom;
  baseMapRef.current = baseMap;
  explorationStatusRef.current = onExplorationTerrainStatusChange;
  explorationScaleChangeRef.current = onExplorationElevationScaleChange;
  explorationEnabledRef.current = explorationTerrainEnabled;
  explorationOpacityRef.current = explorationTerrainOpacity;
  explorationTerrainThemeRef.current = explorationTerrainTheme;
  explorationThemeOpacityRef.current = explorationThemeOpacity;
  explorationElevationModeRef.current = explorationElevationMode;
  explorationElevationScaleRef.current = explorationElevationScale;

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
    const webglAvailable = supportsWebGL();
    const terrainDataSource = webglAvailable ? getSharedTerrariumDataTileSource() : null;
    const explorationSource: DataTileSource | null = terrainDataSource?.source ?? null;
    explorationSource?.setAttributions(
      '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">Mapzen Terrain Tiles · fuentes y atribución</a>',
    );
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
    if (!explorationLayer) explorationStatusRef.current("unavailable");
    const map = new OlMap({
      target: targetRef.current,
      pixelRatio: window.devicePixelRatio || 1,
      layers: [
        osmLayer,
        qgisLayer,
        ...Object.values(vectorBaseMapLayers),
        ...(explorationLayer ? [explorationLayer] : []),
        overlayLayers.boundaries,
        overlayLayers.localities,
        overlayLayers.rivers,
        overlayLayers.lakes,
        drawingsLayer,
        measurementsLayer,
        pointInspectorLayer,
        placeSearchMarkerLayer,
        elevationProfileMarkerLayer,
        geometryBufferPreviewLayer,
        geometryOperationPreviewLayer,
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
    const explorationTileStates = new globalThis.Map<string, {
      loading: boolean;
      hasData: boolean;
      degraded: boolean;
      failed: boolean;
    }>();
    const terrainTileKey = (coordinate: number[]) => {
      const [zoom, x, y] = coordinate;
      return [zoom, wrappedTileX(x, zoom), y].join("/");
    };
    const publishExplorationAvailability = (zoom: number) => {
      const view = map.getView();
      const size = map.getSize();
      const resolution = view.getResolution();
      if (!size || !resolution || !explorationSource) {
        explorationStatusRef.current?.("loading");
        return;
      }
      const grid = explorationSource.getTileGridForProjection(view.getProjection());
      const sourceZoom = effectiveTerrainSourceZoom(
        grid.getZForResolution(resolution),
        EXPLORATION_TERRAIN.maxDataZoom,
      );
      const range = grid.getTileRangeForExtentAndZ(view.calculateExtent(size), sourceZoom);
      const visibleStates: Array<{
        loading: boolean;
        hasData: boolean;
        degraded: boolean;
        failed: boolean;
      } | undefined> = [];
      for (let y = range.minY; y <= range.maxY; y += 1) {
        if (y < 0 || y >= 2 ** sourceZoom) continue;
        for (let x = range.minX; x <= range.maxX; x += 1) {
          visibleStates.push(explorationTileStates.get(terrainTileKey([sourceZoom, x, y])));
        }
      }
      if (!visibleStates.length || visibleStates.some((state) => !state || state.loading)) {
        explorationStatusRef.current?.("loading");
        return;
      }
      const loadedStates = visibleStates.flatMap((state) => state && !state.loading ? [state] : []);
      if (!loadedStates.some((state) => state.hasData)) {
        explorationStatusRef.current?.(loadedStates.some((state) => state.failed) ? "error" : "no-coverage");
        return;
      }
      if (loadedStates.some((state) => state.degraded || state.failed || !state.hasData)) {
        explorationStatusRef.current?.("partial");
        return;
      }
      explorationStatusRef.current?.(zoom > EXPLORATION_TERRAIN.maxDataZoom ? "overzoom" : "active");
    };
    let elevationScaleTimer: ReturnType<typeof setTimeout> | undefined;
    let adaptiveCalculationPending = false;
    let adaptiveCalculationDeadline = 0;
    const updateExplorationStyle = (resolution: number, latitude: number, zoom: number) => {
      const layer = explorationTerrainRef.current;
      if (!layer) return;
      const scale = explorationElevationScaleRef.current;
      const tileGrid = explorationSource?.getTileGridForProjection(map.getView().getProjection());
      const tileZoom = tileGrid?.getZForResolution(resolution) ?? zoom;
      const sourceZoom = effectiveTerrainSourceZoom(tileZoom, EXPLORATION_TERRAIN.maxDataZoom);
      const sourceResolution = tileGrid?.getResolution(sourceZoom) ?? resolution;
      const theme = explorationTerrainThemeRef.current;
      layer.updateStyleVariables({
        groundResolution: terrainPixelGroundDistanceMeters(sourceResolution, latitude),
        showHillshade: explorationEnabledRef.current ? 1 : 0,
        showElevation: theme === "elevation" ? 1 : 0,
        showSlope: theme === "slope" ? 1 : 0,
        showAspect: theme === "aspect" ? 1 : 0,
        hillshadeOpacity: explorationOpacityRef.current / 100,
        themeOpacity: explorationThemeOpacityRef.current / 100,
        adaptiveScale: scale.effectiveMode === "adaptive" ? 1 : 0,
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
      updateExplorationStyle(map.getView().getResolution() ?? 1, latitude, map.getView().getZoom() ?? 0);
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
      const isTerrainBasemap = activeBaseMapRef.current !== null && isTerrainBaseMap(activeBaseMapRef.current);
      const hillshadeEnabled = explorationEnabledRef.current;
      const thematicEnabled = explorationTerrainThemeRef.current !== "none";
      const visible = Boolean(
        layer
        && isTerrainBasemap
        && (hillshadeEnabled || thematicEnabled)
        && zoom >= EXPLORATION_TERRAIN.mapMinimumZoom,
      );
      if (layer) {
        layer.setVisible(visible);
        updateExplorationStyle(resolution, latitude, zoom);
      }
      if (!hasWebGL) explorationStatusRef.current?.("unavailable");
      else if (!isTerrainBasemap) explorationStatusRef.current?.("disabled");
      else if (!hillshadeEnabled && !thematicEnabled) explorationStatusRef.current?.("disabled");
      else publishExplorationAvailability(zoom);
    };
    updateExplorationRef.current = updateExplorationVisibility;
    scheduleElevationScaleRef.current = requestElevationScaleUpdate;
    const explorationTileStarted = (event: TileSourceEvent) => {
      const coordinate = (event.tile as DataTile).getTileCoord();
      explorationTileStates.set(terrainTileKey(coordinate), {
        loading: true,
        hasData: false,
        degraded: false,
        failed: false,
      });
      trimMapEntries(explorationTileStates, 128);
      if (explorationLayer?.getVisible()) publishExplorationAvailability(mapZoomRef.current ?? 0);
    };
    const explorationTileLoaded = (event: TileSourceEvent) => {
      const coordinate = (event.tile as DataTile).getTileCoord();
      const [zoom, x, y] = coordinate;
      const stats = terrainDataSource?.getTileStats(zoom, x, y);
      if (!stats) return;
      explorationTileStates.set(terrainTileKey(coordinate), {
        loading: false,
        hasData: stats.validPixels > 0,
        degraded: stats.fallbackPixels > 0 || stats.missingPixels > 0,
        failed: stats.failedRequests,
      });
      trimMapEntries(explorationTileStates, 128);
      if (explorationLayer?.getVisible()) publishExplorationAvailability(mapZoomRef.current ?? 0);
    };
    const explorationTileFailed = (event: TileSourceEvent) => {
      const coordinate = (event.tile as DataTile).getTileCoord();
      explorationTileStates.set(terrainTileKey(coordinate), {
        loading: false,
        hasData: false,
        degraded: true,
        failed: true,
      });
      trimMapEntries(explorationTileStates, 128);
      if (explorationLayer?.getVisible()) publishExplorationAvailability(mapZoomRef.current ?? 0);
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
    map.once("rendercomplete", firstRender);
    mapRef.current = map;
    baseLayersRef.current = {
      osm: osmLayer,
      qgis: qgisLayer,
      vector: vectorBaseMapLayers,
      overlays: overlayLayers,
      explorationTerrain: explorationLayer,
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
      map.setTarget(undefined);
      mapRef.current = null;
      baseLayersRef.current = null;
      explorationTerrainRef.current = null;
      updateExplorationRef.current = null;
      scheduleElevationScaleRef.current = null;
    };
  }, [baseLayersRef, drawingsLayer, mapRef, measurementsLayer, pointInspectorLayer, placeSearchMarkerLayer, elevationProfileMarkerLayer, geometryBufferPreviewLayer, geometryOperationPreviewLayer, onCenterChange, onMapReady, onOverlayAvailabilityChange, onQgisStatusChange, onStatusChange]);

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
  }, [explorationTerrainEnabled, explorationTerrainOpacity, explorationTerrainTheme, explorationThemeOpacity, explorationElevationMode, mapGeneration]);

  useEffect(() => {
    scheduleElevationScaleRef.current?.();
  }, [explorationElevationMode, explorationElevationScaleRefresh, mapGeneration]);

  useEffect(() => {
    const layers = baseLayersRef.current;
    if (!layers) return;

    const activate = (id: BaseMapId, forceOsmUnderlay = false) => {
      const isTerrain = isTerrainBaseMap(id);
      const styleId: OpenFreeMapId | null = isTerrain
        ? "positron"
        : id === "osm" || id === "qgis" ? null : id;
      const useVectorUnderlay = Boolean(styleId && vectorLoadedRef.current.has(styleId) && !forceOsmUnderlay);
      layers.osm.setVisible(id === "osm" || (isTerrain && !useVectorUnderlay));
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

    if (!isTerrainBaseMap(baseMap)) {
      activeBaseMapRef.current = baseMap;
      layers.explorationTerrain?.setVisible(false);
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
    }

    if (baseMap === "osm" || baseMap === "qgis") {
      activate(baseMap);
      return;
    }

    const styleId: OpenFreeMapId = isTerrainBaseMap(baseMap) ? "positron" : baseMap;
    const group = layers.vector[styleId];
    if (isTerrainBaseMap(baseMap)) activate(baseMap);
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
              || (styleId === "positron" && activeBaseMapRef.current !== null && isTerrainBaseMap(activeBaseMapRef.current));
            if (isActiveBackground) {
              onOpenFreeMapStatusChange(styleId, "available");
              if (activeBaseMapRef.current !== null && isTerrainBaseMap(activeBaseMapRef.current)) activate(activeBaseMapRef.current);
            }
          };
          const onError = () => {
            failedTiles += 1;
            if (errorTimer) return;
            errorTimer = setTimeout(() => {
              errorTimer = undefined;
              const isActiveBackground = activeBaseMapRef.current === styleId
                || (styleId === "positron" && activeBaseMapRef.current !== null && isTerrainBaseMap(activeBaseMapRef.current));
              if (failedTiles > 0 && isActiveBackground) {
                onOpenFreeMapStatusChange(styleId, "error");
                if (activeBaseMapRef.current !== null && isTerrainBaseMap(activeBaseMapRef.current)) activate(activeBaseMapRef.current, true);
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
          if (isTerrainBaseMap(baseMapRef.current)) activate(baseMapRef.current, true);
        }
      });
    vectorPromisesRef.current.set(styleId, loadPromise);
  }, [baseLayersRef, baseMap, mapGeneration, mapRef, onOpenFreeMapStatusChange]);


  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!active) {
      suspendedRef.current = true;
      map.setTarget(undefined);
      return;
    }

    const target = targetRef.current;
    if (target && (!map.getTargetElement() || suspendedRef.current)) map.setTarget(target);
    if (suspendedRef.current) {
      const view = map.getView();
      view.setCenter(fromLonLat(centerRef.current, view.getProjection()));
      view.setZoom(zoomRef.current);
      view.setRotation(0);
      suspendedRef.current = false;
    }

    const frame = requestAnimationFrame(() => {
      map.updateSize();
      map.render();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, mapGeneration, mapRef]);



  return (
    <div
      ref={targetRef}
      className={`map-canvas${active ? "" : " map-canvas--inactive"}`}
      role="application"
      aria-label="Mapa interactivo"
      tabIndex={0}
    />
  );
}
