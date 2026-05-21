import type { CSSProperties } from "react";

/**
 * Shared inline-styles for MVP server-rendered pages (I1.1 design-system baseline).
 *
 * Mobile-first constraints:
 * - Touch targets: 44px minimum height/width (spec §4 Epic I).
 * - Viewport: layout.tsx exports `viewport` meta — no explicit tag needed here.
 * - Padding: clamp() prevents edge crowding at 375px and sprawl at 1440px.
 * - Tables: display:block + overflow-x:auto so wide rows scroll rather than
 *   blow out a 375px viewport.
 * - Form inputs: 1rem font prevents iOS auto-zoom on focus.
 */
export const pageShellStyles = {
  main: {
    fontFamily:
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "1.5rem clamp(1rem, 4vw, 3rem)",
    maxWidth: 960,
    margin: "0 auto",
    lineHeight: 1.5,
    color: "#222",
  } as CSSProperties,

  h1: {
    fontSize: "clamp(1.4rem, 4vw, 1.75rem)",
    marginBottom: "0.25rem",
    marginTop: 0,
  } as CSSProperties,

  h2: {
    fontSize: "clamp(1.1rem, 3vw, 1.25rem)",
    marginTop: "2rem",
    marginBottom: "0.5rem",
  } as CSSProperties,

  muted: { color: "#666", marginTop: 0 } as CSSProperties,

  tableWrap: {
    display: "block" as const,
    overflowX: "auto" as const,
    WebkitOverflowScrolling: "touch" as const,
    border: "1px solid #ddd",
    borderRadius: 6,
  } as CSSProperties,

  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "0.95rem",
    minWidth: 320,
  } as CSSProperties,

  th: {
    textAlign: "left" as const,
    padding: "0.6rem 0.75rem",
    background: "#f6f6f6",
    borderBottom: "1px solid #ddd",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  } as CSSProperties,

  td: {
    padding: "0.6rem 0.75rem",
    borderBottom: "1px solid #eee",
    verticalAlign: "top" as const,
  } as CSSProperties,

  /** Stacked field used in forms */
  field: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.35rem",
  } as CSSProperties,

  label: { fontWeight: 600, fontSize: "0.9rem" } as CSSProperties,

  /** 1rem font prevents iOS Safari from auto-zooming on input focus */
  input: {
    padding: "0.65rem 0.75rem",
    border: "1px solid #ccc",
    borderRadius: 6,
    fontSize: "1rem",
    lineHeight: 1.4,
    minHeight: 44,
    width: "100%",
    boxSizing: "border-box" as const,
  } as CSSProperties,

  select: {
    padding: "0.65rem 0.75rem",
    border: "1px solid #ccc",
    borderRadius: 6,
    fontSize: "1rem",
    lineHeight: 1.4,
    minHeight: 44,
    width: "100%",
    boxSizing: "border-box" as const,
    background: "white",
  } as CSSProperties,

  /** Primary action button — 44px minimum touch target */
  button: {
    display: "inline-flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: "0.65rem 1.25rem",
    minHeight: 44,
    border: "none",
    background: "#2563eb",
    color: "white",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: "1rem",
    fontWeight: 600,
    lineHeight: 1.2,
    textDecoration: "none",
    touchAction: "manipulation" as const,
  } as CSSProperties,

  /** Inline text link — not a touch target by itself, use buttonLink for tappable actions */
  link: { color: "#2563eb", textDecoration: "underline" } as CSSProperties,

  /** CTA link styled as a button — 44px touch target */
  buttonLink: {
    display: "inline-flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: "0.65rem 1.25rem",
    minHeight: 44,
    background: "#2563eb",
    color: "white",
    borderRadius: 6,
    fontSize: "1rem",
    fontWeight: 600,
    textDecoration: "none",
    touchAction: "manipulation" as const,
  } as CSSProperties,

  legalCaution: {
    marginTop: "2rem",
    fontSize: "0.8rem",
    color: "#888",
    borderTop: "1px solid #eee",
    paddingTop: "1rem",
  } as CSSProperties,
};

/**
 * Standard legal caution on aircraft-facing pages. Per spec §3.6.
 */
export const NOT_AIRWORTHINESS_CAUTION =
  "This application is a record-keeping tool. Airworthiness determination is the regulatory responsibility of the certificated mechanic and the aircraft owner. Not for navigational use.";
