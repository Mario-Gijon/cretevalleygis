export const OPEN_FREE_MAP_STYLES = {
  positron: {
    title: "Minimalista",
    description: "Fondo claro y limpio",
    url: "https://tiles.openfreemap.org/styles/positron",
  },
  dark: {
    title: "Oscuro",
    description: "Contraste para trabajar de noche",
    url: "https://tiles.openfreemap.org/styles/dark",
  },
  liberty: {
    title: "Detallado",
    description: "Calles, lugares y referencias",
    url: "https://tiles.openfreemap.org/styles/liberty",
  },
} as const;

export type OpenFreeMapId = keyof typeof OPEN_FREE_MAP_STYLES;
export type BaseMapId = "osm" | "qgis" | "topographic" | OpenFreeMapId;
export type OpenFreeMapStatus = "idle" | "loading" | "available" | "error";

export const OPEN_FREE_MAP_ATTRIBUTION_HTML =
  '<a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>';
