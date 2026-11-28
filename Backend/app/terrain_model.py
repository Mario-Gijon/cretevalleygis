"""Bounded elevation-grid extraction for isolated terrain previews.

This module is independent of FastAPI. It reads only a small output grid from
an existing Copernicus elevation GeoTIFF and returns JSON-compatible values.
The source DEM remains unchanged; nulls preserve NoData and mask gaps.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Literal

import numpy as np
from osgeo import gdal, ogr, osr

from app.zonal_statistics import FLAT_SLOPE_THRESHOLD_PERCENT


SCHEMA_VERSION = "1.0"
DERIVATIVES_SCHEMA_VERSION = "1.1"
DEFAULT_MAX_DIMENSION = 128
MIN_MAX_DIMENSION = 16
MAX_MAX_DIMENSION = 256
MAX_GEOMETRY_VERTICES = 50_000
CONTEXT_MIN_M = 90.0
CONTEXT_FRACTION = 0.05
CONTEXT_MAX_M = 300.0
WARP_MEMORY_LIMIT_MIB = 32
COPERNICUS_SOURCE = "Copernicus DEM GLO-30 Public"
MODEL_TYPE = "DSM"
_NODATA_OUTPUT = float("nan")

gdal.UseExceptions()


class TerrainModelError(ValueError):
    """A controlled input or raster error raised by terrain-model extraction."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message
        self.status_code = status_code


def validate_geometry(geojson_geometry: dict[str, Any]) -> ogr.Geometry:
    """Return a validated Polygon/MultiPolygon in WGS84 without mutating input."""
    if not isinstance(geojson_geometry, dict) or geojson_geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise TerrainModelError("invalid_geometry", "Geometry must be a GeoJSON Polygon or MultiPolygon.")
    try:
        geometry = ogr.CreateGeometryFromJson(json.dumps(geojson_geometry, allow_nan=False))
    except (TypeError, ValueError, RuntimeError) as error:
        raise TerrainModelError("invalid_geometry", "Geometry is not valid GeoJSON.") from error
    if geometry is None or geometry.IsEmpty() or geometry.GetGeometryName().upper() not in {"POLYGON", "MULTIPOLYGON"}:
        raise TerrainModelError("invalid_geometry", "Geometry must be a non-empty Polygon or MultiPolygon.")
    if _vertex_count(geometry) > MAX_GEOMETRY_VERTICES:
        raise TerrainModelError(
            "geometry_too_complex",
            f"Geometry exceeds the terrain-model limit of {MAX_GEOMETRY_VERTICES:,} vertices.",
        )
    envelope = geometry.GetEnvelope()
    min_x, max_x, min_y, max_y = envelope
    if not all(math.isfinite(value) for value in envelope):
        raise TerrainModelError("invalid_geometry", "Geometry coordinates must be finite.")
    if min_x < -180 or max_x > 180 or min_y < -90 or max_y > 90:
        raise TerrainModelError("invalid_geometry", "Geometry coordinates must use WGS84 longitude and latitude.")
    if not geometry.IsValid() or geometry.GetArea() <= 0:
        raise TerrainModelError("invalid_geometry", "Geometry must be a valid polygon with positive area.")

    wgs84 = osr.SpatialReference()
    if wgs84.ImportFromEPSG(4326) != 0:
        raise TerrainModelError("crs_unavailable", "WGS84 could not be initialized.", 500)
    wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    geometry.AssignSpatialReference(wgs84)
    return geometry


def _vertex_count(geometry: ogr.Geometry) -> int:
    if geometry.GetGeometryCount():
        return sum(_vertex_count(geometry.GetGeometryRef(index)) for index in range(geometry.GetGeometryCount()))
    return int(geometry.GetPointCount())


