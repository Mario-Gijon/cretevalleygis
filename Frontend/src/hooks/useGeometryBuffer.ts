import { useCallback, useEffect, useRef, useState } from "react";
import Feature from "ol/Feature.js";
import type Geometry from "ol/geom/Geometry.js";
import MultiPolygon from "ol/geom/MultiPolygon.js";
import Polygon from "ol/geom/Polygon.js";
import GeoJSON, { type GeoJSONLineString, type GeoJSONPoint } from "ol/format/GeoJSON.js";
import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import { Fill, Stroke, Style } from "ol/style.js";
import type { DrawingGeometry } from "@/hooks/useDrawingTools";
import { isSurfaceGeometryType, type GeoJSONSurfaceGeometry } from "@/lib/geometry-types";

export type BufferInputGeometry = GeoJSONPoint | GeoJSONLineString | GeoJSONSurfaceGeometry;

export type GeometryBufferState = {
  status: "loading" | "preview" | "error";
  sourceId: string;
  geometryRevision: number;
  distanceMeters: number;
  geometry?: GeoJSONSurfaceGeometry;
  processingCrs?: string;
  warnings: string[];
  message?: string;
};

export type GeometryBufferElementRef = {
  id: string;
  geometryType: DrawingGeometry;
  geometryRevision: number;
};

type BufferApiResponse = {
  operation?: string;
  result_geometry_type?: string;
  distance_m?: number;
  processing_crs?: string;
  geometry?: GeoJSONSurfaceGeometry | { type: string; coordinates: unknown };
  warnings?: string[];
};

type BufferApiError = {
  detail?: string | { msg?: string; message?: string }[] | { message?: string };
};

const geoJsonFormat = new GeoJSON();
const previewStyle = new Style({
  fill: new Fill({ color: "rgba(194, 232, 18, 0.17)" }),
  stroke: new Stroke({ color: "#b76812", width: 3, lineDash: [10, 7] }),
});

function responseMessage(body: BufferApiError | null, fallback: string): string {
  const detail = body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => item.msg ?? "").filter(Boolean).join(" ") || fallback;
  return detail?.message || fallback;
}

async function parseResponse(response: Response): Promise<BufferApiResponse | BufferApiError | null> {
  try {
    return await response.json() as BufferApiResponse | BufferApiError;
  } catch {
    return null;
  }
}

