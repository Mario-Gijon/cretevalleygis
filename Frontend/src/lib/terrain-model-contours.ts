import type { TerrainGrid, TerrainMeshData } from "@/lib/terrain-model-mesh";

export const TERRAIN_CONTOUR_INTERVALS_M = [5, 10, 20, 50, 100, 200] as const;
export const TERRAIN_CONTOUR_MAX_LEVELS = 256;
export const TERRAIN_CONTOUR_MAX_SEGMENTS = 200_000;
export const TERRAIN_CONTOUR_MAX_TRIANGLE_LEVEL_CHECKS = 2_000_000;

// Elevations within 1e-7 m of a contour are treated as exactly on it.
export const TERRAIN_CONTOUR_ELEVATION_TOLERANCE_M = 1e-7;
// Sub-micrometre horizontal segments are numerical degeneracies, not visible contours.
export const TERRAIN_CONTOUR_MIN_SEGMENT_LENGTH_M = 1e-6;

export type TerrainContourInterval = "auto" | (typeof TERRAIN_CONTOUR_INTERVALS_M)[number];
export type TerrainContourBuildResult = {
  status: "ready" | "no_data" | "no_levels" | "level_limit" | "segment_limit" | "complexity_limit";
  intervalM: number;
  levels: number[];
  minorPositions: Float32Array;
  majorPositions: Float32Array;
  segmentCount: number;
  majorSegmentCount: number;
  majorLevelCount: number;
};

type ContourPoint = {
  key: string;
  east: number;
  north: number;
};

type ContourBucket = { levelIndex: number; triangleOffsets: number[] };

function contourLevelRange(minimumElevationM: number, maximumElevationM: number, intervalM: number) {
  if (!Number.isFinite(minimumElevationM) || !Number.isFinite(maximumElevationM)
    || !Number.isFinite(intervalM) || intervalM <= 0 || maximumElevationM < minimumElevationM) return null;
  const tolerance = elevationTolerance(minimumElevationM, maximumElevationM, intervalM);
  const firstIndex = Math.ceil((minimumElevationM - tolerance) / intervalM);
  const lastIndex = Math.floor((maximumElevationM + tolerance) / intervalM);
  return { firstIndex, lastIndex, count: Math.max(0, lastIndex - firstIndex + 1) };
}

function elevationTolerance(...values: number[]): number {
  return Math.max(TERRAIN_CONTOUR_ELEVATION_TOLERANCE_M,
    Math.max(...values.map((value) => Math.abs(value)), 1) * Number.EPSILON * 8);
}

export function terrainContourLevels(minimumElevationM: number, maximumElevationM: number, intervalM: number): number[] {
  const range = contourLevelRange(minimumElevationM, maximumElevationM, intervalM);
  if (!range || range.count > TERRAIN_CONTOUR_MAX_LEVELS) return [];
  return Array.from({ length: range.count }, (_, offset) => (range.firstIndex + offset) * intervalM);
}

export function selectAutomaticContourInterval(minimumElevationM: number, maximumElevationM: number): number {
  if (!Number.isFinite(minimumElevationM) || !Number.isFinite(maximumElevationM) || maximumElevationM <= minimumElevationM) {
    return 20;
  }
  const targetLevelCount = 12;
  return TERRAIN_CONTOUR_INTERVALS_M.reduce((best, interval) => {
    const count = contourLevelRange(minimumElevationM, maximumElevationM, interval)?.count ?? 0;
    const bestCount = contourLevelRange(minimumElevationM, maximumElevationM, best)?.count ?? 0;
    const countError = count === 0 || count > TERRAIN_CONTOUR_MAX_LEVELS ? Number.POSITIVE_INFINITY : Math.abs(count - targetLevelCount);
    const bestError = bestCount === 0 || bestCount > TERRAIN_CONTOUR_MAX_LEVELS ? Number.POSITIVE_INFINITY : Math.abs(bestCount - targetLevelCount);
    return countError < bestError ? interval : best;
  }, TERRAIN_CONTOUR_INTERVALS_M[0]);
}

