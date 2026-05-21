"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { pageShellStyles as s } from "../../../../../../lib/page-shell";

interface Props {
  tenantId: string;
  entryId: string;
}

export function SignEntryButton({ tenantId, entryId }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function sign() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/orgs/${tenantId}/maintenance-entries/${entryId}/sign`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (res.ok) {
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (res.status === 403 && body.code === "not_authorised_to_sign") {
        setError(
          "Your account does not hold a credential authorising sign-off for this aircraft's regime.",
        );
      } else if (res.status === 409 && body.code === "already_signed") {
        setError("Entry is already signed.");
        router.refresh();
      } else {
        setError(body.error ?? `Request failed (${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          alignItems: "stretch",
        }}
      >
        <button
          type="button"
          onClick={sign}
          disabled={submitting}
          style={{ ...s.button, background: "#059669", flex: "1 1 12rem" }}
        >
          {submitting ? "Signing…" : "Confirm sign-off"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={submitting}
          style={{
            ...s.button,
            background: "white",
            color: "#374151",
            border: "1px solid #d1d5db",
            flex: "0 0 auto",
          }}
        >
          Cancel
        </button>
        {error ? (
          <p
            role="alert"
            style={{
              flex: "1 1 100%",
              margin: 0,
              color: "#b91c1c",
              background: "#fef2f2",
              padding: "0.5rem 0.75rem",
              borderRadius: 4,
              border: "1px solid #fecaca",
              fontSize: "0.9rem",
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={submitting}
        style={{ ...s.button, background: "#059669", width: "100%" }}
      >
        Sign entry
      </button>
      {error ? (
        <p
          role="alert"
          style={{
            marginTop: "0.5rem",
            color: "#b91c1c",
            background: "#fef2f2",
            padding: "0.5rem 0.75rem",
            borderRadius: 4,
            border: "1px solid #fecaca",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
