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
  adaptiveCalculationTimeoutMs: 2_600,
  defaultHillshadeOpacity: 30,
  defaultElevationOpacity: 70,
  verticalExaggeration: 1.1,
  sunElevationDegrees: 45,
  sunAzimuthDegrees: 315,
  defaultHillshadeEnabled: true,
  defaultElevationEnabled: true,
  defaultElevationMode: "absolute" as const,
  hillshadeStorageKey: "cv-gis-exploration-relief",
  elevationStorageKey: "cv-gis-exploration-elevation",
  elevationModeStorageKey: "cv-gis-exploration-elevation-mode",
} as const;

export const ABSOLUTE_ELEVATION_MIN_M = -11_000;
export const ABSOLUTE_ELEVATION_MAX_M = 9_000;

// The ocean and land ramps are independent. Terrarium stores elevation only,
// so a negative land elevation cannot always be separated from bathymetry.
export const OCEAN_ELEVATION_STOPS = [
  { valueM: -11_000, color: "#092e53" },
  { valueM: -8_000, color: "#145d8b" },
  { valueM: -4_000, color: "#3d91af" },
  { valueM: -2_000, color: "#79b2ad" },
  { valueM: 0, color: "#367d53" },
] as const;

// Continuous, nonlinear land ramp inspired by the prepared QGIS terrain palette.
export const ABSOLUTE_ELEVATION_STOPS = [
  { valueM: 0, color: "#367d53" },
  { valueM: 250, color: "#7fa65e" },
  { valueM: 500, color: "#b6bc75" },
  { valueM: 1_000, color: "#d4b87b" },
  { valueM: 1_500, color: "#b28a64" },
  { valueM: 2_500, color: "#906b64" },
  { valueM: 4_000, color: "#765470" },
  { valueM: 9_000, color: "#523a69" },
] as const;

// The same natural land colours are spaced evenly when the range is regional.
export const ADAPTIVE_LAND_STOPS = [
  { position: 0, color: "#367d53" },
  { position: 0.12, color: "#7fa65e" },
  { position: 0.25, color: "#b6bc75" },
  { position: 0.45, color: "#d4b87b" },
  { position: 0.65, color: "#b28a64" },
  { position: 0.78, color: "#906b64" },
  { position: 0.9, color: "#765470" },
  { position: 1, color: "#523a69" },
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
    const storedMode = window.localStorage.getItem(EXPLORATION_TERRAIN.elevationModeStorageKey);
    return storedMode === "adaptive" || storedMode === "absolute"
      ? storedMode
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
