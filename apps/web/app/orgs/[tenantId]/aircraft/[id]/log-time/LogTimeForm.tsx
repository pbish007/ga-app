"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { pageShellStyles as s } from "../../../../../../lib/page-shell";

interface Props {
  tenantId: string;
  aircraftId: string;
  currentTt: number;
  registration: string;
}

interface MonotonicError {
  code: "not_monotonic";
  current_tt: number;
  new_reading: number;
}

export function LogTimeForm({
  tenantId,
  aircraftId,
  currentTt,
  registration,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monotonic, setMonotonic] = useState<MonotonicError | null>(null);

  async function submit(isOverride: boolean, overrideReason?: string) {
    setError(null);
    setMonotonic(null);
    setSubmitting(true);

    const ttInput = (
      document.getElementById("airframe_time_new") as HTMLInputElement | null
    )?.value;
    const airframeTimeNew = ttInput ? Number(ttInput) : NaN;
    if (!Number.isFinite(airframeTimeNew) || airframeTimeNew < 0) {
      setError("Enter a valid airframe total time.");
      setSubmitting(false);
      return;
    }

    const body: Record<string, unknown> = {
      airframe_time_new: airframeTimeNew,
      is_override: isOverride,
    };
    if (isOverride && overrideReason) {
      body.override_reason = overrideReason;
    }

    try {
      const res = await fetch(
        `/api/orgs/${tenantId}/aircraft/${aircraftId}/time-entries`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (res.status === 201) {
        router.push(`/orgs/${tenantId}/aircraft/${aircraftId}`);
        router.refresh();
        return;
      }
      const errBody = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        current_tt?: number;
        new_reading?: number;
      };
      if (errBody.code === "not_monotonic") {
        setMonotonic({
          code: "not_monotonic",
          current_tt: errBody.current_tt ?? currentTt,
          new_reading: errBody.new_reading ?? airframeTimeNew,
        });
      } else {
        setError(errBody.error ?? `Request failed (${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ marginTop: "1.5rem" }}>
      <label style={s.field}>
        <span style={s.label}>
          New airframe total time (hours)
        </span>
        <input
          id="airframe_time_new"
          type="number"
          step="0.1"
          min="0"
          defaultValue={currentTt}
          style={s.input}
          disabled={submitting}
        />
        <span style={{ fontSize: "0.85rem", color: "#666" }}>
          Current: {currentTt.toFixed(1)} h
        </span>
      </label>

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

      {monotonic ? (
        <OverridePanel
          monotonic={monotonic}
          submitting={submitting}
          onOverride={(reason) => submit(true, reason)}
          onCancel={() => setMonotonic(null)}
        />
      ) : (
        <div style={{ marginTop: "1.5rem" }}>
          <button
            type="button"
            style={s.button}
            disabled={submitting}
            onClick={() => submit(false)}
          >
            {submitting ? "Saving…" : `Log time for ${registration}`}
          </button>
        </div>
      )}
    </div>
  );
}

function OverridePanel({
  monotonic,
  submitting,
  onOverride,
  onCancel,
}: {
  monotonic: MonotonicError;
  submitting: boolean;
  onOverride: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const reasonTrimmed = reason.trim();

  return (
    <div
      style={{
        marginTop: "1rem",
        padding: "1rem",
        background: "#fffbeb",
        border: "1px solid #fcd34d",
        borderRadius: 6,
      }}
    >
      <p
        style={{ marginTop: 0, fontWeight: 600, color: "#92400e" }}
        role="alert"
      >
        Reading is lower than current airframe time
      </p>
      <p style={{ color: "#78350f", fontSize: "0.9rem", margin: "0.25rem 0 1rem" }}>
        You entered {monotonic.new_reading.toFixed(1)} h but the current reading
        is {monotonic.current_tt.toFixed(1)} h. This is only allowed for an
        instrument swap. Provide a reason to proceed.
      </p>

      <label style={s.field}>
        <span style={s.label}>Reason for instrument swap (required)</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Hobbs meter replaced S/N 12345 → 67890"
          style={s.input}
          disabled={submitting}
          autoFocus
        />
      </label>

      <div style={{ marginTop: "1rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          style={{
            ...s.button,
            background: reasonTrimmed ? "#d97706" : "#d1d5db",
            cursor: reasonTrimmed ? "pointer" : "not-allowed",
          }}
          disabled={submitting || !reasonTrimmed}
          onClick={() => onOverride(reasonTrimmed)}
        >
          {submitting ? "Saving…" : "Confirm instrument swap"}
        </button>
        <button
          type="button"
          style={{
            ...s.button,
            background: "white",
            color: "#374151",
            border: "1px solid #d1d5db",
          }}
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
