import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Check,
  CornerUpLeft,
  Layers,
  LoaderCircle,
  Map,
  MapPin,
  Minus,
  Moon,
  PanelLeftClose,
  Plus,
  Play,
  Sun,
  X,
} from "lucide-react";
import { fromLonLat } from "ol/proj.js";
import type OlMap from "ol/Map.js";
import OSM from "ol/source/OSM.js";
import TileLayer from "ol/layer/Tile.js";
import MapView, { type MapStatus } from "@/components/MapView";
import { DrawnElementsList } from "@/components/DrawnElementsList";
import { GeometryDetails } from "@/components/GeometryDetails";
import { DrawingToolbar } from "@/components/DrawingToolbar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDrawingTools } from "@/hooks/useDrawingTools";
import { CRETE_CENTER } from "@/lib/map-config";
import { formatCoordinate } from "@/lib/geometry-metrics";

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
  const baseLayerRef = useRef<TileLayer<OSM> | null>(null);
  const drawingTools = useDrawingTools();
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [panelOpen, setPanelOpen] = useState(
    () => !window.matchMedia("(max-width: 720px)").matches,
  );
  const [layerVisible, setLayerVisible] = useState(true);
  const [mapStatus, setMapStatus] = useState<MapStatus>({
    ready: false,
    loading: true,
    error: false,
  });
  const [mapCenter, setMapCenter] = useState<[number, number]>([...CRETE_CENTER]);

  const handleMapStatus = useCallback((status: MapStatus) => {
    setMapStatus(status);
  }, []);

  const handleMapCenterChange = useCallback((center: [number, number]) => {
    setMapCenter(center);
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

  const changeLayerVisibility = (visible: boolean) => {
    baseLayerRef.current?.setVisible(visible);
    setLayerVisible(visible);
  };

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
          <p className="panel-description">Activa la cartografía que quieres consultar.</p>

          <section className="layer-section" aria-labelledby="base-layers-title">
            <h2 className="eyebrow" id="base-layers-title">CAPA BASE</h2>
            <div className="layer-row">
              <div className="layer-symbol" aria-hidden="true">
                <Map size={18} />
              </div>
              <div className="layer-copy">
                <span className="layer-title">OpenStreetMap</span>
                <span className="layer-subtitle">Calles y lugares</span>
              </div>
              <Switch
                checked={layerVisible}
                onCheckedChange={changeLayerVisibility}
                aria-label="Mostrar capa OpenStreetMap"
              />
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
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
            >
              © OpenStreetMap contributors
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
            baseLayerRef={baseLayerRef}
            drawingsLayer={drawingTools.layer}
            measurementsLayer={drawingTools.measurementLayer}
            onStatusChange={handleMapStatus}
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
          {!layerVisible && (
            <div className="map-empty-state" role="status">
              La capa base está oculta
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
