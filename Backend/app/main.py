from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import subprocess
import threading
from typing import Any
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from osgeo import gdal

from terrain_request import (
    MAX_BBOX_SPAN_DEGREES,
    MAX_RASTER_PIXELS,
    MAX_TILES_PER_RUN,
    PROCESSING_RESOLUTION_M,
    selected_tiles,
    validate_bbox_values,
)
from terrain_derivative_config import DERIVATIVE_STYLE_VERSION
from terrain_style_config import REGIONAL_ELEVATION_STYLE_VERSION, regional_elevation_style
from app.zonal_statistics import SCHEMA_VERSION as ZONAL_STATISTICS_SCHEMA_VERSION
from app.zonal_statistics import calculate_zonal_terrain_statistics, geometry_bbox_wgs84


REGION_ROOT = Path(os.environ.get("TERRAIN_REGION_ROOT", "/io/data/terrain/regions"))
SCRIPT_PATH = Path(os.environ.get("TERRAIN_SCRIPT_PATH", "/io/scripts/prepare-terrain.py"))
STYLE_REFRESH_SCRIPT_PATH = Path(os.environ.get(
    "TERRAIN_STYLE_REFRESH_SCRIPT_PATH", "/io/scripts/refresh-terrain-style.py"
))
WMS_URL = os.environ.get("PUBLIC_QGIS_WMS_URL", "http://localhost:8085/ogc/world")
ANALYSIS_ROOT = REGION_ROOT.parent / "analyses"
ANALYSIS_SCHEMA_VERSION = f"terrain-zonal-{ZONAL_STATISTICS_SCHEMA_VERSION}-{DERIVATIVE_STYLE_VERSION}"
COPERNICUS_SOURCE = "Copernicus DEM GLO-30 Public"
ANALYSIS_ID_PATTERN = re.compile(r"^[0-9a-f]{16}$")
ANALYSIS_STATUS_LABELS = {
    "queued": "Pendiente",
    "checking_data": "Comprobando datos",
    "preparing_elevation": "Preparando elevaciones",
    "generating_derivatives": "Generando pendientes y orientación",
    "calculating_statistics": "Calculando estadísticas",
    "completed": "Completado",
    "failed": "Error",
}


def positive_timeout(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive integer") from error
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


JOB_TIMEOUT_SECONDS = positive_timeout("TERRAIN_JOB_TIMEOUT_SECONDS", 1800)
STYLE_REFRESH_TIMEOUT_SECONDS = positive_timeout("TERRAIN_STYLE_REFRESH_TIMEOUT_SECONDS", 120)

REGION_ROOT.mkdir(parents=True, exist_ok=True)
ANALYSIS_ROOT.mkdir(parents=True, exist_ok=True)


class TerrainPreparationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)

    area_name: str = Field(min_length=1, max_length=80)
    bbox_wgs84: tuple[float, float, float, float]

    @field_validator("bbox_wgs84")
    @classmethod
    def validate_extent(cls, value: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
        bbox = validate_bbox_values(tuple(round(coordinate, 8) for coordinate in value))
        selected_tiles(bbox)
        return bbox


class TerrainAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)

    area_name: str = Field(min_length=1, max_length=80)
    geometry: dict[str, Any]

    @field_validator("geometry")
    @classmethod
    def validate_geometry(cls, value: dict[str, Any]) -> dict[str, Any]:
        bbox = geometry_bbox_wgs84(value)
        selected_tiles(tuple(round(coordinate, 8) for coordinate in bbox))
        return value


@dataclass
class TerrainJob:
    job_id: str
    area_name: str
    bbox_wgs84: tuple[float, float, float, float]
    status: str = "queued"
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    started_at: str | None = None
    completed_at: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    reused: bool = False
    derivatives_status: str = "idle"
    derivatives_started_at: str | None = None
    derivatives_completed_at: str | None = None
    derivatives_error: str | None = None


@dataclass
class TerrainAnalysisJob:
    analysis_id: str
    area_name: str
    geometry: dict[str, Any]
    bbox_wgs84: tuple[float, float, float, float]
    status: str = "queued"
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    started_at: str | None = None
    completed_at: str | None = None
    result: dict[str, Any] | None = None
    source: str | None = None
    resolution_m: int | None = None
    horizontal_crs: str | None = None
    terrain_job_id: str | None = None
    raster_paths: dict[str, str] | None = None
    raster_fingerprints: dict[str, dict[str, Any]] | None = None
    terrain_reused: bool = False
    derivatives_reused: bool = False
    reused: bool = False
    error: dict[str, str] | None = None


jobs: dict[str, TerrainJob] = {}
analysis_jobs: dict[str, TerrainAnalysisJob] = {}
jobs_lock = threading.Lock()
active_job_id: str | None = None
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="terrain-preparation")

logger = logging.getLogger("cretevalleygis.analysis")


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(
    title="Crete Valley GIS Backend",
    version="0.1.0",
    description="Local API for preparing Copernicus terrain and running zonal terrain analysis.",
    lifespan=lifespan,
)


def request_id_for(area_name: str, bbox_wgs84: tuple[float, float, float, float]) -> str:
    canonical = {
        "area_name": area_name.casefold(),
        "bbox_wgs84": [round(value, 8) for value in bbox_wgs84],
    }
    payload = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def request_id(request: TerrainPreparationRequest) -> str:
    return request_id_for(request.area_name, request.bbox_wgs84)


def region_directory(job_id: str) -> Path:
    return REGION_ROOT / job_id


