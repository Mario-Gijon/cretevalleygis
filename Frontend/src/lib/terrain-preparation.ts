export type TerrainPreparationResult = {
  coverage: {
    area_name: string;
    extent_wgs84: [number, number, number, number];
    resolution_m: number;
    elevation_min_m: number;
    elevation_max_m: number;
    horizontal_crs: string;
    vertical_datum: string;
    nodata: number;
  };
  storage: {
    project_file: string;
    elevation_raster: string;
    hillshade_raster: string;
  };
  cartography: {
    service_url: string;
    map_parameter: string;
    get_capabilities_url: string;
    get_map_template: string;
    layers: {
      hillshade: string;
      elevation: string;
    };
  };
  preparation: {
    source_tile_count: number;
    source_downloaded_bytes: number;
    reused: boolean;
  };
};

export type TerrainPreparationView = {
  state: "submitting" | "running" | "completed" | "error";
  jobId?: string;
  message: string;
  result?: TerrainPreparationResult;
  reused?: boolean;
};

export type TerrainJobResponse = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  status_url?: string;
  result_url?: string | null;
  result?: TerrainPreparationResult;
  reused?: boolean;
  error?: string;
};
