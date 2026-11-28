import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/terrain-model-mesh.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const meshModule = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const explorationSource = await readFile(new URL("../src/lib/exploration-terrain.ts", import.meta.url), "utf8");
const explorationJavascript = ts.transpileModule(explorationSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const explorationUrl = `data:text/javascript;base64,${Buffer.from(explorationJavascript).toString("base64")}`;
const stylesSource = await readFile(new URL("../src/lib/terrain-model-styles.ts", import.meta.url), "utf8");
const stylesJavascript = ts.transpileModule(stylesSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace('"@/lib/exploration-terrain"', JSON.stringify(explorationUrl));
const stylesModule = await import(`data:text/javascript;base64,${Buffer.from(stylesJavascript).toString("base64")}`);
const terrainModelSource = await readFile(new URL("../src/lib/terrain-model.ts", import.meta.url), "utf8");
const terrainModelJavascript = ts.transpileModule(terrainModelSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const terrainModelModule = await import(`data:text/javascript;base64,${Buffer.from(terrainModelJavascript).toString("base64")}`);
const contoursSource = await readFile(new URL("../src/lib/terrain-model-contours.ts", import.meta.url), "utf8");
const contoursJavascript = ts.transpileModule(contoursSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const contoursModule = await import(`data:text/javascript;base64,${Buffer.from(contoursJavascript).toString("base64")}`);
const isolatedViewSource = await readFile(new URL("../src/components/IsolatedTerrainView.tsx", import.meta.url), "utf8");
const threeTextureSource = await readFile(new URL("../node_modules/three/src/textures/Texture.js", import.meta.url), "utf8");
const threeCanvasTextureSource = await readFile(new URL("../node_modules/three/src/textures/CanvasTexture.js", import.meta.url), "utf8");

function grid(values, east = 10, north = 10) {
  const rows = values.length;
  const columns = values[0].length;
  return {
    columns,
    rows,
    first_sample_local_m: { east: east / 2, north: rows * north - north / 2 },
    sample_spacing_m: { east, north },
    values_m: values,
  };
}

function vertex(mesh, index) {
  const offset = index * 3;
  return [mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]];
}

function triangleNormalY(mesh, offset = 0) {
  const [a, b, c] = [0, 1, 2].map((part) => vertex(mesh, mesh.indices[offset + part]));
  const ab = b.map((value, index) => value - a[index]);
  const ac = c.map((value, index) => value - a[index]);
  return ab[2] * ac[0] - ab[0] * ac[2];
}

function triangleNormal(mesh, offset = 0) {
  const [a, b, c] = [0, 1, 2].map((part) => vertex(mesh, mesh.indices[offset + part]));
  const ab = b.map((value, index) => value - a[index]);
  const ac = c.map((value, index) => value - a[index]);
  return [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
}

function assertValidTriangles(mesh) {
  assert.ok(Array.from(mesh.indices).every((index) => index >= 0 && index < mesh.positions.length / 3));
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const normal = triangleNormal(mesh, offset);
    assert.ok(normal.every(Number.isFinite));
    assert.ok(Math.hypot(...normal) > 1e-5, `degenerate triangle at index ${offset / 3}`);
  }
}

function geometricEdgeUseCounts(meshes) {
  const key = (mesh, index) => vertex(mesh, index).map((value) => value.toFixed(4)).join(",");
  const counts = new Map();
  for (const mesh of meshes) {
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = [0, 1, 2].map((part) => key(mesh, mesh.indices[offset + part]));
      for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
        const edgeKey = a < b ? `${a}|${b}` : `${b}|${a}`;
        counts.set(edgeKey, (counts.get(edgeKey) ?? 0) + 1);
      }
    }
  }
  return counts;
}

const cases = [];
function test(name, action) {
  action();
  cases.push(name);
}

test("flat grid creates a connected surface at its real elevations", () => {
  const data = meshModule.buildTerrainMesh(grid([[120, 120], [120, 120]]));
  assert.equal(data.triangleCount, 2);
  assert.deepEqual(Array.from(data.positions).filter((_, index) => index % 3 === 1), [0, 0, 0, 0]);
  assert.equal(data.referenceElevationM, 120);
});

test("eastward slope increases elevation on the positive X axis", () => {
  const input = grid([[0, 10], [0, 10]]);
  const data = meshModule.buildTerrainMesh(input);
  assert.equal(vertex(data, 0)[0], -5);
  assert.equal(vertex(data, 1)[0], 5);
  assert.equal(vertex(data, 1)[1] - vertex(data, 0)[1], 10);
});

test("northward slope follows negative Z and north-to-south row order", () => {
  const input = grid([[30, 30], [10, 10]]);
  const data = meshModule.buildTerrainMesh(input);
  assert.ok(vertex(data, 0)[2] < vertex(data, 2)[2]);
  assert.ok(vertex(data, 0)[1] > vertex(data, 2)[1]);
});

test("negative and zero elevations remain valid values", () => {
  const data = meshModule.buildTerrainMesh(grid([[-12, 0], [-4, 2]]));
  assert.equal(data.validVertexCount, 4);
  assert.equal(data.minimumElevationM, -12);
  assert.equal(data.maximumElevationM, 2);
  assert.equal(data.triangleCount, 2);
});

test("rectangular grids retain their dimensions and anisotropic spacing", () => {
  const input = grid([[0, 1, 2], [3, 4, 5]], 12, 30);
  const data = meshModule.buildTerrainMesh(input);
  assert.equal(data.positions.length / 3, 6);
  assert.equal(data.triangleCount, 4);
  assert.equal(Math.abs(vertex(data, 1)[0] - vertex(data, 0)[0]), 12);
  assert.equal(Math.abs(vertex(data, 3)[2] - vertex(data, 0)[2]), 30);
});

test("all four single-NoData corner arrangements keep their remaining triangle", () => {
  const arrangements = [
    [[null, 2], [3, 4]],
    [[1, null], [3, 4]],
    [[1, 2], [null, 4]],
    [[1, 2], [3, null]],
  ];
  for (const values of arrangements) {
    const data = meshModule.buildTerrainMesh(grid(values));
    assert.equal(data.triangleCount, 1);
    assert.ok(triangleNormalY(data) > 0);
  }
});

test("complete NoData coverage creates no triangles or non-finite vertex coordinates", () => {
  const data = meshModule.buildTerrainMesh(grid([[null, null], [null, null]]));
  assert.equal(data.triangleCount, 0);
  assert.ok(Array.from(data.positions).every(Number.isFinite));
  assert.equal(data.minimumElevationM, null);
  assert.equal(data.maximumElevationM, null);
});

test("scattered valid samples without a triangle remain an empty surface", () => {
  const data = meshModule.buildTerrainMesh(grid([[8, null], [null, 11]]));
  assert.equal(data.validVertexCount, 2);
  assert.equal(data.triangleCount, 0);
});

test("all complete-cell faces point upward for Three.js Y-up coordinates", () => {
  const data = meshModule.buildTerrainMesh(grid([[2, 3], [4, 5]]));
  assert.ok(triangleNormalY(data, 0) > 0);
  assert.ok(triangleNormalY(data, 3) > 0);
});

test("one metre east and one metre elevation retain equal geometry scale at 1x", () => {
  const data = meshModule.buildTerrainMesh(grid([[0, 10], [0, 10]], 10, 10));
  const eastSpan = vertex(data, 1)[0] - vertex(data, 0)[0];
  const verticalSpan = vertex(data, 1)[1] - vertex(data, 0)[1];
  assert.equal(eastSpan, 10);
  assert.equal(verticalSpan, eastSpan);
});

test("sample positions and local-to-texture alignment use pixel centres", () => {
  const input = grid([[1, 2, 3], [4, 5, 6], [7, 8, 9]], 10, 20);
  const data = meshModule.buildTerrainMesh(input);
  assert.deepEqual(data.sampleCenterBounds, { west: 5, south: 10, east: 25, north: 50 });
  assert.deepEqual(meshModule.terrainLocalToUv(input, 5, 50), [0, 1]);
  assert.deepEqual(meshModule.terrainLocalToUv(input, 25, 10), [1, 0]);
  assert.deepEqual(meshModule.terrainLocalToPosition(input, 5, 50, 1, 5), [-10, -4, -20]);
});

test("Polygon holes and separated MultiPolygon components stay separate texture paths", () => {
  const input = grid([[1, 1, 1], [1, 1, 1], [1, 1, 1]], 10, 10);
  const ring = [[5, 25], [25, 25], [25, 5], [5, 5], [5, 25]];
  const hole = [[10, 20], [20, 20], [20, 10], [10, 10], [10, 20]];
  const polygon = meshModule.projectGeometryToTexture({ type: "Polygon", coordinates: [ring, hole] }, input, 101, 101);
  assert.equal(polygon.length, 1);
  assert.equal(polygon[0].rings.length, 2);
  const multi = meshModule.projectGeometryToTexture({ type: "MultiPolygon", coordinates: [[ring], [[ [40, 40], [45, 40], [45, 35], [40, 35], [40, 40] ]]] }, input, 101, 101);
  assert.equal(multi.length, 2);
  assert.equal(multi[0].rings.length, 1);
  assert.equal(multi[1].rings.length, 1);
});

test("position and index buffers contain finite coordinates and in-range indices", () => {
  const data = meshModule.buildTerrainMesh(grid([[1, null, 3], [4, 5, 6]], 14, 23));
  assert.ok(Array.from(data.positions).every(Number.isFinite));
  assert.ok(Array.from(data.uvs).every(Number.isFinite));
  assert.ok(Array.from(data.indices).every((index) => index >= 0 && index < data.positions.length / 3));
});

test("flat rectangular terrain receives a proportional closed volume without changing its surface", () => {
  const data = meshModule.buildTerrainMesh(grid([[120, 120, 120], [120, 120, 120], [120, 120, 120]], 12, 30));
  const originalPositions = Array.from(data.positions);
  const originalIndices = Array.from(data.indices);
  const volume = meshModule.buildTerrainVolumeSupports(data);
  assert.equal(data.triangleCount, 8);
  assert.equal(volume.boundaryEdgeCount, 8);
  assert.equal(volume.base.triangleCount, data.triangleCount);
  assert.equal(volume.walls.triangleCount, 16);
  assert.equal(volume.thicknessM, 2.88);
  assert.ok(volume.baseElevationM < data.minimumElevationM);
  assert.ok(Array.from(volume.base.positions).filter((_, index) => index % 3 === 1).every((height) => Math.abs(height + 2.88) < 1e-5));
  assert.deepEqual(Array.from(data.positions), originalPositions);
  assert.deepEqual(Array.from(data.indices), originalIndices);

  const allEdges = geometricEdgeUseCounts([data, volume.walls, volume.base]);
  assert.ok(Array.from(allEdges.values()).every((uses) => uses === 2), "closed shell edges must be shared by exactly two faces");
  assertValidTriangles(data);
  assertValidTriangles(volume.walls);
  assertValidTriangles(volume.base);
});

test("mountain walls start on the real surface and their normals face out from the footprint", () => {
  const data = meshModule.buildTerrainMesh(grid([[0, 40, 0], [20, 120, 30], [0, 35, -10]]));
  const volume = meshModule.buildTerrainVolumeSupports(data);
  assert.ok(data.maximumElevationM - data.minimumElevationM > 100);
  assert.ok(volume.baseElevationM < data.minimumElevationM);
  const surfaceHeights = new Map();
  for (let index = 0; index < data.positions.length; index += 3) {
    surfaceHeights.set(`${data.positions[index].toFixed(4)},${data.positions[index + 2].toFixed(4)}`, data.positions[index + 1]);
  }

  for (let edge = 0; edge < volume.boundaryEdgeCount; edge += 1) {
    const firstVertex = edge * 4;
    const topA = vertex(volume.walls, firstVertex);
    const topB = vertex(volume.walls, firstVertex + 1);
    const normal = triangleNormal(volume.walls, edge * 6);
    const midpoint = [(topA[0] + topB[0]) / 2, (topA[2] + topB[2]) / 2];
    assert.ok(normal[0] * midpoint[0] + normal[2] * midpoint[1] > 0, "boundary wall normal must face outward");
    for (const point of [topA, topB]) {
      assert.equal(point[1], surfaceHeights.get(`${point[0].toFixed(4)},${point[2].toFixed(4)}`));
    }
  }
  assert.ok(triangleNormalY(volume.base) < 0, "underside triangles must face down");
});

test("negative elevations keep the visual base below every valid sample", () => {
  const data = meshModule.buildTerrainMesh(grid([[-120, -40], [-80, -10]], 15, 25));
  const volume = meshModule.buildTerrainVolumeSupports(data);
  assert.equal(data.minimumElevationM, -120);
  assert.ok(volume.baseElevationM < -120);
  assert.ok(volume.baseElevationM < data.minimumElevationM);
});

test("partial NoData creates supports only for the triangles that actually exist", () => {
  const data = meshModule.buildTerrainMesh(grid([[1, 2, 3], [4, null, 6], [7, 8, 9]]));
  const volume = meshModule.buildTerrainVolumeSupports(data);
  assert.equal(data.triangleCount, 4);
  assert.equal(volume.base.triangleCount, data.triangleCount);
  assert.equal(volume.boundaryEdgeCount, 12);
  assert.equal(volume.walls.triangleCount, 24);
  assertValidTriangles(volume.walls);
  assertValidTriangles(volume.base);
});

test("separated valid regions receive separate projected bases without bridging NoData", () => {
  const data = meshModule.buildTerrainMesh(grid([
    [1, 1, null, null],
    [1, 1, null, null],
    [null, null, 8, 8],
    [null, null, 8, 8],
  ]));
  const volume = meshModule.buildTerrainVolumeSupports(data);
  assert.equal(data.triangleCount, 4);
  assert.equal(volume.base.triangleCount, 4);
  assert.equal(volume.boundaryEdgeCount, 8);
  const baseXY = new Set(Array.from(volume.base.indices, (index) => (
    `${volume.base.positions[index * 3].toFixed(1)},${volume.base.positions[index * 3 + 2].toFixed(1)}`
  )));
  assert.equal(baseXY.size, 8);
});

test("large volume bases use 32-bit indices while compact walls keep 16-bit indices", () => {
  const values = Array.from({ length: 257 }, () => Array(257).fill(15));
  const data = meshModule.buildTerrainMesh(grid(values, 30, 30));
  const volume = meshModule.buildTerrainVolumeSupports(data);
  assert.ok(data.indices instanceof Uint32Array);
  assert.ok(volume.base.indices instanceof Uint32Array);
  assert.ok(volume.walls.indices instanceof Uint16Array);
  assertValidTriangles(volume.walls);
  assertValidTriangles(volume.base);
});

test("synthetic north-south and west-east elevation colors align with grid vertices and UVs", () => {
  const northSouth = grid([[1_000, 1_000], [0, 0]], 10, 20);
  const northSouthMesh = meshModule.buildTerrainMesh(northSouth);
  const northSouthColors = stylesModule.buildTerrainVertexColors(northSouth, "elevation", 0, 1_000);
  assert.ok(vertex(northSouthMesh, 0)[2] < 0, "row 0 is the northern row at negative Z");
  assert.ok(vertex(northSouthMesh, 2)[2] > 0, "the last row is the southern row at positive Z");
  assert.deepEqual(Array.from(northSouthColors.slice(0, 3)), Array.from(northSouthColors.slice(3, 6)));
  assert.deepEqual(Array.from(northSouthColors.slice(6, 9)), Array.from(northSouthColors.slice(9, 12)));
  assert.notDeepEqual(Array.from(northSouthColors.slice(0, 3)), Array.from(northSouthColors.slice(6, 9)));
  assert.deepEqual(meshModule.terrainLocalToUv(northSouth, 5, 30), [0, 1]);
  assert.deepEqual(meshModule.projectGeometryToTexture({
    type: "Polygon",
    coordinates: [[[5, 30], [15, 30], [15, 10], [5, 10], [5, 30]]],
  }, northSouth, 101, 101)[0].rings[0][0], [0, 0]);

  const westEast = grid([[0, 1_000], [0, 1_000]], 10, 20);
  const westEastMesh = meshModule.buildTerrainMesh(westEast);
  const westEastColors = stylesModule.buildTerrainVertexColors(westEast, "elevation", 0, 1_000);
  assert.ok(vertex(westEastMesh, 0)[0] < 0 && vertex(westEastMesh, 1)[0] > 0);
  assert.notDeepEqual(Array.from(westEastColors.slice(0, 3)), Array.from(westEastColors.slice(3, 6)));
  assert.deepEqual(meshModule.terrainLocalToUv(westEast, 5, 30), [0, 1]);
  assert.deepEqual(meshModule.terrainLocalToUv(westEast, 15, 30), [1, 1]);
});

test("Three.js CanvasTexture inherits the default vertical flip used by north-up UVs", () => {
  assert.match(threeCanvasTextureSource, /class CanvasTexture extends Texture/);
  assert.match(threeTextureSource, /this\.flipY\s*=\s*true/);
  const northUp = grid([[900, 900], [100, 100]]);
  const mesh = meshModule.buildTerrainMesh(northUp);
  assert.equal(mesh.uvs[1], 1, "northern row maps to v=1");
  assert.equal(mesh.uvs[3], 1, "the other northern sample also maps to v=1");
  assert.ok(vertex(mesh, 0)[2] < vertex(mesh, 2)[2], "the northern row remains physically north");
});

test("natural adaptive palette handles flat, negative, and zero elevations without NaN", () => {
  const flat = grid([[-18, -18], [-18, -18]]);
  const colors = stylesModule.buildTerrainVertexColors(flat, "natural", -18, -18);
  assert.ok(Array.from(colors).every(Number.isFinite));
  assert.deepEqual(Array.from(colors.slice(0, 3)), Array.from(colors.slice(3, 6)));
  assert.equal(stylesModule.terrainModelColorForElevation(0, "natural", 0, 0), stylesModule.terrainModelColorForElevation(0, "natural", 0, 0));
  assert.equal(stylesModule.terrainModelColorForElevation(-18, "natural", -18, -18), "#ccad75");
});

test("absolute elevation colors are stable across models and interpolate the fixed land palette", () => {
  const firstModelColor = stylesModule.terrainModelColorForElevation(375, "elevation", 0, 1_000);
  const secondModelColor = stylesModule.terrainModelColorForElevation(375, "elevation", 1_200, 2_800);
  assert.equal(firstModelColor, secondModelColor);
  assert.equal(firstModelColor, "#9bb16a");
  assert.equal(stylesModule.terrainModelColorForElevation(0, "elevation", -10, 10), "#367d53");
  assert.equal(stylesModule.terrainModelColorForElevation(-20_000, "elevation", -20_000, -10_000), "#285b50");
  assert.equal(stylesModule.terrainModelColorForElevation(20_000, "elevation", 10_000, 20_000), "#523a69");
  assert.equal(stylesModule.terrainModelLegendStops("elevation")[0].position, 0);
  assert.equal(stylesModule.terrainModelLegendStops("elevation").at(-1).position, 100);
});

test("NoData vertices have no thematic color and remain excluded from valid triangles", () => {
  const input = grid([[0, null], [1_000, 500]]);
  const data = meshModule.buildTerrainMesh(input);
  const colors = stylesModule.buildTerrainVertexColors(input, "elevation", 0, 1_000);
  assert.deepEqual(Array.from(colors.slice(3, 6)), [0, 0, 0]);
  assert.ok(!Array.from(data.indices).includes(1));
  assert.equal(data.triangleCount, 1);
});

function terrainModelFixture(schemaVersion = "1.0") {
  const model = {
    schema_version: schemaVersion,
    analysis_id: "a1b2c3d4e5f60708",
    source: "Copernicus DEM GLO-30 Public",
    model_type: "DSM",
    horizontal_crs: "EPSG:32635",
    vertical_reference: "EGM2008",
    units: { horizontal: "m", vertical: "m" },
    source_resolution_m: { east: 10, north: 10 },
    source_nodata: -9999,
    extent_projected_m: { west: 0, south: 0, east: 20, north: 20 },
    local_origin: { projected_m: { east: 0, north: 0 }, local_m: { east: 0, north: 0 }, definition: "fixture" },
    geometry_local_m: { type: "Polygon", coordinates: [[[2, 2], [18, 2], [18, 18], [2, 18], [2, 2]]] },
    grid: {
      columns: 2, rows: 2,
      first_sample_local_m: { east: 5, north: 15 },
      sample_spacing_m: { east: 10, north: 10 },
      column_order: "west_to_east", row_order: "north_to_south",
      position_convention: "Values are located at output-cell centres.",
      sampling_method: "native_pixel_centres",
      values_m: [[100, 110], [120, 130]],
    },
    coverage: { availability: "available", valid_samples: 4, missing_samples: 0, valid_sample_fraction: 1 },
    sampled_elevation_range_m: { minimum: 100, maximum: 130 },
    context: { requested_margin_m: 0, was_clipped_to_coverage: false },
    warnings: [],
  };
  if (schemaVersion === "1.0") return model;
  return {
    ...model,
    derivatives: {
      source: "Copernicus DEM GLO-30 Public",
      algorithm: "Horn",
      derivative_version: "horn-terrain-derivatives-1",
      analysis_manifest_version: "2",
      source_elevation_sha256: "a".repeat(64),
      source_resolution_m: { east: 10, north: 10 },
      source_horizontal_crs: "EPSG:32635",
      source_horizontal_units: "m",
      target_grid: "grid",
      sampling_method: "native_pixel_centres",
      resampling_policy: "nearest-neighbour samples at common cell centres",
      slope: {
        unit: "percent",
        values_percent: [[0, 5], [15, null]],
        coverage: {
          availability: "partial", total_samples: 4, valid_samples: 3, missing_samples: 1,
          valid_sample_fraction: 0.75, invalid_domain_samples: 0,
          valid_with_elevation_samples: 3, valid_with_elevation_fraction: 0.75,
          elevation_valid_samples: 4, fraction_of_elevation_samples_covered: 0.75,
        },
      },
      aspect: {
        unit: "degrees", reference: "grid_north",
        values_degrees: [[359, 0], [1, null]], flat_mask: [[false, false], [false, true]],
        coverage: {
          availability: "available", total_samples: 4, valid_samples: 4, missing_samples: 0,
          valid_sample_fraction: 1, invalid_domain_samples: 0,
          valid_with_elevation_samples: 4, valid_with_elevation_fraction: 1,
          elevation_valid_samples: 4, fraction_of_elevation_samples_covered: 1,
          directional_samples: 3, flat_samples: 1,
        },
      },
      flat_slope_threshold_percent: 0.1,
      warnings: ["The numeric rasters retain an older style-revision tag than the analysis manifest; their Horn algorithm, source checksum, units and grid were validated and no raster was regenerated."],
    },
  };
}

function throwsInvalidResponse(action) {
  assert.throws(action, (error) => error instanceof terrainModelModule.TerrainModelRequestError && error.code === "invalid_response");
}

test("terrain model validator accepts shared 1.0 elevation and aligned 1.1 derivatives", () => {
  assert.equal(terrainModelModule.validateTerrainModel(terrainModelFixture("1.0"), "a1b2c3d4e5f60708").schema_version, "1.0");
  const extended = terrainModelModule.validateTerrainModel(terrainModelFixture("1.1"), "a1b2c3d4e5f60708");
  assert.equal(extended.schema_version, "1.1");
  assert.equal(extended.derivatives.sampling_method, "native_pixel_centres");
  assert.equal(extended.derivatives.warnings.length, 1, "style revision difference is preserved as a warning");
  assert.equal(extended.derivatives.slope.values_percent[1][1], null, "null stays NoData, not zero");
});

test("terrain model validation rejects derivative dimensions and inconsistent coverage", () => {
  const wrongDimensions = terrainModelFixture("1.1");
  wrongDimensions.derivatives.slope.values_percent.pop();
  throwsInvalidResponse(() => terrainModelModule.validateTerrainModel(wrongDimensions, "a1b2c3d4e5f60708"));
  const wrongCoverage = terrainModelFixture("1.1");
  wrongCoverage.derivatives.slope.coverage.valid_samples = 4;
  wrongCoverage.derivatives.slope.coverage.missing_samples = 0;
  wrongCoverage.derivatives.slope.coverage.valid_sample_fraction = 1;
  throwsInvalidResponse(() => terrainModelModule.validateTerrainModel(wrongCoverage, "a1b2c3d4e5f60708"));
});

test("a valid direction and a flat-mask sample are mutually exclusive", () => {
  const fixture = terrainModelFixture("1.1");
  fixture.derivatives.aspect.flat_mask[0][0] = true;
  fixture.derivatives.aspect.coverage.flat_samples = 2;
  fixture.derivatives.aspect.coverage.directional_samples = 3;
  throwsInvalidResponse(() => terrainModelModule.validateTerrainModel(fixture, "a1b2c3d4e5f60708"));
});

test("derivative validator rejects negative slopes, out-of-range directions, and non-boolean flat masks", () => {
  const negativeSlope = terrainModelFixture("1.1");
  negativeSlope.derivatives.slope.values_percent[0][0] = -0.01;
  throwsInvalidResponse(() => terrainModelModule.validateTerrainModel(negativeSlope, "a1b2c3d4e5f60708"));
  const invalidAspect = terrainModelFixture("1.1");
  invalidAspect.derivatives.aspect.values_degrees[0][0] = 360.01;
  throwsInvalidResponse(() => terrainModelModule.validateTerrainModel(invalidAspect, "a1b2c3d4e5f60708"));
  const invalidMask = terrainModelFixture("1.1");
  invalidMask.derivatives.aspect.flat_mask[0][0] = 0;
  throwsInvalidResponse(() => terrainModelModule.validateTerrainModel(invalidMask, "a1b2c3d4e5f60708"));
});

test("slope classification includes exact upper boundaries and preserves values above 100 percent", () => {
  const expected = [
    [0, "#4f9f83"], [5, "#4f9f83"], [5.0001, "#a8c96f"], [15, "#a8c96f"],
    [15.001, "#f0df73"], [30, "#f0df73"], [30.001, "#ed9c58"], [60, "#ed9c58"],
    [60.001, "#c84a43"], [100, "#c84a43"], [150, "#c84a43"],
  ];
  for (const [value, color] of expected) assert.equal(stylesModule.classifySlope(value).color, color);
  assert.equal(stylesModule.classifySlope(null), null);
});

test("aspect classification matches zonal north-wrap and inclusive sector boundaries", () => {
  const samples = [
    [359, 0], [0, 0], [1, 0], [360, 0], [22.5, 0], [22.5001, 1],
    [67.5, 1], [67.5001, 2], [112.5, 2], [112.5001, 3], [157.5, 3], [157.5001, 4],
    [202.5, 4], [202.5001, 5], [247.5, 5], [247.5001, 6], [292.5, 6], [292.5001, 7],
    [337.5, 7], [337.5001, 0],
  ];
  for (const [value, category] of samples) {
    assert.equal(stylesModule.classifyAspect(value, false).color, stylesModule.ASPECT_THEME_LEGEND[category].color, `aspect ${value}°`);
  }
  assert.deepEqual(stylesModule.classifyAspect(null, true), { color: "#c9c9c4", label: "Plano" });
  assert.equal(stylesModule.classifyAspect(null, false), null, "directional NoData stays distinct from flat and north");
  assert.equal(stylesModule.classifyAspect(0, true), null, "flat cells cannot carry a valid direction");
});

test("categorical sample UVs address pixel centers with north-up rows and west-east columns", () => {
  const uvs = stylesModule.buildCategoricalSampleUvs(3, 2);
  const expected = [1 / 6, 0.75, 0.5, 0.75, 5 / 6, 0.75, 1 / 6, 0.25, 0.5, 0.25, 5 / 6, 0.25];
  assert.ok(Array.from(uvs).every((value, index) => Math.abs(value - expected[index]) < 1e-7));
  assert.match(isolatedViewSource, /texture\.channel\s*=\s*1/);
  assert.match(isolatedViewSource, /texture\.minFilter\s*=\s*THREE\.NearestFilter/);
  assert.match(isolatedViewSource, /texture\.magFilter\s*=\s*THREE\.NearestFilter/);
  assert.match(isolatedViewSource, /texture\.generateMipmaps\s*=\s*false/);
});

test("categorical colors remain exact palette colors and give thematic NoData a neutral swatch", () => {
  const fixture = terrainModelFixture("1.1");
  const validated = terrainModelModule.validateTerrainModel(fixture, "a1b2c3d4e5f60708");
  const slopeColors = stylesModule.buildCategoricalColors("slope", validated.derivatives);
  assert.deepEqual(slopeColors, ["#4f9f83", "#4f9f83", "#a8c96f", stylesModule.TERRAIN_THEME_NODATA_COLOR]);
  const aspectColors = stylesModule.buildCategoricalColors("aspect", validated.derivatives);
  assert.deepEqual(aspectColors, ["#f2d34f", "#f2d34f", "#f2d34f", "#c9c9c4"]);
  const rgba = stylesModule.categoricalColorsToRgba(slopeColors);
  assert.equal(rgba.length, slopeColors.length * 4);
  assert.equal(rgba[3], 255);
  assert.equal(stylesModule.TERRAIN_THEME_NODATA_COLOR, "#687783");
});

test("a fully absent thematic grid validates as NoData without hiding the elevation surface", () => {
  const fixture = terrainModelFixture("1.1");
  fixture.derivatives.slope.values_percent = [[null, null], [null, null]];
  fixture.derivatives.slope.coverage = {
    availability: "no_data", total_samples: 4, valid_samples: 0, missing_samples: 4,
    valid_sample_fraction: 0, invalid_domain_samples: 0, valid_with_elevation_samples: 0,
    valid_with_elevation_fraction: 0, elevation_valid_samples: 4, fraction_of_elevation_samples_covered: 0,
  };
  const validated = terrainModelModule.validateTerrainModel(fixture, "a1b2c3d4e5f60708");
  assert.equal(validated.grid.values_m[0][0], 100);
  assert.equal(validated.derivatives.slope.coverage.availability, "no_data");
  assert.equal(validated.derivatives.aspect.coverage.availability, "available", "an available aspect variable is retained independently");
  assert.ok(stylesModule.buildCategoricalColors("slope", validated.derivatives).every((color) => color === stylesModule.TERRAIN_THEME_NODATA_COLOR));
});

test("categorical styling does not mutate mesh positions, triangulation, or derivative samples", () => {
  const fixture = terrainModelModule.validateTerrainModel(terrainModelFixture("1.1"), "a1b2c3d4e5f60708");
  const surface = meshModule.buildTerrainMesh(fixture.grid);
  const positions = Array.from(surface.positions);
  const indices = Array.from(surface.indices);
  const slopeAtAllExaggerations = [0.5, 1, 3].map(() => stylesModule.buildCategoricalColors("slope", fixture.derivatives));
  assert.deepEqual(slopeAtAllExaggerations[0], slopeAtAllExaggerations[1]);
  assert.deepEqual(slopeAtAllExaggerations[1], slopeAtAllExaggerations[2]);
  assert.deepEqual(Array.from(surface.positions), positions);
  assert.deepEqual(Array.from(surface.indices), indices);
  assert.deepEqual(fixture.derivatives.slope.values_percent, [[0, 5], [15, null]]);
});

test("derivative fallback is restricted to explicit derivative incompatibility or absence", () => {
  assert.equal(terrainModelModule.canFallbackToElevationOnly(new terrainModelModule.TerrainModelRequestError("missing", "slope_raster_unavailable", 404)), true);
  assert.equal(terrainModelModule.canFallbackToElevationOnly(new terrainModelModule.TerrainModelRequestError("missing", "analysis_in_progress", 409)), false);
  assert.equal(terrainModelModule.canFallbackToElevationOnly(new terrainModelModule.TerrainModelRequestError("bad", "invalid_response", 502)), false);
});

test("triangular overlay contains each actual valid triangle edge once and does not mutate the mesh", () => {
  const data = meshModule.buildTerrainMesh(grid([[1, 2, 3], [4, null, 6], [7, 8, 9]]));
  const originalPositions = Array.from(data.positions);
  const originalIndices = Array.from(data.indices);
  const wireframe = meshModule.buildTerrainWireframeIndices(data);
  const expectedEdges = new Set();
  for (let offset = 0; offset < data.indices.length; offset += 3) {
    for (const [a, b] of [[data.indices[offset], data.indices[offset + 1]], [data.indices[offset + 1], data.indices[offset + 2]], [data.indices[offset + 2], data.indices[offset]]]) {
      expectedEdges.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
  }
  const actualEdges = new Set();
  for (let offset = 0; offset < wireframe.indices.length; offset += 2) {
    const a = wireframe.indices[offset];
    const b = wireframe.indices[offset + 1];
    assert.ok(a >= 0 && a < data.positions.length / 3 && b >= 0 && b < data.positions.length / 3);
    actualEdges.add(a < b ? `${a}:${b}` : `${b}:${a}`);
  }
  assert.equal(wireframe.segmentCount, expectedEdges.size);
  assert.deepEqual(actualEdges, expectedEdges);
  assert.deepEqual(Array.from(data.positions), originalPositions);
  assert.deepEqual(Array.from(data.indices), originalIndices);
});

function contourFixture(values, intervalM, east = 10, north = 10) {
  const input = grid(values, east, north);
  const surface = meshModule.buildTerrainMesh(input);
  return { input, surface, contours: contoursModule.buildTerrainContours(input, surface, intervalM) };
}

function contourSegments(positions) {
  const segments = [];
  for (let offset = 0; offset + 5 < positions.length; offset += 6) {
    segments.push(Array.from(positions.slice(offset, offset + 6)));
  }
  return segments;
}

test("marching triangles place an east-west gradient contour at its known absolute elevation", () => {
  const { contours, surface } = contourFixture([[0, 20], [0, 20]], 10);
  assert.equal(contours.status, "ready");
  assert.deepEqual(contours.levels, [0, 10, 20]);
  const levelTen = contourSegments(contours.minorPositions)
    .filter((segment) => Math.abs(segment[1] - (10 - surface.referenceElevationM)) < 1e-6);
  assert.equal(levelTen.length, 2, "the isoline is split only at the actual mesh diagonal");
  for (const segment of levelTen) {
    for (const point of [[segment[0], segment[1], segment[2]], [segment[3], segment[4], segment[5]]]) {
      assert.ok(Math.abs(point[0]) < 1e-6, "the known east coordinate is centered");
      assert.ok(Math.abs(point[1] - (10 - surface.referenceElevationM)) < 1e-6);
    }
  }
});

test("north-south gradient contours follow north-up local coordinates", () => {
  const { contours, surface } = contourFixture([[30, 30], [10, 10]], 20);
  const segments = contourSegments(contours.minorPositions)
    .filter((segment) => Math.abs(segment[1] - (20 - surface.referenceElevationM)) < 1e-6);
  assert.equal(segments.length, 2, "the plane contour is split at the triangulation diagonal");
  assert.ok(segments.every((segment) => Math.abs(segment[2]) < 1e-6 && Math.abs(segment[5]) < 1e-6));
});

test("negative elevations, zero, and exact extrema use absolute multiples from zero", () => {
  const { contours } = contourFixture([[-20, 20], [-20, 20]], 20);
  assert.deepEqual(contours.levels, [-20, 0, 20]);
  const zeroSegments = [...contourSegments(contours.minorPositions), ...contourSegments(contours.majorPositions)]
    .filter((segment) => Math.abs(segment[1]) < 1e-6 && Math.abs(segment[4]) < 1e-6);
  assert.ok(zeroSegments.length > 0, "the zero contour crosses the terrain");
});

test("flat triangles at a selected contour elevation produce no decorative lines", () => {
  const { contours } = contourFixture([[100, 100, 100], [100, 100, 100]], 20);
  assert.equal(contours.status, "ready");
  assert.equal(contours.segmentCount, 0);
  assert.equal(contours.majorPositions.length, 0);
});

test("an exact-level vertex connects adjacent triangle segments without zero-length pieces", () => {
  const { contours } = contourFixture([[0, 10, 20], [0, 10, 20]], 10);
  const segments = [...contourSegments(contours.minorPositions), ...contourSegments(contours.majorPositions)];
  assert.ok(segments.length > 0);
  assert.ok(segments.every((segment) => Math.hypot(segment[3] - segment[0], segment[5] - segment[2]) > 1e-6));
  const normalized = segments.map((segment) => segment.map((coordinate) => coordinate.toFixed(5)).join(","));
  assert.equal(new Set(normalized).size, normalized.length, "segments are not emitted twice");
});

test("a grid edge exactly on a contour is emitted once despite its two incident triangles", () => {
  const { contours } = contourFixture([[10, 0], [0, 10]], 10);
  const segments = [...contourSegments(contours.minorPositions), ...contourSegments(contours.majorPositions)];
  const exactTenMetreDiagonal = segments.filter((segment) => Math.abs(segment[1] - 5) < 1e-6 && Math.abs(segment[4] - 5) < 1e-6);
  assert.ok(segments.length > 0);
  assert.equal(new Set(segments.map((segment) => segment.map((coordinate) => coordinate.toFixed(5)).join(","))).size, segments.length);
  assert.equal(exactTenMetreDiagonal.length, 1, "the shared diagonal is deduplicated");
});

test("NoData holes are not bridged by contour segments", () => {
  const { input, surface, contours } = contourFixture([[0, 10, 20], [10, null, 30], [20, 30, 40]], 20);
  assert.ok(surface.triangleCount > 0);
  const centerEast = input.first_sample_local_m.east + input.sample_spacing_m.east;
  const centerNorth = input.first_sample_local_m.north - input.sample_spacing_m.north;
  for (const segment of [...contourSegments(contours.minorPositions), ...contourSegments(contours.majorPositions)]) {
    const midpointEast = (segment[0] + segment[3]) / 2 + centerEast;
    const midpointNorth = -(segment[2] + segment[5]) / 2 + centerNorth;
    assert.ok(!(Math.abs(midpointEast - centerEast) < 1 && Math.abs(midpointNorth - centerNorth) < 1));
  }
});

test("disconnected valid regions keep separate contour pieces", () => {
  const { contours } = contourFixture([
    [0, 10, null, 0, 10],
    [10, 20, null, 10, 20],
    [20, 30, null, 20, 30],
  ], 10);
  const segments = [...contourSegments(contours.minorPositions), ...contourSegments(contours.majorPositions)];
  assert.ok(segments.length > 0);
  assert.ok(segments.every((segment) => Math.abs((segment[0] + segment[3]) / 2) > 5));
});

test("rectangular anisotropic grids interpolate coordinates within the valid sample frame", () => {
  const { input, contours } = contourFixture([[0, 20, 40], [10, 30, 50]], 20, 14, 23);
  assert.ok(contours.segmentCount > 0);
  const eastHalfSpan = input.sample_spacing_m.east;
  const northHalfSpan = input.sample_spacing_m.north / 2;
  for (const segment of [...contourSegments(contours.minorPositions), ...contourSegments(contours.majorPositions)]) {
    assert.ok(segment.every(Number.isFinite));
    assert.ok(Math.abs(segment[0]) <= eastHalfSpan && Math.abs(segment[3]) <= eastHalfSpan);
    assert.ok(Math.abs(segment[2]) <= northHalfSpan && Math.abs(segment[5]) <= northHalfSpan);
  }
});

test("automatic interval chooses a readable listed value and manual levels remain absolute multiples", () => {
  const interval = contoursModule.selectAutomaticContourInterval(1077.1, 1257.6);
  assert.ok([5, 10, 20, 50, 100, 200].includes(interval));
  assert.ok(contoursModule.terrainContourLevels(1077.1, 1257.6, interval).length <= 18);
  assert.deepEqual(contoursModule.terrainContourLevels(-23, 44, 20), [-20, 0, 20, 40]);
});

test("master contours occur on every fifth absolute interval, including negative levels", () => {
  const { contours } = contourFixture([[-120, 120], [-120, 120]], 20);
  assert.deepEqual(contours.levels, [-120, -100, -80, -60, -40, -20, 0, 20, 40, 60, 80, 100, 120]);
  assert.equal(contours.majorLevelCount, 3);
  assert.ok(contours.majorSegmentCount > 0);
});

test("excessive level counts and segment counts are reported without partial geometry", () => {
  const input = grid([[0, 300], [0, 300]]);
  const mesh = meshModule.buildTerrainMesh(input);
  assert.equal(contoursModule.buildTerrainContours(input, mesh, 1).status, "level_limit");
  const size = 46;
  const alternating = grid(Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => (row + column) % 2 ? 100 : 0)));
  const denseMesh = meshModule.buildTerrainMesh(alternating);
  const limited = contoursModule.buildTerrainContours(alternating, denseMesh, 1);
  assert.equal(limited.status, "segment_limit");
  assert.equal(limited.segmentCount, 0);
  assert.equal(limited.minorPositions.length + limited.majorPositions.length, 0);
});

