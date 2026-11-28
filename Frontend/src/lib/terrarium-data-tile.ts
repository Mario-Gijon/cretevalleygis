import DataTileSource from "ol/source/DataTile.js";
import type { LoaderOptions } from "ol/source/DataTile.js";
import { EXPLORATION_TERRAIN } from "@/lib/exploration-terrain";

const TILE_SIZE = 256;
const MAX_PARENT_FALLBACK_LEVELS = 3;
const DECODED_TILE_CACHE_SIZE = 48;
const FAILED_TILE_CACHE_SIZE = 48;
const FAILED_TILE_CACHE_TTL_MS = 30_000;
const DATA_TILE_CACHE_SIZE = 128;
const BASE_RASTER_CACHE_SIZE = 64;

export const TERRARIUM_DATA_GUTTER = 1;

type DecodedTerrariumTile = {
  elevations: Float32Array;
  valid: Uint8Array;
  validPixels: number;
};

export type TerrariumTileStats = {
  validPixels: number;
  fallbackPixels: number;
  missingPixels: number;
  failedRequests: boolean;
};

type TerrainTileRaster = {
  data: Float32Array;
  stats: TerrariumTileStats;
};

class TileRequestBudgetExceeded extends Error {}

export type TerrariumElevationSampleOptions = {
  signal?: AbortSignal;
  maximumZoom?: number;
  minimumZoom?: number;
  allowTileRequest?: (key: string) => boolean;
};

export type TerrariumElevationSample =
  | { status: "available"; elevationMeters: number; sourceZoom: number; pixelGroundDistanceMeters: number }
  | { status: "no-data" | "unavailable" | "outside-coverage" | "request-limit" };

export type TerrariumDataTileSource = {
  source: DataTileSource;
  getTileStats: (zoom: number, x: number, y: number) => TerrariumTileStats | undefined;
  samplePoint: (longitude: number, latitude: number, signal?: AbortSignal) => Promise<TerrariumPointNeighborhood>;
  sampleElevation: (longitude: number, latitude: number, options?: TerrariumElevationSampleOptions) => Promise<TerrariumElevationSample>;
};

export type TerrariumPointNeighborhood =
  | { status: "complete"; elevationMeters: number; westMeters: number; eastMeters: number; northMeters: number; southMeters: number; sourceZoom: number; pixelGroundDistanceMeters: number }
  | { status: "elevation-only"; elevationMeters: number; sourceZoom: number; pixelGroundDistanceMeters: number }
  | { status: "no-data" }
  | { status: "unavailable" }
  | { status: "outside-coverage" };

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * 6_378_137;

function wrappedTileX(x: number, zoom: number): number {
  const width = 2 ** zoom;
  return ((x % width) + width) % width;
}

function tileKey(zoom: number, x: number, y: number): string {
  return `${zoom}/${wrappedTileX(x, zoom)}/${y}`;
}

function trimMap<T>(cache: Map<string, T>, maximumSize: number): void {
  while (cache.size > maximumSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return;
    cache.delete(oldestKey);
  }
}

function isValidTerrariumPixel(red: number, green: number, blue: number): boolean {
  // The terrain tile service encodes unavailable cells as RGB 0,0,0 (-32,768 m).
  // That value is outside Terrarium's real terrestrial/bathymetric range.
  return red !== 0 || green !== 0 || blue !== 0;
}

async function decodeTerrariumTile(z: number, x: number, y: number): Promise<DecodedTerrariumTile | null> {
  const url = EXPLORATION_TERRAIN.url
    .replace("{z}", String(z))
    .replace("{x}", String(wrappedTileX(x, z)))
    .replace("{y}", String(y));

  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    try {
      if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) return null;
      const canvas = document.createElement("canvas");
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
      const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);
      const valid = new Uint8Array(TILE_SIZE * TILE_SIZE);
      let validPixels = 0;

      for (let pixel = 0; pixel < valid.length; pixel += 1) {
        const offset = pixel * 4;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        if (!isValidTerrariumPixel(red, green, blue)) continue;

        const elevation = red * 256 + green + blue / 256 - 32768;
        if (!Number.isFinite(elevation) || elevation < -11_000 || elevation > 9_000) continue;
        elevations[pixel] = elevation;
        valid[pixel] = 1;
        validPixels += 1;
      }
      return { elevations, valid, validPixels };
    } finally {
      bitmap.close();
    }
  } catch {
    // A failed request or an unreadable/invalid PNG may still have a usable parent tile.
    return null;
  }
}

