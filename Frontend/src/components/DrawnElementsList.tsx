import { useState } from "react";
import { Check, Eye, EyeOff, MapPin, MapPinned, Pencil, Pentagon, Route, Trash2, X } from "lucide-react";
import type { DrawnElement } from "@/hooks/useDrawingTools";
import type { TerrainPreparationView } from "@/lib/terrain-preparation";
import type { PreparedTerrainState } from "@/lib/prepared-terrain";

type DrawnElementsListProps = {
  elements: DrawnElement[];
  selectedIds: string[];
  onFocus: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  terrainJobs: Record<string, TerrainPreparationView | undefined>;
  preparedTerrains: Record<string, PreparedTerrainState>;
  onToggleTerrain: (id: string, visible: boolean) => void;
  onCenterTerrain: (id: string) => void;
};

const geometryLabels = {
  Point: "Punto",
  LineString: "Línea",
  Polygon: "Área",
} as const;

export function DrawnElementsList({ elements, selectedIds, onFocus, onRename, onDelete, terrainJobs, preparedTerrains, onToggleTerrain, onCenterTerrain }: DrawnElementsListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  return (
    <section className="drawn-elements-section" aria-labelledby="drawn-elements-title">
      <div className="drawn-elements-heading">
        <h2 className="eyebrow" id="drawn-elements-title">ELEMENTOS DIBUJADOS</h2>
        <span className="drawn-elements-count" aria-label={`${elements.length} elementos`}>
          {elements.length}
        </span>
      </div>
      {elements.length === 0 ? (
        <p className="drawn-elements-empty">Los elementos que dibujes aparecerán aquí.</p>
      ) : (
        <ul className="drawn-elements-list">
          {elements.map((element) => {
            const Icon = element.geometryType === "Point"
              ? MapPin
              : element.geometryType === "LineString"
                ? Route
                : Pentagon;
            const job = terrainJobs[element.id];
            const preparedTerrain = preparedTerrains[element.id];
            const resultExtent = job?.result?.coverage.extent_wgs84;
            const preparedMatches = Boolean(element.bboxWgs84 && resultExtent && element.bboxWgs84.every((value, index) => Math.abs(value - resultExtent[index]) < 1e-7));
            const terrainStatus = preparedTerrain
              ? `Terreno preparado · ${preparedTerrain.result.coverage.resolution_m} m · ${preparedTerrain.visible ? "visible" : "oculto"}`
              : job?.state === "completed" && preparedMatches
              ? `Terreno preparado · ${job.result?.coverage.resolution_m ?? 30} m`
              : job?.state === "completed"
                ? "Área modificada · vuelve a preparar el terreno"
              : job?.state === "running" || job?.state === "submitting"
                ? "Preparando terreno…"
                : job?.state === "error"
                  ? "Preparación no disponible"
                  : element.geometryType === "Polygon"
                    ? "Sin terreno preparado"
                    : null;
            const terrainStatusClass = job?.state === "completed" && !preparedMatches ? "stale" : job?.state ?? "idle";

            return (
              <li className="drawn-element-card" key={element.id}>
                {editingId === element.id ? (
                  <form
                    className="drawn-element-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      onRename(element.id, draftName);
                      setEditingId(null);
                    }}
                  >
                    <label className="sr-only" htmlFor={`rename-${element.id}`}>Nombre del elemento</label>
                    <input
                      id={`rename-${element.id}`}
                      autoFocus
                      value={draftName}
                      maxLength={80}
                      onChange={(event) => setDraftName(event.currentTarget.value)}
                    />
                    <button type="submit" aria-label="Guardar nombre"><Check size={15} /></button>
                    <button type="button" aria-label="Cancelar" onClick={() => setEditingId(null)}><X size={15} /></button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="drawn-element-button"
                      aria-pressed={selectedIds.includes(element.id)}
                      aria-label={`Seleccionar y centrar ${element.name}`}
                      onClick={() => onFocus(element.id)}
                    >
                      <span className="drawn-element-icon" aria-hidden="true"><Icon size={16} /></span>
                      <span className="drawn-element-copy">
                        <span className="drawn-element-name">{element.name}</span>
                        <span className="drawn-element-type">{geometryLabels[element.geometryType]}</span>
                      </span>
                      <MapPin className="drawn-element-focus" size={15} aria-hidden="true" />
                    </button>
                    <div className="drawn-element-actions">
                      {preparedTerrain && (
                        <>
                          <button type="button" title={preparedTerrain.visible ? "Ocultar terreno" : "Mostrar terreno"} aria-label={`${preparedTerrain.visible ? "Ocultar" : "Mostrar"} terreno de ${element.name}`} onClick={() => onToggleTerrain(element.id, !preparedTerrain.visible)}>
                            {preparedTerrain.visible ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          <button type="button" title="Centrar terreno" aria-label={`Centrar terreno de ${element.name}`} onClick={() => { onFocus(element.id); onCenterTerrain(element.id); }}>
                            <MapPinned size={14} />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        aria-label={`Renombrar ${element.name}`}
                        title="Renombrar"
                        onClick={() => { setDraftName(element.name); setEditingId(element.id); }}
                      ><Pencil size={14} /></button>
                      <button
                        type="button"
                        className="drawn-element-delete"
                        aria-label={`Eliminar ${element.name}`}
                        title="Eliminar"
                        onClick={() => onDelete(element.id)}
                      ><Trash2 size={14} /></button>
                    </div>
                  </>
                )}
                {terrainStatus && <span className={`drawn-element-terrain drawn-element-terrain--${terrainStatusClass}`}>{terrainStatus}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
