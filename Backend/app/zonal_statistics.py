"""Zonal statistics for numeric terrain rasters and WGS84 polygon geometry.

This module is independent of FastAPI. It reads only the raster window covered
by the polygon and returns ordinary Python values that can be serialized as
JSON. Run it in the backend image, where GDAL/OGR and the shared terrain
classification configuration are available.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from osgeo import gdal, ogr, osr

from terrain_derivative_config import ASPECT_LEGEND, SLOPE_BREAKS
from terrain_request import MAX_RASTER_PIXELS


SCHEMA_VERSION = "1.0"
CHUNK_ROWS = 256
MIN_VALID_COVERAGE_WARNING_PERCENT = 90.0
# prepare-terrain.py uses this threshold when identifying flat cells whose raw
# GDAL aspect value remains NoData.
FLAT_SLOPE_THRESHOLD_PERCENT = 1e-6

gdal.UseExceptions()


def _make_wgs84_geometry(geojson_geometry: dict[str, Any]) -> ogr.Geometry:
    if not isinstance(geojson_geometry, dict):
        raise ValueError("geometry must be a GeoJSON geometry object")
    geometry_type = geojson_geometry.get("type")
    if geometry_type not in {"Polygon", "MultiPolygon"}:
        raise ValueError("geometry type must be Polygon or MultiPolygon")
    try:
        geometry = ogr.CreateGeometryFromJson(json.dumps(geojson_geometry, allow_nan=False))
    except (TypeError, ValueError, RuntimeError) as error:
        raise ValueError("geometry is not valid GeoJSON") from error
    if geometry is None or geometry.IsEmpty():
        raise ValueError("geometry is empty or invalid")
    if geometry.GetGeometryName().upper() not in {"POLYGON", "MULTIPOLYGON"}:
        raise ValueError("geometry type must be Polygon or MultiPolygon")
    envelope = geometry.GetEnvelope()
    min_x, max_x, min_y, max_y = envelope
    if not all(math.isfinite(value) for value in envelope):
        raise ValueError("geometry coordinates must be finite")
    if min_x < -180 or max_x > 180 or min_y < -90 or max_y > 90:
        raise ValueError("geometry coordinates must use WGS84 longitude and latitude")
    if not geometry.IsValid():
        raise ValueError("geometry is topologically invalid")

    wgs84 = osr.SpatialReference()
    if wgs84.ImportFromEPSG(4326) != 0:
        raise ValueError("could not initialize the WGS84 coordinate system")
    wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    geometry.AssignSpatialReference(wgs84)
    return geometry


def _polygon_area_m2(geometry_wgs84: ogr.Geometry) -> float:
    equal_area = osr.SpatialReference()
    if equal_area.ImportFromEPSG(6933) != 0:
        raise ValueError("could not initialize the equal-area coordinate system")
    equal_area.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    source = geometry_wgs84.GetSpatialReference().Clone()
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    try:
        transformed = geometry_wgs84.Clone()
        transformed.Transform(osr.CoordinateTransformation(source, equal_area))
        area = transformed.GetArea()
    except (RuntimeError, ValueError) as error:
        raise ValueError("could not estimate polygon area in WGS84") from error
    if not math.isfinite(area) or area <= 0:
        raise ValueError("polygon area must be greater than zero")
    return float(area)


def _open_raster(path: str | Path, label: str) -> gdal.Dataset:
    raster_path = Path(path)
    if not raster_path.is_file():
        raise FileNotFoundError(f"{label} raster does not exist: {raster_path}")
    dataset = gdal.Open(str(raster_path), gdal.GA_ReadOnly)
    if dataset is None or dataset.RasterCount < 1:
        raise ValueError(f"could not open {label} raster: {raster_path}")
    if not dataset.GetProjectionRef():
        raise ValueError(f"{label} raster has no coordinate reference system")
    return dataset


def _raster_crs(dataset: gdal.Dataset) -> osr.SpatialReference:
    spatial_ref = osr.SpatialReference()
    if spatial_ref.ImportFromWkt(dataset.GetProjectionRef()) != 0:
        raise ValueError("could not read the raster coordinate reference system")
    spatial_ref.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    if not spatial_ref.IsProjected():
        raise ValueError("terrain rasters must use a projected coordinate system")
    if spatial_ref.GetLinearUnits() <= 0:
        raise ValueError("raster coordinate units are not supported")
    return spatial_ref


def _same_grid(datasets: list[gdal.Dataset]) -> None:
    reference = datasets[0]
    reference_crs = _raster_crs(reference)
    reference_transform = reference.GetGeoTransform()
    if not math.isclose(reference_transform[2], 0.0, abs_tol=1e-12) or not math.isclose(
        reference_transform[4], 0.0, abs_tol=1e-12
    ):
        raise ValueError("rotated terrain rasters are not supported")
    for dataset in datasets[1:]:
        spatial_ref = _raster_crs(dataset)
        if dataset.RasterXSize != reference.RasterXSize or dataset.RasterYSize != reference.RasterYSize:
            raise ValueError("elevation, slope and aspect rasters must share one grid")
        if not spatial_ref.IsSame(reference_crs):
            raise ValueError("elevation, slope and aspect rasters must share one CRS")
        transform = dataset.GetGeoTransform()
        if any(
            not math.isclose(value, expected, rel_tol=0.0, abs_tol=1e-8)
            for value, expected in zip(transform, reference_transform)
        ):
            raise ValueError("elevation, slope and aspect rasters must share one pixel alignment")


def _pixel_window(dataset: gdal.Dataset, geometry: ogr.Geometry) -> tuple[int, int, int, int] | None:
    transform = dataset.GetGeoTransform()
    inverse = gdal.InvGeoTransform(transform)
    if inverse is None:
        raise ValueError("raster geotransform cannot be inverted")
    if len(inverse) == 2 and isinstance(inverse[0], (bool, int)):
        success, inverse = inverse
        if not success:
            raise ValueError("raster geotransform cannot be inverted")

    min_x, max_x, min_y, max_y = geometry.GetEnvelope()
    pixels = [
        gdal.ApplyGeoTransform(inverse, x, y)
        for x, y in ((min_x, min_y), (min_x, max_y), (max_x, min_y), (max_x, max_y))
    ]
    x0 = max(0, math.floor(min(point[0] for point in pixels)))
    y0 = max(0, math.floor(min(point[1] for point in pixels)))
    x1 = min(dataset.RasterXSize, math.ceil(max(point[0] for point in pixels)))
    y1 = min(dataset.RasterYSize, math.ceil(max(point[1] for point in pixels)))
    if x1 <= x0 or y1 <= y0:
        return None
    if (x1 - x0) * (y1 - y0) > MAX_RASTER_PIXELS:
        raise ValueError(
            f"raster window exceeds the configured limit of {MAX_RASTER_PIXELS:,} pixels"
        )
    return x0, y0, x1 - x0, y1 - y0


def _rasterize_polygon(
    dataset: gdal.Dataset,
    geometry: ogr.Geometry,
    spatial_ref: osr.SpatialReference,
    window: tuple[int, int, int, int],
) -> np.ndarray:
    xoff, yoff, width, height = window
    memory_driver = ogr.GetDriverByName("Memory")
    vector = memory_driver.CreateDataSource("polygon-mask")
    layer = vector.CreateLayer("polygon", srs=spatial_ref, geom_type=ogr.wkbUnknown)
    feature = ogr.Feature(layer.GetLayerDefn())
    feature.SetGeometry(geometry)
    if layer.CreateFeature(feature) != 0:
        raise RuntimeError("could not stage polygon for rasterization")

    mask = gdal.GetDriverByName("MEM").Create("", width, height, 1, gdal.GDT_Byte)
    source_transform = dataset.GetGeoTransform()
    mask_transform = (
        source_transform[0] + xoff * source_transform[1],
        source_transform[1],
        0.0,
        source_transform[3] + yoff * source_transform[5],
        0.0,
        source_transform[5],
    )
    mask.SetGeoTransform(mask_transform)
    mask.SetProjection(dataset.GetProjectionRef())
    mask.GetRasterBand(1).Fill(0)
    rasterize_error = gdal.RasterizeLayer(
        mask, [1], layer, burn_values=[1], options=["ALL_TOUCHED=FALSE"]
    )
    if rasterize_error != 0:
        raise RuntimeError("GDAL could not rasterize the polygon")
    included = mask.GetRasterBand(1).ReadAsArray()
    if included is None:
        raise RuntimeError("could not read polygon mask")
    return included.astype(bool, copy=False)


def _json_number(value: float, precision: int = 6) -> float:
    return round(float(value), precision)


def _is_valid(values: np.ndarray, nodata: float | None) -> np.ndarray:
    valid = np.isfinite(values)
    if nodata is not None:
        if math.isnan(nodata):
            valid &= ~np.isnan(values)
        else:
            valid &= values != nodata
    return valid


def _source_metadata(dataset: gdal.Dataset) -> str | None:
    metadata = dataset.GetMetadata() or {}
    for key in (
        "COPERNICUS_SOURCE",
        "SOURCE_PRODUCT",
        "DATA_SOURCE",
        "SOURCE",
        "PRODUCT",
    ):
        value = metadata.get(key)
        if value:
            return str(value)
    return None


class _Accumulator:
    """Streaming population statistics and category counts."""

    def __init__(self, category_count: int = 0) -> None:
        self.count = 0
        self.minimum = math.inf
        self.maximum = -math.inf
        self.mean = 0.0
        self.m2 = 0.0
        self.category_counts = [0] * category_count

    def add(self, values: np.ndarray, category_counts: list[int] | None = None) -> None:
        if values.size:
            chunk = values.astype(np.float64, copy=False)
            chunk_count = int(chunk.size)
            chunk_mean = float(np.mean(chunk, dtype=np.float64))
            chunk_delta = chunk - chunk_mean
            chunk_m2 = float(np.sum(chunk_delta * chunk_delta, dtype=np.float64))

            if self.count == 0:
                self.mean = chunk_mean
                self.m2 = chunk_m2
            else:
                delta = chunk_mean - self.mean
                combined_count = self.count + chunk_count
                self.m2 += chunk_m2 + delta * delta * self.count * chunk_count / combined_count
                self.mean += delta * chunk_count / combined_count
            self.count += chunk_count
            self.minimum = min(self.minimum, float(np.min(chunk)))
            self.maximum = max(self.maximum, float(np.max(chunk)))
        if category_counts is not None:
            self.category_counts = [
                previous + current
                for previous, current in zip(self.category_counts, category_counts)
            ]

    def summary(self) -> dict[str, float | None] | None:
        if self.count == 0:
            return None
        return {
            "minimum": _json_number(self.minimum),
            "maximum": _json_number(self.maximum),
            "mean": _json_number(self.mean),
            "standard_deviation": _json_number(math.sqrt(max(0.0, self.m2 / self.count))),
            "range": _json_number(self.maximum - self.minimum),
        }


def _slope_category_counts(values: np.ndarray) -> list[int]:
    counts: list[int] = []
    lower_bound = 0.0
    for index, item in enumerate(SLOPE_BREAKS):
        upper_bound = item["upper_bound"]
        if upper_bound is None:
            selected = values > lower_bound
        elif index == 0:
            selected = (values >= 0.0) & (values <= upper_bound)
        else:
            selected = (values > lower_bound) & (values <= upper_bound)
        counts.append(int(np.count_nonzero(selected)))
        if upper_bound is not None:
            lower_bound = upper_bound
    return counts


def _slope_distribution(counts: list[int], denominator: int) -> dict[str, Any]:
    categories = []
    for item, count in zip(SLOPE_BREAKS, counts):
        categories.append({
            "id": item["id"],
            "label": item["label"],
            "pixel_count": count,
            "percentage": _json_number(count * 100 / denominator) if denominator else None,
        })
    return {
        "denominator": "valid slope pixels",
        "denominator_pixel_count": denominator,
        "categories": categories,
    }


def _aspect_category_counts(values: np.ndarray, flat_count: int) -> list[int]:
    counts = [
        int(np.count_nonzero((values <= 22.5) | (values > 337.5))),
        int(np.count_nonzero((values > 22.5) & (values <= 67.5))),
        int(np.count_nonzero((values > 67.5) & (values <= 112.5))),
        int(np.count_nonzero((values > 112.5) & (values <= 157.5))),
        int(np.count_nonzero((values > 157.5) & (values <= 202.5))),
        int(np.count_nonzero((values > 202.5) & (values <= 247.5))),
        int(np.count_nonzero((values > 247.5) & (values <= 292.5))),
        int(np.count_nonzero((values > 292.5) & (values <= 337.5))),
        flat_count,
    ]
    return counts


def _aspect_distribution(counts: list[int], denominator: int) -> dict[str, Any]:
    return {
        "denominator": "valid aspect pixels, including flat pixels inferred from slope",
        "denominator_pixel_count": denominator,
        "north_reference": "grid_north",
        "categories": [
            {
                "id": item["id"],
                "direction": item["direction"],
                "label": item["label"],
                "pixel_count": count,
                "percentage": _json_number(count * 100 / denominator) if denominator else None,
            }
            for item, count in zip(ASPECT_LEGEND, counts)
        ],
    }


def _variable_result(
    *,
    label: str,
    unit: str,
    dataset: gdal.Dataset,
    band: gdal.Band,
    accumulator: _Accumulator,
    included_pixel_count: int,
    polygon_area_m2: float,
    pixel_area_m2: float,
    resolution_m: list[float],
    distribution: dict[str, Any] | None = None,
    warnings: list[str] | None = None,
    include_summary: bool = True,
) -> dict[str, Any]:
    valid_pixel_fraction = accumulator.count * 100 / included_pixel_count if included_pixel_count else 0.0
    valid_coverage = min(100.0, accumulator.count * pixel_area_m2 * 100 / polygon_area_m2)
    variable_warnings = list(warnings or [])
    if accumulator.count == 0:
        variable_warnings.append(f"No valid {label} pixels intersect the polygon.")
    elif valid_coverage < MIN_VALID_COVERAGE_WARNING_PERCENT:
        variable_warnings.append(
            f"Valid {label} coverage of the polygon area is {valid_coverage:.1f}%, below the "
            f"{MIN_VALID_COVERAGE_WARNING_PERCENT:g}% warning threshold."
        )

    nodata = band.GetNoDataValue()
    if nodata is not None and not math.isfinite(nodata):
        nodata = None
    result: dict[str, Any] = {
        "status": "available" if accumulator.count else "no_data",
        "unit": unit,
        "statistics": accumulator.summary() if include_summary else None,
        "quality": {
            "included_pixel_count": included_pixel_count,
            "valid_pixel_count": accumulator.count,
            "valid_coverage_percent": _json_number(valid_coverage),
            "valid_pixel_fraction_of_included_percent": _json_number(valid_pixel_fraction),
            "valid_surface_area_m2": _json_number(accumulator.count * pixel_area_m2),
            "resolution_m": {"x": _json_number(resolution_m[0]), "y": _json_number(resolution_m[1])},
            "crs": _crs_label(_raster_crs(dataset)),
            "source": _source_metadata(dataset),
            "nodata": nodata,
        },
        "warnings": variable_warnings,
    }
    if distribution is not None:
        result["distribution"] = distribution
    return result


def _crs_label(spatial_ref: osr.SpatialReference) -> str:
    authority = spatial_ref.GetAuthorityName(None)
    code = spatial_ref.GetAuthorityCode(None)
    if authority and code:
        return f"{authority}:{code}"
    return spatial_ref.GetName() or "unknown"


def calculate_zonal_terrain_statistics(
    geometry_geojson: dict[str, Any],
    elevation_raster: str | Path,
    slope_raster: str | Path,
    aspect_raster: str | Path,
) -> dict[str, Any]:
    """Calculate terrain summaries for a Polygon/MultiPolygon in WGS84.

    Raster pixels are included when their centers fall inside the polygon. The
    same mask is used for all three rasters, which must share one grid. Slope
    and aspect distributions use only valid pixels for their own denominator.
    """
    geometry_wgs84 = _make_wgs84_geometry(geometry_geojson)
    polygon_area = _polygon_area_m2(geometry_wgs84)
    datasets = [
        _open_raster(elevation_raster, "elevation"),
        _open_raster(slope_raster, "slope"),
        _open_raster(aspect_raster, "aspect"),
    ]
    elevation_ds, slope_ds, aspect_ds = datasets
    _same_grid(datasets)

    reference_crs = _raster_crs(elevation_ds)
    raster_geometry = geometry_wgs84.Clone()
    wgs84 = geometry_wgs84.GetSpatialReference().Clone()
    wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    try:
        raster_geometry.Transform(osr.CoordinateTransformation(wgs84, reference_crs))
    except (RuntimeError, ValueError) as error:
        raise ValueError("could not transform geometry into the raster CRS") from error
    if not all(math.isfinite(value) for value in raster_geometry.GetEnvelope()):
        raise ValueError("geometry projection produced non-finite coordinates")

    window = _pixel_window(elevation_ds, raster_geometry)
    if window is None:
        included_mask = np.zeros((0, 0), dtype=bool)
        xoff = yoff = width = height = 0
    else:
        xoff, yoff, width, height = window
        included_mask = _rasterize_polygon(elevation_ds, raster_geometry, reference_crs, window)
    included_pixel_count = int(np.count_nonzero(included_mask))

    geotransform = elevation_ds.GetGeoTransform()
    linear_unit_factor = reference_crs.GetLinearUnits()
    resolution_m = [
        abs(geotransform[1]) * linear_unit_factor,
        abs(geotransform[5]) * linear_unit_factor,
    ]
    pixel_area_m2 = abs(geotransform[1] * geotransform[5]) * linear_unit_factor**2
    if pixel_area_m2 <= 0 or not math.isfinite(pixel_area_m2):
        raise ValueError("raster pixel area is invalid")

    elevation_band = elevation_ds.GetRasterBand(1)
    slope_band = slope_ds.GetRasterBand(1)
    aspect_band = aspect_ds.GetRasterBand(1)
    elevation_acc = _Accumulator()
    slope_acc = _Accumulator(len(SLOPE_BREAKS))
    aspect_acc = _Accumulator(len(ASPECT_LEGEND))
    aspect_flat_count = 0
    slope_invalid_count = 0
    aspect_invalid_count = 0

    for row_offset in range(0, height, CHUNK_ROWS):
        rows = min(CHUNK_ROWS, height - row_offset)
        row_mask = included_mask[row_offset : row_offset + rows]
        absolute_y = yoff + row_offset
        elevation_values = elevation_band.ReadAsArray(xoff, absolute_y, width, rows)
        slope_values = slope_band.ReadAsArray(xoff, absolute_y, width, rows)
        aspect_values = aspect_band.ReadAsArray(xoff, absolute_y, width, rows)
        if elevation_values is None or slope_values is None or aspect_values is None:
            raise RuntimeError("could not read the raster window")

        elevation_valid = row_mask & _is_valid(elevation_values, elevation_band.GetNoDataValue())
        elevation_acc.add(elevation_values[elevation_valid])

        slope_valid = row_mask & _is_valid(slope_values, slope_band.GetNoDataValue())
        slope_valid &= slope_values >= 0
        slope_invalid_count += int(np.count_nonzero(
            row_mask & _is_valid(slope_values, slope_band.GetNoDataValue()) & (slope_values < 0)
        ))
        valid_slopes = slope_values[slope_valid]
        slope_acc.add(valid_slopes, _slope_category_counts(valid_slopes))

        raw_aspect_valid = row_mask & _is_valid(aspect_values, aspect_band.GetNoDataValue())
        direction_valid = raw_aspect_valid & (aspect_values >= 0) & (aspect_values <= 360)
        aspect_invalid_count += int(np.count_nonzero(raw_aspect_valid & ~direction_valid))
        flat = (
            row_mask
            & ~raw_aspect_valid
            & slope_valid
            & (slope_values <= FLAT_SLOPE_THRESHOLD_PERCENT)
        )
        flat_count = int(np.count_nonzero(flat))
        aspect_flat_count += flat_count
        directions = aspect_values[direction_valid]
        aspect_acc.add(
            directions,
            _aspect_category_counts(directions, flat_count),
        )

    # Flat cells have valid aspect coverage but no directional angle. Add them
    # after streaming so the numeric accumulator never treats them as angles.
    aspect_acc.count += aspect_flat_count

    slope_warnings = []
    if slope_invalid_count:
        slope_warnings.append(f"{slope_invalid_count} negative slope pixels were excluded as invalid.")
    aspect_warnings = []
    if aspect_invalid_count:
        aspect_warnings.append(f"{aspect_invalid_count} out-of-range aspect pixels were excluded as invalid.")

    slope_distribution = _slope_distribution(slope_acc.category_counts, slope_acc.count)
    aspect_distribution = _aspect_distribution(aspect_acc.category_counts, aspect_acc.count)
    slope_result = _variable_result(
        label="slope",
        unit="%",
        dataset=slope_ds,
        band=slope_band,
        accumulator=slope_acc,
        included_pixel_count=included_pixel_count,
        polygon_area_m2=polygon_area,
        pixel_area_m2=pixel_area_m2,
        resolution_m=resolution_m,
        distribution=slope_distribution,
        warnings=slope_warnings,
    )
    aspect_result = _variable_result(
        label="aspect",
        unit="degrees",
        dataset=aspect_ds,
        band=aspect_band,
        accumulator=aspect_acc,
        included_pixel_count=included_pixel_count,
        polygon_area_m2=polygon_area,
        pixel_area_m2=pixel_area_m2,
        resolution_m=resolution_m,
        distribution=aspect_distribution,
        warnings=aspect_warnings,
        include_summary=False,
    )
    aspect_result["flat_pixel_count"] = aspect_flat_count
    aspect_result["quality"]["north_reference"] = "grid_north"
    elevation_result = _variable_result(
        label="elevation",
        unit="m",
        dataset=elevation_ds,
        band=elevation_band,
        accumulator=elevation_acc,
        included_pixel_count=included_pixel_count,
        polygon_area_m2=polygon_area,
        pixel_area_m2=pixel_area_m2,
        resolution_m=resolution_m,
    )
    if elevation_result["statistics"] is not None:
        elevation_result["statistics"]["maximum_relief_m"] = elevation_result["statistics"]["range"]

    warnings = [
        f"{name}: {warning}"
        for name, result in (
            ("elevation", elevation_result),
            ("slope", slope_result),
            ("aspect", aspect_result),
        )
        for warning in result["warnings"]
    ]
    included_surface = included_pixel_count * pixel_area_m2
    raster_coverage = min(100.0, included_surface * 100 / polygon_area)
    if included_pixel_count:
        warnings.append(
            "Polygon surface and included pixel surface are approximate; pixel inclusion uses pixel centers."
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "geometry_type": geometry_geojson["type"],
        "polygon_area_m2": _json_number(polygon_area),
        "pixel_inclusion": {
            "method": "pixel_center_inside_polygon",
            "included_pixel_count": included_pixel_count,
            "included_surface_area_m2": _json_number(included_surface),
            "raster_coverage_percent": _json_number(raster_coverage),
            "distribution_denominator": "valid pixels for that variable; NoData and invalid values are excluded",
        },
        "crs": {
            "code": _crs_label(reference_crs),
            "horizontal_units": reference_crs.GetLinearUnitsName(),
            "resolution_m": {"x": _json_number(resolution_m[0]), "y": _json_number(resolution_m[1])},
            "aspect_reference": "grid_north",
        },
        "elevation": elevation_result,
        "slope": slope_result,
        "aspect": aspect_result,
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Calculate zonal statistics for prepared terrain rasters")
    parser.add_argument("--geometry-file", required=True, help="UTF-8 JSON file containing a GeoJSON Polygon or MultiPolygon")
    parser.add_argument("--elevation", required=True, help="Numeric elevation GeoTIFF")
    parser.add_argument("--slope", required=True, help="Numeric slope-percent GeoTIFF")
    parser.add_argument("--aspect", required=True, help="Numeric aspect-degrees GeoTIFF (not display raster)")
    args = parser.parse_args()

    geometry = json.loads(Path(args.geometry_file).read_text(encoding="utf-8"))
    result = calculate_zonal_terrain_statistics(
        geometry,
        args.elevation,
        args.slope,
        args.aspect,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
