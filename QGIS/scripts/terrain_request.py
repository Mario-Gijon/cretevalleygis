"""Shared validation for Copernicus terrain preparation requests."""

from __future__ import annotations

import math
import os
from collections.abc import Sequence
from osgeo import osr


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive integer") from error
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


def _positive_float(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, default))
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive number") from error
    if not math.isfinite(value) or value <= 0:
        raise RuntimeError(f"{name} must be a positive number")
    return value


MAX_TILES_PER_RUN = _positive_int("TERRAIN_MAX_TILES", 16)
MAX_BBOX_SPAN_DEGREES = _positive_float("TERRAIN_MAX_SPAN_DEGREES", 4.0)
MAX_RASTER_PIXELS = _positive_int("TERRAIN_MAX_RASTER_PIXELS", 30_000_000)
PROCESSING_RESOLUTION_M = 30


def validate_bbox_values(values: Sequence[float]) -> tuple[float, float, float, float]:
    if len(values) != 4:
        raise ValueError("bbox must contain west, south, east and north")
    try:
        west, south, east, north = (float(value) for value in values)
    except (TypeError, ValueError) as error:
        raise ValueError("bbox coordinates must be numbers") from error
    if not all(math.isfinite(value) for value in (west, south, east, north)):
        raise ValueError("bbox coordinates must be finite")
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("bbox must be an increasing WGS84 longitude/latitude extent")
    if east - west > MAX_BBOX_SPAN_DEGREES or north - south > MAX_BBOX_SPAN_DEGREES:
        raise ValueError(
            f"extent exceeds the configured maximum of {MAX_BBOX_SPAN_DEGREES:g}° per side"
        )
    return west, south, east, north


def parse_bbox_text(value: str) -> tuple[float, float, float, float]:
    try:
        parts = [float(part.strip()) for part in value.split(",")]
    except (AttributeError, ValueError) as error:
        raise ValueError("bbox must be west,south,east,north") from error
    return validate_bbox_values(parts)


def tile_stem(longitude: int, latitude: int) -> str:
    northing = f"{'N' if latitude >= 0 else 'S'}{abs(latitude):02d}_00"
    easting = f"{'E' if longitude >= 0 else 'W'}{abs(longitude):03d}_00"
    return f"Copernicus_DSM_COG_10_{northing}_{easting}_DEM"


def local_metric_crs(bbox: Sequence[float]) -> str:
    west, south, east, north = bbox
    longitude = (west + east) / 2
    latitude = (south + north) / 2
    if latitude >= 84:
        return "EPSG:3413"
    if latitude <= -80:
        return "EPSG:3031"
    zone = max(1, min(60, int((longitude + 180) // 6) + 1))
    return f"EPSG:{32600 + zone if latitude >= 0 else 32700 + zone}"


def projected_raster_dimensions(
    bbox: Sequence[float], resolution_m: int = PROCESSING_RESOLUTION_M
) -> tuple[int, int, int]:
    """Estimate the rectangular projected output dimensions before any download.

    The boundary is sampled along all four sides before transforming so the
    estimate accounts for projection curvature instead of only using corners.
    """
    west, south, east, north = bbox
    source_crs = osr.SpatialReference()
    target_crs = osr.SpatialReference()
    if source_crs.ImportFromEPSG(4326) != 0 or target_crs.ImportFromEPSG(int(local_metric_crs(bbox).split(":")[1])) != 0:
        raise ValueError("could not initialize the terrain projection for the pixel limit check")
    source_crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target_crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transformation = osr.CoordinateTransformation(source_crs, target_crs)

    samples = 64
    boundary: list[tuple[float, float]] = []
    for index in range(samples + 1):
        fraction = index / samples
        longitude = west + (east - west) * fraction
        latitude = south + (north - south) * fraction
        boundary.extend(((longitude, south), (longitude, north), (west, latitude), (east, latitude)))

    try:
        projected = [transformation.TransformPoint(longitude, latitude) for longitude, latitude in boundary]
    except (RuntimeError, ValueError) as error:
        raise ValueError("could not project the requested terrain extent") from error
    eastings = [point[0] for point in projected]
    northings = [point[1] for point in projected]
    if not all(math.isfinite(value) for value in (*eastings, *northings)):
        raise ValueError("the projected terrain extent contains invalid coordinates")
    width = math.ceil((max(eastings) - min(eastings)) / resolution_m)
    height = math.ceil((max(northings) - min(northings)) / resolution_m)
    return width, height, width * height


def validate_raster_pixel_limit(bbox: Sequence[float]) -> tuple[int, int, int]:
    width, height, pixel_count = projected_raster_dimensions(bbox)
    if pixel_count > MAX_RASTER_PIXELS:
        pixel_millions = pixel_count / 1_000_000
        limit_millions = MAX_RASTER_PIXELS / 1_000_000
        raise ValueError(
            f"projected raster at {PROCESSING_RESOLUTION_M} m would contain "
            f"{pixel_millions:.1f} million pixels; limit is {limit_millions:g} million"
        )
    return width, height, pixel_count


def selected_tiles(bbox: Sequence[float]) -> list[str]:
    west, south, east, north = validate_bbox_values(bbox)
    first_x, last_x = math.floor(west), math.ceil(east) - 1
    first_y, last_y = math.floor(south), math.ceil(north) - 1
    stems = [tile_stem(x, y) for y in range(first_y, last_y + 1) for x in range(first_x, last_x + 1)]
    if not stems or len(stems) > MAX_TILES_PER_RUN:
        raise ValueError(
            f"area intersects {len(stems)} Copernicus tiles; limit is {MAX_TILES_PER_RUN}"
        )
    validate_raster_pixel_limit((west, south, east, north))
    return stems
