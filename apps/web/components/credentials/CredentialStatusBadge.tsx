import type { CSSProperties } from "react";

import { colorTokens } from "../../lib/page-shell";
import {
  badgeLabel,
  type CredentialState,
} from "../../lib/credential-state";

interface Props {
  state: CredentialState;
  daysRemaining?: number | null;
}

const baseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 4,
  padding: "2px 8px",
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

function styleFor(state: CredentialState): CSSProperties {
  switch (state) {
    case "current":
      return { background: colorTokens.successBg, color: colorTokens.success };
    case "expiring":
      return { background: colorTokens.warningBg, color: colorTokens.warning };
    case "expired":
    case "revoked":
      return { background: colorTokens.dangerBg, color: colorTokens.danger };
    case "none":
      return { background: "#f3f4f6", color: "#6b7280" };
  }
}

export function CredentialStatusBadge({ state, daysRemaining = null }: Props) {
  const label = badgeLabel(state, daysRemaining);
  return (
    <span
      style={{ ...baseStyle, ...styleFor(state) }}
      aria-label={`Status: ${label}`}
      data-testid="credential-status-badge"
      data-state={state}
    >
      {label}
    </span>
  );
}
