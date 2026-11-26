import { useCallback, useRef, useState } from "react";
import type { TerrainJobResponse, TerrainPreparationResult, TerrainPreparationView } from "@/lib/terrain-preparation";

type TerrainPreparationJobs = Record<string, TerrainPreparationView>;
type TerrainExtent = [number, number, number, number];
type ApiErrorBody = { detail?: string | { msg?: string }[] | { message?: string } };

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 1200;

function apiErrorMessage(status: number, body: ApiErrorBody): string {
  const detail = typeof body.detail === "string"
    ? body.detail
    : Array.isArray(body.detail)
      ? body.detail.map((item) => item.msg ?? "").join(" ")
      : body.detail?.message ?? "";
  const normalized = detail.toLowerCase();

  if (status === 409) return "Hay otra preparación en curso. Espera a que termine y vuelve a intentarlo.";
  if (status === 422 && /2°|safety limit|selects \d+ tiles|four tiles/.test(normalized)) {
    return "La extensión es demasiado grande. Reduce el área a un máximo de 2° por lado y cuatro teselas.";
  }
  if (status === 422) return "La extensión no es válida. Dibuja un polígono dentro del mapa y vuelve a intentarlo.";
  if (status === 503) return "El servicio de preparación no está disponible ahora mismo. El mapa base sigue funcionando.";
  return "No se pudo enviar la solicitud de preparación. El mapa base sigue disponible.";
}

function preparationFailureMessage(detail: string): string {
  const normalized = detail.toLowerCase();
  if (/http error (403|404)|nosuchkey|not found|no such key/.test(normalized)) {
    return "No hay datos Copernicus disponibles para esta extensión.";
  }
  if (/timeout|timed out|temporary failure|urlopen error/.test(normalized)) {
    return "No se pudo acceder a los datos del terreno. Inténtalo más tarde.";
  }
  return "No se pudo preparar el terreno para esta extensión. El mapa base sigue disponible.";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function useTerrainPreparation() {
  const [jobs, setJobs] = useState<TerrainPreparationJobs>({});
  const jobsRef = useRef<TerrainPreparationJobs>({});

  const updateJob = useCallback((elementId: string, job: TerrainPreparationView) => {
    const updated = { ...jobsRef.current, [elementId]: job };
    jobsRef.current = updated;
    setJobs(updated);
  }, []);

  const prepareTerrain = useCallback(async (
    elementId: string,
    areaName: string,
    bboxWgs84: TerrainExtent,
  ) => {
    const current = jobsRef.current[elementId];
    if (current?.state === "submitting" || current?.state === "running") return;

    updateJob(elementId, { state: "submitting", message: "Enviando la solicitud…" });
    try {
      const response = await fetch("/api/terrain/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area_name: areaName, bbox_wgs84: bboxWgs84 }),
      });
      const data = await response.json() as TerrainJobResponse & ApiErrorBody;
      if (!response.ok) {
        updateJob(elementId, { state: "error", message: apiErrorMessage(response.status, data) });
        return;
      }

      if (data.status === "completed") {
        const result = data.result ?? await readResult(data.job_id);
        updateJob(elementId, {
          state: "completed",
          jobId: data.job_id,
          message: data.reused || result.preparation.reused ? "Terreno preparado · datos reutilizados." : "Terreno preparado.",
          result,
          reused: data.reused || result.preparation.reused,
        });
        return;
      }

      updateJob(elementId, {
        state: "running",
        jobId: data.job_id,
        message: "Preparando el terreno. Puedes seguir usando el mapa.",
      });

      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        await wait(POLL_INTERVAL_MS);
        const statusResponse = await fetch(`/api/terrain/jobs/${encodeURIComponent(data.job_id)}`);
        if (!statusResponse.ok) throw new Error("status-unavailable");
        const status = await statusResponse.json() as TerrainJobResponse;

        if (status.status === "failed") {
          updateJob(elementId, {
            state: "error",
            jobId: data.job_id,
            message: preparationFailureMessage(status.error ?? ""),
          });
          return;
        }
        if (status.status === "completed") {
          const result = status.result ?? await readResult(data.job_id);
          updateJob(elementId, {
            state: "completed",
            jobId: data.job_id,
            message: status.reused || result.preparation.reused ? "Terreno preparado · datos reutilizados." : "Terreno preparado.",
            result,
            reused: status.reused || result.preparation.reused,
          });
          return;
        }
      }
      throw new Error("preparation-timeout");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      const message = detail === "preparation-timeout"
        ? "La preparación está tardando más de lo esperado. Puedes volver a consultar esta área más tarde."
        : "No se pudo conectar con el servicio de preparación. El mapa base y las herramientas siguen funcionando.";
      updateJob(elementId, { state: "error", message });
    }
  }, [updateJob]);

  return { jobs, prepareTerrain };
}

async function readResult(jobId: string): Promise<TerrainPreparationResult> {
  const response = await fetch(`/api/terrain/jobs/${encodeURIComponent(jobId)}/result`);
  if (!response.ok) throw new Error("result-unavailable");
  const data = await response.json() as { result: TerrainPreparationResult };
  return data.result;
}
