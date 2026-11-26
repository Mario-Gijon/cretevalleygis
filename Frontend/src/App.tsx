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
import { fromLonLat } from "ol/proj.js";
import type OlMap from "ol/Map.js";
import MapView, { type BaseMapId, type BaseMapLayers, type MapStatus, type QgisStatus } from "@/components/MapView";
import { DrawnElementsList } from "@/components/DrawnElementsList";
import { GeometryDetails } from "@/components/GeometryDetails";
import { DrawingToolbar } from "@/components/DrawingToolbar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDrawingTools } from "@/hooks/useDrawingTools";
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
  DETAILED_TERRAIN_MAX_RESOLUTION,
  TOPOGRAPHIC_LAYERS,
  parseTerrainCoverage,
  type TerrainCoverage,
  type TopographicAvailability,
  type TopographicLayerId,
  type TopographicOpacity,
  type TopographicVisibility,
} from "@/lib/topographic-layers";

type ThemeMode = "light" | "dark";

function initialTheme(): ThemeMode {
  try {
    return window.localStorage.getItem("cv-gis-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function extentsIntersect(
  view: [number, number, number, number],
  coverage: [number, number, number, number],
): boolean {
  return view[0] <= coverage[2] && view[2] >= coverage[0] && view[1] <= coverage[3] && view[3] >= coverage[1];
}

export default function App() {
  const mapStageRef = useRef<HTMLElement | null>(null);
  const traceMenuRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<OlMap | null>(null);
  const baseLayersRef = useRef<BaseMapLayers | null>(null);
  const drawingTools = useDrawingTools();
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
    baseLayersRef.current?.topography[id].setVisible(visible);
    setTopographicVisibility((current) => ({ ...current, [id]: visible }));
  };

  const changeTopographicOpacity = (id: TopographicLayerId, opacity: number) => {
    baseLayersRef.current?.topography[id].setOpacity(opacity / 100);
    setTopographicOpacity((current) => ({ ...current, [id]: opacity }));
  };

  const handleOverlayAvailabilityChange = useCallback((id: GeographicOverlayId, available: boolean) => {
    setOverlayAvailability((current) => current[id] === available ? current : { ...current, [id]: available });
  }, []);

  const handleTopographicAvailabilityChange = useCallback((id: TopographicLayerId, available: boolean) => {
    setTopographicAvailability((current) => current[id] === available ? current : { ...current, [id]: available });
    if (available) setTerrainServiceState("available");
  }, []);

  const detailedTerrainActive = Boolean(
    terrainCoverage && mapExtent && mapResolution !== null &&
    mapResolution <= DETAILED_TERRAIN_MAX_RESOLUTION &&
    extentsIntersect(mapExtent, terrainCoverage.extent),
  );

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
            <p className="overlay-intro">ETOPO 2022 ofrece una vista mundial; el detalle Copernicus de 30 m aparece al acercar donde hay cobertura.</p>
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
                        <span className="layer-subtitle">{layer.description}</span>
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
            {topographicVisibility.elevation && terrainCoverage && (
              <div className="elevation-legend" aria-label="Leyenda de elevación en metros">
                <span className="elevation-legend-title">ETOPO · altura y profundidad (m)</span>
                <div className="elevation-legend-gradient" aria-hidden="true" />
                <div className="elevation-legend-values">
                  <span>{Math.round(terrainCoverage.minElevation)} m</span>
                  <span>0 m</span>
                  <span>{Math.round(terrainCoverage.maxElevation)} m</span>
                </div>
              </div>
            )}
            {terrainServiceState === "loading" && (
              <p className="terrain-coverage-note" role="status">Comprobando los datos topográficos preparados…</p>
            )}
            {terrainServiceState === "unavailable" && (
              <p className="terrain-coverage-note terrain-coverage-note--error" role="status">
                El servicio de elevación no está disponible. El mapa base y las herramientas siguen funcionando.
              </p>
            )}
            {terrainServiceState === "available" && terrainCoverage && (
              <p className="terrain-coverage-note" role="status">
                {detailedTerrainActive
                  ? `Relieve detallado de 30 m disponible en ${terrainCoverage.areaName}; ETOPO mundial completa el resto. Para análisis futuros, aún habrá que validar y preparar estos datos.`
                  : `ETOPO mundial de 60″ para visualización general. Al acercar en ${terrainCoverage.areaName} aparece el relieve de 30 m; ETOPO no está destinado a navegación ni sustituye datos preparados para análisis.`}
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
