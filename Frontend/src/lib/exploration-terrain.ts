export const EXPLORATION_TERRAIN = {
  url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  mapMinimumZoom: 2,
  generalizedZoomThreshold: 8,
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
  defaultElevationMode: "absolute" as const,
  hillshadeStorageKey: "cv-gis-exploration-relief",
  elevationStorageKey: "cv-gis-exploration-elevation",
  elevationModeStorageKey: "cv-gis-exploration-elevation-mode",
  themeStorageKey: "cv-gis-exploration-theme",
  themeOpacityStorageKey: "cv-gis-exploration-theme-opacity",
  defaultThemeOpacity: 70,
  flatAspectThresholdPercent: 0.1,
  aspectSectorHalfWidthDegrees: 22.5,
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
export type ExplorationTerrainTheme = "none" | "elevation" | "slope" | "aspect";
export type ExplorationTerrainRepresentation = Exclude<ExplorationTerrainTheme, "none">;

export function initialExplorationThemeOpacities(): Record<ExplorationTerrainRepresentation, number> {
  const defaults: Record<ExplorationTerrainRepresentation, number> = {
    elevation: EXPLORATION_TERRAIN.defaultThemeOpacity,
    slope: EXPLORATION_TERRAIN.defaultThemeOpacity,
    aspect: EXPLORATION_TERRAIN.defaultThemeOpacity,
  };
  try {
    for (const theme of Object.keys(defaults) as ExplorationTerrainRepresentation[]) {
      const stored = window.localStorage.getItem(`${EXPLORATION_TERRAIN.themeOpacityStorageKey}-${theme}`);
      if (stored !== null) {
        const value = Number(stored);
        if (Number.isFinite(value)) defaults[theme] = Math.max(0, Math.min(80, value));
      }
    }
  } catch {
    // Keep the defaults when browser storage is unavailable.
  }
  return defaults;
}

export const SLOPE_CLASSES = [
  { maximumPercent: 5, color: "#4f9f83", label: "0–5 %" },
  { maximumPercent: 15, color: "#a8c96f", label: ">5–15 %" },
  { maximumPercent: 30, color: "#f0df73", label: ">15–30 %" },
  { maximumPercent: 60, color: "#ed9c58", label: ">30–60 %" },
  { maximumPercent: Number.POSITIVE_INFINITY, color: "#c84a43", label: ">60 %" },
] as const;

export const ASPECT_CLASSES = [
  { direction: "N", color: "#f2d34f", label: "Norte" },
  { direction: "NE", color: "#9bc85b", label: "Noreste" },
  { direction: "E", color: "#48a88e", label: "Este" },
  { direction: "SE", color: "#4b9dc5", label: "Sureste" },
  { direction: "S", color: "#526dba", label: "Sur" },
  { direction: "SO", color: "#8567b8", label: "Suroeste" },
  { direction: "O", color: "#c06b9b", label: "Oeste" },
  { direction: "NO", color: "#e18759", label: "Noroeste" },
] as const;

export const ASPECT_FLAT_COLOR = "#c9c9c4";

/** Ground distance represented by one Terrarium source pixel in Web Mercator. */
export function terrainPixelGroundDistanceMeters(
  sourcePixelResolution: number,
  latitudeDegrees: number,
): number {
  return Math.max(0.1, sourcePixelResolution * Math.max(0.05, Math.cos((latitudeDegrees * Math.PI) / 180)));
}

export function effectiveTerrainSourceZoom(selectedTileZoom: number, maximumDataZoom: number): number {
  return Math.max(0, Math.min(maximumDataZoom, Math.floor(selectedTileZoom)));
}

/** Central-difference slope and downslope azimuth for four neighboring samples. */
export function terrainDerivatives(
  westMeters: number,
  eastMeters: number,
  northMeters: number,
  southMeters: number,
  pixelGroundDistanceMeters: number,
): { slopePercent: number; aspectDegrees: number | null } {
  const distance = Math.max(0.1, pixelGroundDistanceMeters);
  const dzdx = (eastMeters - westMeters) / (2 * distance);
  // Terrarium tile rows increase southward, so the south sample is +Y.
  const dzdy = (southMeters - northMeters) / (2 * distance);
  const slopePercent = Math.hypot(dzdx, dzdy) * 100;
  if (slopePercent <= EXPLORATION_TERRAIN.flatAspectThresholdPercent) {
    return { slopePercent, aspectDegrees: null };
  }
  const azimuth = (Math.atan2(-dzdx, dzdy) * 180) / Math.PI;
  return { slopePercent, aspectDegrees: (azimuth + 360) % 360 };
}
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
