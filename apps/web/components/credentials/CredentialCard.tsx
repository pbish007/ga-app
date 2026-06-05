"use client";

import type { CSSProperties } from "react";

import { colorTokens, pageShellStyles as s } from "../../lib/page-shell";
import {
  daysUntilExpiry,
  getCredentialState,
} from "../../lib/credential-state";

import { CredentialStatusBadge } from "./CredentialStatusBadge";
import type { CredentialDto } from "./types";

interface Props {
  credential: CredentialDto;
  typeName: string;
  userDisplayName: string;
  onEdit: () => void;
  onDelete: () => void;
}

const cardBase: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  border: `1px solid ${colorTokens.cardBorder}`,
  borderRadius: 6,
  padding: 16,
  background: "white",
};

const headerRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const footerRow: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginTop: "0.5rem",
  flexWrap: "wrap",
};

const ghostButton: CSSProperties = {
  ...s.button,
  background: "white",
  color: "#374151",
  border: "1px solid #d1d5db",
};

const dangerGhostButton: CSSProperties = {
  ...s.button,
  background: "white",
  color: colorTokens.danger,
  border: `1px solid ${colorTokens.danger}`,
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return value;
}

export function CredentialCard({
  credential,
  typeName,
  userDisplayName,
  onEdit,
  onDelete,
}: Props) {
  const state = getCredentialState({
    expiresOn: credential.expires_on,
    revokedAt: credential.revoked_at,
  });
  const days = daysUntilExpiry(credential.expires_on);
  const variantStyle: CSSProperties =
    state === "expired" || state === "revoked"
      ? {
          borderColor: colorTokens.danger,
          borderLeft: `4px solid ${colorTokens.danger}`,
        }
      : state === "expiring"
      ? {
          borderColor: colorTokens.warning,
          borderLeft: `4px solid ${colorTokens.warning}`,
        }
      : {};

  const ratings = credential.ratings.length
    ? credential.ratings.join(" · ")
    : null;

  return (
    <article
      style={{ ...cardBase, ...variantStyle }}
      data-testid="credential-card"
      data-state={state}
    >
      <div style={headerRow}>
        <h3
          style={{
            margin: 0,
            fontSize: "1rem",
            fontWeight: 600,
          }}
        >
          {typeName}
        </h3>
        <CredentialStatusBadge state={state} daysRemaining={days} />
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "0.25rem 0.75rem",
          margin: 0,
          fontSize: "0.9rem",
        }}
      >
        <dt style={{ color: "#6b7280" }}>Cert no</dt>
        <dd
          style={{
            margin: 0,
            wordBreak: "break-all",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {credential.certificate_number ?? "—"}
        </dd>
        {ratings ? (
          <>
            <dt style={{ color: "#6b7280" }}>Ratings</dt>
            <dd style={{ margin: 0 }}>{ratings}</dd>
          </>
        ) : null}
        <dt style={{ color: "#6b7280" }}>Issued</dt>
        <dd style={{ margin: 0 }}>{formatDate(credential.issued_on)}</dd>
        <dt style={{ color: "#6b7280" }}>Expires</dt>
        <dd style={{ margin: 0 }}>
          {credential.expires_on
            ? credential.expires_on
            : "No expiration"}
        </dd>
        {state === "expiring" && days !== null ? (
          <>
            <dt style={{ color: "#6b7280" }}>Remaining</dt>
            <dd style={{ margin: 0, color: colorTokens.warning }}>
              {days} day{days === 1 ? "" : "s"}
            </dd>
          </>
        ) : null}
      </dl>
      <div style={footerRow}>
        <button
          type="button"
          onClick={onEdit}
          style={ghostButton}
          data-testid="credential-card-edit"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          style={dangerGhostButton}
          aria-label={`Delete ${typeName} for ${userDisplayName}`}
          data-testid="credential-card-delete"
        >
          Delete
        </button>
      </div>
    </article>
  );
}
