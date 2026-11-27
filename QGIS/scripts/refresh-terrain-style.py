#!/usr/bin/python3
"""Update an existing regional QGIS project without touching its rasters."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from qgis.core import QgsApplication, QgsProject
from terrain_style import style_elevation


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-path", required=True, type=Path)
    parser.add_argument("--minimum-m", required=True, type=float)
    parser.add_argument("--maximum-m", required=True, type=float)
    args = parser.parse_args()
    if not args.project_path.is_absolute():
        parser.error("--project-path must be absolute")
    return args


def main() -> None:
    args = arguments()
    QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX_PATH", "/usr"), True)
    app = QgsApplication([], False)
    app.initQgis()
    try:
        project = QgsProject.instance()
        if not project.read(str(args.project_path)):
            raise RuntimeError(f"Could not open existing regional project: {args.project_path}")
        layers = project.mapLayersByName("terrain_elevation")
        if not layers:
            raise RuntimeError(f"Regional project has no terrain_elevation layer: {args.project_path}")
        style = style_elevation(layers[0], args.minimum_m, args.maximum_m)
        if style is None:
            raise RuntimeError("QGIS did not create the adaptive regional elevation scale")
        abstract = (
            f"Adaptive regional elevation scale {style['min_m']:.1f}–{style['max_m']:.1f} m; "
            "interpolation: linear RGB; renderer stops: "
            + ", ".join(f"{stop['value_m']:.1f} m {stop['color']}" for stop in style["stops"])
            + ". Colours are scaled to this region and should not be compared directly between regions."
        )
        metadata = layers[0].metadata()
        metadata.setAbstract(f"{metadata.abstract()} {abstract}".strip())
        layers[0].setMetadata(metadata)
        layers[0].serverProperties().setAbstract(f"{layers[0].serverProperties().abstract()} {abstract}".strip())

        temporary = args.project_path.with_name(f"{args.project_path.stem}.style-next{args.project_path.suffix}")
        project.setFileName(str(temporary))
        if not project.write():
            raise RuntimeError(f"Could not write updated regional project: {temporary}")
        os.replace(temporary, args.project_path)
        args.project_path.chmod(0o644)
        print(f"RESULT_STYLE_JSON={json.dumps(style, separators=(',', ':'))}", flush=True)
        print(f"Updated the renderer in {args.project_path}; raster files were left unchanged.", flush=True)
    finally:
        app.exitQgis()


if __name__ == "__main__":
    main()
