#!/usr/bin/python3
"""Download compact Natural Earth inputs and build the QGIS Server project."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import urllib.request
import zipfile

from qgis.core import (
    Qgis,
    QgsApplication,
    QgsCoordinateReferenceSystem,
    QgsFillSymbol,
    QgsLineSymbol,
    QgsProject,
    QgsVectorLayer,
)
from qgis.PyQt.QtGui import QColor


ROOT = Path("/io/data/world")
SOURCES = {
    "land": "https://naturalearth.s3.amazonaws.com/110m_physical/ne_110m_land.zip",
    "countries": "https://naturalearth.s3.amazonaws.com/110m_cultural/ne_110m_admin_0_countries.zip",
    "boundaries": "https://naturalearth.s3.amazonaws.com/110m_cultural/ne_110m_admin_0_boundary_lines_land.zip",
}
SHA256 = {
    "land": "1926c621afd6ac67c3f36639bb1236134a48d82226dc675d3e3df53d02d2a3de",
    "countries": "0f243aeac8ac6cf26f0417285b0bd33ac47f1b5bdb719fd3e0df37d03ea37110",
    "boundaries": "bb2954981570498a4b4344f8e83fa54caa5858e15e800094112407d2bd2f940d",
}


def download_and_extract(name: str, url: str) -> Path:
    layer_dir = ROOT / "data" / name
    shapefile_name = url.rsplit("/", 1)[-1].removesuffix(".zip") + ".shp"
    shapefile = layer_dir / shapefile_name
    if shapefile.exists():
        return shapefile

    layer_dir.mkdir(parents=True, exist_ok=True)
    archive = Path("/tmp") / f"{name}.zip"
    request = urllib.request.Request(url, headers={"User-Agent": "CreteValleyGIS/0.1 (local development)"})
    with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    print(f"Downloaded {name}: sha256={digest}", flush=True)
    if digest != SHA256[name]:
        archive.unlink(missing_ok=True)
        raise ValueError(f"Natural Earth archive checksum changed for {name}: {digest}")
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.namelist():
            path = PurePosixPath(member)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError(f"Unsafe archive member: {member}")
        bundle.extractall(layer_dir)
    archive.unlink(missing_ok=True)
    if not shapefile.exists():
        raise FileNotFoundError(f"Expected Natural Earth shapefile was not found: {shapefile}")
    return shapefile


def make_data_readable() -> None:
    # The official server serves requests as www-data. Keep generated input files
    # read-only while allowing that service account to traverse and read them.
    for path in (ROOT, *ROOT.rglob("*")):
        path.chmod(0o755 if path.is_dir() else 0o644)


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    if (ROOT / "world.qgs").exists():
        make_data_readable()
        print("World project already prepared; keeping the existing data volume.", flush=True)
        return

    shapefiles = {name: download_and_extract(name, url) for name, url in SOURCES.items()}

    QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX_PATH", "/usr"), True)
    app = QgsApplication([], False)
    app.initQgis()

    project = QgsProject.instance()
    project.setFilePathStorage(Qgis.FilePathType.Relative)
    project.setCrs(QgsCoordinateReferenceSystem("EPSG:3857"))
    project.setTitle("Crete Valley GIS — World")
    project.setBackgroundColor(QColor("#e5edf0"))

    metadata = project.metadata()
    metadata.setTitle("Crete Valley GIS — World")
    metadata.setAbstract(
        "A lightweight world basemap prepared from Natural Earth 1:110m land, country, and boundary data."
    )
    project.setMetadata(metadata)

    land = QgsVectorLayer(str(shapefiles["land"]), "land", "ogr")
    countries = QgsVectorLayer(str(shapefiles["countries"]), "countries", "ogr")
    boundaries = QgsVectorLayer(str(shapefiles["boundaries"]), "boundaries", "ogr")
    for layer in (land, countries, boundaries):
        if not layer.isValid():
            raise RuntimeError(f"Could not load Natural Earth layer: {layer.name()}")

    land.renderer().setSymbol(
        QgsFillSymbol.createSimple(
            {
                "color": "#eef1e9",
                "outline_color": "#c3cfcb",
                "outline_width": "0.12",
                "joinstyle": "round",
            }
        )
    )
    countries.renderer().setSymbol(
        QgsFillSymbol.createSimple(
            {
                "style": "no",
                "outline_color": "#aebdbc",
                "outline_width": "0.18",
                "joinstyle": "round",
            }
        )
    )
    boundaries.renderer().setSymbol(
        QgsLineSymbol.createSimple(
            {
                "line_color": "#91a5aa",
                "line_width": "0.16",
                "line_style": "solid",
                "joinstyle": "round",
            }
        )
    )

    for layer in (land, countries, boundaries):
        project.addMapLayer(layer)

    project_path = ROOT / "world.qgs"
    project.setFileName(str(project_path))
    if not project.write():
        raise RuntimeError(f"Could not write the QGIS project: {project_path}")

    make_data_readable()
    print(f"Prepared {project_path} with layers land, countries, boundaries.", flush=True)
    app.exitQgis()


if __name__ == "__main__":
    main()