def persist_path(job_id: str) -> Path:
    return region_directory(job_id) / "result.json"


def result_is_ready(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    files = result.get("storage", {})
    return all(
        isinstance(files.get(key), str) and Path(files[key]).is_file()
        for key in ("project_file", "elevation_raster", "hillshade_raster")
    )


def derivatives_are_ready(result: Any) -> bool:
    if not isinstance(result, dict) or not isinstance(result.get("derivatives"), dict):
        return False
    files = result.get("storage", {})
    return all(
        isinstance(files.get(key), str) and Path(files[key]).is_file()
        for key in ("slope_raster", "aspect_raster", "aspect_display_raster")
    )


def discard_broken_derivative_references(result: dict[str, Any]) -> bool:
    if derivatives_are_ready(result):
        return True
    result.pop("derivatives", None)
    storage = result.get("storage", {})
    for key in ("slope_raster", "aspect_raster", "aspect_display_raster"):
        storage.pop(key, None)
    layers = result.get("cartography", {}).get("layers", {})
    for key in ("slope", "aspect"):
        layers.pop(key, None)
    return False


def make_cartography_reference(project_path: Path, script_result: dict[str, Any], reused: bool) -> dict[str, Any]:
    project = str(project_path)
    capabilities_query = urlencode({
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetCapabilities",
        "MAP": project,
    })
    map_query = urlencode({
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "MAP": project,
        "LAYERS": "terrain_hillshade,terrain_elevation",
        "STYLES": "",
        "CRS": script_result["crs"],
        "BBOX": "<xmin>,<ymin>,<xmax>,<ymax>",
        "WIDTH": "1024",
        "HEIGHT": "768",
        "FORMAT": "image/png",
        "TRANSPARENT": "TRUE",
    })
    return {
        "coverage": {
            "area_name": script_result["area_name"],
            "extent_wgs84": script_result["bbox_wgs84"],
            "resolution_m": script_result["resolution_m"],
            "elevation_min_m": script_result["elevation_min_m"],
            "elevation_max_m": script_result["elevation_max_m"],
            "elevation_style": script_result["elevation_style"],
            "horizontal_crs": script_result["crs"],
            "vertical_datum": script_result["vertical_datum"],
            "nodata": script_result["nodata"],
        },
        "storage": {
            "project_file": project,
            "elevation_raster": script_result["elevation_path"],
            "hillshade_raster": script_result["hillshade_path"],
        },
        "cartography": {
            "service_url": WMS_URL,
            "map_parameter": project,
            "get_capabilities_url": f"{WMS_URL}?{capabilities_query}",
            "get_map_template": f"{WMS_URL}?{map_query}",
            "layers": {
                "hillshade": "terrain_hillshade",
                "elevation": "terrain_elevation",
            },
        },
        "preparation": {
            "source_tile_count": script_result["source_tile_count"],
            "source_downloaded_bytes": script_result["source_downloaded_bytes"],
            "reused": reused,
        },
    }


def job_response(job: TerrainJob) -> dict[str, Any]:
    body: dict[str, Any] = {
        "job_id": job.job_id,
        "status": job.status,
        "area_name": job.area_name,
        "bbox_wgs84": list(job.bbox_wgs84),
        "created_at": job.created_at,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "reused": job.reused,
        "status_url": f"/api/terrain/jobs/{job.job_id}",
        "result_url": f"/api/terrain/jobs/{job.job_id}/result" if job.status == "completed" else None,
        "derivatives": {
            "status": job.derivatives_status,
            "started_at": job.derivatives_started_at,
            "completed_at": job.derivatives_completed_at,
            "error": job.derivatives_error,
            "result": job.result.get("derivatives") if derivatives_are_ready(job.result) else None,
        },
    }
    if job.result is not None:
        body["result"] = job.result
    if job.error is not None:
        body["error"] = job.error
    return body


def load_persisted_job(job_id: str) -> TerrainJob | None:
    if not re.fullmatch(r"[0-9a-f]{16}", job_id):
        return None
    path = persist_path(job_id)
    if not path.is_file():
        return None
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        result = saved.get("result")
        if not result_is_ready(result):
            return None
        coverage = result["coverage"]
        area_name = coverage["area_name"]
        bbox = validate_bbox_values(coverage["extent_wgs84"])
        if saved.get("job_id") != job_id or request_id_for(area_name, bbox) != job_id:
            return None
        result.setdefault("preparation", {})["reused"] = True
        derivatives_status = "completed" if discard_broken_derivative_references(result) else "idle"
        return TerrainJob(
            job_id=job_id,
            area_name=area_name,
            bbox_wgs84=bbox,
            status="completed",
            created_at=saved.get("created_at", datetime.now(timezone.utc).isoformat()),
            completed_at=saved.get("completed_at", datetime.now(timezone.utc).isoformat()),
            result=result,
            reused=True,
            derivatives_status=derivatives_status,
        )
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def write_persisted_job(job: TerrainJob) -> None:
    path = persist_path(job.job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps({
            "job_id": job.job_id,
            "created_at": job.created_at,
            "completed_at": job.completed_at,
            "result": job.result,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def execute_job(job: TerrainJob) -> None:
    global active_job_id
    with jobs_lock:
        job.status = "running"
        job.started_at = datetime.now(timezone.utc).isoformat()

    project_path = region_directory(job.job_id) / "terrain.qgs"
    command = [
        "/usr/bin/python3",
        str(SCRIPT_PATH),
        f"--bbox={','.join(f'{value:.8f}' for value in job.bbox_wgs84)}",
        "--name",
        job.area_name,
        "--project-path",
        str(project_path),
    ]
    environment = os.environ.copy()
    environment.update({"QGIS_PREFIX_PATH": "/usr", "QT_QPA_PLATFORM": "offscreen", "PYTHONUNBUFFERED": "1"})
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            timeout=JOB_TIMEOUT_SECONDS,
        )
        if completed.returncode != 0:
            diagnostic = (completed.stderr or completed.stdout or "Terrain preparation failed.").strip()
            raise RuntimeError(diagnostic[-3000:])
        result_line = next(
            (line.removeprefix("RESULT_JSON=") for line in reversed(completed.stdout.splitlines()) if line.startswith("RESULT_JSON=")),
            None,
        )
        if not result_line:
            raise RuntimeError("Terrain preparation finished without its result metadata.")
        script_result = json.loads(result_line)
        result = make_cartography_reference(project_path, script_result, reused=False)
        if not result_is_ready(result):
            raise RuntimeError("Terrain preparation did not produce its project and both rasters.")
        with jobs_lock:
            job.result = result
            job.status = "completed"
            job.completed_at = datetime.now(timezone.utc).isoformat()
            write_persisted_job(job)
    except subprocess.TimeoutExpired:
        with jobs_lock:
            job.status = "failed"
            job.completed_at = datetime.now(timezone.utc).isoformat()
            job.error = f"Terrain preparation exceeded the {JOB_TIMEOUT_SECONDS // 60}-minute time limit."
    except Exception as error:  # Keep the failure visible through the polling API.
        with jobs_lock:
            job.status = "failed"
            job.completed_at = datetime.now(timezone.utc).isoformat()
            job.error = str(error)[:3000]
    finally:
        with jobs_lock:
            if active_job_id == job.job_id:
                active_job_id = None


def refresh_cached_job_style(job: TerrainJob) -> None:
    """Restyle a cached project without downloading or rebuilding its rasters."""
    global active_job_id
    with jobs_lock:
        job.status = "running"
        job.started_at = datetime.now(timezone.utc).isoformat()

    try:
        if not STYLE_REFRESH_SCRIPT_PATH.is_file():
            raise RuntimeError("regional terrain style refresh script is unavailable")
        if job.result is None:
            raise RuntimeError("cached terrain result is missing")
        coverage = job.result["coverage"]
        style = regional_elevation_style(
            coverage["elevation_min_m"], coverage["elevation_max_m"]
        )
        command = [
            "/usr/bin/python3",
            str(STYLE_REFRESH_SCRIPT_PATH),
            "--project-path",
            str(job.result["storage"]["project_file"]),
            "--minimum-m",
            str(coverage["elevation_min_m"]),
            "--maximum-m",
            str(coverage["elevation_max_m"]),
        ]
        environment = os.environ.copy()
        environment.update({"QGIS_PREFIX_PATH": "/usr", "QT_QPA_PLATFORM": "offscreen", "PYTHONUNBUFFERED": "1"})
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            timeout=STYLE_REFRESH_TIMEOUT_SECONDS,
        )
        if completed.returncode != 0:
            diagnostic = (completed.stderr or completed.stdout or "Regional style refresh failed.").strip()
            raise RuntimeError(diagnostic[-3000:])
        style_line = next(
            (line.removeprefix("RESULT_STYLE_JSON=") for line in reversed(completed.stdout.splitlines()) if line.startswith("RESULT_STYLE_JSON=")),
            None,
        )
        if not style_line:
            raise RuntimeError("Regional style refresh finished without style metadata.")
        style = json.loads(style_line)
        if style.get("version") != REGIONAL_ELEVATION_STYLE_VERSION:
            raise RuntimeError("Regional style refresh returned an unsupported style version.")

        with jobs_lock:
            coverage["elevation_style"] = style
            job.result.setdefault("preparation", {})["style_refreshed"] = True
            job.status = "completed"
            job.reused = True
            job.completed_at = datetime.now(timezone.utc).isoformat()
            write_persisted_job(job)
    except subprocess.TimeoutExpired:
        with jobs_lock:
            job.status = "failed"
            job.completed_at = datetime.now(timezone.utc).isoformat()
            job.error = "The cached terrain project took too long to update its style."
    except Exception as error:
        with jobs_lock:
            job.status = "failed"
            job.completed_at = datetime.now(timezone.utc).isoformat()
            job.error = str(error)[:3000]
    finally:
        with jobs_lock:
            if active_job_id == job.job_id:
                active_job_id = None


def execute_derivative_job(job: TerrainJob) -> None:
    """Add derived rasters to a completed region without rebuilding its DEM."""
    global active_job_id
    with jobs_lock:
        job.derivatives_status = "running"
        job.derivatives_started_at = datetime.now(timezone.utc).isoformat()
        job.derivatives_completed_at = None
        job.derivatives_error = None

    try:
        if job.result is None or not result_is_ready(job.result):
            raise RuntimeError("The prepared elevation and regional project are not available.")
        coverage = job.result["coverage"]
        storage = job.result["storage"]
        command = [
            "/usr/bin/python3",
            str(SCRIPT_PATH),
            "--derive-slope-aspect",
            "--elevation-path",
            storage["elevation_raster"],
            "--horizontal-crs",
            coverage["horizontal_crs"],
            f"--bbox={','.join(f'{value:.8f}' for value in coverage['extent_wgs84'])}",
            "--name",
            coverage["area_name"],
            "--project-path",
            storage["project_file"],
        ]
        environment = os.environ.copy()
        environment.update({"QGIS_PREFIX_PATH": "/usr", "QT_QPA_PLATFORM": "offscreen", "PYTHONUNBUFFERED": "1"})
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            timeout=JOB_TIMEOUT_SECONDS,
        )
        if completed.returncode != 0:
            diagnostic = (completed.stderr or completed.stdout or "Terrain derivative processing failed.").strip()
            raise RuntimeError(diagnostic[-3000:])
        result_line = next(
            (
                line.removeprefix("DERIVATIVE_RESULT_JSON=")
                for line in reversed(completed.stdout.splitlines())
                if line.startswith("DERIVATIVE_RESULT_JSON=")
            ),
            None,
        )
        if not result_line:
            raise RuntimeError("Terrain derivative processing finished without result metadata.")
        derived = json.loads(result_line)
        metadata = derived["metadata"]
        if metadata.get("algorithm") != "Horn" or metadata.get("horizontal_crs") != coverage["horizontal_crs"]:
            raise RuntimeError("Terrain derivative metadata does not match the prepared region.")
        if metadata.get("resolution_m") != coverage["resolution_m"]:
            raise RuntimeError("Terrain derivative resolution does not match the prepared elevation.")
        derivative_paths = {
            "slope_raster": derived["slope_path"],
            "aspect_raster": derived["aspect_path"],
            "aspect_display_raster": derived["aspect_display_path"],
        }
        if not all(Path(path).is_file() for path in derivative_paths.values()):
            raise RuntimeError("Terrain derivative processing did not produce all three raster products.")

        with jobs_lock:
            job.result["storage"].update(derivative_paths)
            job.result["cartography"]["layers"].update({
                "slope": metadata["slope"]["wms_layer"],
                "aspect": metadata["aspect"]["wms_layer"],
            })
            job.result["derivatives"] = metadata
            job.result.setdefault("preparation", {})["derivatives_reused"] = bool(derived.get("reused"))
            job.derivatives_status = "completed"
            job.derivatives_completed_at = datetime.now(timezone.utc).isoformat()
            job.derivatives_error = None
            write_persisted_job(job)
    except subprocess.TimeoutExpired:
        with jobs_lock:
            job.derivatives_status = "failed"
            job.derivatives_completed_at = datetime.now(timezone.utc).isoformat()
            job.derivatives_error = (
                f"Terrain derivative processing exceeded the {JOB_TIMEOUT_SECONDS // 60}-minute time limit. "
                "The prepared elevation and hillshade remain available."
            )
            write_persisted_job(job)
    except Exception as error:  # Preserve the completed base terrain on derivative failures.
        with jobs_lock:
            job.derivatives_status = "failed"
            job.derivatives_completed_at = datetime.now(timezone.utc).isoformat()
            job.derivatives_error = f"{str(error)[:2800]} The prepared elevation and hillshade remain available."
            write_persisted_job(job)
    finally:
        with jobs_lock:
            if active_job_id == job.job_id:
                active_job_id = None


class AnalysisProcessingError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message


def analysis_id_for(area_name: str, geometry: dict[str, Any]) -> str:
    canonical_geometry = {"type": geometry["type"], "coordinates": geometry["coordinates"]}
    payload = json.dumps(
        {"area_name": area_name.casefold(), "geometry": canonical_geometry, "version": ANALYSIS_SCHEMA_VERSION},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def analysis_persist_path(analysis_id: str) -> Path:
    return ANALYSIS_ROOT / f"{analysis_id}.json"


def analysis_raster_paths(result: Any) -> dict[str, str] | None:
    if not isinstance(result, dict):
        return None
    storage = result.get("storage", {})
    paths = {
        "elevation": storage.get("elevation_raster"),
        "slope": storage.get("slope_raster"),
        "aspect": storage.get("aspect_raster"),
    }
    if not all(isinstance(path, str) and Path(path).is_file() for path in paths.values()):
        return None
    return paths  # The numeric aspect raster is used, never aspect_display_raster.


def raster_fingerprints(paths: dict[str, str]) -> dict[str, dict[str, Any]] | None:
    fingerprints: dict[str, dict[str, Any]] = {}
    try:
        for name, raw_path in paths.items():
            file_path = Path(raw_path)
            file_stat = file_path.stat()
            fingerprints[name] = {
                "path": str(file_path),
                "size_bytes": file_stat.st_size,
                "modified_ns": file_stat.st_mtime_ns,
            }
    except OSError:
        return None
    return fingerprints


def _terrain_covers_bbox(job: TerrainJob, bbox: tuple[float, float, float, float]) -> bool:
    if job.status != "completed" or not result_is_ready(job.result):
        return False
    try:
        west, south, east, north = bbox
        region = validate_bbox_values(job.result["coverage"]["extent_wgs84"])
        return (
            region[0] <= west + 1e-8
            and region[1] <= south + 1e-8
            and region[2] >= east - 1e-8
            and region[3] >= north - 1e-8
        )
    except (KeyError, TypeError, ValueError):
        return False


def _terrain_source_compatible(job: TerrainJob) -> bool:
    if not result_is_ready(job.result):
        return False
    try:
        coverage = job.result["coverage"]
        if not math.isclose(float(coverage["resolution_m"]), PROCESSING_RESOLUTION_M, abs_tol=1e-6):
            return False
        dataset = gdal.Open(job.result["storage"]["elevation_raster"], gdal.GA_ReadOnly)
        if dataset is None or dataset.RasterCount != 1:
            return False
        spatial_ref = dataset.GetSpatialRef()
        band = dataset.GetRasterBand(1)
        transform = dataset.GetGeoTransform()
        return bool(
            spatial_ref is not None
            and spatial_ref.IsProjected()
            and math.isclose(spatial_ref.GetLinearUnits(), 1.0, rel_tol=0.0, abs_tol=1e-9)
            and band.DataType == gdal.GDT_Float32
            and band.GetUnitType() in ("m", "metre", "meter", "metres", "meters")
            and dataset.GetMetadataItem("COPERNICUS_SOURCE") == COPERNICUS_SOURCE
            and math.isclose(abs(transform[1]), PROCESSING_RESOLUTION_M, abs_tol=1e-6)
            and math.isclose(abs(transform[5]), PROCESSING_RESOLUTION_M, abs_tol=1e-6)
        )
    except (KeyError, TypeError, ValueError, RuntimeError):
        return False


def _derivatives_compatible(job: TerrainJob) -> bool:
    if not derivatives_are_ready(job.result):
        return False
    try:
        metadata = job.result["derivatives"]
        coverage = job.result["coverage"]
        return (
            metadata.get("version") == DERIVATIVE_STYLE_VERSION
            and metadata.get("source") == COPERNICUS_SOURCE
            and metadata.get("algorithm") == "Horn"
            and metadata.get("resolution_m") == PROCESSING_RESOLUTION_M
            and metadata.get("horizontal_crs") == coverage.get("horizontal_crs")
            and metadata.get("slope", {}).get("unit") == "percent"
            and metadata.get("aspect", {}).get("unit") == "degrees"
            and metadata.get("aspect", {}).get("north_reference") == "grid_north"
        )
    except (AttributeError, TypeError):
        return False


def terrain_compatible_for_analysis(
    job: TerrainJob,
    bbox: tuple[float, float, float, float],
    *,
    require_derivatives: bool = False,
) -> bool:
    if not _terrain_covers_bbox(job, bbox) or not _terrain_source_compatible(job):
        return False
    return not require_derivatives or _derivatives_compatible(job)


def find_covering_terrain_job(bbox: tuple[float, float, float, float]) -> TerrainJob | None:
    candidates: dict[str, TerrainJob] = {}
    with jobs_lock:
        candidates.update({job.job_id: job for job in jobs.values()})
    for directory in REGION_ROOT.iterdir():
        if not directory.is_dir() or not re.fullmatch(r"[0-9a-f]{16}", directory.name):
            continue
        if directory.name not in candidates:
            persisted = load_persisted_job(directory.name)
            if persisted is not None:
                candidates[persisted.job_id] = persisted

    matches = [candidate for candidate in candidates.values() if terrain_compatible_for_analysis(candidate, bbox)]
    if not matches:
        return None

    def preference(job: TerrainJob) -> tuple[int, float]:
        west, south, east, north = job.result["coverage"]["extent_wgs84"]
        return (0 if _derivatives_compatible(job) else 1, (east - west) * (north - south))

    selected = min(matches, key=preference)
    with jobs_lock:
        return jobs.setdefault(selected.job_id, selected)


def automatic_terrain_name(bbox: tuple[float, float, float, float]) -> str:
    payload = json.dumps([round(value, 8) for value in bbox], separators=(",", ":"))
    return f"Analysis terrain {hashlib.sha256(payload.encode('utf-8')).hexdigest()[:12]}"


def get_or_create_terrain_job(bbox: tuple[float, float, float, float]) -> tuple[TerrainJob, bool]:
    area_name = automatic_terrain_name(bbox)
    request = TerrainPreparationRequest(area_name=area_name, bbox_wgs84=bbox)
    job_id = request_id(request)
    with jobs_lock:
        terrain_job = jobs.get(job_id)
        if terrain_job is None:
            terrain_job = load_persisted_job(job_id)
        if terrain_job is None or terrain_job.status != "completed" or not terrain_compatible_for_analysis(
            terrain_job, bbox
        ):
            terrain_job = TerrainJob(job_id=job_id, area_name=area_name, bbox_wgs84=bbox)
        jobs[job_id] = terrain_job
        return terrain_job, terrain_job.status == "completed"


def analysis_status_response(job: TerrainAnalysisJob) -> dict[str, Any]:
    return {
        "analysis_id": job.analysis_id,
        "status": job.status,
        "stage": ANALYSIS_STATUS_LABELS.get(job.status, job.status),
        "data_status": analysis_data_status(job.result) if job.status == "completed" else None,
        "area_name": job.area_name,
        "bbox_wgs84": list(job.bbox_wgs84),
        "created_at": job.created_at,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "reused": job.reused,
        "status_url": f"/api/analysis/jobs/{job.analysis_id}",
        "result_url": f"/api/analysis/jobs/{job.analysis_id}/result" if job.status == "completed" else None,
        "error": job.error,
    }


def analysis_result_response(job: TerrainAnalysisJob) -> dict[str, Any]:
    return {
        "analysis_id": job.analysis_id,
        "status": job.status,
        "data_status": analysis_data_status(job.result),
        "area_name": job.area_name,
        "geometry": job.geometry,
        "bbox_wgs84": list(job.bbox_wgs84),
        "calculated_at": job.completed_at,
        "schema_version": job.result.get("schema_version") if job.result else None,
        "source": job.source,
        "resolution_m": job.resolution_m,
        "horizontal_crs": job.horizontal_crs,
        "terrain_reused": job.terrain_reused,
        "derivatives_reused": job.derivatives_reused,
        "result": job.result,
        "reused": job.reused,
    }


def analysis_data_status(result: dict[str, Any] | None) -> str | None:
    if not isinstance(result, dict):
        return None
    states = [
        result.get(variable, {}).get("status")
        for variable in ("elevation", "slope", "aspect")
        if isinstance(result.get(variable), dict)
    ]
    if not states:
        return None
    if all(state == "no_data" for state in states):
        return "no_valid_data"
    if any(state == "no_data" for state in states):
        return "partial_data"
    return "available"


def persist_analysis_job(job: TerrainAnalysisJob) -> None:
    path = analysis_persist_path(job.analysis_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps({
            "analysis_id": job.analysis_id,
            "analysis_version": ANALYSIS_SCHEMA_VERSION,
            "area_name": job.area_name,
            "geometry": job.geometry,
            "bbox_wgs84": list(job.bbox_wgs84),
            "created_at": job.created_at,
            "started_at": job.started_at,
            "completed_at": job.completed_at,
            "source": job.source,
            "resolution_m": job.resolution_m,
            "horizontal_crs": job.horizontal_crs,
            "terrain_job_id": job.terrain_job_id,
            "raster_paths": job.raster_paths,
            "raster_fingerprints": job.raster_fingerprints,
            "terrain_reused": job.terrain_reused,
            "derivatives_reused": job.derivatives_reused,
            "result": job.result,
        }, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def load_persisted_analysis(analysis_id: str) -> TerrainAnalysisJob | None:
    if not ANALYSIS_ID_PATTERN.fullmatch(analysis_id):
        return None
    path = analysis_persist_path(analysis_id)
    if not path.is_file():
        return None
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        area_name = saved["area_name"]
        geometry = saved["geometry"]
        if (
            saved.get("analysis_id") != analysis_id
            or saved.get("analysis_version") != ANALYSIS_SCHEMA_VERSION
            or analysis_id_for(area_name, geometry) != analysis_id
        ):
            return None
        bbox = geometry_bbox_wgs84(geometry)
        bbox = validate_bbox_values(tuple(round(value, 8) for value in bbox))
        selected_tiles(bbox)
        if tuple(saved.get("bbox_wgs84", ())) != bbox:
            return None
        result = saved.get("result")
        if not isinstance(result, dict) or result.get("schema_version") != ZONAL_STATISTICS_SCHEMA_VERSION:
            return None
        terrain_job_id = saved.get("terrain_job_id")
        if not isinstance(terrain_job_id, str) or not re.fullmatch(r"[0-9a-f]{16}", terrain_job_id):
            return None
        terrain_job = jobs.get(terrain_job_id) or load_persisted_job(terrain_job_id)
        if terrain_job is None or not terrain_compatible_for_analysis(terrain_job, bbox, require_derivatives=True):
            return None
        raster_paths = analysis_raster_paths(terrain_job.result)
        if raster_paths is None or saved.get("raster_paths") != raster_paths:
            return None
        fingerprints = raster_fingerprints(raster_paths)
        if fingerprints is None or saved.get("raster_fingerprints") != fingerprints:
            return None
        derivatives = terrain_job.result["derivatives"]
        source = derivatives.get("source")
        resolution = derivatives.get("resolution_m")
        horizontal_crs = derivatives.get("horizontal_crs")
        if (
            saved.get("source") != source
            or saved.get("resolution_m") != resolution
            or saved.get("horizontal_crs") != horizontal_crs
        ):
            return None
        return TerrainAnalysisJob(
            analysis_id=analysis_id,
            area_name=area_name,
            geometry=geometry,
            bbox_wgs84=bbox,
            status="completed",
            created_at=saved.get("created_at", datetime.now(timezone.utc).isoformat()),
            started_at=saved.get("started_at"),
            completed_at=saved.get("completed_at"),
            result=result,
            source=source,
            resolution_m=resolution,
            horizontal_crs=horizontal_crs,
            terrain_job_id=terrain_job_id,
            raster_paths=raster_paths,
            raster_fingerprints=fingerprints,
            terrain_reused=bool(saved.get("terrain_reused")),
            derivatives_reused=bool(saved.get("derivatives_reused")),
            reused=True,
        )
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, RuntimeError):
        return None


def analysis_job_data_is_current(job: TerrainAnalysisJob) -> bool:
    if job.status != "completed" or not job.terrain_job_id or not job.raster_paths or not job.raster_fingerprints:
        return False
    terrain_job = jobs.get(job.terrain_job_id) or load_persisted_job(job.terrain_job_id)
    if terrain_job is None or not terrain_compatible_for_analysis(
        terrain_job, job.bbox_wgs84, require_derivatives=True
    ):
        return False
    paths = analysis_raster_paths(terrain_job.result)
    return paths == job.raster_paths and raster_fingerprints(paths or {}) == job.raster_fingerprints


def _set_analysis_status(job: TerrainAnalysisJob, stage: str) -> None:
    with jobs_lock:
        job.status = stage
        if stage == "checking_data" and job.started_at is None:
            job.started_at = datetime.now(timezone.utc).isoformat()


def _fail_analysis(job: TerrainAnalysisJob, code: str, message: str) -> None:
    with jobs_lock:
        job.status = "failed"
        job.completed_at = datetime.now(timezone.utc).isoformat()
        job.error = {"code": code, "message": message}


def execute_analysis_job(job: TerrainAnalysisJob) -> None:
    global active_job_id
    _set_analysis_status(job, "checking_data")
    try:
        terrain_job = find_covering_terrain_job(job.bbox_wgs84)
        if terrain_job is None:
            _set_analysis_status(job, "preparing_elevation")
            terrain_job, terrain_reused = get_or_create_terrain_job(job.bbox_wgs84)
            if terrain_job.status != "completed":
                execute_job(terrain_job)
            if terrain_job.status != "completed" or not terrain_compatible_for_analysis(
                terrain_job, job.bbox_wgs84
            ):
                raise AnalysisProcessingError(
                    "terrain_preparation_failed",
                    "Copernicus elevation data could not be prepared for this area. Retry later or choose another region.",
                )
            job.terrain_reused = terrain_reused
        else:
            job.terrain_reused = True

        job.terrain_job_id = terrain_job.job_id
        derivatives_reused = _derivatives_compatible(terrain_job)
        if not derivatives_reused:
            _set_analysis_status(job, "generating_derivatives")
            execute_derivative_job(terrain_job)
            if terrain_job.derivatives_status != "completed" or not _derivatives_compatible(terrain_job):
                raise AnalysisProcessingError(
                    "derivative_generation_failed",
                    "Slope and aspect data could not be generated for this area.",
                )
            derivatives_reused = bool(
                terrain_job.result.get("preparation", {}).get("derivatives_reused")
            )
        job.derivatives_reused = derivatives_reused

        raster_paths = analysis_raster_paths(terrain_job.result)
        if raster_paths is None:
            raise AnalysisProcessingError(
                "terrain_data_unavailable",
                "Required numeric terrain data is not available for this area.",
            )
        _set_analysis_status(job, "calculating_statistics")
        result = calculate_zonal_terrain_statistics(
            job.geometry,
            raster_paths["elevation"],
            raster_paths["slope"],
            raster_paths["aspect"],
        )
        derivatives = terrain_job.result["derivatives"]
        source = result["elevation"]["quality"].get("source") or derivatives.get("source")
        resolution_x = float(result["crs"]["resolution_m"]["x"])
        resolution_y = float(result["crs"]["resolution_m"]["y"])
        if (
            source != COPERNICUS_SOURCE
            or not math.isclose(resolution_x, PROCESSING_RESOLUTION_M, abs_tol=1e-6)
            or not math.isclose(resolution_y, PROCESSING_RESOLUTION_M, abs_tol=1e-6)
        ):
            raise AnalysisProcessingError(
                "incompatible_terrain_data",
                "The prepared terrain does not match the supported Copernicus analysis configuration.",
            )

        fingerprints = raster_fingerprints(raster_paths)
        if fingerprints is None:
            raise AnalysisProcessingError(
                "terrain_data_unavailable",
                "Required numeric terrain data is not available for this area.",
            )
        job.result = result
        job.source = source
        job.resolution_m = PROCESSING_RESOLUTION_M
        job.horizontal_crs = result["crs"]["code"]
        job.raster_paths = raster_paths
        job.raster_fingerprints = fingerprints
        job.completed_at = datetime.now(timezone.utc).isoformat()
        with jobs_lock:
            job.status = "completed"
            persist_analysis_job(job)
    except AnalysisProcessingError as error:
        _fail_analysis(job, error.code, error.public_message)
    except Exception:
        logger.exception("Terrain analysis %s failed", job.analysis_id)
        _fail_analysis(
            job,
            "analysis_failed",
            "The geospatial analysis could not be completed. No internal server details are exposed.",
        )
    finally:
        with jobs_lock:
            if active_job_id == f"analysis:{job.analysis_id}":
                active_job_id = None


@app.get("/health")
def health() -> dict[str, str]:
    if not REGION_ROOT.is_dir() or not os.access(REGION_ROOT, os.W_OK):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="terrain storage is not writable")
    return {"status": "ok", "terrain_storage": "available"}


@app.post("/api/terrain/jobs")
def create_terrain_job(request: TerrainPreparationRequest) -> JSONResponse:
    global active_job_id
    job_id = request_id(request)
    with jobs_lock:
        existing = jobs.get(job_id)
        if existing is not None:
            if existing.status != "failed":
                if existing.status == "completed":
                    existing.reused = True
                    if existing.result is not None:
                        existing.result.setdefault("preparation", {})["reused"] = True
                return JSONResponse(
                    status_code=status.HTTP_200_OK if existing.status == "completed" else status.HTTP_202_ACCEPTED,
                    content=job_response(existing),
                )
            del jobs[job_id]

        persisted = load_persisted_job(job_id)
        if persisted is not None:
            jobs[job_id] = persisted
            style = persisted.result["coverage"].get("elevation_style") if persisted.result else None
            if isinstance(style, dict) and style.get("version") == REGIONAL_ELEVATION_STYLE_VERSION:
                return JSONResponse(status_code=status.HTTP_200_OK, content=job_response(persisted))
            if active_job_id is not None:
                del jobs[job_id]
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"message": "Only one terrain preparation can run at a time.", "active_job_id": active_job_id},
                )
            if not STYLE_REFRESH_SCRIPT_PATH.is_file():
                del jobs[job_id]
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="regional terrain style refresh script is unavailable",
                )
            persisted.status = "queued"
            persisted.started_at = None
            persisted.completed_at = None
            persisted.error = None
            active_job_id = job_id
            executor.submit(refresh_cached_job_style, persisted)
            return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=job_response(persisted))

        if active_job_id is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"message": "Only one terrain preparation can run at a time.", "active_job_id": active_job_id},
            )

        if not SCRIPT_PATH.is_file():
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="terrain preparation script is unavailable")
        job = TerrainJob(job_id=job_id, area_name=request.area_name, bbox_wgs84=request.bbox_wgs84)
        jobs[job_id] = job
        active_job_id = job_id
        executor.submit(execute_job, job)
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=job_response(job))


