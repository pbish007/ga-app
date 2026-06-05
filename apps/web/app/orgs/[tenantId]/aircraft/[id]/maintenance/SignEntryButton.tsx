"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { SignoffCredentialCard } from "../../../../../../components/credentials/SignoffCredentialCard";
import {
  daysUntilExpiry,
  getCredentialState,
} from "../../../../../../lib/credential-state";
import { colorTokens, pageShellStyles as s } from "../../../../../../lib/page-shell";
import type {
  ActiveCredentialDto,
  CredentialDto,
} from "../../../../../../components/credentials/types";

interface Props {
  tenantId: string;
  entryId: string;
  regimeId: string;
  userId: string;
}

interface SignoffState {
  /** The credential we'll display on the modal. */
  credential: {
    typeName: string;
    certificateNumber: string | null;
    ratings: string[];
    expiresOn: string | null;
    revokedAt: string | null;
  } | null;
  /** True when the credential on record is expired (hard block). */
  expired: boolean;
  /** True when the user has no credential on record at all. */
  missing: boolean;
}

/**
 * Pick the credential to show on the signoff card. Prefer:
 *  1. Active (non-revoked, unexpired) credential authorising signoff for
 *     this regime — most recent issuedOn.
 *  2. Otherwise, surface the most recent authorising credential of any
 *     kind so we can show the expired/revoked state.
 */
function pickAuthorisingActive(
  rows: ActiveCredentialDto[],
): ActiveCredentialDto | null {
  const authorising = rows.filter((r) => r.authorizes_signoff);
  if (authorising.length === 0) return null;
  return authorising.sort((a, b) =>
    b.issued_on.localeCompare(a.issued_on),
  )[0]!;
}

async function fetchSignoffState(
  tenantId: string,
  userId: string,
  regimeId: string,
): Promise<SignoffState> {
  const activeRes = await fetch(
    `/api/orgs/${tenantId}/credentials/active?userId=${encodeURIComponent(
      userId,
    )}&regimeId=${encodeURIComponent(regimeId)}`,
  );
  if (activeRes.ok) {
    const data = (await activeRes.json()) as {
      credentials: ActiveCredentialDto[];
    };
    const active = pickAuthorisingActive(data.credentials);
    if (active) {
      return {
        credential: {
          typeName: active.credential_type_name,
          certificateNumber: active.certificate_number,
          ratings: active.ratings,
          expiresOn: active.expires_on,
          revokedAt: null,
        },
        expired: false,
        missing: false,
      };
    }
  }

  // No active credential — figure out whether the user has an expired
  // one (hard-block UI) vs no credential at all (existing 403 path).
  const listRes = await fetch(
    `/api/orgs/${tenantId}/credentials?userId=${encodeURIComponent(userId)}`,
  );
  if (!listRes.ok) {
    return { credential: null, expired: false, missing: true };
  }
  const listData = (await listRes.json()) as { credentials: CredentialDto[] };
  const candidates = listData.credentials
    .filter((c) => c.revoked_at === null)
    .sort((a, b) => b.issued_on.localeCompare(a.issued_on));
  if (candidates.length === 0) {
    return { credential: null, expired: false, missing: true };
  }
  const newest = candidates[0]!;
  const state = getCredentialState({
    expiresOn: newest.expires_on,
    revokedAt: newest.revoked_at,
  });
  if (state !== "expired") {
    return { credential: null, expired: false, missing: true };
  }
  return {
    credential: {
      typeName: "Certificate",
      certificateNumber: newest.certificate_number,
      ratings: newest.ratings,
      expiresOn: newest.expires_on,
      revokedAt: newest.revoked_at,
    },
    expired: true,
    missing: false,
  };
}

const ghostButton = {
  ...s.button,
  background: "white",
  color: "#374151",
  border: "1px solid #d1d5db",
} as const;

