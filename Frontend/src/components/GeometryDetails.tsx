import { useEffect, useState } from "react";
import type { SelectedElementInfo } from "@/hooks/useDrawingTools";
import { formatArea, formatCoordinate, formatDistance } from "@/lib/geometry-metrics";

type GeometryDetailsProps = {
  element: SelectedElementInfo;
  onRename: (id: string, name: string) => void;
};

export function GeometryDetails({ element, onRename }: GeometryDetailsProps) {
  const [name, setName] = useState(element?.name ?? "");

  useEffect(() => setName(element?.name ?? ""), [element?.id, element?.name]);

  if (!element) return null;

  const rename = () => onRename(element.id, name);
  const value = element.geometry;

  return (
    <section className="geometry-details" aria-labelledby="geometry-details-title">
      <div className="geometry-details-heading">
        <h2 className="eyebrow" id="geometry-details-title">INFORMACIÓN DEL ELEMENTO</h2>
      </div>
      <label className="geometry-name-label" htmlFor="geometry-element-name">Nombre</label>
      <input
        id="geometry-element-name"
        className="geometry-name-input"
        value={name}
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
        onBlur={rename}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setName(element.name);
          }
        }}
      />

      <dl className="geometry-metrics-list">
        {value.kind === "Point" && (
          <>
            <div><dt>Latitud</dt><dd>{formatCoordinate(value.latitude, "N", "S")}</dd></div>
            <div><dt>Longitud</dt><dd>{formatCoordinate(value.longitude, "E", "O")}</dd></div>
          </>
        )}
        {value.kind === "LineString" && (
          <>
            <div><dt>Longitud</dt><dd>{formatDistance(value.length)}</dd></div>
            <div><dt>Vértices</dt><dd>{value.vertices}</dd></div>
          </>
        )}
        {value.kind === "Polygon" && (
          <>
            <div><dt>Superficie</dt><dd>{formatArea(value.area)}</dd></div>
            <div><dt>Perímetro</dt><dd>{formatDistance(value.perimeter)}</dd></div>
            <div><dt>Vértices</dt><dd>{value.vertices}</dd></div>
          </>
        )}
      </dl>
      <p className="geometry-metrics-note">Mediciones orientativas sobre la esfera terrestre.</p>
    </section>
  );
}
