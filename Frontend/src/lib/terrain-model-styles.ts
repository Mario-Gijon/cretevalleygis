import {
  ABSOLUTE_ELEVATION_STOPS,
  ADAPTIVE_LAND_STOPS,
  ASPECT_CLASSES,
  ASPECT_FLAT_COLOR,
  SLOPE_CLASSES,
} from "@/lib/exploration-terrain";
import type { TerrainModelDerivatives } from "@/lib/terrain-model";
import type { TerrainGrid } from "@/lib/terrain-model-mesh";

export type TerrainModelBaseTheme = "natural" | "elevation" | "hillshade";
export type TerrainModelTheme = TerrainModelBaseTheme | "slope" | "aspect";

export const TERRAIN_THEME_NODATA_COLOR = "#687783";
export const TERRAIN_ASPECT_FLAT_COLOR = ASPECT_FLAT_COLOR;

export type TerrainColorStop = { valueM: number; color: string };
export type RelativeColorStop = { position: number; color: string };

export const ABSOLUTE_MODEL_ELEVATION_MIN_M = -11_000;
export const ABSOLUTE_MODEL_ELEVATION_MAX_M = 9_000;

// Copernicus is a surface model, not a land/sea classification. Negative
// heights use a muted land-green extension of the fixed elevation ramp.
export const ABSOLUTE_MODEL_ELEVATION_STOPS: readonly TerrainColorStop[] = [
  { valueM: ABSOLUTE_MODEL_ELEVATION_MIN_M, color: "#285b50" },
  ...ABSOLUTE_ELEVATION_STOPS,
];

export const NATURAL_RELIEF_STOPS: readonly RelativeColorStop[] = ADAPTIVE_LAND_STOPS;

const HILLSHADE_COLOR = "#aeb5b2";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function hexChannels(color: string): [number, number, number] {
  const normalized = color.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [number, number, number];
}

