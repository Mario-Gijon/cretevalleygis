import { addProtocol, type AddProtocolResponseData } from "maplibre-gl";
import { EXPLORATION_TERRAIN } from "@/lib/exploration-terrain";
import { getSharedTerrariumDataTileSource, type TerrariumTileStats } from "@/lib/terrarium-data-tile";

const PROTOCOL = "cvterrarium";
const TILE_SIZE = 256;
const NO_DATA_RESPONSE = { data: null as unknown as AddProtocolResponseData };
const listeners = new Set<(event: TerrariumDemTileEvent) => void>();
const latestEvents = new Map<string, TerrariumDemTileEvent>();

export type TerrariumDemTileEvent = {
  key: string;
  status: "available" | "no-data" | "error";
  stats?: TerrariumTileStats;
  message?: string;
};

function publish(event: TerrariumDemTileEvent): void {
  latestEvents.delete(event.key);
  latestEvents.set(event.key, event);
  while (latestEvents.size > 128) {
    const oldestKey = latestEvents.keys().next().value;
    if (oldestKey === undefined) break;
    latestEvents.delete(oldestKey);
  }
  listeners.forEach((listener) => listener(event));
}

export function subscribeTerrariumDemTiles(listener: (event: TerrariumDemTileEvent) => void): () => void {
  listeners.add(listener);
  latestEvents.forEach(listener);
  return () => listeners.delete(listener);
}

function tileCoordinates(url: string): [number, number, number] | null {
  try {
    const path = new URL(url).pathname.split("/").filter(Boolean);
    if (path.length !== 3) return null;
    const [zoomText, xText, yText] = path;
    const zoom = Number(zoomText);
    const x = Number(xText);
    const y = Number(yText.replace(/\.(png|webp)$/i, ""));
    return [zoom, x, y].every(Number.isInteger) ? [zoom, x, y] : null;
  } catch {
    return null;
  }
}

function terrariumBytes(elevations: Float32Array): ImageData {
  const image = new ImageData(TILE_SIZE, TILE_SIZE);
  for (let pixel = 0; pixel < TILE_SIZE * TILE_SIZE; pixel += 1) {
    const elevation = elevations[pixel * 2];
    const valid = elevations[pixel * 2 + 1] >= 0.99;
    if (!valid || !Number.isFinite(elevation)) continue;

    const terrariumValue = elevation + 32768;
    const red = Math.floor(terrariumValue / 256);
    const green = Math.floor(terrariumValue - red * 256);
    const blue = Math.round((terrariumValue - Math.floor(terrariumValue)) * 256);
    const offset = pixel * 4;
    image.data[offset] = red;
    image.data[offset + 1] = green;
    image.data[offset + 2] = Math.min(255, blue);
    image.data[offset + 3] = 255;
  }
  return image;
}

async function loadTile(url: string, abortController: AbortController): Promise<{ data: AddProtocolResponseData }> {
  const coordinates = tileCoordinates(url);
  if (!coordinates) throw new Error("La solicitud de elevación contiene coordenadas de tesela no válidas.");
  const [zoom, x, y] = coordinates;
  if (zoom < EXPLORATION_TERRAIN.mapMinimumZoom || y < 0 || y >= 2 ** zoom) {
    publish({ key: `${zoom}/${x}/${y}`, status: "no-data" });
    return NO_DATA_RESPONSE;
  }

  try {
    const tile = await getSharedTerrariumDataTileSource().loadDemTile(zoom, x, y, abortController.signal);
    if (abortController.signal.aborted) throw abortController.signal.reason;
    const key = `${Math.min(zoom, EXPLORATION_TERRAIN.maxDataZoom)}/${x}/${y}`;

    // MapLibre's DEM decoder reads RGB and ignores alpha. A partly transparent image
    // would still become a very deep pit, so only complete, fallback-filled tiles are encoded.
    if (tile.stats.validPixels !== TILE_SIZE * TILE_SIZE || tile.stats.missingPixels > 0) {
      publish({ key, status: "no-data", stats: tile.stats });
      return NO_DATA_RESPONSE;
    }

    const canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
      : document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: false });
    if (!context) throw new Error("No se pudo crear la imagen DEM de la tesela.");
    context.putImageData(terrariumBytes(tile.data), 0, 0);
    const image = await createImageBitmap(canvas);
    publish({ key, status: "available", stats: tile.stats });
    return { data: image };
  } catch (error) {
    if (abortController.signal.aborted) throw abortController.signal.reason;
    const message = error instanceof Error ? error.message : "No se pudo preparar la tesela de elevación.";
    publish({ key: `${zoom}/${x}/${y}`, status: "error", message });
    throw error;
  }
}

addProtocol(PROTOCOL, (request, abortController) => loadTile(request.url, abortController));

export const TERRARIUM_DEM_TILE_TEMPLATE = `${PROTOCOL}://terrain/{z}/{x}/{y}.png`;
