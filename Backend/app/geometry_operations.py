"""Small reusable vector operations using OGR/GEOS in a local metric CRS."""

from __future__ import annotations

import json
import math
from typing import Any

from osgeo import ogr, osr

from terrain_request import local_metric_crs


MAX_BUFFER_DISTANCE_M = 50_000.0
MAX_GEOMETRY_SPAN_DEGREES = 4.0
MAX_BUFFERED_SPAN_METERS = 500_000.0
MAX_GEOMETRY_VERTICES = 10_000
MAX_OVERLAY_RESULT_VERTICES = 50_000
MAX_OVERLAY_RESULT_SPAN_METERS = 500_000.0
BUFFER_QUADRANT_SEGMENTS = 32
MIN_SUPPORTED_LATITUDE = -80.0
MAX_SUPPORTED_LATITUDE = 84.0

ogr.UseExceptions()


class GeometryOperationError(ValueError):
    """Input or result cannot be safely represented by this operation."""


class GeometryEngineUnavailable(RuntimeError):
    """The active GDAL/OGR build cannot run the GEOS operation."""


def _count_vertices(geometry: ogr.Geometry) -> int:
    children = geometry.GetGeometryCount()
    if children:
        return sum(_count_vertices(geometry.GetGeometryRef(index)) for index in range(children))
    return int(geometry.GetPointCount())


def _validate_no_antimeridian_crossing(geometry: ogr.Geometry) -> None:
    if geometry.GetGeometryCount():
        for index in range(geometry.GetGeometryCount()):
            _validate_no_antimeridian_crossing(geometry.GetGeometryRef(index))
        return

    if geometry.GetGeometryName().upper() not in {"LINESTRING", "LINEARRING"}:
        return
    points = geometry.GetPoints()
    for first, second in zip(points, points[1:]):
        if abs(float(second[0]) - float(first[0])) > 180.0:
            raise GeometryOperationError("La geometría cruza el antimeridiano y no se puede procesar en una proyección local.")


def _wgs84_spatial_reference() -> osr.SpatialReference:
    spatial_reference = osr.SpatialReference()
    if spatial_reference.ImportFromEPSG(4326) != 0:
        raise GeometryOperationError("No se pudo inicializar el sistema de coordenadas WGS84.")
    spatial_reference.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return spatial_reference


def _metric_spatial_reference(bbox: tuple[float, float, float, float]) -> tuple[str, osr.SpatialReference]:
    processing_crs = local_metric_crs(bbox)
    try:
        epsg_code = int(processing_crs.split(":", 1)[1])
    except (AttributeError, IndexError, ValueError) as error:
        raise GeometryOperationError("No se pudo seleccionar un CRS métrico local.") from error

    metric_reference = osr.SpatialReference()
    if metric_reference.ImportFromEPSG(epsg_code) != 0 or not metric_reference.IsProjected():
        raise GeometryOperationError("No se pudo inicializar el CRS métrico local.")
    metric_reference.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    if not math.isclose(metric_reference.GetLinearUnits(), 1.0, rel_tol=0.0, abs_tol=1e-9):
        raise GeometryOperationError("El CRS local no utiliza metros como unidad lineal.")
    return processing_crs, metric_reference