def _open_elevation(path: str | Path) -> tuple[gdal.Dataset, ogr.Geometry, float, tuple[float, ...], float | None]:
    raster_path = Path(path)
    if not raster_path.is_file():
        raise TerrainModelError("terrain_data_unavailable", "The elevation raster is not available.", 404)
    try:
        dataset = gdal.Open(str(raster_path), gdal.GA_ReadOnly)
    except (RuntimeError, OSError) as error:
        raise TerrainModelError("terrain_raster_unreadable", "The elevation raster could not be opened.", 409) from error
    if dataset is None or dataset.RasterCount != 1 or dataset.RasterXSize < 1 or dataset.RasterYSize < 1:
        raise TerrainModelError("terrain_raster_unreadable", "The elevation raster is not a readable single-band dataset.", 409)

    try:
        band = dataset.GetRasterBand(1)
        if not dataset.GetProjectionRef():
            raise TerrainModelError("incompatible_terrain_crs", "The elevation raster has no horizontal CRS.", 409)
        spatial_ref = osr.SpatialReference()
        import_status = spatial_ref.ImportFromWkt(dataset.GetProjectionRef())
        if import_status != 0 or not spatial_ref.IsProjected():
            raise TerrainModelError("incompatible_terrain_crs", "The elevation raster must use a projected CRS.", 409)
        spatial_ref.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        linear_units = float(spatial_ref.GetLinearUnits())
        if not math.isfinite(linear_units) or not math.isclose(linear_units, 1.0, rel_tol=0.0, abs_tol=1e-9):
            raise TerrainModelError("incompatible_terrain_crs", "The elevation raster CRS must use metres.", 409)
        if dataset.GetMetadataItem("COPERNICUS_SOURCE") != COPERNICUS_SOURCE:
            raise TerrainModelError("incompatible_terrain_source", "The raster is not the Copernicus elevation product used by this analysis.", 409)
        if (band.GetUnitType() or "").casefold() not in {"m", "metre", "meter", "metres", "meters"}:
            raise TerrainModelError("incompatible_vertical_units", "The elevation raster must use metres.", 409)

        transform = tuple(float(value) for value in dataset.GetGeoTransform())
        if (
            not all(math.isfinite(value) for value in transform)
            or transform[1] <= 0
            or transform[5] >= 0
            or not math.isclose(transform[2], 0.0, rel_tol=0.0, abs_tol=1e-12)
            or not math.isclose(transform[4], 0.0, rel_tol=0.0, abs_tol=1e-12)
        ):
            raise TerrainModelError("incompatible_raster_grid", "The elevation raster must use a north-up grid.", 409)
        nodata = band.GetNoDataValue()
    except TerrainModelError:
        raise
    except (RuntimeError, TypeError, ValueError, OSError) as error:
        raise TerrainModelError("terrain_raster_unreadable", "The elevation raster metadata could not be read.", 409) from error
    nodata_value = float(nodata) if nodata is not None else None
    return dataset, spatial_ref, linear_units, transform, nodata_value


def _open_derivative(
    path: str | Path | None,
    label: Literal["slope", "aspect"],
    reference: gdal.Dataset,
    reference_crs: osr.SpatialReference,
    expected_source_hash: str,
) -> tuple[gdal.Dataset, float | None, str]:
    """Open and validate one numeric Horn derivative against the DEM grid."""
    if path is None or not Path(path).is_file():
        code = "slope_raster_unavailable" if label == "slope" else "aspect_raster_unavailable"
        name = "slope" if label == "slope" else "aspect"
        raise TerrainModelError(code, f"The numeric {name} raster is not available.", 404)
    try:
        dataset = gdal.Open(str(path), gdal.GA_ReadOnly)
    except (RuntimeError, OSError) as error:
        raise TerrainModelError("terrain_raster_unreadable", f"The numeric {label} raster could not be opened.", 409) from error
    if dataset is None or dataset.RasterCount != 1 or dataset.RasterXSize < 1 or dataset.RasterYSize < 1:
        raise TerrainModelError("terrain_raster_unreadable", f"The numeric {label} raster is not a readable single-band dataset.", 409)

    expected_product = "Slope in percent (Horn)" if label == "slope" else "Aspect azimuth in degrees from grid north (Horn)"
    expected_unit = "percent" if label == "slope" else "degree"
    try:
        band = dataset.GetRasterBand(1)
        projection = dataset.GetProjectionRef()
        if not projection:
            raise TerrainModelError("incompatible_derivative_crs", f"The {label} raster has no horizontal CRS.", 409)
        derivative_crs = osr.SpatialReference()
        if derivative_crs.ImportFromWkt(projection) != 0:
            raise TerrainModelError("incompatible_derivative_crs", f"The {label} raster CRS could not be read.", 409)
        derivative_crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        if not derivative_crs.IsSame(reference_crs):
            raise TerrainModelError("incompatible_derivative_crs", f"The {label} raster CRS does not match elevation.", 409)
        transform = tuple(float(value) for value in dataset.GetGeoTransform())
        reference_transform = tuple(float(value) for value in reference.GetGeoTransform())
        if (
            dataset.RasterXSize != reference.RasterXSize
            or dataset.RasterYSize != reference.RasterYSize
            or not all(math.isfinite(value) for value in transform)
            or any(not math.isclose(value, expected, rel_tol=0.0, abs_tol=1e-8) for value, expected in zip(transform, reference_transform))
        ):
            raise TerrainModelError("incompatible_derivative_grid", f"The {label} raster does not share the elevation grid.", 409)
        if transform[1] <= 0 or transform[5] >= 0 or not math.isclose(transform[2], 0.0, abs_tol=1e-12) or not math.isclose(transform[4], 0.0, abs_tol=1e-12):
            raise TerrainModelError("incompatible_derivative_grid", f"The {label} raster must use the same north-up grid as elevation.", 409)
        if not math.isclose(float(derivative_crs.GetLinearUnits()), 1.0, rel_tol=0.0, abs_tol=1e-9):
            raise TerrainModelError("incompatible_derivative_units", f"The {label} raster horizontal units must be metres.", 409)
        if (band.GetUnitType() or "").casefold() != expected_unit:
            raise TerrainModelError("incompatible_derivative_units", f"The {label} raster must use {expected_unit} units.", 409)
        style_version = dataset.GetMetadataItem("STYLE_VERSION") or ""
        if (
            dataset.GetMetadataItem("SOURCE_PRODUCT") != COPERNICUS_SOURCE
            or dataset.GetMetadataItem("DATA_ROLE") != "numeric-analysis-data"
            or dataset.GetMetadataItem("DERIVATIVE") != expected_product
            or dataset.GetMetadataItem("ALGORITHM") != "Horn"
            or dataset.GetMetadataItem("SOURCE_ELEVATION_SHA256") != expected_source_hash
            or not style_version.startswith("horn-terrain-derivatives-")
            or not style_version.removeprefix("horn-terrain-derivatives-").isdigit()
            or dataset.GetMetadataItem("HORIZONTAL_CRS") != _crs_label(reference_crs)
            or dataset.GetMetadataItem("HORIZONTAL_UNITS") != "m"
            or dataset.GetMetadataItem("VERTICAL_UNITS") != "m"
            or dataset.GetMetadataItem("RESOLUTION_M") != "30"
        ):
            raise TerrainModelError("incompatible_derivative_provenance", f"The {label} raster provenance does not match the completed Copernicus analysis.", 409)
        if label == "aspect" and dataset.GetMetadataItem("NORTH_REFERENCE") != "grid_north":
            raise TerrainModelError("incompatible_derivative_provenance", "The aspect raster must use grid north.", 409)
        nodata = band.GetNoDataValue()
        nodata_value = float(nodata) if nodata is not None else None
        declared_nodata = dataset.GetMetadataItem("NODATA")
        if declared_nodata is not None and nodata_value is not None and not math.isclose(float(declared_nodata), nodata_value, rel_tol=0.0, abs_tol=1e-9):
            raise TerrainModelError("incompatible_derivative_provenance", f"The {label} NoData metadata does not match its band.", 409)
    except TerrainModelError:
        raise
    except (RuntimeError, OSError, TypeError, ValueError) as error:
        raise TerrainModelError("terrain_raster_unreadable", f"The numeric {label} raster metadata could not be read.", 409) from error
    return dataset, nodata_value, style_version


