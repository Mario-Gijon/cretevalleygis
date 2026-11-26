import { useCallback, useRef, useState } from "react";
import Collection from "ol/Collection.js";
import Feature from "ol/Feature.js";
import type Geometry from "ol/geom/Geometry.js";
import Draw from "ol/interaction/Draw.js";
import Modify from "ol/interaction/Modify.js";
import Select from "ol/interaction/Select.js";
import type OlMap from "ol/Map.js";
import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import { unByKey } from "ol/Observable.js";
import type { EventsKey } from "ol/events.js";
import CircleStyle from "ol/style/Circle.js";
import Fill from "ol/style/Fill.js";
import Stroke from "ol/style/Stroke.js";
import Style from "ol/style/Style.js";
import { getGeometryInfo, getMeasurementResult, type GeometryInfo, type MeasurementResult } from "@/lib/geometry-metrics";

export type DrawingTool = "navigate" | "point" | "line" | "polygon" | "select" | "modify";
export type MeasurementTool = "measure-distance" | "measure-area";
export type MapTool = DrawingTool | MeasurementTool;
export type DrawingGeometry = "Point" | "LineString" | "Polygon";

export type DrawnElement = {
  id: string;
  name: string;
  geometryType: DrawingGeometry;
};

export type SelectedElementInfo = {
  id: string;
  name: string;
  geometry: GeometryInfo;
} | null;

type DrawInteractions = Partial<Record<Extract<DrawingTool, "point" | "line" | "polygon">, Draw>>;
type MeasurementInteractions = Partial<Record<MeasurementTool, Draw>>;
type MapCleanup = () => void;

const TOOL_TYPES: Record<Extract<DrawingTool, "point" | "line" | "polygon">, DrawingGeometry> = {
  point: "Point",
  line: "LineString",
  polygon: "Polygon",
};

const MEASUREMENT_TYPES: Record<MeasurementTool, { type: "LineString" | "Polygon"; kind: MeasurementResult["kind"] }> = {
  "measure-distance": { type: "LineString", kind: "distance" },
  "measure-area": { type: "Polygon", kind: "area" },
};

const geometryNames: Record<DrawingGeometry, string> = {
  Point: "Punto",
  LineString: "Línea",
  Polygon: "Área",
};

const featureStyle = new Style({
  fill: new Fill({ color: "rgba(69, 197, 197, 0.22)" }),
  stroke: new Stroke({ color: "#134F8A", width: 3 }),
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: "#134F8A" }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
});

const selectedStyle = new Style({
  fill: new Fill({ color: "rgba(69, 197, 197, 0.36)" }),
  stroke: new Stroke({ color: "#05294C", width: 4 }),
  image: new CircleStyle({
    radius: 9,
    fill: new Fill({ color: "#45C5C5" }),
    stroke: new Stroke({ color: "#05294C", width: 2 }),
  }),
});

const measurementStyle = new Style({
  fill: new Fill({ color: "rgba(69, 197, 197, 0.15)" }),
  stroke: new Stroke({ color: "#087f82", width: 3, lineDash: [8, 7] }),
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: "#ffffff" }),
    stroke: new Stroke({ color: "#087f82", width: 2 }),
  }),
});

function isDrawTool(tool: MapTool): tool is "point" | "line" | "polygon" {
  return tool === "point" || tool === "line" || tool === "polygon";
}

function isMeasurementTool(tool: MapTool): tool is MeasurementTool {
  return tool === "measure-distance" || tool === "measure-area";
}

