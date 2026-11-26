import {
  Hand,
  MapPin,
  MousePointer2,
  Pentagon,
  Pencil,
  Route,
  Trash2,
  X,
} from "lucide-react";
import type { DrawingTool } from "@/hooks/useDrawingTools";
import { Button } from "@/components/ui/button";

type DrawingToolbarProps = {
  activeTool: DrawingTool;
  selectedCount: number;
  drawingInProgress: boolean;
  onToolChange: (tool: DrawingTool) => void;
  onCancel: () => void;
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

const instructions: Record<DrawingTool, string> = {
  navigate: "Arrastra para mover el mapa. Usa + y − para cambiar el zoom.",
  point: "Pulsa en el mapa para colocar un punto.",
  line: "Pulsa para añadir vértices y dos veces para terminar la línea.",
  polygon: "Pulsa para marcar el contorno y dos veces para cerrar el área.",
  select: "Pulsa un elemento dibujado para seleccionarlo.",
  modify: "Arrastra los vértices del elemento seleccionado para editarlo.",
};

export function DrawingToolbar({
  activeTool,
  selectedCount,
  drawingInProgress,
  onToolChange,
  onCancel,
  onDelete,
}: DrawingToolbarProps) {
  const isDrawingTool = activeTool === "point" || activeTool === "line" || activeTool === "polygon";

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
        </div>

        {(isDrawingTool || selectedCount > 0) && <span className="drawing-toolbar-divider" />}
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
        {instructions[activeTool]}
      </div>
    </>
  );
}