@app.post("/api/terrain/jobs/{job_id}/derivatives")
def create_terrain_derivatives_job(job_id: str) -> JSONResponse:
    """Generate slope/aspect from an existing region's stored elevation raster."""
    global active_job_id
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            job = load_persisted_job(job_id)
            if job is not None:
                jobs[job_id] = job
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="terrain job not found")
        if job.status != "completed" or not result_is_ready(job.result):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="the base terrain must finish preparing before derivatives can be generated",
            )
        if derivatives_are_ready(job.result):
            job.derivatives_status = "completed"
            job.derivatives_error = None
            job.result["derivatives"]["reused"] = True
            job.result.setdefault("preparation", {})["derivatives_reused"] = True
            write_persisted_job(job)
            return JSONResponse(status_code=status.HTTP_200_OK, content=job_response(job))
        if job.derivatives_status in {"queued", "running"}:
            return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=job_response(job))
        if active_job_id is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"message": "Only one terrain processing job can run at a time.", "active_job_id": active_job_id},
            )
        if not SCRIPT_PATH.is_file():
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="terrain processing script is unavailable")

        job.derivatives_status = "queued"
        job.derivatives_started_at = None
        job.derivatives_completed_at = None
        job.derivatives_error = None
        active_job_id = job_id
        executor.submit(execute_derivative_job, job)
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=job_response(job))


