import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Check,
  Compass,
  CornerUpLeft,
  Droplets,
  Layers,
  MapPinned,
  LoaderCircle,
  Map,
  MapPin,
  Minus,
  Moon,
  Mountain,
  ScanLine,
  PanelLeftClose,
  Plus,
  Play,
  RefreshCw,
  Sun,
  TrendingUp,
  Waves,
  X,
} from "lucide-react";
import { fromLonLat, transformExtent } from "ol/proj.js";
import Polygon from "ol/geom/Polygon.js";
import type OlMap from "ol/Map.js";
import MapView, { type BaseMapLayers, type MapStatus, type QgisStatus } from "@/components/MapView";
import { OPEN_FREE_MAP_STYLES, type BaseMapId, type OpenFreeMapId, type OpenFreeMapStatus } from "@/lib/base-maps";
import { DrawnElementsList } from "@/components/DrawnElementsList";
import { GeometryDetails } from "@/components/GeometryDetails";
import { DrawingToolbar } from "@/components/DrawingToolbar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDrawingTools } from "@/hooks/useDrawingTools";
import { useTerrainPreparation } from "@/hooks/useTerrainPreparation";
import { CRETE_CENTER } from "@/lib/map-config";
import { formatCoordinate } from "@/lib/geometry-metrics";
import {
  DEFAULT_OVERLAY_VISIBILITY,
  GEOGRAPHIC_OVERLAYS,
  type GeographicOverlayId,
  type GeographicOverlayVisibility,
} from "@/lib/cartographic-layers";
import {
  DEFAULT_TOPOGRAPHIC_OPACITY,
  DEFAULT_TOPOGRAPHIC_VISIBILITY,
  TOPOGRAPHIC_LAYERS,
  TERRAIN_VISIBILITY_THRESHOLDS,
  getTerrainCoverageRatio,
  getTerrainRenderMode,
  parseTerrainCoverage,
  type TerrainCoverage,
  type TopographicAvailability,
  type TopographicLayerId,
  type TopographicOpacity,
  type TopographicVisibility,
} from "@/lib/topographic-layers";
import type { TerrainPreparationResult, TerrainPreparationView } from "@/lib/terrain-preparation";
import {
  EXPLORATION_TERRAIN,
  ABSOLUTE_ELEVATION_MAX_M,
  ABSOLUTE_ELEVATION_MIN_M,
  ABSOLUTE_ELEVATION_STOPS,
  ADAPTIVE_LAND_STOPS,
  OCEAN_ELEVATION_STOPS,
  absoluteElevationScale,
  initialExplorationElevationEnabled,
  initialExplorationElevationMode,
  initialExplorationHillshadeEnabled,
  type ExplorationElevationMode,
  type ExplorationElevationScale,
  type ExplorationTerrainStatus,
} from "@/lib/exploration-terrain";
import {
  createPreparedTerrainState,
  type PreparedTerrainMapEntry,
  type PreparedTerrainState,
} from "@/lib/prepared-terrain";

type ThemeMode = "light" | "dark";
type PanelTab = "layers" | "areas" | "analysis";

