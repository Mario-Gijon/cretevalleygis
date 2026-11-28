import { useCallback, useEffect, useRef, useState } from "react";
import type { DrawnElement } from "@/hooks/useDrawingTools";
import { isSurfaceGeometryType } from "@/lib/geometry-types";
import type {
  AreaAnalysisState,
  TerrainAnalysisGeometry,
  TerrainAnalysisStatusResponse,
  TerrainAnalysisResultResponse,
  TerrainAnalysisBatchError,
  TerrainAnalysisBatchState,
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
  const [batchState, setBatchState] = useState<TerrainAnalysisBatchState | null>(null);
  const analysesRef = useRef<AreaAnalysisStates>({});
  const geometryRevisionsRef = useRef(new Map<string, number>());
  const requestVersionsRef = useRef(new Map<string, number>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const areaOperationsRef = useRef(new Map<string, Promise<void>>());
  const operationNamesRef = useRef(new Map<string, { name: string; geometryRevision: number }>());
  const operationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const batchStateRef = useRef<TerrainAnalysisBatchState | null>(null);
  const batchTaskRef = useRef<Promise<void> | null>(null);
  const batchActiveRef = useRef(false);
  const stopBatchRequestedRef = useRef(false);

  const publishBatchState = useCallback((next: TerrainAnalysisBatchState | null) => {
    batchStateRef.current = next;
    setBatchState(next);
  }, []);

  const updateBatchState = useCallback((update: Partial<TerrainAnalysisBatchState>) => {
    const current = batchStateRef.current;
    if (!current) return;
    publishBatchState({ ...current, ...update });
  }, [publishBatchState]);

  const updateAnalysis = useCallback((areaId: string, version: number, state: AreaAnalysisState) => {
    if (requestVersionsRef.current.get(areaId) !== version) return;
    const updated = { ...analysesRef.current, [areaId]: state };
    analysesRef.current = updated;
    setAnalyses(updated);
    if (batchStateRef.current?.currentAreaId === areaId && (state.state === "submitting" || state.state === "running")) {
      updateBatchState({ currentStage: state.stage ?? state.message });
    }
  }, [updateBatchState]);

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

  const queueAreaOperation = useCallback((
    areaId: string,
    areaName: string,
    geometryRevision: number,
    run: () => Promise<void>,
    source: "individual" | "batch",
  ): Promise<void> => {
    const existing = areaOperationsRef.current.get(areaId);
    if (existing) return existing;
    if (batchActiveRef.current && source === "individual") return Promise.resolve();

    operationNamesRef.current.set(areaId, { name: areaName, geometryRevision });
    const operation = operationQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (geometryRevisionsRef.current.get(areaId) !== geometryRevision) return;
        await run();
      });
    areaOperationsRef.current.set(areaId, operation);
    operationQueueRef.current = operation.then(() => undefined, () => undefined);
    void operation.then(() => {
      if (areaOperationsRef.current.get(areaId) === operation) {
        areaOperationsRef.current.delete(areaId);
        operationNamesRef.current.delete(areaId);
      }
    });
    return operation;
  }, []);

  const syncAreas = useCallback((elements: DrawnElement[]) => {
    const currentAreas = new Map(
      elements
        .filter((element) => isSurfaceGeometryType(element.geometryType))
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
          state: "invalidated",
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
      reused: body.reused,
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

  const submitArea = useCallback(async (
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

  const resumeArea = useCallback(async (areaId: string) => {
    const current = analysesRef.current[areaId];
    if (!current?.analysisId || !["tracking-error", "running"].includes(current.state)) return;
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

  const analyzeArea = useCallback((
    areaId: string,
    areaName: string,
    geometryRevision: number,
    geometry: TerrainAnalysisGeometry,
  ): Promise<void> => {
    if (geometryRevisionsRef.current.get(areaId) !== geometryRevision) return Promise.resolve();
    const existing = areaOperationsRef.current.get(areaId);
    if (existing) return existing;
    const current = analysesRef.current[areaId];
    if (current?.geometryRevision === geometryRevision && current.state === "completed" && current.result) return Promise.resolve();

    return queueAreaOperation(areaId, areaName, geometryRevision, async () => {
      const latest = analysesRef.current[areaId];
      if (latest?.geometryRevision === geometryRevision && latest.state === "completed" && latest.result) return;
      if (latest?.geometryRevision === geometryRevision && (latest.state === "tracking-error" || latest.state === "running") && latest.analysisId) {
        await resumeArea(areaId);
        return;
      }
      await submitArea(areaId, areaName, geometryRevision, geometry);
    }, "individual");
  }, [queueAreaOperation, resumeArea, submitArea]);

  const resumeAnalysis = useCallback((areaId: string, areaName = "Área"): Promise<void> => {
    const existing = areaOperationsRef.current.get(areaId);
    if (existing) return existing;
    const current = analysesRef.current[areaId];
    if (current?.state !== "tracking-error" || !current.analysisId) return Promise.resolve();
    return queueAreaOperation(areaId, areaName, current.geometryRevision, () => resumeArea(areaId), "individual");
  }, [queueAreaOperation, resumeArea]);

  const runAnalysisBatch = useCallback((
    selectedAreas: DrawnElement[],
    criterionIds: string[],
    needsTerrainAnalysis: boolean,
  ): Promise<void> => {
    if (batchTaskRef.current) return batchTaskRef.current;

    const snapshot = selectedAreas
      .filter((area) => isSurfaceGeometryType(area.geometryType) && area.geoJsonGeometry)
      .map((area) => ({
        id: area.id,
        name: area.name,
        geometryType: area.geometryType,
        geometryRevision: area.geometryRevision,
        geometry: JSON.parse(JSON.stringify(area.geoJsonGeometry)) as TerrainAnalysisGeometry,
      }));
    const areaIds = snapshot.map((area) => area.id);
    const initialReusableCount = needsTerrainAnalysis
      ? snapshot.filter((area) => {
          const analysis = analysesRef.current[area.id];
          return analysis?.geometryRevision === area.geometryRevision && analysis.state === "completed" && analysis.result !== undefined;
        }).length
      : 0;
    const initialWorkCount = needsTerrainAnalysis ? snapshot.length - initialReusableCount : 0;

    stopBatchRequestedRef.current = false;
    batchActiveRef.current = true;
    publishBatchState({
      phase: "running",
      areaIds,
      criterionIds: [...criterionIds],
      selectedAreaCount: snapshot.length,
      reusableCount: initialReusableCount,
      totalWorkCount: initialWorkCount,
      finishedCount: 0,
      errors: [],
      message: !needsTerrainAnalysis
        ? "Los criterios seleccionados se obtienen de la geometría; no necesitan análisis del terreno."
        : initialWorkCount === 0
          ? "Los resultados seleccionados están vigentes; no se requiere procesamiento adicional."
          : "El cálculo ejecutará los análisis de uno en uno.",
    });

    const run = async () => {
      if (!needsTerrainAnalysis) {
        updateBatchState({ phase: "completed" });
        return;
      }
      if (snapshot.length === 0) {
        updateBatchState({ phase: "completed", message: "Selecciona al menos un área para calcular sus criterios." });
        return;
      }

      // A lost tracker may still represent the server's one active heavy job.
      // Resolve it explicitly before submitting work for any other area.
      const unresolved = Object.entries(analysesRef.current).find(([id, analysis]) => (
        !areaIds.includes(id) && (
          (analysis.state === "tracking-error" && analysis.analysisId !== undefined)
          || (analysis.state === "error" && (analysis.errorCode === "processing_busy" || analysis.errorCode === "backend_unavailable") && !analysis.analysisId)
        )
      ));
      if (unresolved) {
        const metadata = operationNamesRef.current.get(unresolved[0]);
        const areaName = metadata?.name ?? "otra área";
        updateBatchState({
          phase: "blocked",
          currentAreaId: undefined,
          currentAreaName: undefined,
          currentStage: undefined,
          message: `Hay un seguimiento sin resolver en ${areaName}. Reanúdalo o vuelve a intentar su análisis antes de calcular otras áreas.`,
        });
        return;
      }

      const existingOperations = [...areaOperationsRef.current.entries()];
      for (const [areaId, operation] of existingOperations) {
        const metadata = operationNamesRef.current.get(areaId);
        updateBatchState({
          currentAreaId: areaId,
          currentAreaName: metadata?.name ?? "Otra área",
          currentStage: "Esperando a que termine el proceso en curso…",
        });
        await operation;
        const result = analysesRef.current[areaId];
        if (result?.state === "tracking-error" || (result?.state === "error" && !result.analysisId && result.errorCode !== "invalid_geometry" && result.errorCode !== "area_too_large")) {
          updateBatchState({
            phase: "blocked",
            currentAreaId: undefined,
            currentAreaName: undefined,
            currentStage: undefined,
            message: result.message || "No se puede confirmar si el proceso en curso terminó. Reanuda su seguimiento antes de continuar.",
          });
          return;
        }
      }

      const currentResults = snapshot.filter((area) => {
        const analysis = analysesRef.current[area.id];
        return geometryRevisionsRef.current.get(area.id) === area.geometryRevision
          && analysis?.geometryRevision === area.geometryRevision
          && analysis.state === "completed"
          && analysis.result !== undefined;
      }).length;
      const workCount = snapshot.length - currentResults;
      updateBatchState({
        reusableCount: currentResults,
        totalWorkCount: workCount,
        finishedCount: 0,
        currentAreaId: undefined,
        currentAreaName: undefined,
        currentStage: undefined,
        message: workCount === 0
          ? "Los resultados seleccionados están vigentes; no se requiere procesamiento adicional."
          : "El cálculo ejecutará los análisis de uno en uno.",
      });

      let finishedCount = 0;
      let reusableCount = currentResults;
      const errors: TerrainAnalysisBatchError[] = [];
      let blocked = false;

      for (const area of snapshot) {
        if (stopBatchRequestedRef.current) break;
        const currentRevision = geometryRevisionsRef.current.get(area.id);
        if (currentRevision !== area.geometryRevision) {
          errors.push({ areaId: area.id, areaName: area.name, message: "La geometría cambió durante el cálculo; se omitió este resultado." });
          finishedCount += 1;
          updateBatchState({ finishedCount, errors: [...errors] });
          continue;
        }

        const current = analysesRef.current[area.id];
        if (current?.geometryRevision === area.geometryRevision && current.state === "completed" && current.result) continue;

        updateBatchState({
          currentAreaId: area.id,
          currentAreaName: area.name,
          currentStage: current?.stage ?? "Preparando análisis…",
        });

        await queueAreaOperation(area.id, area.name, area.geometryRevision, async () => {
          const latest = analysesRef.current[area.id];
          if (geometryRevisionsRef.current.get(area.id) !== area.geometryRevision) return;
          if (latest?.geometryRevision === area.geometryRevision && latest.state === "completed" && latest.result) return;
          if (latest?.geometryRevision === area.geometryRevision && latest.state === "tracking-error" && latest.analysisId) {
            await resumeArea(area.id);
            return;
          }
          if (latest?.geometryRevision === area.geometryRevision && latest.state === "running" && latest.analysisId) {
            await resumeArea(area.id);
            return;
          }
          await submitArea(area.id, area.name, area.geometryRevision, area.geometry);
        }, "batch");

        const result = analysesRef.current[area.id];
        if (geometryRevisionsRef.current.get(area.id) !== area.geometryRevision || result?.state === "invalidated") {
          errors.push({ areaId: area.id, areaName: area.name, message: "La geometría cambió o se eliminó durante el cálculo; no se utilizó el resultado anterior." });
          finishedCount += 1;
          updateBatchState({ finishedCount, errors: [...errors] });
          continue;
        }
        if (result?.geometryRevision === area.geometryRevision && result.state === "completed" && result.result) {
          if (result.reused) reusableCount += 1;
          finishedCount += 1;
          updateBatchState({ finishedCount, reusableCount });
          continue;
        }

        const message = result?.message ?? "No se pudo completar este análisis.";
        errors.push({ areaId: area.id, areaName: area.name, message });
        finishedCount += 1;
        updateBatchState({ finishedCount, errors: [...errors] });
        if (result?.state === "tracking-error" || (result?.state === "error" && !result.analysisId && result.errorCode !== "invalid_geometry" && result.errorCode !== "area_too_large")) {
          blocked = true;
          break;
        }
      }

      if (blocked) {
        updateBatchState({
          phase: "blocked",
          currentAreaId: undefined,
          currentAreaName: undefined,
          currentStage: undefined,
          errors,
          message: "El seguimiento del trabajo actual no está confirmado. Reanúdalo antes de iniciar el siguiente análisis.",
        });
      } else if (stopBatchRequestedRef.current) {
        updateBatchState({
          phase: "stopped",
          currentAreaId: undefined,
          currentAreaName: undefined,
          currentStage: undefined,
          errors,
          message: "Se detuvo el lanzamiento de nuevos análisis. El trabajo que ya estaba activo terminó y conserva su resultado.",
        });
      } else {
        updateBatchState({
          phase: "completed",
          currentAreaId: undefined,
          currentAreaName: undefined,
          currentStage: undefined,
          errors,
          message: errors.length > 0
            ? `Cálculo terminado con ${errors.length} área${errors.length === 1 ? "" : "s"} pendiente${errors.length === 1 ? "" : "s"} de resolver.`
            : workCount === 0
              ? "Los resultados seleccionados están vigentes; no se requiere procesamiento adicional."
              : "Todos los análisis de la selección han terminado.",
        });
      }
    };

    const task = run().catch(() => {
      updateBatchState({
        phase: "blocked",
        currentAreaId: undefined,
        currentAreaName: undefined,
        currentStage: undefined,
        message: "Se interrumpió la coordinación. Revisa el estado de las áreas antes de continuar.",
      });
    }).finally(() => {
      batchActiveRef.current = false;
      batchTaskRef.current = null;
    });
    batchTaskRef.current = task;
    return task;
  }, [publishBatchState, queueAreaOperation, resumeArea, submitArea, updateBatchState]);

  const stopAnalysisBatch = useCallback(() => {
    if (!batchActiveRef.current || stopBatchRequestedRef.current) return;
    stopBatchRequestedRef.current = true;
    updateBatchState({ phase: "stopping", message: "El análisis activo terminará; no se iniciarán las siguientes áreas." });
  }, [updateBatchState]);

  useEffect(() => () => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
  }, []);

  return {
    analyses,
    analyzeArea,
    resumeAnalysis,
    syncAreas,
    batchState,
    runAnalysisBatch,
    stopAnalysisBatch,
  };
}
