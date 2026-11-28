import { useEffect, useState } from "react";
import { Activity, ArrowLeft, LoaderCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SelectedElementInfo } from "@/hooks/useDrawingTools";
import type { ElevationProfileState } from "@/hooks/useElevationProfiles";
import { TerrainAnalysisPanel } from "@/components/TerrainAnalysisPanel";
import type { AreaAnalysisState } from "@/lib/terrain-analysis";
import { formatArea, formatCoordinate, formatDistance } from "@/lib/geometry-metrics";

type GeometryDetailsProps = {
  element: SelectedElementInfo;
  analysis?: AreaAnalysisState;
  batchBusy?: boolean;
  elevationProfile?: ElevationProfileState;
  onBackToList: () => void;
  onAnalyzeArea: () => void;
  onResumeAnalysis: () => void;
  onRename: (id: string, name: string) => void;
  onGenerateProfile: () => void;
  onCancelProfile: () => void;
};

export function GeometryDetails({ element, analysis, batchBusy = false, elevationProfile, onBackToList, onAnalyzeArea, onResumeAnalysis, onRename, onGenerateProfile, onCancelProfile }: GeometryDetailsProps) {
  const [name, setName] = useState(element?.name ?? "");

  useEffect(() => setName(element?.name ?? ""), [element?.id, element?.name]);

  if (!element) return null;

  const rename = () => onRename(element.id, name);
  const value = element.geometry;
  const geometryLabel = value.kind === "Point" ? "Punto" : value.kind === "LineString" ? "Línea" : "Área";

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
      {value.kind === "LineString" && element.geoJsonLineString && (
        <section className="geometry-profile-action" aria-label="Perfil de elevación">
          <Button
            variant="outline"
            size="small"
            onClick={onGenerateProfile}
            disabled={elevationProfile?.status === "loading"}
          >
            {elevationProfile?.status === "loading"
              ? <LoaderCircle size={14} className="spinner" aria-hidden="true" />
              : <Activity size={14} aria-hidden="true" />}
            {elevationProfile?.result
              ? elevationProfile.status === "partial" ? "Ver perfil parcial" : "Ver perfil de elevación"
              : elevationProfile?.status === "loading" ? "Generando perfil…" : "Generar perfil de elevación"}
          </Button>
          {elevationProfile?.status === "loading" && (
            <Button variant="ghost" size="small" onClick={onCancelProfile} aria-label="Detener consulta del perfil">
              <X size={14} aria-hidden="true" /> Detener
            </Button>
          )}
          {elevationProfile?.status === "error" && <p className="geometry-profile-message geometry-profile-message--error" role="alert">{elevationProfile.message}</p>}
          {elevationProfile?.status === "cancelled" && <p className="geometry-profile-message">{elevationProfile.message}</p>}
          {elevationProfile?.status === "partial" && !elevationProfile.result && <p className="geometry-profile-message">{elevationProfile.message}</p>}
        </section>
      )}
      {value.kind === "Polygon" && element.geoJsonGeometry && (
        <TerrainAnalysisPanel
          analysis={analysis?.geometryRevision === element.geometryRevision ? analysis : analysis ? {
            geometryRevision: element.geometryRevision,
            state: "idle",
            message: "La geometría ha cambiado. Analiza de nuevo esta área para actualizar sus resultados.",
          } : undefined}
          batchBusy={batchBusy}
          onAnalyze={onAnalyzeArea}
          onResume={onResumeAnalysis}
        />
      )}
    </section>
  );
}