def _load_and_validate_geometry(geojson_geometry: dict[str, Any]) -> tuple[ogr.Geometry, tuple[float, float, float, float]]:
    if not isinstance(geojson_geometry, dict):
        raise GeometryOperationError("geometry debe ser una geometría GeoJSON.")
    if geojson_geometry.get("type") not in {"Point", "LineString", "Polygon", "MultiPolygon"}:
        raise GeometryOperationError("Solo se admiten GeoJSON Point, LineString, Polygon y MultiPolygon.")

    try:
        geometry_json = json.dumps(geojson_geometry, ensure_ascii=False, allow_nan=False)
        geometry = ogr.CreateGeometryFromJson(geometry_json)
    except (TypeError, ValueError, RuntimeError) as error:
        raise GeometryOperationError("La geometría no es un GeoJSON válido.") from error

    if geometry is None or geometry.IsEmpty():
        raise GeometryOperationError("La geometría está vacía o no se puede leer.")
    if geometry.GetGeometryName().upper() not in {"POINT", "LINESTRING", "POLYGON", "MULTIPOLYGON"}:
        raise GeometryOperationError("Solo se admiten GeoJSON Point, LineString, Polygon y MultiPolygon.")
    if not geometry.IsValid():
        raise GeometryOperationError("La geometría no es topológicamente válida.")

    vertex_count = _count_vertices(geometry)
    if vertex_count < 1 or vertex_count > MAX_GEOMETRY_VERTICES:
        raise GeometryOperationError(
            f"La geometría debe contener entre 1 y {MAX_GEOMETRY_VERTICES:,} vértices."
        )
    if geometry.GetGeometryName().upper() == "LINESTRING" and vertex_count < 2:
        raise GeometryOperationError("La línea necesita al menos dos vértices.")
    if geometry.GetGeometryName().upper() == "POLYGON" and vertex_count < 4:
        raise GeometryOperationError("El área necesita un anillo cerrado con al menos tres vértices.")
    if geometry.GetGeometryName().upper() == "MULTIPOLYGON" and vertex_count < 4:
        raise GeometryOperationError("El área compuesta necesita al menos un polígono válido.")

    min_x, max_x, min_y, max_y = geometry.GetEnvelope()
    if not all(math.isfinite(value) for value in (min_x, max_x, min_y, max_y)):
        raise GeometryOperationError("Las coordenadas deben ser números finitos.")
    if min_x < -180.0 or max_x > 180.0 or min_y < -90.0 or max_y > 90.0:
        raise GeometryOperationError("Las coordenadas deben usar longitud y latitud WGS84.")
    if max_x - min_x > 180.0:
        raise GeometryOperationError("La geometría cruza o abarca el antimeridiano; reduce su extensión.")
    if max_x - min_x > MAX_GEOMETRY_SPAN_DEGREES or max_y - min_y > MAX_GEOMETRY_SPAN_DEGREES:
        raise GeometryOperationError(
            f"La extensión de la geometría supera el límite de {MAX_GEOMETRY_SPAN_DEGREES:g}° por lado."
        )
    if min_y <= MIN_SUPPORTED_LATITUDE or max_y >= MAX_SUPPORTED_LATITUDE:
        raise GeometryOperationError("Las operaciones en regiones polares no están admitidas por esta proyección local.")

    _validate_no_antimeridian_crossing(geometry)
    geometry.AssignSpatialReference(_wgs84_spatial_reference())
    return geometry, (min_x, min_y, max_x, max_y)


def _validate_output_geometry(geometry: ogr.Geometry, operation_label: str = "El buffer") -> None:
    result_label = "El resultado del buffer" if operation_label == "El buffer" else "El resultado de la operación geométrica"
    if geometry.IsEmpty():
        raise GeometryOperationError(f"{operation_label} no produjo una geometría.")
    if geometry.GetGeometryName().upper() not in {"POLYGON", "MULTIPOLYGON"}:
        raise GeometryOperationError(f"{operation_label} produjo un tipo de geometría no compatible.")
    if not geometry.IsValid():
        raise GeometryOperationError(f"{result_label} no es topológicamente válido.")

    min_x, max_x, min_y, max_y = geometry.GetEnvelope()
    if not all(math.isfinite(value) for value in (min_x, max_x, min_y, max_y)):
        raise GeometryOperationError(f"{result_label} contiene coordenadas no válidas.")
    if min_x < -180.0 or max_x > 180.0 or min_y < -90.0 or max_y > 90.0:
        raise GeometryOperationError(f"{result_label} rebasa los límites WGS84.")
    if max_x - min_x > 180.0:
        raise GeometryOperationError(f"{result_label} cruza el antimeridiano.")
    if min_y <= MIN_SUPPORTED_LATITUDE or max_y >= MAX_SUPPORTED_LATITUDE:
        raise GeometryOperationError(f"{result_label} alcanza una región polar no compatible.")
    _validate_no_antimeridian_crossing(geometry)


