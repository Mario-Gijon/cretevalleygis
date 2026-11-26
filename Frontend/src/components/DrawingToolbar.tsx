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
  onFinishMeasurement: () => void;
  canFinishMeasurement: boolean;
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
  navigate: "Arrastra para mover el mapa. Usa + y − para cambiar el zoom.",
  point: "Pulsa en el mapa para colocar un punto.",
  line: "Pulsa para añadir vértices y dos veces para terminar la línea.",
  polygon: "Pulsa para marcar el contorno y dos veces para cerrar el área.",
  select: "Pulsa un elemento dibujado para seleccionarlo.",
  modify: "Arrastra los vértices del elemento seleccionado para editarlo.",
} satisfies Record<(typeof tools)[number]["id"], string>;

const measurementChoices: { id: MeasurementTool; label: string; instruction: string }[] = [
  { id: "measure-distance", label: "Distancia", instruction: "Pulsa para añadir puntos y termina cuando quieras." },
  { id: "measure-area", label: "Superficie", instruction: "Pulsa para marcar el contorno y termina cuando quieras." },
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
  onFinishMeasurement,
  canFinishMeasurement,
  onDelete,
}: DrawingToolbarProps) {
  const [measureMenuOpen, setMeasureMenuOpen] = useState(false);
  const isDrawingTool = activeTool === "point" || activeTool === "line" || activeTool === "polygon";
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
            aria-label="Cancelar dibujo"
            title={drawingInProgress ? "Cancelar el dibujo actual" : "Salir de la herramienta de dibujo"}
            onClick={onCancel}
          >
            <X size={16} aria-hidden="true" />
            <span>Cancelar</span>
          </Button>
        )}
        {activeMeasurement && (
          <Button
            variant="ghost"
            size="small"
            className="drawing-action-button"
            aria-label="Terminar medición"
            title="Terminar el trazado y conservar el resultado"
            disabled={!drawingInProgress || !canFinishMeasurement}
            onClick={onFinishMeasurement}
          >
            <Check size={16} aria-hidden="true" />
            <span>Terminar</span>
          </Button>
        )}
        {(activeMeasurement || measurementResult !== null) && (
          <Button
            variant="ghost"
            size="small"
            className="drawing-action-button"
            aria-label={activeMeasurement && drawingInProgress ? "Cancelar medición" : "Limpiar medición"}
            title={activeMeasurement && drawingInProgress ? "Cancelar y limpiar la medición" : "Limpiar la medición"}
            onClick={onClearMeasurements}
          >
            <X size={16} aria-hidden="true" />
            <span>{activeMeasurement && drawingInProgress ? "Cancelar" : "Limpiar"}</span>
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
      <div className="drawing-instruction" role="status" aria-live="polite">
        <span>{instruction}</span>
        {measurementResult && (
          <strong className="measurement-readout">
            {measurementResult.kind === "distance" ? "Distancia" : "Superficie"}: {measurementResult.kind === "distance" ? formatDistance(measurementResult.value) : formatArea(measurementResult.value)}
            {measurementResult.kind === "distance" && ` · ${measurementResult.vertices} puntos`}
            {measurementResult.kind === "area" && ` · ${measurementResult.vertices} vértices`}
          </strong>
        )}
      </div>
    </>
  );
}
