"use client";

import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

import { pageShellStyles as s } from "../../../../lib/page-shell";

interface Props {
  tenantId: string;
  enabled: boolean;
  disabledReason?: string;
}

const dangerButton: CSSProperties = {
  ...s.button,
  background: "#b91c1c",
};

const modalBackdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1rem",
  zIndex: 50,
};

const modalCard: CSSProperties = {
  background: "white",
  borderRadius: 8,
  padding: "1.5rem",
  maxWidth: 460,
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
};

const errorBox: CSSProperties = {
  margin: 0,
  color: "#b91c1c",
  background: "#fef2f2",
  padding: "0.65rem 0.85rem",
  borderRadius: 6,
  border: "1px solid #fecaca",
  fontSize: "0.9rem",
};

const successBox: CSSProperties = {
  margin: 0,
  background: "#ecfdf5",
  border: "1px solid #6ee7b7",
  color: "#065f46",
  padding: "0.65rem 0.85rem",
  borderRadius: 6,
  fontSize: "0.9rem",
};

export function ReseedDemoButton({ tenantId, enabled, disabledReason }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function confirm() {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/reseed-demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
        aircraftId?: string;
        seededAt?: string;
      };
      if (!res.ok) {
        setError(body.message ?? `Reseed failed (${res.status}).`);
        setSubmitting(false);
        return;
      }
      setSuccess(
        `Demo content reseeded. Aircraft id ${body.aircraftId ?? "(unknown)"}.`,
      );
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  function close() {
    if (submitting) return;
    setOpen(false);
    setError(null);
    setSuccess(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!enabled}
        style={{
          ...dangerButton,
          background: enabled ? "#b91c1c" : "#9ca3af",
          cursor: enabled ? "pointer" : "not-allowed",
        }}
        title={enabled ? "Reseed the demo content for this tenant" : disabledReason}
      >
        Reseed demo content
      </button>
      {!enabled && disabledReason ? (
        <span style={{ fontSize: "0.8rem", color: "#666" }}>
          {disabledReason}
        </span>
      ) : null}
      {success ? <p style={successBox}>{success}</p> : null}
      {error && !open ? <p style={errorBox}>{error}</p> : null}

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reseed-title"
          style={modalBackdrop}
          onClick={close}
        >
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h2 id="reseed-title" style={{ margin: 0, fontSize: "1.15rem" }}>
              Reseed demo content?
            </h2>
            <p style={{ margin: 0, fontSize: "0.95rem", lineHeight: 1.5 }}>
              This <strong>deletes the existing demo aircraft</strong> for this
              tenant — including its inspection subscriptions, flight time
              entries, open squawks, and draft maintenance entries — and
              re-inserts the canonical demo aircraft.
            </p>
            <p style={{ margin: 0, fontSize: "0.9rem", color: "#666" }}>
              The action is recorded in the tenant provisioning audit log.
            </p>
            {error ? <p style={errorBox}>{error}</p> : null}
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                style={{
                  ...s.button,
                  background: "#f3f4f6",
                  color: "#111827",
                  border: "1px solid #d1d5db",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={submitting}
                style={{
                  ...dangerButton,
                  background: submitting ? "#9ca3af" : "#b91c1c",
                  cursor: submitting ? "not-allowed" : "pointer",
                }}
              >
                {submitting ? "Reseeding…" : "Yes, reseed demo content"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
