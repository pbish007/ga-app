"use client";

import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import { colorTokens, pageShellStyles as s } from "../../lib/page-shell";

import { ModalShell } from "./ModalShell";
import type { CredentialDto, CredentialTypeDto } from "./types";

interface CommonProps {
  open: boolean;
  onClose: () => void;
  onSaved: (credential: CredentialDto) => void;
  tenantId: string;
  userDisplayName: string;
  credentialTypes: CredentialTypeDto[];
}

type Props =
  | (CommonProps & { mode: "create"; userId: string; credential?: undefined })
  | (CommonProps & {
      mode: "edit";
      userId: string;
      credential: CredentialDto;
    });

interface FormState {
  regimeCredentialTypeId: string;
  certificateNumber: string;
  ratingsAirframe: boolean;
  ratingsPowerplant: boolean;
  ratingsOther: boolean;
  ratingsOtherText: string;
  issuedOn: string;
  expiresOn: string;
}

const initialEmpty: FormState = {
  regimeCredentialTypeId: "",
  certificateNumber: "",
  ratingsAirframe: false,
  ratingsPowerplant: false,
  ratingsOther: false,
  ratingsOtherText: "",
  issuedOn: "",
  expiresOn: "",
};

function fromCredential(c: CredentialDto): FormState {
  const known = new Set(["Airframe", "Powerplant"]);
  const other = c.ratings.filter((r) => !known.has(r));
  return {
    regimeCredentialTypeId: c.regime_credential_type_id,
    certificateNumber: c.certificate_number ?? "",
    ratingsAirframe: c.ratings.includes("Airframe"),
    ratingsPowerplant: c.ratings.includes("Powerplant"),
    ratingsOther: other.length > 0,
    ratingsOtherText: other.join(", "),
    issuedOn: c.issued_on,
    expiresOn: c.expires_on ?? "",
  };
}

const footer: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  padding: "1rem",
  borderTop: `1px solid ${colorTokens.cardBorder}`,
  flexWrap: "wrap",
};

const header: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "1rem",
  borderBottom: `1px solid ${colorTokens.cardBorder}`,
};