def create_buffer(geojson_geometry: dict[str, Any], distance_m: float) -> dict[str, Any]:
    """Return a positive, round-ended buffer transformed back to WGS84."""
    if isinstance(distance_m, bool) or not isinstance(distance_m, (int, float)):
        raise GeometryOperationError("La distancia debe ser un número expresado en metros.")
    if not math.isfinite(distance_m) or distance_m <= 0.0:
        raise GeometryOperationError("La distancia debe ser mayor que cero.")
    if distance_m > MAX_BUFFER_DISTANCE_M:
        raise GeometryOperationError(f"La distancia máxima admitida es {MAX_BUFFER_DISTANCE_M / 1000:g} km.")

    geometry_wgs84, bbox = _load_and_validate_geometry(geojson_geometry)
    processing_crs, metric_reference = _metric_spatial_reference(bbox)

    try:
        to_metric = osr.CoordinateTransformation(_wgs84_spatial_reference(), metric_reference)
        geometry_metric = geometry_wgs84.Clone()
        geometry_metric.Transform(to_metric)
    except (RuntimeError, ValueError) as error:
        raise GeometryOperationError("No se pudo proyectar la geometría al CRS métrico local.") from error

    try:
        buffered_metric = geometry_metric.Buffer(float(distance_m), BUFFER_QUADRANT_SEGMENTS)
    except RuntimeError as error:
        if "geos" in str(error).lower():
            raise GeometryEngineUnavailable("GEOS no está disponible en esta instalación de GDAL.") from error
        raise GeometryOperationError("GEOS no pudo calcular el buffer para esta geometría.") from error

    if buffered_metric is None:
        raise GeometryEngineUnavailable("GEOS no devolvió un resultado de buffer.")
    if buffered_metric.IsEmpty():
        raise GeometryOperationError("El buffer produjo un resultado vacío.")

    metric_min_x, metric_max_x, metric_min_y, metric_max_y = buffered_metric.GetEnvelope()
    if max(metric_max_x - metric_min_x, metric_max_y - metric_min_y) > MAX_BUFFERED_SPAN_METERS:
        raise GeometryOperationError(
            f"La extensión procesada supera el límite de {MAX_BUFFERED_SPAN_METERS / 1000:g} km."
        )
    if not buffered_metric.IsValid():
        raise GeometryOperationError("El resultado del buffer no es topológicamente válido.")

    try:
        to_wgs84 = osr.CoordinateTransformation(metric_reference, _wgs84_spatial_reference())
        buffered_wgs84 = buffered_metric.Clone()
        buffered_wgs84.Transform(to_wgs84)
    except (RuntimeError, ValueError) as error:
        raise GeometryOperationError("No se pudo transformar el buffer de vuelta a WGS84.") from error

    _validate_output_geometry(buffered_wgs84)
    try:
        result_geometry = json.loads(buffered_wgs84.ExportToJson())
    except (TypeError, ValueError, RuntimeError) as error:
        raise GeometryOperationError("No se pudo serializar la geometría resultante.") from error

    result_type = buffered_wgs84.GetGeometryName().upper()
    geometry_type_names = {
        "POINT": "Point",
        "LINESTRING": "LineString",
        "POLYGON": "Polygon",
        "MULTIPOLYGON": "MultiPolygon",
    }
    return {
        "operation": "buffer",
        "input_geometry_type": geometry_type_names[geometry_wgs84.GetGeometryName().upper()],
        "result_geometry_type": geometry_type_names[result_type],
        "distance_m": float(distance_m),
        "processing_crs": processing_crs,
        "geometry": result_geometry,
        "warnings": [],
    }


