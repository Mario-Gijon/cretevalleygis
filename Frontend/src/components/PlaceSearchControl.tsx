import { useEffect, useRef, useState } from "react";
import { LoaderCircle, MapPin, Search, X } from "lucide-react";
import {
  parseCoordinateSearch,
  placeTypeLabel,
  searchPlaces,
  type PlaceSearchResult,
  type SearchSelection,
} from "@/lib/place-search";

type PlaceSearchControlProps = {
  onSelect: (selection: SearchSelection) => void;
};

type SearchStatus = "idle" | "loading" | "ready" | "empty" | "error";

const DEBOUNCE_MS = 260;
const RESULT_LIST_ID = "place-search-results";

export function PlaceSearchControl({ onSelect }: PlaceSearchControlProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedTextRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const coordinate = parseCoordinateSearch(query);
  const visible = open && focused && query.trim().length > 0;
  const optionCount = coordinate.kind === "valid" ? 1 : results.length;

  useEffect(() => {
    const trimmed = query.trim();
    if (selectedTextRef.current === trimmed || coordinate.kind !== "not-coordinates" || trimmed.length < 2) {
      setResults([]);
      setErrorMessage("");
      setStatus("idle");
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setResults([]);
    setErrorMessage("");
    setStatus("loading");
    const timer = window.setTimeout(() => {
      void searchPlaces(trimmed, controller.signal)
        .then((items) => {
          if (cancelled) return;
          setResults(items);
          setStatus(items.length > 0 ? "ready" : "empty");
          setActiveIndex(-1);
        })
        .catch((error: unknown) => {
          if (cancelled || controller.signal.aborted) return;
          setErrorMessage(error instanceof Error ? error.message : "No se pudo completar la búsqueda local.");
          setStatus("error");
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [coordinate.kind, query]);

  const selectResult = (selection: SearchSelection) => {
    selectedTextRef.current = selection.name.trim();
    setQuery(selection.name);
    setOpen(false);
    setFocused(false);
    setActiveIndex(-1);
    inputRef.current?.blur();
    onSelect(selection);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setActiveIndex(-1);
        inputRef.current?.blur();
      }
      return;
    }
    if (event.key === "ArrowDown" && visible && optionCount > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % optionCount);
    } else if (event.key === "ArrowUp" && visible && optionCount > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? optionCount - 1 : current - 1));
    } else if (event.key === "Enter" && visible) {
      if (coordinate.kind === "valid") {
        event.preventDefault();
        selectResult(coordinate.result);
      } else if (coordinate.kind === "not-coordinates" && results.length > 0) {
        event.preventDefault();
        selectResult(results[activeIndex >= 0 ? activeIndex : 0]);
      }
    }
  };

  const changeQuery = (value: string) => {
    selectedTextRef.current = null;
    setQuery(value);
    setOpen(true);
    setActiveIndex(-1);
  };

  return (
    <div className="place-search-control">
      <div className="place-search-input-wrap">
        <Search size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Buscar lugares o coordenadas"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={RESULT_LIST_ID}
          aria-activedescendant={activeIndex >= 0 ? `place-search-option-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Lugar o coordenadas"
          value={query}
          onChange={(event) => changeQuery(event.currentTarget.value)}
          onFocus={() => { setFocused(true); setOpen(true); }}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {status === "loading" && coordinate.kind === "not-coordinates" && (
          <LoaderCircle className="spinner" size={15} aria-label="Buscando" />
        )}
        {query && (
          <button
            type="button"
            className="place-search-clear"
            aria-label="Borrar búsqueda"
            title="Borrar búsqueda"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { changeQuery(""); inputRef.current?.focus(); }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {visible && (
        <div id={RESULT_LIST_ID} className="place-search-results" role="listbox" aria-label="Resultados de búsqueda">
          {coordinate.kind === "valid" && (
            <button
              id="place-search-option-0"
              type="button"
              role="option"
              aria-selected={activeIndex === 0}
              className={`place-search-option${activeIndex === 0 ? " place-search-option--active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(0)}
              onClick={() => selectResult(coordinate.result)}
            >
              <MapPin size={16} aria-hidden="true" />
              <span className="place-search-option__copy">
                <strong>{coordinate.result.name}</strong>
                <small>Usar coordenadas introducidas</small>
              </span>
              <span className="place-search-type">Coordenadas</span>
            </button>
          )}

          {coordinate.kind === "invalid" && <p className="place-search-state place-search-state--error" role="alert">{coordinate.message}</p>}
          {coordinate.kind === "not-coordinates" && query.trim().length < 2 && (
            <p className="place-search-state">Escribe al menos 2 caracteres para buscar en Natural Earth.</p>
          )}
          {coordinate.kind === "not-coordinates" && status === "loading" && (
            <p className="place-search-state"><LoaderCircle className="spinner" size={14} aria-hidden="true" /> Buscando lugares…</p>
          )}
          {coordinate.kind === "not-coordinates" && status === "empty" && (
            <p className="place-search-state">No hay coincidencias en los datos locales disponibles.</p>
          )}
          {coordinate.kind === "not-coordinates" && status === "error" && (
            <p className="place-search-state place-search-state--error" role="alert">{errorMessage}</p>
          )}
          {coordinate.kind === "not-coordinates" && results.map((result, index) => (
            <button
              id={`place-search-option-${index}`}
              key={result.id}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              className={`place-search-option${activeIndex === index ? " place-search-option--active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectResult(result)}
            >
              <MapPin size={16} aria-hidden="true" />
              <span className="place-search-option__copy">
                <strong>{result.name}</strong>
                <small>{[result.country, result.region].filter(Boolean).join(" · ") || result.source}</small>
              </span>
              <span className="place-search-type">{placeTypeLabel(result.type)}</span>
            </button>
          ))}
          {coordinate.kind === "not-coordinates" && status === "ready" && (
            <p className="place-search-source">Fuente: Natural Earth 1:10m · cobertura limitada a países y localidades pobladas incluidas</p>
          )}
        </div>
      )}
    </div>
  );
}