function emptyResult(status: TerrainContourBuildResult["status"], intervalM: number, levels: number[] = []): TerrainContourBuildResult {
  return { status, intervalM, levels, minorPositions: new Float32Array(), majorPositions: new Float32Array(), segmentCount: 0, majorSegmentCount: 0, majorLevelCount: 0 };
}

function vertexPoint(grid: TerrainGrid, vertex: number): ContourPoint {
  const row = Math.floor(vertex / grid.columns);
  const column = vertex - row * grid.columns;
  return {
    key: `v${vertex}`,
    east: grid.first_sample_local_m.east + column * grid.sample_spacing_m.east,
    north: grid.first_sample_local_m.north - row * grid.sample_spacing_m.north,
  };
}

function edgePoint(grid: TerrainGrid, a: number, b: number, elevationA: number, elevationB: number, levelM: number, tolerance: number): ContourPoint | null {
  const aOnLevel = Math.abs(elevationA - levelM) <= tolerance;
  const bOnLevel = Math.abs(elevationB - levelM) <= tolerance;
  if (aOnLevel && bOnLevel) return null;
  if (aOnLevel) return vertexPoint(grid, a);
  if (bOnLevel) return vertexPoint(grid, b);
  if ((elevationA < levelM) === (elevationB < levelM)) return null;

  const fraction = Math.max(0, Math.min(1, (levelM - elevationA) / (elevationB - elevationA)));
  const pointA = vertexPoint(grid, a);
  const pointB = vertexPoint(grid, b);
  const first = Math.min(a, b);
  const second = Math.max(a, b);
  return {
    key: `e${first}:${second}`,
    east: pointA.east + (pointB.east - pointA.east) * fraction,
    north: pointA.north + (pointB.north - pointA.north) * fraction,
  };
}

/**
 * Marches each valid triangle in the rendered terrain mesh. Contour elevations
 * are absolute multiples of the selected interval; returned Y values use the
 * same local reference as the surface and are not affected by visual exaggeration.
 */
