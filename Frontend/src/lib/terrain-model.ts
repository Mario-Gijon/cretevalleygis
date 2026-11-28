export const TERRAIN_MODEL_SCHEMA_VERSION = "1.0" as const;
export const TERRAIN_MODEL_MAX_DIMENSION = 256;
export const TERRAIN_MODEL_DEFAULT_DIMENSION = 128;
export const TERRAIN_MODEL_SOURCE = "Copernicus DEM GLO-30 Public" as const;

export type LocalPosition = [number, number, ...number[]];
export type LocalPolygonGeometry = {
  type: "Polygon";
  coordinates: LocalPosition[][];
} | {
  type: "MultiPolygon";
  coordinates: LocalPosition[][][];
};

export type TerrainModelResponse = {
  schema_version: typeof TERRAIN_MODEL_SCHEMA_VERSION;
  analysis_id: string;
  source: typeof TERRAIN_MODEL_SOURCE;
  model_type: "DSM";
  horizontal_crs: string;
  vertical_reference: string | null;
  units: { horizontal: string; vertical: string };
  source_resolution_m: { east: number; north: number };
  source_nodata: number | null;
  extent_projected_m: { west: number; south: number; east: number; north: number };
  local_origin: {
    projected_m: { east: number; north: number };
    local_m: { east: number; north: number };
    definition: string;
  };
  geometry_local_m: LocalPolygonGeometry;
  grid: {
    columns: number;
    rows: number;
    first_sample_local_m: { east: number; north: number };
    sample_spacing_m: { east: number; north: number };
    column_order: "west_to_east";
    row_order: "north_to_south";
    position_convention: string;
    sampling_method: "native_pixel_centres" | "bilinear_at_cell_centres";
    values_m: Array<Array<number | null>>;
  };
  coverage: {
    availability: "available" | "partial" | "no_data" | "insufficient_data";
    valid_samples: number;
    missing_samples: number;
    valid_sample_fraction: number;
  };
  sampled_elevation_range_m: { minimum: number; maximum: number } | null;
  context: { requested_margin_m: number; was_clipped_to_coverage: boolean };
  warnings: string[];
};

export class TerrainModelRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "TerrainModelRequestError";
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireNumber(value: unknown, name: string): number {
  if (!isFiniteNumber(value)) throw new TerrainModelRequestError(`La respuesta contiene un valor no válido en ${name}.`, "invalid_response", 502);
  return value;
}

function validatePoint(value: unknown, name: string): { east: number; north: number } {
  if (!isRecord(value)) throw new TerrainModelRequestError(`Faltan las coordenadas de ${name}.`, "invalid_response", 502);
  return { east: requireNumber(value.east, `${name}.east`), north: requireNumber(value.north, `${name}.north`) };
}

function validateLocalGeometry(value: unknown): LocalPolygonGeometry {
  if (!isRecord(value) || (value.type !== "Polygon" && value.type !== "MultiPolygon")) {
    throw new TerrainModelRequestError("La geometría local del área no es Polygon ni MultiPolygon.", "invalid_response", 502);
  }
  let vertexCount = 0;
  const validateRing = (ring: unknown): LocalPosition[] => {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new TerrainModelRequestError("La geometría local contiene un anillo incompleto.", "invalid_response", 502);
    }
    const positions = ring.map((position): LocalPosition => {
      if (!Array.isArray(position) || position.length < 2 || !position.every(isFiniteNumber)) {
        throw new TerrainModelRequestError("La geometría local contiene coordenadas no válidas.", "invalid_response", 502);
      }
      vertexCount += 1;
      return [...position] as LocalPosition;
    });
    const first = positions[0];
    const last = positions[positions.length - 1];
    if (Math.abs(first[0] - last[0]) > 1e-5 || Math.abs(first[1] - last[1]) > 1e-5) {
      throw new TerrainModelRequestError("Los anillos locales deben estar cerrados.", "invalid_response", 502);
    }
    return positions;
  };
  const validatePolygon = (polygon: unknown): LocalPosition[][] => {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      throw new TerrainModelRequestError("La geometría local no contiene anillos.", "invalid_response", 502);
    }
    return polygon.map(validateRing);
  };
  const geometry: LocalPolygonGeometry = value.type === "Polygon"
    ? { type: "Polygon", coordinates: validatePolygon(value.coordinates) }
    : (() => {
      if (!Array.isArray(value.coordinates) || value.coordinates.length === 0) {
        throw new TerrainModelRequestError("La geometría local no contiene componentes.", "invalid_response", 502);
      }
      return { type: "MultiPolygon", coordinates: value.coordinates.map(validatePolygon) };
    })();
  if (vertexCount > 50_000) throw new TerrainModelRequestError("La geometría supera el límite de vértices admitido.", "invalid_response", 502);
  return geometry;
}

