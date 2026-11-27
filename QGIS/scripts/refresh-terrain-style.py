#!/usr/bin/python3
"""Refresh regional QGIS styles and legends without rebuilding source DEMs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from osgeo import gdal
from qgis.core import QgsApplication, QgsProject

from terrain_derivative_config import (
    ASPECT_LEGEND,
    DERIVATIVE_STYLE_VERSION,
    SLOPE_BREAKS,
)
from terrain_style import style_aspect, style_elevation, style_hillshade, style_slope


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-path", type=Path)
    parser.add_argument("--minimum-m", type=float)
    parser.add_argument("--maximum-m", type=float)
    parser.add_argument("--regions-root", type=Path)
    args = parser.parse_args()
    if bool(args.project_path) == bool(args.regions_root):
        parser.error("provide exactly one of --project-path or --regions-root")
    if args.project_path and not args.project_path.is_absolute():
        parser.error("--project-path must be absolute")
    if args.regions_root and not args.regions_root.is_absolute():
        parser.error("--regions-root must be absolute")
    if (args.minimum_m is None) != (args.maximum_m is None):
        parser.error("--minimum-m and --maximum-m must be provided together")
    return args


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_name(f"{path.name}.next")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def update_slope_overviews(path: Path) -> bool:
    """Rebuild only reduced-resolution slope overviews using source samples."""
    dataset = gdal.Open(str(path), gdal.GA_Update)
    if dataset is None:
        raise RuntimeError(f"Cannot update slope overview for {path}")
    band = dataset.GetRasterBand(1)
    levels = [factor for factor in (2, 4, 8, 16) if min(dataset.RasterXSize, dataset.RasterYSize) // factor >= 1]
    if not levels:
        dataset = None
        return False
    if band.GetOverviewCount() > 0:
        dataset.BuildOverviews("NEAREST", levels)
    dataset.FlushCache()
    dataset = None
    return True


def set_abstract(layer, abstract: str) -> None:
    metadata = layer.metadata()
    metadata.setAbstract(abstract)
    layer.setMetadata(metadata)
    layer.serverProperties().setAbstract(abstract)


def restyle_project(
    project_path: Path,
    *,
    minimum_m: float | None = None,
    maximum_m: float | None = None,
    area_name: str | None = None,
    horizontal_crs: str | None = None,
) -> dict | None:
    project = QgsProject.instance()
    if not project.read(str(project_path)):
        raise RuntimeError(f"Could not open existing regional project: {project_path}")

    elevation_style = None
    for layer in project.mapLayersByName("terrain_elevation"):
        if minimum_m is not None and maximum_m is not None:
            elevation_style = style_elevation(layer, minimum_m, maximum_m)
        if area_name:
            style_text = ""
            if elevation_style:
                style_text = (
                    f" Adaptive elevation renderer {elevation_style['min_m']:.1f}–"
                    f"{elevation_style['max_m']:.1f} m; colors are adapted to this area."
                )
            set_abstract(
                layer,
                f"Copernicus DEM GLO-30 Public elevation in metres for {area_name}."
                f"{style_text} NoData stays transparent.",
            )

    for layer in project.mapLayersByName("terrain_hillshade"):
        style_hillshade(layer)
        if area_name:
            set_abstract(layer, f"Hillshade derived from Copernicus DEM GLO-30 Public for {area_name}.")

    for layer in project.mapLayersByName("terrain_slope"):
        style_slope(layer)
        if area_name:
            set_abstract(
                layer,
                f"Slope in percent for {area_name}; discrete colors use the inclusive upper-bound classes in the legend.",
            )

    for layer in project.mapLayersByName("terrain_aspect"):
        style_aspect(layer)
        if area_name:
            set_abstract(
                layer,
                f"Aspect for {area_name}, degrees clockwise from projected grid north; the north class wraps through 0 degrees and flat cells are separate.",
            )

    temporary = project_path.with_name(f"{project_path.stem}.style-next{project_path.suffix}")
    project.setFileName(str(temporary))
    if not project.write():
        raise RuntimeError(f"Could not write refreshed project: {temporary}")
    os.replace(temporary, project_path)
    project_path.chmod(0o644)
    return elevation_style


def refresh_region(region: Path) -> bool:
    project_path = region / "terrain.qgs"
    result_path = region / "result.json"
    if not project_path.is_file() or not result_path.is_file():
        return False

    envelope = json.loads(result_path.read_text(encoding="utf-8"))
    result = envelope.get("result")
    if not isinstance(result, dict):
        return False
    coverage = result.get("coverage", {})
    area_name = str(coverage.get("area_name") or region.name)
    minimum = coverage.get("elevation_min_m")
    maximum = coverage.get("elevation_max_m")
    style = restyle_project(
        project_path,
        minimum_m=float(minimum) if minimum is not None else None,
        maximum_m=float(maximum) if maximum is not None else None,
        area_name=area_name,
        horizontal_crs=coverage.get("horizontal_crs"),
    )

    derivatives = result.get("derivatives")
    storage = result.get("storage", {})
    slope_path_text = storage.get("slope_raster")
    if isinstance(derivatives, dict):
        derivatives["version"] = DERIVATIVE_STYLE_VERSION
        derivatives.setdefault("slope", {})["legend"] = [
            {key: item[key] for key in ("id", "upper_bound", "color", "label")}
            for item in SLOPE_BREAKS
        ]
        derivatives.setdefault("aspect", {})["legend"] = list(ASPECT_LEGEND)
        derivatives.setdefault("aspect", {})["north_reference"] = "grid_north"
        derivatives.setdefault("aspect", {})["north_reference_label"] = "Norte de cuadrícula del CRS proyectado"

        if slope_path_text:
            slope_path = Path(slope_path_text)
            if slope_path.is_file():
                update_slope_overviews(slope_path)
                for product in (region / "terrain-derivatives.json", slope_path.parent / "terrain-derivatives.json"):
                    if product.is_file():
                        manifest = json.loads(product.read_text(encoding="utf-8"))
                        manifest["version"] = DERIVATIVE_STYLE_VERSION
                        manifest.setdefault("metadata", {}).update(derivatives)
                        slope_entry = manifest.get("products", {}).get("slope")
                        if slope_entry is not None:
                            slope_entry["sha256"] = sha256_file(slope_path)
                            slope_entry["bytes"] = slope_path.stat().st_size
                        atomic_json(product, manifest)

    if style is not None:
        coverage["elevation_style"] = style
    result.setdefault("preparation", {})["style_refreshed"] = True
    atomic_json(result_path, envelope)
    print(f"Refreshed styles and metadata: {region.name}", flush=True)
    return True


def main() -> None:
    args = arguments()
    QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX_PATH", "/usr"), True)
    app = QgsApplication([], False)
    app.initQgis()
    try:
        if args.regions_root:
            updated = sum(refresh_region(region) for region in sorted(args.regions_root.iterdir()) if region.is_dir())
            print(f"Updated {updated} saved terrain regions; source elevation and derivative pixel values were not rebuilt.", flush=True)
        else:
            if args.minimum_m is None or args.maximum_m is None:
                raise RuntimeError("--minimum-m and --maximum-m are required with --project-path")
            style = restyle_project(args.project_path, minimum_m=args.minimum_m, maximum_m=args.maximum_m)
            if style is None:
                raise RuntimeError("QGIS did not create the adaptive regional elevation scale")
            print(f"RESULT_STYLE_JSON={json.dumps(style, separators=(',', ':'))}", flush=True)
            print(f"Updated {args.project_path}; source rasters were left unchanged.", flush=True)
    finally:
        app.exitQgis()


if __name__ == "__main__":
    main()
