import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AlertCircle, Compass, LoaderCircle, Mountain, RefreshCw, RotateCcw, X } from "lucide-react";
import { formatArea } from "@/lib/geometry-metrics";
import {
  buildTerrainWireframeIndices,
  buildTerrainMesh,
  buildTerrainVolumeSupports,
  projectGeometryToTexture,
  type TerrainMeshData,
  type TerrainSupportMeshData,
} from "@/lib/terrain-model-mesh";
import {
  ABSOLUTE_MODEL_ELEVATION_MAX_M,
  ABSOLUTE_MODEL_ELEVATION_MIN_M,
  ASPECT_THEME_LEGEND,
  SLOPE_THEME_LEGEND,
  TERRAIN_THEME_NODATA_COLOR,
  buildCategoricalColors,
  buildCategoricalSampleUvs,
  categoricalColorsToRgba,
  buildTerrainVertexColors,
  terrainModelLegendStops,
  type TerrainModelBaseTheme,
  type TerrainModelTheme,
} from "@/lib/terrain-model-styles";
import { observeTerrainModel, TerrainModelRequestError, type TerrainModelResponse } from "@/lib/terrain-model";
import "@/components/IsolatedTerrainView.css";

type IsolatedTerrainViewProps = {
  areaName: string;
  areaAreaM2: number;
  analysisId: string;
  theme: "light" | "dark";
  onClose: () => void;
};

type LoadState = { status: "loading" } | {
  status: "ready";
  model: TerrainModelResponse;
  derivativesUnavailableReason: string | null;
} | { status: "error"; message: string };
type ModelShape = "surface" | "volume";
type BoundaryMode = "fill" | "outline" | "hidden";

const MODEL_SHAPE_STORAGE_KEY = "cv-gis-isolated-terrain-shape";
const MODEL_THEME_STORAGE_KEY = "cv-gis-isolated-terrain-theme";
const MODEL_BOUNDARY_STORAGE_KEY = "cv-gis-isolated-terrain-boundary";
const MODEL_WIREFRAME_STORAGE_KEY = "cv-gis-isolated-terrain-wireframe";
const MODEL_EXAGGERATION_STORAGE_KEY = "cv-gis-isolated-terrain-exaggeration";

function readChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  try {
    const stored = window.sessionStorage.getItem(key);
    return choices.includes(stored as T) ? stored as T : fallback;
  } catch {
    return fallback;
  }
}