@app.get("/api/terrain/jobs/{job_id}")
def get_terrain_job(job_id: str) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            job = load_persisted_job(job_id)
            if job is not None:
                jobs[job_id] = job
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="terrain job not found")
        return job_response(job)


@app.get("/api/terrain/jobs/{job_id}/result")
def get_terrain_job_result(job_id: str) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            job = load_persisted_job(job_id)
            if job is not None:
                jobs[job_id] = job
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="terrain job not found")
        if job.status in {"queued", "running"}:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="terrain job is still running")
        if job.status == "failed":
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=job.error or "terrain preparation failed")
        return {"job_id": job.job_id, "status": job.status, "result": job.result, "reused": job.reused}


@app.post("/api/analysis/jobs")
def create_terrain_analysis(request: TerrainAnalysisRequest) -> JSONResponse:
    global active_job_id
    bbox = validate_bbox_values(tuple(round(value, 8) for value in geometry_bbox_wgs84(request.geometry)))
    analysis_id = analysis_id_for(request.area_name, request.geometry)
    with jobs_lock:
        existing = analysis_jobs.get(analysis_id)
        if existing is not None:
            if existing.status == "completed" and not analysis_job_data_is_current(existing):
                del analysis_jobs[analysis_id]
                existing = None
            elif existing.status == "failed":
                del analysis_jobs[analysis_id]
                existing = None
            else:
                existing.area_name = request.area_name
                if existing.status == "completed":
                    existing.reused = True
                return JSONResponse(
                    status_code=status.HTTP_200_OK if existing.status == "completed" else status.HTTP_202_ACCEPTED,
                    content=analysis_status_response(existing),
                )

        persisted = load_persisted_analysis(analysis_id)
        if persisted is not None:
            persisted.area_name = request.area_name
            persisted.reused = True
            analysis_jobs[analysis_id] = persisted
            return JSONResponse(status_code=status.HTTP_200_OK, content=analysis_status_response(persisted))

        if active_job_id is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "processing_busy",
                    "message": "Another terrain preparation or analysis is currently running.",
                },
            )

        job = TerrainAnalysisJob(
            analysis_id=analysis_id,
            area_name=request.area_name,
            geometry=request.geometry,
            bbox_wgs84=bbox,
        )
        analysis_jobs[analysis_id] = job
        active_job_id = f"analysis:{analysis_id}"
        executor.submit(execute_analysis_job, job)
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=analysis_status_response(job))


