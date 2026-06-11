"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { faaTokens, pageShellStyles as s } from "../../lib/page-shell";

import { normalizeForLookup } from "./use-faa-lookup";

export interface FaaSearchResult {
  n_number: string;
  make: string | null;
  model: string | null;
  owner_name: string | null;
  year_mfr: number | null;
}

interface SearchResponse {
  kind: "results";
  results: FaaSearchResult[];
  freshness: { pg_loaded_at: string | null };
}

type SearchStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "results"; results: FaaSearchResult[] }
  | { kind: "empty" }
  | { kind: "error"; message: string };

interface Props {
  tenantId: string;
  value: string;
  onChange: (next: string) => void;
  /** Called when a row is picked. Defaults to onChange(n_number). */
  onSelect?: (picked: FaaSearchResult) => void;
  id?: string;
  name?: string;
  required?: boolean;
  placeholder?: string;
  inputStyle?: CSSProperties;
}

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 250;
const LIMIT = 10;
const OWNER_MAX_CHARS = 32;

export function FaaSearchCombobox({
  tenantId,
  value,
  onChange,
  onSelect,
  id,
  name,
  required,
  placeholder,
  inputStyle,
}: Props) {
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;
  const optionId = (i: number) => `${reactId}-option-${i}`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [status, setStatus] = useState<SearchStatus>({ kind: "idle" });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeq = useRef(0);

  const normalized = normalizeForLookup(value);
  const queryEligible =
    normalized != null && normalized.length >= MIN_QUERY_LEN;

  useEffect(() => {
    if (!queryEligible) {
      abortRef.current?.abort();
      abortRef.current = null;
      setStatus({ kind: "idle" });
      return;
    }
    const q = normalized!;
    const seq = ++requestSeq.current;
    const timer = window.setTimeout(() => {
      void runSearch(seq, q);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);

    async function runSearch(thisSeq: number, query: string) {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setStatus({ kind: "loading" });
      try {
        const url = `/api/orgs/${encodeURIComponent(
          tenantId,
        )}/faa/aircraft/search?q=${encodeURIComponent(query)}&limit=${LIMIT}`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-tenant-id": tenantId,
          },
          signal: ctrl.signal,
        });
        if (thisSeq !== requestSeq.current) return;
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          setStatus({
            kind: "error",
            message: errBody?.error ?? `Search failed (${res.status})`,
          });
          return;
        }
        const body = (await res.json().catch(() => null)) as
          | SearchResponse
          | null;
        if (thisSeq !== requestSeq.current) return;
        const results = Array.isArray(body?.results) ? body!.results : [];
        if (results.length === 0) {
          setStatus({ kind: "empty" });
        } else {
          setStatus({ kind: "results", results });
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        if (thisSeq !== requestSeq.current) return;
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, [tenantId, normalized, queryEligible]);

  // Reset active row when result set churns.
  useEffect(() => {
    setActiveIndex(-1);
  }, [status]);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (target && containerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("touchstart", onDocPointer);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("touchstart", onDocPointer);
    };
  }, [open]);

  const results = useMemo(
    () => (status.kind === "results" ? status.results : []),
    [status],
  );

  const commitSelection = useCallback(
    (idx: number) => {
      const picked = results[idx];
      if (!picked) return;
      if (onSelect) onSelect(picked);
      else onChange(picked.n_number);
      setOpen(false);
      setActiveIndex(-1);
      inputRef.current?.focus();
    },
    [onChange, onSelect, results],
  );

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (!open) setOpen(true);
      if (results.length === 0) return;
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % results.length);
      return;
    }
    if (e.key === "ArrowUp") {
      if (!open) setOpen(true);
      if (results.length === 0) return;
      e.preventDefault();
      setActiveIndex((prev) =>
        prev <= 0 ? results.length - 1 : prev - 1,
      );
      return;
    }
    if (e.key === "Enter") {
      if (open && activeIndex >= 0) {
        e.preventDefault();
        commitSelection(activeIndex);
      }
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      }
      return;
    }
  }

  const showPanel =
    open &&
    queryEligible &&
    (status.kind === "loading" ||
      status.kind === "results" ||
      status.kind === "empty" ||
      status.kind === "error");

  return (
    <div ref={containerRef} style={containerStyle}>
      <input
        ref={inputRef}
        id={id}
        name={name}
        required={required}
        placeholder={placeholder}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showPanel}
        aria-busy={status.kind === "loading"}
        aria-controls={listboxId}
        aria-activedescendant={
          showPanel && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        style={inputStyle ?? s.input}
      />

      {showPanel ? (
        <div style={panelStyle} data-testid="faa-search-panel">
          {status.kind === "loading" ? (
            <div style={loadingRowStyle} aria-live="polite">
              <Spinner />
              <span>Searching FAA Registry…</span>
            </div>
          ) : null}

          {status.kind === "results" ? (
            <ul
              role="listbox"
              id={listboxId}
              aria-label="FAA Registry matches"
              style={listStyle}
            >
              {status.results.map((row, i) => {
                const isActive = activeIndex === i;
                return (
                  <li
                    key={row.n_number}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isActive ? "true" : "false"}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitSelection(i);
                    }}
                    onMouseEnter={() => setActiveIndex(i)}
                    style={{
                      ...optionStyle,
                      background: isActive
                        ? faaTokens.surfaceInfoSubtle
                        : "transparent",
                      borderLeftColor: isActive
                        ? faaTokens.textInfo
                        : "transparent",
                      fontWeight: isActive ? 500 : 400,
                    }}
                    data-testid="faa-search-row"
                  >
                    <span style={nNumberStyle}>N{row.n_number}</span>
                    <span
                      style={secondaryLineStyle}
                      title={row.owner_name ?? ""}
                    >
                      {buildSecondaryLine(row)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {status.kind === "empty" ? (
            <div
              role="status"
              aria-live="polite"
              data-testid="faa-search-empty"
              style={emptyRowStyle}
            >
              No results found — try a longer N-Number, or enter registration
              manually
            </div>
          ) : null}

          {status.kind === "error" ? (
            <div
              role="status"
              aria-live="polite"
              data-testid="faa-search-error"
              data-state="lookup_unavailable"
              style={errorRowStyle}
            >
              FAA search unavailable
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + "…";
}

function buildSecondaryLine(row: FaaSearchResult): string {
  const parts: string[] = [];
  if (row.make) parts.push(row.make);
  if (row.model) parts.push(row.model);
  if (row.year_mfr != null) parts.push(String(row.year_mfr));
  if (row.owner_name) parts.push(truncate(row.owner_name, OWNER_MAX_CHARS));
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      role="img"
      aria-label="Searching FAA registry"
      data-testid="faa-search-spinner"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="#cbd5e1"
        strokeWidth="3"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        fill="none"
        stroke={faaTokens.textInfo}
        strokeWidth="3"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

const containerStyle: CSSProperties = {
  position: "relative",
};

const panelStyle: CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  zIndex: 30,
  marginTop: 4,
  background: "white",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
  maxHeight: 360,
  overflowY: "auto",
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const optionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.125rem",
  padding: "0.75rem 1rem",
  minHeight: 44,
  cursor: "pointer",
  borderBottom: "1px solid #f1f5f9",
  borderLeft: "3px solid transparent",
  lineHeight: 1.3,
};

const nNumberStyle: CSSProperties = {
  fontWeight: 500,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  fontSize: "0.875rem",
  color: "#111827",
};

const secondaryLineStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: faaTokens.textSecondary,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

const loadingRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.6rem 0.75rem",
  color: faaTokens.textSecondary,
  fontSize: "0.9rem",
};

const emptyRowStyle: CSSProperties = {
  padding: "0.6rem 0.75rem",
  color: faaTokens.textSecondary,
  fontSize: "0.9rem",
};

const errorRowStyle: CSSProperties = {
  padding: "0.6rem 0.75rem",
  background: faaTokens.surfaceWarningSubtle,
  color: faaTokens.textWarningStrong,
  fontSize: "0.9rem",
  borderRadius: 6,
};