export function validateTerrainModel(value: unknown, expectedAnalysisId: string): TerrainModelResponse {
  if (!isRecord(value)) throw new TerrainModelRequestError("El servidor devolvió una respuesta vacía o no válida.", "invalid_response", 502);
  if (value.schema_version !== TERRAIN_MODEL_SCHEMA_VERSION) {
    throw new TerrainModelRequestError("La versión del modelo no es compatible con esta aplicación.", "incompatible_schema", 502);
  }
  if (value.analysis_id !== expectedAnalysisId || typeof value.analysis_id !== "string") {
    throw new TerrainModelRequestError("El modelo recibido no corresponde al análisis seleccionado.", "analysis_mismatch", 502);
  }
  if (value.source !== TERRAIN_MODEL_SOURCE || value.model_type !== "DSM") {
    throw new TerrainModelRequestError("La fuente del modelo no es Copernicus DEM GLO-30.", "incompatible_source", 502);
  }
  if (typeof value.horizontal_crs !== "string" || !value.horizontal_crs || !isRecord(value.units)
    || typeof value.units.horizontal !== "string" || typeof value.units.vertical !== "string") {
    throw new TerrainModelRequestError("Faltan el CRS o las unidades del modelo.", "invalid_response", 502);
  }
  if (value.vertical_reference !== null && typeof value.vertical_reference !== "string") {
    throw new TerrainModelRequestError("La referencia vertical del modelo no es válida.", "invalid_response", 502);
  }
  if (!isRecord(value.source_resolution_m)) throw new TerrainModelRequestError("Falta la resolución del ráster fuente.", "invalid_response", 502);
  const sourceResolution = {
    east: requireNumber(value.source_resolution_m.east, "source_resolution_m.east"),
    north: requireNumber(value.source_resolution_m.north, "source_resolution_m.north"),
  };
  if (sourceResolution.east <= 0 || sourceResolution.north <= 0) {
    throw new TerrainModelRequestError("La resolución del ráster debe ser positiva.", "invalid_response", 502);
  }
  if (value.source_nodata !== null && !isFiniteNumber(value.source_nodata)) {
    throw new TerrainModelRequestError("El valor NoData fuente no es válido.", "invalid_response", 502);
  }

  if (!isRecord(value.extent_projected_m)) throw new TerrainModelRequestError("Falta la extensión del modelo.", "invalid_response", 502);
  const extent = {
    west: requireNumber(value.extent_projected_m.west, "extent.west"),
    south: requireNumber(value.extent_projected_m.south, "extent.south"),
    east: requireNumber(value.extent_projected_m.east, "extent.east"),
    north: requireNumber(value.extent_projected_m.north, "extent.north"),
  };
  if (extent.east <= extent.west || extent.north <= extent.south) {
    throw new TerrainModelRequestError("La extensión del modelo no tiene superficie.", "invalid_response", 502);
  }
  if (!isRecord(value.local_origin) || typeof value.local_origin.definition !== "string") {
    throw new TerrainModelRequestError("Falta el origen local del modelo.", "invalid_response", 502);
  }
  const origin = {
    projected_m: validatePoint(value.local_origin.projected_m, "local_origin.projected_m"),
    local_m: validatePoint(value.local_origin.local_m, "local_origin.local_m"),
    definition: value.local_origin.definition,
  };
  if (Math.abs(origin.local_m.east) > 1e-6 || Math.abs(origin.local_m.north) > 1e-6
    || Math.abs(origin.projected_m.east - extent.west) > 1e-4
    || Math.abs(origin.projected_m.north - extent.south) > 1e-4) {
    throw new TerrainModelRequestError("El origen local no coincide con la esquina suroeste del modelo.", "invalid_response", 502);
  }

  const geometry = validateLocalGeometry(value.geometry_local_m);
  if (!isRecord(value.grid)) throw new TerrainModelRequestError("Falta la cuadrícula de elevación.", "invalid_response", 502);
  const columns = value.grid.columns;
  const rows = value.grid.rows;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || (columns as number) < 2 || (rows as number) < 2
    || (columns as number) > TERRAIN_MODEL_MAX_DIMENSION || (rows as number) > TERRAIN_MODEL_MAX_DIMENSION) {
    throw new TerrainModelRequestError("Las dimensiones de la cuadrícula no son válidas.", "invalid_response", 502);
  }
  if (value.grid.column_order !== "west_to_east" || value.grid.row_order !== "north_to_south"
    || (value.grid.sampling_method !== "native_pixel_centres" && value.grid.sampling_method !== "bilinear_at_cell_centres")
    || typeof value.grid.position_convention !== "string") {
    throw new TerrainModelRequestError("La orientación o el muestreo de la cuadrícula no son compatibles.", "invalid_response", 502);
  }
  const firstSample = validatePoint(value.grid.first_sample_local_m, "grid.first_sample_local_m");
  const spacing = validatePoint(value.grid.sample_spacing_m, "grid.sample_spacing_m");
  if (spacing.east <= 0 || spacing.north <= 0
    || spacing.east + 1e-5 < sourceResolution.east || spacing.north + 1e-5 < sourceResolution.north) {
    throw new TerrainModelRequestError("La separación de muestras no puede ser menor que la resolución fuente.", "invalid_response", 502);
  }
  const extentWidth = extent.east - extent.west;
  const extentHeight = extent.north - extent.south;
  if (!Number.isFinite(firstSample.east) || !Number.isFinite(firstSample.north)
    || firstSample.east < 0 || firstSample.east > extentWidth
    || firstSample.north < 0 || firstSample.north > extentHeight
    || Math.abs(firstSample.east - spacing.east / 2) > 1e-4
    || Math.abs(firstSample.north - (extentHeight - spacing.north / 2)) > 1e-4
    || Math.abs(spacing.east * (columns as number) - extentWidth) > 1e-3
    || Math.abs(spacing.north * (rows as number) - extentHeight) > 1e-3) {
    throw new TerrainModelRequestError("Las muestras no están alineadas con el origen y la extensión del modelo.", "invalid_response", 502);
  }
  if (!Array.isArray(value.grid.values_m) || value.grid.values_m.length !== rows
    || value.grid.values_m.some((row) => !Array.isArray(row) || row.length !== columns)) {
    throw new TerrainModelRequestError("La matriz de elevación no coincide con las dimensiones declaradas.", "invalid_response", 502);
  }
  const values = (value.grid.values_m as unknown[][]).map((row, rowIndex) => (row as unknown[]).map((sample, columnIndex) => {
    if (sample !== null && !isFiniteNumber(sample)) {
      throw new TerrainModelRequestError(`La muestra ${rowIndex}, ${columnIndex} no es finita ni NoData.`, "invalid_response", 502);
    }
    return sample as number | null;
  }));
  if (!isRecord(value.coverage)) throw new TerrainModelRequestError("Faltan los datos de cobertura de la cuadrícula.", "invalid_response", 502);
  const availability = value.coverage.availability;
  if (availability !== "available" && availability !== "partial" && availability !== "no_data" && availability !== "insufficient_data") {
    throw new TerrainModelRequestError("El estado de cobertura no es compatible.", "invalid_response", 502);
  }
  const validSamples = value.coverage.valid_samples;
  const missingSamples = value.coverage.missing_samples;
  const validFraction = requireNumber(value.coverage.valid_sample_fraction, "coverage.valid_sample_fraction");
  const actualValidSamples = values.reduce((count, row) => count + row.filter((sample) => sample !== null).length, 0);
  const sampleTotal = (rows as number) * (columns as number);
  if (!Number.isInteger(validSamples) || !Number.isInteger(missingSamples)
    || (validSamples as number) < 0 || (missingSamples as number) < 0
    || (validSamples as number) + (missingSamples as number) !== sampleTotal
    || actualValidSamples !== validSamples
    || validFraction < 0 || validFraction > 1
    || Math.abs(validFraction - (validSamples as number) / sampleTotal) > 1e-6) {
    throw new TerrainModelRequestError("Los conteos de cobertura no coinciden con las muestras.", "invalid_response", 502);
  }
  if ((availability === "available" && ((missingSamples as number) !== 0 || (validSamples as number) === 0))
    || (availability === "partial" && ((missingSamples as number) === 0 || (validSamples as number) === 0))
    || (availability === "no_data" && (validSamples as number) !== 0)
    || (availability === "insufficient_data" && (validSamples as number) === 0)) {
    throw new TerrainModelRequestError("El estado de cobertura contradice las muestras recibidas.", "invalid_response", 502);
  }
  let range: { minimum: number; maximum: number } | null = null;
  if (value.sampled_elevation_range_m !== null) {
    if (!isRecord(value.sampled_elevation_range_m)) throw new TerrainModelRequestError("El rango de elevaciones no es válido.", "invalid_response", 502);
    range = {
      minimum: requireNumber(value.sampled_elevation_range_m.minimum, "sampled_elevation_range_m.minimum"),
      maximum: requireNumber(value.sampled_elevation_range_m.maximum, "sampled_elevation_range_m.maximum"),
    };
    if (range.minimum > range.maximum || (validSamples as number) === 0) {
      throw new TerrainModelRequestError("El rango de elevaciones contradice la cobertura.", "invalid_response", 502);
    }
    let actualMinimum = Number.POSITIVE_INFINITY;
    let actualMaximum = Number.NEGATIVE_INFINITY;
    for (const row of values) {
      for (const sample of row) {
        if (sample === null) continue;
        actualMinimum = Math.min(actualMinimum, sample);
        actualMaximum = Math.max(actualMaximum, sample);
      }
    }
    if (Math.abs(range.minimum - actualMinimum) > 1e-4 || Math.abs(range.maximum - actualMaximum) > 1e-4) {
      throw new TerrainModelRequestError("El rango de elevaciones no coincide con la cuadrícula.", "invalid_response", 502);
    }
  } else if ((validSamples as number) !== 0) {
    throw new TerrainModelRequestError("Falta el rango de elevaciones disponibles.", "invalid_response", 502);
  }
  if (!isRecord(value.context) || !isFiniteNumber(value.context.requested_margin_m) || value.context.requested_margin_m < 0
    || typeof value.context.was_clipped_to_coverage !== "boolean" || !Array.isArray(value.warnings)
    || !value.warnings.every((warning) => typeof warning === "string")) {
    throw new TerrainModelRequestError("La información de contexto del modelo no es válida.", "invalid_response", 502);
  }

  return {
    schema_version: TERRAIN_MODEL_SCHEMA_VERSION,
    analysis_id: expectedAnalysisId,
    source: TERRAIN_MODEL_SOURCE,
    model_type: "DSM",
    horizontal_crs: value.horizontal_crs,
    vertical_reference: value.vertical_reference,
    units: { horizontal: value.units.horizontal, vertical: value.units.vertical },
    source_resolution_m: sourceResolution,
    source_nodata: value.source_nodata as number | null,
    extent_projected_m: extent,
    local_origin: origin,
    geometry_local_m: geometry,
    grid: {
      columns: columns as number,
      rows: rows as number,
      first_sample_local_m: firstSample,
      sample_spacing_m: spacing,
      column_order: "west_to_east",
      row_order: "north_to_south",
      position_convention: value.grid.position_convention,
      sampling_method: value.grid.sampling_method,
      values_m: values,
    },
    coverage: {
      availability,
      valid_samples: validSamples as number,
      missing_samples: missingSamples as number,
      valid_sample_fraction: validFraction,
    },
    sampled_elevation_range_m: range,
    context: {
      requested_margin_m: value.context.requested_margin_m,
      was_clipped_to_coverage: value.context.was_clipped_to_coverage,
    },
    warnings: value.warnings as string[],
  };
}

