"use client";

import type { CSSProperties } from "react";

import { faaTokens } from "../../lib/page-shell";

import type { FaaLookupResponse } from "./use-faa-lookup";

interface Props {
  response: FaaLookupResponse;
  onRetry: () => void;
}

const wrapperBase: CSSProperties = {
  marginTop: "0.75rem",
  padding: "0.5rem 0.75rem",
  borderRadius: 6,
  fontSize: "0.85rem",
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const retryButton: CSSProperties = {
  background: "transparent",
  border: "none",
  color: faaTokens.textInfo,
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: "0.85rem",
  padding: "0 0.25rem",
  minHeight: 32,
};

/**
 * AC4a / AC4b banner — informational pill for `no_match`, warning pill
 * for `lookup_unavailable`. Never blocks the form; just gives the
 * operator a one-line status and an explicit `Retry`.
 */
export function FaaLookupBanner({ response, onRetry }: Props) {
  if (response.kind === "match") return null;

  if (response.kind === "no_match") {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="faa-lookup-banner"
        data-state="no_match"
        style={{
          ...wrapperBase,
          background: faaTokens.surfaceInfoSubtle,
          color: faaTokens.textInfo,
        }}
      >
        <span>FAA Registry · no record for N-{response.n_number}</span>
        <button type="button" onClick={onRetry} style={retryButton}>
          Retry lookup
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="faa-lookup-banner"
      data-state="lookup_unavailable"
      style={{
        ...wrapperBase,
        background: faaTokens.surfaceWarningSubtle,
        color: faaTokens.textWarningStrong,
      }}
    >
      <span>FAA Registry unavailable</span>
      <button type="button" onClick={onRetry} style={retryButton}>
        Retry
      </button>
    </div>
  );
}