def _project_geometry(geometry: ogr.Geometry, destination: ogr.SpatialReference) -> ogr.Geometry:
    projected = geometry.Clone()
    source = geometry.GetSpatialReference().Clone()
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    destination = destination.Clone()
    destination.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    try:
        result = projected.Transform(osr.CoordinateTransformation(source, destination))
    except (RuntimeError, ValueError) as error:
        raise TerrainModelError("geometry_projection_failed", "Geometry could not be transformed into the elevation CRS.") from error
    if result != 0 or projected.IsEmpty() or not projected.IsValid():
        raise TerrainModelError("geometry_projection_failed", "Geometry could not be represented in the elevation CRS.")
    if not all(math.isfinite(value) for value in projected.GetEnvelope()):
        raise TerrainModelError("geometry_projection_failed", "Geometry projection produced non-finite coordinates.")
    return projected


def _close_to_integer(value: float) -> int | None:
    nearest = round(value)
    return int(nearest) if math.isclose(value, nearest, rel_tol=0.0, abs_tol=1e-9) else None


def _snap_extent_to_source_grid(
    bounds: tuple[float, float, float, float],
    transform: tuple[float, ...],
    pixel_y: float,
) -> tuple[tuple[float, float, float, float], tuple[int, int, int, int]]:
    min_x, min_y, max_x, max_y = bounds
    origin_x, pixel_x, _, origin_y, _, _ = transform
    left_value = (min_x - origin_x) / pixel_x
    right_value = (max_x - origin_x) / pixel_x
    top_value = (origin_y - max_y) / pixel_y
    bottom_value = (origin_y - min_y) / pixel_y
    left_near = _close_to_integer(left_value)
    right_near = _close_to_integer(right_value)
    top_near = _close_to_integer(top_value)
    bottom_near = _close_to_integer(bottom_value)
    col_start = left_near if left_near is not None else math.floor(left_value)
    col_end = right_near if right_near is not None else math.ceil(right_value)
    row_start = top_near if top_near is not None else math.floor(top_value)
    row_end = bottom_near if bottom_near is not None else math.ceil(bottom_value)
    snapped = (
        origin_x + col_start * pixel_x,
        origin_y - row_end * pixel_y,
        origin_x + col_end * pixel_x,
        origin_y - row_start * pixel_y,
    )
    return snapped, (col_start, row_start, col_end - col_start, row_end - row_start)


