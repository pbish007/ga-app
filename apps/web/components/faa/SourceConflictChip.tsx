"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { faaTokens } from "../../lib/page-shell";

import type { FaaFieldState, FaaFieldReportReason, ReportPayload } from "./types";

interface Props {
  /** Human label of the source — e.g. "FAA Registry". */
  sourceName: string;
  /** Field label used in aria-labels and reopen text. */
  fieldLabel: string;
  state: FaaFieldState;
  onAccept?: () => void | Promise<void>;
  onDecline?: () => void | Promise<void>;
  onReport?: (payload: ReportPayload) => void | Promise<void>;
  /** Optional handler for reopening a collapsed decision. */
  onReopen?: () => void;
  /** Disable buttons while a network call is in-flight. */
  busy?: boolean;
}

const REPORT_REASONS: Array<{ value: FaaFieldReportReason; label: string }> = [
  { value: "registry_typo", label: "Registry typo" },
  { value: "stale_data", label: "Stale registry data" },
  { value: "wrong_tail", label: "Wrong tail number on registry" },
  { value: "other", label: "Other (add note)" },
];

const chipContainer: CSSProperties = {
  marginTop: "0.5rem",
  padding: "0.6rem 0.75rem",
  borderRadius: 6,
  fontSize: "0.9rem",
  lineHeight: 1.4,
};

const chipRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
  alignItems: "center",
};

const buttonBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 36,
  padding: "0.35rem 0.75rem",
  borderRadius: 6,
  fontSize: "0.85rem",
  fontWeight: 600,
  cursor: "pointer",
  touchAction: "manipulation",
};

const primaryButton: CSSProperties = {
  ...buttonBase,
  background: faaTokens.actionPrimaryBg,
  color: faaTokens.actionPrimaryFg,
  border: "1px solid " + faaTokens.actionPrimaryBg,
};

const secondaryButton: CSSProperties = {
  ...buttonBase,
  background: faaTokens.actionSecondaryBg,
  color: faaTokens.actionSecondaryFg,
  border: "1px solid " + faaTokens.actionSecondaryBorder,
};

const sourceLabelStyle: CSSProperties = {
  color: faaTokens.textWarningStrong,
  fontWeight: 600,
};

const footnoteStyle: CSSProperties = {
  marginTop: "0.4rem",
  fontSize: "0.8rem",
  color: faaTokens.textSecondary,
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
  alignItems: "center",
};

const reopenButton: CSSProperties = {
  ...buttonBase,
  background: "transparent",
  border: "none",
  color: faaTokens.textInfo,
  textDecoration: "underline",
  padding: "0 0.25rem",
  minHeight: 32,
  fontSize: "0.8rem",
};

const sheetBackdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15,23,42,0.5)",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  zIndex: 1000,
};

const sheetPanel: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  background: "white",
  borderTopLeftRadius: 12,
  borderTopRightRadius: 12,
  padding: "1rem 1.25rem 1.25rem",
  boxShadow: "0 -4px 12px rgba(0,0,0,0.15)",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function reasonLabel(value: FaaFieldReportReason): string {
  return REPORT_REASONS.find((r) => r.value === value)?.label ?? value;
}

export function SourceConflictChip({
  sourceName,
  fieldLabel,
  state,
  onAccept,
  onDecline,
  onReport,
  onReopen,
  busy = false,
}: Props) {
  const liveRegionId = useId();

  switch (state.kind) {
    case "loading":
      return (
        <div
          aria-live="polite"
          aria-atomic="false"
          id={liveRegionId}
          data-testid="source-conflict-chip"
          data-state="loading"
          style={{
            ...chipContainer,
            background: faaTokens.surfaceNeutralSubtle,
            color: faaTokens.textSecondary,
          }}
        >
          Checking {sourceName}…
        </div>
      );

    case "no_faa_data":
      return null;

    case "faa_lookup_error":
      return (
        <div
          aria-live="polite"
          aria-atomic="false"
          id={liveRegionId}
          data-testid="source-conflict-chip"
          data-state="faa_lookup_error"
          style={{
            ...chipContainer,
            background: faaTokens.surfaceWarningSubtle,
            color: faaTokens.textWarningStrong,
          }}
        >
          {sourceName} unavailable
          {state.retriableAt ? ` · last checked ${formatDate(state.retriableAt)}` : ""}
        </div>
      );

    case "aligned":
      return (
        <div
          aria-live="polite"
          aria-atomic="false"
          id={liveRegionId}
          data-testid="source-conflict-chip"
          data-state="aligned"
          style={footnoteStyle}
        >
          Matches {sourceName} · synced {formatDate(state.lastSyncedAt)}
        </div>
      );

    case "conflict":
      return (
        <ConflictBody
          sourceName={sourceName}
          fieldLabel={fieldLabel}
          faaValue={state.faaValue}
          busy={busy}
          onAccept={onAccept}
          onDecline={onDecline}
          onReport={onReport}
          liveRegionId={liveRegionId}
        />
      );

    case "tenant_wins":
      return (
        <div
          aria-live="polite"
          aria-atomic="false"
          id={liveRegionId}
          data-testid="source-conflict-chip"
          data-state="tenant_wins"
          style={footnoteStyle}
        >
          <span>
            {sourceName} value not applied · decided {formatDate(state.decidedAt)}
          </span>
          {onReopen ? (
            <button
              type="button"
              onClick={onReopen}
              style={reopenButton}
              aria-label={`Reopen ${sourceName} conflict for ${fieldLabel}`}
            >
              Reopen
            </button>
          ) : null}
        </div>
      );

    case "accepted_faa":
      return (
        <div
          aria-live="polite"
          aria-atomic="false"
          id={liveRegionId}
          data-testid="source-conflict-chip"
          data-state="accepted_faa"
          style={footnoteStyle}
        >
          <span>
            Synced from {sourceName} · {formatDate(state.acceptedAt)}
          </span>
          {onReopen ? (
            <button
              type="button"
              onClick={onReopen}
              style={reopenButton}
              aria-label={`Reopen ${sourceName} conflict for ${fieldLabel}`}
            >
              Reopen
            </button>
          ) : null}
        </div>
      );

    case "faa_reported_wrong":
      return (
        <div
          aria-live="polite"
          aria-atomic="false"
          id={liveRegionId}
          data-testid="source-conflict-chip"
          data-state="faa_reported_wrong"
          style={footnoteStyle}
        >
          <span>
            {sourceName} value reported as incorrect · {reasonLabel(state.reportedReason)}
          </span>
          {onReopen ? (
            <button
              type="button"
              onClick={onReopen}
              style={reopenButton}
              aria-label={`Reopen ${sourceName} conflict for ${fieldLabel}`}
            >
              Reopen
            </button>
          ) : null}
        </div>
      );
  }
}

