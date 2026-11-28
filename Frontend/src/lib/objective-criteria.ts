import type { DrawnElement } from "@/hooks/useDrawingTools";
import type {
  AreaAnalysisState,
  TerrainAnalysisResultResponse,
  TerrainVariableAnalysis,
} from "@/lib/terrain-analysis";

export type ObjectiveCriterionCategoryId = "geometry" | "elevation" | "slope" | "aspect";
export type ObjectiveCriterionDependency = Exclude<ObjectiveCriterionCategoryId, "geometry">;
export type ObjectiveCellStatus = "available" | "pending" | "running" | "invalidated" | "insufficient_data" | "error";

export type ObjectiveCriterionQuality = {
  validCoveragePercent: number;
  validPixelCount: number;
  includedPixelCount: number;
  validSurfaceAreaM2: number;
  resolutionM: { x: number; y: number };
  crs: string;
  source: string | null;
  distributionDenominatorPixelCount: number | null;
  warnings: string[];
};

export type ObjectiveCriterionContext = {
  area: DrawnElement;
  analysis?: AreaAnalysisState;
  result?: TerrainAnalysisResultResponse;
};

export type ObjectiveCriterion = {
  id: string;
  name: string;
  description: string;
  unit: "ha" | "m" | "%";
  category: ObjectiveCriterionCategoryId;
  dependencies: readonly ObjectiveCriterionDependency[];
  getValue: (context: ObjectiveCriterionContext) => number | null;
};

export type ObjectiveCriterionCell = {
  areaId: string;
  criterionId: string;
  value: number | null;
  unit: ObjectiveCriterion["unit"];
  status: ObjectiveCellStatus;
  quality: ObjectiveCriterionQuality | null;
  analysisId: string | null;
};

export const OBJECTIVE_CRITERION_CATEGORIES: ReadonlyArray<{
  id: ObjectiveCriterionCategoryId;
  name: string;
}> = [
  { id: "geometry", name: "Geometría" },
  { id: "elevation", name: "Elevación" },
  { id: "slope", name: "Pendientes" },
  { id: "aspect", name: "Orientación de laderas" },
];

