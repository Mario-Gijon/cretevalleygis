"""In-memory place search over the existing Natural Earth 1:10m datasets."""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import threading
import unicodedata
from typing import Any, Mapping

from osgeo import ogr


WORLD_ROOT = Path(os.environ.get("NATURAL_EARTH_WORLD_ROOT", "/io/data/world"))
MANIFEST_PATH = WORLD_ROOT / "data-manifest.json"
MAX_RESULTS = 10
SOURCE_LABEL = "Natural Earth 1:10m"
ALIAS_SPLIT = re.compile(r"\s*[;|]\s*")
COUNTRY_CODE_FIELDS = ("ADM0_A3", "ISO_A3", "ADM0_ISO")
COUNTRY_PRIMARY_FIELDS = ("NAME_ES", "ADMIN", "NAME_EN", "NAME", "NAME_LONG")
PLACE_PRIMARY_FIELDS = ("NAME_ES", "NAME", "NAME_EN", "NAMEASCII")
COMMON_ALIAS_FIELDS = ("NAME", "NAMEASCII", "NAMEPAR", "NAMEALT", "NAME_EN", "NAME_ES")
TRANSLATION_FIELDS = ("NAME_EL", "NAME_FR")


class PlaceSearchUnavailable(RuntimeError):
    """Raised when the prepared local Natural Earth catalog cannot be read."""


@dataclass(frozen=True)
class PlaceRecord:
    identifier: str
    name: str
    kind: str
    country: str | None
    region: str | None
    longitude: float
    latitude: float
    extent: tuple[float, float, float, float] | None
    population: int
    aliases: tuple[str, ...]

    def response(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "id": self.identifier,
            "name": self.name,
            "type": self.kind,
            "country": self.country,
            "region": self.region,
            "coordinates": [self.longitude, self.latitude],
            "source": SOURCE_LABEL,
        }
        if self.extent is not None:
            result["extent"] = list(self.extent)
        return result


