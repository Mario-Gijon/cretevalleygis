import { useState } from "react";
import {
  Check,
  ChevronDown,
  Hand,
  MapPin,
  MousePointer2,
  Pentagon,
  Pencil,
  Ruler,
  Route,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { MapTool, MeasurementTool } from "@/hooks/useDrawingTools";
import type { MeasurementResult } from "@/lib/geometry-metrics";
import { formatArea, formatDistance } from "@/lib/geometry-metrics";
import { Button } from "@/components/ui/button";

type DrawingToolbarProps = {
  activeTool: MapTool;
  selectedCount: number;
  drawingInProgress: boolean;
  measurementResult: MeasurementResult | null;
  onToolChange: (tool: MapTool) => void;
  onCancel: () => void;
  onClearMeasurements: () => void;
  onFinishTrace: () => void;
  canFinishTrace: boolean;
  canUndoVertex: boolean;
  onUndoVertex: () => void;
  onDelete: () => void;
};

const tools = [
  { id: "navigate", label: "Explorar", icon: Hand, title: "Mover el mapa" },
  { id: "point", label: "Punto", icon: MapPin, title: "Dibujar un punto" },
  { id: "line", label: "Línea", icon: Route, title: "Dibujar una línea" },
  { id: "polygon", label: "Área", icon: Pentagon, title: "Dibujar un área" },
  { id: "select", label: "Seleccionar", icon: MousePointer2, title: "Seleccionar elementos" },
  { id: "modify", label: "Editar", icon: Pencil, title: "Editar geometrías seleccionadas" },
] as const;

const instructions = {
  navigate: "",
  point: "Pulsa en el mapa para colocar un punto. Se guarda al instante; Escape sale.",
  line: "Añade 2 puntos. Termina con clic derecho, Enter o Terminar; doble clic también funciona. Ctrl+Z deshace; Escape cancela.",
  polygon: "Marca 3 vértices. Termina con clic derecho, Enter o Terminar; doble clic también funciona. Ctrl+Z deshace; Escape cancela.",
  select: "Pulsa un elemento para seleccionarlo. Después puedes borrarlo con Supr o Eliminar.",
  modify: "Arrastra sus vértices para editarlo. Pulsa Supr o Eliminar para borrarlo.",
} satisfies Record<(typeof tools)[number]["id"], string>;

const measurementChoices: { id: MeasurementTool; label: string; instruction: string }[] = [
  { id: "measure-distance", label: "Distancia", instruction: "Añade 2 puntos. Termina con clic derecho, Enter o Terminar; Ctrl+Z deshace; Escape cancela." },
  { id: "measure-area", label: "Superficie", instruction: "Marca 3 vértices. Termina con clic derecho, Enter o Terminar; Ctrl+Z deshace; Escape cancela." },
];

function isMeasurementTool(tool: MapTool): tool is MeasurementTool {
  return tool === "measure-distance" || tool === "measure-area";
}

export function DrawingToolbar({
  activeTool,
  selectedCount,
  drawingInProgress,
  measurementResult,
  onToolChange,
  onCancel,
  onClearMeasurements,
  onFinishTrace,
  canFinishTrace,
  canUndoVertex,
  onUndoVertex,
  onDelete,
}: DrawingToolbarProps) {
  const [measureMenuOpen, setMeasureMenuOpen] = useState(false);
  const isDrawingTool = activeTool === "point" || activeTool === "line" || activeTool === "polygon";
  const isFinishableDrawing = activeTool === "line" || activeTool === "polygon";
  const activeMeasurement = isMeasurementTool(activeTool);
  const instruction = isMeasurementTool(activeTool)
    ? measurementChoices.find((choice) => choice.id === activeTool)?.instruction
    : instructions[activeTool];

  const chooseMeasurement = (tool: MeasurementTool) => {
    onToolChange(tool);
    setMeasureMenuOpen(false);
  };

  return (
    <>
      <div className="drawing-toolbar" role="toolbar" aria-label="Herramientas del mapa">
        <div className="drawing-tool-buttons">
          {tools.map(({ id, label, icon: Icon, title }) => (
            <Button
              key={id}
              variant={activeTool === id ? "primary" : "ghost"}
              size="small"
              className="drawing-tool-button"
              aria-pressed={activeTool === id}
              title={title}
              onClick={() => onToolChange(id)}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
            </Button>
          ))}
          <div className="measure-menu-wrap">
            <Button
              variant={activeMeasurement ? "primary" : "ghost"}
              size="small"
              className="drawing-tool-button measure-menu-trigger"
              aria-expanded={measureMenuOpen}
              aria-haspopup="true"
              aria-pressed={activeMeasurement}
              title="Medir distancia o superficie"
              onClick={() => setMeasureMenuOpen((open) => !open)}
            >
              <Ruler size={16} aria-hidden="true" />
              <span>Medir</span>
              <ChevronDown size={13} aria-hidden="true" />
            </Button>
            {measureMenuOpen && (
              <div className="measure-menu" aria-label="Opciones de medición">
                {measurementChoices.map(({ id, label }) => (
                  <Button
                    key={id}
                    variant={activeTool === id ? "primary" : "ghost"}
                    size="small"
                    className="measure-menu-option"
                    aria-pressed={activeTool === id}
                    onClick={() => chooseMeasurement(id)}
                  >
                    <Ruler size={15} aria-hidden="true" />
                    <span>{label}</span>
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>

        {(isDrawingTool || activeMeasurement || measurementResult !== null || selectedCount > 0) && <span className="drawing-toolbar-divider" />}
        {isDrawingTool && (
          <Button
            variant="ghost"
            size="small"
            className="drawing-action-button"
            aria-label={drawingInProgress ? "Cancelar dibujo" : "Salir del dibujo"}
            title={drawingInProgress ? "Cancelar este trazado y salir" : "Salir de la herramienta de dibujo"}
            onClick={onCancel}
          >
            <X size={16} aria-hidden="true" />
            <span>{drawingInProgress ? "Cancelar" : "Salir"}</span>
          </Button>
        )}
        {(isFinishableDrawing || activeMeasurement) && (
          <Button
            variant="ghost"
            size="small"
            className="drawing-action-button"
            aria-label="Terminar trazado"
            title="Terminar el trazado y volver a Explorar"
            disabled={!drawingInProgress || !canFinishTrace}
            onClick={onFinishTrace}
          >
            <Check size={16} aria-hidden="true" />
            <span>Terminar</span>
          </Button>
        )}
        {drawingInProgress && canUndoVertex && (
          <Button
            variant="ghost"
            size="small"
            className="drawing-action-button"
            aria-label={activeMeasurement ? "Deshacer último punto de la medición" : "Deshacer último vértice"}
            title={activeMeasurement ? "Quitar el último punto confirmado" : "Quitar el último vértice confirmado"}
            onClick={onUndoVertex}
          >
            <Undo2 size={16} aria-hidden="true" />
            <span>Deshacer</span>
          </Button>
        )}
        {activeMeasurement && drawingInProgress && (
          <Button
            variant="ghost"
            size="small"
            className="drawing-action-button"
            aria-label="Cancelar medición"
            title="Cancelar este trazado temporal y volver a Explorar"
            onClick={onCancel}
          >
            <X size={16} aria-hidden="true" />
            <span>Cancelar</span>
          </Button>
        )}
        {activeMeasurement && !drawingInProgress && !measurementResult && (
          <Button
            variant="ghost"
            size="small"
            className="drawing-action-button"
            aria-label="Salir de medición"
            title="Salir de la herramienta de medición"
            onClick={onCancel}
          >
            <X size={16} aria-hidden="true" />
            <span>Salir</span>
          </Button>
        )}
        {measurementResult && !(activeMeasurement && drawingInProgress) && (
          <Button
            variant="ghost"
            size="small"
            className="drawing-action-button"
            aria-label="Borrar medición"
            title="Borrar la medición temporal"
            onClick={onClearMeasurements}
          >
            <Trash2 size={16} aria-hidden="true" />
            <span>Borrar medición</span>
          </Button>
        )}
        {selectedCount > 0 && (
          <Button
            variant="ghost"
            size="small"
            className="drawing-action-button drawing-delete-button"
            aria-label={`Eliminar ${selectedCount} ${selectedCount === 1 ? "elemento seleccionado" : "elementos seleccionados"}`}
            title={`Eliminar ${selectedCount} elementos seleccionados`}
            onClick={onDelete}
          >
            <Trash2 size={16} aria-hidden="true" />
            <span>Eliminar{selectedCount > 1 ? ` (${selectedCount})` : ""}</span>
          </Button>
        )}
      </div>
      {(instruction || measurementResult) && (
        <div className="drawing-instruction" role="status" aria-live="polite">
          {instruction && <span>{instruction}</span>}
          {measurementResult && (
            <strong className={`measurement-readout ${activeMeasurement && drawingInProgress ? "measurement-readout--provisional" : ""}`}>
              {activeMeasurement && drawingInProgress ? "Provisional · " : "Medición · "}
              {measurementResult.kind === "distance" ? formatDistance(measurementResult.value) : formatArea(measurementResult.value)}
              {measurementResult.kind === "distance" && ` · ${measurementResult.vertices} puntos`}
              {measurementResult.kind === "area" && ` · ${measurementResult.vertices} vértices`}
            </strong>
          )}
          {measurementResult && !(activeMeasurement && drawingInProgress) && (
            <span className="measurement-hint">Medición temporal. Pulsa «Borrar medición» para quitarla.</span>
          )}
        </div>
      )}
    </>
  );
}
