import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { AlertCircle, ArrowUpRight, LoaderCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTerrainAnalysisWarning } from "@/components/TerrainAnalysisPanel";
import type { DrawnElement } from "@/hooks/useDrawingTools";
import type { AreaAnalysisState, TerrainVariableAnalysis } from "@/lib/terrain-analysis";
import {
  analysisStatusLabel,
  buildObjectiveCriterionCell,
  OBJECTIVE_CRITERION_CATEGORIES,
  OBJECTIVE_CRITERIA,
  type ObjectiveCellStatus,
  type ObjectiveCriterion,
} from "@/lib/objective-criteria";

type ObjectiveAreaComparisonProps = {
  areas: DrawnElement[];
  analyses: Record<string, AreaAnalysisState>;
  selectedAreaIds: string[];
  onSelectedAreaIdsChange: (ids: string[]) => void;
  selectedCriterionIds: string[];
  onSelectedCriterionIdsChange: (ids: string[]) => void;
  onClose: () => void;
  onOpenArea: (areaId: string) => void;
};

const valueFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const COVERAGE_WARNING_THRESHOLD = 90;

const cellStatusLabels: Record<ObjectiveCellStatus, string> = {
  available: "Disponible",
  pending: "Pendiente de analizar",
  running: "Análisis en curso",
  invalidated: "Resultado invalidado",
  insufficient_data: "Datos insuficientes",
  error: "Error de procesamiento",
};

function formatCellValue(value: number | null, unit: ObjectiveCriterion["unit"]): string {
  if (value === null || !Number.isFinite(value)) return "";
  return `${valueFormat.format(value)} ${unit}`;
}

function variableQualityNotes(areaName: string, label: string, variable: TerrainVariableAnalysis): string[] {
  if (variable.status === "no_data") return [`${areaName} · ${label}: no hay datos válidos.`];
  if (variable.quality.valid_coverage_percent >= COVERAGE_WARNING_THRESHOLD) return [];
  return [
    `${areaName} · ${label}: cobertura válida baja (${percentFormat.format(variable.quality.valid_coverage_percent)} %). Tenlo en cuenta al interpretar los valores.`,
  ];
}

function collectQualityNotes(
  areas: DrawnElement[],
  analyses: Record<string, AreaAnalysisState>,
): string[] {
  const notes = new Set<string>();
  for (const area of areas) {
    const analysis = analyses[area.id];
    if (analysis?.state !== "completed" || analysis.geometryRevision !== area.geometryRevision || !analysis.result) continue;
    const statistics = analysis.result.result;
    for (const warning of [
      ...statistics.warnings,
      ...statistics.elevation.warnings,
      ...statistics.slope.warnings,
      ...statistics.aspect.warnings,
    ]) {
      // Coverage is rendered once per variable below, including its measured percent.
      // Suppress the backend's equivalent English warnings here to avoid duplicates.
      if (/valid (?:elevation|slope|aspect) coverage of the polygon area/i.test(warning)) continue;
      notes.add(`${area.name}: ${formatTerrainAnalysisWarning(warning)}`);
    }
    for (const [label, variable] of [
      ["elevación", statistics.elevation],
      ["pendiente", statistics.slope],
      ["orientación", statistics.aspect],
    ] as const) {
      variableQualityNotes(area.name, label, variable).forEach((note) => notes.add(note));
    }
  }
  return [...notes];
}

function AnalysisStatus({ area, analysis }: { area: DrawnElement; analysis?: AreaAnalysisState }) {
  const status = analysisStatusLabel(area, analysis);
  return (
    <span className={`comparison-status comparison-status--${status.status}`}>
      {status.status === "running" ? <LoaderCircle className="spinner" size={12} aria-hidden="true" /> : null}
      {status.label}
    </span>
  );
}

function ComparisonCell({ cell }: { cell: ReturnType<typeof buildObjectiveCriterionCell> }) {
  return (
    <td className={`objective-matrix-cell objective-matrix-cell--${cell.status}`}>
      <span className="objective-matrix-value">
        {cell.status === "available" ? formatCellValue(cell.value, cell.unit) : cellStatusLabels[cell.status]}
      </span>
      {cell.quality && (
        <span className={`objective-matrix-quality${cell.quality.validCoveragePercent < COVERAGE_WARNING_THRESHOLD ? " objective-matrix-quality--low" : ""}`}>
          {cell.quality.validCoveragePercent < COVERAGE_WARNING_THRESHOLD && <AlertCircle size={11} aria-hidden="true" />}
          Cobertura válida {percentFormat.format(cell.quality.validCoveragePercent)} %
        </span>
      )}
    </td>
  );
}

