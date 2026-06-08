import type { CSSProperties } from "react";

import { faaTokens } from "../../lib/page-shell";

interface Props {
  /** ISO-8601 from `freshness.pg_loaded_at`. */
  pgLoadedAt: string | null;
  /** Optional override for the source name. */
  sourceName?: string;
}

const pillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 600,
  background: faaTokens.surfaceInfoSubtle,
  color: faaTokens.textInfo,
};

function formatPgLoadedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/**
 * "Last synced from FAA: {date}" status pill. Renders nothing when
 * the freshness timestamp is null — the FAA pipeline hasn't completed
 * its first load yet, so there's no honest date to show.
 */
export function FaaFreshnessPill({ pgLoadedAt, sourceName = "FAA" }: Props) {
  if (!pgLoadedAt) {
    return (
      <span
        style={{
          ...pillStyle,
          background: "#f3f4f6",
          color: faaTokens.textSecondary,
        }}
        data-testid="faa-freshness-pill"
        data-state="unknown"
      >
        {sourceName} sync not yet run
      </span>
    );
  }
  return (
    <span style={pillStyle} data-testid="faa-freshness-pill" data-state="loaded">
      Last synced from {sourceName}: {formatPgLoadedAt(pgLoadedAt)}
    </span>
  );
}