const TERRAIN_MODEL_ERROR_MESSAGES: Record<string, string> = {
  analysis_in_progress: "El análisis todavía no ha terminado. Espera a que se complete y vuelve a abrir el modelo.",
  terrain_model_busy: "El servidor está ocupado procesando otro terreno. Puedes reintentar en unos instantes.",
  terrain_data_unavailable: "El análisis no conserva datos Copernicus compatibles. Actualiza el análisis desde la ficha del área.",
  terrain_data_changed: "Los datos del análisis cambiaron. Actualiza el análisis antes de volver a abrir el modelo.",
  incompatible_terrain_crs: "El sistema de coordenadas del terreno no es compatible con el análisis.",
};

function responseError(value: unknown, status: number): TerrainModelRequestError {
  const detail = isRecord(value) && isRecord(value.detail) ? value.detail : null;
  const code = detail && typeof detail.code === "string" ? detail.code : `http_${status}`;
  const serverMessage = detail && typeof detail.message === "string" ? detail.message : null;
  return new TerrainModelRequestError(
    TERRAIN_MODEL_ERROR_MESSAGES[code] ?? serverMessage ?? "No se pudo obtener la cuadrícula de elevación.",
    code,
    status,
  );
}

export async function fetchTerrainModel(
  analysisId: string,
  signal: AbortSignal,
  maxDimension = TERRAIN_MODEL_DEFAULT_DIMENSION,
): Promise<TerrainModelResponse> {
  if (!/^[a-f\d]{16}$/i.test(analysisId)) {
    throw new TerrainModelRequestError("El identificador del análisis no es válido.", "invalid_analysis_id", 400);
  }
  if (!Number.isInteger(maxDimension) || maxDimension < 16 || maxDimension > TERRAIN_MODEL_MAX_DIMENSION) {
    throw new TerrainModelRequestError("La dimensión solicitada debe estar entre 16 y 256.", "invalid_grid_limit", 400);
  }
  let response: Response;
  try {
    response = await fetch(`/api/analysis/jobs/${encodeURIComponent(analysisId)}/terrain-model?max_dimension=${maxDimension}`, {
      signal,
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new TerrainModelRequestError("No se puede conectar con el backend GIS.", "backend_unavailable", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TerrainModelRequestError("El backend devolvió una respuesta que no es JSON válido.", "invalid_response", response.status);
  }
  if (!response.ok) throw responseError(body, response.status);
  return validateTerrainModel(body, analysisId);
}

type SharedTerrainRequest = {
  controller: AbortController;
  promise: Promise<TerrainModelResponse>;
  consumers: number;
  settled: boolean;
  abortTimer: number | null;
};

const sharedRequests = new Map<string, SharedTerrainRequest>();

/** Shares the development StrictMode mount/unmount request and cancels it when the view really closes. */
export function observeTerrainModel(analysisId: string, maxDimension = TERRAIN_MODEL_DEFAULT_DIMENSION) {
  const key = `${analysisId}:${maxDimension}`;
  let request = sharedRequests.get(key);
  if (!request) {
    const controller = new AbortController();
    const created: SharedTerrainRequest = {
      controller,
      promise: fetchTerrainModel(analysisId, controller.signal, maxDimension),
      consumers: 0,
      settled: false,
      abortTimer: null,
    };
    request = created;
    sharedRequests.set(key, created);
    void created.promise.then(
      () => {
        created.settled = true;
        if (created.consumers === 0 && sharedRequests.get(key) === created) sharedRequests.delete(key);
      },
      () => {
        created.settled = true;
        if (created.consumers === 0 && sharedRequests.get(key) === created) sharedRequests.delete(key);
      },
    );
  }
  if (request.abortTimer !== null) window.clearTimeout(request.abortTimer);
  request.abortTimer = null;
  request.consumers += 1;
  let released = false;
  return {
    promise: request.promise,
    release: () => {
      if (released) return;
      released = true;
      request!.consumers = Math.max(0, request!.consumers - 1);
      if (request!.consumers !== 0 || request!.settled) {
        if (request!.consumers === 0 && request!.settled && sharedRequests.get(key) === request) sharedRequests.delete(key);
        return;
      }
      request!.abortTimer = window.setTimeout(() => {
        request!.abortTimer = null;
        if (request!.consumers === 0 && sharedRequests.get(key) === request) {
          request!.controller.abort();
          sharedRequests.delete(key);
        }
      }, 0);
    },
  };
}
