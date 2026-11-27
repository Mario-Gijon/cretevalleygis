import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  LoaderCircle,
  Play,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ASPECT_CLASSES, ASPECT_FLAT_COLOR, SLOPE_CLASSES } from "@/lib/exploration-terrain";
import type { AreaAnalysisState, TerrainAnalysisResultResponse, TerrainVariableAnalysis } from "@/lib/terrain-analysis";

type TerrainAnalysisPanelProps = {
  analysis?: AreaAnalysisState;
  onAnalyze: () => void;
  onResume: () => void;
};

const numberFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const percentFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const aspectAreas: Record<string, string> = {
  N: "1 / 2",
  NE: "1 / 3",
  E: "2 / 3",
  SE: "3 / 3",
  S: "3 / 2",
  SO: "3 / 1",
  O: "2 / 1",
  NO: "1 / 1",
};

function formatNumber(value: number | null | undefined, digits = numberFormat): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "Sin datos"
    : digits.format(value);
}

function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "Sin datos"
    : `${percentFormat.format(value)} %`;
}

function formatMeters(value: number | null | undefined): string {
  const number = formatNumber(value);
  return number === "Sin datos" ? number : `${number} m`;
}

function warningText(warning: string): string {
  const lowCoverage = warning.match(/(elevation|slope|aspect): Valid \1 coverage of the polygon area is ([\d.]+)%, below/i);
  if (lowCoverage) {
    const variable = lowCoverage[1].toLowerCase() === "elevation"
      ? "elevación"
      : lowCoverage[1].toLowerCase() === "slope" ? "pendiente" : "orientación";
    return `Cobertura válida de ${variable} baja (${formatPercent(Number(lowCoverage[2]))}). Tenlo en cuenta al interpretar el resultado.`;
  }
  if (/No valid elevation pixels/i.test(warning)) return "No hay píxeles válidos de elevación dentro del área.";
  if (/No valid slope pixels/i.test(warning)) return "No hay píxeles válidos de pendiente dentro del área.";
  if (/No valid aspect pixels/i.test(warning)) return "No hay píxeles válidos de orientación dentro del área.";
  if (/pixel inclusion uses pixel centers/i.test(warning)) return "La cobertura ráster es aproximada: se cuentan los píxeles cuyo centro cae dentro del polígono.";
  if (/negative slope pixels were excluded/i.test(warning)) return "Se excluyeron píxeles con pendientes negativas como valores no válidos.";
  if (/out-of-range aspect pixels were excluded/i.test(warning)) return "Se excluyeron píxeles con orientaciones fuera de rango.";
  return warning;
}

function elevationMetrics(result: TerrainAnalysisResultResponse) {
  const statistics = result.result.elevation.statistics;
  return [
    ["Mínima", formatMeters(statistics?.minimum)],
    ["Máxima", formatMeters(statistics?.maximum)],
    ["Media", formatMeters(statistics?.mean)],
    ["Desviación", formatMeters(statistics?.standard_deviation)],
    ["Desnivel", formatMeters(statistics?.maximum_relief_m ?? statistics?.range)],
  ] as const;
}

function slopeMetrics(variable: TerrainVariableAnalysis) {
  const statistics = variable.statistics;
  return [
    ["Mínima", formatPercent(statistics?.minimum)],
    ["Máxima", formatPercent(statistics?.maximum)],
    ["Media", formatPercent(statistics?.mean)],
    ["Desviación", formatPercent(statistics?.standard_deviation)],
  ] as const;
}

function VariableCoverage({ label, variable }: { label: string; variable: TerrainVariableAnalysis }) {
  const percent = variable.quality.valid_coverage_percent;
  const noData = variable.status === "no_data";
  return (
    <div className="analysis-coverage-row">
      <span>{label}</span>
      <div className="analysis-coverage-track" aria-hidden="true">
        <i className={percent < 90 || noData ? "analysis-coverage-track__fill analysis-coverage-track__fill--low" : "analysis-coverage-track__fill"} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
      <strong>{noData ? "Sin datos" : formatPercent(percent)}</strong>
    </div>
  );
}