function statistic(context: ObjectiveCriterionContext, variable: ObjectiveCriterionDependency, key: "minimum" | "maximum" | "mean" | "standard_deviation"): number | null {
  const value = context.result?.result[variable].statistics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function slopeShare(context: ObjectiveCriterionContext, categoryIds: readonly string[]): number | null {
  return distributionShare(context.result?.result.slope, categoryIds);
}

function aspectShare(context: ObjectiveCriterionContext, categoryIds: readonly string[]): number | null {
  return distributionShare(context.result?.result.aspect, categoryIds);
}

function distributionShare(variable: TerrainVariableAnalysis | undefined, categoryIds: readonly string[]): number | null {
  const distribution = variable?.distribution;
  if (!distribution || distribution.denominator_pixel_count <= 0) return null;
  const selected = categoryIds.map((id) => distribution.categories.find((category) => category.id === id));
  if (selected.some((category) => !category)) return null;
  const validPixelCount = selected.reduce((sum, category) => sum + (category?.pixel_count ?? 0), 0);
  return (validPixelCount / distribution.denominator_pixel_count) * 100;
}

const geometryCriterion = (
  id: string,
  name: string,
  description: string,
  unit: "ha" | "m",
  getValue: ObjectiveCriterion["getValue"],
): ObjectiveCriterion => ({ id, name, description, unit, category: "geometry", dependencies: [], getValue });

const analyticalCriterion = (
  id: string,
  name: string,
  description: string,
  unit: ObjectiveCriterion["unit"],
  category: ObjectiveCriterionDependency,
  getValue: ObjectiveCriterion["getValue"],
): ObjectiveCriterion => ({ id, name, description, unit, category, dependencies: [category], getValue });

export const OBJECTIVE_CRITERIA: readonly ObjectiveCriterion[] = [
  geometryCriterion("geometry-area-ha", "Superficie", "Superficie geodésica actual del área.", "ha", ({ area }) => (
    area.geometryInfo?.kind === "Area" ? area.geometryInfo.area / 10_000 : null
  )),
  geometryCriterion("geometry-perimeter-m", "Perímetro", "Perímetro geodésico actual del área.", "m", ({ area }) => (
    area.geometryInfo?.kind === "Area" ? area.geometryInfo.perimeter : null
  )),

  analyticalCriterion("elevation-minimum-m", "Elevación mínima", "Valor mínimo de elevación dentro de los píxeles válidos.", "m", "elevation", (context) => statistic(context, "elevation", "minimum")),
  analyticalCriterion("elevation-maximum-m", "Elevación máxima", "Valor máximo de elevación dentro de los píxeles válidos.", "m", "elevation", (context) => statistic(context, "elevation", "maximum")),
  analyticalCriterion("elevation-mean-m", "Elevación media", "Media de elevación sobre los píxeles válidos.", "m", "elevation", (context) => statistic(context, "elevation", "mean")),
  analyticalCriterion("elevation-standard-deviation-m", "Desviación estándar de elevación", "Dispersión de los valores de elevación.", "m", "elevation", (context) => statistic(context, "elevation", "standard_deviation")),
  analyticalCriterion("elevation-maximum-relief-m", "Desnivel máximo", "Diferencia entre elevación máxima y mínima.", "m", "elevation", ({ result }) => {
    const statistics = result?.result.elevation.statistics;
    const value = statistics?.maximum_relief_m ?? statistics?.range;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }),

  analyticalCriterion("slope-minimum-percent", "Pendiente mínima", "Pendiente mínima entre los píxeles válidos.", "%", "slope", (context) => statistic(context, "slope", "minimum")),
  analyticalCriterion("slope-maximum-percent", "Pendiente máxima", "Pendiente máxima entre los píxeles válidos.", "%", "slope", (context) => statistic(context, "slope", "maximum")),
  analyticalCriterion("slope-mean-percent", "Pendiente media", "Media de pendiente sobre los píxeles válidos.", "%", "slope", (context) => statistic(context, "slope", "mean")),
  analyticalCriterion("slope-standard-deviation-percent", "Desviación estándar de pendiente", "Dispersión de los valores de pendiente.", "%", "slope", (context) => statistic(context, "slope", "standard_deviation")),
  analyticalCriterion("slope-up-to-5-percent", "Superficie con pendiente ≤5 %", "Porcentaje de píxeles válidos en la clase original 0–5 %.", "%", "slope", (context) => slopeShare(context, ["slope-0-5"])),
  analyticalCriterion("slope-up-to-15-percent", "Superficie con pendiente ≤15 %", "Suma de recuentos válidos de las clases 0–5 % y >5–15 %.", "%", "slope", (context) => slopeShare(context, ["slope-0-5", "slope-5-15"])),
  analyticalCriterion("slope-up-to-30-percent", "Superficie con pendiente ≤30 %", "Suma de recuentos válidos de las clases hasta >15–30 %.", "%", "slope", (context) => slopeShare(context, ["slope-0-5", "slope-5-15", "slope-15-30"])),
  analyticalCriterion("slope-over-60-percent", "Superficie con pendiente >60 %", "Porcentaje de píxeles válidos en la clase original >60 %.", "%", "slope", (context) => slopeShare(context, ["slope-over-60"])),

  analyticalCriterion("aspect-north-percent", "Orientación norte", "Porcentaje de píxeles válidos de la categoría aspect-n.", "%", "aspect", (context) => aspectShare(context, ["aspect-n"])),
  analyticalCriterion("aspect-east-percent", "Orientación este", "Porcentaje de píxeles válidos de la categoría aspect-e.", "%", "aspect", (context) => aspectShare(context, ["aspect-e"])),
  analyticalCriterion("aspect-south-percent", "Orientación sur", "Porcentaje de píxeles válidos de la categoría aspect-s.", "%", "aspect", (context) => aspectShare(context, ["aspect-s"])),
  analyticalCriterion("aspect-west-percent", "Orientación oeste", "Porcentaje de píxeles válidos de la categoría aspect-o.", "%", "aspect", (context) => aspectShare(context, ["aspect-o"])),
  analyticalCriterion("aspect-southern-quadrants-percent", "Orientación sur, sureste o suroeste", "Suma de recuentos válidos de aspect-s, aspect-se y aspect-so.", "%", "aspect", (context) => aspectShare(context, ["aspect-s", "aspect-se", "aspect-so"])),
  analyticalCriterion("aspect-flat-percent", "Superficie plana", "Porcentaje de píxeles válidos de la categoría aspect-flat.", "%", "aspect", (context) => aspectShare(context, ["aspect-flat"])),
];

export const OBJECTIVE_CRITERION_BY_ID = new Map(OBJECTIVE_CRITERIA.map((criterion) => [criterion.id, criterion]));

export function objectiveCriterionQuality(
  result: TerrainAnalysisResultResponse | undefined,
  dependency: ObjectiveCriterionDependency,
): ObjectiveCriterionQuality | null {
  if (!result) return null;
  const variable = result.result[dependency];
  return {
    validCoveragePercent: variable.quality.valid_coverage_percent,
    validPixelCount: variable.quality.valid_pixel_count,
    includedPixelCount: variable.quality.included_pixel_count,
    validSurfaceAreaM2: variable.quality.valid_surface_area_m2,
    resolutionM: variable.quality.resolution_m,
    crs: variable.quality.crs,
    source: variable.quality.source,
    distributionDenominatorPixelCount: variable.distribution?.denominator_pixel_count ?? null,
    warnings: [...new Set([...result.result.warnings, ...variable.warnings])],
  };
}

function analysisStateForCell(
  area: DrawnElement,
  analysis: AreaAnalysisState | undefined,
  hasValue: boolean,
): ObjectiveCellStatus {
  if (!analysis) return hasValue ? "available" : "pending";
  if (analysis.geometryRevision !== area.geometryRevision) return "invalidated";
  if (analysis.state === "invalidated" || (analysis.state === "idle" && /geometría ha cambiado/i.test(analysis.message))) return "invalidated";
  if (analysis.state === "submitting" || analysis.state === "running") return "running";
  if (analysis.state === "error" || analysis.state === "tracking-error") return "error";
  if (analysis.state === "idle") return hasValue ? "available" : "pending";
  if (analysis.state !== "completed" || !analysis.result || analysis.result.data_status === "no_valid_data") return "insufficient_data";
  return hasValue ? "available" : "insufficient_data";
}

export function buildObjectiveCriterionCell(
  area: DrawnElement,
  criterion: ObjectiveCriterion,
  analysis: AreaAnalysisState | undefined,
): ObjectiveCriterionCell {
  const isGeometryOnly = criterion.dependencies.length === 0;
  const hasCurrentResult = analysis?.state === "completed"
    && analysis.geometryRevision === area.geometryRevision
    && analysis.result !== undefined;
  const result = hasCurrentResult ? analysis.result : undefined;
  const context: ObjectiveCriterionContext = { area, analysis, result };
  const value = criterion.getValue(context);
  const dependency = criterion.dependencies[0];
  const quality = dependency && hasCurrentResult ? objectiveCriterionQuality(result, dependency) : null;
  let status: ObjectiveCellStatus;

  if (isGeometryOnly) {
    status = value === null ? "insufficient_data" : "available";
  } else {
    status = analysisStateForCell(area, analysis, value !== null);
  }

  if (status === "available" && value === null) status = "insufficient_data";

  return {
    areaId: area.id,
    criterionId: criterion.id,
    value: status === "available" ? value : null,
    unit: criterion.unit,
    status,
    quality,
    analysisId: result?.analysis_id ?? null,
  };
}

export function analysisStatusLabel(area: DrawnElement, analysis: AreaAnalysisState | undefined): {
  label: string;
  status: ObjectiveCellStatus;
} {
  if (!analysis) return { label: "Pendiente de analizar", status: "pending" };
  if (analysis.geometryRevision !== area.geometryRevision || analysis.state === "invalidated") {
    return { label: "Resultado invalidado", status: "invalidated" };
  }
  if (analysis.state === "submitting" || analysis.state === "running") {
    return { label: analysis.stage || "Análisis en curso", status: "running" };
  }
  if (analysis.state === "tracking-error" || analysis.state === "error") {
    return { label: "Error de análisis", status: "error" };
  }
  if (analysis.state === "idle") {
    return /geometría ha cambiado/i.test(analysis.message)
      ? { label: "Resultado invalidado", status: "invalidated" }
      : { label: "Pendiente de analizar", status: "pending" };
  }
  if (!analysis.result || analysis.result.data_status === "no_valid_data") {
    return { label: "Sin datos válidos", status: "insufficient_data" };
  }
  return analysis.result.data_status === "partial_data"
    ? { label: "Cobertura parcial", status: "available" }
    : { label: "Análisis completado", status: "available" };
}
