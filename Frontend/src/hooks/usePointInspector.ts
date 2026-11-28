import { useCallback, useEffect, useRef, useState } from "react";
import Feature from "ol/Feature.js";
import type Map from "ol/Map.js";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style.js";
import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import type Geometry from "ol/geom/Geometry.js";
import Point from "ol/geom/Point.js";
import { fromLonLat, toLonLat } from "ol/proj.js";
import { terrainDerivatives } from "@/lib/exploration-terrain";
import { getSharedTerrariumDataTileSource } from "@/lib/terrarium-data-tile";

export type PointInspection = {
  status: "loading" | "available" | "no-data" | "unavailable" | "outside-coverage";
  longitude: number;
  latitude: number;
  elevationMeters?: number;
  slopePercent?: number | null;
  downslopeAzimuthDegrees?: number | null;
  aspectLabel?: string | null;
  derivativesAvailable?: boolean;
  sourceZoom?: number;
  resolutionMeters?: number;
  source?: string;
};

const ASPECT_LABELS = ["Norte", "Noreste", "Este", "Sureste", "Sur", "Suroeste", "Oeste", "Noroeste"];

function aspectLabel(degrees: number | null): string | null {
  if (degrees === null) return null;
  return ASPECT_LABELS[Math.round(degrees / 45) % ASPECT_LABELS.length];
}

export function usePointInspector() {
  const [markerSource] = useState(() => new VectorSource<Feature<Geometry>>({ wrapX: false }));
  const [layer] = useState(() => new VectorLayer({
    source: markerSource,
    style: new Style({
      image: new CircleStyle({
        radius: 8,
        fill: new Fill({ color: "#1679c5" }),
        stroke: new Stroke({ color: "#ffffff", width: 3 }),
      }),
    }),
    zIndex: 30,
  }));
  const [active, setActiveState] = useState(false);
  const [inspection, setInspection] = useState<PointInspection | null>(null);
  const activeRef = useRef(false);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const markerRef = useRef<Feature<Point> | null>(null);

  const clear = useCallback(() => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    markerSource.clear(true);
    markerRef.current = null;
    setInspection(null);
  }, [markerSource]);

  const setEnabled = useCallback((enabled: boolean) => {
    activeRef.current = enabled;
    setActiveState(enabled);
    if (!enabled) clear();
  }, [clear]);

  const inspectPoint = useCallback(async (longitude: number, latitude: number) => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    const coordinate = fromLonLat([longitude, latitude]);
    if (!markerRef.current) {
      markerRef.current = new Feature(new Point(coordinate));
      markerSource.addFeature(markerRef.current);
    } else {
      markerRef.current.getGeometry()?.setCoordinates(coordinate);
    }
    setInspection({ status: "loading", longitude, latitude });

    try {
      const sample = await getSharedTerrariumDataTileSource().samplePoint(longitude, latitude, controller.signal);
      if (controller.signal.aborted || requestIdRef.current !== requestId) return;
      if (sample.status === "outside-coverage") {
        setInspection({ status: "outside-coverage", longitude, latitude });
        return;
      }
      if (sample.status === "unavailable") {
        setInspection({ status: "unavailable", longitude, latitude });
        return;
      }
      if (sample.status === "no-data") {
        setInspection({ status: "no-data", longitude, latitude });
        return;
      }

      const derivatives = sample.status === "complete"
        ? terrainDerivatives(
            sample.westMeters,
            sample.eastMeters,
            sample.northMeters,
            sample.southMeters,
            sample.pixelGroundDistanceMeters,
          )
        : null;
      setInspection({
        status: "available",
        longitude,
        latitude,
        elevationMeters: sample.elevationMeters,
        slopePercent: derivatives?.slopePercent ?? null,
        downslopeAzimuthDegrees: derivatives?.aspectDegrees ?? null,
        aspectLabel: derivatives ? aspectLabel(derivatives.aspectDegrees) : null,
        derivativesAvailable: derivatives !== null,
        sourceZoom: sample.sourceZoom,
        resolutionMeters: sample.pixelGroundDistanceMeters,
        source: "Mapzen Terrain Tiles · Terrarium",
      });
    } catch {
      if (controller.signal.aborted || requestIdRef.current !== requestId) return;
      setInspection({ status: "unavailable", longitude, latitude });
    }
  }, [markerSource]);

  const connectMap = useCallback((map: Map) => {
    const onSingleClick = (event: { coordinate: number[] }) => {
      if (!activeRef.current) return;
      const [longitude, latitude] = toLonLat(event.coordinate, map.getView().getProjection());
      void inspectPoint(longitude, latitude);
    };
    map.on("singleclick", onSingleClick);
    return () => map.un("singleclick", onSingleClick);
  }, [inspectPoint]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !activeRef.current) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable
        || target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
      )) return;
      event.preventDefault();
      setEnabled(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setEnabled]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    markerSource.clear(true);
  }, [markerSource]);

  return { active, inspection, layer, connectMap, setEnabled, clear };
}