const errorText: CSSProperties = {
  color: colorTokens.danger,
  fontSize: "0.85rem",
  margin: 0,
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

const ghostButton: CSSProperties = {
  ...s.button,
  background: "white",
  color: "#374151",
  border: "1px solid #d1d5db",
};

function todayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

function ratingsFromState(state: FormState): string[] {
  const out: string[] = [];
  if (state.ratingsAirframe) out.push("Airframe");
  if (state.ratingsPowerplant) out.push("Powerplant");
  if (state.ratingsOther) {
    state.ratingsOtherText
      .split(/[,;]\s*/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((v) => out.push(v));
  }
  return out;
}

export function CredentialFormModal(props: Props) {
  const titleId = useId();
  const typeId = useId();
  const certId = useId();
  const issueId = useId();
  const expiryId = useId();
  const issueErrId = useId();
  const expiryErrId = useId();
  const otherRatingId = useId();

  const isEdit = props.mode === "edit";

  const [form, setForm] = useState<FormState>(initialEmpty);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setForm(
      props.mode === "edit" && props.credential
        ? fromCredential(props.credential)
        : initialEmpty,
    );
    setIssueError(null);
    setExpiryError(null);
    setServerError(null);
    setSubmitting(false);
  }, [props.open, props.mode, props.credential]);

  const today = useMemo(todayIso, []);

  function validateIssue(value: string): string | null {
    if (!value) return "Issue date is required";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "Enter a valid date (YYYY-MM-DD)";
    }
    if (value > today) return "Issue date can't be in the future";
    return null;
  }

  function validateExpiry(value: string, issued: string): string | null {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "Enter a valid date (YYYY-MM-DD)";
    }
    if (issued && value <= issued) {
      return "Expiration date must be after the issue date";
    }
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setServerError(null);

    const issueErr = validateIssue(form.issuedOn);
    const expiryErr = validateExpiry(form.expiresOn, form.issuedOn);
    setIssueError(issueErr);
    setExpiryError(expiryErr);
    if (issueErr || expiryErr) return;
    if (!form.regimeCredentialTypeId) {
      setServerError("Select a certificate type.");
      return;
    }

    setSubmitting(true);
    try {
      const ratings = ratingsFromState(form);
      const body = {
        user_id: props.userId,
        regime_credential_type_id: form.regimeCredentialTypeId,
        certificate_number: form.certificateNumber.trim() || null,
        ratings,
        issued_on: form.issuedOn,
        expires_on: form.expiresOn || null,
      };
      const url = isEdit
        ? `/api/orgs/${props.tenantId}/credentials/${props.credential!.id}`
        : `/api/orgs/${props.tenantId}/credentials`;
      const method = isEdit ? "PATCH" : "POST";
      const patchBody = isEdit
        ? {
            certificate_number: body.certificate_number,
            ratings,
            issued_on: form.issuedOn,
            expires_on: form.expiresOn || null,
          }
        : body;

      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setServerError(
          data.error ?? `Couldn't save. Request failed (${res.status}).`,
        );
        return;
      }
      const data = (await res.json()) as { credential: CredentialDto };
      props.onSaved(data.credential);
      props.onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const title = isEdit ? "Edit certificate" : "Add certificate";

  return (
    <ModalShell
      open={props.open}
      onClose={() => {
        if (!submitting) props.onClose();
      }}
      titleId={titleId}
      testId="credential-form-modal"
    >
      <div style={header}>
        <h2 id={titleId} style={{ margin: 0, fontSize: "1.1rem" }}>
          {title}
        </h2>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close"
          style={closeButton}
          disabled={submitting}
        >
          ×
        </button>
      </div>
      <form
        onSubmit={handleSubmit}
        style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}
      >
        <div style={s.field}>
          <label htmlFor={typeId} style={s.label}>
            Certificate type *
          </label>
          <select
            id={typeId}
            value={form.regimeCredentialTypeId}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                regimeCredentialTypeId: e.target.value,
              }))
            }
            style={s.select}
            disabled={isEdit}
            required
            data-testid="credential-form-type"
          >
            <option value="">Select type</option>
            {props.credentialTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {isEdit ? (
            <p style={{ ...s.muted, fontSize: "0.8rem" }}>
              Certificate type cannot be changed after creation.
            </p>
          ) : null}
        </div>

        <div style={s.field}>
          <label htmlFor={certId} style={s.label}>
            Certificate number
          </label>
          <input
            id={certId}
            type="text"
            value={form.certificateNumber}
            onChange={(e) =>
              setForm((f) => ({ ...f, certificateNumber: e.target.value }))
            }
            placeholder="e.g. 2836521"
            style={s.input}
            maxLength={64}
            data-testid="credential-form-cert-number"
          />
        </div>

        <fieldset
          style={{
            border: `1px solid ${colorTokens.cardBorder}`,
            borderRadius: 6,
            padding: "0.5rem 0.75rem",
            margin: 0,
          }}
        >
          <legend style={{ ...s.label, padding: "0 0.25rem" }}>Ratings</legend>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.35rem",
              marginTop: "0.25rem",
            }}
          >
            <label
              style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={form.ratingsAirframe}
                onChange={(e) =>
                  setForm((f) => ({ ...f, ratingsAirframe: e.target.checked }))
                }
                data-testid="credential-form-rating-airframe"
              />
              Airframe
            </label>
            <label
              style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={form.ratingsPowerplant}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    ratingsPowerplant: e.target.checked,
                  }))
                }
                data-testid="credential-form-rating-powerplant"
              />
              Powerplant
            </label>
            <label
              style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={form.ratingsOther}
                onChange={(e) =>
                  setForm((f) => ({ ...f, ratingsOther: e.target.checked }))
                }
                data-testid="credential-form-rating-other"
              />
              Other
            </label>
            {form.ratingsOther ? (
              <div style={s.field}>
                <label htmlFor={otherRatingId} style={s.label}>
                  Other rating
                </label>
                <input
                  id={otherRatingId}
                  type="text"
                  value={form.ratingsOtherText}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      ratingsOtherText: e.target.value,
                    }))
                  }
                  style={s.input}
                  placeholder="Describe — comma-separate multiple"
                />
              </div>
            ) : null}
          </div>
        </fieldset>

        <div style={s.field}>
          <label htmlFor={issueId} style={s.label}>
            Issue date *
          </label>
          <input
            id={issueId}
            type="date"
            value={form.issuedOn}
            max={today}
            onChange={(e) =>
              setForm((f) => ({ ...f, issuedOn: e.target.value }))
            }
            onBlur={(e) => setIssueError(validateIssue(e.target.value))}
            aria-describedby={issueError ? issueErrId : undefined}
            aria-invalid={issueError ? true : undefined}
            style={s.input}
            required
            data-testid="credential-form-issued-on"
          />
          {issueError ? (
            <p
              id={issueErrId}
              role="alert"
              style={errorText}
              data-testid="credential-form-issued-error"
            >
              {issueError}
            </p>
          ) : null}
        </div>

        <div style={s.field}>
          <label htmlFor={expiryId} style={s.label}>
            Expiration date
          </label>
          <input
            id={expiryId}
            type="date"
            value={form.expiresOn}
            onChange={(e) =>
              setForm((f) => ({ ...f, expiresOn: e.target.value }))
            }
            onBlur={(e) =>
              setExpiryError(validateExpiry(e.target.value, form.issuedOn))
            }
            aria-describedby={expiryError ? expiryErrId : undefined}
            aria-invalid={expiryError ? true : undefined}
            style={s.input}
            data-testid="credential-form-expires-on"
          />
          {expiryError ? (
            <p
              id={expiryErrId}
              role="alert"
              style={errorText}
              data-testid="credential-form-expires-error"
            >
              {expiryError}
            </p>
          ) : (
            <p style={{ ...s.muted, fontSize: "0.8rem" }}>
              Leave blank if the certificate does not expire.
            </p>
          )}
        </div>

        {serverError ? (
          <p
            role="alert"
            style={{
              ...errorText,
              background: colorTokens.dangerBg,
              padding: "0.5rem 0.75rem",
              borderRadius: 4,
              border: `1px solid ${colorTokens.danger}`,
            }}
            data-testid="credential-form-server-error"
          >
            {serverError}
          </p>
        ) : null}
      </form>
      <div style={footer}>
        <button
          type="button"
          onClick={props.onClose}
          style={ghostButton}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          onClick={handleSubmit}
          style={s.button}
          disabled={submitting}
          data-testid="credential-form-save"
        >
          {submitting ? "Saving…" : "Save certificate"}
        </button>
      </div>
    </ModalShell>
  );
}
