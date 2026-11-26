export const TOPOGRAPHIC_LAYERS = {
  hillshade: {
    title: "Relieve sombreado",
    description: "Formas del terreno iluminadas",
    wmsLayer: "terrain_hillshade",
  },
  elevation: {
    title: "Elevación del terreno",
    description: "Modelo de superficie · metros",
    wmsLayer: "terrain_elevation",
  },
} as const;

export type TopographicLayerId = keyof typeof TOPOGRAPHIC_LAYERS;
export type TopographicVisibility = Record<TopographicLayerId, boolean>;
export type TopographicOpacity = Record<TopographicLayerId, number>;
export type TopographicAvailability = Record<TopographicLayerId, boolean>;

export type TerrainCoverage = {
  areaName: string;
  extent: [number, number, number, number];
  minElevation: number;
  maxElevation: number;
  horizontalCrs: string;
};

export const DEFAULT_TOPOGRAPHIC_VISIBILITY: TopographicVisibility = {
  hillshade: false,
  elevation: false,
};

export const DEFAULT_TOPOGRAPHIC_OPACITY: TopographicOpacity = {
  hillshade: 55,
  elevation: 70,
};

function directChild(element: Element, name: string): Element | null {
  return Array.from(element.children).find((child) => child.localName === name) ?? null;
}

function numericChild(element: Element, name: string): number | null {
  const text = directChild(element, name)?.textContent?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function parseTerrainCoverage(xml: string): TerrainCoverage | null {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) return null;
  const layers = Array.from(document.getElementsByTagNameNS("*", "Layer"));
  const namedLayer = (name: string) => layers.find((layer) => directChild(layer, "Name")?.textContent?.trim() === name);
  const elevationLayer = namedLayer(TOPOGRAPHIC_LAYERS.elevation.wmsLayer);
  const hillshadeLayer = namedLayer(TOPOGRAPHIC_LAYERS.hillshade.wmsLayer);
  if (!elevationLayer || !hillshadeLayer) return null;

  const abstract = directChild(elevationLayer, "Abstract")?.textContent ?? "";
  const extentMatch = abstract.match(/extent WGS84:\s*(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/i);
  const rangeMatch = abstract.match(/elevation min\/max m:\s*(-?[\d.]+)\/(-?[\d.]+)/i);
  const areaMatch = abstract.match(/Area:\s*([^;]+)/i);
  const crsMatch = abstract.match(/horizontal CRS:\s*([^;]+)/i);

  const geographicBox = directChild(elevationLayer, "EX_GeographicBoundingBox");
  const extentFromCapabilities = geographicBox
    ? [
        numericChild(geographicBox, "westBoundLongitude"),
        numericChild(geographicBox, "southBoundLatitude"),
        numericChild(geographicBox, "eastBoundLongitude"),
        numericChild(geographicBox, "northBoundLatitude"),
      ]
    : [];
  const parsedExtent = extentFromCapabilities.length === 4 && extentFromCapabilities.every((value) => value !== null)
    ? extentFromCapabilities as [number, number, number, number]
    : extentMatch?.slice(1).map(Number) as [number, number, number, number] | undefined;
  const minElevation = rangeMatch ? Number(rangeMatch[1]) : null;
  const maxElevation = rangeMatch ? Number(rangeMatch[2]) : null;
  if (
    !parsedExtent ||
    !parsedExtent.every(Number.isFinite) ||
    minElevation === null || !Number.isFinite(minElevation) ||
    maxElevation === null || !Number.isFinite(maxElevation)
  ) return null;

  return {
    areaName: areaMatch?.[1]?.trim() || "zona preparada",
    extent: parsedExtent,
    minElevation,
    maxElevation,
    horizontalCrs: crsMatch?.[1]?.trim() || "CRS local",
  };
}
