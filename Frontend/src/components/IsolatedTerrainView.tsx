import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AlertCircle, Compass, LoaderCircle, Mountain, RefreshCw, RotateCcw, X } from "lucide-react";
import { formatArea } from "@/lib/geometry-metrics";
import { buildTerrainMesh, projectGeometryToTexture, type TerrainMeshData } from "@/lib/terrain-model-mesh";
import { observeTerrainModel, TerrainModelRequestError, type TerrainModelResponse } from "@/lib/terrain-model";
import "@/components/IsolatedTerrainView.css";

type IsolatedTerrainViewProps = {
  areaName: string;
  areaAreaM2: number;
  analysisId: string;
  theme: "light" | "dark";
  onClose: () => void;
};

type LoadState = { status: "loading" } | { status: "ready"; model: TerrainModelResponse } | { status: "error"; message: string };

const numberFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

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
  return warning;
}

function makeElevationColorTexture(model: TerrainModelResponse): THREE.CanvasTexture {
  const { grid, geometry_local_m: localGeometry } = model;
  const width = Math.max(64, Math.min(512, grid.columns * 2));
  const height = Math.max(64, Math.min(512, grid.rows * 2));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("No se pudo crear la textura del terreno en este navegador.");

  const colors = [
    [42, 91, 72],
    [102, 133, 84],
    [174, 160, 106],
    [152, 119, 83],
    [224, 222, 207],
  ] as const;
  const low = model.sampled_elevation_range_m?.minimum ?? 0;
  const high = model.sampled_elevation_range_m?.maximum ?? low;
  const elevationRange = high - low;
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const row = Math.round((height - 1 - y) / Math.max(1, height - 1) * (grid.rows - 1));
    for (let x = 0; x < width; x += 1) {
      const column = Math.round(x / Math.max(1, width - 1) * (grid.columns - 1));
      const elevation = grid.values_m[row][column];
      const t = elevation === null || elevationRange === 0 ? 0.5 : Math.max(0, Math.min(1, (elevation - low) / elevationRange));
      const scaled = t * (colors.length - 1);
      const start = Math.min(colors.length - 2, Math.floor(scaled));
      const blend = scaled - start;
      const color = colors[start].map((value, channel) => Math.round(value + (colors[start + 1][channel] - value) * blend));
      const offset = (y * width + x) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);

  const polygons = projectGeometryToTexture(localGeometry, grid, width, height);
  context.lineJoin = "round";
  context.lineCap = "round";
  for (const polygon of polygons) {
    context.beginPath();
    for (const ring of polygon.rings) {
      ring.forEach(([x, y], index) => index === 0 ? context.moveTo(x, y) : context.lineTo(x, y));
      context.closePath();
    }
    context.fillStyle = "rgba(69, 197, 197, 0.3)";
    context.fill("evenodd");
    context.strokeStyle = "#134f8a";
    context.lineWidth = 2;
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
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

export default function IsolatedTerrainView({ areaName, areaAreaM2, analysisId, theme, onClose }: IsolatedTerrainViewProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [retryVersion, setRetryVersion] = useState(0);
  const [rendererVersion, setRendererVersion] = useState(0);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [exaggeration, setExaggeration] = useState(1);
  const dialogRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const northIndicatorRef = useRef<HTMLSpanElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);
  const themeRef = useRef(theme);
  const frameRequestRef = useRef<number | null>(null);
  const meshData = useMemo(
    () => loadState.status === "ready" ? buildTerrainMesh(loadState.model.grid) : null,
    [loadState],
  );

  useEffect(() => {
    const observation = observeTerrainModel(analysisId, 128);
    let active = true;
    setLoadState({ status: "loading" });
    setRendererError(null);
    observation.promise.then((model) => {
      if (active) setLoadState({ status: "ready", model });
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
    const camera = cameraRef.current;
    if (scene) scene.background = new THREE.Color(theme === "dark" ? "#0b1b2a" : "#eef2f3");
    if (frameRequestRef.current === null && rendererRef.current && scene && camera) {
      frameRequestRef.current = requestAnimationFrame(() => {
        frameRequestRef.current = null;
        rendererRef.current?.render(scene, camera);
      });
    }
  }, [theme]);

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

    let texture: THREE.CanvasTexture;
    try {
      texture = makeElevationColorTexture(loadState.model);
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
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.88, metalness: 0, side: THREE.FrontSide });
    const terrainMesh = new THREE.Mesh(surface, material);
    terrainMesh.name = "Copernicus elevation grid with draped alternative";
    terrainGroup.add(terrainMesh);
    scene.add(terrainGroup);

    const ambient = new THREE.HemisphereLight(0xf2f7f4, 0x66705d, 1.55);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xfff4dc, 2.1);
    directional.position.set(-0.65, 1.5, 0.8).multiplyScalar(1200);
    scene.add(directional);

    const host = canvasHostRef.current;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 250_000);
    const { east: gridEast, north: gridNorth } = loadState.model.grid.sample_spacing_m;
    const spanX = (loadState.model.grid.columns - 1) * gridEast;
    const spanZ = (loadState.model.grid.rows - 1) * gridNorth;
    const spanY = Math.max(1, (meshData.maximumElevationM ?? 0) - (meshData.minimumElevationM ?? 0));
    const maxSpan = Math.max(spanX, spanZ, spanY, 1);
    const distance = maxSpan * 1.25 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const initialCameraPosition = new THREE.Vector3(distance * 0.72, distance * 0.82, distance * 0.92);
    camera.position.copy(initialCameraPosition);
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    controls.minDistance = Math.max(0.5, maxSpan * 0.18);
    controls.maxDistance = distance * 7;
    controls.minPolarAngle = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.update();

    const resetView = () => {
      camera.position.copy(initialCameraPosition);
      controls.target.set(0, 0, 0);
      controls.update();
      camera.lookAt(0, 0, 0);
      updateNorth();
      render();
    };

    const render = () => {
      if (!rendererRef.current || frameRequestRef.current !== null) return;
      frameRequestRef.current = requestAnimationFrame(() => {
        frameRequestRef.current = null;
        renderer.render(scene, camera);
      });
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
      texture.dispose();
      terrainGroup.clear();
      scene.clear();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      modelGroupRef.current = null;
      resetViewRef.current = null;
    };
  }, [loadState, meshData, rendererVersion]);

  useEffect(() => {
    const group = modelGroupRef.current;
    if (!group) return;
    group.scale.y = exaggeration;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (renderer && scene && camera && frameRequestRef.current === null) {
      frameRequestRef.current = requestAnimationFrame(() => {
        frameRequestRef.current = null;
        renderer.render(scene, camera);
      });
    }
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
  const surfaceMissing = model && meshData && meshData.triangleCount === 0;
  const coveragePercent = model ? numberFormat.format(model.coverage.valid_sample_fraction * 100) : "0";

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
                    <li>El color muestra el rango de esta cuadrícula rectangular, no las estadísticas zonales del área.</li>
                    <li>El contorno está rasterizado en una textura de hasta 512 × 512 píxeles y se ajusta a los centros de las muestras.</li>
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