function readSessionBoolean(key: string, fallback: boolean): boolean {
  try {
    const stored = window.sessionStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

function readSessionExaggeration(): number {
  try {
    const stored = Number(window.sessionStorage.getItem(MODEL_EXAGGERATION_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 0.5 && stored <= 3 ? stored : 1;
  } catch {
    return 1;
  }
}

function readModelShape(): ModelShape {
  return readChoice(MODEL_SHAPE_STORAGE_KEY, ["surface", "volume"], "volume");
}

function availableThematicThemes(model: TerrainModelResponse | null): { slope: boolean; aspect: boolean } {
  if (model?.schema_version !== "1.1") return { slope: false, aspect: false };
  return {
    slope: model.derivatives.slope.coverage.availability !== "no_data",
    aspect: model.derivatives.aspect.coverage.availability !== "no_data",
  };
}

function effectiveTerrainTheme(theme: TerrainModelTheme, model: TerrainModelResponse | null): TerrainModelTheme {
  const available = availableThematicThemes(model);
  if (theme === "slope" && !available.slope) return "natural";
  if (theme === "aspect" && !available.aspect) return "natural";
  return theme;
}

function isCategoricalTheme(theme: TerrainModelTheme): theme is "slope" | "aspect" {
  return theme === "slope" || theme === "aspect";
}

function createCategoricalTexture(model: TerrainModelResponse, theme: "slope" | "aspect"): THREE.CanvasTexture | null {
  if (model.schema_version !== "1.1") return null;
  const { columns, rows } = model.grid;
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  const pixels = categoricalColorsToRgba(buildCategoricalColors(theme, model.derivatives));
  const image = context.createImageData(columns, rows);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = true;
  texture.channel = 1;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const numberFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const integerFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });

function formatMeters(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "Sin datos" : `${numberFormat.format(value)} m`;
}

function translateWarning(warning: string): string {
  if (/digital surface model/i.test(warning)) return "Es un modelo digital de superficie (DSM); edificios y vegetación pueden influir en las elevaciones.";
  if (/not a replacement for the original zonal analysis/i.test(warning)) return "Esta cuadrícula es solo visual. Las estadísticas zonales originales permanecen en la ficha del área.";
  if (/nominal 30 m cell spacing/i.test(warning)) return "La resolución nominal de 30 m no garantiza la precisión vertical.";
  if (/surrounding context was limited/i.test(warning)) return "El terreno disponible limita el margen de contexto alrededor de la alternativa.";
  if (/reduced with bilinear sampling/i.test(warning)) return "La ventana se redujo con muestreo bilineal; no se ha añadido detalle por debajo de la resolución fuente.";
  if (/remain null/i.test(warning)) return "Las zonas sin elevación válida quedan abiertas y no se rellenan.";
  if (/the thematic grid is sampled/i.test(warning)) return "La cuadrícula temática muestra muestras de la fuente en posiciones comunes; no es una agregación por superficie ni una distribución zonal.";
  if (/nearest-neighbour samples/i.test(warning)) return "Pendiente y orientación usan el vecino más próximo en los centros de la cuadrícula; la elevación mantiene el muestreo bilineal.";
  if (/negative slope samples were excluded/i.test(warning)) return warning.replace(/negative slope samples were excluded as invalid\./i, "muestras de pendiente negativas se excluyeron por ser inválidas.");
  if (/aspect samples outside 0–360 degrees were excluded/i.test(warning)) return warning.replace(/aspect samples outside 0–360 degrees were excluded as invalid\./i, "muestras de orientación fuera de 0–360° se excluyeron por ser inválidas.");
  if (/older style-revision tag/i.test(warning)) return "Los rásteres tienen una revisión de estilo anterior al manifiesto; se han validado algoritmo Horn, checksum, unidades y cuadrícula, sin regenerarlos.";
  if (/flat-slope threshold/i.test(warning)) return "NoData de orientación solo se marca como plano cuando la pendiente coincide con el umbral configurado; el resto permanece sin datos.";
  if (/missing or invalid slope samples/i.test(warning)) return "Las muestras de pendiente ausentes o inválidas permanecen sin datos; no se deducen de la elevación.";
  return warning;
}

function drawAlternativeBoundary(
  canvas: HTMLCanvasElement,
  model: TerrainModelResponse,
  mode: BoundaryMode,
): void {
  const { grid, geometry_local_m: localGeometry } = model;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("No se pudo crear la superposición del límite.");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (mode === "hidden") return;

  const polygons = projectGeometryToTexture(localGeometry, grid, canvas.width, canvas.height);
  context.lineJoin = "round";
  context.lineCap = "round";
  for (const polygon of polygons) {
    context.beginPath();
    for (const ring of polygon.rings) {
      ring.forEach(([x, y], index) => index === 0 ? context.moveTo(x, y) : context.lineTo(x, y));
      context.closePath();
    }
    if (mode === "fill") {
      context.fillStyle = "rgba(69, 197, 197, 0.3)";
      context.fill("evenodd");
    }
    context.strokeStyle = "#134f8a";
    context.lineWidth = 2;
    context.stroke();
  }
}

function makeAlternativeBoundaryTexture(model: TerrainModelResponse, mode: BoundaryMode): THREE.CanvasTexture {
  const { grid } = model;
  const width = Math.max(64, Math.min(512, grid.columns * 2));
  const height = Math.max(64, Math.min(512, grid.rows * 2));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  drawAlternativeBoundary(canvas, model, mode);

  const texture = new THREE.CanvasTexture(canvas);
  // Canvas y=0 is north; default CanvasTexture flipY=true maps it to v=1,
  // matching the existing north-up mesh UVs and projected alternative rings.
  texture.flipY = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function createGeometry(data: TerrainMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createSupportGeometry(data: TerrainSupportMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function supportMaterialColors(modelTheme: TerrainModelTheme): { wall: string; base: string } {
  if (modelTheme === "hillshade") return { wall: "#a1a6a4", base: "#686f70" };
  if (isCategoricalTheme(modelTheme)) return { wall: "#a1a6a4", base: "#686f70" };
  return { wall: "#a28d68", base: "#746448" };
}

function legendGradient(theme: Exclude<TerrainModelBaseTheme, "hillshade">): string {
  const stops = terrainModelLegendStops(theme).map(({ position, color }) => `${color} ${position}%`).join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

function updateTerrainLighting(
  ambient: THREE.HemisphereLight | null,
  directional: THREE.DirectionalLight | null,
  appTheme: "light" | "dark",
  modelTheme: TerrainModelTheme,
): void {
  if (!ambient || !directional) return;
  if (isCategoricalTheme(modelTheme)) {
    ambient.intensity = appTheme === "dark" ? 1.35 : 1.42;
    directional.intensity = 0.7;
    directional.color.set("#ffffff");
  } else if (modelTheme === "hillshade") {
    ambient.intensity = appTheme === "dark" ? 0.82 : 0.72;
    directional.intensity = appTheme === "dark" ? 2.05 : 2.25;
    directional.color.set(appTheme === "dark" ? "#e4e8e7" : "#fff4dc");
  } else {
    ambient.intensity = appTheme === "dark" ? 1.35 : 1.45;
    directional.intensity = 1.85;
    directional.color.set("#fff4dc");
  }
}

function scheduleSceneRender(
  renderer: THREE.WebGLRenderer | null,
  scene: THREE.Scene | null,
  camera: THREE.Camera | null,
  frameRequest: { current: number | null },
): void {
  if (!renderer || !scene || !camera || frameRequest.current !== null) return;
  frameRequest.current = requestAnimationFrame(() => {
    frameRequest.current = null;
    renderer.render(scene, camera);
  });
}

export default function IsolatedTerrainView({ areaName, areaAreaM2, analysisId, theme, onClose }: IsolatedTerrainViewProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [retryVersion, setRetryVersion] = useState(0);
  const [rendererVersion, setRendererVersion] = useState(0);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [exaggeration, setExaggeration] = useState(readSessionExaggeration);
  const [modelShape, setModelShape] = useState<ModelShape>(readModelShape);
  const [terrainTheme, setTerrainTheme] = useState<TerrainModelTheme>(() => readChoice(MODEL_THEME_STORAGE_KEY, ["natural", "elevation", "hillshade", "slope", "aspect"], "natural"));
  const [boundaryMode, setBoundaryMode] = useState<BoundaryMode>(() => readChoice(MODEL_BOUNDARY_STORAGE_KEY, ["fill", "outline", "hidden"], "fill"));
  const [showTriangularMesh, setShowTriangularMesh] = useState(() => readSessionBoolean(MODEL_WIREFRAME_STORAGE_KEY, false));
  const dialogRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const northIndicatorRef = useRef<HTMLSpanElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const supportGroupRef = useRef<THREE.Group | null>(null);
  const surfaceMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const boundaryMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const supportWallMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const supportBaseMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const wireframeMaterialRef = useRef<THREE.LineBasicMaterial | null>(null);
  const boundaryTextureRef = useRef<THREE.CanvasTexture | null>(null);
  const thematicTexturesRef = useRef<Partial<Record<"slope" | "aspect", THREE.CanvasTexture>>>({});
  const boundaryCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const boundaryMeshRef = useRef<THREE.Mesh | null>(null);
  const wireframeRef = useRef<THREE.LineSegments | null>(null);
  const surfaceColorAttributeRef = useRef<THREE.BufferAttribute | null>(null);
  const modelShapeRef = useRef(modelShape);
  const terrainThemeRef = useRef(terrainTheme);
  const boundaryModeRef = useRef(boundaryMode);
  const showTriangularMeshRef = useRef(showTriangularMesh);
  const exaggerationRef = useRef(exaggeration);
  const ambientLightRef = useRef<THREE.HemisphereLight | null>(null);
  const directionalLightRef = useRef<THREE.DirectionalLight | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const themeRef = useRef(theme);
  const frameRequestRef = useRef<number | null>(null);
  const meshData = useMemo(
    () => loadState.status === "ready" ? buildTerrainMesh(loadState.model.grid) : null,
    [loadState],
  );
  const volumeSupportData = useMemo(
    () => meshData ? buildTerrainVolumeSupports(meshData) : null,
    [meshData],
  );

  useEffect(() => {
    const observation = observeTerrainModel(analysisId, 128);
    let active = true;
    setLoadState({ status: "loading" });
    setRendererError(null);
    observation.promise.then(({ model, derivativesUnavailableReason }) => {
      if (active) setLoadState({ status: "ready", model, derivativesUnavailableReason });
    }).catch((error: unknown) => {
      if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
      const message = error instanceof TerrainModelRequestError
        ? error.message
        : "No se pudo cargar el modelo de elevación.";
      setLoadState({ status: "error", message });
    });
    return () => {
      active = false;
      observation.release();
    };
  }, [analysisId, retryVersion]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const closeButton = dialog?.querySelector<HTMLButtonElement>(".isolated-terrain-close");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    themeRef.current = theme;
    const scene = sceneRef.current;
    if (scene) scene.background = new THREE.Color(theme === "dark" ? "#0b1b2a" : "#eef2f3");
    wireframeMaterialRef.current?.color.set(theme === "dark" ? "#d8e0dd" : "#294553");
    updateTerrainLighting(ambientLightRef.current, directionalLightRef.current, theme, terrainThemeRef.current);
    scheduleSceneRender(rendererRef.current, scene, cameraRef.current, frameRequestRef);
  }, [theme, terrainTheme]);

  useEffect(() => {
    if (loadState.status !== "ready" || !meshData || meshData.triangleCount === 0 || !canvasHostRef.current) return;
    setRendererError(null);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "low-power" });
    } catch {
      setRendererError("Este navegador no pudo iniciar WebGL para mostrar el modelo 3D.");
      return;
    }
    rendererRef.current = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "isolated-terrain-canvas";
    canvasHostRef.current.appendChild(renderer.domElement);

    let boundaryTexture: THREE.CanvasTexture;
    try {
      boundaryTexture = makeAlternativeBoundaryTexture(loadState.model, boundaryModeRef.current);
    } catch {
      renderer.domElement.remove();
      renderer.dispose();
      rendererRef.current = null;
      setRendererError("No se pudo preparar la representación cartográfica local del terreno.");
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(themeRef.current === "dark" ? "#0b1b2a" : "#eef2f3");
    const terrainGroup = new THREE.Group();
    terrainGroup.scale.y = exaggeration;
    modelGroupRef.current = terrainGroup;

    const surface = createGeometry(meshData);
    const thematicAvailability = availableThematicThemes(loadState.model);
    if (thematicAvailability.slope || thematicAvailability.aspect) {
      surface.setAttribute("uv1", new THREE.BufferAttribute(
        buildCategoricalSampleUvs(loadState.model.grid.columns, loadState.model.grid.rows),
        2,
      ));
    }
    const slopeTexture = thematicAvailability.slope ? createCategoricalTexture(loadState.model, "slope") : null;
    const aspectTexture = thematicAvailability.aspect ? createCategoricalTexture(loadState.model, "aspect") : null;
    thematicTexturesRef.current = {
      ...(slopeTexture ? { slope: slopeTexture } : {}),
      ...(aspectTexture ? { aspect: aspectTexture } : {}),
    };
    const initialTheme = effectiveTerrainTheme(terrainThemeRef.current, loadState.model);
    const elevationRange = loadState.model.sampled_elevation_range_m;
    const vertexColors = buildTerrainVertexColors(
      loadState.model.grid,
      isCategoricalTheme(initialTheme) ? "natural" : initialTheme,
      elevationRange?.minimum ?? meshData.minimumElevationM ?? 0,
      elevationRange?.maximum ?? meshData.maximumElevationM ?? 0,
    );
    const colorAttribute = new THREE.BufferAttribute(vertexColors, 3);
    surface.setAttribute("color", colorAttribute);
    surfaceColorAttributeRef.current = colorAttribute;
    const material = new THREE.MeshStandardMaterial({
      map: initialTheme === "slope" ? slopeTexture : initialTheme === "aspect" ? aspectTexture : null,
      vertexColors: !isCategoricalTheme(initialTheme),
      roughness: initialTheme === "hillshade" ? 1 : 0.88,
      metalness: 0,
      side: THREE.FrontSide,
    });
    surfaceMaterialRef.current = material;
    const terrainMesh = new THREE.Mesh(surface, material);
    terrainMesh.name = "Copernicus elevation grid with draped alternative";
    terrainGroup.add(terrainMesh);

    boundaryCanvasRef.current = boundaryTexture.image as HTMLCanvasElement;
    boundaryTextureRef.current = boundaryTexture;
    const boundaryMaterial = new THREE.MeshBasicMaterial({
      map: boundaryTexture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    boundaryMaterialRef.current = boundaryMaterial;
    const boundaryMesh = new THREE.Mesh(surface, boundaryMaterial);
    boundaryMesh.name = "Alternative boundary and fill overlay";
    boundaryMesh.visible = boundaryModeRef.current !== "hidden";
    boundaryMesh.renderOrder = 2;
    boundaryMeshRef.current = boundaryMesh;
    terrainGroup.add(boundaryMesh);

    const wireframeData = buildTerrainWireframeIndices(meshData);
    let wireframe: THREE.LineSegments | null = null;
    if (wireframeData.segmentCount > 0) {
      const normals = surface.getAttribute("normal");
      const offsetPositions = new Float32Array(meshData.positions.length);
      const offset = Math.min(loadState.model.grid.sample_spacing_m.east, loadState.model.grid.sample_spacing_m.north) * 0.003;
      for (let vertex = 0; vertex < offsetPositions.length / 3; vertex += 1) {
        const offsetIndex = vertex * 3;
        offsetPositions[offsetIndex] = meshData.positions[offsetIndex] + normals.getX(vertex) * offset;
        offsetPositions[offsetIndex + 1] = meshData.positions[offsetIndex + 1] + normals.getY(vertex) * offset;
        offsetPositions[offsetIndex + 2] = meshData.positions[offsetIndex + 2] + normals.getZ(vertex) * offset;
      }
      const wireframeGeometry = new THREE.BufferGeometry();
      wireframeGeometry.setAttribute("position", new THREE.BufferAttribute(offsetPositions, 3));
      wireframeGeometry.setIndex(new THREE.BufferAttribute(wireframeData.indices, 1));
      const wireframeMaterial = new THREE.LineBasicMaterial({
        color: themeRef.current === "dark" ? "#d8e0dd" : "#294553",
        transparent: true,
        opacity: 0.48,
        depthTest: true,
        depthWrite: false,
      });
      wireframeMaterialRef.current = wireframeMaterial;
      wireframe = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
      wireframe.name = "Valid terrain triangulation edges";
      wireframe.visible = showTriangularMeshRef.current;
      wireframe.renderOrder = 1;
      wireframeRef.current = wireframe;
      terrainGroup.add(wireframe);
    }

    const supportGroup = new THREE.Group();
    supportGroup.name = "Graphic volume supports";
    supportGroup.visible = modelShapeRef.current === "volume";
    const supportColors = supportMaterialColors(initialTheme);
    if (volumeSupportData && volumeSupportData.walls.triangleCount > 0 && volumeSupportData.base.triangleCount > 0) {
      const wallGeometry = createSupportGeometry(volumeSupportData.walls);
      const wallMaterial = new THREE.MeshStandardMaterial({ color: supportColors.wall, roughness: 0.94, metalness: 0 });
      supportWallMaterialRef.current = wallMaterial;
      const walls = new THREE.Mesh(wallGeometry, wallMaterial);
      walls.name = "Vertical walls along valid surface boundaries";
      supportGroup.add(walls);

      const baseGeometry = createSupportGeometry(volumeSupportData.base);
      const baseMaterial = new THREE.MeshStandardMaterial({ color: supportColors.base, roughness: 1, metalness: 0 });
      supportBaseMaterialRef.current = baseMaterial;
      const base = new THREE.Mesh(baseGeometry, baseMaterial);
      base.name = "Projected base under valid terrain triangles";
      supportGroup.add(base);
    }
    terrainGroup.add(supportGroup);
    supportGroupRef.current = supportGroup;
    scene.add(terrainGroup);

    const ambient = new THREE.HemisphereLight(0xf2f7f4, 0x66705d, 1.55);
    ambientLightRef.current = ambient;
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xfff4dc, 2.1);
    directional.position.set(-0.65, 1.5, 0.8).multiplyScalar(1200);
    directionalLightRef.current = directional;
    scene.add(directional);

    const host = canvasHostRef.current;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 250_000);
    const { east: gridEast, north: gridNorth } = loadState.model.grid.sample_spacing_m;
    const spanX = (loadState.model.grid.columns - 1) * gridEast;
    const spanZ = (loadState.model.grid.rows - 1) * gridNorth;
    const baseY = (volumeSupportData?.baseElevationM ?? meshData.minimumElevationM ?? 0) - meshData.referenceElevationM;
    const minimumSurfaceY = (meshData.minimumElevationM ?? 0) - meshData.referenceElevationM;
    const maximumY = (meshData.maximumElevationM ?? 0) - meshData.referenceElevationM;
    const cameraFrame = (shape: ModelShape, verticalExaggeration: number, frameWidth: number, frameHeight: number) => {
      const lowerY = (shape === "volume" ? baseY : minimumSurfaceY) * verticalExaggeration;
      const upperY = maximumY * verticalExaggeration;
      const target = new THREE.Vector3(0, (lowerY + upperY) / 2, 0);
      const radius = Math.max(1, Math.hypot(spanX / 2, spanZ / 2, (upperY - lowerY) / 2));
      const aspect = Math.max(0.1, frameWidth / frameHeight);
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
      const limitingHalfFov = Math.min(verticalFov, horizontalFov) / 2;
      const distance = radius / Math.sin(limitingHalfFov) * 1.12;
      const direction = new THREE.Vector3(0.72, 0.82, 0.92).normalize();
      return { target, position: target.clone().addScaledVector(direction, distance), radius, distance };
    };
    const initialFrame = cameraFrame(modelShapeRef.current, exaggerationRef.current, width, height);
    camera.position.copy(initialFrame.position);
    camera.lookAt(initialFrame.target);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(initialFrame.target);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.minDistance = Math.max(0.5, initialFrame.radius * 0.08);
    controls.maxDistance = initialFrame.distance * 7;
    controls.minPolarAngle = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.update();

    const render = () => {
      if (!rendererRef.current || frameRequestRef.current !== null) return;
      frameRequestRef.current = requestAnimationFrame(() => {
        frameRequestRef.current = null;
        renderer.render(scene, camera);
      });
    };
    const resetView = () => {
      const nextWidth = Math.max(1, host.clientWidth);
      const nextHeight = Math.max(1, host.clientHeight);
      const frame = cameraFrame(modelShapeRef.current, exaggerationRef.current, nextWidth, nextHeight);
      camera.position.copy(frame.position);
      controls.target.copy(frame.target);
      controls.minDistance = Math.max(0.5, frame.radius * 0.08);
      controls.maxDistance = frame.distance * 7;
      controls.update();
      camera.lookAt(frame.target);
      updateNorth();
      render();
    };
    const updateNorth = () => {
      const origin = new THREE.Vector3(0, 0, 0).project(camera);
      const north = new THREE.Vector3(0, 0, -1).project(camera);
      const dx = north.x - origin.x;
      const dy = -(north.y - origin.y);
      const angle = Math.atan2(dx, -dy) * 180 / Math.PI;
      northIndicatorRef.current?.style.setProperty("--north-rotation", `${angle}deg`);
    };
    const handleControlsChange = () => {
      updateNorth();
      render();
    };
    controls.addEventListener("change", handleControlsChange);
    sceneRef.current = scene;
    cameraRef.current = camera;
    resetViewRef.current = resetView;

    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.max(1, host.clientWidth);
      const nextHeight = Math.max(1, host.clientHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight, false);
      render();
    });
    resizeObserver.observe(host);
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      setRendererError("Se perdió el contexto gráfico. Puedes intentar crear de nuevo el visor.");
    };
    const handleContextRestored = () => {
      setRendererError(null);
      render();
    };
    renderer.domElement.addEventListener("webglcontextlost", handleContextLost);
    renderer.domElement.addEventListener("webglcontextrestored", handleContextRestored);
    renderer.setSize(width, height, false);
    updateNorth();
    render();

    return () => {
      resizeObserver.disconnect();
      controls.removeEventListener("change", handleControlsChange);
      controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", handleContextLost);
      renderer.domElement.removeEventListener("webglcontextrestored", handleContextRestored);
      if (frameRequestRef.current !== null) cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
      surface.dispose();
      material.dispose();
      boundaryMaterial.dispose();
      boundaryTexture.dispose();
      Object.values(thematicTexturesRef.current).forEach((texture) => texture?.dispose());
      if (wireframe) {
        wireframe.geometry.dispose();
        const wireMaterials = Array.isArray(wireframe.material) ? wireframe.material : [wireframe.material];
        wireMaterials.forEach((wireMaterial) => wireMaterial.dispose());
      }
      for (const child of supportGroup.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((supportMaterial) => supportMaterial.dispose());
      }
      terrainGroup.clear();
      scene.clear();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      modelGroupRef.current = null;
      supportGroupRef.current = null;
      surfaceMaterialRef.current = null;
      boundaryMaterialRef.current = null;
      supportWallMaterialRef.current = null;
      supportBaseMaterialRef.current = null;
      wireframeMaterialRef.current = null;
      boundaryTextureRef.current = null;
      thematicTexturesRef.current = {};
      boundaryCanvasRef.current = null;
      boundaryMeshRef.current = null;
      wireframeRef.current = null;
      surfaceColorAttributeRef.current = null;
      ambientLightRef.current = null;
      directionalLightRef.current = null;
      resetViewRef.current = null;
    };
  }, [loadState, meshData, rendererVersion, volumeSupportData]);

  useEffect(() => {
    modelShapeRef.current = modelShape;
    const supportGroup = supportGroupRef.current;
    if (supportGroup) supportGroup.visible = modelShape === "volume";
    scheduleSceneRender(rendererRef.current, sceneRef.current, cameraRef.current, frameRequestRef);
  }, [modelShape]);

  useEffect(() => {
    const model = loadState.status === "ready" ? loadState.model : null;
    const activeTheme = effectiveTerrainTheme(terrainTheme, model);
    terrainThemeRef.current = activeTheme;
    const colorAttribute = surfaceColorAttributeRef.current;
    if (model && colorAttribute) {
      const range = model.sampled_elevation_range_m;
      const colors = buildTerrainVertexColors(
        model.grid,
        isCategoricalTheme(activeTheme) ? "natural" : activeTheme,
        range?.minimum ?? 0,
        range?.maximum ?? 0,
      );
      (colorAttribute.array as Float32Array).set(colors);
      colorAttribute.needsUpdate = true;
    }
    const material = surfaceMaterialRef.current;
    if (material) {
      const nextMap = activeTheme === "slope" ? thematicTexturesRef.current.slope
        : activeTheme === "aspect" ? thematicTexturesRef.current.aspect
          : null;
      const nextVertexColors = !isCategoricalTheme(activeTheme);
      const programChanged = material.map !== nextMap || material.vertexColors !== nextVertexColors;
      material.map = nextMap ?? null;
      material.vertexColors = nextVertexColors;
      material.roughness = activeTheme === "hillshade" ? 1 : 0.88;
      if (programChanged) material.needsUpdate = true;
    }
    const supportColors = supportMaterialColors(activeTheme);
    supportWallMaterialRef.current?.color.set(supportColors.wall);
    supportBaseMaterialRef.current?.color.set(supportColors.base);
    updateTerrainLighting(ambientLightRef.current, directionalLightRef.current, themeRef.current, activeTheme);
    scheduleSceneRender(rendererRef.current, sceneRef.current, cameraRef.current, frameRequestRef);
  }, [terrainTheme, loadState]);

  useEffect(() => {
    boundaryModeRef.current = boundaryMode;
    const model = loadState.status === "ready" ? loadState.model : null;
    const canvas = boundaryCanvasRef.current;
    const texture = boundaryTextureRef.current;
    if (model && canvas && texture) {
      drawAlternativeBoundary(canvas, model, boundaryMode);
      texture.needsUpdate = true;
    }
    if (boundaryMeshRef.current) boundaryMeshRef.current.visible = boundaryMode !== "hidden";
    scheduleSceneRender(rendererRef.current, sceneRef.current, cameraRef.current, frameRequestRef);
  }, [boundaryMode, loadState]);

  useEffect(() => {
    showTriangularMeshRef.current = showTriangularMesh;
    if (wireframeRef.current) wireframeRef.current.visible = showTriangularMesh;
    scheduleSceneRender(rendererRef.current, sceneRef.current, cameraRef.current, frameRequestRef);
  }, [showTriangularMesh]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(MODEL_SHAPE_STORAGE_KEY, modelShape);
      window.sessionStorage.setItem(MODEL_THEME_STORAGE_KEY, terrainTheme);
      window.sessionStorage.setItem(MODEL_BOUNDARY_STORAGE_KEY, boundaryMode);
      window.sessionStorage.setItem(MODEL_WIREFRAME_STORAGE_KEY, String(showTriangularMesh));
      window.sessionStorage.setItem(MODEL_EXAGGERATION_STORAGE_KEY, String(exaggeration));
    } catch {
      // The current view still works when session storage is unavailable.
    }
  }, [modelShape, terrainTheme, boundaryMode, showTriangularMesh, exaggeration]);

  useEffect(() => {
    exaggerationRef.current = exaggeration;
    const group = modelGroupRef.current;
    if (!group) return;
    group.scale.y = exaggeration;
    scheduleSceneRender(rendererRef.current, sceneRef.current, cameraRef.current, frameRequestRef);
  }, [exaggeration]);

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, a[href], [tabindex]:not([tabindex='-1'])",
    ));
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const model = loadState.status === "ready" ? loadState.model : null;
  const themeAvailability = availableThematicThemes(model);
  const activeTerrainTheme = effectiveTerrainTheme(terrainTheme, model);
  const derivativeUnavailableReason = loadState.status === "ready" ? loadState.derivativesUnavailableReason : null;
  const surfaceMissing = model && meshData && meshData.triangleCount === 0;
  const coveragePercent = model ? numberFormat.format(model.coverage.valid_sample_fraction * 100) : "0";
  const elevationTicks = [ABSOLUTE_MODEL_ELEVATION_MIN_M, 0, ABSOLUTE_MODEL_ELEVATION_MAX_M].map((valueM) => ({
    valueM,
    position: (valueM - ABSOLUTE_MODEL_ELEVATION_MIN_M)
      / (ABSOLUTE_MODEL_ELEVATION_MAX_M - ABSOLUTE_MODEL_ELEVATION_MIN_M) * 100,
    label: `${integerFormat.format(valueM).replace("-", "−")} m`,
  }));
  const aspectCoverage = model?.schema_version === "1.1" ? model.derivatives.aspect.coverage : null;
  const slopeCoverage = model?.schema_version === "1.1" ? model.derivatives.slope.coverage : null;
  const sampleMethodLabel = model?.schema_version === "1.1"
    ? model.derivatives.sampling_method === "native_pixel_centres"
      ? "Centros de píxel nativos"
      : "Vecino más próximo en centros comunes"
    : "No disponible";
  const derivativeWarnings = model?.schema_version === "1.1" ? model.derivatives.warnings : [];
  const categoryCoveragePercent = (coverage: { fraction_of_elevation_samples_covered: number } | null) => (
    coverage ? numberFormat.format(coverage.fraction_of_elevation_samples_covered * 100) : "0"
  );

  return (
    <div
      className="isolated-terrain-backdrop"
      data-theme={theme}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        ref={dialogRef}
        className="isolated-terrain-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="isolated-terrain-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="isolated-terrain-header">
          <div className="isolated-terrain-title-wrap">
            <span className="isolated-terrain-icon"><Mountain size={17} aria-hidden="true" /></span>
            <div>
              <p>MODELO DE TERRENO 3D</p>
              <h2 id="isolated-terrain-title">{areaName}</h2>
            </div>
          </div>
          <button className="isolated-terrain-close" type="button" aria-label="Cerrar modelo 3D" onClick={onClose}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className="isolated-terrain-body">
          <section className="isolated-terrain-viewport" aria-label="Modelo tridimensional navegable del terreno">
            {model && meshData && meshData.triangleCount > 0 && (
              <div ref={canvasHostRef} className="isolated-terrain-canvas-host" />
            )}
            {loadState.status === "loading" && (
              <div className="isolated-terrain-state" role="status">
                <LoaderCircle size={20} className="spinner" aria-hidden="true" />
                <span>Cargando la cuadrícula Copernicus…</span>
              </div>
            )}
            {loadState.status === "error" && (
              <div className="isolated-terrain-state isolated-terrain-state--message" role="alert">
                <AlertCircle size={20} aria-hidden="true" />
                <span>{loadState.message}</span>
                <button type="button" className="isolated-terrain-retry" onClick={() => setRetryVersion((value) => value + 1)}>
                  <RefreshCw size={14} aria-hidden="true" /> Reintentar
                </button>
              </div>
            )}
            {surfaceMissing && model && (
              <div className="isolated-terrain-state isolated-terrain-state--message" role="status">
                <AlertCircle size={20} aria-hidden="true" />
                <span>{model.coverage.availability === "no_data"
                  ? "La cuadrícula no contiene elevaciones válidas. La ausencia de datos no se representa como cota cero."
                  : "Hay algunas muestras, pero no forman triángulos suficientes para construir una superficie."}</span>
              </div>
            )}
            {rendererError && (
              <div className="isolated-terrain-state isolated-terrain-state--message" role="alert">
                <AlertCircle size={20} aria-hidden="true" />
                <span>{rendererError}</span>
                <button type="button" className="isolated-terrain-retry" onClick={() => setRendererVersion((value) => value + 1)}>
                  <RefreshCw size={14} aria-hidden="true" /> Reintentar visor
                </button>
              </div>
            )}
            {model && meshData && meshData.triangleCount > 0 && !rendererError && (
              <>
                <div className="isolated-terrain-north" aria-label="Flecha de norte de cuadrícula">
                  <span ref={northIndicatorRef}>↑</span>
                  <strong>N</strong>
                </div>
                <button
                  type="button"
                  className="isolated-terrain-reset"
                  onClick={() => resetViewRef.current?.()}
                  title="Reiniciar la perspectiva del modelo"
                >
                  <RotateCcw size={14} aria-hidden="true" /> Restablecer vista
                </button>
                <span className="isolated-terrain-hint">Arrastra para rotar · rueda o gesto para acercar · botón derecho o dos dedos para desplazar</span>
              </>
            )}
          </section>

          <aside className="isolated-terrain-info" aria-label="Información del modelo">
            <div className="isolated-terrain-metric isolated-terrain-metric--primary">
              <span>Superficie de la alternativa</span>
              <strong>{formatArea(areaAreaM2)}</strong>
              <small>Medida de la ficha; no se recalcula aquí.</small>
            </div>

            <div className="isolated-terrain-shape-control" role="group" aria-label="Forma del modelo 3D">
              <span>FORMA DEL MODELO</span>
              <div className="isolated-terrain-shape-options">
                <button
                  type="button"
                  aria-pressed={modelShape === "surface"}
                  onClick={() => setModelShape("surface")}
                >Superficie</button>
                <button
                  type="button"
                  aria-pressed={modelShape === "volume"}
                  onClick={() => setModelShape("volume")}
                >Volumen</button>
              </div>
              {modelShape === "volume" && volumeSupportData && (
                <small>Grosor gráfico: {formatMeters(volumeSupportData.thicknessM)} bajo la cota mínima. No representa profundidad geológica ni volumen real del terreno.</small>
              )}
            </div>

            <div className="isolated-terrain-theme-control" role="group" aria-label="Representación temática">
              <span>REPRESENTACIÓN TEMÁTICA</span>
              <div className="isolated-terrain-theme-options">
                <button type="button" aria-pressed={activeTerrainTheme === "natural"} onClick={() => setTerrainTheme("natural")}>Relieve natural</button>
                <button type="button" aria-pressed={activeTerrainTheme === "elevation"} onClick={() => setTerrainTheme("elevation")}>Elevación absoluta</button>
                <button type="button" aria-pressed={activeTerrainTheme === "hillshade"} onClick={() => setTerrainTheme("hillshade")}>Relieve sombreado</button>
                <button type="button" disabled={!themeAvailability.slope} aria-pressed={activeTerrainTheme === "slope"} onClick={() => setTerrainTheme("slope")}>Pendientes</button>
                <button type="button" disabled={!themeAvailability.aspect} aria-pressed={activeTerrainTheme === "aspect"} onClick={() => setTerrainTheme("aspect")}>Orientación</button>
              </div>
              <small>{activeTerrainTheme === "natural"
                ? "Paleta relativa al rango local; un mismo tono puede representar otra cota en otra alternativa."
                : activeTerrainTheme === "elevation"
                  ? "Colores fijos por cota en metros; las elevaciones negativas no se clasifican como agua."
                  : activeTerrainTheme === "hillshade"
                    ? "Iluminación gráfica para percibir el relieve; no representa el sol real ni una fecha y hora."
                    : activeTerrainTheme === "slope"
                      ? "Pendiente Horn en porcentaje, sin convertir a grados ni valorar idoneidad."
                      : "Dirección descendente respecto al norte de cuadrícula; no es norte geográfico."}</small>
            </div>

            {derivativeUnavailableReason && model?.schema_version === "1.0" && (
              <div className="isolated-terrain-derivative-status" role="status">
                <strong>Derivados no disponibles</strong>
                <span>{derivativeUnavailableReason} Se muestran los tres temas de elevación originales.</span>
                <button type="button" className="isolated-terrain-retry" onClick={() => setRetryVersion((value) => value + 1)}>
                  <RefreshCw size={13} aria-hidden="true" /> Reintentar derivados
                </button>
              </div>
            )}
            {model && isCategoricalTheme(terrainTheme) && !themeAvailability[terrainTheme] && !derivativeUnavailableReason && (
              <div className="isolated-terrain-derivative-status" role="status">
                <strong>{terrainTheme === "slope" ? "Pendiente" : "Orientación"} sin cobertura</strong>
                <span>Esta alternativa no tiene muestras válidas para la variable. Se muestra relieve natural.</span>
              </div>
            )}

            <div className={`isolated-terrain-legend isolated-terrain-legend--${activeTerrainTheme}`} aria-label={`Leyenda: ${activeTerrainTheme}`}>
              {activeTerrainTheme === "natural" && (
                <>
                  <span>Elevación relativa al rango local</span>
                  <div className="isolated-terrain-legend-bar" style={{ background: legendGradient("natural") }} />
                  <div className="isolated-terrain-legend-range">
                    <span>{formatMeters(model?.sampled_elevation_range_m?.minimum)}</span>
                    <span>{formatMeters(model?.sampled_elevation_range_m?.maximum)}</span>
                  </div>
                </>
              )}
              {activeTerrainTheme === "elevation" && (
                <>
                  <span>Elevación absoluta · metros</span>
                  <div className="isolated-terrain-absolute-bar-wrap">
                    <div className="isolated-terrain-legend-bar" style={{ background: legendGradient("elevation") }} />
                    {elevationTicks.map((tick) => (
                      <span className="isolated-terrain-absolute-tick" key={tick.valueM} style={{ left: `${tick.position}%` }}>
                        <i />
                        <small>{tick.label}</small>
                      </span>
                    ))}
                  </div>
                  <small>Escala fija: {integerFormat.format(ABSOLUTE_MODEL_ELEVATION_MIN_M)} a {integerFormat.format(ABSOLUTE_MODEL_ELEVATION_MAX_M)} m. Rango de esta cuadrícula: {model?.sampled_elevation_range_m
                    ? `${formatMeters(model.sampled_elevation_range_m.minimum)} – ${formatMeters(model.sampled_elevation_range_m.maximum)}`
                    : "sin muestras válidas"}.</small>
                </>
              )}
              {activeTerrainTheme === "hillshade" && (
                <>
                  <span>Relieve sombreado</span>
                  <small>Representación monocromática con luz de escena. No hay una leyenda numérica en este modo.</small>
                </>
              )}
              {activeTerrainTheme === "slope" && model?.schema_version === "1.1" && (
                <>
                  <span>Pendiente · porcentaje</span>
                  <div className="isolated-terrain-category-legend">
                    {SLOPE_THEME_LEGEND.map((category) => (
                      <div key={category.label}><i style={{ backgroundColor: category.color }} /><span>{category.label}</span></div>
                    ))}
                    {slopeCoverage && slopeCoverage.missing_samples > 0 && (
                      <div><i style={{ backgroundColor: TERRAIN_THEME_NODATA_COLOR }} /><span>Sin datos</span></div>
                    )}
                  </div>
                  <small>Los intervalos incluyen su límite superior; el último agrupa pendientes superiores al 60 %, incluidas las mayores del 100 %.</small>
                </>
              )}
              {activeTerrainTheme === "aspect" && model?.schema_version === "1.1" && (
                <>
                  <span>Orientación · norte de cuadrícula</span>
                  <div className="isolated-terrain-category-legend isolated-terrain-category-legend--aspect">
                    {ASPECT_THEME_LEGEND.map((category) => (
                      <div key={category.direction}><i style={{ backgroundColor: category.color }} /><span>{category.direction === "flat" ? "Plano" : `${category.direction} · ${category.label}`}</span></div>
                    ))}
                    {aspectCoverage && aspectCoverage.missing_samples > 0 && (
                      <div><i style={{ backgroundColor: TERRAIN_THEME_NODATA_COLOR }} /><span>Sin datos</span></div>
                    )}
                  </div>
                  <small>Ocho sectores de 45°. Norte incluye 0°/360° y las muestras próximas al cambio circular.</small>
                </>
              )}
              {model?.coverage.availability === "partial" && <small>Los huecos NoData no reciben color ni triangulación.</small>}
            </div>

            {isCategoricalTheme(activeTerrainTheme) && model?.schema_version === "1.1" && (
              <div className="isolated-terrain-derivative-info" aria-label="Procedencia y cobertura temática">
                <strong>Datos de la representación</strong>
                <dl>
                  <div><dt>Fuente y algoritmo</dt><dd>{model.derivatives.source} · {model.derivatives.algorithm}</dd></div>
                  <div><dt>Resolución original</dt><dd>{formatMeters(model.derivatives.source_resolution_m.east)} × {formatMeters(model.derivatives.source_resolution_m.north)}</dd></div>
                  <div><dt>Separación de muestras</dt><dd>{formatMeters(model.grid.sample_spacing_m.east)} × {formatMeters(model.grid.sample_spacing_m.north)}</dd></div>
                  <div><dt>Muestreo</dt><dd>{sampleMethodLabel}</dd></div>
                  <div><dt>Cobertura temática</dt><dd>{activeTerrainTheme === "slope"
                    ? `${slopeCoverage?.valid_samples ?? 0} / ${slopeCoverage?.total_samples ?? 0} muestras`
                    : `${aspectCoverage?.valid_samples ?? 0} / ${aspectCoverage?.total_samples ?? 0} muestras`}</dd></div>
                  <div><dt>Solapamiento con elevación</dt><dd>{activeTerrainTheme === "slope"
                    ? `${categoryCoveragePercent(slopeCoverage)} % (${slopeCoverage?.valid_with_elevation_samples ?? 0} / ${slopeCoverage?.elevation_valid_samples ?? 0})`
                    : `${categoryCoveragePercent(aspectCoverage)} % (${aspectCoverage?.valid_with_elevation_samples ?? 0} / ${aspectCoverage?.elevation_valid_samples ?? 0})`}</dd></div>
                  {activeTerrainTheme === "aspect" && aspectCoverage && (
                    <div><dt>Direccionales / planas</dt><dd>{aspectCoverage.directional_samples} / {aspectCoverage.flat_samples}</dd></div>
                  )}
                  {activeTerrainTheme === "aspect" && (
                    <div><dt>Umbral de plano</dt><dd>≤ {numberFormat.format(model.derivatives.flat_slope_threshold_percent)} %</dd></div>
                  )}
                </dl>
                <small>La cobertura se calcula sobre las muestras de elevación de la cuadrícula rectangular de visualización; no es cobertura superficial zonal ni un criterio objetivo.</small>
              </div>
            )}

            <div className="isolated-terrain-overlays" role="group" aria-label="Superposiciones">
              <span>SUPERPOSICIONES</span>
              <label>Límites de la alternativa</label>
              <div className="isolated-terrain-boundary-options">
                <button type="button" aria-pressed={boundaryMode === "fill"} onClick={() => setBoundaryMode("fill")}>Relleno y contorno</button>
                <button type="button" aria-pressed={boundaryMode === "outline"} onClick={() => setBoundaryMode("outline")}>Solo contorno</button>
                <button type="button" aria-pressed={boundaryMode === "hidden"} onClick={() => setBoundaryMode("hidden")}>Ocultos</button>
              </div>
              <label className="isolated-terrain-wireframe-toggle">
                <input type="checkbox" checked={showTriangularMesh} onChange={(event) => setShowTriangularMesh(event.target.checked)} />
                <span>Mostrar malla triangular</span>
              </label>
            </div>

            <div className="isolated-terrain-control">
              <label htmlFor="isolated-terrain-exaggeration">Exageración vertical</label>
              <div className="isolated-terrain-range-row">
                <input
                  id="isolated-terrain-exaggeration"
                  type="range"
                  min="0.5"
                  max="3"
                  step="0.1"
                  value={exaggeration}
                  onChange={(event) => setExaggeration(Number(event.target.value))}
                  aria-valuetext={`${numberFormat.format(exaggeration)} veces`}
                />
                <strong>{numberFormat.format(exaggeration)}×</strong>
              </div>
              <small>Solo cambia la apariencia vertical.</small>
            </div>

            {model ? (
              <>
                <dl className="isolated-terrain-data-list">
                  <div><dt>Fuente</dt><dd>{model.source}</dd></div>
                  <div><dt>Modelo</dt><dd>DSM · elevación visual</dd></div>
                  <div><dt>Resolución fuente</dt><dd>{formatMeters(model.source_resolution_m.east)} × {formatMeters(model.source_resolution_m.north)}</dd></div>
                  <div><dt>Separación de muestras</dt><dd>{formatMeters(model.grid.sample_spacing_m.east)} × {formatMeters(model.grid.sample_spacing_m.north)}</dd></div>
                  <div><dt>Cuadrícula disponible</dt><dd>{model.coverage.valid_samples.toLocaleString("es-ES")} / {(model.grid.rows * model.grid.columns).toLocaleString("es-ES")} ({coveragePercent} %)</dd></div>
                  <div><dt>Rango de la cuadrícula</dt><dd>{model.sampled_elevation_range_m
                    ? `${formatMeters(model.sampled_elevation_range_m.minimum)} – ${formatMeters(model.sampled_elevation_range_m.maximum)}`
                    : "Sin muestras válidas"}</dd></div>
                  <div><dt>Referencia vertical</dt><dd>{model.vertical_reference ?? "No indicada"}</dd></div>
                </dl>
                <div className={`isolated-terrain-coverage isolated-terrain-coverage--${model.coverage.availability}`} role="status">
                  <span>{model.coverage.availability === "available"
                    ? "Cobertura completa de la cuadrícula visual."
                    : model.coverage.availability === "partial"
                      ? "Cobertura parcial: solo se dibujan triángulos con elevaciones válidas; los huecos permanecen abiertos."
                      : model.coverage.availability === "no_data"
                        ? "La cuadrícula no tiene elevaciones disponibles."
                        : "Las muestras no tienen vecinos suficientes para formar superficie."}</span>
                </div>
                {model.coverage.availability === "partial" && (
                  <p className="isolated-terrain-area-warning">La alternativa puede quedar parcialmente sin representar donde no haya muestras válidas.</p>
                )}
                <details className="isolated-terrain-notes">
                  <summary>Procedencia y notas</summary>
                  <ul>
                    {model.warnings.map((warning) => <li key={warning}>{translateWarning(warning)}</li>)}
                    {derivativeWarnings.map((warning) => <li key={`derivative-${warning}`}>{translateWarning(warning)}</li>)}
                    <li>Los colores son representaciones visuales y no alteran las cotas ni las estadísticas zonales.</li>
                    <li>Los límites se proyectan sobre una textura de hasta 512 × 512 píxeles; Polygon, huecos y MultiPolygon conservan su geometría local.</li>
                    <li>Las categorías se proyectan desde los centros de la cuadrícula muestreada; no reproducen cada píxel original ni equivalen a estadísticas zonales.</li>
                  </ul>
                </details>
              </>
            ) : loadState.status === "error" ? (
              <p className="isolated-terrain-info-error">No se pudo cargar la información del modelo.</p>
            ) : (
              <p className="isolated-terrain-info-loading"><LoaderCircle size={14} className="spinner" aria-hidden="true" /> Consultando datos…</p>
            )}
            <p className="isolated-terrain-grid-note"><Compass size={13} aria-hidden="true" /> Norte de cuadrícula proyectada; no es una corrección al norte geográfico.</p>
          </aside>
        </div>
      </div>
    </div>
  );
}
