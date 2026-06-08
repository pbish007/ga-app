"use client";

import { useEffect, useRef, useState } from "react";

import type { FaaFieldKey } from "@ga/db";

/**
 * Wire shape returned by `GET /api/orgs/{tenantId}/faa/aircraft/{nNumber}`.
 * Mirrors the lookup-handler contract from PMB-109 PR-35; kept FE-side
 * to avoid leaking the postgres-js types from the server modules into
 * the client bundle.
 */
export interface FaaLookupValue {
  n_number: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  year_manufactured: number | null;
  engine_make: string | null;
  engine_model: string | null;
  owner_name: string | null;
  expiration_date: string | null;
  airworthiness_date: string | null;
  cert_issue_date: string | null;
  status_code: string | null;
}

export interface FaaFreshness {
  snapshot_date: string | null;
  pg_loaded_at: string | null;
}

export type FaaLookupResponse =
  | { kind: "match"; value: FaaLookupValue; freshness: FaaFreshness }
  | { kind: "no_match"; n_number: string; freshness: FaaFreshness }
  | {
      kind: "lookup_unavailable";
      n_number: string;
      error_kind: "timeout" | "server_error" | "rate_limited";
      message?: string;
    };

export type FaaLookupStatus =
  | { kind: "idle" }
  | { kind: "loading"; nNumber: string }
  | { kind: "loaded"; response: FaaLookupResponse };

/**
 * Maps the form's user-typed registration into the canonical N-number
 * shape that the lookup endpoint accepts (1–5 alnum, no leading 'N').
 * Returns null when the input is not yet a valid query.
 */
export function normalizeForLookup(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.length === 0) return null;
  const noPrefix = trimmed.startsWith("N") ? trimmed.slice(1) : trimmed;
  if (!/^[A-Z0-9]{1,5}$/.test(noPrefix)) return null;
  return noPrefix;
}

/** Field keys whose strings can be derived from a lookup value. */
export const PREFILL_FIELDS: ReadonlyArray<FaaFieldKey> = [
  "make",
  "model",
  "serial_number",
  "year_manufactured",
  "owner_name",
  "expiration_date",
];

/**
 * Pull the string FAA value for a given field. `year_manufactured` is a
 * number on the wire; we serialize it back to a string for the chip,
 * which only cares about display + hash equality.
 */
export function faaValueFor(
  value: FaaLookupValue,
  field: FaaFieldKey,
): string | null {
  switch (field) {
    case "make":
      return value.make;
    case "model":
      return value.model;
    case "serial_number":
      return value.serial_number;
    case "year_manufactured":
      return value.year_manufactured == null
        ? null
        : String(value.year_manufactured);
    case "owner_name":
      return value.owner_name;
    case "expiration_date":
      return value.expiration_date;
  }
}

interface UseFaaLookupOptions {
  tenantId: string;
  /** Raw user input (e.g. "N12345"). */
  rawNNumber: string;
  /** Debounce in ms before the request fires. */
  debounceMs?: number;
}

interface UseFaaLookupResult {
  status: FaaLookupStatus;
  /** Force a lookup of the current input now (Retry button). */
  retry: () => void;
}

/**
 * Debounced FAA-Registry lookup hook. Fires `/api/orgs/{tenantId}/faa/aircraft/{nNumber}`
 * once typing settles. Handles 200/match, 200/no_match, and 503/lookup_unavailable
 * uniformly so the form can render a `FaaFieldState` per the ux-pattern doc.
 */
export function useFaaLookup({
  tenantId,
  rawNNumber,
  debounceMs = 350,
}: UseFaaLookupOptions): UseFaaLookupResult {
  const [status, setStatus] = useState<FaaLookupStatus>({ kind: "idle" });
  const requestSeq = useRef(0);
  const [forceTick, setForceTick] = useState(0);

  const normalized = normalizeForLookup(rawNNumber);

  useEffect(() => {
    if (!normalized) {
      setStatus({ kind: "idle" });
      return;
    }
    const seq = ++requestSeq.current;
    const timer = window.setTimeout(() => {
      void runLookup(seq);
    }, debounceMs);
    return () => window.clearTimeout(timer);

    async function runLookup(thisSeq: number) {
      setStatus({ kind: "loading", nNumber: normalized! });
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(tenantId)}/faa/aircraft/${encodeURIComponent(normalized!)}`,
          {
            method: "GET",
            headers: {
              accept: "application/json",
              "x-tenant-id": tenantId,
            },
          },
        );
        if (thisSeq !== requestSeq.current) return;
        const body = (await res.json().catch(() => null)) as
          | FaaLookupResponse
          | { error?: string }
          | null;
        if (
          res.ok &&
          body &&
          "kind" in body &&
          (body.kind === "match" || body.kind === "no_match")
        ) {
          setStatus({ kind: "loaded", response: body });
          return;
        }
        if (res.status === 503 && body && "kind" in body && body.kind === "lookup_unavailable") {
          setStatus({ kind: "loaded", response: body });
          return;
        }
        setStatus({
          kind: "loaded",
          response: {
            kind: "lookup_unavailable",
            n_number: normalized!,
            error_kind: "server_error",
            message:
              body && "error" in body && typeof body.error === "string"
                ? body.error
                : `Unexpected ${res.status}`,
          },
        });
      } catch (err) {
        if (thisSeq !== requestSeq.current) return;
        setStatus({
          kind: "loaded",
          response: {
            kind: "lookup_unavailable",
            n_number: normalized!,
            error_kind: "server_error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    // forceTick is a dependency on purpose — Retry bumps it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, normalized, debounceMs, forceTick]);

  return {
    status,
    retry: () => setForceTick((t) => t + 1),
  };
}
