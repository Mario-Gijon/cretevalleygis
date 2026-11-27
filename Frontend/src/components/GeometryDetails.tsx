import { useEffect, useState } from "react";
import { AlertCircle, ArrowLeft, Check, LoaderCircle, Mountain } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SelectedElementInfo } from "@/hooks/useDrawingTools";
import { formatArea, formatCoordinate, formatDistance } from "@/lib/geometry-metrics";
import type { TerrainPreparationView } from "@/lib/terrain-preparation";

type GeometryDetailsProps = {
  element: SelectedElementInfo;
  onBackToList: () => void;
  onRename: (id: string, name: string) => void;
  terrainPreparation?: TerrainPreparationView;
  onPrepareTerrain: (id: string, name: string, bbox: [number, number, number, number]) => void;
  onPrepareDerivatives: (id: string, jobId: string) => void;
};

export function GeometryDetails({
  element,
  onBackToList,
  onRename,
  terrainPreparation,
  onPrepareTerrain,
  onPrepareDerivatives,
}: GeometryDetailsProps) {
  const [name, setName] = useState(element?.name ?? "");

  useEffect(() => setName(element?.name ?? ""), [element?.id, element?.name]);

  if (!element) return null;

  const rename = () => onRename(element.id, name);
  const value = element.geometry;
  const geometryLabel = value.kind === "Point" ? "Punto" : value.kind === "LineString" ? "Línea" : "Área";
  const isPreparing = terrainPreparation?.state === "submitting" || terrainPreparation?.state === "running";
  const isPrepared = terrainPreparation?.state === "completed";
  const derivatives = terrainPreparation?.derivatives;
  const derivativesBusy = derivatives?.state === "submitting" || derivatives?.state === "queued" || derivatives?.state === "running";
  const derivativesReady = Boolean(terrainPreparation?.result?.derivatives);

  return (
    <section className="geometry-details" aria-labelledby="geometry-details-title">
      <div className="geometry-details-heading">
        <Button variant="ghost" size="small" className="geometry-back-button" onClick={onBackToList}>
          <ArrowLeft size={15} aria-hidden="true" /> Volver a áreas
        </Button>
        <span className="geometry-type-badge">{geometryLabel}</span>
      </div>
      <h2 className="eyebrow" id="geometry-details-title">PROPIEDADES DEL ELEMENTO</h2>
      <label className="sr-only" htmlFor="geometry-element-name">Nombre del elemento</label>
      <input
        id="geometry-element-name"
        className="geometry-name-input"
        value={name}
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
        onBlur={rename}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setName(element.name);
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

      {value.kind === "Polygon" && (
        <section className="terrain-preparation-card" aria-labelledby="terrain-preparation-title">
          <div className="terrain-preparation-heading">
            <span className="overlay-symbol topographic-symbol" aria-hidden="true"><Mountain size={16} /></span>
            <div>
              <h3 id="terrain-preparation-title">Datos de terreno para análisis</h3>
              {isPreparing ? (
                <p>Preparación en curso</p>
              ) : isPrepared ? (
                <p>Datos listos · {terrainPreparation.result?.coverage.resolution_m ?? 30} m</p>
              ) : terrainPreparation?.state === "error" ? (
                <p>No se pudo preparar</p>
              ) : (
                <p>Prepara elevación para análisis posteriores</p>
              )}
            </div>
          </div>

          {isPreparing && (
            <p className="terrain-preparation-status" role="status">
              <LoaderCircle size={14} className="spinner" aria-hidden="true" />
              <span>{terrainPreparation?.message}</span>
            </p>
          )}

          {terrainPreparation?.state === "error" && (
            <p className="terrain-preparation-status terrain-preparation-status--error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <span>{terrainPreparation.message}</span>
            </p>
          )}

          {!isPreparing && !isPrepared && (
            <Button
              variant={terrainPreparation?.state === "error" ? "outline" : "primary"}
              size="small"
              className="terrain-preparation-button"
              disabled={!element.bboxWgs84}
              onClick={() => element.bboxWgs84 && onPrepareTerrain(element.id, element.name, element.bboxWgs84)}
            >
              <Mountain size={14} aria-hidden="true" />
              {terrainPreparation?.state === "error" ? "Reintentar preparación" : "Preparar datos de terreno"}
            </Button>
          )}

          {isPrepared && (
            <>
              <p className="terrain-preparation-status terrain-preparation-status--ready" role="status">
                <Check size={14} aria-hidden="true" />
                <span>{terrainPreparation?.message}{terrainPreparation?.reused ? " Se reutilizaron los datos existentes." : ""}</span>
              </p>
              {derivativesReady ? (
                <p className="terrain-preparation-status terrain-preparation-status--ready" role="status">
                  <Check size={14} aria-hidden="true" />
                  <span>Pendiente y orientación disponibles para análisis.</span>
                </p>
              ) : (
                <div className="analysis-data-action">
                  <Button
                    variant="outline"
                    size="small"
                    className="terrain-preparation-button"
                    disabled={!terrainPreparation?.jobId || derivativesBusy}
                    onClick={() => terrainPreparation?.jobId && onPrepareDerivatives(element.id, terrainPreparation.jobId)}
                  >
                    {derivativesBusy ? <LoaderCircle size={14} className="spinner" aria-hidden="true" /> : <Mountain size={14} aria-hidden="true" />}
                    {derivativesBusy ? "Preparando derivados…" : "Preparar pendientes y orientación"}
                  </Button>
                  {derivatives?.message && <p className={`terrain-preparation-status${derivatives.state === "error" ? " terrain-preparation-status--error" : ""}`} role="status">{derivatives.message}</p>}
                </div>
              )}
            </>
          )}

          {!isPrepared && !isPreparing && (
            <details className="terrain-preparation-limits">
              <summary>Límites de preparación</summary>
              <p>Se prepara el rectángulo del área seleccionada · hasta 4° por lado, 16 teselas y 30 millones de píxeles a 30 m.</p>
            </details>
          )}
        </section>
      )}
    </section>
  );
}
