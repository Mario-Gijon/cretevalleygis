export type PlaceType = "country" | "capital" | "regional-capital" | "city" | "locality";

export type PlaceSearchResult = {
  id: string;
  name: string;
  type: PlaceType;
  country: string | null;
  region: string | null;
  coordinates: [longitude: number, latitude: number];
  extent?: [west: number, south: number, east: number, north: number];
  source: string;
};

export type CoordinateSearchResult = {
  id: string;
  name: string;
  type: "coordinates";
  country: null;
  region: null;
  coordinates: [longitude: number, latitude: number];
  source: "Coordenadas introducidas";
};

export type SearchSelection = PlaceSearchResult | CoordinateSearchResult;

export type CoordinateParseResult =
  | { kind: "not-coordinates" }
  | { kind: "valid"; result: CoordinateSearchResult }
  | { kind: "invalid"; message: string };

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const DECIMAL = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))";
const COORDINATE_PAIR = new RegExp(`^\\s*${DECIMAL}\\s*(?:,\\s*|\\s+)${DECIMAL}\\s*$`);

export function parseCoordinateSearch(value: string): CoordinateParseResult {
  const query = value.trim();
  const match = COORDINATE_PAIR.exec(query);
  if (!match) {
    return /^[\d+\-.,\s]+$/.test(query) && /[,\s]/.test(query)
      ? { kind: "invalid", message: "Escribe latitud y longitud en grados decimales, por ejemplo: 37.7796, -3.7849." }
      : { kind: "not-coordinates" };
  }

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90
    || longitude < -180 || longitude > 180) {
    return { kind: "invalid", message: "Coordenadas fuera de los límites geográficos: latitud ±90° y longitud ±180°." };
  }
  if (Math.abs(latitude) > WEB_MERCATOR_MAX_LATITUDE) {
    return { kind: "invalid", message: "Esa latitud queda fuera del límite de representación Web Mercator (±85,0511°)." };
  }

  const coordinateText = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  return {
    kind: "valid",
    result: {
      id: `coordinates:${latitude.toFixed(6)}:${longitude.toFixed(6)}`,
      name: coordinateText,
      type: "coordinates",
      country: null,
      region: null,
      coordinates: [longitude, latitude],
      source: "Coordenadas introducidas",
    },
  };
}

function isPlaceSearchResult(value: unknown): value is PlaceSearchResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<PlaceSearchResult>;
  return typeof result.id === "string"
    && typeof result.name === "string"
    && ["country", "capital", "regional-capital", "city", "locality"].includes(result.type ?? "")
    && Array.isArray(result.coordinates)
    && result.coordinates.length === 2
    && result.coordinates.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
    && typeof result.source === "string";
}

export async function searchPlaces(query: string, signal: AbortSignal): Promise<PlaceSearchResult[]> {
  const response = await fetch(`/api/search/places?q=${encodeURIComponent(query)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 503) throw new Error("El catálogo Natural Earth local no está disponible.");
    if (response.status === 422) throw new Error("La consulta debe tener entre 2 y 80 caracteres.");
    throw new Error("No se pudo completar la búsqueda local.");
  }
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { results?: unknown }).results)) {
    throw new Error("La respuesta del buscador local no es válida.");
  }
  return (payload as { results: unknown[] }).results.filter(isPlaceSearchResult);
}

export function placeTypeLabel(type: SearchSelection["type"]): string {
  switch (type) {
    case "country": return "País";
    case "capital": return "Capital";
    case "regional-capital": return "Capital regional";
    case "city": return "Ciudad";
    case "locality": return "Localidad";
    case "coordinates": return "Coordenadas";
  }
}
