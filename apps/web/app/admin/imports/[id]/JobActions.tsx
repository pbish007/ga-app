"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { pageShellStyles as s } from "../../../../lib/page-shell";

interface Props {
  jobId: string;
  canRevalidate: boolean;
  canCommit: boolean;
}

export function JobActions({ jobId, canRevalidate, canCommit }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function call(path: string, label: string) {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch(path, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        state?: string;
        message?: string;
        rowsCommitted?: number;
        counts?: { valid?: number; invalid?: number; total?: number };
      };
      if (!res.ok) {
        setErr(
          `${label} failed (${res.status}): ${body.message ?? "unknown error"}`,
        );
      } else if (label === "Commit") {
        setMsg(
          `Committed ${body.rowsCommitted ?? 0} row(s). Refreshing…`,
        );
        router.refresh();
      } else {
        setMsg(
          `Validation finished — ${body.counts?.valid ?? 0} valid, ${
            body.counts?.invalid ?? 0
          } invalid. Refreshing…`,
        );
        router.refresh();
      }
    } catch (e) {
      setErr(
        `Network error: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        marginTop: "0.5rem",
      }}
    >
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={!canRevalidate || busy}
          onClick={() => call(`/api/admin/imports/${jobId}/parse`, "Re-validate")}
          style={{
            ...s.button,
            background: !canRevalidate || busy ? "#9db8f0" : "#2563eb",
            cursor: !canRevalidate || busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Working…" : "Re-validate"}
        </button>
        <button
          type="button"
          disabled={!canCommit || busy}
          onClick={() => call(`/api/admin/imports/${jobId}/commit`, "Commit")}
          style={{
            ...s.button,
            background: !canCommit || busy ? "#9db8f0" : "#059669",
            cursor: !canCommit || busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Working…" : "Commit"}
        </button>
      </div>
      {msg && (
        <p
          role="status"
          style={{
            margin: 0,
            color: "#065f46",
            background: "#ecfdf5",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            border: "1px solid #6ee7b7",
            fontSize: "0.9rem",
          }}
        >
          {msg}
        </p>
      )}
      {err && (
        <p
          role="alert"
          style={{
            margin: 0,
            color: "#b91c1c",
            background: "#fef2f2",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            border: "1px solid #fecaca",
            fontSize: "0.9rem",
          }}
        >
          {err}
        </p>
      )}
    </div>
  );
}