export function useGeometryBuffer() {
  const [previewSource] = useState(() => new VectorSource<Feature<Geometry>>({ wrapX: false }));
  const [previewLayer] = useState(() => new VectorLayer({ source: previewSource, style: previewStyle, zIndex: 20 }));
  const [bufferState, setBufferState] = useState<GeometryBufferState | null>(null);
  const bufferStateRef = useRef(bufferState);
  const currentElementsRef = useRef(new Map<string, { geometryType: DrawingGeometry; geometryRevision: number }>());
  const activeControllerRef = useRef<AbortController | null>(null);
  const requestTokenRef = useRef(0);
  bufferStateRef.current = bufferState;

  const publish = useCallback((state: GeometryBufferState | null) => {
    bufferStateRef.current = state;
    setBufferState(state);
  }, []);

  const clearPreview = useCallback(() => {
    requestTokenRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    previewSource.clear(true);
    publish(null);
  }, [previewSource, publish]);

  const syncElements = useCallback((elements: GeometryBufferElementRef[]) => {
    const next = new Map(elements.map((element) => [element.id, {
      geometryType: element.geometryType,
      geometryRevision: element.geometryRevision,
    }]));
    currentElementsRef.current = next;
    const currentState = bufferStateRef.current;
    if (!currentState) return;
    const currentSource = next.get(currentState.sourceId);
    if (!currentSource || currentSource.geometryRevision !== currentState.geometryRevision) clearPreview();
  }, [clearPreview]);

  const generatePreview = useCallback(async (
    sourceId: string,
    geometryRevision: number,
    geometry: BufferInputGeometry,
    distanceMeters: number,
  ) => {
    const sourceElement = currentElementsRef.current.get(sourceId);
    if (!sourceElement || sourceElement.geometryRevision !== geometryRevision) {
      publish({
        status: "error",
        sourceId,
        geometryRevision,
        distanceMeters,
        warnings: [],
        message: "El elemento ha cambiado o ya no está disponible. Selecciónalo de nuevo para calcular otra vista previa.",
      });
      return;
    }

    activeControllerRef.current?.abort();
    previewSource.clear(true);
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const token = ++requestTokenRef.current;
    const requestIsCurrent = () => requestTokenRef.current === token && !controller.signal.aborted;
    publish({ status: "loading", sourceId, geometryRevision, distanceMeters, warnings: [] });

    try {
      const response = await fetch("/api/geometry/buffer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geometry, distance_m: distanceMeters }),
        signal: controller.signal,
      });
      const body = await parseResponse(response);
      if (!requestIsCurrent()) return;
      if (!response.ok || !body) {
        publish({
          status: "error",
          sourceId,
          geometryRevision,
          distanceMeters,
          warnings: [],
          message: responseMessage(body as BufferApiError | null, "No se pudo calcular la zona de influencia."),
        });
        return;
      }

      const result = body as BufferApiResponse;
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      if (!result.geometry || !isSurfaceGeometryType(result.geometry.type)) {
        publish({
          status: "error",
          sourceId,
          geometryRevision,
          distanceMeters,
          processingCrs: result.processing_crs,
          warnings,
          message: "El backend devolvió una geometría vacía o no compatible con la incorporación actual.",
        });
        return;
      }

      const currentSource = currentElementsRef.current.get(sourceId);
      if (!currentSource || currentSource.geometryRevision !== geometryRevision) return;
      const projectedGeometry = geoJsonFormat.readGeometry(result.geometry, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });
      if (!(projectedGeometry instanceof Polygon) && !(projectedGeometry instanceof MultiPolygon)) {
        publish({
          status: "error",
          sourceId,
          geometryRevision,
          distanceMeters,
          processingCrs: result.processing_crs,
          warnings,
          message: "El backend devolvió una geometría de superficie que no se puede mostrar en el mapa.",
        });
        return;
      }
      if (projectedGeometry.getType() !== result.geometry.type || projectedGeometry.getCoordinates().length === 0) {
        publish({
          status: "error",
          sourceId,
          geometryRevision,
          distanceMeters,
          processingCrs: result.processing_crs,
          warnings,
          message: "El backend devolvió una geometría de superficie vacía o incompatible.",
        });
        return;
      }

      previewSource.addFeature(new Feature<Geometry>({ geometry: projectedGeometry }));
      publish({
        status: "preview",
        sourceId,
        geometryRevision,
        distanceMeters,
        geometry: result.geometry,
        processingCrs: result.processing_crs,
        warnings,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      publish({
        status: "error",
        sourceId,
        geometryRevision,
        distanceMeters,
        warnings: [],
        message: error instanceof Error && error.name === "AbortError"
          ? "La vista previa se canceló."
          : "No se pudo conectar con el servicio de operaciones geométricas.",
      });
    } finally {
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
    }
  }, [previewSource, publish]);

  const getConfirmableSurfaceGeometry = useCallback((sourceId: string, geometryRevision: number): GeoJSONSurfaceGeometry | null => {
    const current = bufferStateRef.current;
    const sourceElement = currentElementsRef.current.get(sourceId);
    if (current?.status !== "preview" || current.sourceId !== sourceId
      || current.geometryRevision !== geometryRevision || !current.geometry
      || !sourceElement || sourceElement.geometryRevision !== geometryRevision) return null;
    return current.geometry;
  }, []);

  useEffect(() => () => {
    activeControllerRef.current?.abort();
    previewSource.clear(true);
  }, [previewSource]);

  return {
    bufferState,
    previewLayer,
    syncElements,
    generatePreview,
    getConfirmableSurfaceGeometry,
    clearPreview,
  };
}
