import { useMemo, useState } from "react";
import { Activity, LoaderCircle, X } from "lucide-react";
import type { ElevationProfileSample } from "@/lib/elevation-profile";
import type { ElevationProfileState } from "@/hooks/useElevationProfiles";
import { formatDistance } from "@/lib/geometry-metrics";
import "@/components/ElevationProfilePanel.css";

type ElevationProfilePanelProps = {
  name: string;
  profile: ElevationProfileState | undefined;
  onClose: () => void;
  onCancel: () => void;
  onSampleHover: (sample: ElevationProfileSample | null) => void;
};

const numberFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
const decimalFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

function formatElevation(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${numberFormat.format(value)} m`;
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${decimalFormat.format(value)} %`;
}

function ProfileChart({
  samples,
  totalDistanceMeters,
  onSampleHover,
}: {
  samples: ElevationProfileSample[];
  totalDistanceMeters: number;
  onSampleHover: (sample: ElevationProfileSample | null) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const width = 800;
  const height = 212;
  const plot = { left: 58, right: 14, top: 16, bottom: 34 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const validElevations = samples.flatMap((sample) => sample.elevationMeters === null ? [] : [sample.elevationMeters]);
  const minimum = validElevations.length ? Math.min(...validElevations) : 0;
  const maximum = validElevations.length ? Math.max(...validElevations) : 1;
  const padding = Math.max(10, (maximum - minimum) * 0.08);
  const domainMinimum = minimum - padding;
  const domainMaximum = maximum + padding;
  const xAt = (distance: number) => plot.left + (totalDistanceMeters > 0 ? distance / totalDistanceMeters : 0) * plotWidth;
  const yAt = (elevation: number) => plot.top + ((domainMaximum - elevation) / (domainMaximum - domainMinimum)) * plotHeight;

  const pathParts = useMemo(() => {
    const lineParts: string[] = [];
    const fillParts: string[] = [];
    let current: ElevationProfileSample[] = [];
    const flush = () => {
      if (!current.length) return;
      const line = current.map((sample, index) => `${index === 0 ? "M" : "L"}${xAt(sample.distanceMeters).toFixed(2)},${yAt(sample.elevationMeters as number).toFixed(2)}`).join(" ");
      lineParts.push(line);
      if (current.length > 1) {
        fillParts.push(`${line} L${xAt(current[current.length - 1].distanceMeters).toFixed(2)},${(plot.top + plotHeight).toFixed(2)} L${xAt(current[0].distanceMeters).toFixed(2)},${(plot.top + plotHeight).toFixed(2)} Z`);
      }
      current = [];
    };
    for (const sample of samples) {
      if (sample.elevationMeters === null) flush();
      else current.push(sample);
    }
    flush();
    return { line: lineParts.join(" "), fill: fillParts };
  }, [samples, totalDistanceMeters, domainMinimum, domainMaximum]);

  const selected = samples[Math.max(0, Math.min(samples.length - 1, selectedIndex))];
  const selectedX = selected ? xAt(selected.distanceMeters) : plot.left;
  const selectedY = selected?.elevationMeters === null || selected?.elevationMeters === undefined
    ? undefined
    : yAt(selected.elevationMeters);
  const description = selected
    ? `${formatDistance(selected.distanceMeters)} del recorrido, ${formatElevation(selected.elevationMeters)}`
    : "Sin muestra seleccionada";

  const chooseAtPointer = (clientX: number, bounds: DOMRect) => {
    if (!samples.length || bounds.width <= 0) return;
    const chartX = ((clientX - bounds.left) / bounds.width) * width;
    const distance = Math.max(0, Math.min(1, (chartX - plot.left) / plotWidth)) * totalDistanceMeters;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < samples.length; index += 1) {
      const difference = Math.abs(samples[index].distanceMeters - distance);
      if (difference < nearestDistance) {
        nearestDistance = difference;
        nearestIndex = index;
      }
    }
    setSelectedIndex(nearestIndex);
    onSampleHover(samples[nearestIndex]);
  };

  return (
    <div
      className="elevation-profile-chart"
      role="slider"
      aria-label="Perfil de elevación. Usa las flechas para recorrer las muestras."
      aria-valuemin={0}
      aria-valuemax={Math.round(totalDistanceMeters)}
      aria-valuenow={selected ? Math.round(selected.distanceMeters) : 0}
      aria-valuetext={description}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        chooseAtPointer(event.clientX, event.currentTarget.getBoundingClientRect());
      }}
      onPointerMove={(event) => {
        chooseAtPointer(event.clientX, event.currentTarget.getBoundingClientRect());
      }}
      onPointerLeave={() => onSampleHover(null)}
      onKeyDown={(event) => {
        if (!samples.length) return;
        const lastIndex = samples.length - 1;
        let nextIndex = selectedIndex;
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextIndex = Math.max(0, selectedIndex - 1);
        else if (event.key === "ArrowRight" || event.key === "ArrowUp") nextIndex = Math.min(lastIndex, selectedIndex + 1);
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = lastIndex;
        else return;
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(nextIndex);
        onSampleHover(samples[nextIndex]);
      }}
    >
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {[0, 1, 2, 3].map((tick) => {
          const fraction = tick / 3;
          const y = plot.top + fraction * plotHeight;
          const value = domainMaximum - fraction * (domainMaximum - domainMinimum);
          return (
            <g key={tick}>
              <line x1={plot.left} x2={width - plot.right} y1={y} y2={y} className="elevation-profile-gridline" />
              <text x={plot.left - 9} y={y + 3} textAnchor="end" className="elevation-profile-axis-label">{numberFormat.format(value)}</text>
            </g>
          );
        })}
        {pathParts.fill.map((path, index) => <path key={index} d={path} className="elevation-profile-fill" />)}
        <path d={pathParts.line} className="elevation-profile-line" />
        {[0, 1, 2, 3, 4].map((tick) => {
          const fraction = tick / 4;
          const x = plot.left + fraction * plotWidth;
          return (
            <g key={tick}>
              <line x1={x} x2={x} y1={plot.top + plotHeight} y2={plot.top + plotHeight + 4} className="elevation-profile-axis-tick" />
              <text x={x} y={height - 8} textAnchor="middle" className="elevation-profile-axis-label">{formatDistance(totalDistanceMeters * fraction)}</text>
            </g>
          );
        })}
        {selected && (
          <>
            <line x1={selectedX} x2={selectedX} y1={plot.top} y2={plot.top + plotHeight} className="elevation-profile-cursor" />
            {selectedY !== undefined && <circle cx={selectedX} cy={selectedY} r="5" className="elevation-profile-selected-point" />}
            <text
              x={selectedX > width * 0.72 ? selectedX - 8 : selectedX + 8}
              y={plot.top + 13}
              textAnchor={selectedX > width * 0.72 ? "end" : "start"}
              className="elevation-profile-tooltip"
            >
              {formatDistance(selected.distanceMeters)} · {formatElevation(selected.elevationMeters)}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

export function ElevationProfilePanel({ name, profile, onClose, onCancel, onSampleHover }: ElevationProfilePanelProps) {
  const result = profile?.result;
  const stats = result?.statistics;
  const statusLabel = profile?.status === "loading"
    ? "Consultando"
    : profile?.status === "partial"
      ? "Cobertura parcial"
      : profile?.status === "error"
        ? "No disponible"
        : profile?.status === "cancelled"
          ? "Detenido"
          : "Exploratorio";

  return (
    <section className="elevation-profile-panel" aria-label={`Perfil de elevación de ${name}`}>
      <header className="elevation-profile-header">
        <div className="elevation-profile-title">
          <span className="elevation-profile-icon"><Activity size={15} aria-hidden="true" /></span>
          <div>
            <span className="elevation-profile-eyebrow">PERFIL TOPOGRÁFICO</span>
            <h2 title={name}>{name}</h2>
          </div>
          <span className={`elevation-profile-status elevation-profile-status--${profile?.status ?? "error"}`}>{statusLabel}</span>
        </div>
        <div className="elevation-profile-actions">
          {profile?.status === "loading" && (
            <button type="button" className="elevation-profile-cancel" onClick={onCancel}>Detener</button>
          )}
          <button type="button" className="elevation-profile-close" aria-label="Cerrar perfil" title="Cerrar perfil" onClick={onClose}><X size={17} aria-hidden="true" /></button>
        </div>
      </header>

      {profile?.status === "loading" && (
        <div className="elevation-profile-loading" role="status">
          <LoaderCircle size={15} className="spinner" aria-hidden="true" />
          <span>Consultando {profile.processedSamples ?? 0} de {profile.totalSamples ?? 0} muestras…</span>
          <div className="elevation-profile-progress"><i style={{ width: `${Math.round(((profile.processedSamples ?? 0) / Math.max(1, profile.totalSamples ?? 1)) * 100)}%` }} /></div>
        </div>
      )}

      {profile?.message && <p className={`elevation-profile-message${profile.status === "error" ? " elevation-profile-message--error" : ""}`} role={profile.status === "error" ? "alert" : "status"}>{profile.message}</p>}

      {stats && (
        <>
          <dl className="elevation-profile-metrics">
            <div><dt>Recorrido</dt><dd>{formatDistance(stats.totalDistanceMeters)}</dd></div>
            <div><dt>Inicio · final</dt><dd>{formatElevation(stats.initialElevationMeters)} · {formatElevation(stats.finalElevationMeters)}</dd></div>
            <div><dt>Mín. · máx.</dt><dd>{formatElevation(stats.minimumElevationMeters)} · {formatElevation(stats.maximumElevationMeters)}</dd></div>
            <div><dt>Media · relieve</dt><dd>{formatElevation(stats.meanElevationMeters)} · {formatElevation(stats.maximumReliefMeters)}</dd></div>
            <div><dt>Ascenso · descenso</dt><dd>+{formatDistance(stats.cumulativeAscentMeters)} · −{formatDistance(stats.cumulativeDescentMeters)}</dd></div>
            <div><dt>Cobertura</dt><dd>{formatPercent(stats.coveragePercent)} · {stats.validSampleCount}/{stats.totalSampleCount}</dd></div>
          </dl>
          <ProfileChart samples={result.samples} totalDistanceMeters={stats.totalDistanceMeters} onSampleHover={onSampleHover} />
          <p className="elevation-profile-source">
            Mapzen Terrain Tiles · Terrarium · z{stats.minimumSourceZoom ?? "—"}–{stats.maximumSourceZoom ?? "—"}
            {stats.minimumPixelGroundDistanceMeters !== null && stats.maximumPixelGroundDistanceMeters !== null
              ? ` · píxel nominal ${formatDistance(stats.minimumPixelGroundDistanceMeters)}–${formatDistance(stats.maximumPixelGroundDistanceMeters)}`
              : " · píxel nominal no disponible"}
            {` · paso medio ${formatDistance(stats.meanSampleSpacingMeters)} · ${stats.requestedTileCount} peticiones nuevas`}
          </p>
        </>
      )}

      <p className="elevation-profile-disclaimer">Perfil exploratorio: media, ascensos y descensos dependen del muestreo. El píxel nominal no garantiza la resolución nativa del modelo y los huecos sin datos no se interpolan.</p>
    </section>
  );
}
