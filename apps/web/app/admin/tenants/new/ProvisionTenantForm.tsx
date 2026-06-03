"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type CSSProperties } from "react";

import { pageShellStyles as s } from "../../../../lib/page-shell";

export interface RegimeOption {
  id: string;
  code: string;
  label: string;
}

interface Props {
  regimes: RegimeOption[];
}

const ORG_TYPE_OPTIONS: { value: OrgType; label: string }[] = [
  { value: "owner", label: "Owner / operator (single aircraft)" },
  { value: "club", label: "Flying club" },
  { value: "school", label: "Flight school" },
  { value: "shop", label: "Maintenance shop" },
];

const SEAT_ROLE_OPTIONS: { value: SeatRole; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "mechanic", label: "Mechanic" },
  { value: "pilot", label: "Pilot" },
  { value: "read_only", label: "Read-only" },
];

type OrgType = "owner" | "club" | "school" | "shop";
type SeatRole = "admin" | "manager" | "mechanic" | "pilot" | "read_only";
type PasswordMode = "auto" | "manual";

interface SeatRow {
  email: string;
  role: SeatRole;
}

interface SuccessState {
  tenantId: string;
  primaryAdminUserId: string | null;
  primaryAdminEmail: string;
  /** Present iff mode (a) — server-generated, displayed once. */
  initialPassword?: string;
  auditId: string;
}

interface TypedError {
  code: string;
  message: string;
  field?: string;
}

function genIdempotencyKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers; RFC 4122 v4-ish from random bytes.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const errorBoxStyle: CSSProperties = {
  margin: 0,
  color: "#b91c1c",
  background: "#fef2f2",
  padding: "0.65rem 0.85rem",
  borderRadius: 6,
  border: "1px solid #fecaca",
  fontSize: "0.9rem",
};

const credentialBoxStyle: CSSProperties = {
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: 6,
  padding: "1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

const credentialValueStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: "1rem",
  background: "#fff",
  border: "1px solid #fcd34d",
  borderRadius: 4,
  padding: "0.5rem 0.75rem",
  wordBreak: "break-all" as const,
};

const seatRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto",
  gap: "0.5rem",
  alignItems: "end",
};

function fieldErrorMessage(
  err: TypedError | null,
  field: string,
): string | null {
  if (!err || err.field !== field) return null;
  return err.message;
}