function channelsToHex(channels: [number, number, number]): string {
  return `#${channels.map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

function interpolateColors(first: string, second: string, fraction: number): string {
  const from = hexChannels(first);
  const to = hexChannels(second);
  return channelsToHex(from.map((value, index) => value + (to[index] - value) * fraction) as [number, number, number]);
}

function interpolateAbsolutePalette(valueM: number): string {
  const stops = ABSOLUTE_MODEL_ELEVATION_STOPS;
  const bounded = clamp(valueM, ABSOLUTE_MODEL_ELEVATION_MIN_M, ABSOLUTE_MODEL_ELEVATION_MAX_M);
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    if (bounded <= next.valueM) {
      const span = next.valueM - previous.valueM;
      const fraction = span > 0 ? (bounded - previous.valueM) / span : 0;
      return interpolateColors(previous.color, next.color, fraction);
    }
  }
  return stops[stops.length - 1].color;
}

function interpolateRelativePalette(position: number): string {
  const bounded = clamp(position, 0, 1);
  for (let index = 1; index < NATURAL_RELIEF_STOPS.length; index += 1) {
    const previous = NATURAL_RELIEF_STOPS[index - 1];
    const next = NATURAL_RELIEF_STOPS[index];
    if (bounded <= next.position) {
      const span = next.position - previous.position;
      const fraction = span > 0 ? (bounded - previous.position) / span : 0;
      return interpolateColors(previous.color, next.color, fraction);
    }
  }
  return NATURAL_RELIEF_STOPS[NATURAL_RELIEF_STOPS.length - 1].color;
}

export function terrainModelColorForElevation(
  elevationM: number,
  theme: TerrainModelBaseTheme,
  minimumElevationM: number,
  maximumElevationM: number,
): string {
  if (!Number.isFinite(elevationM)) return HILLSHADE_COLOR;
  if (theme === "hillshade") return HILLSHADE_COLOR;
  if (theme === "elevation") return interpolateAbsolutePalette(elevationM);

  const range = maximumElevationM - minimumElevationM;
  // A flat range gets the middle natural color without dividing by zero.
  const position = Number.isFinite(range) && range > 0
    ? clamp((elevationM - minimumElevationM) / range, 0, 1)
    : 0.5;
  return interpolateRelativePalette(position);
}

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * Produces one linear-RGB vertex color per source sample. Null samples remain
 * zero and are never indexed by the valid terrain triangulation.
 */
export function buildTerrainVertexColors(
  grid: TerrainGrid,
  theme: TerrainModelBaseTheme,
  minimumElevationM: number,
  maximumElevationM: number,
): Float32Array {
  const colors = new Float32Array(grid.rows * grid.columns * 3);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const elevation = grid.values_m[row][column];
      if (elevation === null || !Number.isFinite(elevation)) continue;
      const offset = (row * grid.columns + column) * 3;
      const color = hexChannels(terrainModelColorForElevation(elevation, theme, minimumElevationM, maximumElevationM));
      colors[offset] = srgbChannelToLinear(color[0] / 255);
      colors[offset + 1] = srgbChannelToLinear(color[1] / 255);
      colors[offset + 2] = srgbChannelToLinear(color[2] / 255);
    }
  }
  return colors;
}

export function terrainModelLegendStops(theme: Exclude<TerrainModelBaseTheme, "hillshade">): Array<{ position: number; color: string }> {
  if (theme === "natural") {
    return NATURAL_RELIEF_STOPS.map((stop) => ({ position: stop.position * 100, color: stop.color }));
  }
  const span = ABSOLUTE_MODEL_ELEVATION_MAX_M - ABSOLUTE_MODEL_ELEVATION_MIN_M;
  return ABSOLUTE_MODEL_ELEVATION_STOPS.map((stop) => ({
    position: (stop.valueM - ABSOLUTE_MODEL_ELEVATION_MIN_M) / span * 100,
    color: stop.color,
  }));
}

export function classifySlope(value: number | null): { color: string; label: string } | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  const category = SLOPE_CLASSES.find((entry) => value <= entry.maximumPercent);
  return category ? { color: category.color, label: category.label } : null;
}

export function classifyAspect(value: number | null, flat: boolean): { color: string; label: string } | null {
  if (flat) return value === null ? { color: ASPECT_FLAT_COLOR, label: "Plano" } : null;
  if (value === null || !Number.isFinite(value) || value < 0 || value > 360) return null;
  if (value <= 22.5 || value > 337.5) {
    const north = ASPECT_CLASSES[0];
    return { color: north.color, label: north.label };
  }
  const boundaries = [67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5];
  const index = boundaries.findIndex((boundary) => value <= boundary) + 1;
  const category = ASPECT_CLASSES[index];
  return { color: category.color, label: category.label };
}

export function buildCategoricalColors(
  theme: "slope" | "aspect",
  derivatives: TerrainModelDerivatives,
): string[] {
  const { rows, columns } = derivatives.slope.values_percent.reduce((shape, row) => ({
    rows: shape.rows + 1,
    columns: row.length,
  }), { rows: 0, columns: 0 });
  const colors: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const category = theme === "slope"
        ? classifySlope(derivatives.slope.values_percent[row][column])
        : classifyAspect(derivatives.aspect.values_degrees[row][column], derivatives.aspect.flat_mask[row][column]);
      colors.push(category?.color ?? TERRAIN_THEME_NODATA_COLOR);
    }
  }
  return colors;
}

export function categoricalColorsToRgba(colors: string[]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(colors.length * 4);
  colors.forEach((color, index) => {
    const channels = hexChannels(color);
    const offset = index * 4;
    pixels[offset] = channels[0];
    pixels[offset + 1] = channels[1];
    pixels[offset + 2] = channels[2];
    pixels[offset + 3] = 255;
  });
  return pixels;
}

/** UVs sample the center of each texel; the CanvasTexture's Y flip aligns north-up row 0. */
export function buildCategoricalSampleUvs(columns: number, rows: number): Float32Array {
  const uvs = new Float32Array(columns * rows * 2);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const offset = (row * columns + column) * 2;
      uvs[offset] = (column + 0.5) / columns;
      uvs[offset + 1] = 1 - (row + 0.5) / rows;
    }
  }
  return uvs;
}

export const SLOPE_THEME_LEGEND = SLOPE_CLASSES.map(({ label, color }) => ({ label, color }));
export const ASPECT_THEME_LEGEND = [
  ...ASPECT_CLASSES.map(({ direction, label, color }) => ({ direction, label, color })),
  { direction: "flat", label: "Plano", color: ASPECT_FLAT_COLOR },
];
