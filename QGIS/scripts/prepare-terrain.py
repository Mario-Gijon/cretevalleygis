#!/usr/bin/python3
"""Prepare a small Copernicus GLO-30 terrain area for the existing QGIS WMS.

Original COG tiles and derived rasters live in separate persistent-volume
directories. Use --bbox and --name to prepare another small area later.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
import urllib.request

import numpy as np
from osgeo import gdal
from qgis.core import (
    Qgis,
    QgsApplication,
    QgsCoordinateReferenceSystem,
    QgsProject,
    QgsRasterLayer,
)
from terrain_style import style_elevation as apply_shared_elevation_style
from terrain_style import style_aspect as apply_shared_aspect_style
from terrain_style import style_hillshade as apply_shared_hillshade_style
from terrain_style import style_slope as apply_shared_slope_style
from terrain_derivative_config import (
    ASPECT_FLAT_DISPLAY_VALUE,
    ASPECT_NODATA,
    DERIVATIVE_STYLE_VERSION,
    derivative_metadata,
)
from terrain_request import local_metric_crs, parse_bbox_text, selected_tiles


DATA_ROOT = Path("/io/data/terrain")
SOURCE_ROOT = DATA_ROOT / "source"
SOURCE_TILES = SOURCE_ROOT / "tiles"
DERIVED_ROOT = DATA_ROOT / "derived"
SOURCE_MANIFEST = DATA_ROOT / "source-manifest.json"
DERIVED_MANIFEST = DATA_ROOT / "derived-manifest.json"
WORLD_PROJECT_PATH = Path("/io/data/world/world.qgs")
PROJECT_PATH = Path(os.environ.get("TERRAIN_PROJECT_PATH", WORLD_PROJECT_PATH))
NATURAL_EARTH_DATA = Path("/io/data/world/data")
S3_ROOT = "https://copernicus-dem-30m.s3.amazonaws.com"
PRODUCT = "Copernicus DEM GLO-30 Public"
SOURCE_NODATA = -9999.0
RASTER_CREATION_OPTIONS = ["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=3", "BIGTIFF=IF_SAFER"]
HILLSHADE_CREATION_OPTIONS = ["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=2", "BIGTIFF=IF_SAFER"]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_manifest(path: Path) -> dict:
    if not path.exists():
        return {"format": 1, "tiles": {}}
    try:
        manifest = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot read terrain manifest {path}: {error}") from error
    if manifest.get("format") != 1 or not isinstance(manifest.get("tiles"), dict):
        raise RuntimeError(f"Unsupported terrain manifest: {path}")
    return manifest


def write_manifest(path: Path, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    os.replace(temp_path, path)


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    try:
        return parse_bbox_text(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--derive-slope-aspect",
        action="store_true",
        help="derive slope and aspect from an existing regional elevation raster without downloading data",
    )
    parser.add_argument(
        "--bbox",
        default=os.environ.get("TERRAIN_BBOX"),
        help="WGS84 extent west,south,east,north (or TERRAIN_BBOX)",
    )
    parser.add_argument(
        "--name",
        default=os.environ.get("TERRAIN_AREA_NAME", "Terrain area"),
        help="human-readable name for this terrain coverage",
    )
    parser.add_argument(
        "--project-path",
        default=os.environ.get("TERRAIN_PROJECT_PATH", str(WORLD_PROJECT_PATH)),
        help="QGIS project to update (use a separate path to keep the world project unchanged)",
    )
    parser.add_argument(
        "--elevation-path",
        help="existing regional elevation GeoTIFF (required by --derive-slope-aspect)",
    )
    parser.add_argument(
        "--horizontal-crs",
        help="projected CRS of the existing elevation raster (for example EPSG:32635)",
    )
    args = parser.parse_args()
    if not args.bbox and not args.derive_slope_aspect:
        parser.error("--bbox or TERRAIN_BBOX is required")
    if args.bbox:
        args.bbox = parse_bbox(args.bbox)
    args.name = args.name.strip()
    if not args.name:
        parser.error("--name cannot be empty")
    args.project_path = Path(args.project_path)
    if not args.project_path.is_absolute():
        parser.error("--project-path must be absolute")
    if args.derive_slope_aspect:
        if not args.elevation_path:
            parser.error("--elevation-path is required by --derive-slope-aspect")
        args.elevation_path = Path(args.elevation_path)
        if not args.elevation_path.is_absolute():
            parser.error("--elevation-path must be absolute")
        if not args.horizontal_crs:
            parser.error("--horizontal-crs is required by --derive-slope-aspect")
        if not args.bbox:
            parser.error("--bbox is required by --derive-slope-aspect")
    elif args.elevation_path or args.horizontal_crs:
        parser.error("--elevation-path and --horizontal-crs require --derive-slope-aspect")
    return args


def validate_cog(path: Path) -> tuple[float | None, list[int]]:
    dataset = gdal.Open(str(path), gdal.GA_ReadOnly)
    if dataset is None:
        raise ValueError(f"GDAL cannot open source tile: {path}")
    if dataset.RasterCount != 1 or dataset.RasterXSize < 300 or dataset.RasterYSize < 300:
        raise ValueError(f"Unexpected dimensions or band count in source tile: {path}")
    band = dataset.GetRasterBand(1)
    if band.DataType != gdal.GDT_Float32:
        raise ValueError(f"Expected a 32-bit float Copernicus DEM tile: {path}")
    spatial_ref = dataset.GetSpatialRef()
    # These public COGs are EPSG:4326, but their WKT axis-order metadata can
    # differ from canonical EPSG WKT and make IsSame overly strict.
    if not spatial_ref or spatial_ref.GetAuthorityCode(None) != "4326":
        raise ValueError(f"Expected a WGS84 (EPSG:4326) source tile: {path}")
    transform = dataset.GetGeoTransform()
    if transform[1] <= 0 or transform[5] >= 0:
        raise ValueError(f"Unexpected north-up pixel grid in source tile: {path}")
    nodata = band.GetNoDataValue()
    overviews = [band.GetOverview(index).XSize for index in range(band.GetOverviewCount())]
    dataset = None
    return nodata, overviews


def download_or_reuse_tile(stem: str, manifest: dict) -> tuple[Path, dict, int]:
    url = f"{S3_ROOT}/{stem}/{stem}.tif"
    target = SOURCE_TILES / f"{stem}.tif"
    previous = manifest["tiles"].get(stem, {})
    if target.is_file():
        try:
            digest = sha256_file(target)
            if previous.get("sha256") in (None, digest):
                nodata, overviews = validate_cog(target)
                record = {
                    "url": url,
                    "sha256": digest,
                    "bytes": target.stat().st_size,
                    "etag": previous.get("etag"),
                    "nodata": nodata,
                    "overview_widths": overviews,
                }
                print(f"Reusing original Copernicus tile: {stem}", flush=True)
                return target, record, 0
        except (OSError, ValueError) as error:
            print(f"Cached Copernicus tile failed integrity checks; fetching a fresh copy: {error}", flush=True)

    SOURCE_TILES.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{stem}-", suffix=".partial", dir=SOURCE_TILES)
    temp_path = Path(temp_name)
    received = 0
    etag = None
    request = urllib.request.Request(url, headers={"User-Agent": "CreteValleyGIS/0.2 (local terrain preparation)"})
    try:
        with os.fdopen(descriptor, "wb") as output, urllib.request.urlopen(request, timeout=180) as response:
            etag = response.headers.get("ETag", "").strip('"') or None
            expected_bytes = int(response.headers.get("Content-Length", "0"))
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                received += len(chunk)
        if expected_bytes and received != expected_bytes:
            raise IOError(f"Incomplete Copernicus tile download: expected {expected_bytes}, got {received} bytes")
        nodata, overviews = validate_cog(temp_path)
        digest = sha256_file(temp_path)
        os.replace(temp_path, target)
        record = {
            "url": url,
            "sha256": digest,
            "etag": etag,
            "bytes": received,
            "nodata": nodata,
            "overview_widths": overviews,
            "downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        print(f"Downloaded and checked Copernicus tile {stem}: {received} bytes, SHA-256 {digest}", flush=True)
        return target, record, received
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def area_slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")
    return slug[:48] or "terrain-area"


def write_cutline(bbox: tuple[float, float, float, float], path: Path) -> None:
    west, south, east, north = bbox
    ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
    feature_collection = {
        "type": "FeatureCollection",
        "name": "terrain_bbox",
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [ring]}}],
    }
    path.write_text(json.dumps(feature_collection))


def valid_raster(path: Path, *, min_width: int = 2) -> bool:
    dataset = gdal.Open(str(path), gdal.GA_ReadOnly) if path.is_file() else None
    if not dataset:
        return False
    valid = dataset.RasterCount == 1 and dataset.RasterXSize >= min_width and dataset.RasterYSize >= min_width
    dataset = None
    return valid


def raster_stats(path: Path) -> tuple[float, float]:
    dataset = gdal.Open(str(path), gdal.GA_ReadOnly)
    if not dataset:
        raise RuntimeError(f"Cannot open derived elevation: {path}")
    band = dataset.GetRasterBand(1)
    band.ComputeStatistics(False)
    minimum, maximum, _, _ = band.GetStatistics(False, True)
    if not math.isfinite(minimum) or not math.isfinite(maximum):
        raise RuntimeError(f"Elevation statistics are not finite for {path}")
    dataset = None
    return minimum, maximum


def natural_earth_land_10m() -> Path:
    matches = sorted((NATURAL_EARTH_DATA / "land_10").glob("*/ne_10m_land.shp"))
    if not matches:
        raise RuntimeError("Natural Earth 1:10m land data is missing; terrain cannot mask ocean NoData safely")
    return matches[0]


def mask_ocean_as_nodata(elevation_path: Path, source_mosaic: Path, mask_path: Path) -> None:
    """Mask zero-filled sea from the public COG while preserving 0 m land."""
    elevation = gdal.Open(str(elevation_path), gdal.GA_Update)
    if not elevation:
        raise RuntimeError(f"Cannot open clipped elevation for NoData masking: {elevation_path}")
    source = gdal.Open(str(source_mosaic), gdal.GA_ReadOnly)
    source_transform = source.GetGeoTransform()
    source_width, source_height = source.RasterXSize, source.RasterYSize
    source_bounds = [source_transform[0], source_transform[3] + source_height * source_transform[5],
                     source_transform[0] + source_width * source_transform[1], source_transform[3]]
    source_land_mask = mask_path.with_name("land-mask-wgs84.tif")
    geographic_mask = gdal.Rasterize(
        str(source_land_mask), str(natural_earth_land_10m()),
        options=gdal.RasterizeOptions(
            format="GTiff",
            outputBounds=source_bounds,
            outputSRS=source.GetProjection(),
            width=source_width,
            height=source_height,
            outputType=gdal.GDT_Byte,
            burnValues=[1],
            initValues=[0],
            creationOptions=["TILED=YES", "COMPRESS=DEFLATE"],
        ),
    )
    source = None
    if geographic_mask is None:
        raise RuntimeError("Could not rasterize the land polygons on the source grid")
    geographic_mask = None
    transform = elevation.GetGeoTransform()
    width, height = elevation.RasterXSize, elevation.RasterYSize
    bounds = [transform[0], transform[3] + height * transform[5],
              transform[0] + width * transform[1], transform[3]]
    mask = gdal.Warp(
        str(mask_path), str(source_land_mask),
        options=gdal.WarpOptions(
            format="GTiff",
            dstSRS=elevation.GetProjection(),
            outputBounds=bounds,
            width=width,
            height=height,
            resampleAlg="near",
            dstNodata=0,
            creationOptions=["TILED=YES", "COMPRESS=DEFLATE"],
        ),
    )
    source_land_mask.unlink(missing_ok=True)
    if mask is None or mask.RasterXSize != width or mask.RasterYSize != height:
        raise RuntimeError("Could not warp the land mask onto the terrain grid")
    dem_band = elevation.GetRasterBand(1)
    mask_band = mask.GetRasterBand(1)
    for y in range(0, height, 512):
        rows = min(512, height - y)
        values = dem_band.ReadAsArray(0, y, width, rows)
        land = mask_band.ReadAsArray(0, y, width, rows) != 0
        nodata = dem_band.GetNoDataValue()
        invalid = ~land
        if nodata is not None:
            invalid |= values == nodata
        values[invalid] = SOURCE_NODATA
        dem_band.WriteArray(values, 0, y)
    dem_band.SetNoDataValue(SOURCE_NODATA)
    dem_band.SetUnitType("m")
    dem_band.SetDescription("Elevation in metres above EGM2008")
    elevation.FlushCache()
    mask = None
    elevation = None


def build_derived(
    source_paths: list[Path],
    source_sha256: str,
    area_name: str,
    bbox: tuple[float, float, float, float],
) -> tuple[Path, Path, dict]:
    slug = area_slug(area_name)
    bbox_text = ",".join(f"{value:.8f}" for value in bbox)
    dst_crs = local_metric_crs(bbox)
    signature = hashlib.sha256(f"{source_sha256}|{bbox_text}|{dst_crs}|30m-v1".encode()).hexdigest()[:16]
    area_dir = DERIVED_ROOT / slug
    version_dir = area_dir / signature
    elevation_path = version_dir / "elevation.tif"
    hillshade_path = version_dir / "hillshade.tif"
    manifest = read_manifest(DERIVED_MANIFEST)
    entry = manifest["tiles"].get(f"{slug}:{signature}", {})
    if (
        entry.get("source_sha256") == source_sha256
        and valid_raster(elevation_path)
        and valid_raster(hillshade_path)
        and entry.get("elevation_sha256") == sha256_file(elevation_path)
        and entry.get("hillshade_sha256") == sha256_file(hillshade_path)
    ):
        print(f"Reusing valid terrain derivatives for {area_name}.", flush=True)
        # Earlier runs may leave this temporary mask inside the version folder.
        (version_dir / "land-mask.tif").unlink(missing_ok=True)
        (version_dir / "clip.geojson").unlink(missing_ok=True)
        minimum, maximum = raster_stats(elevation_path)
        return elevation_path, hillshade_path, {
            **entry,
            "area_name": area_name,
            "bbox_wgs84": list(bbox),
            "crs": dst_crs,
            "elevation_min_m": minimum,
            "elevation_max_m": maximum,
        }

    area_dir.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=f".{signature}-", dir=area_dir))
    cutline_path = staging_dir / "clip.geojson"
    temp_elevation = staging_dir / "elevation.tif"
    temp_hillshade = staging_dir / "hillshade.tif"
    temp_land_mask = staging_dir / "land-mask.tif"
    write_cutline(bbox, cutline_path)
    source_dataset = gdal.Open(str(source_paths[0]), gdal.GA_ReadOnly)
    if not source_dataset:
        raise RuntimeError(f"Cannot open original Copernicus tile: {source_paths[0]}")
    input_nodata = source_dataset.GetRasterBand(1).GetNoDataValue()
    source_dataset = None
    warp_options = {
        "format": "GTiff",
        "dstSRS": dst_crs,
        "cutlineDSName": str(cutline_path),
        "cropToCutline": True,
        "xRes": 30,
        "yRes": 30,
        "resampleAlg": "bilinear",
        "dstNodata": SOURCE_NODATA,
        "creationOptions": RASTER_CREATION_OPTIONS,
        "multithread": False,
    }
    if input_nodata is not None:
        warp_options["srcNodata"] = input_nodata
    try:
        elevation = gdal.Warp(
            str(temp_elevation), [str(path) for path in source_paths], options=gdal.WarpOptions(**warp_options)
        )
        if elevation is None or elevation.RasterCount != 1 or elevation.RasterXSize < 2 or elevation.RasterYSize < 2:
            raise RuntimeError("GDAL could not clip a valid terrain patch from the selected source tiles")
        band = elevation.GetRasterBand(1)
        band.SetNoDataValue(SOURCE_NODATA)
        band.SetUnitType("m")
        band.SetDescription("Elevation in metres above EGM2008")
        elevation.SetMetadataItem("AREA_OR_POINT", "Point")
        elevation.SetMetadataItem("COPERNICUS_SOURCE", PRODUCT)
        elevation = None
        source_mosaic = staging_dir / "source-mosaic.vrt"
        mosaic = gdal.BuildVRT(str(source_mosaic), [str(path) for path in source_paths])
        if mosaic is None:
            raise RuntimeError("Could not build a virtual mosaic of selected Copernicus source tiles")
        mosaic = None
        mask_ocean_as_nodata(temp_elevation, source_mosaic, temp_land_mask)
        source_mosaic.unlink(missing_ok=True)
        elevation = gdal.Open(str(temp_elevation), gdal.GA_Update)
        elevation.BuildOverviews("AVERAGE", [2, 4, 8, 16])
        elevation.FlushCache()
        elevation = None

        hillshade_options = gdal.DEMProcessingOptions(
            format="GTiff",
            creationOptions=HILLSHADE_CREATION_OPTIONS,
            computeEdges=True,
            zFactor=1.0,
            scale=1.0,
            altitude=45,
            multiDirectional=True,
        )
        hillshade = gdal.DEMProcessing(str(temp_hillshade), str(temp_elevation), "hillshade", options=hillshade_options)
        if hillshade is None or hillshade.RasterCount != 1:
            raise RuntimeError(f"GDAL could not derive hillshade from {temp_elevation}")
        hillshade.GetRasterBand(1).SetDescription("Multidirectional hillshade")
        hillshade.SetMetadataItem("COPERNICUS_SOURCE", PRODUCT)
        hillshade.BuildOverviews("AVERAGE", [2, 4, 8, 16])
        hillshade.FlushCache()
        hillshade = None
        if not valid_raster(temp_elevation) or not valid_raster(temp_hillshade):
            raise RuntimeError("GDAL created an invalid terrain derivative")

        # Keep only source and deliverable rasters in the persistent volume.
        cutline_path.unlink(missing_ok=True)
        temp_land_mask.unlink(missing_ok=True)
        minimum, maximum = raster_stats(temp_elevation)
        final_dir = version_dir
        if final_dir.exists():
            suffix = 1
            while final_dir.exists():
                final_dir = area_dir / f"{signature}-repair-{suffix}"
                suffix += 1
        os.replace(staging_dir, final_dir)
        staging_dir = final_dir
        elevation_path = final_dir / "elevation.tif"
        hillshade_path = final_dir / "hillshade.tif"
        record = {
            "source_sha256": source_sha256,
            "elevation_sha256": sha256_file(elevation_path),
            "hillshade_sha256": sha256_file(hillshade_path),
            "area_name": area_name,
            "bbox_wgs84": list(bbox),
            "crs": dst_crs,
            "vertical_datum": "EGM2008",
            "resolution_m": 30,
            "nodata": SOURCE_NODATA,
            "elevation_min_m": minimum,
            "elevation_max_m": maximum,
        }
        manifest["tiles"][f"{slug}:{signature}"] = record
        write_manifest(DERIVED_MANIFEST, manifest)
        return elevation_path, hillshade_path, record
    except Exception:
        if staging_dir.exists() and staging_dir != version_dir:
            shutil.rmtree(staging_dir, ignore_errors=True)
        raise


def set_elevation_renderer(layer: QgsRasterLayer, minimum: float, maximum: float) -> dict:
    style = apply_shared_elevation_style(layer, minimum, maximum)
    if style is None:
        raise RuntimeError("QGIS did not create the adaptive regional elevation scale")
    return style


def style_hillshade(layer: QgsRasterLayer) -> None:
    apply_shared_hillshade_style(layer)


def set_raster_metadata(layer: QgsRasterLayer, title: str, abstract: str) -> None:
    metadata = layer.metadata()
    metadata.setTitle(title)
    metadata.setAbstract(abstract)
    layer.setMetadata(metadata)
    server_metadata = layer.serverProperties()
    server_metadata.setTitle(title)
    server_metadata.setAbstract(abstract)
    server_metadata.setAttribution(
        "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 "
        "provided under COPERNICUS by the European Union and ESA; all rights reserved."
    )
    server_metadata.setAttributionUrl(
        "https://dataspace.copernicus.eu/sites/default/files/media/files/2025-06/"
        "copernicus_contributing_mission_data_access_v2_cop_dem_licenses.pdf"
    )


def derivative_dataset_metadata(
    dataset: gdal.Dataset,
    *,
    product: str,
    unit: str,
    horizontal_crs: str,
    source_elevation_sha256: str,
    north_reference: str | None = None,
    role: str = "numeric-analysis-data",
) -> None:
    band = dataset.GetRasterBand(1)
    band.SetNoDataValue(SOURCE_NODATA)
    band.SetUnitType(unit)
    band.SetDescription(product)
    dataset.SetMetadataItem("SOURCE_PRODUCT", PRODUCT)
    dataset.SetMetadataItem("SOURCE_ELEVATION_SHA256", source_elevation_sha256)
    dataset.SetMetadataItem("DERIVATIVE", product)
    dataset.SetMetadataItem("ALGORITHM", "Horn")
    dataset.SetMetadataItem("RESOLUTION_M", "30")
    dataset.SetMetadataItem("HORIZONTAL_CRS", horizontal_crs)
    dataset.SetMetadataItem("HORIZONTAL_UNITS", "m")
    dataset.SetMetadataItem("VERTICAL_UNITS", "m")
    dataset.SetMetadataItem("VERTICAL_DATUM", "EGM2008")
    dataset.SetMetadataItem("NODATA", f"{SOURCE_NODATA:g}")
    dataset.SetMetadataItem("DATA_ROLE", role)
    dataset.SetMetadataItem("STYLE_VERSION", DERIVATIVE_STYLE_VERSION)
    if north_reference:
        dataset.SetMetadataItem("NORTH_REFERENCE", north_reference)


def same_raster_grid(path: Path, template: gdal.Dataset) -> bool:
    if template is None:
        return False
    candidate = gdal.Open(str(path), gdal.GA_ReadOnly) if path.is_file() else None
    if candidate is None:
        return False
    valid = (
        candidate.RasterCount == 1
        and candidate.RasterXSize == template.RasterXSize
        and candidate.RasterYSize == template.RasterYSize
        and candidate.GetGeoTransform() == template.GetGeoTransform()
        and candidate.GetProjection() == template.GetProjection()
        and candidate.GetRasterBand(1).DataType == gdal.GDT_Float32
        and candidate.GetRasterBand(1).GetNoDataValue() == SOURCE_NODATA
    )
    candidate = None
    return valid


def raster_valid_range(path: Path) -> tuple[float | None, float | None]:
    """Read finite, non-NoData extrema in bounded chunks; all-NoData is valid."""
    dataset = gdal.Open(str(path), gdal.GA_ReadOnly)
    if dataset is None:
        raise RuntimeError(f"Cannot open derivative raster: {path}")
    band = dataset.GetRasterBand(1)
    nodata = band.GetNoDataValue()
    minimum = math.inf
    maximum = -math.inf
    for y in range(0, dataset.RasterYSize, 256):
        rows = min(256, dataset.RasterYSize - y)
        values = band.ReadAsArray(0, y, dataset.RasterXSize, rows)
        valid = values[np.isfinite(values)]
        if nodata is not None:
            valid = valid[valid != nodata]
        if valid.size:
            minimum = min(minimum, float(valid.min()))
            maximum = max(maximum, float(valid.max()))
    dataset = None
    if minimum == math.inf:
        return None, None
    return minimum, maximum


def derivative_manifest_path(directory: Path) -> Path:
    return directory / "terrain-derivatives.json"


def read_derivative_manifest(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def derive_slope_aspect(
    elevation_path: Path,
    *,
    area_name: str,
    horizontal_crs: str,
) -> dict:
    """Derive compressed metric slope/aspect products from a cached DEM only."""
    if not elevation_path.is_file():
        raise RuntimeError(f"Prepared elevation raster is missing: {elevation_path}")

    directory = elevation_path.parent
    slope_path = directory / "slope-percent.tif"
    aspect_path = directory / "aspect-degrees.tif"
    aspect_display_path = directory / "aspect-display.tif"
    manifest_path = derivative_manifest_path(directory)
    elevation_hash = sha256_file(elevation_path)
    manifest = read_derivative_manifest(manifest_path)
    cached_products = manifest.get("products", {}) if manifest else {}
    cache_template = gdal.Open(str(elevation_path), gdal.GA_ReadOnly)
    cache_valid = bool(
        manifest
        and manifest.get("version") == DERIVATIVE_STYLE_VERSION
        and manifest.get("source_elevation_sha256") == elevation_hash
        and cache_template is not None
        and all(
            same_raster_grid(path, cache_template)
            and cached_products.get(name, {}).get("sha256") == sha256_file(path)
            for name, path in (
                ("slope", slope_path),
                ("aspect", aspect_path),
                ("aspect_display", aspect_display_path),
            )
        )
    )
    cache_template = None

    if cache_valid:
        metadata = dict(manifest["metadata"])
        metadata["reused"] = True
        metadata["storage_bytes"] = sum(path.stat().st_size for path in (slope_path, aspect_path, aspect_display_path))
        print("Reusing verified slope and aspect rasters.", flush=True)
        return {
            "slope_path": str(slope_path),
            "aspect_path": str(aspect_path),
            "aspect_display_path": str(aspect_display_path),
            "metadata": metadata,
            "reused": True,
        }

    # Bound GDAL's block cache inside the existing 768 MiB backend limit.
    gdal.SetCacheMax(64 * 1024 * 1024)
    source = gdal.Open(str(elevation_path), gdal.GA_ReadOnly)
    if source is None or source.RasterCount != 1:
        raise RuntimeError(f"GDAL cannot read the prepared elevation raster: {elevation_path}")
    source_band = source.GetRasterBand(1)
    if source_band.DataType != gdal.GDT_Float32 or source_band.GetUnitType() not in ("m", "metre", "meter", "metres", "meters"):
        raise RuntimeError("Prepared elevation must be a Float32 raster in metres")
    nodata = source_band.GetNoDataValue()
    if nodata is None:
        raise RuntimeError("Prepared elevation has no NoData value")
    if nodata != SOURCE_NODATA:
        raise RuntimeError(f"Prepared elevation NoData must be {SOURCE_NODATA:g}; found {nodata:g}")
    source_crs = source.GetSpatialRef()
    if source_crs is None or not source_crs.IsProjected():
        raise RuntimeError("Slope and aspect require the prepared metric projected CRS")
    linear_units = source_crs.GetLinearUnits()
    if not math.isclose(linear_units, 1.0, rel_tol=0, abs_tol=1e-9):
        raise RuntimeError("Prepared elevation CRS must use metres to match vertical units")
    if source.GetRasterBand(1).GetUnitType() not in ("m", "metre", "meter", "metres", "meters"):
        raise RuntimeError("Prepared elevation vertical units are not metres")
    if source.GetProjection() == "":
        raise RuntimeError("Prepared elevation has no CRS metadata")

    staging_dir = Path(tempfile.mkdtemp(prefix=".terrain-derivatives-", dir=directory))
    temporary_slope = staging_dir / "slope-percent.tif"
    temporary_aspect = staging_dir / "aspect-degrees.tif"
    temporary_display = staging_dir / "aspect-display.tif"
    try:
        slope_options = gdal.DEMProcessingOptions(
            format="GTiff",
            creationOptions=RASTER_CREATION_OPTIONS,
            alg="Horn",
            slopeFormat="percent",
            scale=1.0,
            computeEdges=False,
        )
        slope = gdal.DEMProcessing(str(temporary_slope), source, "slope", options=slope_options)
        if slope is None:
            raise RuntimeError("GDAL could not generate slope in percent")
        derivative_dataset_metadata(
            slope,
            product="Slope in percent (Horn)",
            unit="percent",
            horizontal_crs=horizontal_crs,
            source_elevation_sha256=elevation_hash,
        )
        slope.FlushCache()
        slope = None

        aspect_options = gdal.DEMProcessingOptions(
            format="GTiff",
            creationOptions=RASTER_CREATION_OPTIONS,
            alg="Horn",
            scale=1.0,
            zeroForFlat=False,
            computeEdges=False,
        )
        aspect = gdal.DEMProcessing(str(temporary_aspect), source, "aspect", options=aspect_options)
        if aspect is None:
            raise RuntimeError("GDAL could not generate aspect azimuths")
        derivative_dataset_metadata(
            aspect,
            product="Aspect azimuth in degrees from grid north (Horn)",
            unit="degree",
            horizontal_crs=horizontal_crs,
            source_elevation_sha256=elevation_hash,
            north_reference="grid_north",
        )
        aspect.FlushCache()
        aspect = None
        source = None

        display = gdal.Translate(
            str(temporary_display),
            str(temporary_aspect),
            options=gdal.TranslateOptions(format="GTiff", creationOptions=RASTER_CREATION_OPTIONS),
        )
        if display is None:
            raise RuntimeError("GDAL could not create the categorical aspect display raster")
        display_band = display.GetRasterBand(1)
        display_band.SetNoDataValue(SOURCE_NODATA)
        display_band.SetUnitType("degree")
        display_band.SetDescription("Aspect display categories; use aspect-degrees.tif for numeric analysis")
        display.SetMetadataItem("SOURCE_ELEVATION_SHA256", elevation_hash)
        display.SetMetadataItem("DATA_ROLE", "visualization-only")
        display.SetMetadataItem("RAW_ASPECT_RASTER", aspect_path.name)
        display.SetMetadataItem("FLAT_DISPLAY_VALUE", f"{ASPECT_FLAT_DISPLAY_VALUE:g}")
        display.SetMetadataItem("FLAT_POLICY", "GDAL raw aspect remains NoData; -1 is a display-only flat category")

        raw_aspect = gdal.Open(str(temporary_aspect), gdal.GA_ReadOnly)
        slope_data = gdal.Open(str(temporary_slope), gdal.GA_ReadOnly)
        raw_aspect_band = raw_aspect.GetRasterBand(1)
        slope_band = slope_data.GetRasterBand(1)
        aspect_nodata = raw_aspect_band.GetNoDataValue()
        if aspect_nodata is None:
            raise RuntimeError("GDAL aspect output has no NoData value")
        width, height = display.RasterXSize, display.RasterYSize
        for y in range(0, height, 256):
            rows = min(256, height - y)
            aspect_values = raw_aspect_band.ReadAsArray(0, y, width, rows)
            slope_values = slope_band.ReadAsArray(0, y, width, rows)
            flat_cells = (
                (aspect_values == aspect_nodata)
                & (slope_values != nodata)
                & (slope_values <= 1e-6)
            )
            if flat_cells.any():
                aspect_values[flat_cells] = ASPECT_FLAT_DISPLAY_VALUE
                display_band.WriteArray(aspect_values, 0, y)
        raw_aspect = None
        slope_data = None
        overview_levels = [
            factor for factor in (2, 4, 8, 16)
            if min(width, height) // factor >= 1
        ]
        if overview_levels:
            for path, resampling in (
                # Slope is rendered as fixed discrete classes. Nearest keeps
                # each overview sample in the same class as a real source cell.
                (temporary_slope, "NEAREST"),
                (temporary_aspect, "NEAREST"),
                (temporary_display, "NEAREST"),
            ):
                overview_dataset = gdal.Open(str(path), gdal.GA_Update)
                overview_dataset.BuildOverviews(resampling, overview_levels)
                overview_dataset.FlushCache()
                overview_dataset = None
        display.FlushCache()
        display = None

        temporary_paths = (temporary_slope, temporary_aspect, temporary_display)
        grid_template = gdal.Open(str(elevation_path), gdal.GA_ReadOnly)
        grids_match = grid_template is not None and all(
            same_raster_grid(path, grid_template) for path in temporary_paths
        )
        grid_template = None
        if not grids_match:
            raise RuntimeError("GDAL derivatives do not match the source DEM grid, projection, or NoData")
        slope_min, slope_max = raster_stats(temporary_slope)
        aspect_min, aspect_max = raster_valid_range(temporary_aspect)
        if slope_min < 0 or (
            aspect_min is not None
            and (aspect_max is None or aspect_min < 0 or aspect_max > 360)
        ):
            raise RuntimeError("GDAL derivative values are outside their expected numeric ranges")

        for source_path, target_path in zip(
            temporary_paths,
            (slope_path, aspect_path, aspect_display_path),
            strict=True,
        ):
            os.replace(source_path, target_path)

        storage_bytes = sum(path.stat().st_size for path in (slope_path, aspect_path, aspect_display_path))
        metadata = derivative_metadata(
            area_name=area_name,
            horizontal_crs=horizontal_crs,
            resolution_m=30,
            nodata=SOURCE_NODATA,
            slope_min=slope_min,
            slope_max=slope_max,
            aspect_min=aspect_min,
            aspect_max=aspect_max,
            source_elevation_sha256=elevation_hash,
            reused=False,
            storage_bytes=storage_bytes,
        )
        manifest = {
            "version": DERIVATIVE_STYLE_VERSION,
            "source_elevation_sha256": elevation_hash,
            "products": {
                name: {"file": path.name, "sha256": sha256_file(path), "bytes": path.stat().st_size}
                for name, path in zip(
                    ("slope", "aspect", "aspect_display"),
                    (slope_path, aspect_path, aspect_display_path),
                    strict=True,
                )
            },
            "metadata": metadata,
        }
        temporary_manifest = staging_dir / manifest_path.name
        temporary_manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temporary_manifest, manifest_path)
        return {
            "slope_path": str(slope_path),
            "aspect_path": str(aspect_path),
            "aspect_display_path": str(aspect_display_path),
            "metadata": metadata,
            "reused": False,
        }
    except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise
    finally:
        source = None
        shutil.rmtree(staging_dir, ignore_errors=True)


def add_slope_aspect_to_project(
    project_path: Path,
    slope_path: Path,
    aspect_display_path: Path,
    metadata: dict,
) -> None:
    project = QgsProject.instance()
    if not project_path.is_file() or not project.read(str(project_path)):
        raise RuntimeError(f"Could not open the existing regional QGIS project: {project_path}")
    project.setFilePathStorage(Qgis.FilePathType.Relative)
    for name in ("terrain_slope", "terrain_aspect"):
        for layer in project.mapLayersByName(name):
            project.removeMapLayer(layer.id())

    slope = QgsRasterLayer(str(slope_path), "terrain_slope", "gdal")
    aspect = QgsRasterLayer(str(aspect_display_path), "terrain_aspect", "gdal")
    if not slope.isValid() or not aspect.isValid():
        raise RuntimeError("QGIS could not load both slope and aspect display rasters")
    apply_shared_slope_style(slope)
    apply_shared_aspect_style(aspect)
    shared = (
        f"Derived from {PRODUCT}; resolution 30 m; algorithm Horn; horizontal CRS "
        f"{metadata['horizontal_crs']} with metre units; vertical elevations in metres; "
        f"NoData {SOURCE_NODATA:g}. Numeric rasters remain available for later analysis."
    )
    set_raster_metadata(
        slope,
        f"Pendiente del terreno — {metadata['area_name']}",
        f"Slope values are percent rise. Fixed colour classes are for visualization. {shared}",
    )
    set_raster_metadata(
        aspect,
        f"Orientación de laderas — {metadata['area_name']}",
        f"Azimuth in degrees clockwise from grid north of the projected CRS. "
        f"Flat cells use a separate display code; the raw aspect GeoTIFF keeps GDAL NoData. {shared}",
    )
    project.addMapLayer(slope)
    project.addMapLayer(aspect)

    temporary_project = project_path.parent / f"{project_path.stem}.derivatives.next{project_path.suffix}"
    project.setFileName(str(temporary_project))
    if not project.write():
        raise RuntimeError(f"Could not write the regional QGIS project with derivative layers: {temporary_project}")
    os.replace(temporary_project, project_path)


def add_terrain_to_project(elevation_path: Path, hillshade_path: Path, record: dict) -> dict:
    project = QgsProject.instance()
    PROJECT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if PROJECT_PATH.exists():
        if not project.read(str(PROJECT_PATH)):
            raise RuntimeError(f"Could not open the existing QGIS project: {PROJECT_PATH}")
    else:
        project.clear()
        project.setCrs(QgsCoordinateReferenceSystem("EPSG:3857"))
    project.setFilePathStorage(Qgis.FilePathType.Relative)
    for name in ("terrain_hillshade", "terrain_elevation"):
        for layer in project.mapLayersByName(name):
            project.removeMapLayer(layer.id())

    area_name = record["area_name"]
    min_m = record["elevation_min_m"]
    max_m = record["elevation_max_m"]
    crs = record["crs"]
    bbox = record["bbox_wgs84"]
    shared_abstract = (
        f"Area: {area_name}; extent WGS84: {bbox[0]:.6f},{bbox[1]:.6f},"
        f"{bbox[2]:.6f},{bbox[3]:.6f}; elevation min/max m: {min_m:.1f}/{max_m:.1f}; "
        f"horizontal CRS: {crs}; vertical datum: EGM2008; NoData: {SOURCE_NODATA:g}. "
        "The application displays detailed Copernicus data only when map scale and viewport coverage are suitable. "
        "Copernicus GLO-30 Public is a digital surface model (vegetation and buildings can affect elevations)."
    )
    elevation = QgsRasterLayer(str(elevation_path), "terrain_elevation", "gdal")
    hillshade = QgsRasterLayer(str(hillshade_path), "terrain_hillshade", "gdal")
    if not elevation.isValid() or not hillshade.isValid():
        raise RuntimeError("QGIS could not load both terrain rasters")
    elevation_style = set_elevation_renderer(elevation, min_m, max_m)
    style_stops_text = ", ".join(
        f"{stop['value_m']:.1f} m {stop['color']}" for stop in elevation_style["stops"]
    )
    style_abstract = (
        f"Adaptive regional elevation scale {elevation_style['min_m']:.1f}–"
        f"{elevation_style['max_m']:.1f} m; interpolation: linear RGB; "
        f"renderer stops: {style_stops_text}. "
        "Colours are scaled to this region and should not be compared directly between regions."
    )
    style_hillshade(hillshade)
    set_raster_metadata(elevation, f"Elevación del terreno — {area_name}", f"{PRODUCT}, 30 m; elevation units: metres. {shared_abstract} {style_abstract}")
    set_raster_metadata(hillshade, f"Relieve sombreado — {area_name}", f"Hillshade derived with GDAL from {PRODUCT}, 30 m. {shared_abstract}")
    project.addMapLayer(elevation)
    project.addMapLayer(hillshade)

    temp_project = PROJECT_PATH.parent / f"{PROJECT_PATH.stem}.next{PROJECT_PATH.suffix}"
    project.setFileName(str(temp_project))
    if not project.write():
        raise RuntimeError(f"Could not write the QGIS project with terrain layers: {temp_project}")
    os.replace(temp_project, PROJECT_PATH)
    return elevation_style


def make_terrain_readable(paths: tuple[Path, ...]) -> None:
    # QGIS Server reads the shared volume as www-data. Only normalize this
    # request's project and raster paths; don't rewrite permissions on other areas.
    for path in paths:
        if path.is_file():
            path.chmod(0o644)
        directory = path.parent
        while directory == DATA_ROOT or DATA_ROOT in directory.parents:
            if directory.exists():
                directory.chmod(0o755)
            if directory == DATA_ROOT:
                break
            directory = directory.parent


def main() -> None:
    global PROJECT_PATH
    args = arguments()
    PROJECT_PATH = args.project_path

    if args.derive_slope_aspect:
        products = derive_slope_aspect(
            args.elevation_path,
            area_name=args.name,
            horizontal_crs=args.horizontal_crs,
        )
        QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX_PATH", "/usr"), True)
        app = QgsApplication([], False)
        app.initQgis()
        try:
            add_slope_aspect_to_project(
                PROJECT_PATH,
                Path(products["slope_path"]),
                Path(products["aspect_display_path"]),
                products["metadata"],
            )
        finally:
            app.exitQgis()

        readable_paths = (
            PROJECT_PATH,
            Path(products["slope_path"]),
            Path(products["aspect_path"]),
            Path(products["aspect_display_path"]),
            derivative_manifest_path(Path(products["slope_path"]).parent),
        )
        make_terrain_readable(readable_paths)
        aspect_min = products["metadata"]["aspect"]["minimum"]
        aspect_max = products["metadata"]["aspect"]["maximum"]
        aspect_range = (
            f"{aspect_min:.3f}–{aspect_max:.3f}°"
            if aspect_min is not None and aspect_max is not None
            else "sin orientación definida (todo plano)"
        )
        print(
            f"Terrain derivatives for '{args.name}': slope {products['metadata']['slope']['minimum']:.3f}–"
            f"{products['metadata']['slope']['maximum']:.3f} %, aspect {aspect_range}. "
            f"Stored {products['metadata']['storage_bytes']} compressed bytes; reused={products['reused']}. ",
            flush=True,
        )
        print(
            f"DERIVATIVE_RESULT_JSON={json.dumps(products, separators=(',', ':'))}",
            flush=True,
        )
        return

    bbox = args.bbox
    stems = selected_tiles(bbox)
    source_manifest = read_manifest(SOURCE_MANIFEST)
    downloaded_bytes = 0
    sources: list[tuple[Path, str]] = []
    for stem in stems:
        path, record, received = download_or_reuse_tile(stem, source_manifest)
        source_manifest["tiles"][stem] = record
        downloaded_bytes += received
        sources.append((path, record["sha256"]))
    source_manifest["product"] = PRODUCT
    source_manifest["source_resolution_arc_seconds"] = 1
    source_manifest["source_vertical_datum"] = "EGM2008"
    write_manifest(SOURCE_MANIFEST, source_manifest)

    combined_source_hash = hashlib.sha256("".join(sorted(digest for _, digest in sources)).encode()).hexdigest()
    elevation_path, hillshade_path, record = build_derived(
        [path for path, _ in sources], combined_source_hash, args.name, bbox
    )

    QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX_PATH", "/usr"), True)
    app = QgsApplication([], False)
    app.initQgis()
    try:
        elevation_style = add_terrain_to_project(elevation_path, hillshade_path, record)
    finally:
        app.exitQgis()

    make_terrain_readable((PROJECT_PATH, elevation_path, hillshade_path))
    source_bytes = sum(path.stat().st_size for path in SOURCE_TILES.glob("*.tif"))
    derived_bytes = sum(path.stat().st_size for path in DERIVED_ROOT.rglob("*.tif"))
    print(f"Prepared Copernicus terrain coverage '{args.name}' at {bbox}.", flush=True)
    print(f"Source tiles selected: {len(stems)}; bytes downloaded this run: {downloaded_bytes}.", flush=True)
    print(f"Original COG storage: {source_bytes} bytes; derived raster storage: {derived_bytes} bytes.", flush=True)
    print(f"Elevation range: {record['elevation_min_m']:.1f}–{record['elevation_max_m']:.1f} m; CRS {record['crs']}; NoData {SOURCE_NODATA:g}.", flush=True)
    print("QGIS WMS layers: terrain_hillshade, terrain_elevation.", flush=True)
    result = {
        "area_name": args.name,
        "bbox_wgs84": list(bbox),
        "elevation_min_m": record["elevation_min_m"],
        "elevation_max_m": record["elevation_max_m"],
        "elevation_style": elevation_style,
        "crs": record["crs"],
        "vertical_datum": record.get("vertical_datum", "EGM2008"),
        "resolution_m": 30,
        "nodata": SOURCE_NODATA,
        "project_path": str(PROJECT_PATH),
        "elevation_path": str(elevation_path),
        "hillshade_path": str(hillshade_path),
        "source_tile_count": len(stems),
        "source_downloaded_bytes": downloaded_bytes,
        "source_tiles": [{"name": path.name, "sha256": digest} for path, digest in sources],
    }
    print(f"RESULT_JSON={json.dumps(result, separators=(',', ':'))}", flush=True)


if __name__ == "__main__":
    gdal.UseExceptions()
    main()
