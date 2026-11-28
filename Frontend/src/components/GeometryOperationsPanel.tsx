import { useState } from "react";
import { ArrowLeftRight, GitCompareArrows, LoaderCircle, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DrawnElement } from "@/hooks/useDrawingTools";
import type { GeometryOperationPreview, GeometryOverlayOperation } from "@/hooks/useGeometryOperations";
import { formatArea } from "@/lib/geometry-metrics";
import { isSurfaceGeometryType } from "@/lib/geometry-types";

type GeometryOperationsPanelProps = {
  areas: DrawnElement[];
  preview: GeometryOperationPreview | null;
  onGeneratePreview: (operation: GeometryOverlayOperation, areaAId: string, areaBId: string) => void;
  onConfirm: (operation: GeometryOverlayOperation, areaAId: string, areaBId: string, name: string) => void;
  onClearPreview: () => void;
  onClose: () => void;
};

const operationDescriptions: Record<GeometryOverlayOperation, string> = {
  union: "Combina las superficies de ambas áreas y cuenta una sola vez la zona compartida.",
  intersection: "Conserva únicamente la superficie común a ambas áreas.",
  difference: "Conserva A y sustrae B. El orden de las áreas cambia el resultado.",
};

const operationLabels: Record<GeometryOverlayOperation, string> = {
  union: "Unión",
  intersection: "Intersección",
  difference: "Diferencia",
};

