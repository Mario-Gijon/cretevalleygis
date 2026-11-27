import type Polygon from "ol/geom/Polygon.js";
import {
  DEFAULT_TOPOGRAPHIC_OPACITY,
  type TopographicAvailability,
  type TopographicLayerId,
  type TopographicOpacity,
  type TopographicVisibility,
} from "@/lib/topographic-layers";
import type { TerrainPreparationResult } from "@/lib/terrain-preparation";

export type PreparedTerrainState = {
  elementId: string;
  jobId: string;
  result: TerrainPreparationResult;
  geometryRevision: number;
  visible: boolean;
  visibility: TopographicVisibility;
  opacity: TopographicOpacity;
  selectedLayer: Exclude<TopographicLayerId, "hillshade">;
  availability: TopographicAvailability;
};

export type PreparedTerrainMapEntry = PreparedTerrainState & {
  geometry: Polygon;
  selected: boolean;
};

export function createPreparedTerrainState(
  elementId: string,
  jobId: string,
  result: TerrainPreparationResult,
  geometryRevision: number,
): PreparedTerrainState {
  return {
    elementId,
    jobId,
    result,
    geometryRevision,
    visible: true,
    visibility: { hillshade: true, elevation: true, slope: false, aspect: false },
    opacity: { ...DEFAULT_TOPOGRAPHIC_OPACITY, hillshade: 20, elevation: 35 },
    selectedLayer: "elevation",
    availability: {
      hillshade: true,
      elevation: true,
      slope: Boolean(result.cartography.layers.slope),
      aspect: Boolean(result.cartography.layers.aspect),
    },
  };
}
