"""Focused numeric checks for bounded Copernicus terrain-model extraction."""

from __future__ import annotations

import tempfile
import unittest
import math
import hashlib
from pathlib import Path

import numpy as np
from osgeo import gdal, osr

from app.terrain_model import COPERNICUS_SOURCE, TerrainModelError, extract_terrain_model


TEST_SOURCE_ELEVATION_SHA256 = "a" * 64
TEST_DERIVATIVE_VERSION = "horn-terrain-derivatives-2"


class TerrainModelTests(unittest.TestCase):
    width = 160
    height = 160
    origin_x = 500_000.0
    origin_y = 4_000_000.0
    resolution = 30.0

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="terrain-model-test-")
        self.path = Path(self.temp_dir.name) / "synthetic-elevation.tif"
        self.values = np.full((self.height, self.width), 123.5, dtype=np.float32)
        self._write_raster()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _write_raster(self, crs: str = "EPSG:32635") -> None:
        driver = gdal.GetDriverByName("GTiff")
        dataset = driver.Create(str(self.path), self.width, self.height, 1, gdal.GDT_Float32)
        self.assertIsNotNone(dataset)
        dataset.SetGeoTransform((self.origin_x, self.resolution, 0, self.origin_y, 0, -self.resolution))
        spatial_ref = osr.SpatialReference()
        self.assertEqual(spatial_ref.ImportFromEPSG(int(crs.split(":")[1])), 0)
        spatial_ref.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        dataset.SetProjection(spatial_ref.ExportToWkt())
        dataset.SetMetadataItem("COPERNICUS_SOURCE", COPERNICUS_SOURCE)
        dataset.SetMetadataItem("VERTICAL_DATUM", "EGM2008")
        band = dataset.GetRasterBand(1)
        band.SetNoDataValue(-9999)
        band.SetUnitType("m")
        band.SetDescription("Elevation in metres above EGM2008")
        band.WriteArray(self.values)
        band.FlushCache()
        dataset.FlushCache()
        dataset = None

    def _wgs84_point(self, column: float, row: float) -> list[float]:
        projected = osr.SpatialReference()
        geographic = osr.SpatialReference()
        projected.ImportFromEPSG(32635)
        geographic.ImportFromEPSG(4326)
        projected.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        geographic.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        transform = osr.CoordinateTransformation(projected, geographic)
        x = self.origin_x + column * self.resolution
        y = self.origin_y - row * self.resolution
        longitude, latitude, *_ = transform.TransformPoint(x, y)
        return [longitude, latitude]

    def _ring(self, bounds: tuple[float, float, float, float], clockwise: bool = True) -> list[list[float]]:
        left, top, right, bottom = bounds
        pixel_ring = [
            (left, top), (right, top), (right, bottom), (left, bottom), (left, top),
        ]
        if not clockwise:
            pixel_ring = list(reversed(pixel_ring))
        return [self._wgs84_point(column, row) for column, row in pixel_ring]

    def _polygon(
        self,
        bounds: tuple[float, float, float, float] = (50, 50, 56, 56),
        holes: list[tuple[float, float, float, float]] | None = None,
    ) -> dict:
        rings = [self._ring(bounds)]
        rings.extend(self._ring(hole, clockwise=False) for hole in holes or [])
        return {"type": "Polygon", "coordinates": rings}

    def _extract(self, geometry: dict | None = None, max_dimension: int = 128) -> dict:
        return extract_terrain_model(
            geometry or self._polygon(),
            self.path,
            max_dimension,
            analysis_id="0123456789abcdef",
            source=COPERNICUS_SOURCE,
            vertical_reference="EGM2008",
            expected_horizontal_crs="EPSG:32635",
        )

    def _write_derivative(
        self,
        label: str,
        values: np.ndarray,
        *,
        nodata: float | None = -9999.0,
        mask: np.ndarray | None = None,
        crs: str = "EPSG:32635",
        transform: tuple[float, ...] | None = None,
        unit: str | None = None,
        source_hash: str = TEST_SOURCE_ELEVATION_SHA256,
    ) -> Path:
        path = Path(self.temp_dir.name) / f"synthetic-{label}.tif"
        array = np.asarray(values, dtype=np.float32)
        dataset = gdal.GetDriverByName("GTiff").Create(str(path), self.width, self.height, 1, gdal.GDT_Float32)
        dataset.SetGeoTransform(transform or (self.origin_x, self.resolution, 0, self.origin_y, 0, -self.resolution))
        spatial_ref = osr.SpatialReference()
        self.assertEqual(spatial_ref.ImportFromEPSG(int(crs.split(":")[1])), 0)
        spatial_ref.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        dataset.SetProjection(spatial_ref.ExportToWkt())
        band = dataset.GetRasterBand(1)
        if nodata is not None:
            band.SetNoDataValue(nodata)
        band.SetUnitType(unit or ("percent" if label == "slope" else "degree"))
        product = "Slope in percent (Horn)" if label == "slope" else "Aspect azimuth in degrees from grid north (Horn)"
        band.SetDescription(product)
        band.WriteArray(array)
        dataset.SetMetadataItem("SOURCE_PRODUCT", COPERNICUS_SOURCE)
        dataset.SetMetadataItem("SOURCE_ELEVATION_SHA256", source_hash)
        dataset.SetMetadataItem("DERIVATIVE", product)
        dataset.SetMetadataItem("ALGORITHM", "Horn")
        dataset.SetMetadataItem("RESOLUTION_M", "30")
        dataset.SetMetadataItem("HORIZONTAL_CRS", crs)
        dataset.SetMetadataItem("HORIZONTAL_UNITS", "m")
        dataset.SetMetadataItem("VERTICAL_UNITS", "m")
        dataset.SetMetadataItem("VERTICAL_DATUM", "EGM2008")
        dataset.SetMetadataItem("DATA_ROLE", "numeric-analysis-data")
        dataset.SetMetadataItem("STYLE_VERSION", TEST_DERIVATIVE_VERSION)
        if nodata is not None:
            dataset.SetMetadataItem("NODATA", f"{nodata:g}")
        if label == "aspect":
            dataset.SetMetadataItem("NORTH_REFERENCE", "grid_north")
        if mask is not None:
            self.assertEqual(band.CreateMaskBand(gdal.GMF_PER_DATASET), 0)
            band.GetMaskBand().WriteArray(np.asarray(mask, dtype=np.uint8))
        band.FlushCache()
        dataset.FlushCache()
        dataset = None
        return path

    def _extract_with_derivatives(
        self,
        geometry: dict | None = None,
        max_dimension: int = 128,
        *,
        slope_values: np.ndarray | None = None,
        aspect_values: np.ndarray | None = None,
        slope_nodata: float | None = -9999.0,
        aspect_nodata: float | None = -9999.0,
        slope_mask: np.ndarray | None = None,
        aspect_mask: np.ndarray | None = None,
        slope_crs: str = "EPSG:32635",
        aspect_crs: str = "EPSG:32635",
        slope_transform: tuple[float, ...] | None = None,
        aspect_transform: tuple[float, ...] | None = None,
        slope_unit: str = "percent",
        aspect_unit: str = "degree",
    ) -> dict:
        slope_values = np.zeros((self.height, self.width), dtype=np.float32) if slope_values is None else slope_values
        aspect_values = np.zeros((self.height, self.width), dtype=np.float32) if aspect_values is None else aspect_values
        slope_path = self._write_derivative(
            "slope", slope_values, nodata=slope_nodata, mask=slope_mask,
            crs=slope_crs, transform=slope_transform, unit=slope_unit,
        )
        aspect_path = self._write_derivative(
            "aspect", aspect_values, nodata=aspect_nodata, mask=aspect_mask,
            crs=aspect_crs, transform=aspect_transform, unit=aspect_unit,
        )
        return extract_terrain_model(
            geometry or self._polygon(),
            self.path,
            max_dimension,
            analysis_id="0123456789abcdef",
            source=COPERNICUS_SOURCE,
            vertical_reference="EGM2008",
            expected_horizontal_crs="EPSG:32635",
            include_derivatives=True,
            slope_raster=slope_path,
            aspect_raster=aspect_path,
            derivative_source_elevation_sha256=TEST_SOURCE_ELEVATION_SHA256,
            derivative_style_version=TEST_DERIVATIVE_VERSION,
        )

    def _output_index_for_source_pixel(self, result: dict, row: int, column: int) -> tuple[int, int]:
        extent = result["extent_projected_m"]
        col_start = round((extent["west"] - self.origin_x) / self.resolution)
        row_start = round((self.origin_y - extent["north"]) / self.resolution)
        return row - row_start, column - col_start

    def test_flat_surface_has_known_elevation_and_native_grid(self) -> None:
        result = self._extract()
        self.assertEqual(result["coverage"]["availability"], "available")
        self.assertEqual(result["sampled_elevation_range_m"], {"minimum": 123.5, "maximum": 123.5})
        self.assertEqual(result["grid"]["sampling_method"], "native_pixel_centres")
        self.assertEqual(result["vertical_reference"], "EGM2008")

    def test_east_gradient_matches_native_sample_positions(self) -> None:
        self.values = np.tile(np.arange(self.width, dtype=np.float32), (self.height, 1)) * 1.5
        self._write_raster()
        result = self._extract()
        grid = result["grid"]
        origin = result["local_origin"]["projected_m"]
        first = grid["first_sample_local_m"]
        east = origin["east"] + first["east"]
        north = origin["north"] + first["north"]
        column = int((east - self.origin_x) // self.resolution)
        row = int((self.origin_y - north) // self.resolution)
        expected = float(self.values[row, column])
        self.assertAlmostEqual(grid["values_m"][0][0], expected, places=5)
        self.assertGreater(grid["values_m"][0][-1], grid["values_m"][0][0])

    def test_north_south_row_order_matches_raster_geotransform(self) -> None:
        self.values = np.repeat((300 - np.arange(self.height, dtype=np.float32) * 2)[:, None], self.width, axis=1)
        self._write_raster()
        values = self._extract()["grid"]["values_m"]
        self.assertEqual(self._extract()["grid"]["row_order"], "north_to_south")
        self.assertGreater(values[0][0], values[-1][0])

    def test_negative_and_zero_elevations_remain_valid(self) -> None:
        self.values.fill(-10)
        self.values[52, 52] = 0
        self._write_raster()
        result = self._extract()
        flattened = [value for row in result["grid"]["values_m"] for value in row if value is not None]
        self.assertIn(0.0, flattened)
        self.assertTrue(any(value < 0 for value in flattened))
        self.assertEqual(result["sampled_elevation_range_m"]["minimum"], -10.0)

    def test_nodata_is_null_and_marks_partial_coverage(self) -> None:
        self.values[48:55, 48:55] = -9999
        self._write_raster()
        result = self._extract()
        self.assertEqual(result["coverage"]["availability"], "partial")
        self.assertGreater(result["coverage"]["missing_samples"], 0)
        self.assertTrue(any(value is None for row in result["grid"]["values_m"] for value in row))

    def test_resampling_does_not_turn_nodata_into_elevation(self) -> None:
        self.values.fill(500)
        self.values[50:110, 50:110] = -9999
        self._write_raster()
        result = self._extract(self._polygon((5, 5, 155, 155)), max_dimension=16)
        values = result["grid"]["values_m"]
        self.assertEqual(result["grid"]["sampling_method"], "bilinear_at_cell_centres")
        self.assertEqual(result["coverage"]["availability"], "partial")
        self.assertTrue(any(value is None for row in values for value in row))
        self.assertTrue(all(value in (None, 500.0) for row in values for value in row))

    def test_no_valid_data_is_not_reported_as_zero(self) -> None:
        self.values.fill(-9999)
        self._write_raster()
        result = self._extract()
        self.assertEqual(result["coverage"]["availability"], "no_data")
        self.assertEqual(result["coverage"]["valid_samples"], 0)
        self.assertIsNone(result["sampled_elevation_range_m"])
        self.assertTrue(all(value is None for row in result["grid"]["values_m"] for value in row))

    def test_valid_samples_without_a_triangle_are_insufficient(self) -> None:
        self.values.fill(-9999)
        self.values[52, 52:54] = [42, 43]
        self._write_raster()
        result = self._extract()
        self.assertEqual(result["coverage"]["availability"], "insufficient_data")
        self.assertEqual(result["coverage"]["valid_samples"], 2)

    def test_polygon_hole_is_preserved_while_context_beneath_it_has_elevation(self) -> None:
        result = self._extract(self._polygon((40, 40, 80, 80), [(52, 52, 66, 66)]))
        geometry = result["geometry_local_m"]
        self.assertEqual(geometry["type"], "Polygon")
        self.assertEqual(len(geometry["coordinates"]), 2)
        self.assertEqual(result["coverage"]["availability"], "available")

    def test_multipolygon_components_are_both_preserved(self) -> None:
        multi = {
            "type": "MultiPolygon",
            "coordinates": [
                [self._ring((25, 25, 32, 32))],
                [self._ring((95, 95, 103, 103))],
            ],
        }
        geometry = self._extract(multi)["geometry_local_m"]
        self.assertEqual(geometry["type"], "MultiPolygon")
        self.assertEqual(len(geometry["coordinates"]), 2)

    def test_small_polygon_keeps_source_pixel_spacing(self) -> None:
        result = self._extract(self._polygon((70, 70, 71, 71)))
        self.assertEqual(result["grid"]["sampling_method"], "native_pixel_centres")
        self.assertGreaterEqual(result["grid"]["sample_spacing_m"]["east"], self.resolution)
        self.assertGreaterEqual(result["grid"]["sample_spacing_m"]["north"], self.resolution)

    def test_large_window_is_reduced_to_requested_dimensions(self) -> None:
        self.values = np.tile(np.arange(self.width, dtype=np.float32), (self.height, 1))
        self._write_raster()
        grid = self._extract(self._polygon((5, 5, 155, 155)), max_dimension=16)["grid"]
        self.assertLessEqual(grid["columns"], 16)
        self.assertLessEqual(grid["rows"], 16)
        self.assertEqual(grid["sampling_method"], "bilinear_at_cell_centres")
        self.assertGreaterEqual(grid["sample_spacing_m"]["east"], self.resolution)

    def test_geometry_at_raster_edge_keeps_polygon_and_reports_clipped_context(self) -> None:
        result = self._extract(self._polygon((0, 0, 5, 5)))
        extent = result["extent_projected_m"]
        geometry_coords = result["geometry_local_m"]["coordinates"][0]
        self.assertTrue(result["context"]["was_clipped_to_coverage"])
        self.assertGreaterEqual(min(point[0] for point in geometry_coords), 0)
        self.assertGreaterEqual(min(point[1] for point in geometry_coords), 0)
        self.assertGreater(extent["east"], extent["west"])

    def test_invalid_grid_limit_and_geographic_raster_crs_are_rejected(self) -> None:
        with self.assertRaises(TerrainModelError) as limit_error:
            self._extract(max_dimension=257)
        self.assertEqual(limit_error.exception.code, "invalid_grid_limit")
        missing_path = Path(self.temp_dir.name) / "missing.tif"
        with self.assertRaises(TerrainModelError) as missing_error:
            extract_terrain_model(
                self._polygon(), missing_path, 128,
                analysis_id="0123456789abcdef", source=COPERNICUS_SOURCE,
            )
        self.assertEqual(missing_error.exception.code, "terrain_data_unavailable")
        with self.assertRaises(TerrainModelError) as geometry_error:
            extract_terrain_model(
                {"type": "Polygon", "coordinates": []}, self.path, 128,
                analysis_id="0123456789abcdef", source=COPERNICUS_SOURCE,
            )
        self.assertEqual(geometry_error.exception.code, "invalid_geometry")
        self._write_raster(crs="EPSG:4326")
        with self.assertRaises(TerrainModelError) as crs_error:
            self._extract()
        self.assertEqual(crs_error.exception.code, "incompatible_terrain_crs")

    def test_api_10_shape_is_unchanged_and_11_response_validates_aligned_grids(self) -> None:
        from app.main import TerrainModelDerivativesResponse, TerrainModelResponse

        legacy = self._extract()
        self.assertEqual(legacy["schema_version"], "1.0")
        self.assertNotIn("derivatives", legacy)
        self.assertEqual(TerrainModelResponse.model_validate(legacy).schema_version, "1.0")
        extended = self._extract_with_derivatives()
        self.assertEqual(extended["schema_version"], "1.1")
        self.assertEqual(TerrainModelDerivativesResponse.model_validate(extended).schema_version, "1.1")
        self.assertNotIn("rows", extended["derivatives"])
        self.assertNotIn("columns", extended["derivatives"])

    def test_native_derivatives_share_exact_dimensions_positions_and_north_up_order(self) -> None:
        slopes = np.repeat(np.arange(self.height, dtype=np.float32)[:, None] * 2, self.width, axis=1)
        aspects = np.repeat(np.arange(self.width, dtype=np.float32)[None, :], self.height, axis=0)
        result = self._extract_with_derivatives(slope_values=slopes, aspect_values=aspects)
        grid = result["grid"]
        derivatives = result["derivatives"]
        self.assertEqual(derivatives["sampling_method"], "native_pixel_centres")
        for matrix in (derivatives["slope"]["values_percent"], derivatives["aspect"]["values_degrees"], derivatives["aspect"]["flat_mask"]):
            self.assertEqual(len(matrix), grid["rows"])
            self.assertTrue(all(len(row) == grid["columns"] for row in matrix))
        self.assertEqual(grid["row_order"], "north_to_south")
        self.assertEqual(grid["column_order"], "west_to_east")
        north_row, west_column = self._output_index_for_source_pixel(result, 50, 50)
        south_row, east_column = self._output_index_for_source_pixel(result, 55, 55)
        self.assertAlmostEqual(derivatives["slope"]["values_percent"][north_row][west_column], 100)
        self.assertAlmostEqual(derivatives["slope"]["values_percent"][south_row][west_column], 110)
        self.assertAlmostEqual(derivatives["aspect"]["values_degrees"][north_row][west_column], 50)
        self.assertAlmostEqual(derivatives["aspect"]["values_degrees"][north_row][east_column], 55)
        self.assertEqual(derivatives["target_grid"], "grid")

    def test_reduced_grid_uses_nearest_original_samples_and_preserves_explicit_mask(self) -> None:
        rows, columns = np.indices((self.height, self.width))
        slopes = (rows * 1000 + columns).astype(np.float32)
        aspects = np.where(columns % 2 == 0, 359.0, 1.0).astype(np.float32)
        mask = np.full((self.height, self.width), 255, dtype=np.uint8)
        mask[50:110, 50:110] = 0
        original_slopes = slopes.copy()
        original_aspects = aspects.copy()
        result = self._extract_with_derivatives(
            self._polygon((5, 5, 155, 155)),
            max_dimension=16,
            slope_values=slopes,
            aspect_values=aspects,
            slope_mask=mask,
        )
        grid = result["grid"]
        derivatives = result["derivatives"]
        self.assertEqual(grid["sampling_method"], "bilinear_at_cell_centres")
        self.assertEqual(derivatives["sampling_method"], "nearest_neighbor_at_common_cell_centres")
        self.assertTrue(any(value is None for row in derivatives["slope"]["values_percent"] for value in row))
        for target_row in range(grid["rows"]):
            northing = result["extent_projected_m"]["north"] - (target_row + 0.5) * grid["sample_spacing_m"]["north"]
            source_row = math.floor((self.origin_y - northing) / self.resolution)
            for target_column in range(grid["columns"]):
                easting = result["extent_projected_m"]["west"] + (target_column + 0.5) * grid["sample_spacing_m"]["east"]
                source_column = math.floor((easting - self.origin_x) / self.resolution)
                slope_value = derivatives["slope"]["values_percent"][target_row][target_column]
                aspect_value = derivatives["aspect"]["values_degrees"][target_row][target_column]
                if 0 <= source_row < self.height and 0 <= source_column < self.width:
                    if mask[source_row, source_column] == 0:
                        self.assertIsNone(slope_value)
                    else:
                        self.assertEqual(slope_value, float(original_slopes[source_row, source_column]))
                    self.assertEqual(aspect_value, float(original_aspects[source_row, source_column]))
        self.assertTrue(any(value in (1.0, 359.0) for row in derivatives["aspect"]["values_degrees"] for value in row if value is not None))
        self.assertFalse(any(value == 180.0 for row in derivatives["aspect"]["values_degrees"] for value in row if value is not None))

    def test_aspect_cardinal_values_zero_and_360_are_valid_north_grid_directions(self) -> None:
        slopes = np.full((self.height, self.width), 20, dtype=np.float32)
        aspects = np.resize(np.array([359, 0, 1, 90, 180, 270, 360], dtype=np.float32), (self.height, self.width))
        result = self._extract_with_derivatives(slope_values=slopes, aspect_values=aspects)
        directions = [value for row in result["derivatives"]["aspect"]["values_degrees"] for value in row if value is not None]
        self.assertEqual(result["derivatives"]["aspect"]["reference"], "grid_north")
        for direction in (0, 1, 90, 180, 270, 359, 360):
            self.assertIn(float(direction), directions)
        self.assertEqual(result["derivatives"]["aspect"]["coverage"]["flat_samples"], 0)

    def test_zero_and_over_100_percent_slopes_remain_valid_numeric_samples(self) -> None:
        slopes = np.full((self.height, self.width), 250.0, dtype=np.float32)
        slopes[50, 50] = 0
        aspects = np.full((self.height, self.width), 180.0, dtype=np.float32)
        result = self._extract_with_derivatives(slope_values=slopes, aspect_values=aspects)
        row, column = self._output_index_for_source_pixel(result, 50, 50)
        values = result["derivatives"]["slope"]["values_percent"]
        self.assertEqual(values[row][column], 0.0)
        self.assertEqual(values[row + 1][column + 1], 250.0)
        self.assertEqual(result["derivatives"]["slope"]["coverage"]["valid_samples"], result["grid"]["rows"] * result["grid"]["columns"])

    def test_flat_aspect_nodata_is_separate_from_north_and_other_missing_values(self) -> None:
        slopes = np.full((self.height, self.width), 0, dtype=np.float32)
        slopes[53, 53] = 12
        aspects = np.full((self.height, self.width), -9999, dtype=np.float32)
        aspects[52, 52] = 0
        result = self._extract_with_derivatives(slope_values=slopes, aspect_values=aspects)
        north_row, west_column = self._output_index_for_source_pixel(result, 52, 52)
        flat_row, flat_column = self._output_index_for_source_pixel(result, 52, 53)
        missing_row, missing_column = self._output_index_for_source_pixel(result, 53, 53)
        aspect = result["derivatives"]["aspect"]
        self.assertEqual(aspect["values_degrees"][north_row][west_column], 0.0)
        self.assertFalse(aspect["flat_mask"][north_row][west_column])
        self.assertTrue(aspect["flat_mask"][flat_row][flat_column])
        self.assertIsNone(aspect["values_degrees"][flat_row][flat_column])
        self.assertFalse(aspect["flat_mask"][missing_row][missing_column])
        self.assertIsNone(aspect["values_degrees"][missing_row][missing_column])
        self.assertEqual(aspect["coverage"]["flat_samples"], aspect["coverage"]["valid_samples"] - aspect["coverage"]["directional_samples"])

    def test_masks_are_independent_per_variable_and_elevation_is_not_dropped(self) -> None:
        slope_mask = np.full((self.height, self.width), 255, dtype=np.uint8)
        aspect_mask = np.full((self.height, self.width), 255, dtype=np.uint8)
        slope_mask[52, 52] = 0
        aspect_mask[53, 53] = 0
        slopes = np.full((self.height, self.width), 15, dtype=np.float32)
        aspects = np.full((self.height, self.width), 120, dtype=np.float32)
        slopes[53, 53] = 0
        result = self._extract_with_derivatives(
            slope_values=slopes,
            aspect_values=aspects,
            slope_nodata=None,
            aspect_nodata=None,
            slope_mask=slope_mask,
            aspect_mask=aspect_mask,
        )
        slope_row, slope_column = self._output_index_for_source_pixel(result, 52, 52)
        aspect_row, aspect_column = self._output_index_for_source_pixel(result, 53, 53)
        self.assertIsNotNone(result["grid"]["values_m"][slope_row][slope_column])
        self.assertIsNone(result["derivatives"]["slope"]["values_percent"][slope_row][slope_column])
        aspect = result["derivatives"]["aspect"]
        self.assertTrue(aspect["flat_mask"][aspect_row][aspect_column])
        self.assertIsNone(aspect["values_degrees"][aspect_row][aspect_column])
        self.assertLess(result["derivatives"]["slope"]["coverage"]["valid_with_elevation_samples"], result["derivatives"]["slope"]["coverage"]["total_samples"])

    def test_partial_and_completely_absent_derivative_coverage_are_distinguished(self) -> None:
        slopes = np.full((self.height, self.width), -9999, dtype=np.float32)
        aspects = np.full((self.height, self.width), -9999, dtype=np.float32)
        slopes[50:55, 50:55] = 35
        aspects[50:55, 50:55] = 270
        partial = self._extract_with_derivatives(slope_values=slopes, aspect_values=aspects)
        self.assertEqual(partial["derivatives"]["slope"]["coverage"]["availability"], "partial")
        self.assertEqual(partial["derivatives"]["aspect"]["coverage"]["availability"], "partial")
        self.assertEqual(partial["derivatives"]["slope"]["coverage"]["valid_samples"] + partial["derivatives"]["slope"]["coverage"]["missing_samples"], partial["grid"]["rows"] * partial["grid"]["columns"])
        slopes.fill(-9999)
        aspects.fill(-9999)
        absent = self._extract_with_derivatives(slope_values=slopes, aspect_values=aspects)
        self.assertEqual(absent["derivatives"]["slope"]["coverage"]["availability"], "no_data")
        self.assertEqual(absent["derivatives"]["aspect"]["coverage"]["availability"], "no_data")
        self.assertTrue(all(value is None for row in absent["derivatives"]["slope"]["values_percent"] for value in row))
        self.assertTrue(all(not is_flat for row in absent["derivatives"]["aspect"]["flat_mask"] for is_flat in row))

    def test_invalid_derivative_domain_is_not_coerced_to_zero_or_north(self) -> None:
        slopes = np.full((self.height, self.width), -2, dtype=np.float32)
        aspects = np.full((self.height, self.width), 361, dtype=np.float32)
        result = self._extract_with_derivatives(slope_values=slopes, aspect_values=aspects)
        derivatives = result["derivatives"]
        self.assertEqual(derivatives["slope"]["coverage"]["invalid_domain_samples"], derivatives["slope"]["coverage"]["total_samples"])
        self.assertEqual(derivatives["aspect"]["coverage"]["invalid_domain_samples"], derivatives["aspect"]["coverage"]["total_samples"])
        self.assertTrue(all(value is None for row in derivatives["slope"]["values_percent"] for value in row))
        self.assertTrue(all(value is None for row in derivatives["aspect"]["values_degrees"] for value in row))
        self.assertTrue(all(not is_flat for row in derivatives["aspect"]["flat_mask"] for is_flat in row))

    def test_derivative_source_metadata_grid_units_and_presence_are_validated(self) -> None:
        values = np.ones((self.height, self.width), dtype=np.float32)
        shifted = (self.origin_x + 0.5, self.resolution, 0, self.origin_y, 0, -self.resolution)
        with self.assertRaises(TerrainModelError) as grid_error:
            self._extract_with_derivatives(slope_values=values, slope_transform=shifted)
        self.assertEqual(grid_error.exception.code, "incompatible_derivative_grid")
        with self.assertRaises(TerrainModelError) as crs_error:
            self._extract_with_derivatives(slope_values=values, slope_crs="EPSG:32636")
        self.assertEqual(crs_error.exception.code, "incompatible_derivative_crs")
        with self.assertRaises(TerrainModelError) as unit_error:
            self._extract_with_derivatives(slope_values=values, slope_unit="degrees")
        self.assertEqual(unit_error.exception.code, "incompatible_derivative_units")
        with self.assertRaises(TerrainModelError) as missing_error:
            extract_terrain_model(
                self._polygon(), self.path, 128,
                analysis_id="0123456789abcdef", source=COPERNICUS_SOURCE,
                include_derivatives=True, slope_raster=None, aspect_raster="absent.tif",
            )
        self.assertEqual(missing_error.exception.code, "slope_raster_unavailable")
        slope_path = self._write_derivative("slope", values)
        with self.assertRaises(TerrainModelError) as missing_aspect_error:
            extract_terrain_model(
                self._polygon(), self.path, 128,
                analysis_id="0123456789abcdef", source=COPERNICUS_SOURCE,
                include_derivatives=True, slope_raster=slope_path, aspect_raster=None,
            )
        self.assertEqual(missing_aspect_error.exception.code, "aspect_raster_unavailable")

    def test_maximum_dimension_256_is_accepted_and_inputs_remain_unchanged(self) -> None:
        self.width = self.height = 320
        self.values = np.full((self.height, self.width), 123.5, dtype=np.float32)
        self._write_raster()
        slopes = np.full((self.height, self.width), 5, dtype=np.float32)
        aspects = np.full((self.height, self.width), 45, dtype=np.float32)
        slope_path = self._write_derivative("slope", slopes)
        aspect_path = self._write_derivative("aspect", aspects)
        before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (self.path, slope_path, aspect_path)]
        result = extract_terrain_model(
            self._polygon((5, 5, 315, 315)),
            self.path,
            256,
            analysis_id="0123456789abcdef",
            source=COPERNICUS_SOURCE,
            include_derivatives=True,
            slope_raster=slope_path,
            aspect_raster=aspect_path,
            derivative_source_elevation_sha256=TEST_SOURCE_ELEVATION_SHA256,
            derivative_style_version=TEST_DERIVATIVE_VERSION,
        )
        after = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (self.path, slope_path, aspect_path)]
        self.assertEqual(result["grid"]["columns"], 256)
        self.assertEqual(result["grid"]["rows"], 256)
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
