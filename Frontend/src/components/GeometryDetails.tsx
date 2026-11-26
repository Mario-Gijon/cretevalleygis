import { useEffect, useState } from "react";
import { AlertCircle, Check, LoaderCircle, MapPinned, Mountain } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SelectedElementInfo } from "@/hooks/useDrawingTools";
import { formatArea, formatCoordinate, formatDistance } from "@/lib/geometry-metrics";
import type { TerrainPreparationView } from "@/lib/terrain-preparation";

type GeometryDetailsProps = {
  element: SelectedElementInfo;
  onRename: (id: string, name: string) => void;
  terrainPreparation?: TerrainPreparationView;
  terrainIsActive: boolean;
  onPrepareTerrain: (id: string, name: string, bbox: [number, number, number, number]) => void;
  onShowPreparedTerrain: (id: string) => void;
  onClosePreparedTerrain: () => void;
  onCenterPreparedTerrain: () => void;
};

export function GeometryDetails({
  element,
  onRename,
  terrainPreparation,
  terrainIsActive,
  onPrepareTerrain,
  onShowPreparedTerrain,
  onClosePreparedTerrain,
  onCenterPreparedTerrain,
}: GeometryDetailsProps) {
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
      {value.kind === "Polygon" && (
        <section className="terrain-preparation-card" aria-labelledby="terrain-preparation-title">
          <div className="terrain-preparation-heading">
            <span className="overlay-symbol topographic-symbol" aria-hidden="true"><Mountain size={16} /></span>
            <div>
              <h3 id="terrain-preparation-title">Terreno detallado</h3>
              <p>Preparar elevación para esta área</p>
            </div>
          </div>
          {terrainPreparation?.state === "submitting" || terrainPreparation?.state === "running" ? (
            <p className="terrain-preparation-status" role="status">
              <LoaderCircle size={14} className="spinner" aria-hidden="true" />
              <span>{terrainPreparation.message}</span>
            </p>
          ) : terrainPreparation?.state === "error" ? (
            <>
              <p className="terrain-preparation-status terrain-preparation-status--error" role="alert">
                <AlertCircle size={14} aria-hidden="true" />
                <span>{terrainPreparation.message}</span>
              </p>
              <Button
                variant="outline"
                size="small"
                className="terrain-preparation-button"
                disabled={!element.bboxWgs84}
                onClick={() => element.bboxWgs84 && onPrepareTerrain(element.id, element.name, element.bboxWgs84)}
              >
                <Mountain size={14} aria-hidden="true" />
                Reintentar
              </Button>
            </>
          ) : terrainPreparation?.state === "completed" ? (
            <>
              <p className="terrain-preparation-status terrain-preparation-status--ready" role="status">
                <Check size={14} aria-hidden="true" />
                <span>{terrainPreparation.message} · {terrainPreparation.result?.coverage.resolution_m} m</span>
              </p>
              {terrainIsActive ? (
                <div className="terrain-preparation-actions">
                  <Button variant="outline" size="small" onClick={onCenterPreparedTerrain}>
                    <MapPinned size={14} aria-hidden="true" />
                    Centrar mapa
                  </Button>
                  <Button variant="ghost" size="small" onClick={onClosePreparedTerrain}>
                    Cerrar visualización
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="small" className="terrain-preparation-button" onClick={() => onShowPreparedTerrain(element.id)}>
                  <MapPinned size={14} aria-hidden="true" />
                  Ver terreno preparado
                </Button>
              )}
            </>
          ) : (
            <>
              <p className="terrain-preparation-help">Usa el rectángulo que contiene el polígono · hasta 2° por lado y 4 teselas.</p>
              <Button
                variant="primary"
                size="small"
                className="terrain-preparation-button"
                disabled={!element.bboxWgs84}
                onClick={() => element.bboxWgs84 && onPrepareTerrain(element.id, element.name, element.bboxWgs84)}
              >
                <Mountain size={14} aria-hidden="true" />
                Preparar terreno
              </Button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