export function SignEntryButton({ tenantId, entryId, regimeId, userId }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signoff, setSignoff] = useState<SignoffState | null>(null);

  async function openConfirm() {
    setError(null);
    setLoading(true);
    try {
      const state = await fetchSignoffState(tenantId, userId, regimeId);
      setSignoff(state);
      setConfirming(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

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
        setConfirming(false);
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
    }
  }

  if (confirming && signoff) {
    const state = signoff.credential
      ? getCredentialState({
          expiresOn: signoff.credential.expiresOn,
          revokedAt: signoff.credential.revokedAt,
        })
      : null;
    const days = signoff.credential
      ? daysUntilExpiry(signoff.credential.expiresOn)
      : null;
    const canConfirm = !signoff.expired && !signoff.missing;

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
        data-testid="signoff-confirm-pane"
      >
        {signoff.credential ? (
          <SignoffCredentialCard
            credential={{
              userDisplayName: "you",
              typeName: signoff.credential.typeName,
              certificateNumber: signoff.credential.certificateNumber,
              ratings: signoff.credential.ratings,
              expiresOn: signoff.credential.expiresOn,
              revokedAt: signoff.credential.revokedAt,
            }}
          />
        ) : null}

        {state === "expiring" && days !== null ? (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: "0.5rem 0.75rem",
              background: colorTokens.warningBg,
              border: `1px solid ${colorTokens.warning}`,
              borderRadius: 4,
              color: "#78350f",
              fontSize: "0.9rem",
            }}
            data-testid="signoff-expiring-warning"
          >
            ⚠ Your certificate expires in {days} day{days === 1 ? "" : "s"}.
            Ask your admin to update the expiration date soon.
          </p>
        ) : null}

        {signoff.expired ? (
          <div
            role="alert"
            style={{
              padding: "0.75rem",
              background: colorTokens.dangerBg,
              border: `1px solid ${colorTokens.danger}`,
              borderRadius: 4,
              color: "#7f1d1d",
              fontSize: "0.9rem",
            }}
            data-testid="signoff-expired-block"
          >
            <strong>✗ Sign-off blocked</strong>
            <p style={{ margin: "0.25rem 0 0" }}>
              The certificate on record is expired. Ask your admin to update
              the expiration date before signing.
            </p>
          </div>
        ) : null}

        {signoff.missing ? (
          <div
            role="alert"
            style={{
              padding: "0.75rem",
              background: colorTokens.dangerBg,
              border: `1px solid ${colorTokens.danger}`,
              borderRadius: 4,
              color: "#7f1d1d",
              fontSize: "0.9rem",
            }}
            data-testid="signoff-missing-block"
          >
            <strong>No credential on record</strong>
            <p style={{ margin: "0.25rem 0 0" }}>
              Ask your admin to add an authorizing certificate before signing.
            </p>
          </div>
        ) : null}

        <p
          style={{
            margin: 0,
            fontSize: "0.85rem",
            color: "#374151",
          }}
        >
          By signing, I certify this work was performed in accordance with
          Part 43 and applicable airworthiness requirements.
        </p>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {canConfirm ? (
            <button
              type="button"
              onClick={sign}
              disabled={submitting}
              style={{ ...s.button, background: "#059669", flex: "1 1 12rem" }}
              data-testid="signoff-confirm-button"
            >
              {submitting ? "Signing…" : "Confirm sign-off"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              setSignoff(null);
              setError(null);
            }}
            disabled={submitting}
            style={{ ...ghostButton, flex: canConfirm ? "0 0 auto" : "1 1 auto" }}
            data-testid="signoff-cancel-button"
          >
            Cancel
          </button>
        </div>

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
        onClick={openConfirm}
        disabled={loading || submitting}
        style={{ ...s.button, background: "#059669", width: "100%" }}
        data-testid="signoff-start-button"
      >
        {loading ? "Loading…" : "Sign entry"}
      </button>
      {error ? (
        <p
          role="alert"
          style={{
            marginTop: "0.5rem",
            color: colorTokens.danger,
            background: colorTokens.dangerBg,
            padding: "0.5rem 0.75rem",
            borderRadius: 4,
            border: `1px solid ${colorTokens.danger}`,
            fontSize: "0.9rem",
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
