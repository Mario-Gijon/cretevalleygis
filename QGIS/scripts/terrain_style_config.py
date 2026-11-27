"""Pure data and calculations for regional terrain colour scales.

This module is shared by PyQGIS and FastAPI so the legend metadata is derived
from the exact values QGIS uses for the renderer.
"""

from __future__ import annotations

import math


REGIONAL_ELEVATION_STYLE_VERSION = "regional-adaptive-1"
REGIONAL_ELEVATION_PALETTE = (
    (0.0, "#315f43"),
    (0.18, "#66884d"),
    (0.35, "#a0ae68"),
    (0.52, "#d1c37e"),
    (0.68, "#bd895f"),
    (0.82, "#8e7462"),
    (0.93, "#b8b8b0"),
    (1.0, "#f5f2e9"),
)
MIN_REGIONAL_DISPLAY_RANGE_M = 400.0


def regional_elevation_style(minimum_m: float, maximum_m: float) -> dict:
    """Return QGIS renderer bounds and exact continuous ramp stops.

    Ranges under 400 m receive neutral padding around the observed values. This
    avoids stretching minor height changes across the full palette while still
    keeping all observed elevations inside the ramp.
    """
    minimum = float(minimum_m)
    maximum = float(maximum_m)
    if not math.isfinite(minimum) or not math.isfinite(maximum) or maximum < minimum:
        raise ValueError("regional elevation statistics must be finite and ordered")

    data_range = maximum - minimum
    display_padding = max(0.0, (MIN_REGIONAL_DISPLAY_RANGE_M - data_range) / 2)
    display_minimum = minimum - display_padding
    display_maximum = maximum + display_padding
    display_range = display_maximum - display_minimum
    if display_range <= 0:
        # A perfectly flat area still gets a stable, non-exaggerated scale.
        display_minimum = minimum - MIN_REGIONAL_DISPLAY_RANGE_M / 2
        display_maximum = maximum + MIN_REGIONAL_DISPLAY_RANGE_M / 2
        display_range = MIN_REGIONAL_DISPLAY_RANGE_M

    stops = [
        {
            "position": position,
            "value_m": display_minimum + display_range * position,
            "color": color,
        }
        for position, color in REGIONAL_ELEVATION_PALETTE
    ]
    return {
        "version": REGIONAL_ELEVATION_STYLE_VERSION,
        "interpolation": "linear-rgb",
        "unit": "m",
        "data_min_m": minimum,
        "data_max_m": maximum,
        "min_m": display_minimum,
        "max_m": display_maximum,
        "stops": stops,
    }
