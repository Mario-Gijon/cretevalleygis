"""Focused numeric checks for bounded Copernicus terrain-model extraction."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
from osgeo import gdal, osr

from app.terrain_model import COPERNICUS_SOURCE, TerrainModelError, extract_terrain_model


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


if __name__ == "__main__":
    unittest.main()
