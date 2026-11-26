export const BASE_MAP_WMS_LAYERS = [
  "land_110m",
  "land_50m",
  "land_10m",
  "countries_110m",
  "countries_50m",
  "countries_10m",
] as const;

export const GEOGRAPHIC_OVERLAYS = {
  boundaries: {
    title: "Límites",
    description: "Fronteras entre países",
    layers: ["boundaries_110m", "boundaries_50m", "boundaries_10m"],
  },
  localities: {
    title: "Localidades",
    description: "Ciudades principales",
    layers: ["localities_110m", "localities_50m", "localities_10m"],
  },
  rivers: {
    title: "Ríos",
    description: "Ríos principales",
    layers: ["rivers_110m", "rivers_50m", "rivers_10m"],
  },
  lakes: {
    title: "Lagos",
    description: "Lagos y embalses",
    layers: ["lakes_110m", "lakes_50m", "lakes_10m"],
  },
} as const;

export type GeographicOverlayId = keyof typeof GEOGRAPHIC_OVERLAYS;
export type GeographicOverlayVisibility = Record<GeographicOverlayId, boolean>;

export const DEFAULT_OVERLAY_VISIBILITY: GeographicOverlayVisibility = {
  boundaries: true,
  localities: true,
  rivers: false,
  lakes: false,
};
