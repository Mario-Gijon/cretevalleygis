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
import CircleStyle from "ol/style/Circle.js";
import Fill from "ol/style/Fill.js";
import Stroke from "ol/style/Stroke.js";
import Style from "ol/style/Style.js";

export type DrawingTool = "navigate" | "point" | "line" | "polygon" | "select" | "modify";
export type DrawingGeometry = "Point" | "LineString" | "Polygon";

export type DrawnElement = {
  id: string;
  name: string;
  geometryType: DrawingGeometry;
};

type DrawInteractions = Partial<Record<DrawingTool, Draw>>;
type MapCleanup = () => void;

const TOOL_TYPES: Record<Extract<DrawingTool, "point" | "line" | "polygon">, DrawingGeometry> = {
  point: "Point",
  line: "LineString",
  polygon: "Polygon",
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

function isDrawTool(tool: DrawingTool): tool is "point" | "line" | "polygon" {
  return tool === "point" || tool === "line" || tool === "polygon";
}

export function useDrawingTools() {
  const [source] = useState(() => new VectorSource<Feature<Geometry>>({ wrapX: false }));
  const [layer] = useState(() => new VectorLayer({ source, style: featureStyle, zIndex: 10 }));
  const [activeToolState, setActiveToolState] = useState<DrawingTool>("navigate");
  const [elements, setElements] = useState<DrawnElement[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [drawingInProgress, setDrawingInProgress] = useState(false);
  const activeToolRef = useRef<DrawingTool>("navigate");
  const drawInteractionsRef = useRef<DrawInteractions>({});
  const selectedFeaturesRef = useRef<Collection<Feature<Geometry>> | null>(null);
  const selectInteractionRef = useRef<Select | null>(null);
  const modifyInteractionRef = useRef<Modify | null>(null);
  const mapRef = useRef<OlMap | null>(null);
  const nextIdRef = useRef(1);
  const countsRef = useRef<Record<DrawingGeometry, number>>({
    Point: 0,
    LineString: 0,
    Polygon: 0,
  });

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
    setSelectedIds(selectedFeatures?.getArray().map((feature) => String(feature.getId() ?? "")) ?? []);
  }, []);

  const setActiveTool = useCallback((nextTool: DrawingTool) => {
    const previousTool = activeToolRef.current;
    if (previousTool === nextTool) return;

    if (isDrawTool(previousTool)) {
      drawInteractionsRef.current[previousTool]?.abortDrawing();
    }

    for (const [tool, draw] of Object.entries(drawInteractionsRef.current)) {
      draw?.setActive(tool === nextTool);
    }
    selectInteractionRef.current?.setActive(nextTool === "select");
    modifyInteractionRef.current?.setActive(nextTool === "modify");
    // Selection and modification use the same feature collection. Only Modify is
    // active in edit mode; select mode stays available as its own focused tool.
    activeToolRef.current = nextTool;
    setActiveToolState(nextTool);
    setDrawingInProgress(false);
  }, []);

  const connectMap = useCallback((map: OlMap): MapCleanup => {
    mapRef.current = map;
    const selectedFeatures = new Collection<Feature<Geometry>>();
    const select = new Select({
      features: selectedFeatures,
      layers: [layer],
      hitTolerance: 8,
      style: selectedStyle,
    });
    const modify = new Modify({ features: selectedFeatures, pixelTolerance: 12 });
    const draws: DrawInteractions = {};

    for (const [tool, type] of Object.entries(TOOL_TYPES) as ["point" | "line" | "polygon", DrawingGeometry][]) {
      const draw = new Draw({ source, type, stopClick: true });
      draw.on("drawstart", () => setDrawingInProgress(true));
      draw.on("drawabort", () => setDrawingInProgress(false));
      draw.on("drawend", ({ feature }) => {
        countsRef.current[type] += 1;
        feature.setId(`drawing-${nextIdRef.current++}`);
        feature.set("name", `${geometryNames[type]} ${countsRef.current[type]}`);
        setDrawingInProgress(false);
      });
      draws[tool] = draw;
      map.addInteraction(draw);
    }

    map.addInteraction(select);
    map.addInteraction(modify);
    drawInteractionsRef.current = draws;
    selectedFeaturesRef.current = selectedFeatures;
    selectInteractionRef.current = select;
    modifyInteractionRef.current = modify;

    for (const [tool, draw] of Object.entries(draws)) {
      draw?.setActive(tool === activeToolRef.current);
    }
    select.setActive(activeToolRef.current === "select");
    modify.setActive(activeToolRef.current === "modify");

    const updateSelection = () => refreshSelection();
    const updateElements = () => refreshElements();
    selectedFeatures.on("change:length", updateSelection);
    source.on("addfeature", updateElements);
    source.on("removefeature", updateElements);
    refreshElements();
    refreshSelection();

    return () => {
      selectedFeatures.un("change:length", updateSelection);
      source.un("addfeature", updateElements);
      source.un("removefeature", updateElements);
      for (const interaction of [...Object.values(draws), select, modify]) {
        if (interaction) map.removeInteraction(interaction);
      }
      drawInteractionsRef.current = {};
      selectedFeaturesRef.current = null;
      selectInteractionRef.current = null;
      modifyInteractionRef.current = null;
      mapRef.current = null;
      setDrawingInProgress(false);
    };
  }, [layer, refreshElements, refreshSelection, source]);

  const cancelDrawing = useCallback(() => {
    const activeTool = activeToolRef.current;
    if (isDrawTool(activeTool)) drawInteractionsRef.current[activeTool]?.abortDrawing();
    setActiveTool("navigate");
  }, [setActiveTool]);

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
      view.animate({
        center: geometry.getClosestPoint(view.getCenter() ?? [0, 0]),
        zoom: Math.max(view.getZoom() ?? 0, 15),
        duration: 260,
      });
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

  return {
    layer,
    elements,
    selectedIds,
    activeTool: activeToolState,
    drawingInProgress,
    connectMap,
    setActiveTool,
    cancelDrawing,
    selectElement,
    centerElement,
    deleteSelected,
  };
}
