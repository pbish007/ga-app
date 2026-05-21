"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { pageShellStyles as s } from "../../../../../../../lib/page-shell";

const ENTRY_TYPE_OPTIONS: {
  value: string;
  label: string;
  hint: string;
}[] = [
  {
    value: "maintenance",
    label: "Maintenance",
    hint: "General maintenance, repairs, alterations.",
  },
  {
    value: "annual_inspection",
    label: "Annual inspection",
    hint: "FAR 91.409(a)(1) annual.",
  },
  {
    value: "100_hour_inspection",
    label: "100-hour inspection",
    hint: "FAR 91.409(b) 100-hour.",
  },
  {
    value: "inspection_program",
    label: "Inspection program",
    hint: "Manufacturer or operator program compliance.",
  },
  {
    value: "ad_compliance",
    label: "AD compliance",
    hint: "Airworthiness Directive compliance entry.",
  },
];

interface Props {
  tenantId: string;
  aircraftId: string;
  currentTt: number;
  registration: string;
}

function isoDateToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function NewEntryForm({
  tenantId,
  aircraftId,
  currentTt,
  registration,
}: Props) {
  const router = useRouter();
  const [entryType, setEntryType] = useState<string>("maintenance");
  const [workPerformed, setWorkPerformed] = useState("");
  const [performedOn, setPerformedOn] = useState(() => isoDateToday());
  const [airframeTime, setAirframeTime] = useState(() => currentTt.toFixed(1));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workTrimmed = workPerformed.trim();
  const canSubmit = workTrimmed.length > 0 && !submitting;

  async function submit() {
    setError(null);
    const att = Number(airframeTime);
    if (!Number.isFinite(att) || att < 0) {
      setError("Airframe total time must be a non-negative number.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/orgs/${tenantId}/aircraft/${aircraftId}/maintenance-entries`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            entry_type: entryType,
            work_performed: workTrimmed,
            performed_on: performedOn,
            aircraft_total_time: att,
          }),
        },
      );
      if (res.status === 201) {
        router.push(`/orgs/${tenantId}/aircraft/${aircraftId}/maintenance`);
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `Request failed (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        marginTop: "1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
        <legend style={{ ...s.label, marginBottom: "0.35rem" }}>Entry type</legend>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {ENTRY_TYPE_OPTIONS.map((opt) => {
            const selected = entryType === opt.value;
            return (
              <label
                key={opt.value}
                style={{
                  display: "flex",
                  gap: "0.6rem",
                  alignItems: "flex-start",
                  padding: "0.65rem 0.85rem",
                  minHeight: 44,
                  borderRadius: 6,
                  border: `1px solid ${selected ? "#2563eb" : "#d1d5db"}`,
                  background: selected ? "#eff6ff" : "white",
                  cursor: "pointer",
                  touchAction: "manipulation",
                }}
              >
                <input
                  type="radio"
                  name="entry_type"
                  value={opt.value}
                  checked={selected}
                  onChange={() => setEntryType(opt.value)}
                  disabled={submitting}
                  style={{ marginTop: 4 }}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <strong>{opt.label}</strong>
                  <span style={{ fontSize: "0.85rem", color: "#4b5563" }}>
                    {opt.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <label style={s.field}>
        <span style={s.label}>Work performed</span>
        <textarea
          value={workPerformed}
          onChange={(e) => setWorkPerformed(e.target.value)}
          rows={5}
          placeholder="e.g. Replaced left magneto, S/N 12345. Run-up checks normal."
          disabled={submitting}
          style={{
            ...s.input,
            minHeight: 120,
            fontFamily: "inherit",
            resize: "vertical",
          }}
          autoFocus
        />
      </label>

      <label style={s.field}>
        <span style={s.label}>Performed on</span>
        <input
          type="date"
          value={performedOn}
          onChange={(e) => setPerformedOn(e.target.value)}
          disabled={submitting}
          style={s.input}
        />
      </label>

      <label style={s.field}>
        <span style={s.label}>Airframe total time (hours)</span>
        <input
          type="number"
          step="0.1"
          min="0"
          value={airframeTime}
          onChange={(e) => setAirframeTime(e.target.value)}
          disabled={submitting}
          style={s.input}
        />
        <span style={{ fontSize: "0.85rem", color: "#666" }}>
          Current: {currentTt.toFixed(1)} h
        </span>
      </label>

      {error ? (
        <p
          role="alert"
          style={{
            color: "#b91c1c",
            background: "#fef2f2",
            padding: "0.75rem 1rem",
            borderRadius: 4,
            border: "1px solid #fecaca",
            margin: 0,
          }}
        >
          {error}
        </p>
      ) : null}

      <div>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          style={{
            ...s.button,
            background: canSubmit ? "#2563eb" : "#d1d5db",
            cursor: canSubmit ? "pointer" : "not-allowed",
            width: "100%",
          }}
        >
          {submitting ? "Saving draft…" : `Save draft for ${registration}`}
        </button>
        <p style={{ fontSize: "0.85rem", color: "#6b7280", marginTop: "0.5rem" }}>
          The entry is saved as an unsigned draft. Tap <strong>Sign entry</strong>{" "}
          on the maintenance log to finalise it; sign-off requires a credential
          authorised under this aircraft&rsquo;s regime.
        </p>
      </div>
    </div>
  );
}
