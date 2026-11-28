import type { GeoJSONMultiPolygon, GeoJSONPolygon } from "ol/format/GeoJSON.js";

/** The stored GeoJSON/OpenLayers type, independent of its functional role. */
export type DrawingGeometryType = "Point" | "LineString" | "Polygon" | "MultiPolygon";
export type SurfaceGeometryType = Extract<DrawingGeometryType, "Polygon" | "MultiPolygon">;
export type GeoJSONSurfaceGeometry = GeoJSONPolygon | GeoJSONMultiPolygon;

export function isSurfaceGeometryType(type: string | null | undefined): type is SurfaceGeometryType {
  return type === "Polygon" || type === "MultiPolygon";
}
