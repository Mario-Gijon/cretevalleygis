import type Geometry from "ol/geom/Geometry.js";
import LineString from "ol/geom/LineString.js";
import MultiPolygon from "ol/geom/MultiPolygon.js";
import Point from "ol/geom/Point.js";
import Polygon from "ol/geom/Polygon.js";
import { getArea, getLength } from "ol/sphere.js";
import { toLonLat } from "ol/proj.js";
import type { ProjectionLike } from "ol/proj.js";
import type { SurfaceGeometryType } from "@/lib/geometry-types";

export type GeometryInfo =
  | { kind: "Point"; longitude: number; latitude: number }
  | { kind: "LineString"; length: number; vertices: number }
  | { kind: "Area"; geometryType: SurfaceGeometryType; area: number; perimeter: number; vertices: number; polygonCount: number };

export type MeasurementResult =
  | { kind: "distance"; value: number; vertices: number }
  | { kind: "area"; value: number; vertices: number };

const numberFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
const coordinateFormat = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 5,
  maximumFractionDigits: 5,
});

export function getGeometryInfo(geometry: Geometry, projection: ProjectionLike): GeometryInfo | null {
  if (geometry instanceof Point) {
    const [longitude, latitude] = toLonLat(geometry.getCoordinates(), projection);
    return { kind: "Point", longitude, latitude };
  }

  if (geometry instanceof LineString) {
    return {
      kind: "LineString",
      length: getLength(geometry, { projection }),
      vertices: geometry.getCoordinates().length,
    };
  }

  if (geometry instanceof Polygon || geometry instanceof MultiPolygon) {
    const polygonCoordinates = geometry instanceof Polygon
      ? [geometry.getCoordinates()]
      : geometry.getCoordinates();
    return {
      kind: "Area",
      geometryType: geometry.getType() as SurfaceGeometryType,
      area: getArea(geometry, { projection }),
      perimeter: getLength(geometry, { projection }),
      vertices: polygonCoordinates.reduce((total, rings) => total + rings.reduce(
        (count, ring) => count + Math.max(0, ring.length - 1),
        0,
      ), 0),
      polygonCount: polygonCoordinates.length,
    };
  }

  return null;
}

export function getMeasurementResult(
  geometry: Geometry,
  kind: MeasurementResult["kind"],
  projection: ProjectionLike,
): MeasurementResult | null {
  if (kind === "distance" && geometry instanceof LineString) {
    return { kind, value: getLength(geometry, { projection }), vertices: geometry.getCoordinates().length };
  }
  if (kind === "area" && geometry instanceof Polygon) {
    const rings = geometry.getCoordinates();
    return {
      kind,
      value: getArea(geometry, { projection }),
      vertices: rings.reduce((count, ring) => count + Math.max(0, ring.length - 1), 0),
    };
  }
  return null;
}

export function formatDistance(meters: number): string {
  return meters >= 1000 ? `${numberFormat.format(meters / 1000)} km` : `${numberFormat.format(meters)} m`;
}

export function formatArea(squareMeters: number): string {
  if (squareMeters >= 1_000_000) return `${numberFormat.format(squareMeters / 1_000_000)} km²`;
  if (squareMeters >= 10_000) return `${numberFormat.format(squareMeters / 10_000)} ha`;
  return `${numberFormat.format(squareMeters)} m²`;
}

export function formatCoordinate(value: number, positive: string, negative: string): string {
  return `${coordinateFormat.format(Math.abs(value))}° ${value < 0 ? negative : positive}`;
}