function sampleParentElevation(
  tile: DecodedTerrariumTile,
  x: number,
  y: number,
): number | null {
  const clampedX = Math.max(0, Math.min(TILE_SIZE - 1, x));
  const clampedY = Math.max(0, Math.min(TILE_SIZE - 1, y));
  const left = Math.floor(clampedX);
  const top = Math.floor(clampedY);
  const right = Math.min(TILE_SIZE - 1, left + 1);
  const bottom = Math.min(TILE_SIZE - 1, top + 1);
  const xFraction = clampedX - left;
  const yFraction = clampedY - top;
  const samples = [
    [left, top, (1 - xFraction) * (1 - yFraction)],
    [right, top, xFraction * (1 - yFraction)],
    [left, bottom, (1 - xFraction) * yFraction],
    [right, bottom, xFraction * yFraction],
  ] as const;
  let weightedElevation = 0;
  let validWeight = 0;

  for (const [sampleX, sampleY, weight] of samples) {
    if (weight <= 0) continue;
    const index = sampleY * TILE_SIZE + sampleX;
    if (!tile.valid[index]) continue;
    weightedElevation += tile.elevations[index] * weight;
    validWeight += weight;
  }

  return validWeight > 0 ? weightedElevation / validWeight : null;
}

export function createTerrariumDataTileSource(): TerrariumDataTileSource {
  const decodedTiles = new Map<string, Promise<DecodedTerrariumTile | null>>();
  const failedTileExpirations = new Map<string, number>();
  const statsByTile = new Map<string, TerrariumTileStats>();
  const baseRasterTiles = new Map<string, Promise<TerrainTileRaster>>();

  const loadDecodedTile = (
    zoom: number,
    x: number,
    y: number,
    allowTileRequest?: (key: string) => boolean,
  ): Promise<DecodedTerrariumTile | null> => {
    const key = tileKey(zoom, x, y);
    const cached = decodedTiles.get(key);
    if (cached) {
      decodedTiles.delete(key);
      decodedTiles.set(key, cached);
      return cached;
    }
    const failedUntil = failedTileExpirations.get(key);
    if (failedUntil && failedUntil > Date.now()) return Promise.resolve(null);
    if (failedUntil) failedTileExpirations.delete(key);
    if (allowTileRequest && !allowTileRequest(key)) throw new TileRequestBudgetExceeded();

    const request = decodeTerrariumTile(zoom, x, y).then((tile) => {
      if (!tile) {
        decodedTiles.delete(key);
        failedTileExpirations.set(key, Date.now() + FAILED_TILE_CACHE_TTL_MS);
        trimMap(failedTileExpirations, FAILED_TILE_CACHE_SIZE);
      }
      return tile;
    });
    decodedTiles.set(key, request);
    trimMap(decodedTiles, DECODED_TILE_CACHE_SIZE);
    return request;
  };

  const buildBaseRasterTile = async (
    zoom: number,
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<TerrainTileRaster> => {
    const pixelCount = TILE_SIZE * TILE_SIZE;
    const output = new Float32Array(pixelCount * 2);
    const key = tileKey(zoom, x, y);
    const emptyStats: TerrariumTileStats = {
      validPixels: 0,
      fallbackPixels: 0,
      missingPixels: pixelCount,
      failedRequests: false,
    };

    if (y < 0 || y >= 2 ** zoom || zoom > EXPLORATION_TERRAIN.maxDataZoom) {
      statsByTile.set(key, emptyStats);
      trimMap(statsByTile, DATA_TILE_CACHE_SIZE);
      return { data: output, stats: emptyStats };
    }

    const sourceX = wrappedTileX(x, zoom);
    const current = await loadDecodedTile(zoom, sourceX, y);
    if (signal.aborted) throw signal.reason;
    const valid = new Uint8Array(pixelCount);
    const stats = { ...emptyStats, failedRequests: current === null };
    let hasMissingPixels = false;

    if (current) {
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (!current.valid[pixel]) {
          hasMissingPixels = true;
          continue;
        }
        output[pixel * 2] = current.elevations[pixel];
        output[pixel * 2 + 1] = 1;
        valid[pixel] = 1;
        stats.validPixels += 1;
      }
    } else {
      hasMissingPixels = true;
    }

    for (let parentZoom = zoom - 1, fallbackLevel = 1;
      hasMissingPixels && fallbackLevel <= MAX_PARENT_FALLBACK_LEVELS && parentZoom >= EXPLORATION_TERRAIN.mapMinimumZoom;
      parentZoom -= 1, fallbackLevel += 1) {
      if (signal.aborted) throw signal.reason;
      const factor = 2 ** fallbackLevel;
      const parentX = Math.floor(sourceX / factor);
      const parentY = Math.floor(y / factor);
      const parent = await loadDecodedTile(parentZoom, parentX, parentY);
      if (!parent) {
        stats.failedRequests = true;
        continue;
      }

      const childOffsetX = sourceX - parentX * factor;
      const childOffsetY = y - parentY * factor;
      hasMissingPixels = false;
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (valid[pixel]) continue;
        const pixelX = pixel % TILE_SIZE;
        const pixelY = Math.floor(pixel / TILE_SIZE);
        const parentPixelX = childOffsetX * TILE_SIZE / factor + (pixelX + 0.5) / factor - 0.5;
        const parentPixelY = childOffsetY * TILE_SIZE / factor + (pixelY + 0.5) / factor - 0.5;
        const elevation = sampleParentElevation(parent, parentPixelX, parentPixelY);
        if (elevation === null) {
          hasMissingPixels = true;
          continue;
        }
        output[pixel * 2] = elevation;
        output[pixel * 2 + 1] = 1;
        valid[pixel] = 1;
        stats.validPixels += 1;
        stats.fallbackPixels += 1;
      }
    }

    stats.missingPixels = pixelCount - stats.validPixels;
    statsByTile.set(key, stats);
    trimMap(statsByTile, DATA_TILE_CACHE_SIZE);
    return { data: output, stats };
  };

  const loadBaseRasterTile = (zoom: number, x: number, y: number, signal: AbortSignal): Promise<TerrainTileRaster> => {
    const key = tileKey(zoom, x, y);
    const cached = baseRasterTiles.get(key);
    if (cached) {
      baseRasterTiles.delete(key);
      baseRasterTiles.set(key, cached);
      return cached;
    }
    const request = buildBaseRasterTile(zoom, wrappedTileX(x, zoom), y, signal).catch((error: unknown) => {
      baseRasterTiles.delete(key);
      throw error;
    });
    baseRasterTiles.set(key, request);
    trimMap(baseRasterTiles, BASE_RASTER_CACHE_SIZE);
    return request;
  };

  const sampleWorldPixel = async (
    zoom: number,
    worldPixelX: number,
    worldPixelY: number,
    signal?: AbortSignal,
    allowTileRequest?: (key: string) => boolean,
  ): Promise<{ elevation: number | null; loadedTile: boolean }> => {
    const sampleX = worldPixelX - 0.5;
    const sampleY = worldPixelY - 0.5;
    const left = Math.floor(sampleX);
    const top = Math.floor(sampleY);
    const xFraction = sampleX - left;
    const yFraction = sampleY - top;
    const corners = [
      [left, top, (1 - xFraction) * (1 - yFraction)],
      [left + 1, top, xFraction * (1 - yFraction)],
      [left, top + 1, (1 - xFraction) * yFraction],
      [left + 1, top + 1, xFraction * yFraction],
    ] as const;
    let weightedElevation = 0;
    let validWeight = 0;
    let loadedTile = false;

    for (const [pixelX, pixelY, weight] of corners) {
      if (weight <= 1e-8) continue;
      const tileX = Math.floor(pixelX / TILE_SIZE);
      const tileY = Math.floor(pixelY / TILE_SIZE);
      if (tileY < 0 || tileY >= 2 ** zoom) continue;
      const tile = await loadDecodedTile(zoom, tileX, tileY, allowTileRequest);
      if (signal?.aborted) throw signal.reason;
      if (!tile) continue;
      loadedTile = true;
      const localX = pixelX - tileX * TILE_SIZE;
      const localY = pixelY - tileY * TILE_SIZE;
      const index = localY * TILE_SIZE + localX;
      if (!tile.valid[index]) continue;
      weightedElevation += tile.elevations[index] * weight;
      validWeight += weight;
    }

    // Do not interpolate across NoData gaps; try a parent tile instead.
    return {
      elevation: validWeight >= 1 - 1e-6 ? weightedElevation / validWeight : null,
      loadedTile,
    };
  };

  const samplePoint: TerrariumDataTileSource["samplePoint"] = async (longitude, latitude, signal) => {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180
      || Math.abs(latitude) > WEB_MERCATOR_MAX_LATITUDE) {
      return { status: "outside-coverage" };
    }

    const firstZoom = EXPLORATION_TERRAIN.maxDataZoom;
    const lastZoom = Math.max(EXPLORATION_TERRAIN.mapMinimumZoom, firstZoom - MAX_PARENT_FALLBACK_LEVELS);
    let loadedAnyTile = false;
    let bestElevation: { elevationMeters: number; sourceZoom: number; pixelGroundDistanceMeters: number } | undefined;

    for (let zoom = firstZoom; zoom >= lastZoom; zoom -= 1) {
      if (signal?.aborted) throw signal.reason;
      const tileCount = 2 ** zoom;
      const latitudeRadians = (latitude * Math.PI) / 180;
      const worldPixelX = ((longitude + 180) / 360) * tileCount * TILE_SIZE;
      const worldPixelY = ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * tileCount * TILE_SIZE;
      const center = await sampleWorldPixel(zoom, worldPixelX, worldPixelY, signal);
      loadedAnyTile ||= center.loadedTile;
      if (center.elevation === null) continue;

      const pixelGroundDistanceMeters = (EARTH_CIRCUMFERENCE_METERS / (tileCount * TILE_SIZE)) * Math.cos(latitudeRadians);
      bestElevation ??= { elevationMeters: center.elevation, sourceZoom: zoom, pixelGroundDistanceMeters };
      const [west, east, north, south] = await Promise.all([
        sampleWorldPixel(zoom, worldPixelX - 1, worldPixelY, signal),
        sampleWorldPixel(zoom, worldPixelX + 1, worldPixelY, signal),
        sampleWorldPixel(zoom, worldPixelX, worldPixelY - 1, signal),
        sampleWorldPixel(zoom, worldPixelX, worldPixelY + 1, signal),
      ]);
      loadedAnyTile ||= west.loadedTile || east.loadedTile || north.loadedTile || south.loadedTile;
      if ([west, east, north, south].every((sample) => sample.elevation !== null)) {
        return {
          status: "complete",
          elevationMeters: center.elevation,
          westMeters: west.elevation!,
          eastMeters: east.elevation!,
          northMeters: north.elevation!,
          southMeters: south.elevation!,
          sourceZoom: zoom,
          pixelGroundDistanceMeters,
        };
      }
    }

    if (bestElevation) return { status: "elevation-only", ...bestElevation };
    return { status: loadedAnyTile ? "no-data" : "unavailable" };
  };

  const sampleElevation: TerrariumDataTileSource["sampleElevation"] = async (longitude, latitude, options = {}) => {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180
      || Math.abs(latitude) > WEB_MERCATOR_MAX_LATITUDE) {
      return { status: "outside-coverage" };
    }

    const firstZoom = Math.max(
      EXPLORATION_TERRAIN.mapMinimumZoom,
      Math.min(EXPLORATION_TERRAIN.maxDataZoom, Math.floor(options.maximumZoom ?? EXPLORATION_TERRAIN.maxDataZoom)),
    );
    const lastZoom = Math.max(
      EXPLORATION_TERRAIN.mapMinimumZoom,
      Math.min(firstZoom, Math.floor(options.minimumZoom ?? firstZoom - MAX_PARENT_FALLBACK_LEVELS)),
    );
    const latitudeRadians = (latitude * Math.PI) / 180;
    let loadedAnyTile = false;

    try {
      for (let zoom = firstZoom; zoom >= lastZoom; zoom -= 1) {
        if (options.signal?.aborted) throw options.signal.reason;
        const tileCount = 2 ** zoom;
        const worldPixelX = ((longitude + 180) / 360) * tileCount * TILE_SIZE;
        const worldPixelY = ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * tileCount * TILE_SIZE;
        const center = await sampleWorldPixel(
          zoom,
          worldPixelX,
          worldPixelY,
          options.signal,
          options.allowTileRequest,
        );
        loadedAnyTile ||= center.loadedTile;
        if (center.elevation === null) continue;

        const pixelGroundDistanceMeters = (EARTH_CIRCUMFERENCE_METERS / (tileCount * TILE_SIZE)) * Math.cos(latitudeRadians);
        return {
          status: "available",
          elevationMeters: center.elevation,
          sourceZoom: zoom,
          pixelGroundDistanceMeters,
        };
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof TileRequestBudgetExceeded) return { status: "request-limit" };
      throw error;
    }

    return { status: loadedAnyTile ? "no-data" : "unavailable" };
  };

  const loader = async (zoom: number, x: number, y: number, options: LoaderOptions) => {
    const sourceX = wrappedTileX(x, zoom);
    const centerTile = await loadBaseRasterTile(zoom, sourceX, y, options.signal);
    const gutter = TERRARIUM_DATA_GUTTER;
    const paddedSize = TILE_SIZE + gutter * 2;
    const output = new Float32Array(paddedSize * paddedSize * 2);
    const neighborOffsets: Array<[number, number]> = [];
    for (let tileY = -1; tileY <= 1; tileY += 1) {
      for (let tileX = -1; tileX <= 1; tileX += 1) {
        if (tileX === 0 && tileY === 0) continue;
        neighborOffsets.push([tileX, tileY]);
      }
    }
    const neighborTiles = await Promise.all(neighborOffsets.map(async ([tileX, tileY]) => {
      if (options.signal.aborted) throw options.signal.reason;
      const neighborY = y + tileY;
      if (neighborY < 0 || neighborY >= 2 ** zoom) return { offset: [tileX, tileY] as const, tile: null };
      const tile = await loadBaseRasterTile(zoom, sourceX + tileX, neighborY, options.signal);
      return { offset: [tileX, tileY] as const, tile };
    }));
    const rasterByOffset = new globalThis.Map<string, TerrainTileRaster>([
      ["0/0", centerTile],
      ...neighborTiles.flatMap(({ offset, tile }) => tile ? [[offset.join("/"), tile] as const] : []),
    ]);

    for (let outputY = 0; outputY < paddedSize; outputY += 1) {
      const tileOffsetY = outputY === 0 ? -1 : outputY === paddedSize - 1 ? 1 : 0;
      const sourceY = outputY === 0 ? TILE_SIZE - 1 : outputY === paddedSize - 1 ? 0 : outputY - gutter;
      for (let outputX = 0; outputX < paddedSize; outputX += 1) {
        const tileOffsetX = outputX === 0 ? -1 : outputX === paddedSize - 1 ? 1 : 0;
        const sourceXInTile = outputX === 0 ? TILE_SIZE - 1 : outputX === paddedSize - 1 ? 0 : outputX - gutter;
        const sourceTile = rasterByOffset.get(`${tileOffsetX}/${tileOffsetY}`);
        if (!sourceTile) continue;
        const sourceOffset = (sourceY * TILE_SIZE + sourceXInTile) * 2;
        const outputOffset = (outputY * paddedSize + outputX) * 2;
        output[outputOffset] = sourceTile.data[sourceOffset];
        output[outputOffset + 1] = sourceTile.data[sourceOffset + 1];
      }
    }

    return output;
  };

  const source = new DataTileSource({
    loader,
    bandCount: 2,
    hasAlpha: true,
    minZoom: EXPLORATION_TERRAIN.mapMinimumZoom,
    maxZoom: EXPLORATION_TERRAIN.maxDataZoom,
    tileSize: TILE_SIZE,
    gutter: TERRARIUM_DATA_GUTTER,
    wrapX: true,
    transition: 180,
    interpolate: true,
  });

  return {
    source,
    getTileStats: (zoom, x, y) => statsByTile.get(tileKey(zoom, x, y)),
    samplePoint,
    sampleElevation,
  };
}

let sharedTerrariumDataTileSource: TerrariumDataTileSource | null = null;

export function getSharedTerrariumDataTileSource(): TerrariumDataTileSource {
  sharedTerrariumDataTileSource ??= createTerrariumDataTileSource();
  return sharedTerrariumDataTileSource;
}
