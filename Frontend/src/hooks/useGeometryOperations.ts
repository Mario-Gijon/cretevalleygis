import { useCallback, useRef, useState } from "react";
import Feature from "ol/Feature.js";
import type Geometry from "ol/geom/Geometry.js";
import MultiPolygon from "ol/geom/MultiPolygon.js";
import Polygon from "ol/geom/Polygon.js";
import GeoJSON from "ol/format/GeoJSON.js";
import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import { Fill, Stroke, Style } from "ol/style.js";
import type { DrawnElement } from "@/hooks/useDrawingTools";
import { getGeometryInfo, type GeometryInfo } from "@/lib/geometry-metrics";
import { isSurfaceGeometryType, type GeoJSONSurfaceGeometry } from "@/lib/geometry-types";

export type GeometryOverlayOperation = "union" | "intersection" | "difference";
export type GeometryOperationPreviewStatus = "loading" | "preview" | "empty" | "error";

export type GeometryOperationPreview = {
  status: GeometryOperationPreviewStatus;
  operation: GeometryOverlayOperation;
  areaAId: string;
  areaAGeometryRevision: number;
  areaBId: string;
  areaBGeometryRevision: number;
  geometry?: GeoJSONSurfaceGeometry;
  geometryInfo?: Extract<GeometryInfo, { kind: "Area" }>;
  processingCrs?: string;
  warnings: string[];
  message?: string;
};

type GeometryOverlayResponse = {
  operation?: GeometryOverlayOperation;
  geometry?: GeoJSONSurfaceGeometry | null;
  result_geometry_type?: string | null;
  result_status?: "success" | "empty";
  processing_crs?: string;
  warnings?: string[];
};

type GeometryOverlayError = {
  detail?: string | { msg?: string }[] | { message?: string };
};

type GeometryOperationAreaRef = {
  geometryType: DrawnElement["geometryType"];
  geometryRevision: number;
};

const geoJsonFormat = new GeoJSON();
const operationPreviewStyle = new Style({
  fill: new Fill({ color: "rgba(194, 232, 18, 0.22)" }),
  stroke: new Stroke({ color: "#05294C", width: 3, lineDash: [9, 6] }),
});

function responseMessage(body: GeometryOverlayError | null, fallback: string): string {
  const detail = body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => item.msg ?? "").filter(Boolean).join(" ") || fallback;
  return detail?.message || fallback;
}

async function parseResponse(response: Response): Promise<GeometryOverlayResponse | GeometryOverlayError | null> {
  try {
    return await response.json() as GeometryOverlayResponse | GeometryOverlayError;
  } catch {
    return null;
  }
}

function hasSurface(element: DrawnElement | undefined): element is DrawnElement & { geoJsonGeometry: GeoJSONSurfaceGeometry } {
  return Boolean(element?.geoJsonGeometry && isSurfaceGeometryType(element.geometryType));
}