export function GeometryOperationsPanel({ areas, preview, onGeneratePreview, onConfirm, onClearPreview, onClose }: GeometryOperationsPanelProps) {
  const eligibleAreas = areas.filter((area) => isSurfaceGeometryType(area.geometryType) && area.geoJsonGeometry);
  const [areaAId, setAreaAId] = useState(eligibleAreas[0]?.id ?? "");
  const [areaBId, setAreaBId] = useState(eligibleAreas.find((area) => area.id !== eligibleAreas[0]?.id)?.id ?? "");
  const [operation, setOperation] = useState<GeometryOverlayOperation>("union");
  const [name, setName] = useState("Resultado geométrico");

  const areaA = eligibleAreas.find((area) => area.id === areaAId) ?? eligibleAreas[0];
  const areaB = eligibleAreas.find((area) => area.id === areaBId && area.id !== areaA?.id)
    ?? eligibleAreas.find((area) => area.id !== areaA?.id);
  const selectedAId = areaA?.id ?? "";
  const selectedBId = areaB?.id ?? "";
  const canOperate = Boolean(areaA && areaB && areaA.id !== areaB.id);
  const currentPreview = preview?.status === "preview"
    && preview.operation === operation
    && preview.areaAId === selectedAId
    && preview.areaBId === selectedBId
    && preview.areaAGeometryRevision === areaA?.geometryRevision
    && preview.areaBGeometryRevision === areaB?.geometryRevision
    ? preview
    : null;
  const loading = preview?.status === "loading";

  const updateInputs = () => onClearPreview();
  const swapAreas = () => {
    if (!areaA || !areaB) return;
    setAreaAId(areaB.id);
    setAreaBId(areaA.id);
    updateInputs();
  };

  return (
    <section className="geometry-operations-panel" aria-labelledby="geometry-operations-title">
      <div className="geometry-operations-heading">
        <div>
          <h3 id="geometry-operations-title"><GitCompareArrows size={15} aria-hidden="true" /> Operaciones geométricas</h3>
          <p>Combina dos áreas dibujadas en una nueva.</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Cerrar operaciones geométricas" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </Button>
      </div>

      {eligibleAreas.length < 2 ? (
        <p className="geometry-operations-message">Se necesitan dos áreas disponibles para continuar.</p>
      ) : (
        <>
          <div className="geometry-operations-area-row">
            <label htmlFor="geometry-operation-area-a">Área A</label>
            <select
              id="geometry-operation-area-a"
              value={selectedAId}
              disabled={loading}
              onChange={(event) => {
                setAreaAId(event.currentTarget.value);
                updateInputs();
              }}
            >
              {eligibleAreas.map((area) => <option key={area.id} value={area.id} disabled={area.id === selectedBId}>{area.name}</option>)}
            </select>
          </div>
          <div className="geometry-operations-swap-row">
            <span aria-hidden="true" />
            <Button variant="ghost" size="small" onClick={swapAreas} disabled={!canOperate || loading}>
              <ArrowLeftRight size={14} aria-hidden="true" /> Intercambiar A y B
            </Button>
          </div>
          <div className="geometry-operations-area-row">
            <label htmlFor="geometry-operation-area-b">Área B</label>
            <select
              id="geometry-operation-area-b"
              value={selectedBId}
              disabled={loading}
              onChange={(event) => {
                setAreaBId(event.currentTarget.value);
                updateInputs();
              }}
            >
              {eligibleAreas.map((area) => <option key={area.id} value={area.id} disabled={area.id === selectedAId}>{area.name}</option>)}
            </select>
          </div>

          <label className="geometry-operations-field" htmlFor="geometry-operation-type">
            <span>Operación</span>
            <select
              id="geometry-operation-type"
              value={operation}
              disabled={loading}
              onChange={(event) => {
                setOperation(event.currentTarget.value as GeometryOverlayOperation);
                updateInputs();
              }}
            >
              {Object.entries(operationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <p className="geometry-operations-description">
            {operation === "difference" && areaA && areaB
              ? `Se conservará A («${areaA.name}») y se sustraerá B («${areaB.name}»).`
              : operationDescriptions[operation]}
          </p>

          <label className="geometry-operations-field" htmlFor="geometry-operation-result-name">
            <span>Nombre del área resultante</span>
            <input
              id="geometry-operation-result-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>

          {preview?.status === "loading" && <p className="geometry-operations-message" role="status">Calculando la vista previa en el servidor…</p>}
          {preview?.status === "error" && <p className="geometry-operations-message geometry-operations-message--error" role="alert">{preview.message}</p>}
          {preview?.status === "empty" && (
            <p className="geometry-operations-message geometry-operations-message--empty" role="status">{preview.message}</p>
          )}
          {currentPreview && currentPreview.geometryInfo && (
            <div className="geometry-operations-result" role="status">
              <strong>Vista previa · {operationLabels[operation]}</strong>
              <span>Superficie {formatArea(currentPreview.geometryInfo.area)}</span>
              <span>{currentPreview.geometryInfo.polygonCount} {currentPreview.geometryInfo.polygonCount === 1 ? "polígono" : "polígonos"}</span>
              {currentPreview.processingCrs && <span>CRS de cálculo {currentPreview.processingCrs}</span>}
            </div>
          )}
          {preview?.warnings.map((warning, index) => <p className="geometry-operations-message" key={`${warning}-${index}`}>{warning}</p>)}

          <div className="geometry-operations-actions">
            <Button
              variant="outline"
              size="small"
              disabled={!canOperate || loading}
              onClick={() => onGeneratePreview(operation, selectedAId, selectedBId)}
            >
              {loading ? <LoaderCircle size={14} className="spinner" aria-hidden="true" /> : <GitCompareArrows size={14} aria-hidden="true" />}
              {loading ? "Calculando…" : "Generar vista previa"}
            </Button>
            {currentPreview ? (
              <Button
                variant="primary"
                size="small"
                disabled={!name.trim()}
                onClick={() => onConfirm(operation, selectedAId, selectedBId, name.trim())}
              >
                <Sparkles size={14} aria-hidden="true" /> Añadir área
              </Button>
            ) : loading ? (
              <Button variant="ghost" size="small" onClick={onClearPreview}><X size={14} aria-hidden="true" /> Cancelar</Button>
            ) : null}
          </div>
          {currentPreview && <Button variant="ghost" size="small" className="geometry-operations-clear" onClick={onClearPreview}>Cancelar vista previa</Button>}
        </>
      )}
    </section>
  );
}
