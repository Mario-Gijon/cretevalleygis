import { useState } from "react";
import { Check, Ellipsis, MapPin, Pencil, Pentagon, Route, Trash2, X } from "lucide-react";
import type { DrawnElement } from "@/hooks/useDrawingTools";
import type { TerrainPreparationView } from "@/lib/terrain-preparation";
import { formatArea, formatCoordinate, formatDistance } from "@/lib/geometry-metrics";

type DrawnElementsListProps = {
  elements: DrawnElement[];
  selectedIds: string[];
  onFocus: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  terrainJobs: Record<string, TerrainPreparationView | undefined>;
};

const geometryLabels = {
  Point: "Punto",
  LineString: "Línea",
  Polygon: "Área",
} as const;

export function DrawnElementsList({ elements, selectedIds, onFocus, onRename, onDelete, terrainJobs }: DrawnElementsListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  return (
    <section className="drawn-elements-section" aria-labelledby="drawn-elements-title">
      <div className="drawn-elements-heading">
        <div>
          <h2 className="eyebrow" id="drawn-elements-title">ÁREAS Y ELEMENTOS</h2>
          <p className="drawn-elements-caption">Selecciona uno para consultar sus propiedades.</p>
        </div>
        <span className="drawn-elements-count" aria-label={`${elements.length} elementos`}>{elements.length}</span>
      </div>
      {elements.length === 0 ? (
        <p className="drawn-elements-empty">Dibuja un punto, una línea o un área para empezar.</p>
      ) : (
        <ul className="drawn-elements-list">
          {elements.map((element) => {
            const Icon = element.geometryType === "Point" ? MapPin : element.geometryType === "LineString" ? Route : Pentagon;
            const measure = element.geometryInfo?.kind === "Point"
              ? `${formatCoordinate(element.geometryInfo.latitude, "N", "S")} · ${formatCoordinate(element.geometryInfo.longitude, "E", "O")}`
              : element.geometryInfo?.kind === "LineString"
                ? formatDistance(element.geometryInfo.length)
                : element.geometryInfo?.kind === "Polygon"
                  ? formatArea(element.geometryInfo.area)
                  : null;
            const job = terrainJobs[element.id];
            const resultExtent = job?.result?.coverage.extent_wgs84;
            const preparedMatches = Boolean(element.bboxWgs84 && resultExtent && element.bboxWgs84.every((value, index) => Math.abs(value - resultExtent[index]) < 1e-7));
            const terrainStatus = element.geometryType !== "Polygon"
              ? null
              : job?.state === "completed" && preparedMatches
                ? `Datos listos · ${job.result?.coverage.resolution_m ?? 30} m`
                : job?.state === "completed"
                  ? "Área modificada · volver a preparar"
                  : job?.state === "running" || job?.state === "submitting"
                    ? "Preparando datos…"
                    : job?.state === "error"
                      ? "Error al preparar datos"
                      : "Datos de terreno sin preparar";
            const statusClass = job?.state === "completed" && preparedMatches
              ? "ready"
              : job?.state === "completed"
                ? "stale"
                : job?.state === "error"
                  ? "error"
                  : job?.state ?? "idle";

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
                    <input id={`rename-${element.id}`} autoFocus value={draftName} maxLength={80} onChange={(event) => setDraftName(event.currentTarget.value)} />
                    <button type="submit" aria-label="Guardar nombre"><Check size={15} /></button>
                    <button type="button" aria-label="Cancelar" onClick={() => setEditingId(null)}><X size={15} /></button>
                  </form>
                ) : (
                  <div className="drawn-element-row">
                    <button
                      type="button"
                      className="drawn-element-button"
                      aria-pressed={selectedIds.includes(element.id)}
                      aria-label={`Abrir propiedades de ${element.name}${terrainStatus ? `, ${terrainStatus}` : ""}`}
                      onClick={() => onFocus(element.id)}
                    >
                      <span className="drawn-element-icon" aria-hidden="true"><Icon size={16} /></span>
                      <span className="drawn-element-copy">
                        <span className="drawn-element-name">{element.name}</span>
                        <span className="drawn-element-meta">
                          <span className="drawn-element-type">{geometryLabels[element.geometryType]}</span>
                          {measure && <span className="drawn-element-measure">{measure}</span>}
                          {terrainStatus && <span className={`drawn-element-terrain drawn-element-terrain--${statusClass}`}>{terrainStatus}</span>}
                        </span>
                      </span>
                    </button>
                    <details className="drawn-element-menu">
                      <summary aria-label={`Acciones de ${element.name}`} title="Más acciones"><Ellipsis size={17} aria-hidden="true" /></summary>
                      <div className="drawn-element-menu-actions">
                        <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setDraftName(element.name); setEditingId(element.id); }}>
                          <Pencil size={14} /> Renombrar
                        </button>
                        <button type="button" className="drawn-element-delete" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onDelete(element.id); }}>
                          <Trash2 size={14} /> Eliminar
                        </button>
                      </div>
                    </details>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
