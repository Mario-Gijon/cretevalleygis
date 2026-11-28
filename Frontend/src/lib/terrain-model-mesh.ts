import type { LocalPolygonGeometry, TerrainModelResponse } from "@/lib/terrain-model";

export type TerrainGrid = TerrainModelResponse["grid"];

export type TerrainMeshData = {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  validVertexCount: number;
  triangleCount: number;
  referenceElevationM: number;
  minimumElevationM: number | null;
  maximumElevationM: number | null;
  sampleCenterBounds: { west: number; south: number; east: number; north: number };
};

export type TerrainSupportMeshData = {
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  triangleCount: number;
};

export type TerrainVolumeSupportData = {
  walls: TerrainSupportMeshData;
  base: TerrainSupportMeshData;
  boundaryEdgeCount: number;
  thicknessM: number;
  baseElevationM: number | null;
};

export type TexturePolygon = {
  rings: Array<Array<[number, number]>>;
};

export function terrainGridFrame(grid: TerrainGrid) {
  const { columns, rows, first_sample_local_m: first, sample_spacing_m: spacing } = grid;
  const west = first.east;
  const east = first.east + (columns - 1) * spacing.east;
  const north = first.north;
  const south = first.north - (rows - 1) * spacing.north;
  return {
    west,
    south,
    east,
    north,
    centerEast: (west + east) / 2,
    centerNorth: (south + north) / 2,
  };
}

export function terrainLocalToPosition(
  grid: TerrainGrid,
  east: number,
  north: number,
  elevationM: number,
  referenceElevationM: number,
): [number, number, number] {
  const frame = terrainGridFrame(grid);
  return [east - frame.centerEast, elevationM - referenceElevationM, -(north - frame.centerNorth)];
}

export function terrainLocalToUv(grid: TerrainGrid, east: number, north: number): [number, number] {
  const frame = terrainGridFrame(grid);
  const width = frame.east - frame.west;
  const height = frame.north - frame.south;
  if (width <= 0 || height <= 0) return [0.5, 0.5];
  return [(east - frame.west) / width, (north - frame.south) / height];
}

function isElevation(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

export function buildTerrainMesh(grid: TerrainGrid): TerrainMeshData {
  const { columns, rows, values_m: values } = grid;
  const vertexCount = columns * rows;
  let validVertexCount = 0;
  let minimumElevationM: number | null = null;
  let maximumElevationM: number | null = null;
  for (const row of values) {
    for (const value of row) {
      if (!isElevation(value)) continue;
      validVertexCount += 1;
      minimumElevationM = minimumElevationM === null ? value : Math.min(minimumElevationM, value);
      maximumElevationM = maximumElevationM === null ? value : Math.max(maximumElevationM, value);
    }
  }
  const referenceElevationM = minimumElevationM === null || maximumElevationM === null
    ? 0
    : (minimumElevationM + maximumElevationM) / 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const valid = new Uint8Array(vertexCount);
  const frame = terrainGridFrame(grid);

  for (let row = 0; row < rows; row += 1) {
    const north = grid.first_sample_local_m.north - row * grid.sample_spacing_m.north;
    const v = 1 - row / (rows - 1);
    for (let column = 0; column < columns; column += 1) {
      const east = grid.first_sample_local_m.east + column * grid.sample_spacing_m.east;
      const index = row * columns + column;
      const elevation = values[row][column];
      const positionOffset = index * 3;
      positions[positionOffset] = east - frame.centerEast;
      positions[positionOffset + 1] = isElevation(elevation) ? elevation - referenceElevationM : 0;
      positions[positionOffset + 2] = -(north - frame.centerNorth);
      // CanvasTexture's default flipY maps its top row to v=1; row 0 is grid north.
      const uvOffset = index * 2;
      uvs[uvOffset] = column / (columns - 1);
      uvs[uvOffset + 1] = v;
      if (isElevation(elevation)) valid[index] = 1;
    }
  }

  const indices: number[] = [];
  const addTriangle = (a: number, b: number, c: number) => indices.push(a, b, c);
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column; // north-west
      const b = a + 1; // north-east
      const c = a + columns; // south-west
      const d = c + 1; // south-east
      const validCount = valid[a] + valid[b] + valid[c] + valid[d];
      if (validCount === 4) {
        // X points east, Z points south; this winding keeps normals facing +Y.
        addTriangle(a, c, d);
        addTriangle(a, d, b);
      } else if (validCount === 3) {
        if (!valid[a]) addTriangle(b, c, d);
        else if (!valid[b]) addTriangle(a, c, d);
        else if (!valid[c]) addTriangle(a, d, b);
        else addTriangle(a, c, b);
      }
    }
  }
  const IndexArray = vertexCount > 65_536 ? Uint32Array : Uint16Array;
  return {
    positions,
    uvs,
    indices: new IndexArray(indices),
    validVertexCount,
    triangleCount: indices.length / 3,
    referenceElevationM,
    minimumElevationM,
    maximumElevationM,
    sampleCenterBounds: { west: frame.west, south: frame.south, east: frame.east, north: frame.north },
  };
}

function toIndexArray(indices: number[], vertexCount: number): Uint16Array | Uint32Array {
  const IndexArray = vertexCount > 65_536 ? Uint32Array : Uint16Array;
  return new IndexArray(indices);
}

