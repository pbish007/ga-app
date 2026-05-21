"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { pageShellStyles as s } from "../../../../../../lib/page-shell";

interface Props {
  tenantId: string;
  squawkId: string;
}

export function ResolveSquawkButton({ tenantId, squawkId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/orgs/${tenantId}/squawks/${squawkId}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resolution_notes: notes.trim() || null }),
        },
      );
      if (res.ok) {
        setOpen(false);
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

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          ...s.button,
          background: "#059669",
          padding: "0.45rem 0.85rem",
          minHeight: 36,
          fontSize: "0.9rem",
        }}
      >
        Resolve
      </button>
    );
  }

  return (
    <div
      style={{
        marginTop: "0.5rem",
        padding: "0.75rem",
        border: "1px solid #d1fae5",
        background: "#ecfdf5",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <label style={s.field}>
        <span style={{ ...s.label, fontSize: "0.85rem" }}>
          Resolution notes (optional)
        </span>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={submitting}
          placeholder="e.g. Replaced pitot tube; ops check OK"
          style={s.input}
        />
      </label>
      {error ? (
        <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: "0.85rem" }}>
          {error}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          style={{
            ...s.button,
            background: "#059669",
            padding: "0.45rem 0.85rem",
            minHeight: 36,
            fontSize: "0.9rem",
          }}
        >
          {submitting ? "Saving…" : "Confirm resolve"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={submitting}
          style={{
            ...s.button,
            background: "white",
            color: "#374151",
            border: "1px solid #d1d5db",
            padding: "0.45rem 0.85rem",
            minHeight: 36,
            fontSize: "0.9rem",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
