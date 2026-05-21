import type { CSSProperties } from "react";

/**
 * Shared inline-styles used by the MVP server-rendered pages. Epic I
 * will replace these with a proper design system + responsive shell;
 * for now we keep the styling minimal, readable, and responsive enough
 * that the layout works at both desktop and phone widths.
 *
 * Mobile-readiness: max-widths cap content so it doesn't sprawl on
 * desktop; padding clamps prevent edge crowding on phones; tables use
 * `display: block` + `overflow-x: auto` so long rows scroll instead of
 * blowing out the viewport.
 */
export const pageShellStyles = {
  main: {
    fontFamily:
      "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "2rem clamp(1rem, 4vw, 3rem)",
    maxWidth: 960,
    margin: "0 auto",
    lineHeight: 1.5,
    color: "#222",
  } as CSSProperties,
  h1: { fontSize: "1.75rem", marginBottom: "0.25rem" } as CSSProperties,
  h2: { fontSize: "1.25rem", marginTop: "2rem", marginBottom: "0.5rem" } as CSSProperties,
  muted: { color: "#666", marginTop: 0 } as CSSProperties,
  tableWrap: {
    overflowX: "auto" as const,
    border: "1px solid #ddd",
    borderRadius: 6,
  } as CSSProperties,
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "0.95rem",
  } as CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: "0.5rem 0.75rem",
    background: "#f6f6f6",
    borderBottom: "1px solid #ddd",
    fontWeight: 600,
  } as CSSProperties,
  td: {
    padding: "0.5rem 0.75rem",
    borderBottom: "1px solid #eee",
  } as CSSProperties,
  field: { display: "flex", flexDirection: "column" as const, gap: "0.25rem" } as CSSProperties,
  label: { fontWeight: 600 } as CSSProperties,
  input: {
    padding: "0.5rem 0.6rem",
    border: "1px solid #ccc",
    borderRadius: 4,
    fontSize: "1rem",
  } as CSSProperties,
  button: {
    padding: "0.6rem 1rem",
    border: "1px solid #2563eb",
    background: "#2563eb",
    color: "white",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: "1rem",
  } as CSSProperties,
  link: { color: "#2563eb" } as CSSProperties,
  legalCaution: {
    marginTop: "2rem",
    fontSize: "0.8rem",
    color: "#888",
    borderTop: "1px solid #eee",
    paddingTop: "1rem",
  } as CSSProperties,
};

/**
 * Standard legal caution surfaced on aircraft-facing pages. Per spec
 * §3.6, the UI must reinforce that airworthiness determination is the
 * mechanic/owner's regulatory responsibility, not the software's.
 */
export const NOT_AIRWORTHINESS_CAUTION =
  "This application is a record-keeping tool. Airworthiness determination is the regulatory responsibility of the certificated mechanic and the aircraft owner. Not for navigational use.";