def get_analysis_job_or_404(analysis_id: str) -> TerrainAnalysisJob:
    if not ANALYSIS_ID_PATTERN.fullmatch(analysis_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="analysis job not found")
    with jobs_lock:
        job = analysis_jobs.get(analysis_id)
        if job is not None and job.status == "completed" and not analysis_job_data_is_current(job):
            del analysis_jobs[analysis_id]
            job = None
        if job is None:
            job = load_persisted_analysis(analysis_id)
            if job is not None:
                analysis_jobs[analysis_id] = job
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="analysis job not found or source data is unavailable")
        return job


@app.get("/api/analysis/jobs/{analysis_id}")
def get_terrain_analysis(analysis_id: str) -> dict[str, Any]:
    return analysis_status_response(get_analysis_job_or_404(analysis_id))


@app.get("/api/analysis/jobs/{analysis_id}/result")
def get_terrain_analysis_result(analysis_id: str) -> dict[str, Any]:
    job = get_analysis_job_or_404(analysis_id)
    if job.status in {"queued", "checking_data", "preparing_elevation", "generating_derivatives", "calculating_statistics"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "analysis_in_progress", "message": "Terrain analysis has not completed."},
        )
    if job.status == "failed":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=job.error or {"code": "analysis_failed", "message": "Terrain analysis failed."},
        )
    return analysis_result_response(job)
