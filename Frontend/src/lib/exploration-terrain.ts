export const EXPLORATION_TERRAIN = {
  url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  minZoom: 8,
  maxDataZoom: 15,
  cacheSize: 96,
  defaultOpacity: 30,
  verticalExaggeration: 1.15,
  sunElevationDegrees: 45,
  sunAzimuthDegrees: 315,
  defaultEnabled: true,
  storageKey: "cv-gis-exploration-relief",
} as const;

export type ExplorationTerrainStatus =
  | "disabled"
  | "scale"
  | "loading"
  | "active"
  | "overzoom"
  | "regional-priority"
  | "unavailable"
  | "error";

export function initialExplorationTerrainEnabled(): boolean {
  try {
    const value = window.localStorage.getItem(EXPLORATION_TERRAIN.storageKey);
    return value === null ? EXPLORATION_TERRAIN.defaultEnabled : value === "true";
  } catch {
    return EXPLORATION_TERRAIN.defaultEnabled;
  }
}
