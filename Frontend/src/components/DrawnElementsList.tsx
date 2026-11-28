import { useState } from "react";
import { Check, Ellipsis, GitCompareArrows, MapPin, Pencil, Pentagon, Route, Scale, Trash2, X } from "lucide-react";
import type { DrawnElement } from "@/hooks/useDrawingTools";
import { formatArea, formatCoordinate, formatDistance } from "@/lib/geometry-metrics";
import { isSurfaceGeometryType } from "@/lib/geometry-types";

type DrawnElementsListProps = {
  elements: DrawnElement[];
  selectedIds: string[];
  previewsAvailable?: boolean;
  onFocus: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onCompare: () => void;
  onGeometryOperations: () => void;
};

const geometryLabels = {
  Point: "Punto",
  LineString: "Línea",
  Polygon: "Área",
  MultiPolygon: "Área compuesta",
} as const;

export function DrawnElementsList({ elements, selectedIds, previewsAvailable = true, onFocus, onRename, onDelete, onCompare, onGeometryOperations }: DrawnElementsListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const polygonCount = elements.filter((element) => isSurfaceGeometryType(element.geometryType)).length;

  return (
    <section className="drawn-elements-section" aria-labelledby="drawn-elements-title">
      <div className="drawn-elements-heading">
        <div>
          <h2 className="eyebrow" id="drawn-elements-title">ÁREAS Y ELEMENTOS</h2>
          <p className="drawn-elements-caption">Selecciona uno para consultar sus propiedades.</p>
        </div>
        <div className="drawn-elements-heading-actions">
          {polygonCount >= 2 && (
            <button type="button" className="drawn-elements-compare" onClick={onCompare}>
              <Scale size={14} aria-hidden="true" /> Comparar áreas
            </button>
          )}
          <span className="drawn-elements-count" aria-label={`${elements.length} elementos`}>{elements.length}</span>
        </div>
      </div>
      {polygonCount >= 2 && previewsAvailable && (
        <button
          type="button"
          className="drawn-elements-operations"
          aria-label="Operaciones geométricas entre áreas"
          onClick={onGeometryOperations}
        >
          <GitCompareArrows size={14} aria-hidden="true" /> Operaciones geométricas
        </button>
      )}
      {polygonCount >= 2 && !previewsAvailable && (
        <p className="geometry-preview-availability">Vuelve a 2D para previsualizar operaciones entre áreas.</p>
      )}
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
                : element.geometryInfo?.kind === "Area"
                  ? formatArea(element.geometryInfo.area)
                  : null;
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
                      aria-label={`Abrir propiedades de ${element.name}`}
                      onClick={() => onFocus(element.id)}
                    >
                      <span className="drawn-element-icon" aria-hidden="true"><Icon size={16} /></span>
                      <span className="drawn-element-copy">
                        <span className="drawn-element-name">{element.name}</span>
                        <span className="drawn-element-meta">
                          <span className="drawn-element-type">{geometryLabels[element.geometryType]}</span>
                          {element.geometryInfo?.kind === "Area" && element.geometryType === "MultiPolygon" && (
                            <span className="drawn-element-measure">{element.geometryInfo.polygonCount} polígonos</span>
                          )}
                          {measure && <span className="drawn-element-measure">{measure}</span>}
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
