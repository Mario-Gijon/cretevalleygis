import { useCallback, useEffect, useRef, useState } from "react";
import Feature from "ol/Feature.js";
import Point from "ol/geom/Point.js";
import type Geometry from "ol/geom/Geometry.js";
import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import { fromLonLat } from "ol/proj.js";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style.js";
import { getSharedTerrariumDataTileSource } from "@/lib/terrarium-data-tile";
import {
  calculateElevationProfileStatistics,
  createElevationProfilePlan,
  ELEVATION_PROFILE_LIMITS,
  type ElevationProfileResult,
  type ElevationProfileSample,
  type GeographicLineCoordinate,
} from "@/lib/elevation-profile";

export type ElevationProfileState = {
  status: "loading" | "ready" | "partial" | "error" | "cancelled";
  geometryRevision: number;
  processedSamples?: number;
  totalSamples?: number;
  result?: ElevationProfileResult;
  message?: string;
};

export type ElevationProfileElementRef = {
  id: string;
  geometryType: string;
  geometryRevision: number;
};

type ActiveRequest = {
  controller: AbortController;
  revision: number;
  token: number;
};

const markerStyle = new Style({
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: "#c2e812" }),
    stroke: new Stroke({ color: "#05294c", width: 2.5 }),
  }),
});

export function useElevationProfiles() {
  const [profilesById, setProfilesById] = useState<Record<string, ElevationProfileState>>({});
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [markerSource] = useState(() => new VectorSource<Feature<Geometry>>({ wrapX: false }));
  const [markerLayer] = useState(() => new VectorLayer({ source: markerSource, style: markerStyle, zIndex: 32 }));
  const activeRequestsRef = useRef(new Map<string, ActiveRequest>());
  const currentRevisionsRef = useRef(new Map<string, { geometryType: string; revision: number }>());
  const nextTokenRef = useRef(0);
  const hoverMarkerRef = useRef<Feature<Point> | null>(null);
  const profilesRef = useRef(profilesById);
  const activeProfileIdRef = useRef(activeProfileId);
  profilesRef.current = profilesById;
  activeProfileIdRef.current = activeProfileId;

  const clearHoverMarker = useCallback(() => {
    markerSource.clear(true);
    hoverMarkerRef.current = null;
  }, [markerSource]);

  const showSampleOnMap = useCallback((sample: ElevationProfileSample | null) => {
    if (!sample || sample.elevationMeters === null) {
      clearHoverMarker();
      return;
    }
    const coordinate = fromLonLat([sample.longitude, sample.latitude]);
    if (!hoverMarkerRef.current) {
      hoverMarkerRef.current = new Feature(new Point(coordinate));
      markerSource.addFeature(hoverMarkerRef.current);
    } else {
      hoverMarkerRef.current.getGeometry()?.setCoordinates(coordinate);
    }
  }, [clearHoverMarker, markerSource]);

  const cancelProfile = useCallback((id: string) => {
    const request = activeRequestsRef.current.get(id);
    if (request) {
      request.controller.abort();
      activeRequestsRef.current.delete(id);
      setProfilesById((previous) => {
        const current = previous[id];
        if (!current || current.status !== "loading") return previous;
        return {
          ...previous,
          [id]: {
            ...current,
            status: "cancelled",
            message: "Consulta detenida. Puedes volver a generarla cuando quieras.",
          },
        };
      });
    }
  }, []);

  const syncElements = useCallback((elements: ElevationProfileElementRef[]) => {
    const revisions = new Map(elements.map((element) => [element.id, {
      geometryType: element.geometryType,
      revision: element.geometryRevision,
    }]));
    currentRevisionsRef.current = revisions;

    for (const [id, request] of activeRequestsRef.current) {
      const current = revisions.get(id);
      if (!current || current.geometryType !== "LineString" || current.revision !== request.revision) {
        request.controller.abort();
        activeRequestsRef.current.delete(id);
      }
    }

    setProfilesById((previous) => {
      let changed = false;
      const next: Record<string, ElevationProfileState> = {};
      for (const [id, profile] of Object.entries(previous)) {
        const current = revisions.get(id);
        if (!current || current.geometryType !== "LineString" || current.revision !== profile.geometryRevision) {
          changed = true;
          continue;
        }
        next[id] = profile;
      }
      return changed ? next : previous;
    });

    const activeProfileIdValue = activeProfileIdRef.current;
    if (activeProfileIdValue) {
      const active = revisions.get(activeProfileIdValue);
      const profile = profilesRef.current[activeProfileIdValue];
      if (!active || active.geometryType !== "LineString"
        || (profile && active.revision !== profile.geometryRevision)) {
        setActiveProfileId(null);
        setPanelOpen(false);
        clearHoverMarker();
      }
    }
  }, [clearHoverMarker]);

  const openOrGenerate = useCallback(async (
    id: string,
    revision: number,
    coordinates: GeographicLineCoordinate[],
  ) => {
    setActiveProfileId(id);
    setPanelOpen(true);
    clearHoverMarker();

    const existing = profilesRef.current[id];
    if (existing?.geometryRevision === revision && existing.result) return;

    const liveRevision = currentRevisionsRef.current.get(id);
    if (liveRevision && (liveRevision.geometryType !== "LineString" || liveRevision.revision !== revision)) return;

    activeRequestsRef.current.get(id)?.controller.abort();
    const controller = new AbortController();
    const token = ++nextTokenRef.current;
    activeRequestsRef.current.set(id, { controller, revision, token });

    let plan;
    try {
      plan = createElevationProfilePlan(coordinates);
    } catch (error) {
      activeRequestsRef.current.delete(id);
      setProfilesById((previous) => ({
        ...previous,
        [id]: {
          status: "error",
          geometryRevision: revision,
          message: error instanceof Error ? error.message : "No se pudo preparar el perfil.",
        },
      }));
      return;
    }

    setProfilesById((previous) => ({
      ...previous,
      [id]: {
        status: "loading",
        geometryRevision: revision,
        processedSamples: 0,
        totalSamples: plan.samples.length,
      },
    }));

    let requestedTileCount = 0;
    const allowTileRequest = () => {
      if (requestedTileCount >= ELEVATION_PROFILE_LIMITS.maximumNewTileRequests) return false;
      requestedTileCount += 1;
      return true;
    };
    const source = getSharedTerrariumDataTileSource();
    const samples: ElevationProfileSample[] = plan.samples.map((sample) => ({ ...sample, elevationMeters: null }));
    const unavailableStatuses: string[] = [];
    let nextSampleIndex = 0;
    let processedSamples = 0;
    let reachedRequestLimit = false;

    const isStillCurrent = () => {
      const active = activeRequestsRef.current.get(id);
      const current = currentRevisionsRef.current.get(id);
      return !controller.signal.aborted
        && active?.token === token
        && active.revision === revision
        && (!current || (current.geometryType === "LineString" && current.revision === revision));
    };

    const updateProgress = () => {
      if (!isStillCurrent()) return;
      setProfilesById((previous) => {
        const current = previous[id];
        if (!current || current.geometryRevision !== revision || current.status !== "loading") return previous;
        return { ...previous, [id]: { ...current, processedSamples } };
      });
    };

    const worker = async () => {
      while (true) {
        if (controller.signal.aborted || reachedRequestLimit) return;
        const index = nextSampleIndex;
        nextSampleIndex += 1;
        if (index >= plan.samples.length) return;
        const location = plan.samples[index];
        try {
          const sampled = await source.sampleElevation(location.longitude, location.latitude, {
            signal: controller.signal,
            maximumZoom: plan.sourceZoom,
            allowTileRequest,
          });
          if (controller.signal.aborted) return;
          if (sampled.status === "available") {
            samples[index] = {
              ...location,
              elevationMeters: sampled.elevationMeters,
              sourceZoom: sampled.sourceZoom,
              pixelGroundDistanceMeters: sampled.pixelGroundDistanceMeters,
            };
          } else if (sampled.status === "request-limit") {
            reachedRequestLimit = true;
          } else {
            unavailableStatuses.push(sampled.status);
          }
        } catch {
          if (controller.signal.aborted) return;
          unavailableStatuses.push("unavailable");
        }
        processedSamples += 1;
        if (processedSamples % 20 === 0 || processedSamples === plan.samples.length || reachedRequestLimit) updateProgress();
      }
    };

    await Promise.all(Array.from(
      { length: Math.min(ELEVATION_PROFILE_LIMITS.maximumConcurrentSamples, plan.samples.length) },
      () => worker(),
    ));
    if (!isStillCurrent()) return;

    activeRequestsRef.current.delete(id);
    const validSampleCount = samples.reduce((count, sample) => count + (sample.elevationMeters === null ? 0 : 1), 0);
    if (validSampleCount === 0 && unavailableStatuses.length > 0
      && unavailableStatuses.every((status) => status === "unavailable" || status === "outside-coverage")) {
      setProfilesById((previous) => ({
        ...previous,
        [id]: {
          status: "error",
          geometryRevision: revision,
          message: "El servicio Terrarium no devolvió elevaciones para esta línea.",
        },
      }));
      return;
    }

    const statistics = calculateElevationProfileStatistics(samples, plan.totalDistanceMeters, requestedTileCount);
    const partial = reachedRequestLimit || validSampleCount < samples.length;
    const result: ElevationProfileResult = { samples, statistics };
    const message = reachedRequestLimit
      ? `Se alcanzó el límite de ${ELEVATION_PROFILE_LIMITS.maximumNewTileRequests} peticiones nuevas de teselas; se conserva la cobertura obtenida.`
      : validSampleCount < samples.length
        ? "Cobertura parcial: los tramos sin datos se muestran como interrupciones."
        : undefined;
    setProfilesById((previous) => ({
      ...previous,
      [id]: {
        status: partial ? "partial" : "ready",
        geometryRevision: revision,
        processedSamples,
        totalSamples: plan.samples.length,
        result,
        message,
      },
    }));
  }, [clearHoverMarker]);

  const cancelActiveProfile = useCallback(() => {
    if (activeProfileId) cancelProfile(activeProfileId);
  }, [activeProfileId, cancelProfile]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    clearHoverMarker();
  }, [clearHoverMarker]);

  useEffect(() => () => {
    for (const request of activeRequestsRef.current.values()) request.controller.abort();
    activeRequestsRef.current.clear();
    markerSource.clear(true);
  }, [markerSource]);

  return {
    profilesById,
    activeProfileId,
    panelOpen,
    markerLayer,
    openOrGenerate,
    cancelProfile,
    cancelActiveProfile,
    syncElements,
    showSampleOnMap,
    closePanel,
    openPanel: () => setPanelOpen(true),
  };
}
