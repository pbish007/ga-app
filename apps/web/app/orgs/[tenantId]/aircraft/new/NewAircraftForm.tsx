"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type { FaaFieldKey } from "@ga/db";

import { FaaFreshnessPill } from "../../../../../components/faa/FaaFreshnessPill";
import { FaaLookupBanner } from "../../../../../components/faa/FaaLookupBanner";
import { FaaSearchCombobox } from "../../../../../components/faa/FaaSearchCombobox";
import { SourceConflictChip } from "../../../../../components/faa/SourceConflictChip";
import type {
  FaaFieldReportReason,
  FaaFieldState,
} from "../../../../../components/faa/types";
import {
  faaValueFor,
  useFaaLookup,
} from "../../../../../components/faa/use-faa-lookup";
import { pageShellStyles as s } from "../../../../../lib/page-shell";

interface Props {
  tenantId: string;
}

const fieldRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "1rem",
  marginTop: "1rem",
};

type PrefillKey = Extract<
  FaaFieldKey,
  "make" | "model" | "serial_number" | "year_manufactured"
>;

const PREFILL_KEYS: ReadonlyArray<PrefillKey> = [
  "make",
  "model",
  "serial_number",
  "year_manufactured",
];

interface FieldLabel {
  key: PrefillKey;
  label: string;
}

const FIELD_LABELS: ReadonlyArray<FieldLabel> = [
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "serial_number", label: "Serial number" },
  { key: "year_manufactured", label: "Year manufactured" },
];

function labelFor(key: PrefillKey): string {
  return FIELD_LABELS.find((f) => f.key === key)?.label ?? key;
}

/** Local chip state — on the new form decisions don't persist, they
 * only drive whether the form takes the FAA value or the tenant value
 * on submit. The chip still renders the full state machine so the
 * operator sees the same UX as on edit. */
type LocalDecision =
  | { kind: "pending" }
  | { kind: "accepted_faa" }
  | { kind: "tenant_wins" }
  | { kind: "faa_reported_wrong"; reason: FaaFieldReportReason };

