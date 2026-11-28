import { useState } from "react";
import { Activity, Check, Copy, Info, LoaderCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PointInspection } from "@/hooks/usePointInspector";

type PointInspectorControlProps = {
  active: boolean;
  inspection: PointInspection | null;
  onToggle: () => void;
};

const coordinateFormat = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 5, maximumFractionDigits: 6 });
const valueFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

function formatCoordinate(value: number): string {
  return coordinateFormat.format(value);
}

export function PointInspectorControl({ active, inspection, onToggle }: PointInspectorControlProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const copyCoordinates = async () => {
    if (!inspection) return;
    const text = `${inspection.latitude.toFixed(6)}, ${inspection.longitude.toFixed(6)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(false);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  return (
    <div className={`point-inspector-control${active ? " point-inspector-control--active" : ""}`}>
      <Button
        variant={active ? "primary" : "ghost"}
        size="small"
        className="point-inspector-toggle"
        aria-pressed={active}
        onClick={onToggle}
        title={active ? "Salir del inspector" : "Consultar información de un punto"}
      >
        <Info size={16} aria-hidden="true" />
        <span>{active ? "Salir" : "Inspeccionar"}</span>
      </Button>

      {active && (
        <section className="point-inspector-card" aria-label="Información geográfica del punto" role="status" aria-live="polite">
          <header className="point-inspector-card__header">
            <div>
              <p className="eyebrow">EXPLORACIÓN</p>
              <h2>Información del punto</h2>
            </div>
            <Button variant="ghost" size="icon" aria-label="Desactivar inspector" title="Desactivar inspector" onClick={onToggle}>
              <X size={16} aria-hidden="true" />
            </Button>
          </header>

          {!inspection && <p className="point-inspector-prompt">Pulsa una ubicación del mapa para consultar su terreno.</p>}

          {inspection?.status === "loading" && (
            <div className="point-inspector-message" role="status">
              <LoaderCircle size={15} className="spinner" aria-hidden="true" />
              <span>Consultando las teselas de terreno…</span>
            </div>
          )}

          {inspection && inspection.status !== "loading" && (
            <>
              <dl className="point-inspector-coordinates">
                <div><dt>Latitud</dt><dd>{formatCoordinate(inspection.latitude)}°</dd></div>
                <div><dt>Longitud</dt><dd>{formatCoordinate(inspection.longitude)}°</dd></div>
              </dl>
              <Button
                variant="outline"
                size="small"
                className="point-inspector-copy"
                onClick={() => void copyCoordinates()}
              >
                {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                <span>{copied ? "Coordenadas copiadas" : "Copiar coordenadas"}</span>
              </Button>
              {copyError && <p className="point-inspector-copy-error" role="alert">No se pudo copiar. Selecciona las coordenadas para copiarlas manualmente.</p>}

              {inspection.status === "available" && (
                <>
                  <dl className="point-inspector-values">
                    <div><dt>Elevación</dt><dd>{valueFormat.format(inspection.elevationMeters!)} m</dd></div>
                    <div>
                      <dt>Pendiente</dt>
                      <dd>{inspection.derivativesAvailable ? `${valueFormat.format(inspection.slopePercent!)} %` : "No disponible"}</dd>
                    </div>
                    <div>
                      <dt>Azimut de descenso</dt>
                      <dd>{inspection.derivativesAvailable
                        ? inspection.downslopeAzimuthDegrees === null ? "— (terreno plano)" : `${valueFormat.format(inspection.downslopeAzimuthDegrees!)}°`
                        : "No disponible"}</dd>
                    </div>
                    <div>
                      <dt>Orientación</dt>
                      <dd>{inspection.derivativesAvailable
                        ? inspection.aspectLabel ?? "Terreno plano"
                        : "No disponible"}</dd>
                    </div>
                  </dl>
                  {!inspection.derivativesAvailable && (
                    <p className="point-inspector-note">La elevación está disponible, pero faltan datos vecinos para calcular pendiente y orientación con fiabilidad.</p>
                  )}
                  <div className="point-inspector-source">
                    <span><strong>Fuente</strong>{inspection.source}</span>
                    <span><strong>Espaciado de tesela</strong>≈ {valueFormat.format(inspection.resolutionMeters!)} m · z{inspection.sourceZoom}</span>
                  </div>
                  <p className="point-inspector-note"><Activity size={13} aria-hidden="true" /> Valores orientativos. El espaciado de la tesela no garantiza la resolución nativa del terreno y no sustituye el análisis zonal.</p>
                </>
              )}

              {inspection.status === "no-data" && <p className="point-inspector-message point-inspector-message--warning">No hay datos válidos de terreno en este punto.</p>}
              {inspection.status === "outside-coverage" && <p className="point-inspector-message point-inspector-message--warning">Esta ubicación queda fuera de la cobertura de las teselas.</p>}
              {inspection.status === "unavailable" && <p className="point-inspector-message point-inspector-message--error">No se pudo consultar la fuente de terreno. Prueba otra ubicación más tarde.</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}