function initialTheme(): ThemeMode {
  try {
    return window.localStorage.getItem("cv-gis-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const BASE_MAP_OPTIONS: Array<{ id: BaseMapId; title: string; description: string }> = [
  { id: "positron", title: "Minimalista", description: "Fondo claro y limpio" },
  { id: "dark", title: "Oscuro", description: "Contraste nocturno" },
  { id: "liberty", title: "Detallado", description: "Calles y lugares" },
  { id: "osm", title: "OpenStreetMap", description: "Calles y lugares" },
  { id: "qgis", title: "Crete Valley GIS", description: "Cartografía propia · Natural Earth" },
  { id: "topographic", title: "Topográfico", description: "Elevaciones y relieve del terreno" },
];

const TOPOGRAPHIC_LAYER_OPTIONS = [
  ["hillshade", Mountain],
  ["elevation", Layers],
  ["slope", TrendingUp],
  ["aspect", Compass],
] as const;

function explorationTerrainStatusMessage(status: ExplorationTerrainStatus, zoom: number): string {
  if (status === "disabled") return "Relieve desactivado.";
  if (status === "scale") return "Acércate para mostrar el relieve.";
  if (status === "loading") return "Cargando relieve…";
  if (status === "active") return "Relieve activo.";
  if (status === "overzoom") return "Mostrando el detalle máximo disponible.";
  if (status === "regional-priority") return "El terreno preparado tiene prioridad.";
  if (status === "unavailable") return "El relieve no está disponible en este navegador.";
  if (status === "error") return "No se pudieron cargar algunas teselas.";
  return `Relieve disponible · zoom ${zoom.toLocaleString("es-ES", { maximumFractionDigits: 1 })}.`;
}

function elevationGradient(
  stops: ReadonlyArray<{ valueM: number; color: string }>,
  minimumM: number,
  maximumM: number,
): string {
  const range = maximumM - minimumM;
  return `linear-gradient(90deg, ${stops.map((stop) => (
    `${stop.color} ${(((stop.valueM - minimumM) / range) * 100).toFixed(2)}%`
  )).join(", ")})`;
}

export default function App() {
  const mapStageRef = useRef<HTMLElement | null>(null);
  const traceMenuRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<OlMap | null>(null);
  const baseLayersRef = useRef<BaseMapLayers | null>(null);
  const drawingTools = useDrawingTools();
  const terrainJobs = useTerrainPreparation();
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [panelOpen, setPanelOpen] = useState(
    () => !window.matchMedia("(max-width: 720px)").matches,
  );
  const [panelTab, setPanelTab] = useState<PanelTab>("layers");
  const [panelWidth, setPanelWidth] = useState(300);
  const panelResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [baseMap, setBaseMap] = useState<BaseMapId>("positron");
  const baseMapRef = useRef<BaseMapId>(baseMap);
  const [openFreeMapStatus, setOpenFreeMapStatus] = useState<Record<OpenFreeMapId, OpenFreeMapStatus>>({
    positron: "idle",
    dark: "idle",
    liberty: "idle",
  });
  const [baseMapNotice, setBaseMapNotice] = useState<string | null>(null);
  const [overlayVisibility, setOverlayVisibility] = useState<GeographicOverlayVisibility>(DEFAULT_OVERLAY_VISIBILITY);
  const [overlayAvailability, setOverlayAvailability] = useState<Record<GeographicOverlayId, boolean>>({
    boundaries: true,
    localities: true,
    rivers: true,
    lakes: true,
  });
  const [topographicVisibility, setTopographicVisibility] = useState<TopographicVisibility>(DEFAULT_TOPOGRAPHIC_VISIBILITY);
  const [topographicOpacity, setTopographicOpacity] = useState<TopographicOpacity>(DEFAULT_TOPOGRAPHIC_OPACITY);
  const [topographicAvailability, setTopographicAvailability] = useState<TopographicAvailability>({
    hillshade: true,
    elevation: true,
    slope: true,
    aspect: true,
  });
  const [terrainCoverage, setTerrainCoverage] = useState<TerrainCoverage | null>(null);
  const [explorationTerrainEnabled, setExplorationTerrainEnabled] = useState(initialExplorationHillshadeEnabled);
  const [explorationElevationEnabled, setExplorationElevationEnabled] = useState(initialExplorationElevationEnabled);
  const [explorationElevationMode, setExplorationElevationMode] = useState<ExplorationElevationMode>(initialExplorationElevationMode);
  const [explorationTerrainOpacity, setExplorationTerrainOpacity] = useState<number>(EXPLORATION_TERRAIN.defaultHillshadeOpacity);
  const [explorationElevationOpacity, setExplorationElevationOpacity] = useState<number>(EXPLORATION_TERRAIN.defaultElevationOpacity);
  const [explorationElevationScale, setExplorationElevationScale] = useState<ExplorationElevationScale>(
    () => absoluteElevationScale(initialExplorationElevationMode()),
  );
  const [explorationElevationScaleRefresh, setExplorationElevationScaleRefresh] = useState(0);
  const [explorationTerrainVisible, setExplorationTerrainVisible] = useState(false);
  const [explorationTerrainStatus, setExplorationTerrainStatus] = useState<ExplorationTerrainStatus>("loading");
  const [preparedTerrains, setPreparedTerrains] = useState<Record<string, PreparedTerrainState>>({});
  const preparedTerrainsRef = useRef(preparedTerrains);
  const terrainRequestRevisionsRef = useRef(new globalThis.Map<string, number>());
  const [terrainServiceState, setTerrainServiceState] = useState<"loading" | "available" | "unavailable">("loading");
  const [mapExtent, setMapExtent] = useState<[number, number, number, number] | null>(null);
  const [mapResolution, setMapResolution] = useState<number | null>(null);
  const [mapZoom, setMapZoom] = useState(8.2);
  const [qgisStatus, setQgisStatus] = useState<QgisStatus>("idle");
  const [mapStatus, setMapStatus] = useState<MapStatus>({
    ready: false,
    loading: true,
    error: false,
  });
  const [mapCenter, setMapCenter] = useState<[number, number]>([...CRETE_CENTER]);

  preparedTerrainsRef.current = preparedTerrains;
  baseMapRef.current = baseMap;

  const handleMapStatus = useCallback((status: MapStatus) => {
    setMapStatus(status);
  }, []);

  const handleMapCenterChange = useCallback((
    center: [number, number],
    extent: [number, number, number, number],
    resolution: number,
    zoom: number,
  ) => {
    setMapCenter(center);
    setMapExtent(extent);
    setMapResolution(resolution);
    setMapZoom(zoom);
  }, []);

  const handleQgisStatusChange = useCallback((status: QgisStatus) => {
    setQgisStatus(status);
    if (status !== "error") return;
    if (baseMapRef.current === "qgis") {
      baseMapRef.current = "osm";
      setBaseMap("osm");
    }
  }, []);

  const handleOpenFreeMapStatusChange = useCallback((id: OpenFreeMapId, status: OpenFreeMapStatus) => {
    setOpenFreeMapStatus((current) => ({ ...current, [id]: status }));
    const isTopographicBackground = baseMapRef.current === "topographic" && id === "positron";
    if (status === "error") {
      setBaseMapNotice(isTopographicBackground
        ? "No se pudo cargar el fondo vectorial; OpenStreetMap sigue disponible bajo el relieve."
        : "No se pudo cargar el mapa vectorial. OpenStreetMap sigue disponible.");
      if (baseMapRef.current === id) {
        baseMapRef.current = "osm";
        setBaseMap("osm");
      }
    } else if (status === "available" && (baseMapRef.current === id || isTopographicBackground)) {
      setBaseMapNotice(null);
    }
  }, []);

  const changeTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    try {
      window.localStorage.setItem("cv-gis-theme", nextTheme);
    } catch {
      // The theme remains active for this page even if storage is unavailable.
    }
  };

  const changeBaseMap = (next: BaseMapId) => {
    baseMapRef.current = next;
    setBaseMapNotice(null);
    setBaseMap(next);
    if (next === "qgis") setQgisStatus("loading");
  };

  const changeOverlayVisibility = (id: GeographicOverlayId, visible: boolean) => {
    baseLayersRef.current?.overlays[id].setVisible(visible);
    setOverlayVisibility((current) => ({ ...current, [id]: visible }));
  };

  const changeTopographicVisibility = (id: TopographicLayerId, visible: boolean) => {
    setTopographicVisibility((current) => {
      const next = { ...current, [id]: visible };
      if (visible && id !== "hillshade") {
        (Object.keys(TOPOGRAPHIC_LAYERS) as TopographicLayerId[]).forEach((other) => {
          if (other !== "hillshade" && other !== id) next[other] = false;
        });
      }
      return next;
    });
  };

  const changeTopographicOpacity = (id: TopographicLayerId, opacity: number) => {
    baseLayersRef.current?.topography[id].setOpacity(opacity / 100);
    setTopographicOpacity((current) => ({ ...current, [id]: opacity }));
  };

  const changeExplorationTerrainEnabled = (enabled: boolean) => {
    setExplorationTerrainEnabled(enabled);
    try {
      window.localStorage.setItem(EXPLORATION_TERRAIN.hillshadeStorageKey, String(enabled));
    } catch {
      // The preference remains active for this page if storage is unavailable.
    }
  };

  const changeExplorationElevationEnabled = (enabled: boolean) => {
    setExplorationElevationEnabled(enabled);
    try {
      window.localStorage.setItem(EXPLORATION_TERRAIN.elevationStorageKey, String(enabled));
    } catch {
      // Keep this session's preference if browser storage is unavailable.
    }
  };

  const changeExplorationElevationMode = (mode: ExplorationElevationMode) => {
    setExplorationElevationMode(mode);
    try {
      window.localStorage.setItem(EXPLORATION_TERRAIN.elevationModeStorageKey, mode);
    } catch {
      // Keep this session's preference if browser storage is unavailable.
    }
  };

  const handleExplorationTerrainStatusChange = useCallback((status: ExplorationTerrainStatus) => {
    setExplorationTerrainStatus(status);
  }, []);

  const handleExplorationTerrainVisibilityChange = useCallback((visible: boolean) => {
    setExplorationTerrainVisible((current) => current === visible ? current : visible);
  }, []);

  const handleExplorationElevationScaleChange = useCallback((scale: ExplorationElevationScale) => {
    setExplorationElevationScale((current) => current.requestedMode === scale.requestedMode
      && current.effectiveMode === scale.effectiveMode
      && current.minM === scale.minM
      && current.maxM === scale.maxM
      && current.sampleCount === scale.sampleCount
      ? current
      : scale);
  }, []);

  const activatePreparedTerrain = useCallback((elementId: string, jobId: string, result: TerrainPreparationResult) => {
    const feature = drawingTools.layer.getSource()?.getFeatureById(elementId);
    const geometry = feature?.getGeometry();
    if (!(geometry instanceof Polygon)) return;
    const requestedRevision = terrainRequestRevisionsRef.current.get(elementId);
    const existing = preparedTerrainsRef.current[elementId];
    const expectedRevision = existing?.geometryRevision ?? requestedRevision;
    if (expectedRevision === undefined || expectedRevision !== geometry.getRevision()) return;
    if (existing?.jobId === jobId && existing.result === result) return;
    const next = existing && existing.jobId === jobId
      ? { ...existing, result, availability: {
        ...existing.availability,
        slope: Boolean(result.cartography.layers.slope),
        aspect: Boolean(result.cartography.layers.aspect),
      } }
      : createPreparedTerrainState(elementId, jobId, result, geometry.getRevision());
    const updated = { ...preparedTerrainsRef.current, [elementId]: next };
    preparedTerrainsRef.current = updated;
    setPreparedTerrains(updated);
  }, [drawingTools.layer]);

  const setPreparedTerrainVisible = useCallback((elementId: string, visible: boolean) => {
    setPreparedTerrains((current) => {
      const terrain = current[elementId];
      if (!terrain || terrain.visible === visible) return current;
      const next = { ...current, [elementId]: { ...terrain, visible } };
      preparedTerrainsRef.current = next;
      return next;
    });
  }, []);

  const setPreparedTerrainLayerVisible = useCallback((elementId: string, id: TopographicLayerId, visible: boolean) => {
    setPreparedTerrains((current) => {
      const terrain = current[elementId];
      if (!terrain) return current;
      const visibility = { ...terrain.visibility };
      if (id === "hillshade") visibility.hillshade = visible;
      else {
        (Object.keys(TOPOGRAPHIC_LAYERS) as TopographicLayerId[]).forEach((other) => {
          if (other !== "hillshade") visibility[other] = visible && other === id;
        });
      }
      const next = {
        ...current,
        [elementId]: { ...terrain, visibility, ...(id !== "hillshade" ? { selectedLayer: id } : {}) },
      };
      preparedTerrainsRef.current = next;
      return next;
    });
  }, []);

  const setPreparedTerrainOpacity = useCallback((elementId: string, id: TopographicLayerId, opacity: number) => {
    setPreparedTerrains((current) => {
      const terrain = current[elementId];
      if (!terrain || terrain.opacity[id] === opacity) return current;
      const next = { ...current, [elementId]: { ...terrain, opacity: { ...terrain.opacity, [id]: opacity } } };
      preparedTerrainsRef.current = next;
      return next;
    });
  }, []);

  const centerPreparedTerrain = useCallback((elementId: string) => {
    const terrain = preparedTerrainsRef.current[elementId];
    const view = mapRef.current?.getView();
    if (!terrain || !view) return;
    const extent = transformExtent(
      terrain.result.coverage.extent_wgs84,
      "EPSG:4326",
      view.getProjection(),
      8,
    );
    view.fit(extent, { duration: 420, maxZoom: 13, padding: [84, 42, 84, 42] });
  }, []);

  const handlePrepareTerrain = useCallback((elementId: string, areaName: string, bbox: [number, number, number, number]) => {
    const geometry = drawingTools.layer.getSource()?.getFeatureById(elementId)?.getGeometry();
    if (!(geometry instanceof Polygon)) return;
    terrainRequestRevisionsRef.current.set(elementId, geometry.getRevision());
    void terrainJobs.prepareTerrain(elementId, areaName, bbox);
  }, [drawingTools.layer, terrainJobs.prepareTerrain]);

  const handlePrepareDerivatives = useCallback(async (elementId: string, jobId: string) => {
    const expectedRevision = preparedTerrainsRef.current[elementId]?.geometryRevision;
    const result = await terrainJobs.prepareDerivatives(elementId, jobId);
    if (!result) return;
    const current = preparedTerrainsRef.current[elementId];
    const geometry = drawingTools.layer.getSource()?.getFeatureById(elementId)?.getGeometry();
    if (current && current.geometryRevision === expectedRevision && geometry instanceof Polygon && geometry.getRevision() === expectedRevision) {
      activatePreparedTerrain(elementId, jobId, result);
    }
  }, [activatePreparedTerrain, drawingTools.layer, terrainJobs.prepareDerivatives]);

  const showPreparedTerrain = useCallback((elementId: string) => {
    const job = terrainJobs.jobs[elementId];
    if (job?.state === "completed" && job.result && job.jobId) activatePreparedTerrain(elementId, job.jobId, job.result);
  }, [activatePreparedTerrain, terrainJobs.jobs]);

  const handleOverlayAvailabilityChange = useCallback((id: GeographicOverlayId, available: boolean) => {
    setOverlayAvailability((current) => current[id] === available ? current : { ...current, [id]: available });
  }, []);

  const handleTopographicAvailabilityChange = useCallback((id: TopographicLayerId, available: boolean) => {
    setTopographicAvailability((current) => current[id] === available ? current : { ...current, [id]: available });
    if (available) setTerrainServiceState("available");
  }, []);

  const terrainRenderMode = terrainServiceState === "available"
    ? getTerrainRenderMode(mapExtent, mapResolution, terrainCoverage)
    : "hidden";
  const groundResolution = mapResolution === null
    ? null
    : mapResolution * Math.cos((mapCenter[1] * Math.PI) / 180);
  const detailedCoverageRatio = getTerrainCoverageRatio(mapExtent, terrainCoverage);
  const hasDetailedCoverageForView = detailedCoverageRatio >= TERRAIN_VISIBILITY_THRESHOLDS.detailedMinViewCoverageRatio;
  const hasTopographicPreference = Object.values(topographicVisibility).some(Boolean);
  const selectedVectorBaseMap: OpenFreeMapId | null = baseMap === "topographic"
    ? "positron"
    : baseMap === "osm" || baseMap === "qgis" ? null : baseMap;
  const selectedVectorStatus = selectedVectorBaseMap ? openFreeMapStatus[selectedVectorBaseMap] : "idle";
  const selectedElement = drawingTools.selectedElementInfo;
  const selectedTerrainJob = selectedElement ? terrainJobs.jobs[selectedElement.id] : undefined;
  const selectedTerrainMatches = Boolean(
    selectedElement?.bboxWgs84 && selectedTerrainJob?.result && selectedElement.bboxWgs84.every((coordinate, index) => (
      Math.abs(coordinate - selectedTerrainJob.result!.coverage.extent_wgs84[index]) < 1e-7
    )),
  );
  const selectedTerrainPreparation: TerrainPreparationView | undefined = selectedTerrainJob?.state === "completed" && !selectedTerrainMatches
    ? { state: "error", message: "El área cambió después de preparar estos datos. Vuelve a preparar el terreno." }
    : selectedTerrainJob;
  const selectedPreparedTerrain = selectedElement ? preparedTerrains[selectedElement.id] : undefined;
  const regionalElevationStyle = selectedPreparedTerrain?.result.coverage.elevation_style;
  const regionalDerivatives = selectedPreparedTerrain?.result.derivatives;
  const activeTerrainOverzoomFactor = selectedPreparedTerrain && groundResolution && groundResolution > 0
    ? selectedPreparedTerrain.result.coverage.resolution_m / groundResolution
    : null;
  const preparedTerrainEntries: PreparedTerrainMapEntry[] = useMemo(() => Object.values(preparedTerrains).flatMap((terrain) => {
    const geometry = drawingTools.layer.getSource()?.getFeatureById(terrain.elementId)?.getGeometry();
    if (!(geometry instanceof Polygon) || geometry.getRevision() !== terrain.geometryRevision) return [];
    return [{ ...terrain, geometry, selected: terrain.elementId === selectedElement?.id }];
  }), [drawingTools.layer, preparedTerrains, selectedElement?.id]);
  const hasVisibleRegionalHillshade = preparedTerrainEntries.some((terrain) => (
    terrain.visible && terrain.visibility.hillshade
  ));
  const topographicBasemapActive = baseMap === "topographic";
  const suppressGlobalHillshade = topographicBasemapActive || explorationTerrainVisible || hasVisibleRegionalHillshade;
  const showExplorationHillshadeControls = topographicBasemapActive || explorationTerrainEnabled;
  const showExplorationElevationControls = topographicBasemapActive || explorationElevationEnabled;
  const explorationStatusMessage = explorationTerrainStatusMessage(explorationTerrainStatus, mapZoom);
  const formatElevation = (value: number) => Math.round(value).toLocaleString("es-ES");
  const absoluteLandGradient = elevationGradient(ABSOLUTE_ELEVATION_STOPS, 0, ABSOLUTE_ELEVATION_MAX_M);
  const oceanExplorationGradient = elevationGradient(OCEAN_ELEVATION_STOPS, ABSOLUTE_ELEVATION_MIN_M, 0);
  const adaptiveLandGradient = `linear-gradient(90deg, ${ADAPTIVE_LAND_STOPS.map((stop) => (
    `${stop.color} ${(stop.position * 100).toFixed(2)}%`
  )).join(", ")})`;
  const visibleExplorationScale = topographicBasemapActive
    ? absoluteElevationScale()
    : explorationElevationScale;
  const visibleExplorationMode = topographicBasemapActive ? "absolute" : visibleExplorationScale.effectiveMode;
  const visibleExplorationRequestedMode = topographicBasemapActive ? "absolute" : visibleExplorationScale.requestedMode;
  const adaptiveScaleFallback = visibleExplorationScale.requestedMode === "adaptive"
    && visibleExplorationScale.effectiveMode !== "adaptive";
  const regionalElevationGradient = regionalElevationStyle
    ? `linear-gradient(90deg, ${regionalElevationStyle.stops.map((stop) => (
      `${stop.color} ${(stop.position * 100).toFixed(2)}%`
    )).join(", ")})`
    : undefined;

  useEffect(() => {
    drawingTools.setPreparedTerrainIds(preparedTerrainEntries.map((terrain) => terrain.elementId));
  }, [drawingTools.setPreparedTerrainIds, preparedTerrainEntries]);

  useEffect(() => {
    const source = drawingTools.layer.getSource();
    const invalidIds = new Set<string>();
    terrainRequestRevisionsRef.current.forEach((revision, id) => {
      const geometry = source?.getFeatureById(id)?.getGeometry();
      if (!(geometry instanceof Polygon) || geometry.getRevision() !== revision) invalidIds.add(id);
    });
    Object.values(preparedTerrainsRef.current).forEach((terrain) => {
      const geometry = source?.getFeatureById(terrain.elementId)?.getGeometry();
      if (!(geometry instanceof Polygon) || geometry.getRevision() !== terrain.geometryRevision) invalidIds.add(terrain.elementId);
    });
    if (invalidIds.size) {
      invalidIds.forEach((id) => {
        terrainRequestRevisionsRef.current.delete(id);
        terrainJobs.removeJob(id);
      });
      setPreparedTerrains((current) => {
        const next = { ...current };
        invalidIds.forEach((id) => delete next[id]);
        preparedTerrainsRef.current = next;
        return next;
      });
    }
    Object.entries(terrainJobs.jobs).forEach(([elementId, job]) => {
      if (job.state !== "completed" || !job.result || !job.jobId) return;
      const geometry = source?.getFeatureById(elementId)?.getGeometry();
      const requestedRevision = terrainRequestRevisionsRef.current.get(elementId);
      if (!(geometry instanceof Polygon) || requestedRevision === undefined || geometry.getRevision() !== requestedRevision) return;
      activatePreparedTerrain(elementId, job.jobId, job.result);
    });
  }, [activatePreparedTerrain, drawingTools.elements, drawingTools.layer, terrainJobs.jobs, terrainJobs.removeJob]);

  useEffect(() => {
    const layers = baseLayersRef.current?.topography;
    if (!layers) return;

    (Object.keys(TOPOGRAPHIC_LAYERS) as TopographicLayerId[]).forEach((id) => {
      const layer = layers[id];
      const source = layer.getSource();
      if (!source) return;
      const supportsGlobalLayer = id === "hillshade" || id === "elevation";
      const globalHillshadeBlocked = topographicBasemapActive || (id === "hillshade" && suppressGlobalHillshade);
      const shouldRender = supportsGlobalLayer
        && terrainServiceState === "available"
        && topographicVisibility[id]
        && terrainRenderMode !== "hidden"
        && !globalHillshadeBlocked;
      if (shouldRender) {
        const names = TOPOGRAPHIC_LAYERS[id];
        const requestedLayer = terrainRenderMode === "detailed"
          ? names.wmsLayer
          : id === "hillshade"
            ? TOPOGRAPHIC_LAYERS.hillshade.globalWmsLayer
            : TOPOGRAPHIC_LAYERS.elevation.globalWmsLayer;
        if (source.getParams().LAYERS !== requestedLayer) source.updateParams({ LAYERS: requestedLayer });
      }
      if (layer.getVisible() !== shouldRender) layer.setVisible(shouldRender);
    });
  }, [suppressGlobalHillshade, terrainRenderMode, terrainServiceState, topographicBasemapActive, topographicVisibility]);

  const handlePreparedTerrainAvailabilityChange = useCallback((elementId: string, id: TopographicLayerId, available: boolean) => {
    setPreparedTerrains((current) => {
      const terrain = current[elementId];
      if (!terrain || terrain.availability[id] === available) return current;
      const next = { ...current, [elementId]: { ...terrain, availability: { ...terrain.availability, [id]: available } } };
      preparedTerrainsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/qgis/ogc/world?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`QGIS WMS responded with ${response.status}`);
        return response.text();
      })
      .then((xml) => {
        if (controller.signal.aborted) return;
        const coverage = parseTerrainCoverage(xml);
        setTerrainCoverage(coverage);
        setTerrainServiceState(coverage ? "available" : "unavailable");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setTerrainCoverage(null);
        setTerrainServiceState("unavailable");
      });
    return () => controller.abort();
  }, []);

  const changeZoom = (amount: number) => {
    const view = mapRef.current?.getView();
    if (!view) return;
    const zoom = view.getZoom() ?? 7.6;
    view.animate({ zoom: Math.max(2, Math.min(19, zoom + amount)), duration: 180 });
  };

  const resetView = () => {
    mapRef.current?.getView().animate({
      center: fromLonLat([...CRETE_CENTER]),
      zoom: 7.6,
      duration: 240,
    });
  };

  const focusElement = (id: string) => {
    drawingTools.selectElement(id);
    drawingTools.centerElement(id);
  };

  const handleStageContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest(".map-canvas")) return;
    const stage = event.currentTarget.getBoundingClientRect();
    const opened = drawingTools.openTraceContextMenu({
      x: event.clientX - stage.left,
      y: event.clientY - stage.top,
    });
    if (opened) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [drawingTools.openTraceContextMenu]);

  const handleTraceClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (drawingTools.traceContextMenu && !(event.target instanceof HTMLElement && event.target.closest(".trace-context-menu"))) {
      drawingTools.continueTrace();
    }
  }, [drawingTools.continueTrace, drawingTools.traceContextMenu]);

  useEffect(() => {
    if (!drawingTools.traceContextMenu) return;
    traceMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus();
  }, [drawingTools.traceContextMenu]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")
      ) return;

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
        if (!drawingTools.canUndoVertex) return;
        event.preventDefault();
        drawingTools.undoLastVertex();
        return;
      }

      if (event.ctrlKey || event.metaKey) return;
      if (event.key === "Enter" && target instanceof HTMLElement && target.closest(".trace-context-menu")) return;

      if (event.key === "Escape" && drawingTools.activeTool !== "navigate") {
        event.preventDefault();
        drawingTools.cancelDrawing();
      } else if (event.key === "Enter" && drawingTools.canFinishTrace) {
        event.preventDefault();
        drawingTools.finishTrace();
      } else if ((event.key === "Delete" || event.key === "Del") && drawingTools.selectedIds.length > 0) {
        event.preventDefault();
        drawingTools.deleteSelected();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    drawingTools.activeTool,
    drawingTools.canFinishTrace,
    drawingTools.canUndoVertex,
    drawingTools.cancelDrawing,
    drawingTools.deleteSelected,
    drawingTools.finishTrace,
    drawingTools.undoLastVertex,
    drawingTools.selectedIds.length,
  ]);

  return (
      <div className="app-shell" data-theme={theme} onClickCapture={handleTraceClickCapture}>
      <header className="app-header flex items-center justify-between">
        <div className="brand-lockup flex items-center gap-3">
          <div className="brand-mark" aria-hidden="true">
            <Map size={20} strokeWidth={1.8} />
          </div>
          <div className="brand-name">
            <span>Crete Valley</span>
            <span className="brand-divider" aria-hidden="true">/</span>
            <span className="brand-product">GIS</span>
          </div>
        </div>

        <div className="header-actions flex items-center gap-2">
          <Button
            variant="ghost"
            size="small"
            className="layers-button"
            aria-expanded={panelOpen}
            aria-controls="layer-panel"
            onClick={() => setPanelOpen((open) => !open)}
          >
            {panelOpen ? <PanelLeftClose size={17} /> : <Layers size={17} />}
            <span>Capas</span>
          </Button>
          <span className="header-separator" aria-hidden="true" />
          <Button
            variant="ghost"
            size="icon"
            aria-label={theme === "light" ? "Activar modo oscuro" : "Activar modo claro"}
            aria-pressed={theme === "dark"}
            title={theme === "light" ? "Modo oscuro" : "Modo claro"}
            onClick={changeTheme}
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </Button>
        </div>
      </header>

      <main
        className={`workspace ${panelOpen ? "workspace--panel-open" : "workspace--panel-closed"}`}
        style={panelOpen ? { gridTemplateColumns: `${panelWidth}px minmax(0, 1fr)` } : undefined}
      >
        {panelOpen && (
          <button
            type="button"
            className="panel-scrim"
            aria-label="Cerrar panel de capas"
            onClick={() => setPanelOpen(false)}
          />
        )}
        <aside
          className="layer-panel"
          id="layer-panel"
          aria-label="Panel de capas"
          hidden={!panelOpen}
        >
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CONTENIDO DEL MAPA</p>
              <h1>Capas</h1>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="panel-close"
              aria-label="Cerrar panel de capas"
              onClick={() => setPanelOpen(false)}
            >
              <X size={17} />
            </Button>
          </div>
          <div className="panel-tabs" role="tablist" aria-label="Contenido del panel">
            {([
              ["layers", "Capas"],
              ["areas", `Áreas${drawingTools.elements.length ? ` · ${drawingTools.elements.length}` : ""}`],
              ["analysis", "Análisis"],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                id={`panel-tab-${tab}`}
                type="button"
                role="tab"
                aria-selected={panelTab === tab}
                aria-controls="panel-tab-content"
                tabIndex={panelTab === tab ? 0 : -1}
                onClick={() => setPanelTab(tab)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="panel-content" id="panel-tab-content" role="tabpanel" aria-labelledby={`panel-tab-${panelTab}`}>
          {panelTab === "layers" && (
            <>
          <section className="layer-section" aria-labelledby="base-layers-title">
            <h2 className="eyebrow" id="base-layers-title">MAPA BASE</h2>
            <div className="base-map-options" role="radiogroup" aria-label="Mapa base">
              {BASE_MAP_OPTIONS.map((option) => {
                const vectorId: OpenFreeMapId | null = option.id === "topographic"
                  ? "positron"
                  : option.id === "osm" || option.id === "qgis" ? null : option.id;
                const vectorStatus = vectorId ? openFreeMapStatus[vectorId] : "idle";
                const subtitle = vectorStatus === "loading"
                  ? "Cargando estilo…"
                  : vectorStatus === "error"
                    ? option.id === "topographic"
                      ? "Relieve sobre OpenStreetMap"
                      : "No disponible · OpenStreetMap activo"
                    : option.id === "qgis" && qgisStatus === "error"
                      ? "Servicio no disponible"
                      : null;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`base-map-option base-map-option--${option.id}`}
                    role="radio"
                    aria-checked={baseMap === option.id}
                    aria-label={`${option.title}${subtitle ? ` · ${subtitle}` : ""}`}
                    title={subtitle ?? option.description}
                    onClick={() => changeBaseMap(option.id)}
                  >
                    <span className={`base-map-preview base-map-preview--${option.id}`} aria-hidden="true" />
                    {baseMap === option.id && vectorStatus === "loading" ? (
                      <LoaderCircle className="base-map-loading spinner" size={13} aria-hidden="true" />
                    ) : (
                      <span className={`base-map-indicator ${baseMap === option.id ? "base-map-indicator--active" : ""}`} aria-hidden="true" />
                    )}
                    <span className="base-map-title">{option.id === "osm" ? "OSM" : option.title}</span>
                    {subtitle && <span className="base-map-status">{subtitle}</span>}
                  </button>
                );
              })}
            </div>
          </section>

          <details className="panel-group thematic-layer-section" open>
            <summary className="panel-group-summary"><span className="eyebrow" id="geographic-layers-title">CAPAS GEOGRÁFICAS</span></summary>
            <div className="overlay-layer-list">
              {([
                ["boundaries", ScanLine],
                ["localities", MapPinned],
                ["rivers", Waves],
                ["lakes", Droplets],
              ] as const).map(([id, Icon]) => {
                const layer = GEOGRAPHIC_OVERLAYS[id];
                return (
                  <div className="overlay-layer-row" key={id}>
                    <span className={`overlay-symbol overlay-symbol--${id}`} aria-hidden="true"><Icon size={16} /></span>
                    <span className="layer-copy"><span className="layer-title">{layer.title}</span></span>
                    {!overlayAvailability[id] && <span className="layer-unavailable">No disponible</span>}
                    <Switch
                      checked={overlayVisibility[id]}
                      onCheckedChange={(visible) => changeOverlayVisibility(id, visible)}
                      aria-label={`${overlayVisibility[id] ? "Ocultar" : "Mostrar"} ${layer.title.toLowerCase()}`}
                    />
                  </div>
                );
              })}
            </div>
          </details>

          <details className="panel-group topography-section" open>
            <summary className="panel-group-summary"><span className="eyebrow" id="topography-title">TOPOGRAFÍA</span></summary>
            <section className="terrain-exploration-controls" aria-label="Topografía del mapa completo">
              <div className="topography-subheading">
                <strong>Relieve del mapa</strong>
                {topographicBasemapActive
                  ? <span className="topographic-layer-included">Incluido</span>
                  : <span className={`topography-state topography-state--${explorationTerrainStatus}`}>{explorationStatusMessage}</span>}
              </div>
              {topographicBasemapActive ? (
                <p className="topography-inline-note">Elevación y sombreado activos en el mapa base.</p>
              ) : (
                <div className="topographic-toggle-list">
                  <div className="overlay-layer-row topographic-layer-row exploration-terrain-row">
                    <span className="overlay-symbol topographic-symbol topographic-symbol--hillshade" aria-hidden="true"><Mountain size={16} /></span>
                    <span className="layer-copy"><span className="layer-title">Relieve sombreado</span></span>
                    <Switch
                      checked={explorationTerrainEnabled}
                      onCheckedChange={changeExplorationTerrainEnabled}
                      aria-label={`${explorationTerrainEnabled ? "Desactivar" : "Activar"} relieve sombreado`}
                    />
                  </div>
                  <div className="overlay-layer-row topographic-layer-row exploration-terrain-row exploration-elevation-row">
                    <span className="overlay-symbol topographic-symbol topographic-symbol--elevation" aria-hidden="true"><Layers size={16} /></span>
                    <span className="layer-copy"><span className="layer-title">Elevación</span></span>
                    <Switch
                      checked={explorationElevationEnabled}
                      onCheckedChange={changeExplorationElevationEnabled}
                      aria-label={`${explorationElevationEnabled ? "Desactivar" : "Activar"} elevación del terreno`}
                    />
                  </div>
                </div>
              )}

              <details className="topography-display-settings">
                <summary>Ajustes y leyenda</summary>
                <div className="topography-display-settings__content">
                  {showExplorationHillshadeControls && (
                    <label className="topographic-opacity exploration-terrain-opacity" htmlFor="exploration-hillshade-opacity">
                      <span>Intensidad del relieve</span><output htmlFor="exploration-hillshade-opacity">{explorationTerrainOpacity} %</output>
                      <input
                        id="exploration-hillshade-opacity"
                        type="range"
                        min="0"
                        max="75"
                        step="5"
                        value={explorationTerrainOpacity}
                        onChange={(event) => setExplorationTerrainOpacity(Number(event.currentTarget.value))}
                        aria-label="Intensidad del relieve sombreado"
                      />
                    </label>
                  )}
                  {showExplorationElevationControls && (
                    <>
                      <label className="topographic-opacity exploration-terrain-opacity" htmlFor="exploration-elevation-opacity">
                        <span>Intensidad del color</span><output htmlFor="exploration-elevation-opacity">{explorationElevationOpacity} %</output>
                        <input
                          id="exploration-elevation-opacity"
                          type="range"
                          min="0"
                          max="80"
                          step="5"
                          value={explorationElevationOpacity}
                          onChange={(event) => setExplorationElevationOpacity(Number(event.currentTarget.value))}
                          aria-label="Intensidad del color de elevación"
                        />
                      </label>
                      {topographicBasemapActive ? (
                        <span className="exploration-elevation-mode-note">Colores absolutos · comparables entre regiones</span>
                      ) : (
                        <label className="exploration-elevation-mode" htmlFor="exploration-elevation-mode">
                          <span>Colores</span>
                          <select
                            id="exploration-elevation-mode"
                            value={explorationElevationMode}
                            onChange={(event) => changeExplorationElevationMode(event.currentTarget.value as ExplorationElevationMode)}
                          >
                            <option value="adaptive">Adaptativos a la región</option>
                            <option value="absolute">Escala absoluta</option>
                          </select>
                        </label>
                      )}
                      <div className="exploration-elevation-legend" aria-label={`Leyenda de elevación ${visibleExplorationMode === "adaptive" ? "adaptativa" : "absoluta"} en metros`}>
                        <span className="elevation-legend-title">Altitud · metros</span>
                        <div className="exploration-elevation-legend__bands">
                          <div className="exploration-elevation-legend__band">
                            <span>Océano</span>
                            <i style={{ background: oceanExplorationGradient }} aria-hidden="true" />
                            <div className="exploration-elevation-legend__values"><span>≤ {formatElevation(ABSOLUTE_ELEVATION_MIN_M)} m</span><span>0 m</span></div>
                          </div>
                          <div className="exploration-elevation-legend__band">
                            <div className="exploration-elevation-legend__band-heading">
                              <span>Terreno · {visibleExplorationMode === "adaptive" ? "adaptativo" : "absoluto"}</span>
                              {visibleExplorationRequestedMode === "adaptive" && (
                                <Button
                                  variant="ghost"
                                  size="small"
                                  className="exploration-elevation-refresh"
                                  aria-label="Recalcular escala adaptativa para la vista actual"
                                  title="Recalcular con las teselas de la vista actual"
                                  onClick={() => setExplorationElevationScaleRefresh((revision) => revision + 1)}
                                >
                                  <RefreshCw size={13} aria-hidden="true" /> Recalcular
                                </Button>
                              )}
                            </div>
                            <i style={{ background: visibleExplorationMode === "adaptive" ? adaptiveLandGradient : absoluteLandGradient }} aria-hidden="true" />
                            {visibleExplorationMode === "adaptive" ? (
                              <div className="exploration-elevation-legend__values"><span>&lt; {formatElevation(visibleExplorationScale.minM)} m</span><span>&gt; {formatElevation(visibleExplorationScale.maxM)} m</span></div>
                            ) : (
                              <div className="exploration-elevation-legend__values"><span>0 m</span><span>1 500 m</span><span>≥ {formatElevation(ABSOLUTE_ELEVATION_MAX_M)} m</span></div>
                            )}
                          </div>
                        </div>
                        {adaptiveScaleFallback && <span className="elevation-legend-note exploration-elevation-legend__fallback">Muestra insuficiente; se mantiene la escala absoluta.</span>}
                      </div>
                    </>
                  )}
                  {!showExplorationHillshadeControls && !showExplorationElevationControls && (
                    <p className="topography-inline-note">Activa una capa para ajustar su representación.</p>
                  )}
                </div>
              </details>
            </section>

            <section className="terrain-area-section" aria-labelledby="prepared-terrain-title">
              <div className="terrain-area-heading"><span className="eyebrow" id="prepared-terrain-title">TERRENOS PREPARADOS</span></div>
            {selectedPreparedTerrain ? (
              <>
                <div className="active-terrain-card">
                  <div className="active-terrain-copy">
                    <strong>{selectedPreparedTerrain.result.coverage.area_name}</strong>
                    <span>{selectedPreparedTerrain.result.coverage.resolution_m} m · {selectedPreparedTerrain.visible ? "Visible" : "Oculto"}</span>
                  </div>
                  <div className="active-terrain-actions">
                    <Switch
                      checked={selectedPreparedTerrain.visible}
                      onCheckedChange={(visible) => setPreparedTerrainVisible(selectedPreparedTerrain.elementId, visible)}
                      aria-label={`${selectedPreparedTerrain.visible ? "Ocultar" : "Mostrar"} terreno de ${selectedPreparedTerrain.result.coverage.area_name}`}
                    />
                    <Button variant="ghost" size="small" onClick={() => centerPreparedTerrain(selectedPreparedTerrain.elementId)}>
                      <MapPinned size={14} aria-hidden="true" /> Centrar
                    </Button>
                  </div>
                </div>
                <div className="topographic-layer-list">
                  {TOPOGRAPHIC_LAYER_OPTIONS.filter(([id]) => id === "hillshade" || id === "elevation" || Boolean(regionalDerivatives)).map(([id, Icon]) => {
                    const layer = TOPOGRAPHIC_LAYERS[id];
                    const isVisible = selectedPreparedTerrain.visibility[id];
                    return (
                      <div className="topographic-layer-card" key={id}>
                        <div className="overlay-layer-row topographic-layer-row">
                          <span className={`overlay-symbol topographic-symbol topographic-symbol--${id}`} aria-hidden="true"><Icon size={16} /></span>
                          <span className="layer-copy"><span className="layer-title">{layer.title}</span></span>
                          <Switch
                            checked={isVisible}
                            onCheckedChange={(visible) => setPreparedTerrainLayerVisible(selectedPreparedTerrain.elementId, id, visible)}
                            aria-label={`${isVisible ? "Ocultar" : "Mostrar"} ${layer.title.toLowerCase()}`}
                          />
                        </div>
                        {!selectedPreparedTerrain.availability[id] && <span className="topographic-layer-error" role="status">No disponible</span>}
                      </div>
                    );
                  })}
                </div>
                <details className="terrain-region-adjustments">
                  <summary>Opacidad y leyendas</summary>
                  <div className="terrain-region-adjustments__content">
                    {TOPOGRAPHIC_LAYER_OPTIONS.filter(([id]) => selectedPreparedTerrain.visibility[id]).map(([id]) => (
                      <label className="topographic-opacity" htmlFor={`terrain-${selectedPreparedTerrain.elementId}-${id}-opacity`} key={id}>
                        <span>Opacidad · {TOPOGRAPHIC_LAYERS[id].title}</span>
                        <output htmlFor={`terrain-${selectedPreparedTerrain.elementId}-${id}-opacity`}>{selectedPreparedTerrain.opacity[id]} %</output>
                        <input id={`terrain-${selectedPreparedTerrain.elementId}-${id}-opacity`} type="range" min="0" max="100" step="5" value={selectedPreparedTerrain.opacity[id]} onChange={(event) => setPreparedTerrainOpacity(selectedPreparedTerrain.elementId, id, Number(event.currentTarget.value))} aria-label={`Opacidad de ${TOPOGRAPHIC_LAYERS[id].title.toLowerCase()}`} />
                      </label>
                    ))}
                    {selectedPreparedTerrain.visibility.slope && regionalDerivatives && (
                      <div className="derivative-legend" aria-label="Leyenda de pendientes en porcentaje">
                        <span className="elevation-legend-title">Pendiente</span>
                        <div className="derivative-legend-grid">{regionalDerivatives.slope.legend.map((item) => <span className="derivative-legend-item" key={item.id}><i style={{ backgroundColor: item.color }} aria-hidden="true" />{item.label}</span>)}</div>
                      </div>
                    )}
                    {selectedPreparedTerrain.visibility.aspect && regionalDerivatives && (
                      <div className="derivative-legend" aria-label="Leyenda de orientación de laderas">
                        <span className="elevation-legend-title">Orientación</span>
                        <div className="derivative-legend-grid derivative-legend-grid--aspect">{regionalDerivatives.aspect.legend.map((item) => <span className="derivative-legend-item" key={item.id} title={item.label} aria-label={item.label}><i style={{ backgroundColor: item.color }} aria-hidden="true" />{item.direction}</span>)}</div>
                        <span className="derivative-legend-note">Norte de cuadrícula · las zonas planas no tienen orientación.</span>
                      </div>
                    )}
                    {selectedPreparedTerrain.visibility.elevation && (
                      <div className="elevation-legend" aria-label={`Leyenda de elevación de ${selectedPreparedTerrain.result.coverage.area_name} en metros`}>
                        <span className="elevation-legend-title">Elevación · metros</span>
                        <div className="elevation-legend-gradient" style={regionalElevationGradient ? { background: regionalElevationGradient } : undefined} />
                        {regionalElevationStyle && <div className="elevation-legend-values"><span>{formatElevation(regionalElevationStyle.min_m)} m</span><span>{formatElevation((regionalElevationStyle.min_m + regionalElevationStyle.max_m) / 2)} m</span><span>{formatElevation(regionalElevationStyle.max_m)} m</span></div>}
                        <span className="elevation-legend-note">La escala se ajusta a esta área.</span>
                      </div>
                    )}
                    {activeTerrainOverzoomFactor !== null && activeTerrainOverzoomFactor > 2 && <p className="terrain-resolution-note">El zoom por encima de 30 m no añade detalle.</p>}
                    {!TOPOGRAPHIC_LAYER_OPTIONS.some(([id]) => selectedPreparedTerrain.visibility[id]) && <p className="topography-inline-note">Activa una capa para ajustar su opacidad.</p>}
                  </div>
                </details>
              </>
            ) : (
              <p className="topography-inline-note">Selecciona un terreno preparado para ver sus capas.</p>
            )}
            </section>
            <details className="terrain-advanced">
              <summary>Más opciones y fuentes</summary>
              <details className="terrain-global-controls">
                <summary>ETOPO · relieve de menor resolución</summary>
                <div className="topographic-layer-list">
                  {TOPOGRAPHIC_LAYER_OPTIONS.filter(([id]) => id === "hillshade" || id === "elevation").map(([id, Icon]) => {
                    const layer = TOPOGRAPHIC_LAYERS[id];
                    const opacityId = `global-${id}-opacity`;
                    return <div className="topographic-layer-card" key={id}>
                      <div className="overlay-layer-row topographic-layer-row">
                        <span className={`overlay-symbol topographic-symbol topographic-symbol--${id}`} aria-hidden="true"><Icon size={16} /></span>
                        <span className="layer-copy"><span className="layer-title">{layer.title}</span></span>
                        <Switch checked={topographicVisibility[id]} disabled={terrainServiceState !== "available" || topographicBasemapActive} onCheckedChange={(visible) => changeTopographicVisibility(id, visible)} aria-label={`${topographicVisibility[id] ? "Ocultar" : "Mostrar"} relieve mundial`} />
                      </div>
                      {topographicVisibility[id] && <label className="topographic-opacity" htmlFor={opacityId}><span>Opacidad</span><output htmlFor={opacityId}>{topographicOpacity[id]} %</output><input id={opacityId} type="range" min="0" max="100" step="5" value={topographicOpacity[id]} onChange={(event) => changeTopographicOpacity(id, Number(event.currentTarget.value))} aria-label={`Opacidad de ${layer.title.toLowerCase()}`} /></label>}
                      {topographicVisibility[id] && !topographicAvailability[id] && <p className="topographic-layer-error" role="status">No disponible</p>}
                    </div>;
                  })}
                </div>
                {topographicBasemapActive && <p className="terrain-coverage-note">ETOPO está en pausa mientras Topográfico muestra el relieve Mapzen.</p>}
                {!topographicBasemapActive && topographicVisibility.hillshade && suppressGlobalHillshade && <p className="terrain-coverage-note">ETOPO se oculta mientras otro relieve está activo.</p>}
                {topographicVisibility.elevation && terrainCoverage && terrainRenderMode !== "hidden" && <div className="elevation-legend"><span className="elevation-legend-title">Elevación mundial · metros</span><div className="elevation-legend-values"><span>{Math.round(terrainCoverage.minElevation)} m</span><span>0 m</span><span>{Math.round(terrainCoverage.maxElevation)} m</span></div></div>}
                {terrainServiceState === "unavailable" && <p className="terrain-coverage-note terrain-coverage-note--error">Relieve mundial no disponible; las áreas preparadas siguen funcionando.</p>}
                {terrainServiceState === "available" && terrainCoverage && <p className="terrain-coverage-note">{!hasTopographicPreference ? "Relieve mundial desactivado." : terrainRenderMode === "hidden" ? "Oculto por escala." : terrainRenderMode === "detailed" ? "Copernicus 30 m disponible." : hasDetailedCoverageForView ? "ETOPO 60″ visible; el detalle aumenta al acercar." : "ETOPO 60″ visible; sin cobertura detallada en esta vista."}</p>}
              </details>
              <details className="terrain-source-details">
                <summary>Fuentes, licencias y datos</summary>
                <div className="copernicus-notice">
                  <span>ETOPO 2022 · NOAA NCEI · DOI: 10.25921/fd45-gt74 · CC0 1.0.</span>
                  <a href="https://www.ncei.noaa.gov/products/etopo-global-relief-model" target="_blank" rel="noreferrer">Documentación de NOAA</a>
                </div>
                <div className="copernicus-notice">
                  <span>Mapzen Terrain Tiles · Terrarium · mosaico de fuentes abiertas.</span>
                  <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">Fuentes y atribución de Mapzen</a>
                </div>
                <div className="copernicus-notice">
                  <span>© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.</span>
                  <span>Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.</span>
                  <span>The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.</span>
                  <a href="https://dataspace.copernicus.eu/sites/default/files/media/files/2025-06/copernicus_contributing_mission_data_access_v2_cop_dem_licenses.pdf" target="_blank" rel="noreferrer">Licencia de Copernicus DEM</a>
                </div>
              </details>
            </details>
          </details>
            </>
          )}

          {panelTab === "areas" && <DrawnElementsList
            elements={drawingTools.elements}
            selectedIds={drawingTools.selectedIds}
            onFocus={focusElement}
            onRename={drawingTools.renameElement}
            onDelete={drawingTools.deleteElement}
            terrainJobs={terrainJobs.jobs}
            preparedTerrains={preparedTerrains}
            onToggleTerrain={setPreparedTerrainVisible}
            onCenterTerrain={centerPreparedTerrain}
          />}

          {panelTab === "analysis" && (drawingTools.selectedElementInfo ? <GeometryDetails
            element={drawingTools.selectedElementInfo}
            onRename={drawingTools.renameElement}
            terrainPreparation={selectedTerrainPreparation}
            preparedTerrain={selectedPreparedTerrain}
            onPrepareTerrain={handlePrepareTerrain}
            onShowPreparedTerrain={showPreparedTerrain}
            onSetTerrainVisible={setPreparedTerrainVisible}
            onCenterPreparedTerrain={centerPreparedTerrain}
            onPrepareDerivatives={(id, jobId) => void handlePrepareDerivatives(id, jobId)}
          /> : (
            <div className="panel-empty-state">
              <MapPinned size={20} aria-hidden="true" />
              <strong>Selecciona un elemento</strong>
              <span>Sus medidas y opciones aparecerán aquí.</span>
            </div>
          ))}
          </div>

          <div
            className="panel-resize-handle"
            role="separator"
            aria-label="Redimensionar panel lateral"
            aria-orientation="vertical"
            aria-valuemin={260}
            aria-valuemax={460}
            aria-valuenow={panelWidth}
            tabIndex={0}
            onPointerDown={(event) => {
              panelResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: panelWidth };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = panelResizeRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              setPanelWidth(Math.max(260, Math.min(460, Math.min(window.innerWidth * 0.44, drag.startWidth + event.clientX - drag.startX))));
            }}
            onPointerUp={() => { panelResizeRef.current = null; }}
            onPointerCancel={() => { panelResizeRef.current = null; }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setPanelWidth((width) => Math.max(260, Math.min(460, width + (event.key === "ArrowRight" ? 16 : -16))));
            }}
          />
        </aside>

        <section
          ref={mapStageRef}
          className={`map-stage${drawingTools.activeTool === "navigate" ? " map-stage--exploring" : ""}`}
          aria-label="Visor cartográfico"
          onContextMenu={handleStageContextMenu}
        >
          <MapView
            baseMap={baseMap}
            mapRef={mapRef}
            baseLayersRef={baseLayersRef}
            drawingsLayer={drawingTools.layer}
            measurementsLayer={drawingTools.measurementLayer}
            preparedTerrains={preparedTerrainEntries}
            explorationTerrainEnabled={explorationTerrainEnabled}
            explorationTerrainOpacity={explorationTerrainOpacity}
            explorationElevationEnabled={explorationElevationEnabled}
            explorationElevationOpacity={explorationElevationOpacity}
            explorationElevationMode={explorationElevationMode}
            explorationElevationScale={explorationElevationScale}
            explorationElevationScaleRefresh={explorationElevationScaleRefresh}
            regionalHillshadeVisible={hasVisibleRegionalHillshade}
            onStatusChange={handleMapStatus}
            onQgisStatusChange={handleQgisStatusChange}
            onOpenFreeMapStatusChange={handleOpenFreeMapStatusChange}
            onOverlayAvailabilityChange={handleOverlayAvailabilityChange}
            onTopographicAvailabilityChange={handleTopographicAvailabilityChange}
            onExplorationTerrainStatusChange={handleExplorationTerrainStatusChange}
            onExplorationTerrainVisibilityChange={handleExplorationTerrainVisibilityChange}
            onExplorationElevationScaleChange={handleExplorationElevationScaleChange}
            onPreparedTerrainAvailabilityChange={handlePreparedTerrainAvailabilityChange}
            onMapReady={drawingTools.connectMap}
            onCenterChange={handleMapCenterChange}
          />

          <DrawingToolbar
            activeTool={drawingTools.activeTool}
            selectedCount={drawingTools.selectedIds.length}
            drawingInProgress={drawingTools.drawingInProgress}
            measurementResult={drawingTools.measurementResult}
            onToolChange={drawingTools.setActiveTool}
            onCancel={drawingTools.cancelDrawing}
            onClearMeasurements={drawingTools.clearMeasurements}
            onFinishTrace={drawingTools.finishTrace}
            canFinishTrace={drawingTools.canFinishTrace}
            canUndoVertex={drawingTools.canUndoVertex}
            onUndoVertex={drawingTools.undoLastVertex}
            onDelete={drawingTools.deleteSelected}
          />

          {drawingTools.traceContextMenu && (
            <div
              ref={traceMenuRef}
              className="trace-context-menu"
              role="menu"
              aria-label={drawingTools.traceContextMenu.measurement ? "Acciones de medición" : "Acciones del trazado"}
              style={{
                left: Math.max(8, Math.min(drawingTools.traceContextMenu.x, (mapStageRef.current?.clientWidth ?? 260) - 232)),
                top: Math.max(8, Math.min(drawingTools.traceContextMenu.y, (mapStageRef.current?.clientHeight ?? 220) - 212)),
              }}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])"));
                const index = items.indexOf(document.activeElement as HTMLElement);
                const step = event.key === "ArrowDown" ? 1 : -1;
                const nextIndex = index < 0
                  ? (step > 0 ? 0 : items.length - 1)
                  : (index + step + items.length) % items.length;
                items[nextIndex]?.focus();
              }}
            >
              <span className="trace-context-menu-title">
                {drawingTools.traceContextMenu.measurement ? "Medición en curso" : "Trazado en curso"}
              </span>
              <Button role="menuitem" variant="ghost" size="small" disabled={!drawingTools.canFinishTrace} onClick={drawingTools.finishTrace}>
                <Check size={15} aria-hidden="true" />
                <span>Finalizar {drawingTools.traceContextMenu.measurement ? "medición" : "trazado"}</span>
              </Button>
              <Button role="menuitem" variant="ghost" size="small" disabled={!drawingTools.canUndoVertex} onClick={drawingTools.undoLastVertex}>
                <CornerUpLeft size={15} aria-hidden="true" />
                <span>Deshacer último {drawingTools.traceContextMenu.measurement ? "punto" : "vértice"}</span>
              </Button>
              <Button role="menuitem" variant="ghost" size="small" onClick={drawingTools.continueTrace}>
                <Play size={15} aria-hidden="true" />
                <span>Continuar {drawingTools.traceContextMenu.measurement ? "medición" : "trazado"}</span>
              </Button>
              <Button role="menuitem" variant="ghost" size="small" className="trace-context-menu-cancel" onClick={drawingTools.cancelDrawing}>
                <X size={15} aria-hidden="true" />
                <span>Cancelar {drawingTools.traceContextMenu.measurement ? "medición" : "trazado"}</span>
              </Button>
            </div>
          )}

          <div className="map-location-chip">
            <MapPin size={15} aria-hidden="true" />
            <span>Centro del mapa</span>
            <span className="map-center-coordinates">
              {formatCoordinate(mapCenter[1], "N", "S")}, {formatCoordinate(mapCenter[0], "E", "O")}
            </span>
          </div>

          <div className="map-controls" aria-label="Controles del mapa">
            <Button
              variant="map"
              size="icon"
              aria-label="Acercar mapa"
              title="Acercar"
              onClick={() => changeZoom(1)}
            >
              <Plus size={18} />
            </Button>
            <Button
              variant="map"
              size="icon"
              aria-label="Alejar mapa"
              title="Alejar"
              onClick={() => changeZoom(-1)}
            >
              <Minus size={18} />
            </Button>
            <span className="control-divider" aria-hidden="true" />
            <Button
              variant="map"
              size="icon"
              aria-label="Volver a Creta"
              title="Volver a Creta"
              onClick={resetView}
            >
              <MapPin size={17} />
            </Button>
          </div>

          {mapStatus.loading && !mapStatus.ready && (
            <div className="map-status map-status--loading" role="status">
              <LoaderCircle size={15} className="spinner" aria-hidden="true" />
              <span>Cargando el mapa…</span>
            </div>
          )}
          {mapStatus.error && (
            <div className="map-status map-status--error" role="alert">
              No se pudieron cargar algunas teselas. Comprueba tu conexión.
            </div>
          )}
          {selectedVectorBaseMap && selectedVectorStatus === "loading" && (
            <div className="map-status map-status--loading" role="status">
              <LoaderCircle size={15} className="spinner" aria-hidden="true" />
              <span>Cargando el mapa {OPEN_FREE_MAP_STYLES[selectedVectorBaseMap].title.toLowerCase()}…</span>
            </div>
          )}
          {baseMapNotice && (
            <div className="map-status map-status--error" role="status">
              {baseMapNotice}
            </div>
          )}
          {baseMap === "osm" && qgisStatus === "error" && (
            <div className="map-status map-status--error qgis-unavailable-notice" role="status">
              La cartografía QGIS no está disponible. OpenStreetMap sigue activo.
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
