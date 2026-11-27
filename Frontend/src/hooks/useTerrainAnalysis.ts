import { useCallback, useEffect, useRef, useState } from "react";
import type { DrawnElement } from "@/hooks/useDrawingTools";
import type {
  AreaAnalysisState,
  TerrainAnalysisGeometry,
  TerrainAnalysisStatusResponse,
  TerrainAnalysisResultResponse,
} from "@/lib/terrain-analysis";

type AreaAnalysisStates = Record<string, AreaAnalysisState>;
type ApiErrorBody = {
  detail?: string | { msg?: string }[] | { code?: string; message?: string };
};

const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_DURATION_MS = 30 * 60 * 1_000;

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, POLL_INTERVAL_MS);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function responseBody<T>(response: Response): Promise<T | ApiErrorBody | null> {
  try {
    return await response.json() as T | ApiErrorBody;
  } catch {
    return null;
  }
}

function apiFailureMessage(status: number, body: ApiErrorBody | null): { code: string; message: string } {
  const detail = body?.detail;
  const text = typeof detail === "string"
    ? detail
    : Array.isArray(detail)
      ? detail.map((item) => item.msg ?? "").join(" ")
      : detail?.message ?? "";
  const normalized = text.toLowerCase();

  if (status === 409) {
    return { code: "processing_busy", message: "Hay otro proceso geográfico en curso. Espera un momento y vuelve a intentarlo." };
  }
  if (status === 422 && /self-intersection|topologically invalid|geometry is invalid/.test(normalized)) {
    return { code: "invalid_geometry", message: "El polígono no es válido. Corrige su forma e inténtalo de nuevo." };
  }
  if (status === 422 && /extent exceeds/.test(normalized)) {
    return { code: "area_too_large", message: "El área supera el tamaño permitido. Reduce el polígono e inténtalo de nuevo." };
  }
  if (status === 422 && /copernicus tiles|million pixels|pixel limit/.test(normalized)) {
    return { code: "area_too_large", message: "El área requiere más datos de los admitidos. Reduce el polígono e inténtalo de nuevo." };
  }
  if (status === 422) {
    return { code: "invalid_geometry", message: "La geometría no es válida para analizar. Revisa el polígono e inténtalo de nuevo." };
  }
  if (status === 503 || status === 0) {
    return { code: "backend_unavailable", message: "El servicio de análisis no está disponible. El mapa sigue funcionando." };
  }
  return { code: "request_failed", message: "No se pudo solicitar el análisis. Puedes volver a intentarlo." };
}

function processingFailureMessage(error: TerrainAnalysisStatusResponse["error"]): string {
  if (!error) return "No se pudo completar el análisis. Puedes volver a intentarlo.";
  if (error.code === "terrain_preparation_failed" || error.code === "terrain_data_unavailable") {
    return "No hay datos de terreno disponibles para esta zona en este momento.";
  }
  if (error.code === "derivative_generation_failed") {
    return "No se pudieron preparar los datos de pendientes y orientación para el análisis.";
  }
  if (error.code === "incompatible_terrain_data") {
    return "Los datos preparados no son compatibles con este análisis.";
  }
  return "El análisis no pudo completarse. Puedes volver a intentarlo más tarde.";
}

