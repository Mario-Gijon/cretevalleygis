export const EXPLORATION_TERRAIN = {
  url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  minZoom: 8,
  maxDataZoom: 15,
  cacheSize: 96,
  sampleCacheSize: 96,
  samplesPerTileAxis: 12,
  minimumAdaptiveSamples: 180,
  minimumDisplayRangeM: 400,
  sampleSettleDelayMs: 650,
  defaultHillshadeOpacity: 30,
  defaultElevationOpacity: 42,
  verticalExaggeration: 1.15,
  sunElevationDegrees: 45,
  sunAzimuthDegrees: 315,
  defaultHillshadeEnabled: true,
  defaultElevationEnabled: true,
  defaultElevationMode: "adaptive" as const,
  hillshadeStorageKey: "cv-gis-exploration-relief",
  elevationStorageKey: "cv-gis-exploration-elevation",
  elevationModeStorageKey: "cv-gis-exploration-elevation-mode",
} as const;

export const ABSOLUTE_ELEVATION_MIN_M = -11_000;
export const ABSOLUTE_ELEVATION_MAX_M = 9_000;

// Kept in step with QGIS/scripts/terrain_style.py for comparable absolute colors.
export const ABSOLUTE_ELEVATION_STOPS = [
  { valueM: -11_000, color: "#092e53" },
  { valueM: -8_000, color: "#145d8b" },
  { valueM: -4_000, color: "#3d91af" },
  { valueM: -2_000, color: "#8dc4ca" },
  { valueM: 0, color: "#e2e9d4" },
  { valueM: 500, color: "#b6cb8a" },
  { valueM: 1_500, color: "#78a568" },
  { valueM: 2_500, color: "#c6b47a" },
  { valueM: 4_000, color: "#a77a5a" },
  { valueM: 6_000, color: "#d0c9bd" },
  { valueM: 9_000, color: "#f5f3ea" },
] as const;

// The land colors reuse the regional ramp; a narrow shoreline transition
// joins its first color to the fixed bathymetry ramp without a tile seam.
export const ADAPTIVE_LAND_STOPS = [
  { position: 0, color: "#e2e9d4" },
  { position: 0.12, color: "#315f43" },
  { position: 0.2784, color: "#66884d" },
  { position: 0.428, color: "#a0ae68" },
  { position: 0.5776, color: "#d1c37e" },
  { position: 0.7184, color: "#bd895f" },
  { position: 0.8384, color: "#8e7462" },
  { position: 0.9384, color: "#b8b8b0" },
  { position: 1, color: "#f5f2e9" },
] as const;

export type ExplorationElevationMode = "adaptive" | "absolute";
export type ExplorationTerrainStatus =
  | "disabled"
  | "scale"
  | "loading"
  | "active"
  | "overzoom"
  | "regional-priority"
  | "unavailable"
  | "error";

export type ExplorationElevationScale = {
  requestedMode: ExplorationElevationMode;
  effectiveMode: ExplorationElevationMode;
  minM: number;
  maxM: number;
  sampleCount: number;
};

export function absoluteElevationScale(
  requestedMode: ExplorationElevationMode = "absolute",
  sampleCount = 0,
): ExplorationElevationScale {
  return {
    requestedMode,
    effectiveMode: "absolute",
    minM: ABSOLUTE_ELEVATION_MIN_M,
    maxM: ABSOLUTE_ELEVATION_MAX_M,
    sampleCount,
  };
}

export function adaptiveElevationScale(
  values: ArrayLike<number>,
): ExplorationElevationScale | null {
  const landValues: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value) && value >= 0) landValues.push(value);
  }
  if (landValues.length < EXPLORATION_TERRAIN.minimumAdaptiveSamples) return null;

  landValues.sort((left, right) => left - right);
  const percentile = (fraction: number) => {
    const position = (landValues.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const portion = position - lower;
    return landValues[lower] + (landValues[upper] - landValues[lower]) * portion;
  };

  let minM = Math.max(0, percentile(0.05));
  let maxM = percentile(0.95);
  if (maxM - minM < EXPLORATION_TERRAIN.minimumDisplayRangeM) {
    const center = (minM + maxM) / 2;
    minM = Math.max(0, center - EXPLORATION_TERRAIN.minimumDisplayRangeM / 2);
    maxM = Math.max(center + EXPLORATION_TERRAIN.minimumDisplayRangeM / 2, minM + EXPLORATION_TERRAIN.minimumDisplayRangeM);
  }

  return {
    requestedMode: "adaptive",
    effectiveMode: "adaptive",
    minM,
    maxM,
    sampleCount: landValues.length,
  };
}

export function initialExplorationHillshadeEnabled(): boolean {
  return readBooleanPreference(
    EXPLORATION_TERRAIN.hillshadeStorageKey,
    EXPLORATION_TERRAIN.defaultHillshadeEnabled,
  );
}

export function initialExplorationElevationEnabled(): boolean {
  return readBooleanPreference(
    EXPLORATION_TERRAIN.elevationStorageKey,
    EXPLORATION_TERRAIN.defaultElevationEnabled,
  );
}

export function initialExplorationElevationMode(): ExplorationElevationMode {
  try {
    return window.localStorage.getItem(EXPLORATION_TERRAIN.elevationModeStorageKey) === "absolute"
      ? "absolute"
      : EXPLORATION_TERRAIN.defaultElevationMode;
  } catch {
    return EXPLORATION_TERRAIN.defaultElevationMode;
  }
}

function readBooleanPreference(key: string, defaultValue: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? defaultValue : value === "true";
  } catch {
    return defaultValue;
  }
}