def normalize_name(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    without_marks = "".join(character for character in decomposed if not unicodedata.combining(character))
    return " ".join(re.sub(r"[^\w]+", " ", without_marks, flags=re.UNICODE).split())


def _clean_text(value: str) -> str:
    return "".join(character for character in value if unicodedata.category(character) not in {"Cc", "Cf"}).strip()


def _manifest_dataset_path(key: str, filename: str) -> Path:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        archive_hash = manifest["datasets"][key]["archive_sha256"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        archive_hash = None

    if isinstance(archive_hash, str) and re.fullmatch(r"[0-9a-f]{64}", archive_hash):
        candidate = WORLD_ROOT / "data" / key / archive_hash[:12] / filename
        if candidate.is_file():
            return candidate

    # Keep compatibility with an existing volume whose manifest predates the
    # checksum index, while never choosing arbitrarily between multiple copies.
    candidates = sorted((WORLD_ROOT / "data" / key).glob(f"*/{filename}"))
    if len(candidates) == 1 and candidates[0].is_file():
        return candidates[0]
    raise PlaceSearchUnavailable(f"Natural Earth dataset {key} is unavailable")


def _field(feature: ogr.Feature, name: str, default: Any = None, indices: Mapping[str, int] | None = None) -> Any:
    index = indices.get(name.upper(), -1) if indices is not None else feature.GetFieldIndex(name)
    if index < 0 or not feature.IsFieldSetAndNotNull(index):
        return default
    value = feature.GetField(index)
    return default if value is None else value


def _string_aliases(feature: ogr.Feature, fields: tuple[str, ...], indices: Mapping[str, int]) -> tuple[str, ...]:
    values: list[str] = []
    for field_name in fields:
        value = _field(feature, field_name, indices=indices)
        if not isinstance(value, str):
            continue
        for raw_item in ALIAS_SPLIT.split(value.strip()):
            item = _clean_text(raw_item)
            if item and normalize_name(item) and item not in values:
                values.append(item)
    return tuple(values)


def _alias_fields(layer: ogr.Layer, common: tuple[str, ...]) -> tuple[str, ...]:
    definition = layer.GetLayerDefn()
    available = {
        definition.GetFieldDefn(index).GetName().upper(): definition.GetFieldDefn(index)
        for index in range(definition.GetFieldCount())
    }
    preferred = [name for name in common if name in available]
    translations = [
        name for name in TRANSLATION_FIELDS
        if name in available and available[name].GetType() == ogr.OFTString and name not in preferred
    ]
    return tuple(preferred + translations)


def _layer_field_indices(layer: ogr.Layer) -> dict[str, int]:
    definition = layer.GetLayerDefn()
    return {
        definition.GetFieldDefn(index).GetName().upper(): index
        for index in range(definition.GetFieldCount())
    }


def _ignore_unused_fields(layer: ogr.Layer, indices: Mapping[str, int], required: set[str]) -> None:
    ignored = [name for name in indices if name not in required]
    if ignored:
        layer.SetIgnoredFields(ignored)


def _primary_name(feature: ogr.Feature, fields: tuple[str, ...], indices: Mapping[str, int]) -> str | None:
    for field_name in fields:
        value = _field(feature, field_name, indices=indices)
        if isinstance(value, str) and _clean_text(value):
            return _clean_text(value)
    return None


def _numeric(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def _country_kind_and_point(
    feature: ogr.Feature,
    indices: Mapping[str, int],
) -> tuple[float, float, tuple[float, float, float, float]] | None:
    geometry = feature.GetGeometryRef()
    if geometry is None or geometry.IsEmpty():
        return None
    envelope = geometry.GetEnvelope()  # minX, maxX, minY, maxY
    extent = (float(envelope[0]), float(envelope[2]), float(envelope[1]), float(envelope[3]))
    longitude = _numeric(_field(feature, "LABEL_X", indices=indices))
    latitude = _numeric(_field(feature, "LABEL_Y", indices=indices))
    if longitude is None or latitude is None:
        centroid = geometry.Centroid()
        if centroid is None or centroid.IsEmpty():
            return None
        longitude, latitude = centroid.GetX(), centroid.GetY()
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        return None
    return longitude, latitude, extent


def _place_kind(feature: ogr.Feature, indices: Mapping[str, int]) -> str:
    feature_class = str(_field(feature, "FEATURECLA", "", indices)).casefold()
    if "admin-0 capital" in feature_class or int(_field(feature, "ADM0CAP", 0, indices) or 0) == 1:
        return "capital"
    if "admin-1 capital" in feature_class:
        return "regional-capital"
    if (int(_field(feature, "MEGACITY", 0, indices) or 0) == 1
            or int(_field(feature, "WORLDCITY", 0, indices) or 0) == 1
            or int(_field(feature, "POP_MAX", 0, indices) or 0) >= 100_000):
        return "city"
    return "locality"


class PlaceSearchIndex:
    def __init__(self, records: dict[str, PlaceRecord]):
        self.records = records
        alias_records: dict[str, set[str]] = {}
        for record in records.values():
            for alias in record.aliases:
                normalized = normalize_name(alias)
                if normalized:
                    alias_records.setdefault(normalized, set()).add(record.identifier)
        self.alias_records = {alias: tuple(ids) for alias, ids in alias_records.items()}
        self.sorted_aliases = tuple(sorted(self.alias_records))

    @classmethod
    def load(cls) -> "PlaceSearchIndex":
        countries_path = _manifest_dataset_path("countries_10", "ne_10m_admin_0_countries.shp")
        places_path = _manifest_dataset_path("localities_10", "ne_10m_populated_places.shp")
        country_dataset = ogr.Open(str(countries_path), 0)
        place_dataset = ogr.Open(str(places_path), 0)
        if country_dataset is None or place_dataset is None:
            raise PlaceSearchUnavailable("Natural Earth datasets could not be opened")
        countries_layer = country_dataset.GetLayer(0)
        places_layer = place_dataset.GetLayer(0)
        if countries_layer is None or places_layer is None:
            raise PlaceSearchUnavailable("Natural Earth datasets contain no readable layer")

        records: dict[str, PlaceRecord] = {}
        country_names_by_code: dict[str, str] = {}
        country_indices = _layer_field_indices(countries_layer)
        country_alias_fields = _alias_fields(countries_layer, COUNTRY_PRIMARY_FIELDS + ("NAME_ALT", "FORMAL_EN", "SOVEREIGNT"))
        _ignore_unused_fields(countries_layer, country_indices, {
            *country_alias_fields, "NE_ID", "LABEL_X", "LABEL_Y", "CONTINENT", *COUNTRY_CODE_FIELDS,
        })

        for feature in countries_layer:
            identifier_value = _field(feature, "NE_ID", indices=country_indices)
            name = _primary_name(feature, COUNTRY_PRIMARY_FIELDS, country_indices)
            coordinate_extent = _country_kind_and_point(feature, country_indices)
            if identifier_value is None or not name or coordinate_extent is None:
                continue
            longitude, latitude, extent = coordinate_extent
            identifier = f"ne:country:{identifier_value}"
            aliases = _string_aliases(feature, country_alias_fields, country_indices)
            if name not in aliases:
                aliases = (name, *aliases)
            records[identifier] = PlaceRecord(
                identifier=identifier,
                name=name,
                kind="country",
                country=None,
                region=str(_field(feature, "CONTINENT", "", country_indices)).strip() or None,
                longitude=longitude,
                latitude=latitude,
                extent=extent,
                population=0,
                aliases=aliases,
            )
            for code_field in COUNTRY_CODE_FIELDS:
                code = _field(feature, code_field, indices=country_indices)
                if isinstance(code, str) and code and code != "-99":
                    country_names_by_code[code] = name

        place_alias_fields = _alias_fields(places_layer, PLACE_PRIMARY_FIELDS + ("NAMEPAR", "NAMEALT"))
        place_indices = _layer_field_indices(places_layer)
        _ignore_unused_fields(places_layer, place_indices, {
            *place_alias_fields, "NE_ID", "FEATURECLA", "ADM0CAP", "MEGACITY", "WORLDCITY",
            "POP_MAX", "ADM0_A3", "ADM0NAME", "ADM1NAME", "LATITUDE", "LONGITUDE",
        })
        for feature in places_layer:
            identifier_value = _field(feature, "NE_ID", indices=place_indices)
            name = _primary_name(feature, PLACE_PRIMARY_FIELDS, place_indices)
            geometry = feature.GetGeometryRef()
            if identifier_value is None or not name or geometry is None or geometry.IsEmpty():
                continue
            longitude = _numeric(_field(feature, "LONGITUDE", indices=place_indices))
            latitude = _numeric(_field(feature, "LATITUDE", indices=place_indices))
            if longitude is None or latitude is None:
                longitude, latitude = geometry.GetX(), geometry.GetY()
            if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
                continue
            identifier = f"ne:place:{identifier_value}"
            aliases = _string_aliases(feature, place_alias_fields, place_indices)
            if name not in aliases:
                aliases = (name, *aliases)
            country_code = str(_field(feature, "ADM0_A3", "", place_indices))
            country = country_names_by_code.get(country_code) or str(_field(feature, "ADM0NAME", "", place_indices)).strip() or None
            region = str(_field(feature, "ADM1NAME", "", place_indices)).strip() or None
            records[identifier] = PlaceRecord(
                identifier=identifier,
                name=name,
                kind=_place_kind(feature, place_indices),
                country=country,
                region=region,
                longitude=longitude,
                latitude=latitude,
                extent=None,
                population=int(_field(feature, "POP_MAX", 0, place_indices) or 0),
                aliases=aliases,
            )

        country_dataset = None
        place_dataset = None
        if not records:
            raise PlaceSearchUnavailable("Natural Earth index is empty")
        return cls(records)

    @staticmethod
    def _type_rank(record: PlaceRecord) -> int:
        return {"country": 0, "capital": 1, "regional-capital": 2, "city": 3, "locality": 4}.get(record.kind, 5)

    def search(self, query: str) -> list[dict[str, Any]]:
        normalized_query = normalize_name(query)
        if not normalized_query:
            return []

        match_rank: dict[str, int] = {}

        def add_matches(alias: str, rank: int) -> None:
            for identifier in self.alias_records.get(alias, ()):
                match_rank[identifier] = min(rank, match_rank.get(identifier, rank))

        add_matches(normalized_query, 0)
        start = bisect_left(self.sorted_aliases, normalized_query)
        for alias_index in range(start, len(self.sorted_aliases)):
            alias = self.sorted_aliases[alias_index]
            if not alias.startswith(normalized_query):
                break
            if alias != normalized_query:
                add_matches(alias, 1)
        if len(match_rank) < MAX_RESULTS:
            for alias in self.sorted_aliases:
                if normalized_query in alias and alias != normalized_query and not alias.startswith(normalized_query):
                    add_matches(alias, 2)

        ranked = sorted(
            match_rank,
            key=lambda identifier: (
                match_rank[identifier],
                self._type_rank(self.records[identifier]),
                -self.records[identifier].population,
                normalize_name(self.records[identifier].name),
                identifier,
            ),
        )
        return [self.records[identifier].response() for identifier in ranked[:MAX_RESULTS]]


_index: PlaceSearchIndex | None = None
_index_lock = threading.Lock()


def search_places(query: str) -> list[dict[str, Any]]:
    global _index
    if _index is None:
        with _index_lock:
            if _index is None:
                try:
                    _index = PlaceSearchIndex.load()
                except PlaceSearchUnavailable:
                    raise
                except Exception as error:  # GDAL reports several driver-specific exception types.
                    raise PlaceSearchUnavailable("Natural Earth index could not be loaded") from error
    return _index.search(query)
