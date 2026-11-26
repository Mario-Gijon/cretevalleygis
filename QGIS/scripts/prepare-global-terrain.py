#!/usr/bin/python3
"""Prepare NOAA ETOPO 2022 60-arc-second global elevation and hillshade."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import urllib.request

from osgeo import gdal
from qgis.core import Qgis, QgsApplication, QgsProject, QgsRasterLayer

from terrain_style import (
    ELEVATION_STYLE_MAX,
    ELEVATION_STYLE_MIN,
    style_elevation,
    style_hillshade,
)


DATA_ROOT = Path("/io/data/terrain/global")
SOURCE_ROOT = DATA_ROOT / "source"
SOURCE_PATH = SOURCE_ROOT / "ETOPO_2022_v1_60s_N90W180_surface.tif"
SOURCE_MANIFEST = DATA_ROOT / "source-manifest.json"
DERIVED_ROOT = DATA_ROOT / "derived"
DERIVED_MANIFEST = DATA_ROOT / "derived-manifest.json"
PROJECT_PATH = Path("/io/data/world/world.qgs")
SOURCE_URL = (
    "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/"
    "60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif"
)
PRODUCT = "NOAA ETOPO 2022 surface, 60 arc-seconds"
NOAA_PRODUCT_URL = "https://www.ncei.noaa.gov/products/etopo-global-relief-model"
DOI = "https://doi.org/10.25921/fd45-gt74"
EXPECTED_PIXEL_SIZE = 1.0 / 60.0
MAX_SOURCE_BYTES = 750_000_000
MAX_GDAL_CACHE_BYTES = 192 * 1024 * 1024
OVERVIEW_LEVELS = [2, 4, 8, 16, 32, 64]
RASTER_CREATION_OPTIONS = [
    "TILED=YES",
    "BLOCKXSIZE=512",
    "BLOCKYSIZE=512",
    "COMPRESS=DEFLATE",
    "BIGTIFF=IF_SAFER",
]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_manifest(path: Path) -> dict:
    if not path.exists():
        return {"format": 1}
    manifest = json.loads(path.read_text())
    if manifest.get("format") != 1:
        raise RuntimeError(f"Unsupported ETOPO manifest: {path}")
    return manifest


def write_manifest(path: Path, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, path)


def is_wgs84_geographic(dataset) -> bool:
    """Check horizontal WGS84, including GeoTIFFs with a compound vertical CRS."""
    spatial_ref = dataset.GetSpatialRef()
    if not spatial_ref:
        return False
    geographic_ref = spatial_ref.CloneGeogCS()
    if not geographic_ref:
        return False
    authority = geographic_ref.GetAuthorityCode(None) or geographic_ref.GetAuthorityCode("GEOGCS")
    if authority == "4326":
        return True
    expected = geographic_ref.Clone()
    expected.ImportFromEPSG(4326)
    return bool(geographic_ref.IsSame(expected))


def validate_source(path: Path) -> dict:
    dataset = gdal.Open(str(path), gdal.GA_ReadOnly)
    if dataset is None or dataset.RasterCount != 1:
        raise ValueError(f"GDAL cannot open a single-band ETOPO raster: {path}")
    width, height = dataset.RasterXSize, dataset.RasterYSize
    if not (21_000 <= width <= 22_000 and 10_000 <= height <= 11_000):
        raise ValueError(f"Unexpected global 60-second dimensions: {width} × {height}")
    if not is_wgs84_geographic(dataset):
        raise ValueError("ETOPO source must use horizontal WGS84 (EPSG:4326)")
    transform = dataset.GetGeoTransform()
    if not math.isclose(transform[1], EXPECTED_PIXEL_SIZE, abs_tol=0.00001):
        raise ValueError(f"Expected 60-arc-second longitude cells, got {transform[1]}")
    if not math.isclose(transform[5], -EXPECTED_PIXEL_SIZE, abs_tol=0.00001):
        raise ValueError(f"Expected 60-arc-second latitude cells, got {transform[5]}")
    west = transform[0]
    north = transform[3]
    east = west + width * transform[1]
    south = north + height * transform[5]
    if west > -179.9 or east < 179.9 or south > -89.9 or north < 89.9:
        raise ValueError(f"ETOPO file does not provide full-world coverage: {west},{south},{east},{north}")
    band = dataset.GetRasterBand(1)
    no_data = band.GetNoDataValue()
    info = {
        "width": width,
        "height": height,
        "pixel_size_degrees": transform[1],
        "extent_wgs84": [west, south, east, north],
        "horizontal_crs": "EPSG:4326",
        "vertical_datum": "EGM2008",
        "nodata": no_data,
        "data_type": gdal.GetDataTypeName(band.DataType),
    }
    dataset = None
    return info


def get_source() -> tuple[Path, dict]:
    SOURCE_ROOT.mkdir(parents=True, exist_ok=True)
    manifest = read_manifest(SOURCE_MANIFEST)
    previous = manifest.get("source", {})
    if SOURCE_PATH.is_file() and SOURCE_PATH.stat().st_size <= MAX_SOURCE_BYTES:
        try:
            info = validate_source(SOURCE_PATH)
            digest = file_sha256(SOURCE_PATH)
            if previous.get("sha256") in (None, digest):
                record = {
                    **info,
                    "url": SOURCE_URL,
                    "sha256": digest,
                    "bytes": SOURCE_PATH.stat().st_size,
                    "downloaded_at_utc": previous.get("downloaded_at_utc"),
                }
                manifest["source"] = record
                write_manifest(SOURCE_MANIFEST, manifest)
                print(f"Reusing verified NOAA ETOPO source ({record['bytes']} bytes).", flush=True)
                return SOURCE_PATH, record
        except (OSError, ValueError) as error:
            print(f"Cached ETOPO file failed validation; downloading a fresh copy: {error}", flush=True)

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".etopo-", suffix=".partial", dir=SOURCE_ROOT
    )
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    received = 0
    try:
        request = urllib.request.Request(
            SOURCE_URL,
            headers={"User-Agent": "CreteValleyGIS local terrain preparation"},
        )
        with os.fdopen(descriptor, "wb") as output, urllib.request.urlopen(request, timeout=180) as response:
            expected_bytes = int(response.headers.get("Content-Length", "0"))
            if expected_bytes <= 0 or expected_bytes > MAX_SOURCE_BYTES:
                raise IOError(f"Unexpected NOAA ETOPO download size: {expected_bytes}")
            while chunk := response.read(4 * 1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
                received += len(chunk)
        if received != expected_bytes:
            raise IOError(f"Incomplete NOAA download: expected {expected_bytes}, received {received} bytes")
        info = validate_source(temporary)
        os.replace(temporary, SOURCE_PATH)
        record = {
            **info,
            "url": SOURCE_URL,
            "sha256": digest.hexdigest(),
            "bytes": received,
            "downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        manifest["source"] = record
        write_manifest(SOURCE_MANIFEST, manifest)
        print(f"Downloaded NOAA ETOPO 2022 source: {received} bytes, SHA-256 {record['sha256']}.", flush=True)
        return SOURCE_PATH, record
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def raster_statistics(path: Path, block_rows: int = 256) -> tuple[float, float]:
    import numpy as np

    dataset = gdal.Open(str(path), gdal.GA_ReadOnly)
    if dataset is None:
        raise RuntimeError(f"Cannot read elevation raster: {path}")
    band = dataset.GetRasterBand(1)
    no_data = band.GetNoDataValue()
    minimum, maximum = math.inf, -math.inf
    for y in range(0, dataset.RasterYSize, block_rows):
        rows = min(block_rows, dataset.RasterYSize - y)
        values = band.ReadAsArray(0, y, dataset.RasterXSize, rows)
        valid = np.isfinite(values)
        if no_data is not None:
            valid &= values != no_data
        if valid.any():
            minimum = min(minimum, float(values[valid].min()))
            maximum = max(maximum, float(values[valid].max()))
    dataset = None
    if not math.isfinite(minimum) or not math.isfinite(maximum):
        raise RuntimeError(f"No valid elevation values found in {path}")
    return minimum, maximum


def valid_raster(path: Path, expected_width: int, expected_height: int) -> bool:
    dataset = gdal.Open(str(path), gdal.GA_ReadOnly) if path.is_file() else None
    if dataset is None:
        return False
    valid = (
        dataset.RasterCount == 1
        and dataset.RasterXSize == expected_width
        and dataset.RasterYSize == expected_height
        and is_wgs84_geographic(dataset)
    )
    dataset = None
    return valid


def prepare_products(source_path: Path, source: dict) -> tuple[Path, Path, dict]:
    signature = hashlib.sha256(
        f"{source['sha256']}|{PRODUCT}|streaming-gtiff-overviews|hillshade-v2".encode()
    ).hexdigest()[:16]
    output_dir = DERIVED_ROOT / signature
    elevation_path = output_dir / "elevation.tif"
    hillshade_path = output_dir / "hillshade.tif"
    manifest = read_manifest(DERIVED_MANIFEST)
    cached = manifest.get("products", {}).get(signature, {})
    if (
        cached.get("source_sha256") == source["sha256"]
        and valid_raster(elevation_path, source["width"], source["height"])
        and valid_raster(hillshade_path, source["width"], source["height"])
        and cached.get("elevation_sha256") == file_sha256(elevation_path)
        and cached.get("hillshade_sha256") == file_sha256(hillshade_path)
    ):
        print("Reusing verified ETOPO elevation and hillshade products.", flush=True)
        return elevation_path, hillshade_path, cached

    DERIVED_ROOT.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{signature}-", dir=DERIVED_ROOT))
    temp_elevation = staging / "elevation.tif"
    temp_hillshade = staging / "hillshade.tif"
    source_dataset = gdal.Open(str(source_path), gdal.GA_ReadOnly)
    source_band = source_dataset.GetRasterBand(1)
    predictor = "3" if source_band.DataType in (gdal.GDT_Float32, gdal.GDT_Float64) else "2"
    options = [*RASTER_CREATION_OPTIONS, f"PREDICTOR={predictor}"]
    width, height = source_dataset.RasterXSize, source_dataset.RasterYSize
    source_dataset = None
    try:
        elevation = gdal.Translate(
            str(temp_elevation),
            str(source_path),
            options=gdal.TranslateOptions(format="GTiff", creationOptions=options),
        )
        if elevation is None:
            raise RuntimeError("GDAL could not create the tiled ETOPO elevation raster")
        band = elevation.GetRasterBand(1)
        band.SetUnitType("m")
        band.SetDescription("Elevation in metres above EGM2008")
        elevation.SetMetadataItem("SOURCE_PRODUCT", PRODUCT)
        elevation.SetMetadataItem("SOURCE_URL", SOURCE_URL)
        elevation.BuildOverviews("AVERAGE", OVERVIEW_LEVELS)
        elevation.FlushCache()
        elevation = None

        hillshade = gdal.DEMProcessing(
            str(temp_hillshade),
            str(temp_elevation),
            "hillshade",
            options=gdal.DEMProcessingOptions(
                format="GTiff",
                creationOptions=[*RASTER_CREATION_OPTIONS, "PREDICTOR=2"],
                scale=111_120.0,
                zFactor=1.0,
                altitude=45.0,
                multiDirectional=True,
            ),
        )
        if hillshade is None:
            raise RuntimeError("GDAL could not derive global ETOPO hillshade")
        hillshade.GetRasterBand(1).SetDescription("Multidirectional ETOPO hillshade")
        hillshade.SetMetadataItem("SOURCE_PRODUCT", PRODUCT)
        hillshade.BuildOverviews("AVERAGE", OVERVIEW_LEVELS)
        hillshade.FlushCache()
        hillshade = None

        if not valid_raster(temp_elevation, width, height) or not valid_raster(temp_hillshade, width, height):
            raise RuntimeError("GDAL created an invalid global terrain product")
        minimum, maximum = raster_statistics(temp_elevation)
        if minimum < ELEVATION_STYLE_MIN or maximum > ELEVATION_STYLE_MAX:
            raise RuntimeError(
                f"ETOPO values {minimum}–{maximum} exceed the configured global colour range"
            )

        final_dir = output_dir
        repair_index = 0
        while final_dir.exists():
            repair_index += 1
            final_dir = DERIVED_ROOT / f"{signature}-repair-{repair_index}"
        os.replace(staging, final_dir)
        elevation_path = final_dir / "elevation.tif"
        hillshade_path = final_dir / "hillshade.tif"
        record = {
            "source_sha256": source["sha256"],
            "elevation_sha256": file_sha256(elevation_path),
            "hillshade_sha256": file_sha256(hillshade_path),
            "resolution_arc_seconds": 60,
            "horizontal_crs": "EPSG:4326",
            "vertical_datum": "EGM2008",
            "nodata": source["nodata"],
            "min_elevation_m": minimum,
            "max_elevation_m": maximum,
        }
        manifest.setdefault("products", {})[signature] = record
        write_manifest(DERIVED_MANIFEST, manifest)
        return elevation_path, hillshade_path, record
    except Exception:
        if staging.exists():
            import shutil

            shutil.rmtree(staging, ignore_errors=True)
        raise


def set_server_metadata(layer: QgsRasterLayer, title: str, abstract: str) -> None:
    metadata = layer.metadata()
    metadata.setTitle(title)
    metadata.setAbstract(abstract)
    layer.setMetadata(metadata)
    server = layer.serverProperties()
    server.setTitle(title)
    server.setAbstract(abstract)
    server.setAttribution("ETOPO 2022 · NOAA National Centers for Environmental Information · CC0 1.0")
    server.setAttributionUrl(NOAA_PRODUCT_URL)


def update_project(elevation_path: Path, hillshade_path: Path, source: dict, products: dict) -> None:
    project = QgsProject.instance()
    if not project.read(str(PROJECT_PATH)):
        raise RuntimeError(f"Could not open QGIS project: {PROJECT_PATH}")
    project.setFilePathStorage(Qgis.FilePathType.Relative)
    for name in ("terrain_elevation_global", "terrain_hillshade_global"):
        for existing in project.mapLayersByName(name):
            project.removeMapLayer(existing.id())

    west, south, east, north = source["extent_wgs84"]
    no_data = source["nodata"]
    no_data_text = "not declared" if no_data is None else f"{no_data:g}"
    abstract = (
        f"Source: {PRODUCT}; resolution: 60 arc-seconds (~1.85 km at the equator); "
        f"extent WGS84: {west:.6f},{south:.6f},{east:.6f},{north:.6f}; "
        f"elevation min/max m: {products['min_elevation_m']:.1f}/{products['max_elevation_m']:.1f}; "
        f"horizontal CRS: EPSG:4326; vertical datum: EGM2008; NoData: {no_data_text}; "
        f"license: CC0 1.0; DOI: {DOI}. NOAA ETOPO 2022 includes topography and bathymetry."
    )
    elevation = QgsRasterLayer(str(elevation_path), "terrain_elevation_global", "gdal")
    hillshade = QgsRasterLayer(str(hillshade_path), "terrain_hillshade_global", "gdal")
    if not elevation.isValid() or not hillshade.isValid():
        raise RuntimeError("QGIS could not load the global elevation and hillshade rasters")
    style_elevation(elevation)
    style_hillshade(hillshade)
    set_server_metadata(elevation, "Elevación mundial — ETOPO 2022 60 arc-seconds", abstract)
    set_server_metadata(hillshade, "Relieve mundial — ETOPO 2022 60 arc-seconds", abstract)
    project.addMapLayer(elevation)
    project.addMapLayer(hillshade)

    temporary = PROJECT_PATH.parent / "world.with-global-terrain.next.qgs"
    project.setFileName(str(temporary))
    if not project.write():
        raise RuntimeError(f"Could not write global terrain layers to {temporary}")
    os.replace(temporary, PROJECT_PATH)
    PROJECT_PATH.chmod(0o644)


def make_global_readable() -> None:
    for directory in (DATA_ROOT, SOURCE_ROOT, DERIVED_ROOT):
        if directory.exists():
            directory.chmod(0o755)
    for path in DATA_ROOT.rglob("*"):
        if path.is_dir():
            path.chmod(0o755)
        elif path.is_file():
            path.chmod(0o644)


def main() -> None:
    gdal.SetCacheMax(MAX_GDAL_CACHE_BYTES)
    source_path, source = get_source()
    elevation_path, hillshade_path, products = prepare_products(source_path, source)
    QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX_PATH", "/usr"), True)
    application = QgsApplication([], False)
    application.initQgis()
    try:
        update_project(elevation_path, hillshade_path, source, products)
    finally:
        application.exitQgis()
    make_global_readable()
    source_bytes = sum(path.stat().st_size for path in SOURCE_ROOT.glob("*.tif"))
    derived_bytes = sum(path.stat().st_size for path in DERIVED_ROOT.rglob("*.tif"))
    print(f"Prepared global NOAA ETOPO elevation range {products['min_elevation_m']:.1f}–{products['max_elevation_m']:.1f} m.", flush=True)
    print(f"ETOPO source storage: {source_bytes} bytes; global derivatives: {derived_bytes} bytes.", flush=True)
    print("QGIS WMS layers: terrain_elevation_global, terrain_hillshade_global.", flush=True)


if __name__ == "__main__":
    gdal.UseExceptions()
    main()
