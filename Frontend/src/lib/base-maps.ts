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
export const TERRAIN_BASE_MAPS = {
  "terrain-elevation": { title: "Elevación", theme: "elevation" },
  "terrain-slope": { title: "Pendientes", theme: "slope" },
  "terrain-aspect": { title: "Orientación de laderas", theme: "aspect" },
} as const;

export type TerrainBaseMapId = keyof typeof TERRAIN_BASE_MAPS;
export type TerrainTheme = (typeof TERRAIN_BASE_MAPS)[TerrainBaseMapId]["theme"];
export type BaseMapId = "osm" | "qgis" | TerrainBaseMapId | OpenFreeMapId;
export type OpenFreeMapStatus = "idle" | "loading" | "available" | "error";

export function isTerrainBaseMap(id: BaseMapId): id is TerrainBaseMapId {
  return id in TERRAIN_BASE_MAPS;
}

export function terrainThemeForBaseMap(id: BaseMapId): TerrainTheme | null {
  return isTerrainBaseMap(id) ? TERRAIN_BASE_MAPS[id].theme : null;
}

export const OPEN_FREE_MAP_ATTRIBUTION_HTML =
  '<a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>';