export function ObjectiveAreaComparison({
  areas,
  analyses,
  selectedAreaIds,
  onSelectedAreaIdsChange,
  selectedCriterionIds,
  onSelectedCriterionIdsChange,
  onClose,
  onOpenArea,
}: ObjectiveAreaComparisonProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const selectedAreas = useMemo(
    () => areas.filter((area) => selectedAreaIds.includes(area.id)),
    [areas, selectedAreaIds],
  );
  const selectedCriteria = useMemo(
    () => OBJECTIVE_CRITERIA.filter((criterion) => selectedCriterionIds.includes(criterion.id)),
    [selectedCriterionIds],
  );
  const qualityNotes = useMemo(() => collectQualityNotes(selectedAreas, analyses), [selectedAreas, analyses]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const toggleArea = (id: string) => {
    onSelectedAreaIdsChange(selectedAreaIds.includes(id)
      ? selectedAreaIds.filter((selectedId) => selectedId !== id)
      : [...selectedAreaIds, id]);
  };

  const toggleCriterion = (id: string) => {
    onSelectedCriterionIdsChange(selectedCriterionIds.includes(id)
      ? selectedCriterionIds.filter((selectedId) => selectedId !== id)
      : [...selectedCriterionIds, id]);
  };

  const toggleCategory = (criterionIds: string[], checked: boolean) => {
    const selected = new Set(selectedCriterionIds);
    criterionIds.forEach((id) => checked ? selected.add(id) : selected.delete(id));
    onSelectedCriterionIdsChange([...selected]);
  };

  const allCriterionIds = OBJECTIVE_CRITERIA.map((criterion) => criterion.id);

  return (
    <dialog
      ref={dialogRef}
      className="objective-comparison-dialog"
      aria-labelledby="objective-comparison-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="objective-comparison-shell">
        <header className="objective-comparison-header">
          <div>
            <p className="eyebrow">ÁREAS</p>
            <h2 id="objective-comparison-title">Comparación de áreas</h2>
            <p>Compara las medidas geométricas y los resultados disponibles.</p>
          </div>
          <Button ref={closeButtonRef} variant="ghost" size="icon" aria-label="Cerrar comparación" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </Button>
        </header>

        <div className="objective-comparison-content">
          <aside className="objective-comparison-controls" aria-label="Selección de áreas y criterios">
            <section className="comparison-control-section" aria-labelledby="comparison-areas-title">
              <div className="comparison-control-heading">
                <div>
                  <h3 id="comparison-areas-title">Áreas incluidas</h3>
                  <p>Selecciona los polígonos que quieres comparar.</p>
                </div>
                <span>{selectedAreas.length}</span>
              </div>
              <ul className="comparison-area-list">
                {areas.map((area) => {
                  const status = analysisStatusLabel(area, analyses[area.id]);
                  return (
                    <li className="comparison-area-option" key={area.id}>
                      <label>
                        <input type="checkbox" checked={selectedAreaIds.includes(area.id)} onChange={() => toggleArea(area.id)} />
                        <span className="comparison-area-option__copy">
                          <strong>{area.name}</strong>
                          <AnalysisStatus area={area} analysis={analyses[area.id]} />
                        </span>
                      </label>
                      {status.status !== "available" && (
                        <button type="button" className="comparison-area-open" onClick={() => onOpenArea(area.id)} aria-label={`Abrir ficha de ${area.name}`} title="Abrir ficha para consultar o iniciar su análisis">
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="comparison-control-section comparison-criteria-section" aria-labelledby="comparison-criteria-title">
              <div className="comparison-control-heading">
                <div>
                  <h3 id="comparison-criteria-title">Criterios</h3>
                  <p>Elige las filas de la matriz.</p>
                </div>
                <span>{selectedCriteria.length}</span>
              </div>
              <div className="comparison-criteria-actions">
                <button type="button" onClick={() => onSelectedCriterionIdsChange(allCriterionIds)}>Seleccionar todos</button>
                <button type="button" onClick={() => onSelectedCriterionIdsChange([])}>Limpiar</button>
              </div>
              <div className="comparison-criteria-groups">
                {OBJECTIVE_CRITERION_CATEGORIES.map((category) => {
                  const categoryCriteria = OBJECTIVE_CRITERIA.filter((criterion) => criterion.category === category.id);
                  const categoryIds = categoryCriteria.map((criterion) => criterion.id);
                  const categorySelectedCount = categoryIds.filter((id) => selectedCriterionIds.includes(id)).length;
                  return (
                    <details className="comparison-criterion-group" key={category.id} open>
                      <summary>
                        <span>{category.name}</span><small>{categorySelectedCount}/{categoryCriteria.length}</small>
                      </summary>
                      <div className="comparison-criterion-group__actions">
                        <button type="button" onClick={() => toggleCategory(categoryIds, true)}>Todos</button>
                        <button type="button" onClick={() => toggleCategory(categoryIds, false)}>Ninguno</button>
                      </div>
                      {categoryCriteria.map((criterion) => (
                        <label className="comparison-criterion-option" key={criterion.id} title={criterion.description}>
                          <input type="checkbox" checked={selectedCriterionIds.includes(criterion.id)} onChange={() => toggleCriterion(criterion.id)} />
                          <span>{criterion.name}</span>
                        </label>
                      ))}
                    </details>
                  );
                })}
              </div>
            </section>
          </aside>

          <main className="objective-comparison-matrix" aria-label="Matriz de criterios objetivos">
            <div className="objective-matrix-heading">
              <div>
                <h3>Matriz comparativa</h3>
                <p>{selectedAreas.length} {selectedAreas.length === 1 ? "área" : "áreas"} · {selectedCriteria.length} {selectedCriteria.length === 1 ? "criterio" : "criterios"}</p>
              </div>
              {selectedAreaIds.length < 2 && selectedAreaIds.length > 0 && <span>Selecciona otra área para comparar.</span>}
            </div>

            {qualityNotes.length > 0 && (
              <aside className="comparison-quality-alerts" aria-label="Advertencias de calidad de los datos">
                <AlertCircle size={15} aria-hidden="true" />
                <ul>{qualityNotes.map((note) => <li key={note}>{note}</li>)}</ul>
              </aside>
            )}

            <div className="objective-matrix-scroll">
              {selectedAreas.length === 0 || selectedCriteria.length === 0 ? (
                <div className="objective-comparison-empty">
                  <p>{selectedAreas.length === 0 ? "Selecciona al menos un polígono." : "Selecciona al menos un criterio para mostrar la matriz."}</p>
                </div>
              ) : (
                <table className="objective-matrix-table">
                  <thead>
                    <tr>
                      <th scope="col">Criterio</th>
                      {selectedAreas.map((area) => (
                        <th scope="col" key={area.id}>
                          <span className="objective-matrix-area-name">{area.name}</span>
                          <AnalysisStatus area={area} analysis={analyses[area.id]} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {OBJECTIVE_CRITERION_CATEGORIES.map((category) => {
                      const categoryCriteria = selectedCriteria.filter((criterion) => criterion.category === category.id);
                      if (!categoryCriteria.length) return null;
                      return (
                        <FragmentCategory key={category.id} title={category.name} colSpan={selectedAreas.length + 1}>
                          {categoryCriteria.map((criterion) => (
                            <tr key={criterion.id}>
                              <th scope="row" title={criterion.description}>
                                <span>{criterion.name}</span>
                                <small>{criterion.unit}</small>
                              </th>
                              {selectedAreas.map((area) => (
                                <ComparisonCell
                                  key={`${area.id}:${criterion.id}`}
                                  cell={buildObjectiveCriterionCell(area, criterion, analyses[area.id])}
                                />
                              ))}
                            </tr>
                          ))}
                        </FragmentCategory>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <p className="objective-comparison-footnote">
              Los porcentajes de pendiente y orientación usan como denominador la superficie válida analizada, que puede ser menor que toda el área. Los valores nulos se muestran como datos insuficientes, nunca como cero.
            </p>
          </main>
        </div>
      </div>
    </dialog>
  );
}

function FragmentCategory({ title, colSpan, children }: { title: string; colSpan: number; children: ReactNode }) {
  return (
    <>
      <tr className="objective-matrix-category-row"><th scope="colgroup" colSpan={colSpan}>{title}</th></tr>
      {children}
    </>
  );
}
