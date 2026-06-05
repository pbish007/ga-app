import type { CSSProperties } from "react";

import { colorTokens } from "../../lib/page-shell";
import {
  daysUntilExpiry,
  getCredentialState,
  type CredentialState,
} from "../../lib/credential-state";

import { CredentialStatusBadge } from "./CredentialStatusBadge";

export interface SignoffCredentialView {
  userDisplayName: string;
  typeName: string;
  certificateNumber: string | null;
  ratings: string[];
  expiresOn: string | null;
  revokedAt: string | null;
}

interface Props {
  credential: SignoffCredentialView;
}

const card: CSSProperties = {
  background: "#f9fafb",
  borderRadius: 6,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  border: `1px solid ${colorTokens.cardBorder}`,
};

const row1: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const secondary: CSSProperties = {
  fontSize: "0.9rem",
  color: "#374151",
  wordBreak: "break-all",
};

export function SignoffCredentialCard({ credential }: Props) {
  const state: CredentialState = getCredentialState({
    expiresOn: credential.expiresOn,
    revokedAt: credential.revokedAt,
  });
  const days = daysUntilExpiry(credential.expiresOn);
  const ratings = credential.ratings.length
    ? credential.ratings.join(" · ")
    : null;

  return (
    <div style={card} data-testid="signoff-credential-card" data-state={state}>
      <div style={row1}>
        <strong style={{ fontSize: "0.95rem" }}>
          Signing as {credential.userDisplayName}
        </strong>
        <CredentialStatusBadge state={state} daysRemaining={days} />
      </div>
      <div style={secondary}>
        {credential.typeName}
        {credential.certificateNumber
          ? ` · No. ${credential.certificateNumber}`
          : ""}
      </div>
      {ratings ? (
        <div style={{ ...secondary, color: "#6b7280" }}>{ratings}</div>
      ) : null}
    </div>
  );
}
