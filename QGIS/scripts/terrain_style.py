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


def style_elevation(layer: QgsRasterLayer) -> None:
    items = [
        QgsColorRampShader.ColorRampItem(value, QColor(color), f"{value:g} m")
        for value, color in ELEVATION_COLOR_STOPS
    ]
    color_shader = QgsColorRampShader(ELEVATION_STYLE_MIN, ELEVATION_STYLE_MAX)
    color_shader.setColorRampType(QgsColorRampShader.Interpolated)
    color_shader.setColorRampItemList(items)
    raster_shader = QgsRasterShader(ELEVATION_STYLE_MIN, ELEVATION_STYLE_MAX)
    raster_shader.setRasterShaderFunction(color_shader)
    layer.setRenderer(QgsSingleBandPseudoColorRenderer(layer.dataProvider(), 1, raster_shader))
    set_visual_resampling(layer)


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