def _expanded_extent(
    geometry_bounds: tuple[float, float, float, float],
    raster_bounds: tuple[float, float, float, float],
    transform: tuple[float, ...],
    pixel_y: float,
) -> tuple[tuple[float, float, float, float], float, bool]:
    min_x, min_y, max_x, max_y = geometry_bounds
    raster_min_x, raster_min_y, raster_max_x, raster_max_y = raster_bounds
    margin_m = min(max(CONTEXT_MIN_M, max(max_x - min_x, max_y - min_y) * CONTEXT_FRACTION), CONTEXT_MAX_M)
    desired = (min_x - margin_m, min_y - margin_m, max_x + margin_m, max_y + margin_m)
    expanded = (
        min(min_x, max(raster_min_x, desired[0])),
        min(min_y, max(raster_min_y, desired[1])),
        max(max_x, min(raster_max_x, desired[2])),
        max(max_y, min(raster_max_y, desired[3])),
    )
    snapped, _ = _snap_extent_to_source_grid(expanded, transform, pixel_y)
    actual_margins = (min_x - snapped[0], min_y - snapped[1], snapped[2] - max_x, snapped[3] - max_y)
    clipped = any(value + 1e-6 < margin_m for value in actual_margins)
    return snapped, margin_m, clipped


def _target_shape(source_columns: int, source_rows: int, max_dimension: int) -> tuple[int, int, bool]:
    factor = max(1.0, source_columns / max_dimension, source_rows / max_dimension)
    if factor <= 1.0:
        return source_columns, source_rows, False
    columns = max(2, min(max_dimension, math.ceil(source_columns / factor - 1e-12)))
    rows = max(2, min(max_dimension, math.ceil(source_rows / factor - 1e-12)))
    return columns, rows, True


def _valid_values(values: np.ndarray, nodata: float | None, mask: np.ndarray | None) -> np.ndarray:
    valid = np.isfinite(values)
    if nodata is not None and not math.isnan(nodata):
        valid &= values != nodata
    if mask is not None:
        valid &= mask != 0
    return valid


def _read_native_window(
    dataset: gdal.Dataset,
    transform: tuple[float, ...],
    nodata: float | None,
    source_window: tuple[int, int, int, int],
    label: str = "elevation",
) -> np.ndarray:
    col_start, row_start, columns, rows = source_window
    result = np.full((rows, columns), np.nan, dtype=np.float32)
    source_col0 = max(0, col_start)
    source_row0 = max(0, row_start)
    source_col1 = min(dataset.RasterXSize, col_start + columns)
    source_row1 = min(dataset.RasterYSize, row_start + rows)
    if source_col1 <= source_col0 or source_row1 <= source_row0:
        return result

    width = source_col1 - source_col0
    height = source_row1 - source_row0
    band = dataset.GetRasterBand(1)
    try:
        values = band.ReadAsArray(source_col0, source_row0, width, height)
        has_mask = not bool(band.GetMaskFlags() & gdal.GMF_ALL_VALID)
        mask = band.GetMaskBand().ReadAsArray(source_col0, source_row0, width, height) if has_mask else None
    except (RuntimeError, OSError) as error:
        raise TerrainModelError("terrain_read_failed", f"The {label} window could not be read.", 409) from error
    if values is None or (has_mask and mask is None) or (mask is not None and mask.shape != values.shape):
        raise TerrainModelError("terrain_read_failed", f"The {label} window could not be read.", 409)
    valid = _valid_values(values, nodata, mask)
    destination_row = source_row0 - row_start
    destination_col = source_col0 - col_start
    target = result[destination_row:destination_row + height, destination_col:destination_col + width]
    target[valid] = values[valid]
    return result