test("a full 256 by 256 synthetic hill stays within contour allocation limits", () => {
  const size = 256;
  const largeGrid = grid(Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => (
    850 + column * 0.28 + row * 0.19 + Math.sin(column / 13) * 9 + Math.cos(row / 17) * 7
  ))));
  const largeMesh = meshModule.buildTerrainMesh(largeGrid);
  const startedAt = performance.now();
  const contours = contoursModule.buildTerrainContours(largeGrid, largeMesh, 20);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(largeMesh.triangleCount, (size - 1) * (size - 1) * 2);
  assert.equal(contours.status, "ready");
  assert.ok(contours.segmentCount <= contoursModule.TERRAIN_CONTOUR_MAX_SEGMENTS);
  console.log(`256×256 contour generation: ${elapsedMs.toFixed(1)} ms, ${contours.segmentCount.toLocaleString("es-ES")} segments`);
});

test("contours are independent of exaggeration and do not mutate the source mesh", () => {
  const input = grid([[-10, 0, 10], [20, 30, 40], [50, 60, 70]], 12, 30);
  const mesh = meshModule.buildTerrainMesh(input);
  const sourcePositions = Array.from(mesh.positions);
  const sourceIndices = Array.from(mesh.indices);
  const results = [0.5, 1, 3].map(() => contoursModule.buildTerrainContours(input, mesh, 10));
  assert.deepEqual(Array.from(results[0].minorPositions), Array.from(results[1].minorPositions));
  assert.deepEqual(Array.from(results[1].majorPositions), Array.from(results[2].majorPositions));
  assert.deepEqual(Array.from(mesh.positions), sourcePositions);
  assert.deepEqual(Array.from(mesh.indices), sourceIndices);
});

console.log(`terrain mesh checks: ${cases.length} passed`);
for (const name of cases) console.log(`✓ ${name}`);
