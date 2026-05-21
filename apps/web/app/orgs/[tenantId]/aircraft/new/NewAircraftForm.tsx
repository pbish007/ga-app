"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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

export function NewAircraftForm({ tenantId }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      style={{ marginTop: "1.5rem" }}
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSubmitting(true);
        const formData = new FormData(e.currentTarget);
        const body: Record<string, unknown> = {
          registration: formData.get("registration"),
          make: formData.get("make"),
          model: formData.get("model"),
          serial_number: formData.get("serial_number"),
          category: formData.get("category"),
          aircraft_class: formData.get("aircraft_class"),
          time_source: formData.get("time_source"),
        };
        const yr = String(formData.get("year_manufactured") ?? "").trim();
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
      <div style={fieldRowStyle}>
        <label style={s.field}>
          <span style={s.label}>Registration (N-number)</span>
          <input
            name="registration"
            required
            style={s.input}
            placeholder="N12345"
            autoComplete="off"
          />
        </label>
        <label style={s.field}>
          <span style={s.label}>Make</span>
          <input name="make" required style={s.input} placeholder="Cessna" />
        </label>
        <label style={s.field}>
          <span style={s.label}>Model</span>
          <input name="model" required style={s.input} placeholder="172N" />
        </label>
        <label style={s.field}>
          <span style={s.label}>Serial number</span>
          <input
            name="serial_number"
            required
            style={s.input}
            placeholder="17270001"
          />
        </label>
        <label style={s.field}>
          <span style={s.label}>Year manufactured (optional)</span>
          <input
            name="year_manufactured"
            type="number"
            min="1900"
            max="2100"
            style={s.input}
          />
        </label>
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
          <select name="time_source" required style={s.input} defaultValue="hobbs">
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