function triangleAreaSquared(positions: Float32Array, a: number, b: number, c: number): number {
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const abx = positions[b * 3] - ax;
  const aby = positions[b * 3 + 1] - ay;
  const abz = positions[b * 3 + 2] - az;
  const acx = positions[c * 3] - ax;
  const acy = positions[c * 3 + 1] - ay;
  const acz = positions[c * 3 + 2] - az;
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  return crossX * crossX + crossY * crossY + crossZ * crossZ;
}

/**
 * Creates a flat underside and vertical boundary walls from the valid surface
 * triangles only. Open edges around NoData become their own boundaries, so
 * disconnected valid regions are never bridged by a rectangular box.
 */
export function buildTerrainVolumeSupports(
  surface: TerrainMeshData,
  thicknessRatio = 0.12,
): TerrainVolumeSupportData {
  const emptySupport = (): TerrainSupportMeshData => ({
    positions: new Float32Array(0),
    indices: new Uint16Array(0),
    triangleCount: 0,
  });
  if (!Number.isFinite(thicknessRatio) || thicknessRatio <= 0 || thicknessRatio >= 1) {
    throw new RangeError("The terrain volume thickness ratio must be between 0 and 1.");
  }
  if (surface.triangleCount === 0 || surface.minimumElevationM === null) {
    return { walls: emptySupport(), base: emptySupport(), boundaryEdgeCount: 0, thicknessM: 0, baseElevationM: null };
  }

  const bounds = surface.sampleCenterBounds;
  const horizontalSpan = Math.min(bounds.east - bounds.west, bounds.north - bounds.south);
  if (!Number.isFinite(horizontalSpan) || horizontalSpan <= 0) {
    return { walls: emptySupport(), base: emptySupport(), boundaryEdgeCount: 0, thicknessM: 0, baseElevationM: null };
  }

  const thicknessM = horizontalSpan * thicknessRatio;
  const baseElevationM = surface.minimumElevationM - thicknessM;
  const baseY = baseElevationM - surface.referenceElevationM;
  const vertexCount = surface.positions.length / 3;
  const basePositions = new Float32Array(surface.positions.length);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    basePositions[offset] = surface.positions[offset];
    basePositions[offset + 1] = baseY;
    basePositions[offset + 2] = surface.positions[offset + 2];
  }

  const baseIndices: number[] = [];
  const edges = new Map<string, { a: number; b: number; count: number }>();
  const addEdge = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const edge = edges.get(key);
    if (edge) edge.count += 1;
    else edges.set(key, { a, b, count: 1 });
  };

  for (let offset = 0; offset + 2 < surface.indices.length; offset += 3) {
    const a = surface.indices[offset];
    const b = surface.indices[offset + 1];
    const c = surface.indices[offset + 2];
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount || a === b || b === c || c === a) continue;
    if (triangleAreaSquared(surface.positions, a, b, c) <= 1e-10) continue;

    baseIndices.push(a, c, b);
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  const wallPositions: number[] = [];
  const wallIndices: number[] = [];
  let boundaryEdgeCount = 0;
  for (const edge of edges.values()) {
    if (edge.count !== 1) continue;
    const topA = edge.a;
    const topB = edge.b;
    const ax = surface.positions[topA * 3];
    const ay = surface.positions[topA * 3 + 1];
    const az = surface.positions[topA * 3 + 2];
    const bx = surface.positions[topB * 3];
    const by = surface.positions[topB * 3 + 1];
    const bz = surface.positions[topB * 3 + 2];
    const horizontalLengthSquared = (bx - ax) ** 2 + (bz - az) ** 2;
    if (!Number.isFinite(horizontalLengthSquared) || horizontalLengthSquared <= 1e-10) continue;

    const firstVertex = wallPositions.length / 3;
    wallPositions.push(ax, ay, az, bx, by, bz, ax, baseY, az, bx, baseY, bz);
    // Reverse the upward-facing triangle boundary so the side normal points out.
    wallIndices.push(firstVertex + 1, firstVertex, firstVertex + 2, firstVertex + 1, firstVertex + 2, firstVertex + 3);
    boundaryEdgeCount += 1;
  }

  return {
    walls: {
      positions: new Float32Array(wallPositions),
      indices: toIndexArray(wallIndices, wallPositions.length / 3),
      triangleCount: wallIndices.length / 3,
    },
    base: {
      positions: basePositions,
      indices: toIndexArray(baseIndices, vertexCount),
      triangleCount: baseIndices.length / 3,
    },
    boundaryEdgeCount,
    thicknessM,
    baseElevationM,
  };
}

export function projectGeometryToTexture(
  geometry: LocalPolygonGeometry,
  grid: TerrainGrid,
  width: number,
  height: number,
): TexturePolygon[] {
  const frame = terrainGridFrame(grid);
  const spanEast = frame.east - frame.west;
  const spanNorth = frame.north - frame.south;
  if (spanEast <= 0 || spanNorth <= 0 || width < 2 || height < 2) return [];
  const projectRing = (ring: Array<[number, number, ...number[]]>) => ring.map(([east, north]) => [
    (east - frame.west) / spanEast * (width - 1),
    (frame.north - north) / spanNorth * (height - 1),
  ] as [number, number]);
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((polygon) => ({ rings: polygon.map(projectRing) }));
}
