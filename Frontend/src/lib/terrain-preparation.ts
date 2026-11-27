export type TerrainPreparationResult = {
  coverage: {
    area_name: string;
    extent_wgs84: [number, number, number, number];
    resolution_m: number;
    elevation_min_m: number;
    elevation_max_m: number;
    elevation_style: {
      version: string;
      interpolation: "linear-rgb";
      unit: "m";
      data_min_m: number;
      data_max_m: number;
      min_m: number;
      max_m: number;
      stops: Array<{
        position: number;
        value_m: number;
        color: string;
      }>;
    };
    horizontal_crs: string;
    vertical_datum: string;
    nodata: number;
  };
  storage: {
    project_file: string;
    elevation_raster: string;
    hillshade_raster: string;
    slope_raster?: string;
    aspect_raster?: string;
    aspect_display_raster?: string;
  };
  cartography: {
    service_url: string;
    map_parameter: string;
    get_capabilities_url: string;
    get_map_template: string;
    layers: {
      hillshade: string;
      elevation: string;
      slope?: string;
      aspect?: string;
    };
  };
  derivatives?: {
    version: string;
    area_name: string;
    source: string;
    resolution_m: number;
    horizontal_crs: string;
    horizontal_units: string;
    vertical_units: string;
    algorithm: "Horn";
    source_elevation_sha256: string;
    nodata: number;
    storage_bytes: number;
    reused: boolean;
    slope: {
      unit: "percent";
      minimum: number;
      maximum: number;
      wms_layer: string;
      raster_kind: "numeric-analysis-data";
      legend: Array<{ value: number; color: string; label: string }>;
    };
    aspect: {
      unit: "degrees";
      minimum: number | null;
      maximum: number | null;
      wms_layer: string;
      north_reference: "grid_north";
      north_reference_label: string;
      flat_policy: string;
      display_flat_value: number;
      raw_raster_nodata: number;
      raster_kind: "numeric-analysis-data";
      legend: Array<{ direction: string; label: string; color: string }>;
    };
  };
  preparation: {
    source_tile_count: number;
    source_downloaded_bytes: number;
    reused: boolean;
    style_refreshed?: boolean;
    derivatives_reused?: boolean;
  };
};

export type TerrainDerivativeJob = {
  status: "idle" | "queued" | "running" | "completed" | "failed";
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  result?: TerrainPreparationResult["derivatives"] | null;
};

export type TerrainPreparationView = {
  state: "submitting" | "running" | "completed" | "error";
  jobId?: string;
  message: string;
  result?: TerrainPreparationResult;
  reused?: boolean;
  derivatives?: {
    state: "submitting" | "queued" | "running" | "completed" | "error";
    message: string;
    error?: string;
  };
};

export type TerrainJobResponse = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  status_url?: string;
  result_url?: string | null;
  result?: TerrainPreparationResult;
  reused?: boolean;
  error?: string;
  derivatives?: TerrainDerivativeJob;
};
