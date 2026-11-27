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
  Sun,
  Waves,
  X,
} from "lucide-react";
import { fromLonLat, transformExtent } from "ol/proj.js";
import Polygon from "ol/geom/Polygon.js";
import type OlMap from "ol/Map.js";
import MapView, { type BaseMapId, type BaseMapLayers, type MapStatus, type QgisStatus } from "@/components/MapView";
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

type ThemeMode = "light" | "dark";

function initialTheme(): ThemeMode {
  try {
    return window.localStorage.getItem("cv-gis-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
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
  const [baseMap, setBaseMap] = useState<BaseMapId>("osm");
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
  });
  const [terrainCoverage, setTerrainCoverage] = useState<TerrainCoverage | null>(null);
  const [activePreparedTerrain, setActivePreparedTerrain] = useState<{
    elementId: string;
    result: TerrainPreparationResult;
    geometryRevision: number;
  } | null>(null);
  const activePreparedTerrainRef = useRef<typeof activePreparedTerrain>(null);
  const previousTopographicVisibilityRef = useRef<TopographicVisibility | null>(null);
  const topographicVisibilityRef = useRef(topographicVisibility);
  const displayedTerrainJobsRef = useRef(new Set<string>());
  const [terrainServiceState, setTerrainServiceState] = useState<"loading" | "available" | "unavailable">("loading");
  const [mapExtent, setMapExtent] = useState<[number, number, number, number] | null>(null);
  const [mapResolution, setMapResolution] = useState<number | null>(null);
  const [qgisStatus, setQgisStatus] = useState<QgisStatus>("idle");
  const [mapStatus, setMapStatus] = useState<MapStatus>({
    ready: false,
    loading: true,
    error: false,
  });
  const [mapCenter, setMapCenter] = useState<[number, number]>([...CRETE_CENTER]);

  activePreparedTerrainRef.current = activePreparedTerrain;
  topographicVisibilityRef.current = topographicVisibility;

  const handleMapStatus = useCallback((status: MapStatus) => {
    setMapStatus(status);
  }, []);

  const handleMapCenterChange = useCallback((
    center: [number, number],
    extent: [number, number, number, number],
    resolution: number,
  ) => {
    setMapCenter(center);
    setMapExtent(extent);
    setMapResolution(resolution);
  }, []);

  const handleQgisStatusChange = useCallback((status: QgisStatus) => {
    setQgisStatus(status);
    if (status !== "error") return;
    baseLayersRef.current?.qgis.setVisible(false);
    baseLayersRef.current?.osm.setVisible(true);
    setBaseMap("osm");
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
    baseLayersRef.current?.osm.setVisible(next === "osm");
    baseLayersRef.current?.qgis.setVisible(next === "qgis");
    setBaseMap(next);
    if (next === "qgis") setQgisStatus("loading");
  };

  const changeOverlayVisibility = (id: GeographicOverlayId, visible: boolean) => {
    baseLayersRef.current?.overlays[id].setVisible(visible);
    setOverlayVisibility((current) => ({ ...current, [id]: visible }));
  };

  const changeTopographicVisibility = (id: TopographicLayerId, visible: boolean) => {
    setTopographicVisibility((current) => ({ ...current, [id]: visible }));
  };

  const changeTopographicOpacity = (id: TopographicLayerId, opacity: number) => {
    baseLayersRef.current?.topography[id].setOpacity(opacity / 100);
    setTopographicOpacity((current) => ({ ...current, [id]: opacity }));
  };

  const activatePreparedTerrain = useCallback((elementId: string, result: TerrainPreparationResult) => {
    const feature = drawingTools.layer.getSource()?.getFeatureById(elementId);
    const geometry = feature?.getGeometry();
    if (!(geometry instanceof Polygon)) return;
    if (!activePreparedTerrainRef.current) {
      previousTopographicVisibilityRef.current = topographicVisibilityRef.current;
    }
    drawingTools.setTerrainFeatureId(elementId);
    const active = { elementId, result, geometryRevision: geometry.getRevision() };
    activePreparedTerrainRef.current = active;
    setActivePreparedTerrain(active);
    const visible = { hillshade: true, elevation: true };
    topographicVisibilityRef.current = visible;
    setTopographicVisibility(visible);
  }, [drawingTools.layer, drawingTools.setTerrainFeatureId]);

  const closePreparedTerrain = useCallback(() => {
    drawingTools.setTerrainFeatureId(null);
    activePreparedTerrainRef.current = null;
    setActivePreparedTerrain(null);
    const previous = previousTopographicVisibilityRef.current;
    previousTopographicVisibilityRef.current = null;
    if (previous) {
      topographicVisibilityRef.current = previous;
      setTopographicVisibility(previous);
    }
  }, [drawingTools.setTerrainFeatureId]);

  const centerPreparedTerrain = useCallback(() => {
    const active = activePreparedTerrainRef.current;
    const view = mapRef.current?.getView();
    if (!active || !view) return;
    const extent = transformExtent(
      active.result.coverage.extent_wgs84,
      "EPSG:4326",
      view.getProjection(),
      8,
    );
    view.fit(extent, { duration: 420, maxZoom: 13, padding: [84, 42, 84, 42] });
  }, []);

  const handlePrepareTerrain = useCallback((elementId: string, areaName: string, bbox: [number, number, number, number]) => {
    void terrainJobs.prepareTerrain(elementId, areaName, bbox);
  }, [terrainJobs.prepareTerrain]);

  const showPreparedTerrain = useCallback((elementId: string) => {
    const job = terrainJobs.jobs[elementId];
    if (job?.state === "completed" && job.result) activatePreparedTerrain(elementId, job.result);
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
  const detailedCoverageRatio = getTerrainCoverageRatio(mapExtent, terrainCoverage);
  const hasDetailedCoverageForView = detailedCoverageRatio >= TERRAIN_VISIBILITY_THRESHOLDS.detailedMinViewCoverageRatio;
  const hasTopographicPreference = topographicVisibility.hillshade || topographicVisibility.elevation;
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
  const selectedTerrainIsActive = Boolean(activePreparedTerrain && activePreparedTerrain.elementId === selectedElement?.id);
  const activeTerrainFeature = activePreparedTerrain
    ? drawingTools.layer.getSource()?.getFeatureById(activePreparedTerrain.elementId)
    : null;
  const activeTerrainGeometry = activeTerrainFeature?.getGeometry();
  const activeTerrainClipGeometry = activeTerrainGeometry instanceof Polygon ? activeTerrainGeometry : null;
  const regionalElevationStyle = activePreparedTerrain?.result.coverage.elevation_style;
  const regionalElevationGradient = regionalElevationStyle
    ? `linear-gradient(90deg, ${regionalElevationStyle.stops.map((stop) => (
      `${stop.color} ${(stop.position * 100).toFixed(2)}%`
    )).join(", ")})`
    : undefined;
  const formatElevation = (value: number) => Math.round(value).toLocaleString("es-ES");

  useEffect(() => {
    if (!activePreparedTerrain) return;
    if (
      !activeTerrainClipGeometry
      || activeTerrainClipGeometry.getRevision() !== activePreparedTerrain.geometryRevision
    ) closePreparedTerrain();
  }, [activePreparedTerrain, activeTerrainClipGeometry, closePreparedTerrain, drawingTools.elements]);

  useEffect(() => {
    const layers = baseLayersRef.current?.topography;
    if (!layers) return;

    (Object.keys(TOPOGRAPHIC_LAYERS) as TopographicLayerId[]).forEach((id) => {
      const layer = layers[id];
      const source = layer.getSource();
      if (!source) return;
      const shouldRender = !activePreparedTerrain && terrainServiceState === "available" && topographicVisibility[id] && terrainRenderMode !== "hidden";
      if (shouldRender) {
        const names = TOPOGRAPHIC_LAYERS[id];
        const requestedLayer = terrainRenderMode === "detailed" ? names.wmsLayer : names.globalWmsLayer;
        if (source.getParams().LAYERS !== requestedLayer) source.updateParams({ LAYERS: requestedLayer });
      }
      if (layer.getVisible() !== shouldRender) layer.setVisible(shouldRender);
    });
  }, [activePreparedTerrain, terrainRenderMode, terrainServiceState, topographicVisibility]);

  useEffect(() => {
    const layers = baseLayersRef.current?.regionalTopography;
    if (!layers) return;
    (Object.keys(TOPOGRAPHIC_LAYERS) as TopographicLayerId[]).forEach((id) => {
      const layer = layers[id];
      const source = layer.getSource();
      if (!source) return;
      if (activePreparedTerrain && activeTerrainClipGeometry) {
        source.updateParams({
          MAP: activePreparedTerrain.result.cartography.map_parameter,
          LAYERS: activePreparedTerrain.result.cartography.layers[id],
        });
        layer.setOpacity(topographicOpacity[id] / 100);
        if (layer.getVisible() !== topographicVisibility[id]) layer.setVisible(topographicVisibility[id]);
      } else if (layer.getVisible()) {
        layer.setVisible(false);
      }
    });
  }, [activePreparedTerrain, activeTerrainClipGeometry, topographicOpacity, topographicVisibility]);

  useEffect(() => {
    const selected = drawingTools.selectedElementInfo;
    if (!selected?.bboxWgs84) return;
    const job = terrainJobs.jobs[selected.id];
    if (job?.state !== "completed" || !job.result || !job.jobId) return;
    const sameExtent = selected.bboxWgs84.every((coordinate, index) => (
      Math.abs(coordinate - job.result!.coverage.extent_wgs84[index]) < 1e-7
    ));
    const displayKey = `${selected.id}:${job.jobId}`;
    if (!sameExtent || displayedTerrainJobsRef.current.has(displayKey)) return;
    displayedTerrainJobsRef.current.add(displayKey);
    activatePreparedTerrain(selected.id, job.result);
  }, [activatePreparedTerrain, drawingTools.selectedElementInfo, terrainJobs.jobs]);

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

      <main className={`workspace ${panelOpen ? "workspace--panel-open" : "workspace--panel-closed"}`}>
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
          <section className="layer-section" aria-labelledby="base-layers-title">
            <h2 className="eyebrow" id="base-layers-title">CAPA BASE</h2>
            <div className="base-map-options" role="radiogroup" aria-label="Mapa base">
              <button
                type="button"
                className="base-map-option"
                role="radio"
                aria-checked={baseMap === "osm"}
                onClick={() => changeBaseMap("osm")}
              >
                <span className="layer-symbol" aria-hidden="true"><Map size={18} /></span>
                <span className="layer-copy">
                  <span className="layer-title">OpenStreetMap</span>
                  <span className="layer-subtitle">Calles y lugares</span>
                </span>
                <span className={`base-map-indicator ${baseMap === "osm" ? "base-map-indicator--active" : ""}`} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="base-map-option"
                role="radio"
                aria-checked={baseMap === "qgis"}
                onClick={() => changeBaseMap("qgis")}
              >
                <span className="layer-symbol" aria-hidden="true"><Layers size={18} /></span>
                <span className="layer-copy">
                  <span className="layer-title">Crete Valley GIS</span>
                  <span className="layer-subtitle">
                    {qgisStatus === "available" ? "Cartografía propia · Natural Earth" : qgisStatus === "error" ? "Servicio no disponible" : "Mapa mundial · Natural Earth"}
                  </span>
                </span>
                <span className={`base-map-indicator ${baseMap === "qgis" ? "base-map-indicator--active" : ""}`} aria-hidden="true" />
              </button>
            </div>
          </section>

          <section className="layer-section thematic-layer-section" aria-labelledby="geographic-layers-title">
            <h2 className="eyebrow" id="geographic-layers-title">CAPAS GEOGRÁFICAS</h2>
            <p className="overlay-intro">Añade información al mapa sin cambiar su vista.</p>
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
                    <span className="layer-copy">
                      <span className="layer-title">{layer.title}</span>
                      <span className="layer-subtitle">
                        {overlayAvailability[id] ? layer.description : "No disponible en este momento"}
                      </span>
                    </span>
                    <Switch
                      checked={overlayVisibility[id]}
                      onCheckedChange={(visible) => changeOverlayVisibility(id, visible)}
                      aria-label={`${overlayVisibility[id] ? "Ocultar" : "Mostrar"} ${layer.title.toLowerCase()}`}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="layer-section topography-section" aria-labelledby="topography-title">
            <h2 className="eyebrow" id="topography-title">TOPOGRAFÍA</h2>
            <p className="overlay-intro">
              {activePreparedTerrain
                ? "El terreno preparado tiene prioridad. Al cerrarlo, vuelve el relieve mundial."
                : "La capa visible se ajusta a la escala y cobertura del mapa."}
            </p>
            {activePreparedTerrain && (
              <div className="active-terrain-card" role="status">
                <div className="active-terrain-copy">
                  <span className="eyebrow">TERRENO PREPARADO · {activePreparedTerrain.result.coverage.resolution_m} M</span>
                  <strong>{activePreparedTerrain.result.coverage.area_name}</strong>
                </div>
                <div className="active-terrain-actions">
                  <Button variant="outline" size="small" onClick={centerPreparedTerrain}>
                    <MapPinned size={14} aria-hidden="true" />
                    Centrar
                  </Button>
                  <Button variant="ghost" size="small" onClick={closePreparedTerrain}>
                    <X size={14} aria-hidden="true" />
                    Cerrar
                  </Button>
                </div>
              </div>
            )}
            <div className="topographic-layer-list">
              {([
                ["hillshade", Mountain],
                ["elevation", Layers],
              ] as const).map(([id, Icon]) => {
                const layer = TOPOGRAPHIC_LAYERS[id];
                const opacityId = `topographic-opacity-${id}`;
                return (
                  <div className="topographic-layer-card" key={id}>
                    <div className="overlay-layer-row topographic-layer-row">
                      <span className={`overlay-symbol topographic-symbol topographic-symbol--${id}`} aria-hidden="true">
                        <Icon size={16} />
                      </span>
                      <span className="layer-copy">
                        <span className="layer-title">{layer.title}</span>
                          <span className="layer-subtitle">
                            {activePreparedTerrain
                              ? `${activePreparedTerrain.result.coverage.resolution_m} m · ${activePreparedTerrain.result.coverage.horizontal_crs}`
                              : layer.description}
                          </span>
                      </span>
                      <Switch
                        checked={topographicVisibility[id]}
                        onCheckedChange={(visible) => changeTopographicVisibility(id, visible)}
                        aria-label={`${topographicVisibility[id] ? "Ocultar" : "Mostrar"} ${layer.title.toLowerCase()}`}
                      />
                    </div>
                    {topographicVisibility[id] && (
                      <label className="topographic-opacity" htmlFor={opacityId}>
                        <span>Opacidad</span>
                        <output htmlFor={opacityId}>{topographicOpacity[id]} %</output>
                        <input
                          id={opacityId}
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={topographicOpacity[id]}
                          onChange={(event) => changeTopographicOpacity(id, Number(event.currentTarget.value))}
                          aria-label={`Opacidad de ${layer.title.toLowerCase()}`}
                        />
                      </label>
                    )}
                    {topographicVisibility[id] && !topographicAvailability[id] && (
                      <p className="topographic-layer-error" role="status">Esta capa no está disponible ahora mismo.</p>
                    )}
                  </div>
                );
              })}
            </div>
            {topographicVisibility.elevation && (
              (activePreparedTerrain || (terrainCoverage && terrainRenderMode !== "hidden"))
            ) && (
              <div className="elevation-legend" aria-label="Leyenda de elevación en metros">
                <span className="elevation-legend-title">
                  {activePreparedTerrain ? "Elevación · escala adaptativa regional (m)" : "Elevación · altura y profundidad (m)"}
                </span>
                <div
                  className="elevation-legend-gradient"
                  style={regionalElevationGradient ? { background: regionalElevationGradient } : undefined}
                  aria-label={regionalElevationStyle
                    ? `Interpolación lineal RGB: ${regionalElevationStyle.stops.map((stop) => `${formatElevation(stop.value_m)} m ${stop.color}`).join(", ")}`
                    : undefined}
                  title={regionalElevationStyle
                    ? `Escala ${formatElevation(regionalElevationStyle.min_m)}–${formatElevation(regionalElevationStyle.max_m)} m`
                    : undefined}
                  aria-hidden={!regionalElevationStyle}
                />
                <div className="elevation-legend-values">
                  {regionalElevationStyle ? (
                    <>
                      <span>{formatElevation(regionalElevationStyle.min_m)} m</span>
                      <span>{formatElevation((regionalElevationStyle.min_m + regionalElevationStyle.max_m) / 2)} m</span>
                      <span>{formatElevation(regionalElevationStyle.max_m)} m</span>
                    </>
                  ) : (
                    <>
                      <span>{Math.round(terrainCoverage!.minElevation)} m</span>
                      <span>0 m</span>
                      <span>{Math.round(terrainCoverage!.maxElevation)} m</span>
                    </>
                  )}
                </div>
                {regionalElevationStyle && (
                  <span className="elevation-legend-data-range">
                    Datos válidos: {formatElevation(regionalElevationStyle.data_min_m)}–{formatElevation(regionalElevationStyle.data_max_m)} m
                  </span>
                )}
              </div>
            )}
            {activePreparedTerrain ? (
              <p className="terrain-coverage-note" role="status">
                Escala ajustada a esta región; los colores no son comparables entre zonas. Elevación y sombreado se controlan por separado.
              </p>
            ) : terrainServiceState === "loading" && (
              <p className="terrain-coverage-note" role="status">Comprobando los datos topográficos preparados…</p>
            )}
            {!activePreparedTerrain && terrainServiceState === "unavailable" && (
              <p className="terrain-coverage-note terrain-coverage-note--error" role="status">
                El servicio de elevación no está disponible. El mapa base y las herramientas siguen funcionando.
              </p>
            )}
            {!activePreparedTerrain && terrainServiceState === "available" && terrainCoverage && (
              <p className="terrain-coverage-note" role="status">
                {!hasTopographicPreference
                  ? "Relieve desactivado."
                  : terrainRenderMode === "detailed"
                    ? "Relieve detallado activo · 30 m."
                    : terrainRenderMode === "global"
                      ? hasDetailedCoverageForView
                        ? "Relieve mundial activo · 60″. El detalle aparece al acercar."
                        : "Relieve mundial activo · 60″. Sin cobertura detallada suficiente en esta vista."
                      : hasDetailedCoverageForView
                        ? "Relieve oculto por escala; se mantiene el mapa base."
                        : "Sin cobertura detallada suficiente; el relieve se oculta y se mantiene el mapa base."}
              </p>
            )}
            <div className="copernicus-notice">
              <span>ETOPO 2022 · NOAA NCEI · DOI: 10.25921/fd45-gt74 · CC0 1.0.</span>
              <a href="https://www.ncei.noaa.gov/products/etopo-global-relief-model" target="_blank" rel="noreferrer">Fuente y documentación NOAA</a>
            </div>
            <div className="copernicus-notice">
              <span>© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.</span>
              <span>Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.</span>
              <span>The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.</span>
              <a href="https://dataspace.copernicus.eu/sites/default/files/media/files/2025-06/copernicus_contributing_mission_data_access_v2_cop_dem_licenses.pdf" target="_blank" rel="noreferrer">Licencia de Copernicus DEM</a>
            </div>
          </section>

          <DrawnElementsList
            elements={drawingTools.elements}
            selectedIds={drawingTools.selectedIds}
            onFocus={focusElement}
          />
          <GeometryDetails
            element={drawingTools.selectedElementInfo}
            onRename={drawingTools.renameElement}
            terrainPreparation={selectedTerrainPreparation}
            terrainIsActive={selectedTerrainIsActive}
            onPrepareTerrain={handlePrepareTerrain}
            onShowPreparedTerrain={showPreparedTerrain}
            onClosePreparedTerrain={closePreparedTerrain}
            onCenterPreparedTerrain={centerPreparedTerrain}
          />

          <div className="panel-spacer" />
          <div className="panel-attribution">
            <span>Fuente cartográfica</span>
            <a
              href={baseMap === "osm" ? "https://www.openstreetmap.org/copyright" : "https://www.naturalearthdata.com/about/terms-of-use/"}
              target="_blank"
              rel="noreferrer"
            >
              {baseMap === "osm" ? "© OpenStreetMap contributors" : "Made with Natural Earth"}
            </a>
          </div>
        </aside>

        <section
          ref={mapStageRef}
          className="map-stage"
          aria-label="Visor cartográfico"
          onContextMenu={handleStageContextMenu}
        >
          <MapView
            mapRef={mapRef}
            baseLayersRef={baseLayersRef}
            drawingsLayer={drawingTools.layer}
            measurementsLayer={drawingTools.measurementLayer}
            terrainClipGeometry={activeTerrainClipGeometry}
            onStatusChange={handleMapStatus}
            onQgisStatusChange={handleQgisStatusChange}
            onOverlayAvailabilityChange={handleOverlayAvailabilityChange}
            onTopographicAvailabilityChange={handleTopographicAvailabilityChange}
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
          {qgisStatus === "error" && (
            <div className="map-status map-status--error qgis-unavailable-notice" role="status">
              La cartografía QGIS no está disponible. OpenStreetMap sigue activo.
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