export function useTerrainAnalysis() {
  const [analyses, setAnalyses] = useState<AreaAnalysisStates>({});
  const analysesRef = useRef<AreaAnalysisStates>({});
  const geometryRevisionsRef = useRef(new Map<string, number>());
  const requestVersionsRef = useRef(new Map<string, number>());
  const controllersRef = useRef(new Map<string, AbortController>());

  const updateAnalysis = useCallback((areaId: string, version: number, state: AreaAnalysisState) => {
    if (requestVersionsRef.current.get(areaId) !== version) return;
    const updated = { ...analysesRef.current, [areaId]: state };
    analysesRef.current = updated;
    setAnalyses(updated);
  }, []);

  const startOperation = useCallback((areaId: string) => {
    controllersRef.current.get(areaId)?.abort();
    const version = (requestVersionsRef.current.get(areaId) ?? 0) + 1;
    requestVersionsRef.current.set(areaId, version);
    const controller = new AbortController();
    controllersRef.current.set(areaId, controller);
    return { version, controller };
  }, []);

  const finishOperation = useCallback((areaId: string, controller: AbortController) => {
    if (controllersRef.current.get(areaId) === controller) controllersRef.current.delete(areaId);
  }, []);

  const syncAreas = useCallback((elements: DrawnElement[]) => {
    const currentAreas = new Map(
      elements
        .filter((element) => element.geometryType === "Polygon")
        .map((element) => [element.id, element.geometryRevision] as const),
    );
    const next = { ...analysesRef.current };
    let changed = false;

    for (const [areaId, previousRevision] of geometryRevisionsRef.current) {
      if (!currentAreas.has(areaId)) {
        controllersRef.current.get(areaId)?.abort();
        controllersRef.current.delete(areaId);
        requestVersionsRef.current.set(areaId, (requestVersionsRef.current.get(areaId) ?? 0) + 1);
        geometryRevisionsRef.current.delete(areaId);
        requestVersionsRef.current.delete(areaId);
        if (areaId in next) {
          delete next[areaId];
          changed = true;
        }
        continue;
      }

      const revision = currentAreas.get(areaId);
      if (revision === undefined || revision === previousRevision) continue;
      controllersRef.current.get(areaId)?.abort();
      controllersRef.current.delete(areaId);
      requestVersionsRef.current.set(areaId, (requestVersionsRef.current.get(areaId) ?? 0) + 1);
      if (next[areaId]) {
        next[areaId] = {
          geometryRevision: revision,
          state: "idle",
          message: "La geometría ha cambiado. Analiza de nuevo esta área para actualizar sus resultados.",
        };
        changed = true;
      }
    }

    for (const [areaId, revision] of currentAreas) geometryRevisionsRef.current.set(areaId, revision);
    if (changed) {
      analysesRef.current = next;
      setAnalyses(next);
    }
  }, []);

  const finishWithResult = useCallback(async (
    areaId: string,
    geometryRevision: number,
    analysisId: string,
    version: number,
    controller: AbortController,
  ) => {
    const response = await fetch(`/api/analysis/jobs/${encodeURIComponent(analysisId)}/result`, {
      signal: controller.signal,
    });
    const body = await responseBody<TerrainAnalysisResultResponse>(response);
    if (requestVersionsRef.current.get(areaId) !== version || controller.signal.aborted) return;
    if (!response.ok || !body || !("result" in body)) {
      updateAnalysis(areaId, version, {
        geometryRevision,
        state: "tracking-error",
        analysisId,
        retryMode: "resume",
        message: "El análisis está completado, pero no se pudo recuperar el resultado. Reanuda el seguimiento.",
      });
      return;
    }
    updateAnalysis(areaId, version, {
      geometryRevision,
      state: "completed",
      analysisId,
      stage: "Completado",
      message: body.data_status === "no_valid_data"
        ? "Análisis completado · sin datos válidos en esta zona."
        : body.data_status === "partial_data"
          ? "Análisis completado · cobertura parcial."
          : "Análisis completado.",
      result: body,
    });
  }, [updateAnalysis]);

  const pollAnalysis = useCallback(async (
    areaId: string,
    geometryRevision: number,
    analysisId: string,
    version: number,
    controller: AbortController,
  ) => {
    const isCurrent = () => requestVersionsRef.current.get(areaId) === version && !controller.signal.aborted;
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < MAX_POLL_DURATION_MS) {
        await waitForPoll(controller.signal);
        if (!isCurrent()) return;
        const response = await fetch(`/api/analysis/jobs/${encodeURIComponent(analysisId)}`, {
          signal: controller.signal,
        });
        const body = await responseBody<TerrainAnalysisStatusResponse>(response);
        if (!isCurrent()) return;
        if (!response.ok || !body || !("analysis_id" in body)) {
          updateAnalysis(areaId, version, {
            geometryRevision,
            state: "tracking-error",
            analysisId,
            retryMode: "resume",
            message: "Se perdió la conexión con el seguimiento. Puedes reanudarlo sin crear otro trabajo.",
          });
          return;
        }
        if (body.status === "failed") {
          updateAnalysis(areaId, version, {
            geometryRevision,
            state: "error",
            analysisId,
            retryMode: "submit",
            errorCode: body.error?.code ?? "analysis_failed",
            message: processingFailureMessage(body.error),
          });
          return;
        }
        if (body.status === "completed") {
          await finishWithResult(areaId, geometryRevision, analysisId, version, controller);
          return;
        }
        updateAnalysis(areaId, version, {
          geometryRevision,
          state: "running",
          analysisId,
          stage: body.stage,
          message: body.stage,
        });
      }

      if (isCurrent()) {
        updateAnalysis(areaId, version, {
          geometryRevision,
          state: "tracking-error",
          analysisId,
          retryMode: "resume",
          message: "El análisis sigue en el servidor. Puedes reanudar el seguimiento más tarde.",
        });
      }
    } catch {
      if (!isCurrent()) return;
      updateAnalysis(areaId, version, {
        geometryRevision,
        state: "tracking-error",
        analysisId,
        retryMode: "resume",
        message: "No se pudo consultar el estado. Reanuda el seguimiento cuando vuelva la conexión.",
      });
    }
  }, [finishWithResult, updateAnalysis]);

  const analyzeArea = useCallback(async (
    areaId: string,
    areaName: string,
    geometryRevision: number,
    geometry: TerrainAnalysisGeometry,
  ) => {
    const currentRevision = geometryRevisionsRef.current.get(areaId);
    if (currentRevision !== undefined && currentRevision !== geometryRevision) return;
    const current = analysesRef.current[areaId];
    if (current?.geometryRevision === geometryRevision && ["submitting", "running", "completed"].includes(current.state)) return;
    geometryRevisionsRef.current.set(areaId, geometryRevision);
    const { version, controller } = startOperation(areaId);
    updateAnalysis(areaId, version, {
      geometryRevision,
      state: "submitting",
      message: "Enviando el área para su análisis…",
    });

    try {
      const response = await fetch("/api/analysis/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area_name: areaName, geometry }),
        signal: controller.signal,
      });
      const body = await responseBody<TerrainAnalysisStatusResponse>(response);
      if (requestVersionsRef.current.get(areaId) !== version || controller.signal.aborted) return;
      if (!response.ok || !body || !("analysis_id" in body)) {
        const failure = apiFailureMessage(response.status, body as ApiErrorBody | null);
        updateAnalysis(areaId, version, {
          geometryRevision,
          state: "error",
          retryMode: "submit",
          errorCode: failure.code,
          message: failure.message,
        });
        return;
      }
      if (body.status === "failed") {
        updateAnalysis(areaId, version, {
          geometryRevision,
          state: "error",
          analysisId: body.analysis_id,
          retryMode: "submit",
          errorCode: body.error?.code ?? "analysis_failed",
          message: processingFailureMessage(body.error),
        });
        return;
      }
      if (body.status === "completed") {
        await finishWithResult(areaId, geometryRevision, body.analysis_id, version, controller);
        return;
      }
      updateAnalysis(areaId, version, {
        geometryRevision,
        state: "running",
        analysisId: body.analysis_id,
        stage: body.stage,
        message: body.stage,
      });
      await pollAnalysis(areaId, geometryRevision, body.analysis_id, version, controller);
    } catch {
      if (requestVersionsRef.current.get(areaId) !== version || controller.signal.aborted) return;
      updateAnalysis(areaId, version, {
        geometryRevision,
        state: "error",
        retryMode: "submit",
        errorCode: "backend_unavailable",
        message: "No se pudo conectar con el servicio de análisis. Puedes volver a intentarlo.",
      });
    } finally {
      finishOperation(areaId, controller);
    }
  }, [finishOperation, finishWithResult, pollAnalysis, startOperation, updateAnalysis]);

  const resumeAnalysis = useCallback(async (areaId: string) => {
    const current = analysesRef.current[areaId];
    if (current?.state !== "tracking-error" || !current.analysisId) return;
    const { version, controller } = startOperation(areaId);
    updateAnalysis(areaId, version, {
      ...current,
      state: "running",
      retryMode: undefined,
      message: "Reanudando el seguimiento del análisis…",
    });
    try {
      await pollAnalysis(areaId, current.geometryRevision, current.analysisId, version, controller);
    } finally {
      finishOperation(areaId, controller);
    }
  }, [finishOperation, pollAnalysis, startOperation, updateAnalysis]);

  useEffect(() => () => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
  }, []);

  return { analyses, analyzeArea, resumeAnalysis, syncAreas };
}
