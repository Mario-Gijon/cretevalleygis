import { MapPin, Pentagon, Route } from "lucide-react";
import type { DrawnElement } from "@/hooks/useDrawingTools";

type DrawnElementsListProps = {
  elements: DrawnElement[];
  selectedIds: string[];
  onFocus: (id: string) => void;
};

const geometryLabels = {
  Point: "Punto",
  LineString: "Línea",
  Polygon: "Área",
} as const;

export function DrawnElementsList({ elements, selectedIds, onFocus }: DrawnElementsListProps) {
  return (
    <section className="drawn-elements-section" aria-labelledby="drawn-elements-title">
      <div className="drawn-elements-heading">
        <h2 className="eyebrow" id="drawn-elements-title">ELEMENTOS DIBUJADOS</h2>
        <span className="drawn-elements-count" aria-label={`${elements.length} elementos`}>
          {elements.length}
        </span>
      </div>
      {elements.length === 0 ? (
        <p className="drawn-elements-empty">Aquí aparecerán los puntos, líneas y áreas que dibujes.</p>
      ) : (
        <ul className="drawn-elements-list">
          {elements.map((element) => {
            const Icon = element.geometryType === "Point"
              ? MapPin
              : element.geometryType === "LineString"
                ? Route
                : Pentagon;

            return (
              <li key={element.id}>
                <button
                  type="button"
                  className="drawn-element-button"
                  aria-pressed={selectedIds.includes(element.id)}
                  aria-label={`Seleccionar y centrar ${element.name}`}
                  onClick={() => onFocus(element.id)}
                >
                  <span className="drawn-element-icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <span className="drawn-element-copy">
                    <span className="drawn-element-name">{element.name}</span>
                    <span className="drawn-element-type">{geometryLabels[element.geometryType]}</span>
                  </span>
                  <MapPin className="drawn-element-focus" size={15} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
