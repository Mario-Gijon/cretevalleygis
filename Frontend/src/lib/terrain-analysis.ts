import type { GeoJSONMultiPolygon, GeoJSONPolygon } from "ol/format/GeoJSON.js";

export type TerrainAnalysisGeometry = GeoJSONPolygon | GeoJSONMultiPolygon;
export type TerrainAnalysisJobStatus =
  | "queued"
  | "checking_data"
  | "preparing_elevation"
  | "generating_derivatives"
  | "calculating_statistics"
  | "completed"
  | "failed";

export type TerrainAnalysisDataStatus = "available" | "partial_data" | "no_valid_data";

export type TerrainStatisticSummary = {
  minimum: number;
  maximum: number;
  mean: number;
  standard_deviation: number;
  range: number;
  maximum_relief_m?: number;
};

export type TerrainDistributionCategory = {
  id: string;
  label: string;
  direction?: string;
  pixel_count: number;
  percentage: number | null;
};

export type TerrainVariableAnalysis = {
  status: "available" | "no_data";
  unit: "m" | "%" | "degrees";
  statistics: TerrainStatisticSummary | null;
  quality: {
    included_pixel_count: number;
    valid_pixel_count: number;
    valid_coverage_percent: number;
    valid_pixel_fraction_of_included_percent: number;
    valid_surface_area_m2: number;
    resolution_m: { x: number; y: number };
    crs: string;
    source: string | null;
    nodata: number | null;
    north_reference?: "grid_north";
  };
  warnings: string[];
  distribution?: {
    denominator: string;
    denominator_pixel_count: number;
    north_reference?: "grid_north";
    categories: TerrainDistributionCategory[];
  };
  flat_pixel_count?: number;
};

export type ZonalTerrainStatistics = {
  schema_version: string;
  geometry_type: "Polygon" | "MultiPolygon";
  polygon_area_m2: number;
  pixel_inclusion: {
    method: "pixel_center_inside_polygon";
    included_pixel_count: number;
    included_surface_area_m2: number;
    raster_coverage_percent: number;
    distribution_denominator: string;
  };
  crs: {
    code: string;
    horizontal_units: string;
    resolution_m: { x: number; y: number };
    aspect_reference: "grid_north";
  };
  elevation: TerrainVariableAnalysis;
  slope: TerrainVariableAnalysis;
  aspect: TerrainVariableAnalysis;
  warnings: string[];
};

export type TerrainAnalysisStatusResponse = {
  analysis_id: string;
  status: TerrainAnalysisJobStatus;
  stage: string;
  data_status: TerrainAnalysisDataStatus | null;
  area_name: string;
  bbox_wgs84: [number, number, number, number];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  reused: boolean;
  status_url: string;
  result_url: string | null;
  error: { code: string; message: string } | null;
};

export type TerrainAnalysisResultResponse = {
  analysis_id: string;
  status: "completed";
  data_status: TerrainAnalysisDataStatus;
  area_name: string;
  geometry: TerrainAnalysisGeometry;
  bbox_wgs84: [number, number, number, number];
  calculated_at: string;
  schema_version: string;
  source: string;
  resolution_m: number;
  horizontal_crs: string;
  terrain_reused: boolean;
  derivatives_reused: boolean;
  result: ZonalTerrainStatistics;
  reused: boolean;
};

export type AreaAnalysisState = {
  geometryRevision: number;
  state: "idle" | "invalidated" | "submitting" | "running" | "tracking-error" | "completed" | "error";
  stage?: string;
  message: string;
  analysisId?: string;
  retryMode?: "submit" | "resume";
  errorCode?: string;
  result?: TerrainAnalysisResultResponse;
};
