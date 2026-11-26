#!/usr/bin/python3
"""Prepare an incremental QGIS project from selected Natural Earth datasets."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import urllib.request
import zipfile

from qgis.core import (
    Qgis,
    QgsApplication,
    QgsCoordinateReferenceSystem,
    QgsFillSymbol,
    QgsLineSymbol,
    QgsMarkerSymbol,
    QgsPalLayerSettings,
    QgsProperty,
    QgsProject,
    QgsTextBufferSettings,
    QgsTextFormat,
    QgsVectorLayer,
    QgsVectorLayerSimpleLabeling,
)
from qgis.PyQt.QtGui import QColor, QFont


ROOT = Path("/io/data/world")
DATA_DIR = ROOT / "data"
MANIFEST_PATH = ROOT / "data-manifest.json"
PROJECT_PATH = ROOT / "world.qgs"
NATURAL_EARTH = "https://naturalearth.s3.amazonaws.com"


def dataset_url(scale: str, category: str, name: str) -> str:
    return f"{NATURAL_EARTH}/{scale}m_{category}/ne_{scale}m_{name}.zip"


DATASETS = {
    f"{layer}_{scale}": {
        "url": dataset_url(scale, category, source),
        "source": f"ne_{scale}m_{source}.shp",
    }
    for scale in ("110", "50", "10")
    for layer, category, source in (
        ("land", "physical", "land"),
        ("countries", "cultural", "admin_0_countries"),
        ("boundaries", "cultural", "admin_0_boundary_lines_land"),
        ("localities", "cultural", "populated_places"),
        ("rivers", "physical", "rivers_lake_centerlines"),
        ("lakes", "physical", "lakes"),
    )
}

# Official Natural Earth zip archive SHA-256 fingerprints. These are pinned so
# the reproducible local preparation never silently accepts changed downloads.
ARCHIVE_SHA256 = {
    "land_110": "1926c621afd6ac67c3f36639bb1236134a48d82226dc675d3e3df53d02d2a3de",
    "countries_110": "0f243aeac8ac6cf26f0417285b0bd33ac47f1b5bdb719fd3e0df37d03ea37110",
    "boundaries_110": "bb2954981570498a4b4344f8e83fa54caa5858e15e800094112407d2bd2f940d",
    "localities_110": "29b901a2ae0a745741c0642123480e31101ed723086c4d0cae657a8d722c3b28",
    "rivers_110": "1a010128c0801de738307eda7fd0ad3533a5985bc7e223c6640bdd749495f655",
    "lakes_110": "f2eed3c738a93010770acb0ba44273ea6a83b053641588bc902d9d6fd1cdafcb",
    "land_50": "0b8e670cf80dce9cbebe2a193bc44ba5602758c22e1fa603980553646d7ff162",
    "countries_50": "5fed433373581fa648920435f937d95f2d3c0200e067409c6478dcdf1b853139",
    "boundaries_50": "02f369ae10578c4ce33fc4a08f8cdd69ea11eb39b44d7923e88eb7199aaff8ea",
    "localities_50": "9022c3be867be79c44bd6fc6ff4dcc210e85ffee13b033bf4d1d87d83c9ee6b4",
    "rivers_50": "c607d9d7e7702827a7996fff6dc17b87a338c5ed3b52d12c402e0c9669cc7b56",
    "lakes_50": "f28d42c286d96b57a17aac2cbeb432f8c65532c20063495711fbc64e24666df3",
    "land_10": "e547d749445eaa0964aba76738090ec88f5e63c4585122170f98c67a7ea922dc",
    "countries_10": "ce1ac7036499a0edd641fbc093cd209a98f96a49d2eca8480aaacad35138a7f6",
    "boundaries_10": "16ead035f539c8b6c23650c5845d86ad3556553e7456bdf9b4730210f26aacbe",
    "localities_10": "cd149186f03d2603e0410da399b980a4357d0ac32d3a2305a49ed3dffcc41d7b",
    "rivers_10": "ded71b01870855ccfe19b51f2ec14c9bb48fae23c0e9f3c11974d426433b5c38",
    "lakes_10": "0803a06f9c3cb4671d89b68c48b142aad9366ba40f665245e12a913fbc61722a",
}

SCALES = {
    # QgsMapLayer minimum = most zoomed out; maximum = most zoomed in.
    "110": (0, 50_000_000),
    "50": (50_000_000, 5_000_000),
    "10": (5_000_000, 0),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def component_hashes(shapefile: Path) -> dict[str, str]:
    required = (".shp", ".shx", ".dbf", ".prj")
    hashes = {}
    for suffix in required:
        component = shapefile.with_suffix(suffix)
        if not component.is_file() or component.stat().st_size == 0:
            raise ValueError(f"Missing or empty Natural Earth component: {component}")
        hashes[suffix] = sha256_file(component)
    return hashes


def is_valid_vector(path: Path) -> bool:
    layer = QgsVectorLayer(str(path), path.stem, "ogr")
    return layer.isValid() and layer.featureCount() > 0


def safe_extract(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        for member in members:
            member_path = PurePosixPath(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise ValueError(f"Unsafe archive member: {member.filename}")
        bundle.extractall(destination)


def read_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        return {"format": 1, "datasets": {}}
    try:
        manifest = json.loads(MANIFEST_PATH.read_text())
        if manifest.get("format") != 1 or not isinstance(manifest.get("datasets"), dict):
            raise ValueError("Unsupported Natural Earth data manifest")
        return manifest
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot read Natural Earth manifest {MANIFEST_PATH}: {error}") from error


def existing_dataset_path(key: str) -> Path | None:
    # Reuse the original 1:110m files from the first world-map milestone.
    legacy = {
        "land_110": DATA_DIR / "land" / "ne_110m_land.shp",
        "countries_110": DATA_DIR / "countries" / "ne_110m_admin_0_countries.shp",
        "boundaries_110": DATA_DIR / "boundaries" / "ne_110m_admin_0_boundary_lines_land.shp",
    }.get(key)
    if legacy and legacy.is_file():
        return legacy

    expected = ARCHIVE_SHA256.get(key)
    if not expected:
        return None
    target = DATA_DIR / key / expected[:12] / DATASETS[key]["source"]
    return target if target.is_file() else None


def download_dataset(key: str) -> tuple[Path, int]:
    info = DATASETS[key]
    url = info["url"]
    expected_hash = ARCHIVE_SHA256.get(key)
    if not expected_hash:
        raise RuntimeError(f"Missing pinned archive SHA-256 for {key}; download aborted")

    archive_file = tempfile.NamedTemporaryFile(prefix=f"natural-earth-{key}-", suffix=".zip", delete=False)
    archive_path = Path(archive_file.name)
    downloaded_bytes = 0
    request = urllib.request.Request(url, headers={"User-Agent": "CreteValleyGIS/0.2 (local development)"})
    try:
        with archive_file as output, urllib.request.urlopen(request, timeout=90) as response:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                downloaded_bytes += len(chunk)
        digest = sha256_file(archive_path)
        if digest != expected_hash:
            raise ValueError(f"Natural Earth archive checksum mismatch for {key}: {digest}")

        target_dir = DATA_DIR / key / digest[:12]
        if target_dir.exists():
            # Never remove or overwrite previous input data. A corrupt copy gets
            # a new sibling directory so it remains available for inspection.
            repair_number = 1
            while (DATA_DIR / key / f"{digest[:12]}-repair-{repair_number}").exists():
                repair_number += 1
            target_dir = DATA_DIR / key / f"{digest[:12]}-repair-{repair_number}"
        target_dir.mkdir(parents=True, exist_ok=False)
        safe_extract(archive_path, target_dir)
        shapefile = target_dir / info["source"]
        if not shapefile.is_file() or not is_valid_vector(shapefile):
            raise RuntimeError(f"Downloaded Natural Earth dataset {key} is not a valid shapefile")
        component_hashes(shapefile)
        return shapefile, downloaded_bytes
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise
    finally:
        archive_path.unlink(missing_ok=True)


def prepare_datasets(app: QgsApplication) -> tuple[dict[str, Path], dict, int]:
    manifest = read_manifest()
    updated_datasets = dict(manifest["datasets"])
    shapefiles: dict[str, Path] = {}
    downloaded_bytes = 0

    for key, info in DATASETS.items():
        expected_hash = ARCHIVE_SHA256.get(key)
        if not expected_hash:
            raise RuntimeError(f"Missing pinned archive SHA-256 for {key}; refusing unverified data")
        candidate = existing_dataset_path(key)
        entry = updated_datasets.get(key, {})
        candidate_is_valid = False
        if candidate and candidate.is_file():
            try:
                current_components = component_hashes(candidate)
                candidate_is_valid = is_valid_vector(candidate)
                if entry and (
                    entry.get("archive_sha256") != expected_hash
                    or entry.get("components") != current_components
                ):
                    candidate_is_valid = False
            except (OSError, ValueError):
                current_components = {}
                candidate_is_valid = False
        else:
            current_components = {}

        if candidate_is_valid:
            shapefiles[key] = candidate
            updated_datasets[key] = {
                "url": info["url"],
                "archive_sha256": expected_hash,
                "components": current_components,
            }
            print(f"Reusing verified Natural Earth data: {key}", flush=True)
            continue

        candidate, received = download_dataset(key)
        downloaded_bytes += received
        components = component_hashes(candidate)
        if not is_valid_vector(candidate):
            raise RuntimeError(f"Natural Earth data became invalid while preparing {key}")
        shapefiles[key] = candidate
        updated_datasets[key] = {
            "url": info["url"],
            "archive_sha256": expected_hash,
            "components": components,
        }
        print(f"Downloaded {key}: {received} bytes, sha256={expected_hash}", flush=True)

    manifest = {"format": 1, "datasets": updated_datasets}
    temp_manifest = MANIFEST_PATH.with_suffix(".json.tmp")
    temp_manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    os.replace(temp_manifest, MANIFEST_PATH)
    return shapefiles, manifest, downloaded_bytes


def first_field(layer: QgsVectorLayer, candidates: tuple[str, ...]) -> str | None:
    fields = {field.name().casefold(): field.name() for field in layer.fields()}
    return next((fields[name.casefold()] for name in candidates if name.casefold() in fields), None)


def set_labeling(
    layer: QgsVectorLayer,
    field_name: str,
    *,
    size: float,
    color: str,
    placement: Qgis.LabelPlacement,
    rank_field: str | None = None,
    max_rank: int | None = None,
    buffer_color: str = "#f7f7f1",
    buffer_size: float = 0.75,
) -> None:
    settings = QgsPalLayerSettings()
    settings.fieldName = field_name
    settings.placement = placement
    settings.priority = 5
    if rank_field and max_rank is not None:
        settings.dataDefinedProperties().setProperty(
            QgsPalLayerSettings.Property.Show,
            QgsProperty.fromExpression(f'"{rank_field}" <= {max_rank}'),
        )

    text_format = QgsTextFormat()
    font = QFont("Noto Sans")
    font.setPointSizeF(size)
    text_format.setFont(font)
    text_format.setSize(size)
    text_format.setColor(QColor(color))
    buffer = QgsTextBufferSettings()
    buffer.setEnabled(True)
    buffer.setSize(buffer_size)
    buffer.setColor(QColor(buffer_color))
    text_format.setBuffer(buffer)
    settings.setFormat(text_format)
    layer.setLabeling(QgsVectorLayerSimpleLabeling(settings))
    layer.setLabelsEnabled(True)


def set_scale(layer: QgsVectorLayer, scale: str) -> None:
    minimum, maximum = SCALES[scale]
    layer.setScaleBasedVisibility(True)
    layer.setMinimumScale(minimum)
    layer.setMaximumScale(maximum)


def add_layer(project: QgsProject, path: Path, name: str, scale: str) -> QgsVectorLayer:
    layer = QgsVectorLayer(str(path), name, "ogr")
    if not layer.isValid():
        raise RuntimeError(f"Could not load Natural Earth layer: {name} ({path})")
    set_scale(layer, scale)
    project.addMapLayer(layer)
    return layer


def style_land(layer: QgsVectorLayer, scale: str) -> None:
    outline = {"110": "#c5d0ca", "50": "#bdcbc4", "10": "#b5c5bd"}[scale]
    width = {"110": "0.10", "50": "0.12", "10": "0.14"}[scale]
    layer.renderer().setSymbol(QgsFillSymbol.createSimple({
        "color": "#eef1e9", "outline_color": outline, "outline_width": width, "joinstyle": "round",
    }))


def style_countries(layer: QgsVectorLayer, scale: str) -> None:
    layer.renderer().setSymbol(QgsFillSymbol.createSimple({
        "style": "no", "outline_style": "no",
    }))
    field_name = first_field(layer, ("NAME_EN", "NAME"))
    if field_name:
        rank_field = first_field(layer, ("LABELRANK",))
        set_labeling(
            layer, field_name, size={"110": 8.2, "50": 8.5, "10": 8.8}[scale],
            color="#314b5c", placement=Qgis.LabelPlacement.Horizontal,
            rank_field=rank_field, max_rank={"110": 3, "50": 6, "10": 10}[scale],
            buffer_color="#eef1e9", buffer_size=0.85,
        )


def style_boundaries(layer: QgsVectorLayer, scale: str) -> None:
    width = {"110": "0.15", "50": "0.18", "10": "0.21"}[scale]
    layer.renderer().setSymbol(QgsLineSymbol.createSimple({
        "line_color": "#91a5aa", "line_width": width, "line_style": "solid", "joinstyle": "round",
    }))


def style_localities(layer: QgsVectorLayer, scale: str) -> None:
    layer.renderer().setSymbol(QgsMarkerSymbol.createSimple({
        "name": "circle", "color": "#134f8a", "outline_color": "#ffffff",
        "outline_width": "0.18", "size": {"110": "0.55", "50": "0.7", "10": "0.8"}[scale],
    }))
    name_field = first_field(layer, ("NAME", "NAMEASCII"))
    if name_field:
        rank_field = first_field(layer, ("SCALERANK", "LABELRANK"))
        set_labeling(layer, name_field, size={"110": 7.2, "50": 7.5, "10": 7.8}[scale],
                     color="#365061", placement=Qgis.LabelPlacement.AroundPoint,
                     rank_field=rank_field, max_rank={"110": 2, "50": 5, "10": 8}[scale],
                     buffer_color="#f7f7f1", buffer_size=0.8)


def style_rivers(layer: QgsVectorLayer, scale: str) -> None:
    width = {"110": "0.16", "50": "0.20", "10": "0.25"}[scale]
    layer.renderer().setSymbol(QgsLineSymbol.createSimple({
        "line_color": "#70b6ce", "line_width": width, "line_style": "solid", "joinstyle": "round",
    }))
    name_field = first_field(layer, ("name", "name_en", "namealt"))
    if name_field:
        rank_field = first_field(layer, ("scalerank", "labelrank"))
        set_labeling(layer, name_field, size=7.2, color="#4c91ac",
                     placement=Qgis.LabelPlacement.Curved, rank_field=rank_field,
                     max_rank={"110": 2, "50": 5, "10": 8}[scale],
                     buffer_color="#eef1e9", buffer_size=0.65)


def style_lakes(layer: QgsVectorLayer, scale: str) -> None:
    layer.renderer().setSymbol(QgsFillSymbol.createSimple({
        "color": "#b8dce4", "outline_color": "#79b3c4",
        "outline_width": {"110": "0.10", "50": "0.13", "10": "0.16"}[scale],
    }))
    name_field = first_field(layer, ("name", "name_en", "namealt"))
    if name_field:
        rank_field = first_field(layer, ("scalerank", "labelrank"))
        set_labeling(layer, name_field, size=7.1, color="#467f93",
                     placement=Qgis.LabelPlacement.Horizontal, rank_field=rank_field,
                     max_rank={"110": 3, "50": 6, "10": 10}[scale],
                     buffer_color="#dceef0", buffer_size=0.6)


def make_data_readable(shapefiles: dict[str, Path]) -> None:
    # QGIS Server reads this named volume as www-data; it remains non-writable.
    directories = {ROOT, DATA_DIR}
    files = {MANIFEST_PATH, PROJECT_PATH}
    for shapefile in shapefiles.values():
        directory = shapefile.parent
        while directory == DATA_DIR or DATA_DIR in directory.parents:
            directories.add(directory)
            if directory == DATA_DIR:
                break
            directory = directory.parent
        files.update(path for path in shapefile.parent.glob(f"{shapefile.stem}.*") if path.is_file())
    for path in directories:
        if path.exists():
            path.chmod(0o755)
    for path in files:
        if path.is_file():
            path.chmod(0o644)


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX_PATH", "/usr"), True)
    app = QgsApplication([], False)
    app.initQgis()

    shapefiles, manifest, downloaded_bytes = prepare_datasets(app)
    project = QgsProject.instance()
    project.clear()
    project.setFilePathStorage(Qgis.FilePathType.Relative)
    project.setCrs(QgsCoordinateReferenceSystem("EPSG:3857"))
    project.setTitle("Crete Valley GIS — World")
    project.setBackgroundColor(QColor("#e5edf0"))

    metadata = project.metadata()
    metadata.setTitle("Crete Valley GIS — World")
    metadata.setAbstract(
        "World cartography from selected Natural Earth 1:110m, 1:50m and 1:10m datasets. "
        "Thematic layers: country boundaries, populated places, rivers and lakes."
    )
    project.setMetadata(metadata)

    layers_by_name = {}
    for scale in ("110", "50", "10"):
        land = add_layer(project, shapefiles[f"land_{scale}"], f"land_{scale}m", scale)
        style_land(land, scale)
        layers_by_name[land.name()] = land

        countries = add_layer(project, shapefiles[f"countries_{scale}"], f"countries_{scale}m", scale)
        style_countries(countries, scale)
        layers_by_name[countries.name()] = countries

        boundaries = add_layer(project, shapefiles[f"boundaries_{scale}"], f"boundaries_{scale}m", scale)
        style_boundaries(boundaries, scale)
        layers_by_name[boundaries.name()] = boundaries

        localities = add_layer(project, shapefiles[f"localities_{scale}"], f"localities_{scale}m", scale)
        style_localities(localities, scale)
        layers_by_name[localities.name()] = localities

        rivers = add_layer(project, shapefiles[f"rivers_{scale}"], f"rivers_{scale}m", scale)
        style_rivers(rivers, scale)
        layers_by_name[rivers.name()] = rivers

        lakes = add_layer(project, shapefiles[f"lakes_{scale}"], f"lakes_{scale}m", scale)
        style_lakes(lakes, scale)
        layers_by_name[lakes.name()] = lakes

    root = project.layerTreeRoot()
    root.setHasCustomLayerOrder(True)
    root.setCustomLayerOrder(list(layers_by_name.values()))

    # Write beside the existing project, then replace it atomically so a failed
    # update leaves the previously serving project intact.
    temp_project_path = ROOT / "world.next.qgs"
    project.setFileName(str(temp_project_path))
    if not project.write():
        raise RuntimeError(f"Could not write the QGIS project: {temp_project_path}")
    os.replace(temp_project_path, PROJECT_PATH)
    make_data_readable(shapefiles)

    # Shapefile components are small; use a direct tree walk for the disk total.
    data_bytes = sum(path.stat().st_size for path in DATA_DIR.rglob("*") if path.is_file())
    print(f"Prepared {PROJECT_PATH} with {len(layers_by_name)} scale-specific layers.", flush=True)
    print(f"Natural Earth bytes downloaded this run: {downloaded_bytes}", flush=True)
    print(f"Natural Earth data volume size: {data_bytes} bytes", flush=True)
    print(f"Manifest tracks {len(manifest['datasets'])} verified datasets.", flush=True)
    app.exitQgis()


if __name__ == "__main__":
    main()