export function buildTerrainContours(
  grid: TerrainGrid,
  surface: TerrainMeshData,
  intervalM: number,
): TerrainContourBuildResult {
  if (surface.minimumElevationM === null || surface.maximumElevationM === null || surface.triangleCount === 0) {
    return emptyResult("no_data", intervalM);
  }
  const range = contourLevelRange(surface.minimumElevationM, surface.maximumElevationM, intervalM);
  if (!range || range.count === 0) return emptyResult("no_levels", intervalM);
  if (range.count > TERRAIN_CONTOUR_MAX_LEVELS) return emptyResult("level_limit", intervalM);
  const firstLevelIndex = range.firstIndex;
  const levels = Array.from({ length: range.count }, (_, offset) => (firstLevelIndex + offset) * intervalM);
  const buckets: ContourBucket[] = levels.map((_, levelIndex) => ({ levelIndex, triangleOffsets: [] }));
  const samples = grid.values_m;
  const indices = surface.indices;
  const elevationAt = (vertex: number) => samples[Math.floor(vertex / grid.columns)]?.[vertex % grid.columns] ?? null;
  let triangleLevelChecks = 0;

  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const a = indices[offset];
    const b = indices[offset + 1];
    const c = indices[offset + 2];
    const elevations = [elevationAt(a), elevationAt(b), elevationAt(c)];
    if (elevations.some((value) => value === null)) continue;
    const values = elevations as number[];
    const lowIndex = Math.max(firstLevelIndex, Math.ceil((Math.min(...values) - elevationTolerance(...values, intervalM)) / intervalM));
    const highIndex = Math.min(firstLevelIndex + levels.length - 1, Math.floor((Math.max(...values) + elevationTolerance(...values, intervalM)) / intervalM));
    for (let levelIndex = lowIndex; levelIndex <= highIndex; levelIndex += 1) {
      triangleLevelChecks += 1;
      if (triangleLevelChecks > TERRAIN_CONTOUR_MAX_TRIANGLE_LEVEL_CHECKS) {
        return emptyResult("complexity_limit", intervalM, levels);
      }
      buckets[levelIndex - firstLevelIndex].triangleOffsets.push(offset);
    }
  }

  const frameWest = grid.first_sample_local_m.east;
  const frameEast = frameWest + (grid.columns - 1) * grid.sample_spacing_m.east;
  const frameNorth = grid.first_sample_local_m.north;
  const frameSouth = frameNorth - (grid.rows - 1) * grid.sample_spacing_m.north;
  const centerEast = (frameWest + frameEast) / 2;
  const centerNorth = (frameSouth + frameNorth) / 2;
  const minorPositions: number[] = [];
  const majorPositions: number[] = [];
  const emitted = new Set<string>();
  let segmentCount = 0;
  let majorSegmentCount = 0;
  const majorLevels = new Set<number>();

  for (const bucket of buckets) {
    const levelM = levels[bucket.levelIndex];
    const tolerance = elevationTolerance(levelM, intervalM);
    for (const offset of bucket.triangleOffsets) {
      const a = indices[offset];
      const b = indices[offset + 1];
      const c = indices[offset + 2];
      const elevations = [elevationAt(a), elevationAt(b), elevationAt(c)] as number[];
      const onLevel = elevations.map((value) => Math.abs(value - levelM) <= tolerance);
      // A flat triangle is an area at this height, not a contour line.
      if (onLevel.every(Boolean)) continue;

      const vertices = [a, b, c];
      const exactEdges: Array<[ContourPoint, ContourPoint]> = [];
      const intersections = new Map<string, ContourPoint>();
      for (const [first, second] of [[0, 1], [1, 2], [2, 0]] as const) {
        if (onLevel[first] && onLevel[second]) {
          exactEdges.push([vertexPoint(grid, vertices[first]), vertexPoint(grid, vertices[second])]);
          continue;
        }
        const point = edgePoint(grid, vertices[first], vertices[second], elevations[first], elevations[second], levelM, tolerance);
        if (point) intersections.set(point.key, point);
      }
      const segment = exactEdges[0] ?? (intersections.size === 2 ? Array.from(intersections.values()) as [ContourPoint, ContourPoint] : null);
      if (!segment) continue;

      const [start, end] = segment;
      const eastDelta = end.east - start.east;
      const northDelta = end.north - start.north;
      if (eastDelta * eastDelta + northDelta * northDelta <= TERRAIN_CONTOUR_MIN_SEGMENT_LENGTH_M ** 2) continue;
      const pointKey = (point: ContourPoint) => point.key;
      const startKey = pointKey(start);
      const endKey = pointKey(end);
      const key = `${bucket.levelIndex}:${startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      segmentCount += 1;
      if (segmentCount > TERRAIN_CONTOUR_MAX_SEGMENTS) return emptyResult("segment_limit", intervalM, levels);

      const isMajor = Math.round(levelM / intervalM) % 5 === 0;
      const target = isMajor ? majorPositions : minorPositions;
      if (isMajor) {
        majorSegmentCount += 1;
        majorLevels.add(levelM);
      }
      target.push(
        start.east - centerEast, levelM - surface.referenceElevationM, -(start.north - centerNorth),
        end.east - centerEast, levelM - surface.referenceElevationM, -(end.north - centerNorth),
      );
    }
  }

  return {
    status: "ready",
    intervalM,
    levels,
    minorPositions: new Float32Array(minorPositions),
    majorPositions: new Float32Array(majorPositions),
    segmentCount,
    majorSegmentCount,
    majorLevelCount: majorLevels.size,
  };
}