def _read_resampled_window(
    dataset: gdal.Dataset,
    nodata: float | None,
    extent: tuple[float, float, float, float],
    columns: int,
    rows: int,
    *,
    resample_algorithm: int = gdal.GRA_Bilinear,
    label: str = "elevation",
) -> np.ndarray:
    options: dict[str, Any] = {
        "format": "MEM",
        "outputBounds": extent,
        "width": columns,
        "height": rows,
        "resampleAlg": resample_algorithm,
        "dstNodata": _NODATA_OUTPUT,
        "outputType": gdal.GDT_Float32,
        "warpMemoryLimit": WARP_MEMORY_LIMIT_MIB,
        "multithread": False,
    }
    if nodata is not None:
        options["srcNodata"] = nodata
    try:
        sampled = gdal.Warp("", dataset, options=gdal.WarpOptions(**options))
        if sampled is None or sampled.RasterCount != 1 or sampled.RasterXSize != columns or sampled.RasterYSize != rows:
            raise TerrainModelError("terrain_read_failed", f"GDAL could not create the bounded {label} grid.", 409)
        band = sampled.GetRasterBand(1)
        values = band.ReadAsArray()
        has_mask = not bool(band.GetMaskFlags() & gdal.GMF_ALL_VALID)
        mask = band.GetMaskBand().ReadAsArray() if has_mask else None
        if values is None or (has_mask and mask is None) or (mask is not None and mask.shape != values.shape):
            raise TerrainModelError("terrain_read_failed", f"The resampled {label} grid could not be read.", 409)
        valid = _valid_values(values, _NODATA_OUTPUT, mask)
        result = np.full((rows, columns), np.nan, dtype=np.float32)
        result[valid] = values[valid]
        sampled = None
        return result
    except TerrainModelError:
        raise
    except (RuntimeError, OSError, ValueError) as error:
        raise TerrainModelError("terrain_read_failed", f"GDAL could not read the {label} grid.", 409) from error


def _has_valid_triangle(valid: np.ndarray) -> bool:
    rows, columns = valid.shape
    for row in range(rows - 1):
        for column in range(columns - 1):
            if int(np.count_nonzero(valid[row:row + 2, column:column + 2])) >= 3:
                return True
    return False


def _local_geometry(geometry: ogr.Geometry, origin_x: float, origin_y: float) -> dict[str, Any]:
    payload = json.loads(geometry.ExportToJson())

    def convert(value: Any) -> Any:
        if isinstance(value, list):
            if len(value) >= 2 and isinstance(value[0], (int, float)) and isinstance(value[1], (int, float)):
                converted = [round(float(value[0]) - origin_x, 6), round(float(value[1]) - origin_y, 6)]
                converted.extend(value[2:])
                return converted
            return [convert(item) for item in value]
        return value

    return {"type": payload["type"], "coordinates": convert(payload["coordinates"])}


def _crs_label(spatial_ref: osr.SpatialReference) -> str:
    authority = spatial_ref.GetAuthorityName(None)
    code = spatial_ref.GetAuthorityCode(None)
    if authority and code:
        return f"{authority}:{code}"
    try:
        spatial_ref.AutoIdentifyEPSG()
    except RuntimeError:
        pass
    authority = spatial_ref.GetAuthorityName(None)
    code = spatial_ref.GetAuthorityCode(None)
    if authority and code:
        return f"{authority}:{code}"
    name = spatial_ref.GetName()
    return str(name or "unknown")


