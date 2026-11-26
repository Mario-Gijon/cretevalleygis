"""Shared validation for Copernicus terrain preparation requests."""

from __future__ import annotations

import math
from collections.abc import Sequence


MAX_TILES_PER_RUN = 4
MAX_BBOX_SPAN_DEGREES = 2.0


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
        raise ValueError("terrain preparation is limited to small areas (max 2° × 2°)")
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


def selected_tiles(bbox: Sequence[float]) -> list[str]:
    west, south, east, north = validate_bbox_values(bbox)
    first_x, last_x = math.floor(west), math.ceil(east) - 1
    first_y, last_y = math.floor(south), math.ceil(north) - 1
    stems = [tile_stem(x, y) for y in range(first_y, last_y + 1) for x in range(first_x, last_x + 1)]
    if not stems or len(stems) > MAX_TILES_PER_RUN:
        raise ValueError(f"Area selects {len(stems)} tiles; the safety limit is {MAX_TILES_PER_RUN}")
    return stems