def _surface_components(geometry: ogr.Geometry) -> tuple[list[ogr.Geometry], int]:
    """Extract polygonal members without repairing or discarding surface pieces."""
    geometry_name = geometry.GetGeometryName().upper()
    if geometry.IsEmpty():
        return [], 0
    if geometry_name == "POLYGON":
        return [geometry.Clone()], 0
    if geometry_name in {"MULTIPOLYGON", "GEOMETRYCOLLECTION"}:
        surfaces: list[ogr.Geometry] = []
        lower_dimension_count = 0
        for index in range(geometry.GetGeometryCount()):
            child_surfaces, child_lower_dimensions = _surface_components(geometry.GetGeometryRef(index))
            surfaces.extend(child_surfaces)
            lower_dimension_count += child_lower_dimensions
        return surfaces, lower_dimension_count
    return [], 1


def _combined_geometry_extent(
    bbox_a: tuple[float, float, float, float],
    bbox_b: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    west = min(bbox_a[0], bbox_b[0])
    south = min(bbox_a[1], bbox_b[1])
    east = max(bbox_a[2], bbox_b[2])
    north = max(bbox_a[3], bbox_b[3])
    if east - west > 180.0:
        raise GeometryOperationError("Las áreas abarcan o cruzan el antimeridiano; usa regiones cercanas entre sí.")
    if east - west > MAX_GEOMETRY_SPAN_DEGREES or north - south > MAX_GEOMETRY_SPAN_DEGREES:
        raise GeometryOperationError(
            f"La extensión conjunta supera el límite de {MAX_GEOMETRY_SPAN_DEGREES:g}° por lado."
        )
    if south <= MIN_SUPPORTED_LATITUDE or north >= MAX_SUPPORTED_LATITUDE:
        raise GeometryOperationError("La operación no está disponible en regiones polares.")
    return west, south, east, north


def create_overlay(
    operation: str,
    geometry_a_json: dict[str, Any],
    geometry_b_json: dict[str, Any],
) -> dict[str, Any]:
    """Apply a binary polygon overlay in one shared local metric CRS."""
    if operation not in {"union", "intersection", "difference"}:
        raise GeometryOperationError("La operación debe ser union, intersection o difference.")

    try:
        geometry_a_wgs84, bbox_a = _load_and_validate_geometry(geometry_a_json)
    except GeometryOperationError as error:
        raise GeometryOperationError(f"geometry_a: {error}") from error
    try:
        geometry_b_wgs84, bbox_b = _load_and_validate_geometry(geometry_b_json)
    except GeometryOperationError as error:
        raise GeometryOperationError(f"geometry_b: {error}") from error

    if geometry_a_wgs84.GetGeometryName().upper() not in {"POLYGON", "MULTIPOLYGON"}:
        raise GeometryOperationError("geometry_a debe ser Polygon o MultiPolygon.")
    if geometry_b_wgs84.GetGeometryName().upper() not in {"POLYGON", "MULTIPOLYGON"}:
        raise GeometryOperationError("geometry_b debe ser Polygon o MultiPolygon.")

    joint_bbox = _combined_geometry_extent(bbox_a, bbox_b)
    processing_crs, metric_reference = _metric_spatial_reference(joint_bbox)
    try:
        to_metric = osr.CoordinateTransformation(_wgs84_spatial_reference(), metric_reference)
        geometry_a_metric = geometry_a_wgs84.Clone()
        geometry_b_metric = geometry_b_wgs84.Clone()
        geometry_a_metric.Transform(to_metric)
        geometry_b_metric.Transform(to_metric)
    except (RuntimeError, ValueError) as error:
        raise GeometryOperationError("No se pudieron proyectar ambas áreas al CRS métrico común.") from error

    if not geometry_a_metric.IsValid() or not geometry_b_metric.IsValid():
        raise GeometryOperationError("Una geometría dejó de ser válida al proyectarla; no se alteraron los originales.")

    try:
        if operation == "union":
            result_metric = geometry_a_metric.Union(geometry_b_metric)
        elif operation == "intersection":
            result_metric = geometry_a_metric.Intersection(geometry_b_metric)
        else:
            result_metric = geometry_a_metric.Difference(geometry_b_metric)
    except RuntimeError as error:
        if "geos" in str(error).lower():
            raise GeometryEngineUnavailable("GEOS no está disponible en esta instalación de GDAL.") from error
        raise GeometryOperationError("GEOS no pudo completar la operación para estas áreas.") from error

    if result_metric is None:
        raise GeometryEngineUnavailable("GEOS no devolvió un resultado para la operación geométrica.")

    surfaces, lower_dimension_count = _surface_components(result_metric)
    warnings: list[str] = []
    if not surfaces:
        if lower_dimension_count:
            warnings.append("Las áreas solo comparten un borde o vértice; no existe superficie común para crear un área.")
        elif operation == "difference":
            warnings.append("No queda superficie de A después de restar el área B.")
        elif operation == "intersection":
            warnings.append("Las áreas no tienen una superficie común.")
        else:
            raise GeometryOperationError("La unión no produjo una superficie válida.")
        return {
            "operation": operation,
            "geometry": None,
            "result_geometry_type": None,
            "result_status": "empty",
            "processing_crs": processing_crs,
            "warnings": warnings,
        }

    result_surface = surfaces[0] if len(surfaces) == 1 else ogr.Geometry(ogr.wkbMultiPolygon)
    if len(surfaces) > 1:
        for surface in surfaces:
            if result_surface.AddGeometry(surface) != ogr.OGRERR_NONE:
                raise GeometryOperationError("No se pudieron conservar todos los componentes superficiales del resultado.")
    result_surface.AssignSpatialReference(metric_reference)

    if result_surface.IsEmpty() or not result_surface.IsValid():
        raise GeometryOperationError("El resultado superficial no es topológicamente válido.")
    result_vertices = _count_vertices(result_surface)
    if result_vertices > MAX_OVERLAY_RESULT_VERTICES:
        raise GeometryOperationError(
            f"El resultado supera el límite de {MAX_OVERLAY_RESULT_VERTICES:,} vértices."
        )
    metric_min_x, metric_max_x, metric_min_y, metric_max_y = result_surface.GetEnvelope()
    if max(metric_max_x - metric_min_x, metric_max_y - metric_min_y) > MAX_OVERLAY_RESULT_SPAN_METERS:
        raise GeometryOperationError(
            f"La extensión métrica del resultado supera {MAX_OVERLAY_RESULT_SPAN_METERS / 1000:g} km."
        )
    if lower_dimension_count:
        warnings.append(
            f"Se conservaron las superficies y se descartaron {lower_dimension_count} componentes lineales o puntuales."
        )

    try:
        to_wgs84 = osr.CoordinateTransformation(metric_reference, _wgs84_spatial_reference())
        result_wgs84 = result_surface.Clone()
        result_wgs84.Transform(to_wgs84)
    except (RuntimeError, ValueError) as error:
        raise GeometryOperationError("No se pudo transformar el resultado a WGS84.") from error

    _validate_output_geometry(result_wgs84, "La operación geométrica")
    if _count_vertices(result_wgs84) > MAX_OVERLAY_RESULT_VERTICES:
        raise GeometryOperationError(
            f"El resultado supera el límite de {MAX_OVERLAY_RESULT_VERTICES:,} vértices."
        )
    result_type = result_wgs84.GetGeometryName().upper()
    geometry_type_names = {"POLYGON": "Polygon", "MULTIPOLYGON": "MultiPolygon"}
    try:
        result_geometry = json.loads(result_wgs84.ExportToJson())
    except (TypeError, ValueError, RuntimeError) as error:
        raise GeometryOperationError("No se pudo serializar la geometría resultante.") from error

    return {
        "operation": operation,
        "geometry": result_geometry,
        "result_geometry_type": geometry_type_names[result_type],
        "result_status": "success",
        "processing_crs": processing_crs,
        "warnings": warnings,
    }