export function ProvisionTenantForm({ regimes }: Props) {
  const [orgName, setOrgName] = useState("");
  const [orgType, setOrgType] = useState<OrgType>("owner");
  const [regimeId, setRegimeId] = useState<string>("");
  const [primaryAdminEmail, setPrimaryAdminEmail] = useState("");
  const [passwordMode, setPasswordMode] = useState<PasswordMode>("auto");
  const [manualPassword, setManualPassword] = useState("");
  const [seats, setSeats] = useState<SeatRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<TypedError | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [copyOk, setCopyOk] = useState(false);

  // Idempotency key state:
  //  - Generated lazily on submit
  //  - Re-used when the previous attempt failed at the network layer (no
  //    response received) so a retry hits the same audit row
  //  - Rotated after any server response (success or typed 4xx) so the
  //    next submit with edited inputs doesn't collide with the prior
  //    `done` snapshot / get a 409 idempotency_key_reused
  const idemRef = useRef<string | null>(null);
  const reuseKey = useRef(false);

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (success) return false;
    if (orgName.trim().length === 0) return false;
    if (!primaryAdminEmail.includes("@")) return false;
    if (passwordMode === "manual" && manualPassword.length < 8) return false;
    for (const seat of seats) {
      if (!seat.email.includes("@")) return false;
    }
    return true;
  }, [
    submitting,
    success,
    orgName,
    primaryAdminEmail,
    passwordMode,
    manualPassword,
    seats,
  ]);

  function addSeat() {
    setSeats((rows) => [...rows, { email: "", role: "mechanic" }]);
  }

  function removeSeat(index: number) {
    setSeats((rows) => rows.filter((_, i) => i !== index));
  }

  function updateSeat(index: number, patch: Partial<SeatRow>) {
    setSeats((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function resetForm() {
    setOrgName("");
    setOrgType("owner");
    setRegimeId("");
    setPrimaryAdminEmail("");
    setPasswordMode("auto");
    setManualPassword("");
    setSeats([]);
    setError(null);
    setGenericError(null);
    setSuccess(null);
    setCopyOk(false);
    idemRef.current = null;
    reuseKey.current = false;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setGenericError(null);
    setSubmitting(true);

    if (!idemRef.current || !reuseKey.current) {
      idemRef.current = genIdempotencyKey();
    }
    reuseKey.current = false;

    const trimmedSeats = seats
      .map((seat) => ({
        email: seat.email.trim().toLowerCase(),
        role: seat.role,
      }))
      .filter((seat) => seat.email.length > 0);

    const body: Record<string, unknown> = {
      orgName: orgName.trim(),
      orgType,
      primaryAdmin: {
        email: primaryAdminEmail.trim().toLowerCase(),
        ...(passwordMode === "auto"
          ? { generatePassword: true }
          : { password: manualPassword }),
      },
    };
    if (regimeId) body.regimeId = regimeId;
    if (trimmedSeats.length > 0) body.additionalSeats = trimmedSeats;

    let res: Response;
    try {
      res = await fetch("/api/admin/tenants", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idemRef.current,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network failure — no response received. Preserve the key so the
      // operator can retry without creating a duplicate audit row.
      reuseKey.current = true;
      setSubmitting(false);
      setGenericError(
        `Network error: ${err instanceof Error ? err.message : String(err)}. Submit again to retry — the same idempotency key will be used.`,
      );
      return;
    }

    // We received a response. Whatever happens next, the *next* user-driven
    // submit should rotate the key (otherwise an edit + retry collides with
    // the prior body under the same key and 409s).
    const responseBody = (await res
      .json()
      .catch(() => ({}))) as Record<string, unknown>;

    if (res.ok) {
      const ok = responseBody as {
        tenantId?: string;
        primaryAdminUserId?: string | null;
        initialPassword?: string;
        auditId?: string;
      };
      setSuccess({
        tenantId: ok.tenantId ?? "(unknown)",
        primaryAdminUserId: ok.primaryAdminUserId ?? null,
        primaryAdminEmail: primaryAdminEmail.trim().toLowerCase(),
        initialPassword: ok.initialPassword,
        auditId: ok.auditId ?? "(unknown)",
      });
      // Clear the manually-typed password from React state on success so
      // the only surviving credential is the one the server returned (if
      // mode (a)). The auto-generated credential is cleared after the
      // operator confirms they've copied it (see acknowledgeCredential).
      setManualPassword("");
      // Rotate the key — next provisioning attempt should be independent.
      idemRef.current = null;
      reuseKey.current = false;
      setSubmitting(false);
      return;
    }

    const typed = responseBody as {
      code?: string;
      message?: string;
      field?: string;
    };
    if (typeof typed.code === "string" && typeof typed.message === "string") {
      setError({
        code: typed.code,
        message: typed.message,
        field: typed.field,
      });
    } else {
      setGenericError(`Request failed (${res.status}).`);
    }
    // Rotate the key — the operator will edit the form and resubmit.
    idemRef.current = null;
    reuseKey.current = false;
    setSubmitting(false);
  }

  async function copyPassword(password: string) {
    try {
      await navigator.clipboard.writeText(password);
      setCopyOk(true);
    } catch {
      setCopyOk(false);
      setGenericError(
        "Could not copy to clipboard automatically — please copy the password manually.",
      );
    }
  }

  function acknowledgeCredential() {
    if (!success) return;
    setSuccess({ ...success, initialPassword: undefined });
    setCopyOk(false);
  }

  // Top-level non-field error: not tied to a single input.
  const nonFieldError =
    error && !error.field
      ? humanizeTopLevelError(error)
      : genericError ?? null;

  // ---- Success view --------------------------------------------------------
  if (success) {
    const showCredential = success.initialPassword != null;
    return (
      <section style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div
          role="status"
          style={{
            background: "#ecfdf5",
            border: "1px solid #6ee7b7",
            color: "#065f46",
            padding: "0.85rem 1rem",
            borderRadius: 6,
          }}
        >
          <strong>Tenant created.</strong>
          <div style={{ fontSize: "0.9rem", marginTop: "0.25rem" }}>
            Tenant ID: <code>{success.tenantId}</code>
          </div>
          <div style={{ fontSize: "0.9rem" }}>
            Primary admin: {success.primaryAdminEmail}
          </div>
          <div style={{ fontSize: "0.85rem", marginTop: "0.25rem", color: "#047857" }}>
            Audit row: <code>{success.auditId}</code>
          </div>
        </div>

        {showCredential ? (
          <div style={credentialBoxStyle}>
            <div>
              <strong>Initial password</strong>
              <div style={{ fontSize: "0.85rem", color: "#92400e" }}>
                Shown once. Share with the new admin through your usual secure
                channel, then confirm you&rsquo;ve copied it.
              </div>
            </div>
            <div style={credentialValueStyle}>{success.initialPassword}</div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => copyPassword(success.initialPassword!)}
                style={{ ...s.button, background: "#b45309" }}
              >
                {copyOk ? "Copied ✓" : "Copy password"}
              </button>
              <button
                type="button"
                onClick={acknowledgeCredential}
                disabled={!copyOk}
                style={{
                  ...s.button,
                  background: copyOk ? "#065f46" : "#9ca3af",
                  cursor: copyOk ? "pointer" : "not-allowed",
                }}
              >
                I&rsquo;ve copied this — clear it
              </button>
            </div>
            {genericError ? <p style={errorBoxStyle}>{genericError}</p> : null}
          </div>
        ) : (
          <p style={{ fontSize: "0.9rem", color: "#444", margin: 0 }}>
            {passwordMode === "auto"
              ? "Initial password cleared. It is not stored anywhere reachable from this UI."
              : "Initial password was set manually — not displayed."}
          </p>
        )}

        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={resetForm}
            style={{ ...s.button, background: "#2563eb" }}
          >
            Provision another tenant
          </button>
          <Link href="/orgs" style={s.link}>
            Back to organizations
          </Link>
        </div>
      </section>
    );
  }

  // ---- Form view -----------------------------------------------------------
  return (
    <form
      onSubmit={submit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        marginTop: "1.5rem",
      }}
      noValidate
    >
      <label style={s.field}>
        <span style={s.label}>Organization name</span>
        <input
          type="text"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          placeholder="e.g. Blue Sky Aviation"
          disabled={submitting}
          style={s.input}
          autoFocus
          required
        />
        <FieldError msg={fieldErrorMessage(error, "orgName")} />
      </label>

      <label style={s.field}>
        <span style={s.label}>Organization type</span>
        <select
          value={orgType}
          onChange={(e) => setOrgType(e.target.value as OrgType)}
          disabled={submitting}
          style={s.select}
        >
          {ORG_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <FieldError msg={fieldErrorMessage(error, "orgType")} />
      </label>

      <label style={s.field}>
        <span style={s.label}>Regulatory regime</span>
        <select
          value={regimeId}
          onChange={(e) => setRegimeId(e.target.value)}
          disabled={submitting}
          style={s.select}
        >
          <option value="">Use platform default</option>
          {regimes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <FieldError msg={fieldErrorMessage(error, "regimeId")} />
        {error?.code === "invalid_regime" && !error.field ? (
          <FieldError msg={error.message} />
        ) : null}
      </label>

      <label style={s.field}>
        <span style={s.label}>Primary admin email</span>
        <input
          type="email"
          value={primaryAdminEmail}
          onChange={(e) => setPrimaryAdminEmail(e.target.value)}
          placeholder="admin@example.com"
          autoComplete="off"
          disabled={submitting}
          style={s.input}
          required
        />
        <FieldError msg={fieldErrorMessage(error, "primaryAdmin.email")} />
        {error?.code === "email_already_exists" ? (
          <FieldError
            msg={
              error.message ||
              "An account already exists with this email. Pick a different address."
            }
          />
        ) : null}
      </label>

      <fieldset
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          padding: "0.85rem 1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        <legend style={{ fontWeight: 600, fontSize: "0.9rem", padding: "0 0.35rem" }}>
          Initial password
        </legend>
        <label
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "flex-start",
            fontSize: "0.95rem",
          }}
        >
          <input
            type="radio"
            name="passwordMode"
            value="auto"
            checked={passwordMode === "auto"}
            onChange={() => setPasswordMode("auto")}
            disabled={submitting}
            style={{ marginTop: "0.25rem" }}
          />
          <span>
            <strong>Generate a one-time password.</strong> The server returns
            it once in the response — copy it, then share through your usual
            secure channel. Recommended.
          </span>
        </label>
        <label
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "flex-start",
            fontSize: "0.95rem",
          }}
        >
          <input
            type="radio"
            name="passwordMode"
            value="manual"
            checked={passwordMode === "manual"}
            onChange={() => setPasswordMode("manual")}
            disabled={submitting}
            style={{ marginTop: "0.25rem" }}
          />
          <span>
            <strong>Set the initial password manually.</strong> You enter it
            here and share it out-of-band.
          </span>
        </label>
        {passwordMode === "manual" ? (
          <label style={s.field}>
            <span style={s.label}>Initial password</span>
            <input
              type="password"
              value={manualPassword}
              onChange={(e) => setManualPassword(e.target.value)}
              minLength={8}
              autoComplete="new-password"
              disabled={submitting}
              style={s.input}
              required
            />
            <span style={{ fontSize: "0.8rem", color: "#666" }}>
              At least 8 characters.
            </span>
            <FieldError msg={fieldErrorMessage(error, "primaryAdmin.password")} />
          </label>
        ) : null}
      </fieldset>

      <fieldset
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          padding: "0.85rem 1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        <legend style={{ fontWeight: 600, fontSize: "0.9rem", padding: "0 0.35rem" }}>
          Additional seats (optional)
        </legend>
        <p style={{ ...s.muted, fontSize: "0.85rem", marginTop: 0 }}>
          Invite emails are sent through the email outbox. Each invite expires
          per the platform default.
        </p>
        {seats.map((seat, i) => (
          <div key={i} style={seatRowStyle}>
            <label style={s.field}>
              <span style={s.label}>Email</span>
              <input
                type="email"
                value={seat.email}
                onChange={(e) =>
                  updateSeat(i, { email: e.target.value })
                }
                disabled={submitting}
                style={s.input}
                placeholder="teammate@example.com"
              />
              <FieldError
                msg={fieldErrorMessage(error, `additionalSeats[${i}].email`)}
              />
            </label>
            <label style={s.field}>
              <span style={s.label}>Role</span>
              <select
                value={seat.role}
                onChange={(e) =>
                  updateSeat(i, { role: e.target.value as SeatRole })
                }
                disabled={submitting}
                style={s.select}
              >
                {SEAT_ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <FieldError
                msg={fieldErrorMessage(error, `additionalSeats[${i}].role`)}
              />
            </label>
            <button
              type="button"
              onClick={() => removeSeat(i)}
              disabled={submitting}
              style={{
                ...s.button,
                background: "#ef4444",
                padding: "0.5rem 0.85rem",
                alignSelf: "end",
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addSeat}
          disabled={submitting}
          style={{
            ...s.button,
            background: "#f3f4f6",
            color: "#111827",
            border: "1px solid #d1d5db",
            alignSelf: "flex-start",
          }}
        >
          + Add seat
        </button>
      </fieldset>

      {nonFieldError ? (
        <p role="alert" style={errorBoxStyle}>
          {nonFieldError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!canSubmit}
        style={{
          ...s.button,
          width: "100%",
          background: canSubmit ? "#2563eb" : "#9db8f0",
          cursor: canSubmit ? "pointer" : "not-allowed",
        }}
      >
        {submitting ? "Provisioning…" : "Provision tenant"}
      </button>
    </form>
  );
}

function FieldError({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <span style={{ color: "#b91c1c", fontSize: "0.8rem" }}>{msg}</span>
  );
}

function humanizeTopLevelError(err: TypedError): string {
  switch (err.code) {
    case "email_already_exists":
      return (
        err.message ||
        "An account already exists with that email. Pick a different address."
      );
    case "idempotency_conflict":
      return (
        err.message ||
        "A provisioning attempt with the same key is already in flight. Wait a moment, then try again."
      );
    case "idempotency_key_reused":
      return (
        err.message ||
        "This request looks like a replay of a previous attempt. Edit the form, then resubmit — a fresh idempotency key will be generated."
      );
    case "invalid_regime":
      return err.message || "The selected regime is not valid.";
    case "validation_error":
      return err.message || "One or more fields failed validation.";
    default:
      return err.message || `Request failed (${err.code}).`;
  }
}
