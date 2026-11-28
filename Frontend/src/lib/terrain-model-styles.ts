import {
  ABSOLUTE_ELEVATION_STOPS,
  ADAPTIVE_LAND_STOPS,
} from "@/lib/exploration-terrain";
import type { TerrainGrid } from "@/lib/terrain-model-mesh";

export type TerrainModelTheme = "natural" | "elevation" | "hillshade";

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
  theme: TerrainModelTheme,
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
  theme: TerrainModelTheme,
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

export function terrainModelLegendStops(theme: Exclude<TerrainModelTheme, "hillshade">): Array<{ position: number; color: string }> {
  if (theme === "natural") {
    return NATURAL_RELIEF_STOPS.map((stop) => ({ position: stop.position * 100, color: stop.color }));
  }
  const span = ABSOLUTE_MODEL_ELEVATION_MAX_M - ABSOLUTE_MODEL_ELEVATION_MIN_M;
  return ABSOLUTE_MODEL_ELEVATION_STOPS.map((stop) => ({
    position: (stop.valueM - ABSOLUTE_MODEL_ELEVATION_MIN_M) / span * 100,
    color: stop.color,
  }));
}
