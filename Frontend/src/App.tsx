import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Check,
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
  Waves,
  X,
} from "lucide-react";
import { fromLonLat } from "ol/proj.js";
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
import type { TerrainPreparationView } from "@/lib/terrain-preparation";
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

type ThemeMode = "light" | "dark";
type PanelTab = "layers" | "areas";
type AreaPanelView = "list" | "detail";

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

function explorationTerrainStatusMessage(status: ExplorationTerrainStatus, zoom: number): string {
  if (status === "disabled") return "Relieve desactivado.";
  if (status === "scale") return "Acércate para mostrar el relieve.";
  if (status === "loading") return "Cargando relieve…";
  if (status === "active") return "Relieve activo.";
  if (status === "overzoom") return "Mostrando el detalle máximo disponible.";
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
  const [areaPanelView, setAreaPanelView] = useState<AreaPanelView>("list");
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
  const [explorationTerrainEnabled, setExplorationTerrainEnabled] = useState(initialExplorationHillshadeEnabled);
  const [explorationElevationEnabled, setExplorationElevationEnabled] = useState(initialExplorationElevationEnabled);
  const [explorationElevationMode, setExplorationElevationMode] = useState<ExplorationElevationMode>(initialExplorationElevationMode);
  const [explorationTerrainOpacity, setExplorationTerrainOpacity] = useState<number>(EXPLORATION_TERRAIN.defaultHillshadeOpacity);
  const [explorationElevationOpacity, setExplorationElevationOpacity] = useState<number>(EXPLORATION_TERRAIN.defaultElevationOpacity);
  const [explorationElevationScale, setExplorationElevationScale] = useState<ExplorationElevationScale>(
    () => absoluteElevationScale(initialExplorationElevationMode()),
  );
  const [explorationElevationScaleRefresh, setExplorationElevationScaleRefresh] = useState(0);
  const [explorationTerrainStatus, setExplorationTerrainStatus] = useState<ExplorationTerrainStatus>("loading");
  const terrainRequestRevisionsRef = useRef(new globalThis.Map<string, number>());
  const [mapZoom, setMapZoom] = useState(8.2);
  const [qgisStatus, setQgisStatus] = useState<QgisStatus>("idle");
  const [mapStatus, setMapStatus] = useState<MapStatus>({
    ready: false,
    loading: true,
    error: false,
  });
  const [mapCenter, setMapCenter] = useState<[number, number]>([...CRETE_CENTER]);

  baseMapRef.current = baseMap;

  const handleMapStatus = useCallback((status: MapStatus) => {
    setMapStatus(status);
  }, []);

  const handleMapCenterChange = useCallback((
    center: [number, number],
    _extent: [number, number, number, number],
    _resolution: number,
    zoom: number,
  ) => {
    setMapCenter(center);
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

  const handleExplorationElevationScaleChange = useCallback((scale: ExplorationElevationScale) => {
    setExplorationElevationScale((current) => current.requestedMode === scale.requestedMode
      && current.effectiveMode === scale.effectiveMode
      && current.minM === scale.minM
      && current.maxM === scale.maxM
      && current.sampleCount === scale.sampleCount
      ? current
      : scale);
  }, []);

  const handlePrepareTerrain = useCallback((elementId: string, areaName: string, bbox: [number, number, number, number]) => {
    const geometry = drawingTools.layer.getSource()?.getFeatureById(elementId)?.getGeometry();
    if (!(geometry instanceof Polygon)) return;
    terrainRequestRevisionsRef.current.set(elementId, geometry.getRevision());
    void terrainJobs.prepareTerrain(elementId, areaName, bbox);
  }, [drawingTools.layer, terrainJobs.prepareTerrain]);

  const handlePrepareDerivatives = useCallback(async (elementId: string, jobId: string) => {
    const geometry = drawingTools.layer.getSource()?.getFeatureById(elementId)?.getGeometry();
    const expectedRevision = terrainRequestRevisionsRef.current.get(elementId);
    if (!(geometry instanceof Polygon) || expectedRevision === undefined || geometry.getRevision() !== expectedRevision) return;
    await terrainJobs.prepareDerivatives(elementId, jobId);
  }, [drawingTools.layer, terrainJobs.prepareDerivatives]);

  const handleOverlayAvailabilityChange = useCallback((id: GeographicOverlayId, available: boolean) => {
    setOverlayAvailability((current) => current[id] === available ? current : { ...current, [id]: available });
  }, []);

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
  const explorationStatusMessage = explorationTerrainStatusMessage(explorationTerrainStatus, mapZoom);
  const formatElevation = (value: number) => Math.round(value).toLocaleString("es-ES");
  const absoluteLandGradient = elevationGradient(ABSOLUTE_ELEVATION_STOPS, 0, ABSOLUTE_ELEVATION_MAX_M);
  const oceanExplorationGradient = elevationGradient(OCEAN_ELEVATION_STOPS, ABSOLUTE_ELEVATION_MIN_M, 0);
  const adaptiveLandGradient = `linear-gradient(90deg, ${ADAPTIVE_LAND_STOPS.map((stop) => (
    `${stop.color} ${(stop.position * 100).toFixed(2)}%`
  )).join(", ")})`;
  const visibleExplorationScale = explorationElevationScale;
  const visibleExplorationMode = visibleExplorationScale.effectiveMode;
  const visibleExplorationRequestedMode = visibleExplorationScale.requestedMode;
  const adaptiveScaleFallback = visibleExplorationScale.requestedMode === "adaptive"
    && visibleExplorationScale.effectiveMode !== "adaptive";

  useEffect(() => {
    if (!selectedElement) return;
    setPanelTab("areas");
    setAreaPanelView("detail");
    setPanelOpen(true);
  }, [selectedElement]);

  useEffect(() => {
    const source = drawingTools.layer.getSource();
    const invalidIds = new Set<string>();
    terrainRequestRevisionsRef.current.forEach((revision, id) => {
      const geometry = source?.getFeatureById(id)?.getGeometry();
      if (!(geometry instanceof Polygon) || geometry.getRevision() !== revision) invalidIds.add(id);
    });
    invalidIds.forEach((id) => {
      terrainRequestRevisionsRef.current.delete(id);
      terrainJobs.removeJob(id);
    });
  }, [drawingTools.elements, drawingTools.layer, terrainJobs.removeJob]);

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

  const openAreaDetails = (id: string) => {
    setPanelTab("areas");
    setAreaPanelView("detail");
    setPanelOpen(true);
    focusElement(id);
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
              <h1>{panelTab === "areas" ? "Áreas" : "Capas"}</h1>
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
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                id={`panel-tab-${tab}`}
                type="button"
                role="tab"
                aria-selected={panelTab === tab}
                aria-controls="panel-tab-content"
                tabIndex={panelTab === tab ? 0 : -1}
                onClick={() => {
                  setPanelTab(tab);
                  if (tab === "areas") setAreaPanelView("list");
                }}
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
                <span className={`topography-state topography-state--${explorationTerrainStatus}`}>{explorationStatusMessage}</span>
              </div>
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

              <details className="topography-display-settings">
                <summary>Ajustes y leyenda</summary>
                <div className="topography-display-settings__content">
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
                  {explorationElevationEnabled && (
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
                  )}
                </div>
              </details>
            </section>
          </details>
            </>
          )}

          {panelTab === "areas" && (areaPanelView === "list" || !selectedElement ? <DrawnElementsList
            elements={drawingTools.elements}
            selectedIds={drawingTools.selectedIds}
            onFocus={openAreaDetails}
            onRename={drawingTools.renameElement}
            onDelete={drawingTools.deleteElement}
            terrainJobs={terrainJobs.jobs}
          /> : <GeometryDetails
            element={selectedElement}
            onBackToList={() => setAreaPanelView("list")}
            onRename={drawingTools.renameElement}
            terrainPreparation={selectedTerrainPreparation}
            onPrepareTerrain={handlePrepareTerrain}
            onPrepareDerivatives={(id, jobId) => void handlePrepareDerivatives(id, jobId)}
          />)}
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
            explorationTerrainEnabled={explorationTerrainEnabled}
            explorationTerrainOpacity={explorationTerrainOpacity}
            explorationElevationEnabled={explorationElevationEnabled}
            explorationElevationOpacity={explorationElevationOpacity}
            explorationElevationMode={explorationElevationMode}
            explorationElevationScale={explorationElevationScale}
            explorationElevationScaleRefresh={explorationElevationScaleRefresh}
            onStatusChange={handleMapStatus}
            onQgisStatusChange={handleQgisStatusChange}
            onOpenFreeMapStatusChange={handleOpenFreeMapStatusChange}
            onOverlayAvailabilityChange={handleOverlayAvailabilityChange}
            onExplorationTerrainStatusChange={handleExplorationTerrainStatusChange}
            onExplorationElevationScaleChange={handleExplorationElevationScaleChange}
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