export function useGeometryOperations() {
  const [previewSource] = useState(() => new VectorSource<Feature<Geometry>>({ wrapX: false }));
  const [previewLayer] = useState(() => new VectorLayer({ source: previewSource, style: operationPreviewStyle, zIndex: 21 }));
  const [preview, setPreview] = useState<GeometryOperationPreview | null>(null);
  const previewRef = useRef(preview);
  const currentAreasRef = useRef(new Map<string, GeometryOperationAreaRef>());
  const activeControllerRef = useRef<AbortController | null>(null);
  const requestTokenRef = useRef(0);
  previewRef.current = preview;

  const publish = useCallback((next: GeometryOperationPreview | null) => {
    previewRef.current = next;
    setPreview(next);
  }, []);

  const clearPreview = useCallback(() => {
    requestTokenRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    previewSource.clear(true);
    publish(null);
  }, [previewSource, publish]);

  const syncAreas = useCallback((elements: DrawnElement[]) => {
    currentAreasRef.current = new Map(elements.map((element) => [element.id, {
      geometryType: element.geometryType,
      geometryRevision: element.geometryRevision,
    }]));

    const current = previewRef.current;
    if (!current || (current.status !== "loading" && current.status !== "preview")) return;
    const areaA = currentAreasRef.current.get(current.areaAId);
    const areaB = currentAreasRef.current.get(current.areaBId);
    if (
      areaA?.geometryRevision === current.areaAGeometryRevision
      && areaB?.geometryRevision === current.areaBGeometryRevision
      && isSurfaceGeometryType(areaA.geometryType)
      && isSurfaceGeometryType(areaB.geometryType)
    ) return;

    requestTokenRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    previewSource.clear(true);
    publish({
      ...current,
      status: "error",
      geometry: undefined,
      geometryInfo: undefined,
      message: "Una de las áreas originales cambió o se eliminó. Genera una vista previa nueva.",
    });
  }, [previewSource, publish]);

  const generatePreview = useCallback(async (
    operation: GeometryOverlayOperation,
    areaA: DrawnElement | undefined,
    areaB: DrawnElement | undefined,
  ) => {
    if (!areaA || !areaB || areaA.id === areaB.id || !hasSurface(areaA) || !hasSurface(areaB)) {
      previewSource.clear(true);
      publish({
        status: "error",
        operation,
        areaAId: areaA?.id ?? "",
        areaAGeometryRevision: areaA?.geometryRevision ?? -1,
        areaBId: areaB?.id ?? "",
        areaBGeometryRevision: areaB?.geometryRevision ?? -1,
        warnings: [],
        message: "Selecciona dos áreas distintas con geometrías disponibles.",
      });
      return;
    }

    const currentA = currentAreasRef.current.get(areaA.id);
    const currentB = currentAreasRef.current.get(areaB.id);
    if (
      currentA?.geometryRevision !== areaA.geometryRevision
      || currentB?.geometryRevision !== areaB.geometryRevision
    ) {
      previewSource.clear(true);
      publish({
        status: "error",
        operation,
        areaAId: areaA.id,
        areaAGeometryRevision: areaA.geometryRevision,
        areaBId: areaB.id,
        areaBGeometryRevision: areaB.geometryRevision,
        warnings: [],
        message: "Una de las áreas originales cambió. Selecciónala de nuevo antes de calcular.",
      });
      return;
    }

    activeControllerRef.current?.abort();
    previewSource.clear(true);
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const token = ++requestTokenRef.current;
    const requestIsCurrent = () => requestTokenRef.current === token && !controller.signal.aborted;
    const identity = {
      operation,
      areaAId: areaA.id,
      areaAGeometryRevision: areaA.geometryRevision,
      areaBId: areaB.id,
      areaBGeometryRevision: areaB.geometryRevision,
    };
    publish({ status: "loading", ...identity, warnings: [] });

    try {
      const response = await fetch("/api/geometry/overlay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation,
          geometry_a: areaA.geoJsonGeometry,
          geometry_b: areaB.geoJsonGeometry,
        }),
        signal: controller.signal,
      });
      const body = await parseResponse(response);
      if (!requestIsCurrent()) return;
      if (!response.ok || !body) {
        publish({
          status: "error",
          ...identity,
          warnings: [],
          message: responseMessage(body as GeometryOverlayError | null, "No se pudo calcular la operación geométrica."),
        });
        return;
      }

      const result = body as GeometryOverlayResponse;
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      if (result.operation !== operation) {
        publish({ status: "error", ...identity, warnings, message: "El backend devolvió otra operación. Inténtalo de nuevo." });
        return;
      }
      if (result.result_status === "empty" && result.geometry === null && !result.result_geometry_type) {
        previewSource.clear(true);
        publish({
          status: "empty",
          ...identity,
          processingCrs: result.processing_crs,
          warnings,
          message: warnings[0] ?? "La operación no produce una superficie con área.",
        });
        return;
      }
      if (
        result.result_status !== "success"
        || !result.geometry
        || !isSurfaceGeometryType(result.geometry.type)
        || result.result_geometry_type !== result.geometry.type
      ) {
        publish({
          status: "error",
          ...identity,
          processingCrs: result.processing_crs,
          warnings,
          message: "El backend devolvió una geometría vacía o no compatible.",
        });
        return;
      }

      const latestA = currentAreasRef.current.get(areaA.id);
      const latestB = currentAreasRef.current.get(areaB.id);
      if (
        !requestIsCurrent()
        || latestA?.geometryRevision !== areaA.geometryRevision
        || latestB?.geometryRevision !== areaB.geometryRevision
      ) return;

      const projectedGeometry = geoJsonFormat.readGeometry(result.geometry, {
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      });
      if (
        (!(projectedGeometry instanceof Polygon) && !(projectedGeometry instanceof MultiPolygon))
        || projectedGeometry.getType() !== result.geometry.type
        || projectedGeometry.getCoordinates().length === 0
      ) {
        publish({
          status: "error",
          ...identity,
          processingCrs: result.processing_crs,
          warnings,
          message: "No se puede representar la superficie devuelta por el backend.",
        });
        return;
      }

      const geometryInfo = getGeometryInfo(projectedGeometry, "EPSG:3857");
      if (!geometryInfo || geometryInfo.kind !== "Area" || !Number.isFinite(geometryInfo.area) || geometryInfo.area <= 0) {
        publish({
          status: "error",
          ...identity,
          processingCrs: result.processing_crs,
          warnings,
          message: "La operación no produjo una superficie válida.",
        });
        return;
      }

      previewSource.addFeature(new Feature<Geometry>({ geometry: projectedGeometry }));
      publish({
        status: "preview",
        ...identity,
        geometry: result.geometry,
        geometryInfo,
        processingCrs: result.processing_crs,
        warnings,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      publish({
        status: "error",
        ...identity,
        warnings: [],
        message: error instanceof Error && error.name === "AbortError"
          ? "La solicitud se canceló."
          : "No se pudo conectar con el servicio de operaciones geométricas.",
      });
    } finally {
      if (requestTokenRef.current === token) activeControllerRef.current = null;
    }
  }, [previewSource, publish]);

  const getConfirmableResult = useCallback((
    operation: GeometryOverlayOperation,
    areaAId: string,
    areaBId: string,
  ): GeoJSONSurfaceGeometry | null => {
    const current = previewRef.current;
    if (
      current?.status !== "preview"
      || current.operation !== operation
      || current.areaAId !== areaAId
      || current.areaBId !== areaBId
      || !current.geometry
    ) return null;
    const areaA = currentAreasRef.current.get(areaAId);
    const areaB = currentAreasRef.current.get(areaBId);
    if (
      !areaA
      || !areaB
      || areaA.geometryRevision !== current.areaAGeometryRevision
      || areaB.geometryRevision !== current.areaBGeometryRevision
      || !isSurfaceGeometryType(areaA.geometryType)
      || !isSurfaceGeometryType(areaB.geometryType)
    ) return null;
    return current.geometry;
  }, []);

  return { previewLayer, preview, syncAreas, generatePreview, getConfirmableResult, clearPreview };
}