interface ConflictBodyProps {
  sourceName: string;
  fieldLabel: string;
  faaValue: string;
  busy: boolean;
  onAccept?: () => void | Promise<void>;
  onDecline?: () => void | Promise<void>;
  onReport?: (payload: ReportPayload) => void | Promise<void>;
  liveRegionId: string;
}

function ConflictBody({
  sourceName,
  fieldLabel,
  faaValue,
  busy,
  onAccept,
  onDecline,
  onReport,
  liveRegionId,
}: ConflictBodyProps) {
  const [reportOpen, setReportOpen] = useState(false);
  const reportTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      id={liveRegionId}
      data-testid="source-conflict-chip"
      data-state="conflict"
      style={{
        ...chipContainer,
        background: faaTokens.surfaceWarningSubtle,
        border: "1px solid " + faaTokens.warningBorder,
      }}
    >
      <div style={chipRow}>
        <span>
          <span style={sourceLabelStyle}>{sourceName} says:</span>{" "}
          <span>{faaValue}</span>
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAccept?.()}
          style={primaryButton}
          aria-label={`Use ${sourceName} value for ${fieldLabel}`}
        >
          Use {sourceName} value
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecline?.()}
          style={secondaryButton}
          aria-label={`Keep my ${fieldLabel} value`}
        >
          Keep mine
        </button>
        <button
          ref={reportTriggerRef}
          type="button"
          disabled={busy}
          onClick={() => setReportOpen(true)}
          style={secondaryButton}
          aria-haspopup="dialog"
          aria-expanded={reportOpen}
          aria-label={`${sourceName} value is wrong for ${fieldLabel}`}
        >
          {sourceName} is wrong ▾
        </button>
      </div>
      {reportOpen && onReport ? (
        <ReportSheet
          sourceName={sourceName}
          fieldLabel={fieldLabel}
          onClose={() => {
            setReportOpen(false);
            requestAnimationFrame(() => reportTriggerRef.current?.focus());
          }}
          onSubmit={async (payload) => {
            await onReport(payload);
            setReportOpen(false);
            requestAnimationFrame(() => reportTriggerRef.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}

interface ReportSheetProps {
  sourceName: string;
  fieldLabel: string;
  onClose: () => void;
  onSubmit: (payload: ReportPayload) => void | Promise<void>;
}

function ReportSheet({
  sourceName,
  fieldLabel,
  onClose,
  onSubmit,
}: ReportSheetProps) {
  const [reason, setReason] = useState<FaaFieldReportReason>("registry_typo");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFocusRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    firstFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function trapFocus(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const noteRequired = reason === "other";
  const disabled = submitting || (noteRequired && note.trim().length === 0);

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={sheetBackdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onKeyDown={trapFocus}
        style={sheetPanel}
      >
        <h2 id={titleId} style={{ marginTop: 0, fontSize: "1rem" }}>
          Report {sourceName} value for {fieldLabel}
        </h2>
        <fieldset
          style={{ border: "none", padding: 0, margin: "0.75rem 0" }}
        >
          <legend style={{ fontSize: "0.85rem", color: faaTokens.textSecondary }}>
            Reason
          </legend>
          {REPORT_REASONS.map((option, idx) => (
            <label
              key={option.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.4rem 0",
                fontSize: "0.95rem",
              }}
            >
              <input
                ref={idx === 0 ? firstFocusRef : null}
                type="radio"
                name="faa-report-reason"
                value={option.value}
                checked={reason === option.value}
                onChange={() => setReason(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <label style={{ display: "block", marginTop: "0.5rem" }}>
          <span
            style={{
              fontSize: "0.85rem",
              color: faaTokens.textSecondary,
            }}
          >
            Note {noteRequired ? "(required)" : "(optional)"} — 280 char max
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 280))}
            rows={3}
            style={{
              marginTop: "0.25rem",
              width: "100%",
              padding: "0.5rem",
              border: "1px solid " + faaTokens.actionSecondaryBorder,
              borderRadius: 6,
              fontSize: "0.95rem",
              boxSizing: "border-box",
            }}
          />
        </label>
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginTop: "1rem",
            justifyContent: "flex-end",
          }}
        >
          <button type="button" onClick={onClose} style={secondaryButton}>
            Cancel
          </button>
          <button
            type="button"
            disabled={disabled}
            style={{
              ...primaryButton,
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? "not-allowed" : "pointer",
            }}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onSubmit({
                  reason,
                  note: note.trim() ? note.trim() : undefined,
                });
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? "Submitting…" : "Submit report"}
          </button>
        </div>
      </div>
    </div>
  );
}