export function NewAircraftForm({ tenantId }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tenant-side input state — we control these so chip actions can
  // overwrite or restore them per the user's decision.
  const [registration, setRegistration] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [yearManufactured, setYearManufactured] = useState("");

  const inputsByKey: Record<PrefillKey, { value: string; set: (v: string) => void }> = {
    make: { value: make, set: setMake },
    model: { value: model, set: setModel },
    serial_number: { value: serialNumber, set: setSerialNumber },
    year_manufactured: { value: yearManufactured, set: setYearManufactured },
  };

  const [decisions, setDecisions] = useState<Record<PrefillKey, LocalDecision>>({
    make: { kind: "pending" },
    model: { kind: "pending" },
    serial_number: { kind: "pending" },
    year_manufactured: { kind: "pending" },
  });

  const { status: lookupStatus, retry } = useFaaLookup({
    tenantId,
    rawNNumber: registration,
  });

  // Prefill empty fields when a match arrives. Never overwrites a
  // user-typed value — that path goes through the conflict chip.
  useEffect(() => {
    if (lookupStatus.kind !== "loaded") return;
    if (lookupStatus.response.kind !== "match") return;
    const match = lookupStatus.response;
    for (const key of PREFILL_KEYS) {
      if (decisions[key].kind !== "pending") continue;
      const tenant = inputsByKey[key].value.trim();
      if (tenant.length > 0) continue;
      const faa = faaValueFor(match.value, key);
      if (faa != null) inputsByKey[key].set(faa);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupStatus]);

  const fieldStates = useMemo(() => {
    return PREFILL_KEYS.map((key) => ({
      key,
      state: deriveFieldState(key, lookupStatus, inputsByKey[key].value, decisions[key]),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupStatus, make, model, serialNumber, yearManufactured, decisions]);

  const freshness =
    lookupStatus.kind === "loaded" &&
    (lookupStatus.response.kind === "match" ||
      lookupStatus.response.kind === "no_match")
      ? lookupStatus.response.freshness
      : null;

  return (
    <form
      style={{ marginTop: "1.5rem" }}
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSubmitting(true);
        const formData = new FormData(e.currentTarget);
        const body: Record<string, unknown> = {
          registration: registration.trim(),
          make: make.trim(),
          model: model.trim(),
          serial_number: serialNumber.trim(),
          category: formData.get("category"),
          aircraft_class: formData.get("aircraft_class"),
          time_source: formData.get("time_source"),
        };
        const yr = yearManufactured.trim();
        if (yr) body.year_manufactured = Number(yr);
        const tt = String(formData.get("airframe_total_time") ?? "").trim();
        if (tt) body.airframe_total_time = Number(tt);

        try {
          const res = await fetch(`/api/orgs/${tenantId}/aircraft`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-tenant-id": tenantId,
            },
            body: JSON.stringify(body),
          });
          if (res.status === 201) {
            const created = (await res.json()) as { id: string };
            router.push(`/orgs/${tenantId}/aircraft/${created.id}`);
            router.refresh();
            return;
          }
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(errBody.error ?? `Request failed (${res.status})`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      {freshness ? (
        <p style={{ marginTop: "0.5rem" }}>
          <FaaFreshnessPill pgLoadedAt={freshness.pg_loaded_at} />
        </p>
      ) : null}

      <div style={fieldRowStyle}>
        <div style={s.field}>
          <label htmlFor="aircraft-registration" style={s.label}>
            Registration (N-number)
          </label>
          <FaaSearchCombobox
            tenantId={tenantId}
            value={registration}
            onChange={setRegistration}
            onSelect={(picked) => setRegistration(picked.n_number)}
            id="aircraft-registration"
            name="registration"
            required
            placeholder="N12345"
          />
          {lookupStatus.kind === "loaded" &&
          lookupStatus.response.kind !== "match" ? (
            <FaaLookupBanner response={lookupStatus.response} onRetry={retry} />
          ) : null}
        </div>

        {FIELD_LABELS.map(({ key, label }) => (
          <label key={key} style={s.field}>
            <span style={s.label}>{label}</span>
            <input
              name={key}
              required={key !== "year_manufactured"}
              type={key === "year_manufactured" ? "number" : "text"}
              min={key === "year_manufactured" ? 1900 : undefined}
              max={key === "year_manufactured" ? 2100 : undefined}
              style={s.input}
              value={inputsByKey[key].value}
              onChange={(e) => {
                inputsByKey[key].set(e.target.value);
                if (decisions[key].kind !== "pending") {
                  setDecisions((prev) => ({ ...prev, [key]: { kind: "pending" } }));
                }
              }}
            />
            <SourceConflictChip
              sourceName="FAA Registry"
              fieldLabel={label}
              state={fieldStates.find((f) => f.key === key)!.state}
              onAccept={() => {
                const faa = currentFaaValue(lookupStatus, key);
                if (faa != null) inputsByKey[key].set(faa);
                setDecisions((prev) => ({ ...prev, [key]: { kind: "accepted_faa" } }));
              }}
              onDecline={() => {
                setDecisions((prev) => ({ ...prev, [key]: { kind: "tenant_wins" } }));
              }}
              onReport={async ({ reason }) => {
                setDecisions((prev) => ({
                  ...prev,
                  [key]: { kind: "faa_reported_wrong", reason },
                }));
              }}
              onReopen={() =>
                setDecisions((prev) => ({ ...prev, [key]: { kind: "pending" } }))
              }
            />
          </label>
        ))}

        <label style={s.field}>
          <span style={s.label}>Category</span>
          <input
            name="category"
            required
            style={s.input}
            placeholder="normal"
          />
        </label>
        <label style={s.field}>
          <span style={s.label}>Class</span>
          <input
            name="aircraft_class"
            required
            style={s.input}
            placeholder="single_engine_land"
          />
        </label>
        <label style={s.field}>
          <span style={s.label}>Time source</span>
          <select name="time_source" required style={s.select} defaultValue="hobbs">
            <option value="hobbs">Hobbs</option>
            <option value="tach">Tach</option>
          </select>
        </label>
        <label style={s.field}>
          <span style={s.label}>Airframe total time (hours)</span>
          <input
            name="airframe_total_time"
            type="number"
            step="0.1"
            min="0"
            defaultValue="0"
            style={s.input}
          />
        </label>
      </div>

      {error ? (
        <p
          role="alert"
          style={{
            marginTop: "1rem",
            color: "#b91c1c",
            background: "#fef2f2",
            padding: "0.75rem 1rem",
            borderRadius: 4,
            border: "1px solid #fecaca",
          }}
        >
          {error}
        </p>
      ) : null}

      <div style={{ marginTop: "1.5rem" }}>
        <button type="submit" style={s.button} disabled={submitting}>
          {submitting ? "Creating…" : "Create aircraft"}
        </button>
      </div>
    </form>
  );
}

function currentFaaValue(
  status: ReturnType<typeof useFaaLookup>["status"],
  key: PrefillKey,
): string | null {
  if (status.kind !== "loaded" || status.response.kind !== "match") return null;
  return faaValueFor(status.response.value, key);
}

function deriveFieldState(
  key: PrefillKey,
  status: ReturnType<typeof useFaaLookup>["status"],
  tenantValue: string,
  decision: LocalDecision,
): FaaFieldState {
  if (status.kind === "loading") return { kind: "loading" };
  if (status.kind === "idle") return { kind: "no_faa_data" };
  if (status.response.kind === "no_match") return { kind: "no_faa_data" };
  if (status.response.kind === "lookup_unavailable") {
    return {
      kind: "faa_lookup_error",
      errorKind: status.response.error_kind,
    };
  }

  const faaValue = faaValueFor(status.response.value, key);
  if (faaValue == null) return { kind: "no_faa_data" };
  const syncedAt = status.response.freshness.pg_loaded_at ?? "";

  if (decision.kind === "accepted_faa") {
    return {
      kind: "accepted_faa",
      faaValue,
      acceptedAt: new Date().toISOString(),
      acceptedByUserId: "(you)",
    };
  }
  if (decision.kind === "tenant_wins") {
    return {
      kind: "tenant_wins",
      tenantValue,
      lastDeclinedFaaValueHash: hashStringDjb2(faaValue),
      decidedAt: new Date().toISOString(),
      decidedByUserId: "(you)",
    };
  }
  if (decision.kind === "faa_reported_wrong") {
    return {
      kind: "faa_reported_wrong",
      tenantValue,
      reportedReason: decision.reason,
      reportedAt: new Date().toISOString(),
      reportedByUserId: "(you)",
    };
  }

  // pending — derive aligned vs conflict from current tenant input
  const tenant = tenantValue.trim();
  if (tenant.length === 0) {
    // pre-fill if empty
    return { kind: "aligned", faaValue, lastSyncedAt: syncedAt };
  }
  if (tenant === faaValue) {
    return { kind: "aligned", faaValue, lastSyncedAt: syncedAt };
  }
  return {
    kind: "conflict",
    faaValue,
    tenantValue: tenant,
    lastSyncedAt: syncedAt,
  };
}

/** Cheap stable hash for local-only "I declined this FAA value" state. */
function hashStringDjb2(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
