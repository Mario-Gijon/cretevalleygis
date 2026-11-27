"""Shared terrain symbology used by both global and detailed rasters."""

from qgis.core import (
    QgsColorRampShader,
    QgsBilinearRasterResampler,
    QgsContrastEnhancement,
    Qgis,
    QgsRasterLayer,
    QgsRasterShader,
    QgsSingleBandGrayRenderer,
    QgsSingleBandPseudoColorRenderer,
)
from qgis.PyQt.QtGui import QColor
from terrain_derivative_config import ASPECT_SHADER_ITEMS, SLOPE_BREAKS, SLOPE_SHADER_MAXIMUM
from terrain_style_config import regional_elevation_style


# Keep the same absolute value-to-colour mapping at both resolutions.
ELEVATION_STYLE_MIN = -11_000.0
ELEVATION_STYLE_MAX = 9_000.0
ELEVATION_COLOR_STOPS = (
    (-11_000.0, "#092e53"),
    (-8_000.0, "#145d8b"),
    (-4_000.0, "#3d91af"),
    (-2_000.0, "#8dc4ca"),
    (0.0, "#e2e9d4"),
    (500.0, "#b6cb8a"),
    (1_500.0, "#78a568"),
    (2_500.0, "#c6b47a"),
    (4_000.0, "#a77a5a"),
    (6_000.0, "#d0c9bd"),
    (9_000.0, "#f5f3ea"),
)


def set_visual_resampling(layer: QgsRasterLayer) -> None:
    """Smooth rendered pixels only; the source GeoTIFF values remain unchanged."""
    resample_filter = layer.resampleFilter()
    if resample_filter is None:
        raise RuntimeError(f"QGIS has no raster resampling filter for {layer.name()}")
    resample_filter.setZoomedInResampler(QgsBilinearRasterResampler())
    resample_filter.setZoomedOutResampler(QgsBilinearRasterResampler())
    layer.setResamplingStage(Qgis.RasterResamplingStage.ResampleFilter)


def style_elevation(
    layer: QgsRasterLayer,
    minimum_m: float | None = None,
    maximum_m: float | None = None,
) -> dict | None:
    """Use the fixed world ramp by default, or an adaptive regional ramp."""
    regional_style = None
    if minimum_m is None or maximum_m is None:
        display_minimum = ELEVATION_STYLE_MIN
        display_maximum = ELEVATION_STYLE_MAX
        stops = [
            {"value_m": value, "color": color}
            for value, color in ELEVATION_COLOR_STOPS
        ]
    else:
        regional_style = regional_elevation_style(minimum_m, maximum_m)
        display_minimum = regional_style["min_m"]
        display_maximum = regional_style["max_m"]
        stops = regional_style["stops"]

    items = [
        QgsColorRampShader.ColorRampItem(
            stop["value_m"],
            QColor(stop["color"]),
            f"{stop['value_m']:g} m",
        )
        for stop in stops
    ]
    color_shader = QgsColorRampShader(display_minimum, display_maximum)
    color_shader.setColorRampType(QgsColorRampShader.Interpolated)
    color_shader.setColorRampItemList(items)
    raster_shader = QgsRasterShader(display_minimum, display_maximum)
    raster_shader.setRasterShaderFunction(color_shader)
    layer.setRenderer(QgsSingleBandPseudoColorRenderer(layer.dataProvider(), 1, raster_shader))
    set_visual_resampling(layer)
    return regional_style


def style_hillshade(layer: QgsRasterLayer) -> None:
    provider = layer.dataProvider()
    renderer = QgsSingleBandGrayRenderer(provider, 1)
    enhancement = QgsContrastEnhancement(provider.dataType(1))
    enhancement.setContrastEnhancementAlgorithm(QgsContrastEnhancement.StretchToMinimumMaximum)
    enhancement.setMinimumValue(1)
    enhancement.setMaximumValue(255)
    renderer.setContrastEnhancement(enhancement)
    layer.setRenderer(renderer)
    set_visual_resampling(layer)


def style_slope(layer: QgsRasterLayer) -> None:
    """Render slope using inclusive upper bounds matching the displayed legend."""
    items = [
        QgsColorRampShader.ColorRampItem(
            entry["shader_value"], QColor(entry["color"]), entry["label"]
        )
        for entry in SLOPE_BREAKS
    ]
    color_shader = QgsColorRampShader(0.0, SLOPE_SHADER_MAXIMUM)
    color_shader.setColorRampType(QgsColorRampShader.Discrete)
    color_shader.setColorRampItemList(items)
    raster_shader = QgsRasterShader(0.0, SLOPE_SHADER_MAXIMUM)
    raster_shader.setRasterShaderFunction(color_shader)
    layer.setRenderer(QgsSingleBandPseudoColorRenderer(layer.dataProvider(), 1, raster_shader))
    # Keep the provider's nearest-neighbour sampling: bilinear resampling before
    # classification can move pixels across a displayed class boundary.


def style_aspect(layer: QgsRasterLayer) -> None:
    """Render direction bins using inclusive upper bounds and a wrapped north."""
    items = [
        QgsColorRampShader.ColorRampItem(
            entry["value"], QColor(entry["color"]), entry["label"]
        )
        for entry in ASPECT_SHADER_ITEMS
    ]
    color_shader = QgsColorRampShader(-1.0, 360.0)
    color_shader.setColorRampType(QgsColorRampShader.Discrete)
    color_shader.setColorRampItemList(items)
    raster_shader = QgsRasterShader(-1.0, 360.0)
    raster_shader.setRasterShaderFunction(color_shader)
    layer.setRenderer(QgsSingleBandPseudoColorRenderer(layer.dataProvider(), 1, raster_shader))
    # Leave QGIS at its native nearest-neighbour resampling so direction
    # categories and the flat sentinel never blend into other colours.
