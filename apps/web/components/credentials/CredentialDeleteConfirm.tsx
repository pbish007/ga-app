"use client";

import { useEffect, useId, useState, type CSSProperties } from "react";

import { colorTokens, pageShellStyles as s } from "../../lib/page-shell";

import { ModalShell } from "./ModalShell";
import type { CredentialDto } from "./types";

interface Props {
  open: boolean;
  onClose: () => void;
  onDeleted: (credential: CredentialDto) => void;
  tenantId: string;
  credential: CredentialDto | null;
  typeName: string;
  userDisplayName: string;
}

const header: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "1rem",
  borderBottom: `1px solid ${colorTokens.cardBorder}`,
};

const closeButton: CSSProperties = {
  background: "transparent",
  border: "none",
  fontSize: "1.5rem",
  cursor: "pointer",
  padding: "0.25rem 0.5rem",
  minHeight: 44,
  minWidth: 44,
  color: "#6b7280",
};

const footer: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  padding: "1rem",
  borderTop: `1px solid ${colorTokens.cardBorder}`,
  flexWrap: "wrap",
};

const ghostButton: CSSProperties = {
  ...s.button,
  background: "white",
  color: "#374151",
  border: "1px solid #d1d5db",
};

const dangerButton: CSSProperties = {
  ...s.button,
  background: colorTokens.danger,
  color: "white",
};

export function CredentialDeleteConfirm({
  open,
  onClose,
  onDeleted,
  tenantId,
  credential,
  typeName,
  userDisplayName,
}: Props) {
  const titleId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  async function handleDelete() {
    if (!credential) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/orgs/${tenantId}/credentials/${credential.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(data.error ?? `Request failed (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { credential: CredentialDto };
      onDeleted(data.credential);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      titleId={titleId}
      testId="credential-delete-confirm"
    >
      <div style={header}>
        <h2 id={titleId} style={{ margin: 0, fontSize: "1.1rem" }}>
          Delete certificate?
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={closeButton}
          disabled={submitting}
        >
          ×
        </button>
      </div>
      <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <p style={{ margin: 0 }}>
          This will remove the {typeName} record for {userDisplayName}.
        </p>
        <p
          role="note"
          style={{
            margin: 0,
            padding: "0.75rem",
            background: colorTokens.warningBg,
            border: `1px solid ${colorTokens.warning}`,
            borderRadius: 6,
            color: "#78350f",
            fontSize: "0.9rem",
          }}
        >
          ⚠ Signed maintenance entries that reference this certificate will
          not be changed — the record is preserved for audit purposes.
        </p>
        {error ? (
          <p
            role="alert"
            style={{
              margin: 0,
              color: colorTokens.danger,
              background: colorTokens.dangerBg,
              padding: "0.5rem 0.75rem",
              borderRadius: 4,
              border: `1px solid ${colorTokens.danger}`,
              fontSize: "0.9rem",
            }}
            data-testid="credential-delete-error"
          >
            {error}
          </p>
        ) : null}
      </div>
      <div style={footer}>
        <button
          type="button"
          onClick={onClose}
          style={ghostButton}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleDelete}
          style={dangerButton}
          disabled={submitting || !credential}
          aria-label={`Delete ${typeName} for ${userDisplayName}`}
          data-testid="credential-delete-confirm-button"
        >
          {submitting ? "Deleting…" : "Delete certificate"}
        </button>
      </div>
    </ModalShell>
  );
}
