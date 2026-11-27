"""Stable cartographic classes for terrain derivatives.

Numeric GeoTIFFs remain the analysis source. These classes describe only their
QGIS rendering and the legends returned by the local API.
"""

DERIVATIVE_STYLE_VERSION = "horn-terrain-derivatives-2"

# QgsColorRampShader.Discrete chooses the first ramp item whose value is
# greater than or equal to the raster value. These values are therefore the
# inclusive upper bounds of the classes (the final slope class is open-ended).
SLOPE_SHADER_MAXIMUM = 1.0e30

SLOPE_BREAKS = (
    {"id": "slope-0-5", "upper_bound": 5.0, "shader_value": 5.0, "color": "#4f9f83", "label": "0–5 %"},
    {"id": "slope-5-15", "upper_bound": 15.0, "shader_value": 15.0, "color": "#a8c96f", "label": ">5–15 %"},
    {"id": "slope-15-30", "upper_bound": 30.0, "shader_value": 30.0, "color": "#f0df73", "label": ">15–30 %"},
    {"id": "slope-30-60", "upper_bound": 60.0, "shader_value": 60.0, "color": "#ed9c58", "label": ">30–60 %"},
    {"id": "slope-over-60", "upper_bound": None, "shader_value": SLOPE_SHADER_MAXIMUM, "color": "#c84a43", "label": ">60 %"},
)

ASPECT_FLAT_DISPLAY_VALUE = -1.0
ASPECT_NODATA = -9999.0
ASPECT_SHADER_ITEMS = (
    {"value": ASPECT_FLAT_DISPLAY_VALUE, "color": "#c9c9c4", "label": "Plana / sin orientación"},
    {"value": 22.5, "color": "#f2d34f", "label": "Norte · 0°–22,5°"},
    {"value": 67.5, "color": "#9bc85b", "label": "Noreste · >22,5°–67,5°"},
    {"value": 112.5, "color": "#48a88e", "label": "Este · >67,5°–112,5°"},
    {"value": 157.5, "color": "#4b9dc5", "label": "Sureste · >112,5°–157,5°"},
    {"value": 202.5, "color": "#526dba", "label": "Sur · >157,5°–202,5°"},
    {"value": 247.5, "color": "#8567b8", "label": "Suroeste · >202,5°–247,5°"},
    {"value": 292.5, "color": "#c06b9b", "label": "Oeste · >247,5°–292,5°"},
    {"value": 337.5, "color": "#e18759", "label": "Noroeste · >292,5°–337,5°"},
    {"value": 360.0, "color": "#f2d34f", "label": "Norte · >337,5°–360°"},
)

ASPECT_LEGEND = (
    {"id": "aspect-n", "direction": "N", "label": "Norte · 0°–22,5° y >337,5°–360°", "color": "#f2d34f"},
    {"id": "aspect-ne", "direction": "NE", "label": "Noreste · >22,5°–67,5°", "color": "#9bc85b"},
    {"id": "aspect-e", "direction": "E", "label": "Este · >67,5°–112,5°", "color": "#48a88e"},
    {"id": "aspect-se", "direction": "SE", "label": "Sureste · >112,5°–157,5°", "color": "#4b9dc5"},
    {"id": "aspect-s", "direction": "S", "label": "Sur · >157,5°–202,5°", "color": "#526dba"},
    {"id": "aspect-so", "direction": "SO", "label": "Suroeste · >202,5°–247,5°", "color": "#8567b8"},
    {"id": "aspect-o", "direction": "O", "label": "Oeste · >247,5°–292,5°", "color": "#c06b9b"},
    {"id": "aspect-no", "direction": "NO", "label": "Noroeste · >292,5°–337,5°", "color": "#e18759"},
    {"id": "aspect-flat", "direction": "—", "label": "Plana / sin orientación", "color": "#c9c9c4"},
)


def discrete_upper_bound_color(value: float, items: tuple[dict, ...]) -> str | None:
    """Mirror QGIS's discrete shader lookup for synthetic boundary checks."""
    for item in items:
        if value <= item["value"]:
            return item["color"]
    return None


def slope_color_for_value(value: float) -> str | None:
    shader_items = tuple(
        {"value": item["shader_value"], "color": item["color"]}
        for item in SLOPE_BREAKS
    )
    return discrete_upper_bound_color(value, shader_items)


def aspect_color_for_value(value: float) -> str | None:
    if value == ASPECT_FLAT_DISPLAY_VALUE:
        return ASPECT_SHADER_ITEMS[0]["color"]
    if not 0.0 <= value <= 360.0:
        return None
    return discrete_upper_bound_color(value, ASPECT_SHADER_ITEMS[1:])


def derivative_metadata(
    *,
    area_name: str,
    horizontal_crs: str,
    resolution_m: int,
    nodata: float,
    slope_min: float,
    slope_max: float,
    aspect_min: float | None,
    aspect_max: float | None,
    source_elevation_sha256: str,
    reused: bool,
    storage_bytes: int,
) -> dict:
    """Return API metadata alongside the original numeric products."""
    return {
        "version": DERIVATIVE_STYLE_VERSION,
        "area_name": area_name,
        "source": "Copernicus DEM GLO-30 Public",
        "resolution_m": resolution_m,
        "horizontal_crs": horizontal_crs,
        "horizontal_units": "m",
        "vertical_units": "m",
        "algorithm": "Horn",
        "source_elevation_sha256": source_elevation_sha256,
        "nodata": nodata,
        "storage_bytes": storage_bytes,
        "reused": reused,
        "slope": {
            "unit": "percent",
            "minimum": slope_min,
            "maximum": slope_max,
            "wms_layer": "terrain_slope",
            "raster_kind": "numeric-analysis-data",
            "legend": [
                {key: item[key] for key in ("id", "upper_bound", "color", "label")}
                for item in SLOPE_BREAKS
            ],
        },
        "aspect": {
            "unit": "degrees",
            "minimum": aspect_min,
            "maximum": aspect_max,
            "wms_layer": "terrain_aspect",
            "north_reference": "grid_north",
            "north_reference_label": "Norte de cuadrícula del CRS proyectado",
            "flat_policy": "GDAL aspect remains NoData (-9999); a separate display raster uses -1 for flat cells.",
            "display_flat_value": ASPECT_FLAT_DISPLAY_VALUE,
            "raw_raster_nodata": ASPECT_NODATA,
            "raster_kind": "numeric-analysis-data",
            "legend": list(ASPECT_LEGEND),
        },
    }