def extract_terrain_model(
    geometry_geojson: dict[str, Any],
    elevation_raster: str | Path,
    max_dimension: int = DEFAULT_MAX_DIMENSION,
    *,
    analysis_id: str,
    source: str,
    vertical_reference: str | None = None,
    expected_horizontal_crs: str | None = None,
    include_derivatives: bool = False,
    slope_raster: str | Path | None = None,
    aspect_raster: str | Path | None = None,
    derivative_source_elevation_sha256: str | None = None,
    derivative_style_version: str | None = None,
) -> dict[str, Any]:
    """Build a bounded elevation grid and, on request, aligned Horn derivatives."""
    if isinstance(max_dimension, bool) or not isinstance(max_dimension, int) or not MIN_MAX_DIMENSION <= max_dimension <= MAX_MAX_DIMENSION:
        raise TerrainModelError(
            "invalid_grid_limit",
            f"max_dimension must be between {MIN_MAX_DIMENSION} and {MAX_MAX_DIMENSION}.",
        )
    if source != COPERNICUS_SOURCE:
        raise TerrainModelError("incompatible_terrain_source", "Only Copernicus DEM GLO-30 analysis data can be used.", 409)
    if include_derivatives and (slope_raster is None or aspect_raster is None):
        missing = "slope" if slope_raster is None else "aspect"
        code = "slope_raster_unavailable" if missing == "slope" else "aspect_raster_unavailable"
        raise TerrainModelError(code, f"The numeric {missing} raster is not available.", 404)
    if include_derivatives and (
        not isinstance(derivative_source_elevation_sha256, str)
        or len(derivative_source_elevation_sha256) != 64
        or any(character not in "0123456789abcdef" for character in derivative_source_elevation_sha256.casefold())
        or not isinstance(derivative_style_version, str)
        or not derivative_style_version
    ):
        raise TerrainModelError("incompatible_derivative_provenance", "Derivative provenance is missing or invalid.", 409)
    geometry_wgs84 = validate_geometry(geometry_geojson)
    dataset, spatial_ref, _, transform, nodata = _open_elevation(elevation_raster)
    band = dataset.GetRasterBand(1)
    projected = _project_geometry(geometry_wgs84, spatial_ref)
    geometry_bounds_raw = projected.GetEnvelope()
    geometry_bounds = (
        float(geometry_bounds_raw[0]), float(geometry_bounds_raw[2]),
        float(geometry_bounds_raw[1]), float(geometry_bounds_raw[3]),
    )
    if geometry_bounds[0] >= geometry_bounds[2] or geometry_bounds[1] >= geometry_bounds[3]:
        raise TerrainModelError("invalid_geometry", "The projected geometry has no measurable extent.")

    pixel_x = transform[1]
    pixel_y = abs(transform[5])
    raster_bounds = (
        transform[0],
        transform[3] - dataset.RasterYSize * pixel_y,
        transform[0] + dataset.RasterXSize * pixel_x,
        transform[3],
    )
    extent, context_margin_m, context_clipped = _expanded_extent(geometry_bounds, raster_bounds, transform, pixel_y)
    extent, source_window = _snap_extent_to_source_grid(extent, transform, pixel_y)
    col_start, row_start, source_columns, source_rows = source_window
    if source_columns < 1 or source_rows < 1:
        raise TerrainModelError("insufficient_source_coverage", "The elevation raster has no usable grid extent for this geometry.", 409)
    if source_columns < 2 or source_rows < 2:
        min_x, min_y, max_x, max_y = extent
        geometry_min_x, geometry_min_y, geometry_max_x, geometry_max_y = geometry_bounds
        if source_columns < 2:
            center_x = (geometry_min_x + geometry_max_x) / 2
            min_x = min(min_x, center_x - pixel_x)
            max_x = max(max_x, center_x + pixel_x)
        if source_rows < 2:
            center_y = (geometry_min_y + geometry_max_y) / 2
            min_y = min(min_y, center_y - pixel_y)
            max_y = max(max_y, center_y + pixel_y)
        extent, source_window = _snap_extent_to_source_grid((min_x, min_y, max_x, max_y), transform, pixel_y)
        col_start, row_start, source_columns, source_rows = source_window
    columns, rows, downsampled = _target_shape(source_columns, source_rows, max_dimension)

    source_nodata = band.GetNoDataValue()
    source_nodata_value = float(source_nodata) if source_nodata is not None else None
    vertical = vertical_reference or dataset_vertical_reference(dataset)
    vertical_units = band.GetUnitType() or "m"

    if downsampled:
        values = _read_resampled_window(dataset, source_nodata_value, extent, columns, rows)
        sampling_method: Literal["native_pixel_centres", "bilinear_at_cell_centres"] = "bilinear_at_cell_centres"
    else:
        values = _read_native_window(dataset, transform, source_nodata_value, source_window)
        sampling_method = "native_pixel_centres"

    derivative_payload: dict[str, Any] | None = None
    if include_derivatives:
        slope_dataset, slope_nodata, slope_data_version = _open_derivative(
            slope_raster,
            "slope",
            dataset,
            spatial_ref,
            str(derivative_source_elevation_sha256),
        )
        aspect_dataset, aspect_nodata, aspect_data_version = _open_derivative(
            aspect_raster,
            "aspect",
            dataset,
            spatial_ref,
            str(derivative_source_elevation_sha256),
        )
        if slope_data_version != aspect_data_version:
            raise TerrainModelError("incompatible_derivative_provenance", "Slope and aspect raster revisions do not match.", 409)
        if downsampled:
            slope_samples = _read_resampled_window(
                slope_dataset,
                slope_nodata,
                extent,
                columns,
                rows,
                resample_algorithm=gdal.GRA_NearestNeighbour,
                label="slope",
            )
            aspect_samples = _read_resampled_window(
                aspect_dataset,
                aspect_nodata,
                extent,
                columns,
                rows,
                resample_algorithm=gdal.GRA_NearestNeighbour,
                label="aspect",
            )
            derivative_sampling_method = "nearest_neighbor_at_common_cell_centres"
        else:
            slope_samples = _read_native_window(
                slope_dataset, transform, slope_nodata, source_window, label="slope"
            )
            aspect_samples = _read_native_window(
                aspect_dataset, transform, aspect_nodata, source_window, label="aspect"
            )
            derivative_sampling_method = "native_pixel_centres"
        slope_dataset = None
        aspect_dataset = None

        elevation_valid = np.isfinite(values)
        slope_finite = np.isfinite(slope_samples)
        slope_invalid_count = int(np.count_nonzero(slope_finite & (slope_samples < 0)))
        slope_valid = slope_finite & (slope_samples >= 0)
        slope_values = slope_samples.copy()
        slope_values[~slope_valid] = np.nan

        aspect_finite = np.isfinite(aspect_samples)
        aspect_domain_valid = aspect_finite & (aspect_samples >= 0) & (aspect_samples <= 360)
        aspect_invalid_count = int(np.count_nonzero(aspect_finite & ~aspect_domain_valid))
        # GDAL's raw aspect deliberately leaves truly flat cells as NoData.
        # Infer flatness only where the paired numeric slope confirms the
        # existing zonal-statistics threshold; 0 degrees remains valid north.
        aspect_flat = (
            ~aspect_finite
            & slope_valid
            & (slope_samples <= FLAT_SLOPE_THRESHOLD_PERCENT)
        )
        aspect_values = aspect_samples.copy()
        aspect_values[~aspect_domain_valid] = np.nan

        def coverage(valid_mask: np.ndarray, invalid_count: int = 0) -> dict[str, Any]:
            total = int(rows * columns)
            valid_count = int(np.count_nonzero(valid_mask))
            joint_count = int(np.count_nonzero(valid_mask & elevation_valid))
            elevation_count = int(np.count_nonzero(elevation_valid))
            return {
                "total_samples": total,
                "valid_samples": valid_count,
                "missing_samples": total - valid_count,
                "valid_sample_fraction": round(valid_count / total, 8) if total else 0.0,
                "invalid_domain_samples": invalid_count,
                "valid_with_elevation_samples": joint_count,
                "valid_with_elevation_fraction": round(joint_count / total, 8) if total else 0.0,
                "elevation_valid_samples": elevation_count,
                "fraction_of_elevation_samples_covered": round(joint_count / elevation_count, 8) if elevation_count else 0.0,
                "availability": "no_data" if valid_count == 0 else "partial" if valid_count < total else "available",
            }

        slope_coverage = coverage(slope_valid, slope_invalid_count)
        aspect_valid = aspect_domain_valid | aspect_flat
        aspect_coverage = coverage(aspect_valid, aspect_invalid_count)
        aspect_coverage["directional_samples"] = int(np.count_nonzero(aspect_domain_valid))
        aspect_coverage["flat_samples"] = int(np.count_nonzero(aspect_flat))
        derivative_warnings = [
            "The thematic grid is sampled at the elevation grid's cell centres; it represents selected source samples and is not an area-weighted aggregate or a zonal category distribution."
        ]
        if derivative_sampling_method != "native_pixel_centres":
            derivative_warnings.append("Slope and aspect use nearest-neighbour samples on the common output grid; elevation uses the existing bilinear method.")
        if slope_invalid_count:
            derivative_warnings.append(f"{slope_invalid_count} negative slope samples were excluded as invalid.")
        if aspect_invalid_count:
            derivative_warnings.append(f"{aspect_invalid_count} aspect samples outside 0–360 degrees were excluded as invalid.")
        if slope_coverage["valid_samples"] < rows * columns:
            derivative_warnings.append("Missing or invalid slope samples remain null and are not inferred from elevation.")
        if aspect_coverage["missing_samples"]:
            derivative_warnings.append("Aspect NoData is marked flat only when the paired valid slope is at or below the zonal flat-slope threshold; other missing samples remain null.")
        if slope_data_version != derivative_style_version:
            derivative_warnings.append("The numeric rasters retain an older style-revision tag than the analysis manifest; their Horn algorithm, source checksum, units and grid were validated and no raster was regenerated.")
        derivative_payload = {
            "source": COPERNICUS_SOURCE,
            "algorithm": "Horn",
            "derivative_version": slope_data_version,
            "analysis_manifest_version": derivative_style_version,
            "source_elevation_sha256": derivative_source_elevation_sha256,
            "source_resolution_m": {"east": abs(transform[1]), "north": abs(transform[5])},
            "source_horizontal_crs": _crs_label(spatial_ref),
            "source_horizontal_units": "m",
            "target_grid": "grid",
            "sampling_method": derivative_sampling_method,
            "resampling_policy": "Nearest-neighbour samples the original derivative at each common output cell centre; it does not aggregate the area represented by an output cell.",
            "slope": {
                "unit": "percent",
                "values_percent": [
                    [float(slope_values[row, column]) if slope_valid[row, column] else None for column in range(columns)]
                    for row in range(rows)
                ],
                "coverage": slope_coverage,
            },
            "aspect": {
                "unit": "degrees",
                "reference": "grid_north",
                "values_degrees": [
                    [float(aspect_values[row, column]) if aspect_domain_valid[row, column] else None for column in range(columns)]
                    for row in range(rows)
                ],
                "flat_mask": [[bool(aspect_flat[row, column]) for column in range(columns)] for row in range(rows)],
                "coverage": aspect_coverage,
            },
            "flat_slope_threshold_percent": FLAT_SLOPE_THRESHOLD_PERCENT,
            "warnings": derivative_warnings,
        }
    dataset = None

    valid = np.isfinite(values)
    valid_count = int(np.count_nonzero(valid))
    total_count = int(rows * columns)
    missing_count = total_count - valid_count
    if valid_count == 0:
        availability: Literal["available", "partial", "no_data", "insufficient_data"] = "no_data"
    elif not _has_valid_triangle(valid):
        availability = "insufficient_data"
    elif missing_count:
        availability = "partial"
    else:
        availability = "available"

    sampled_min = float(np.min(values[valid])) if valid_count else None
    sampled_max = float(np.max(values[valid])) if valid_count else None
    extent_width = extent[2] - extent[0]
    extent_height = extent[3] - extent[1]
    spacing_east = extent_width / columns
    spacing_north = extent_height / rows
    origin_x, origin_y = extent[0], extent[1]
    first_sample_local = (spacing_east / 2, extent_height - spacing_north / 2)
    local_geometry = _local_geometry(projected, origin_x, origin_y)
    valid_fraction = valid_count / total_count if total_count else 0.0
    output_values = [
        [float(values[row, column]) if valid[row, column] else None for column in range(columns)]
        for row in range(rows)
    ]
    source_resolution = {"east": abs(transform[1]), "north": abs(transform[5])}

    warnings = [
        "Copernicus DEM GLO-30 is a digital surface model (DSM); buildings and vegetation may affect elevation.",
        "This bounded display grid is not a replacement for the original zonal analysis results.",
        "The nominal 30 m cell spacing does not guarantee vertical accuracy.",
    ]
    if context_clipped:
        warnings.append("The requested surrounding context was limited by the available raster coverage.")
    if downsampled:
        warnings.append("The source window was reduced with bilinear sampling; no detail below source resolution was added.")
    if availability in {"partial", "no_data", "insufficient_data"}:
        warnings.append("Samples without valid elevation remain null and must not be used to create triangles.")

    crs_label = _crs_label(spatial_ref)
    if expected_horizontal_crs and crs_label != expected_horizontal_crs:
        raise TerrainModelError("incompatible_terrain_crs", "The elevation raster CRS does not match the completed analysis.", 409)

    result = {
        "schema_version": DERIVATIVES_SCHEMA_VERSION if include_derivatives else SCHEMA_VERSION,
        "analysis_id": analysis_id,
        "source": source,
        "model_type": MODEL_TYPE,
        "horizontal_crs": crs_label,
        "vertical_reference": vertical,
        "units": {"horizontal": "m", "vertical": vertical_units},
        "source_resolution_m": source_resolution,
        "source_nodata": float(source_nodata) if source_nodata is not None and math.isfinite(float(source_nodata)) else None,
        "extent_projected_m": {
            "west": extent[0], "south": extent[1], "east": extent[2], "north": extent[3],
        },
        "local_origin": {
            "projected_m": {"east": origin_x, "north": origin_y},
            "local_m": {"east": 0.0, "north": 0.0},
            "definition": "The lower-left model extent corner is local (east=0, north=0); local X points east and local Y points north.",
        },
        "geometry_local_m": local_geometry,
        "grid": {
            "columns": columns,
            "rows": rows,
            "first_sample_local_m": {"east": first_sample_local[0], "north": first_sample_local[1]},
            "sample_spacing_m": {"east": spacing_east, "north": spacing_north},
            "column_order": "west_to_east",
            "row_order": "north_to_south",
            "position_convention": "Values are located at output-cell centres; row 0 is northernmost and column 0 is westernmost.",
            "sampling_method": sampling_method,
            "values_m": output_values,
        },
        "coverage": {
            "availability": availability,
            "valid_samples": valid_count,
            "missing_samples": missing_count,
            "valid_sample_fraction": round(valid_fraction, 6),
        },
        "sampled_elevation_range_m": {"minimum": sampled_min, "maximum": sampled_max} if valid_count else None,
        "context": {"requested_margin_m": context_margin_m, "was_clipped_to_coverage": context_clipped},
        "warnings": warnings,
    }
    if derivative_payload is not None:
        result["derivatives"] = derivative_payload
    return result


def dataset_vertical_reference(dataset: gdal.Dataset) -> str | None:
    """Read a vertical reference declared by an open source raster, if any."""
    for key in ("VERTICAL_DATUM", "VERTICAL_REFERENCE", "SOURCE_VERTICAL_DATUM"):
        value = dataset.GetMetadataItem(key)
        if value:
            return str(value)
    description = dataset.GetRasterBand(1).GetDescription() or ""
    if "EGM2008" in description.upper():
        return "EGM2008"
    return None
