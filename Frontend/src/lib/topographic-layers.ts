export const TOPOGRAPHIC_LAYERS = {
  hillshade: {
    title: "Relieve sombreado",
    description: "Según escala y cobertura",
    wmsLayer: "terrain_hillshade",
    globalWmsLayer: "terrain_hillshade_global",
  },
  elevation: {
    title: "Elevación del terreno",
    description: "Elevaciones y batimetría · metros",
    wmsLayer: "terrain_elevation",
    globalWmsLayer: "terrain_elevation_global",
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

export const TERRAIN_VISIBILITY_THRESHOLDS = {
  // At 800 projected metres per screen pixel, ETOPO's 60″ cells stay near
  // two screen pixels. Closer views hide the coarse global raster.
  globalMinResolution: 800,
  // Copernicus GLO-30 is only requested close to its native resolution.
  detailedMaxResolution: 60,
  // Require most of the viewport to have 30 m data to avoid isolated blocks.
  detailedMinViewCoverageRatio: 0.8,
} as const;

export const DEFAULT_TOPOGRAPHIC_VISIBILITY: TopographicVisibility = {
  hillshade: false,
  elevation: false,
};

export const DEFAULT_TOPOGRAPHIC_OPACITY: TopographicOpacity = {
  hillshade: 25,
  elevation: 65,
};

export type TerrainRenderMode = "global" | "detailed" | "hidden";

export function getTerrainCoverageRatio(
  view: [number, number, number, number] | null,
  coverage: TerrainCoverage | null,
): number {
  if (!view || !coverage) return 0;
  const viewArea = (view[2] - view[0]) * (view[3] - view[1]);
  if (!(viewArea > 0)) return 0;
  const width = Math.max(0, Math.min(view[2], coverage.extent[2]) - Math.max(view[0], coverage.extent[0]));
  const height = Math.max(0, Math.min(view[3], coverage.extent[3]) - Math.max(view[1], coverage.extent[1]));
  return Math.min(1, (width * height) / viewArea);
}

export function getTerrainRenderMode(
  view: [number, number, number, number] | null,
  resolution: number | null,
  coverage: TerrainCoverage | null,
): TerrainRenderMode {
  if (resolution === null || !Number.isFinite(resolution) || resolution <= 0) return "hidden";
  const detailedCoverageRatio = getTerrainCoverageRatio(view, coverage);
  if (
    coverage &&
    resolution <= TERRAIN_VISIBILITY_THRESHOLDS.detailedMaxResolution &&
    detailedCoverageRatio >= TERRAIN_VISIBILITY_THRESHOLDS.detailedMinViewCoverageRatio
  ) {
    return "detailed";
  }
  if (resolution >= TERRAIN_VISIBILITY_THRESHOLDS.globalMinResolution) return "global";
  return "hidden";
}

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
  const globalElevationLayer = namedLayer(TOPOGRAPHIC_LAYERS.elevation.globalWmsLayer);
  const globalHillshadeLayer = namedLayer(TOPOGRAPHIC_LAYERS.hillshade.globalWmsLayer);
  if (!elevationLayer || !hillshadeLayer || !globalElevationLayer || !globalHillshadeLayer) return null;

  const abstract = directChild(elevationLayer, "Abstract")?.textContent ?? "";
  const globalAbstract = directChild(globalElevationLayer, "Abstract")?.textContent ?? "";
  const extentMatch = abstract.match(/extent WGS84:\s*(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/i);
  const rangeMatch = globalAbstract.match(/elevation min\/max m:\s*(-?[\d.]+)\/(-?[\d.]+)/i);
  const areaMatch = abstract.match(/Area:\s*([^;]+)/i);
  const crsMatch = globalAbstract.match(/horizontal CRS:\s*([^;]+)/i);

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
