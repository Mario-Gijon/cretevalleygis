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


def _load_and_validate_geometry(geojson_geometry: dict[str, Any]) -> tuple[ogr.Geometry, tuple[float, float, float, float]]:
    if not isinstance(geojson_geometry, dict):
        raise GeometryOperationError("geometry debe ser una geometría GeoJSON.")
    if geojson_geometry.get("type") not in {"Point", "LineString", "Polygon"}:
        raise GeometryOperationError("Solo se admiten GeoJSON Point, LineString y Polygon.")

    try:
        geometry_json = json.dumps(geojson_geometry, ensure_ascii=False, allow_nan=False)
        geometry = ogr.CreateGeometryFromJson(geometry_json)
    except (TypeError, ValueError, RuntimeError) as error:
        raise GeometryOperationError("La geometría no es un GeoJSON válido.") from error

    if geometry is None or geometry.IsEmpty():
        raise GeometryOperationError("La geometría está vacía o no se puede leer.")
    if geometry.GetGeometryName().upper() not in {"POINT", "LINESTRING", "POLYGON"}:
        raise GeometryOperationError("Solo se admiten GeoJSON Point, LineString y Polygon.")
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
        raise GeometryOperationError("Los buffers en regiones polares no están admitidos por esta proyección local.")

    _validate_no_antimeridian_crossing(geometry)
    geometry.AssignSpatialReference(_wgs84_spatial_reference())
    return geometry, (min_x, min_y, max_x, max_y)


def _validate_output_geometry(geometry: ogr.Geometry) -> None:
    if geometry.IsEmpty():
        raise GeometryOperationError("El buffer no produjo una geometría.")
    if geometry.GetGeometryName().upper() not in {"POLYGON", "MULTIPOLYGON"}:
        raise GeometryOperationError("El buffer produjo un tipo de geometría no compatible.")
    if not geometry.IsValid():
        raise GeometryOperationError("El resultado del buffer no es topológicamente válido.")

    min_x, max_x, min_y, max_y = geometry.GetEnvelope()
    if not all(math.isfinite(value) for value in (min_x, max_x, min_y, max_y)):
        raise GeometryOperationError("El resultado contiene coordenadas no válidas.")
    if min_x < -180.0 or max_x > 180.0 or min_y < -90.0 or max_y > 90.0:
        raise GeometryOperationError("El resultado rebasa los límites de coordenadas WGS84.")
    if max_x - min_x > 180.0:
        raise GeometryOperationError("El resultado cruza el antimeridiano y no se puede representar correctamente.")
    if min_y <= MIN_SUPPORTED_LATITUDE or max_y >= MAX_SUPPORTED_LATITUDE:
        raise GeometryOperationError("El resultado alcanza una región polar no compatible con la proyección local.")
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
    warnings = []
    if result_type == "MULTIPOLYGON":
        warnings.append(
            "El resultado contiene varios polígonos. La interfaz actual no puede incorporarlos sin descartar componentes; no se puede confirmar esta vista previa."
        )

    return {
        "operation": "buffer",
        "input_geometry_type": geometry_type_names[geometry_wgs84.GetGeometryName().upper()],
        "result_geometry_type": geometry_type_names[result_type],
        "distance_m": float(distance_m),
        "processing_crs": processing_crs,
        "geometry": result_geometry,
        "warnings": warnings,
    }