function Results({ result }: { result: TerrainAnalysisResultResponse }) {
  const statistics = result.result;
  const elevationMean = statistics.elevation.statistics?.mean;
  const slopeMean = statistics.slope.statistics?.mean;
  const maximumRelief = statistics.elevation.statistics?.maximum_relief_m ?? statistics.elevation.statistics?.range;
  const gentleSlope = statistics.slope.distribution?.categories.find((category) => category.id === "slope-0-5");
  const warnings = statistics.warnings.map(warningText);
  const coverageWarnings = warnings.filter((warning) => /cobertura válida/i.test(warning));

  return (
    <div className="analysis-result" aria-label="Resultados del análisis del terreno">
      {result.data_status === "no_valid_data" ? (
        <div className="analysis-notice analysis-notice--muted">
          <CircleHelp size={15} aria-hidden="true" />
          <span>No hay datos válidos dentro de esta área. La ausencia de datos no representa una elevación de cero.</span>
        </div>
      ) : result.data_status === "partial_data" ? (
        <div className="analysis-notice analysis-notice--warning">
          <AlertCircle size={15} aria-hidden="true" />
          <span>Hay variables sin cobertura válida. Los valores disponibles se muestran por separado.</span>
        </div>
      ) : null}

      {coverageWarnings.length > 0 && (
        <div className="analysis-notice analysis-notice--warning" role="status">
          <AlertCircle size={15} aria-hidden="true" />
          <div>{coverageWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
        </div>
      )}

      {result.data_status !== "no_valid_data" && (
        <>
          <div className="analysis-primary-metrics">
            <article className="analysis-primary-metric">
              <span>Elevación media</span>
              <strong>{formatMeters(elevationMean)}</strong>
            </article>
            <article className="analysis-primary-metric">
              <span>Pendiente media</span>
              <strong>{formatPercent(slopeMean)}</strong>
            </article>
            <article className="analysis-primary-metric">
              <span>Desnivel máximo</span>
              <strong>{formatMeters(maximumRelief)}</strong>
            </article>
            <article className="analysis-primary-metric">
              <span>Superficie ≤5 %</span>
              <strong>{formatPercent(gentleSlope?.percentage)}</strong>
              <small>de la superficie válida</small>
            </article>
          </div>

          <details className="analysis-results-section">
            <summary><span>Elevación</span><ChevronDown size={14} aria-hidden="true" /></summary>
            <dl className="analysis-stat-grid">
              {elevationMetrics(result).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
          </details>

          <details className="analysis-results-section">
            <summary><span>Pendientes</span><ChevronDown size={14} aria-hidden="true" /></summary>
            <dl className="analysis-stat-grid">
              {slopeMetrics(statistics.slope).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
            {statistics.slope.distribution && (
              <div className="analysis-slope-distribution" aria-label="Distribución de pendientes">
                {statistics.slope.distribution.categories.map((category, index) => (
                  <div className="analysis-distribution-row" key={category.id}>
                    <span>{category.label}</span>
                    <div className="analysis-distribution-track" aria-hidden="true">
                      <i style={{ width: `${Math.max(0, Math.min(100, category.percentage ?? 0))}%`, backgroundColor: SLOPE_CLASSES[index]?.color }} />
                    </div>
                    <strong>{formatPercent(category.percentage)}</strong>
                  </div>
                ))}
              </div>
            )}
          </details>

          <details className="analysis-results-section">
            <summary><span>Orientación de laderas</span><ChevronDown size={14} aria-hidden="true" /></summary>
            {statistics.aspect.distribution && (
              <div className="analysis-aspect-grid" aria-label="Distribución por orientación">
                {ASPECT_CLASSES.map((aspect) => {
                  const category = statistics.aspect.distribution?.categories.find((item) => item.id === `aspect-${aspect.direction.toLowerCase()}`);
                  return (
                    <div className="analysis-aspect-cell" key={aspect.direction} style={{ gridArea: aspectAreas[aspect.direction] }} title={`${aspect.label}: ${formatPercent(category?.percentage)}`}>
                      <span>{aspect.direction}</span><strong>{formatPercent(category?.percentage)}</strong>
                      <i style={{ width: `${Math.max(0, Math.min(100, category?.percentage ?? 0))}%`, backgroundColor: aspect.color }} aria-hidden="true" />
                    </div>
                  );
                })}
                {(() => {
                  const flat = statistics.aspect.distribution?.categories.find((item) => item.id === "aspect-flat");
                  return <div className="analysis-aspect-cell analysis-aspect-cell--flat" style={{ gridArea: "2 / 2" }} title={`Terreno plano: ${formatPercent(flat?.percentage)}`}><span>Plano</span><strong>{formatPercent(flat?.percentage)}</strong><i style={{ width: `${Math.max(0, Math.min(100, flat?.percentage ?? 0))}%`, backgroundColor: ASPECT_FLAT_COLOR }} aria-hidden="true" /></div>;
                })()}
              </div>
            )}
          </details>
        </>
      )}

      <details className="analysis-results-section analysis-data-section">
        <summary><span>Información de los datos</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <dl className="analysis-data-list">
          <div><dt>Fuente</dt><dd>{result.source}</dd></div>
          <div><dt>Resolución</dt><dd>{result.resolution_m} m</dd></div>
          <div><dt>CRS</dt><dd>{result.horizontal_crs}</dd></div>
          <div><dt>Fecha del análisis</dt><dd>{new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short" }).format(new Date(result.calculated_at))}</dd></div>
          <VariableCoverage label="Elevación válida" variable={statistics.elevation} />
          <VariableCoverage label="Pendiente válida" variable={statistics.slope} />
          <VariableCoverage label="Orientación válida" variable={statistics.aspect} />
          {warnings.length > 0 && (
            <div className="analysis-warnings">
              <dt>Advertencias</dt>
              {warnings.map((warning) => <dd key={warning}>{warning}</dd>)}
            </div>
          )}
        </dl>
      </details>
      <p className="analysis-orientation-note">La orientación se expresa por direcciones; no se calcula una media angular.</p>
      <p className="analysis-precision-note">Resultados orientativos · píxeles de 30 m · cálculo sobre el polígono original.</p>
    </div>
  );
}

export function TerrainAnalysisPanel({ analysis, onAnalyze, onResume }: TerrainAnalysisPanelProps) {
  const busy = analysis?.state === "submitting" || analysis?.state === "running";
  const canAnalyze = !analysis || analysis.state === "idle" || (analysis.state === "error" && analysis.retryMode === "submit");
  const canResume = analysis?.state === "tracking-error" && analysis.retryMode === "resume";

  return (
    <section className="area-analysis-panel" aria-labelledby="area-analysis-title">
      <div className="area-analysis-heading">
        <h2 className="eyebrow" id="area-analysis-title">ANÁLISIS DEL TERRENO</h2>
        {analysis?.state === "completed" && <CheckCircle2 size={15} aria-label="Análisis completado" className="area-analysis-complete-icon" />}
      </div>

      {canAnalyze && (
        <Button variant="outline" size="small" className="area-analysis-action" onClick={onAnalyze}>
          {analysis?.state === "error" ? <RefreshCw size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          {analysis?.state === "error" ? "Reintentar análisis" : "Analizar área"}
        </Button>
      )}

      {busy && (
        <div className="area-analysis-status" role="status" aria-live="polite">
          <LoaderCircle size={15} className="spinner" aria-hidden="true" />
          <div><strong>{analysis.stage ?? "En curso"}</strong><span>Puedes seguir usando el mapa.</span></div>
        </div>
      )}

      {analysis?.state === "idle" && analysis.message && <p className="area-analysis-message">{analysis.message}</p>}
      {analysis?.state === "error" && (
        <div className="analysis-notice analysis-notice--warning" role="alert">
          <AlertCircle size={15} aria-hidden="true" /><span>{analysis.message}</span>
        </div>
      )}
      {analysis?.state === "tracking-error" && (
        <div className="analysis-notice analysis-notice--warning" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{analysis.message}</span>
          {canResume && <Button variant="ghost" size="small" onClick={onResume}>Reanudar seguimiento</Button>}
        </div>
      )}

      {!analysis && <p className="area-analysis-hint">Consulta elevación, pendiente y orientación dentro de esta área.</p>}
      {analysis?.state === "completed" && analysis.result && <Results result={analysis.result} />}
    </section>
  );
}
