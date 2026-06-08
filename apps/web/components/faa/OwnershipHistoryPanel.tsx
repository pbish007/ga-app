"use client";

import { useEffect, useState } from "react";

import { faaTokens, pageShellStyles as s } from "../../lib/page-shell";

import { FaaFreshnessPill } from "./FaaFreshnessPill";

export type FaaAircraftChangeKind =
  | "new_registration"
  | "ownership_transfer"
  | "address_change"
  | "expiration_change"
  | "airworthiness_change"
  | "deregistration";

export interface OwnershipHistoryEvent {
  snapshot_date: string;
  change_kind: FaaAircraftChangeKind;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
}

export interface OwnershipHistoryResponse {
  events: OwnershipHistoryEvent[];
  freshness: { snapshot_date: string | null; pg_loaded_at: string | null };
}

interface Props {
  tenantId: string;
  aircraftId: string;
  /** Test-only injection; defaults to the live API endpoint. */
  fetchImpl?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  /** Test-only initial state for component-level rendering tests. */
  initial?: OwnershipHistoryResponse | null;
}

const containerStyle = {
  marginTop: "0.75rem",
  padding: "1rem",
  border: "1px solid " + faaTokens.actionSecondaryBorder,
  borderRadius: 6,
} as const;

const CHANGE_KIND_LABELS: Record<FaaAircraftChangeKind, string> = {
  new_registration: "New registration",
  ownership_transfer: "Ownership transfer",
  address_change: "Address change",
  expiration_change: "Expiration date change",
  airworthiness_change: "Airworthiness date change",
  deregistration: "Deregistration",
};

/**
 * R4 follow-up (PMB-215): Ownership History panel.
 *
 * Renders the `aircraft_changes` log written by R3 change detection for
 * the tail. The panel is informational only — no edit affordances, no
 * decision write-back; the per-field chip handles user intent against
 * the live registry row.
 *
 * Empty state ("no FAA-recorded changes yet") is a legitimate state for
 * any aircraft that hasn't churned since R3 captured forward; the
 * issue's acceptance criteria treat 404-from-no-rows as a UX bug.
 */
export function OwnershipHistoryPanel({
  tenantId,
  aircraftId,
  fetchImpl,
  initial,
}: Props) {
  const [data, setData] = useState<OwnershipHistoryResponse | null>(
    initial ?? null,
  );
  const [loading, setLoading] = useState<boolean>(initial == null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial != null) return;
    let cancelled = false;
    const f = fetchImpl ?? fetch;
    async function load() {
      try {
        const res = await f(
          `/api/orgs/${encodeURIComponent(tenantId)}/aircraft/${encodeURIComponent(aircraftId)}/faa-ownership-history`,
          { headers: { accept: "application/json", "x-tenant-id": tenantId } },
        );
        if (!res.ok) {
          if (cancelled) return;
          setError(`Couldn't load FAA history (${res.status}).`);
          setLoading(false);
          return;
        }
        const body = (await res.json()) as OwnershipHistoryResponse;
        if (cancelled) return;
        setData(body);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [tenantId, aircraftId, fetchImpl, initial]);

  return (
    <section style={containerStyle} data-testid="faa-ownership-history">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.75rem",
          marginBottom: "0.5rem",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "1rem" }}>FAA Ownership History</h3>
        <FaaFreshnessPill pgLoadedAt={data?.freshness.pg_loaded_at ?? null} />
      </div>

      {loading ? (
        <p style={s.muted}>Loading FAA-recorded changes…</p>
      ) : error ? (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.9rem" }}>
          {error}
        </p>
      ) : !data || data.events.length === 0 ? (
        <p style={s.muted} data-testid="faa-ownership-history-empty">
          No FAA-recorded ownership or registration changes for this tail yet.
        </p>
      ) : (
        <ol
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
          }}
          data-testid="faa-ownership-history-list"
        >
          {data.events.map((event, idx) => (
            <li
              key={`${event.snapshot_date}:${event.change_kind}:${idx}`}
              style={{
                padding: "0.6rem 0.75rem",
                border: "1px solid #eee",
                borderRadius: 4,
                background: faaTokens.surfaceNeutralSubtle,
              }}
              data-testid="faa-ownership-history-event"
              data-change-kind={event.change_kind}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "0.25rem",
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {CHANGE_KIND_LABELS[event.change_kind] ?? event.change_kind}
                </span>
                <span style={{ color: faaTokens.textSecondary, fontSize: "0.85rem" }}>
                  {event.snapshot_date}
                </span>
              </div>
              <EventDetails event={event} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EventDetails({ event }: { event: OwnershipHistoryEvent }) {
  const fields = mergeFields(event.previous_value, event.new_value);
  if (fields.length === 0) {
    return (
      <p style={{ margin: 0, color: faaTokens.textSecondary, fontSize: "0.85rem" }}>
        No field-level detail captured.
      </p>
    );
  }
  return (
    <ul
      style={{
        listStyle: "none",
        padding: 0,
        margin: 0,
        fontSize: "0.9rem",
      }}
    >
      {fields.map((row) => (
        <li
          key={row.key}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.35rem",
            padding: "2px 0",
          }}
          data-testid="faa-ownership-history-field"
          data-field-key={row.key}
        >
          <span style={{ color: faaTokens.textSecondary, minWidth: 120 }}>
            {labelize(row.key)}:
          </span>
          <span>
            {formatValue(row.previous)}
            <span aria-hidden="true" style={{ margin: "0 0.35rem" }}>
              →
            </span>
            <span style={{ fontWeight: 600 }}>{formatValue(row.new)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

interface MergedField {
  key: string;
  previous: unknown;
  new: unknown;
}

function mergeFields(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): MergedField[] {
  const keys = new Set<string>();
  if (prev) for (const k of Object.keys(prev)) keys.add(k);
  if (next) for (const k of Object.keys(next)) keys.add(k);
  // n_number is on the new_registration payload but is redundant with
  // the tail header on the profile page — drop to keep the panel terse.
  keys.delete("n_number");
  return [...keys].map((key) => ({
    key,
    previous: prev?.[key] ?? null,
    new: next?.[key] ?? null,
  }));
}

function labelize(key: string): string {
  return key
    .split("_")
    .map((part) => (part.length ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length ? value : "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
