import { useState } from "react";
import { CircleDot, LoaderCircle, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GeometryBufferState } from "@/hooks/useGeometryBuffer";
import "@/components/GeometryBufferControl.css";

type GeometryBufferControlProps = {
  sourceName: string;
  state?: GeometryBufferState | null;
  onGenerate: (distanceMeters: number) => void;
  onConfirm: (name: string) => void;
  onCancel: () => void;
};

const MAX_DISTANCE_METERS = 50_000;

export function GeometryBufferControl({ sourceName, state, onGenerate, onConfirm, onCancel }: GeometryBufferControlProps) {
  const [distanceValue, setDistanceValue] = useState("500");
  const [unit, setUnit] = useState<"m" | "km">("m");
  const [areaName, setAreaName] = useState(() => `Buffer de ${sourceName}`.slice(0, 80));
  const [formMessage, setFormMessage] = useState("");
  const isLoading = state?.status === "loading";
  const hasPreview = state?.status === "preview" && state.geometry;

  const generate = () => {
    const enteredDistance = Number(distanceValue.trim().replace(",", "."));
    const distanceMeters = unit === "km" ? enteredDistance * 1000 : enteredDistance;
    if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
      setFormMessage("Indica una distancia mayor que cero.");
      return;
    }
    if (distanceMeters > MAX_DISTANCE_METERS) {
      setFormMessage("La distancia máxima es 50 km.");
      return;
    }
    if (!areaName.trim()) {
      setFormMessage("Escribe un nombre para el área resultante.");
      return;
    }
    setFormMessage("");
    onGenerate(distanceMeters);
  };

  const changeDistance = (value: string) => {
    setDistanceValue(value);
    setFormMessage("");
    if (state) onCancel();
  };

  const changeUnit = (value: "m" | "km") => {
    const numericDistance = Number(distanceValue.trim().replace(",", "."));
    if (Number.isFinite(numericDistance) && numericDistance > 0) {
      const converted = unit === "m" && value === "km"
        ? numericDistance / 1000
        : unit === "km" && value === "m"
          ? numericDistance * 1000
          : numericDistance;
      setDistanceValue(String(Number(converted.toPrecision(8))));
    }
    setUnit(value);
    setFormMessage("");
    if (state) onCancel();
  };

  return (
    <section className="geometry-buffer-control" aria-label="Crear zona de influencia">
      <h3><CircleDot size={14} aria-hidden="true" /> Crear zona de influencia</h3>
      <div className="geometry-buffer-distance-row">
        <label htmlFor="buffer-distance">Distancia</label>
        <input
          id="buffer-distance"
          type="number"
          inputMode="decimal"
          min="0.01"
          max={unit === "km" ? MAX_DISTANCE_METERS / 1000 : MAX_DISTANCE_METERS}
          step="any"
          value={distanceValue}
          onChange={(event) => changeDistance(event.target.value)}
          disabled={isLoading}
        />
        <select
          aria-label="Unidad de distancia"
          value={unit}
          onChange={(event) => changeUnit(event.target.value as "m" | "km")}
          disabled={isLoading}
        >
          <option value="m">m</option>
          <option value="km">km</option>
        </select>
      </div>
      <label className="geometry-buffer-name-label" htmlFor="buffer-area-name">Nombre del área resultante</label>
      <input
        id="buffer-area-name"
        className="geometry-buffer-name"
        value={areaName}
        maxLength={80}
        onChange={(event) => {
          setAreaName(event.target.value);
          setFormMessage("");
        }}
        disabled={isLoading}
      />

      {formMessage && <p className="geometry-buffer-message geometry-buffer-message--error" role="alert">{formMessage}</p>}
      {state?.status === "loading" && <p className="geometry-buffer-message" role="status">Calculando una vista previa en el servidor…</p>}
      {state?.status === "error" && <p className="geometry-buffer-message geometry-buffer-message--error" role="alert">{state.message}</p>}
      {state?.status === "preview" && (
        <div className="geometry-buffer-preview-summary" role="status">
          <span>Vista previa · {state.distanceMeters >= 1000 ? `${(state.distanceMeters / 1000).toLocaleString("es-ES")} km` : `${state.distanceMeters.toLocaleString("es-ES")} m`}</span>
          {state.processingCrs && <span>CRS {state.processingCrs}</span>}
        </div>
      )}
      {state?.warnings.map((warning) => <p className="geometry-buffer-message" key={warning}>{warning}</p>)}

      <div className="geometry-buffer-actions">
        {hasPreview ? (
          <>
            <Button variant="primary" size="small" onClick={() => onConfirm(areaName.trim())} disabled={!areaName.trim()}>
              <Sparkles size={14} aria-hidden="true" /> Crear área
            </Button>
            <Button variant="ghost" size="small" onClick={onCancel}>
              <X size={14} aria-hidden="true" /> Cancelar
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="small" onClick={generate} disabled={isLoading}>
              {isLoading ? <LoaderCircle size={14} className="spinner" aria-hidden="true" /> : <CircleDot size={14} aria-hidden="true" />}
              {isLoading ? "Calculando…" : "Generar vista previa"}
            </Button>
            {(isLoading || state?.status === "error") && (
              <Button variant="ghost" size="small" onClick={onCancel}>
                <X size={14} aria-hidden="true" /> Cancelar
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