export function useDrawingTools() {
  const [source] = useState(() => new VectorSource<Feature<Geometry>>({ wrapX: false }));
  const [layer] = useState(() => new VectorLayer({ source, style: featureStyle, zIndex: 10 }));
  const [measurementSource] = useState(() => new VectorSource<Feature<Geometry>>({ wrapX: false }));
  const [measurementLayer] = useState(() => new VectorLayer({ source: measurementSource, style: measurementStyle, zIndex: 11 }));
  const [activeToolState, setActiveToolState] = useState<MapTool>("navigate");
  const [elements, setElements] = useState<DrawnElement[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedElementInfo, setSelectedElementInfo] = useState<SelectedElementInfo>(null);
  const [drawingInProgress, setDrawingInProgress] = useState(false);
  const [measurementResult, setMeasurementResult] = useState<MeasurementResult | null>(null);
  const activeToolRef = useRef<MapTool>("navigate");
  const drawInteractionsRef = useRef<DrawInteractions>({});
  const measurementInteractionsRef = useRef<MeasurementInteractions>({});
  const selectedFeaturesRef = useRef<Collection<Feature<Geometry>> | null>(null);
  const selectInteractionRef = useRef<Select | null>(null);
  const modifyInteractionRef = useRef<Modify | null>(null);
  const mapRef = useRef<OlMap | null>(null);
  const nextIdRef = useRef(1);
  const countsRef = useRef<Record<DrawingGeometry, number>>({ Point: 0, LineString: 0, Polygon: 0 });

  const refreshElements = useCallback(() => {
    setElements(
      source.getFeatures().map((feature) => {
        const geometryType = feature.getGeometry()?.getType() as DrawingGeometry | undefined;
        const id = feature.getId();
        return {
          id: String(id ?? ""),
          name: String(feature.get("name") ?? "Elemento"),
          geometryType: geometryType ?? "Point",
        };
      }),
    );
  }, [source]);

  const refreshSelection = useCallback(() => {
    const selectedFeatures = selectedFeaturesRef.current;
    const selected = selectedFeatures?.getArray() ?? [];
    setSelectedIds(selected.map((feature) => String(feature.getId() ?? "")));
    if (selected.length !== 1) {
      setSelectedElementInfo(null);
      return;
    }
    const feature = selected[0];
    const geometry = feature.getGeometry();
    const projection = mapRef.current?.getView().getProjection();
    const geometryInfo = geometry && projection ? getGeometryInfo(geometry, projection) : null;
    setSelectedElementInfo(
      geometryInfo
        ? { id: String(feature.getId() ?? ""), name: String(feature.get("name") ?? "Elemento"), geometry: geometryInfo }
        : null,
    );
  }, []);

  const setActiveTool = useCallback((nextTool: MapTool) => {
    const previousTool = activeToolRef.current;
    if (previousTool === nextTool) return;

    if (isDrawTool(previousTool)) drawInteractionsRef.current[previousTool]?.abortDrawing();
    if (isMeasurementTool(previousTool)) measurementInteractionsRef.current[previousTool]?.abortDrawing();
    if (isMeasurementTool(nextTool)) {
      measurementSource.clear();
      setMeasurementResult(null);
    }

    for (const [tool, draw] of Object.entries(drawInteractionsRef.current)) {
      draw?.setActive(tool === nextTool);
    }
    for (const [tool, draw] of Object.entries(measurementInteractionsRef.current)) {
      draw?.setActive(tool === nextTool);
    }
    selectInteractionRef.current?.setActive(nextTool === "select");
    modifyInteractionRef.current?.setActive(nextTool === "modify");
    activeToolRef.current = nextTool;
    setActiveToolState(nextTool);
    setDrawingInProgress(false);
  }, [measurementSource]);

  const connectMap = useCallback((map: OlMap): MapCleanup => {
    mapRef.current = map;
    const selectedFeatures = new Collection<Feature<Geometry>>();
    const select = new Select({ features: selectedFeatures, layers: [layer], hitTolerance: 8, style: selectedStyle });
    const modify = new Modify({ features: selectedFeatures, pixelTolerance: 12 });
    const draws: DrawInteractions = {};
    const measurementDraws: MeasurementInteractions = {};

    for (const [tool, type] of Object.entries(TOOL_TYPES) as ["point" | "line" | "polygon", DrawingGeometry][]) {
      const draw = new Draw({ source, type, stopClick: true });
      draw.on("drawstart", () => setDrawingInProgress(true));
      draw.on("drawabort", () => setDrawingInProgress(false));
      draw.on("drawend", ({ feature }) => {
        countsRef.current[type] += 1;
        feature.setId(`drawing-${nextIdRef.current++}`);
        feature.set("name", `${geometryNames[type]} ${countsRef.current[type]}`);
        setDrawingInProgress(false);
        refreshElements();
      });
      draws[tool] = draw;
      map.addInteraction(draw);
    }

    for (const [tool, { type, kind }] of Object.entries(MEASUREMENT_TYPES) as [MeasurementTool, (typeof MEASUREMENT_TYPES)[MeasurementTool]][]) {
      const draw = new Draw({ source: measurementSource, type, stopClick: true, finishCondition: () => false });
      let geometryKey: EventsKey | undefined;
      const stopTracking = () => {
        if (geometryKey) unByKey(geometryKey);
        geometryKey = undefined;
      };
      draw.on("drawstart", ({ feature }) => {
        measurementSource.clear();
        setMeasurementResult(null);
        setDrawingInProgress(true);
        const geometry = feature.getGeometry();
        if (!geometry) return;
        const updateResult = () => {
          const result = getMeasurementResult(geometry, kind, map.getView().getProjection());
          if (!result) return;
          setMeasurementResult({ ...result, vertices: Math.max(1, result.vertices - 1) });
        };
        geometryKey = geometry.on("change", updateResult);
        updateResult();
      });
      draw.on("drawend", ({ feature }) => {
        stopTracking();
        const geometry = feature.getGeometry();
        const result = geometry && getMeasurementResult(geometry, kind, map.getView().getProjection());
        if (result) setMeasurementResult(result);
        setDrawingInProgress(false);
      });
      draw.on("drawabort", () => {
        stopTracking();
        setDrawingInProgress(false);
        setMeasurementResult(null);
        measurementSource.clear();
      });
      measurementDraws[tool] = draw;
      map.addInteraction(draw);
    }

    map.addInteraction(select);
    map.addInteraction(modify);
    drawInteractionsRef.current = draws;
    measurementInteractionsRef.current = measurementDraws;
    selectedFeaturesRef.current = selectedFeatures;
    selectInteractionRef.current = select;
    modifyInteractionRef.current = modify;

    for (const [tool, draw] of Object.entries(draws)) draw?.setActive(tool === activeToolRef.current);
    for (const [tool, draw] of Object.entries(measurementDraws)) draw?.setActive(tool === activeToolRef.current);
    select.setActive(activeToolRef.current === "select");
    modify.setActive(activeToolRef.current === "modify");

    const updateSelection = () => refreshSelection();
    const updateElements = () => {
      refreshElements();
      refreshSelection();
    };
    selectedFeatures.on("change:length", updateSelection);
    source.on("addfeature", updateElements);
    source.on("removefeature", updateElements);
    source.on("changefeature", updateElements);
    refreshElements();
    refreshSelection();

    return () => {
      selectedFeatures.un("change:length", updateSelection);
      source.un("addfeature", updateElements);
      source.un("removefeature", updateElements);
      source.un("changefeature", updateElements);
      for (const interaction of [...Object.values(draws), ...Object.values(measurementDraws), select, modify]) {
        if (interaction) map.removeInteraction(interaction);
      }
      drawInteractionsRef.current = {};
      measurementInteractionsRef.current = {};
      selectedFeaturesRef.current = null;
      selectInteractionRef.current = null;
      modifyInteractionRef.current = null;
      mapRef.current = null;
      setDrawingInProgress(false);
    };
  }, [layer, measurementSource, refreshElements, refreshSelection, source]);

  const cancelDrawing = useCallback(() => {
    const activeTool = activeToolRef.current;
    if (isDrawTool(activeTool)) drawInteractionsRef.current[activeTool]?.abortDrawing();
    if (isMeasurementTool(activeTool)) {
      measurementInteractionsRef.current[activeTool]?.abortDrawing();
      measurementSource.clear();
      setMeasurementResult(null);
    }
    setActiveTool("navigate");
  }, [measurementSource, setActiveTool]);

  const clearMeasurements = useCallback(() => {
    if (isMeasurementTool(activeToolRef.current)) {
      measurementInteractionsRef.current[activeToolRef.current]?.abortDrawing();
      setActiveTool("navigate");
    }
    measurementSource.clear();
    setMeasurementResult(null);
  }, [measurementSource, setActiveTool]);

  const canFinishMeasurement = measurementResult !== null && (
    measurementResult.kind === "distance" ? measurementResult.vertices >= 2 : measurementResult.vertices >= 3
  );

  const finishMeasurement = useCallback(() => {
    const activeTool = activeToolRef.current;
    if (!isMeasurementTool(activeTool) || !canFinishMeasurement) return;
    measurementInteractionsRef.current[activeTool]?.finishDrawing();
  }, [canFinishMeasurement]);

  const selectElement = useCallback((id: string) => {
    const feature = source.getFeatureById(id);
    const selectedFeatures = selectedFeaturesRef.current;
    if (!feature || !selectedFeatures) return;
    selectedFeatures.clear();
    selectedFeatures.push(feature as Feature<Geometry>);
    refreshSelection();
  }, [refreshSelection, source]);

  const centerElement = useCallback((id: string) => {
    const feature = source.getFeatureById(id);
    const geometry = feature?.getGeometry();
    const map = mapRef.current;
    if (!geometry || !map) return;

    const view = map.getView();
    if (geometry.getType() === "Point") {
      view.animate({ center: geometry.getClosestPoint(view.getCenter() ?? [0, 0]), zoom: Math.max(view.getZoom() ?? 0, 15), duration: 260 });
      return;
    }
    view.fit(geometry.getExtent(), { duration: 260, maxZoom: 16, padding: [100, 70, 80, 70] });
  }, [source]);

  const deleteSelected = useCallback(() => {
    const selectedFeatures = selectedFeaturesRef.current;
    if (!selectedFeatures) return;
    for (const feature of selectedFeatures.getArray().slice()) source.removeFeature(feature);
    selectedFeatures.clear();
    refreshSelection();
  }, [refreshSelection, source]);

  const renameElement = useCallback((id: string, name: string) => {
    const feature = source.getFeatureById(id);
    if (!feature) return;
    feature.set("name", name.trim() || "Elemento");
    refreshElements();
    refreshSelection();
  }, [refreshElements, refreshSelection, source]);

  return {
    layer,
    measurementLayer,
    elements,
    selectedIds,
    selectedElementInfo,
    activeTool: activeToolState,
    drawingInProgress,
    measurementResult,
    canFinishMeasurement,
    connectMap,
    setActiveTool,
    cancelDrawing,
    clearMeasurements,
    finishMeasurement,
    selectElement,
    centerElement,
    deleteSelected,
    renameElement,
  };
}
