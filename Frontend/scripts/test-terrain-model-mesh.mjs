import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/terrain-model-mesh.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const meshModule = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

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

console.log(`terrain mesh checks: ${cases.length} passed`);
for (const name of cases) console.log(`✓ ${name}`);
