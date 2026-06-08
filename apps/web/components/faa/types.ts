/**
 * FE-only types for the FAA prefill UX (PMB-112 ux-pattern, PMB-212).
 *
 * `FaaFieldState` mirrors the union UXDesigner published — kept
 * verbatim here so the `SourceConflictChip` component can be reused
 * for non-FAA "authoritative source vs tenant value" surfaces later
 * (ICAO, ATA, OEM parts). Lookup-endpoint / decision-endpoint shapes
 * live next to the handlers; this file is intentionally not coupled
 * to them.
 */

export type FaaFieldReportReason =
  | "registry_typo"
  | "stale_data"
  | "wrong_tail"
  | "other";

export type FaaFieldState =
  | { kind: "loading" }
  | { kind: "no_faa_data" }
  | {
      kind: "faa_lookup_error";
      errorKind: "timeout" | "server_error" | "rate_limited";
      retriableAt?: string;
    }
  | { kind: "aligned"; faaValue: string; lastSyncedAt: string }
  | {
      kind: "conflict";
      faaValue: string;
      tenantValue: string;
      lastSyncedAt: string;
    }
  | {
      kind: "tenant_wins";
      tenantValue: string;
      lastDeclinedFaaValueHash: string;
      decidedAt: string;
      decidedByUserId: string;
    }
  | {
      kind: "accepted_faa";
      faaValue: string;
      acceptedAt: string;
      acceptedByUserId: string;
    }
  | {
      kind: "faa_reported_wrong";
      tenantValue: string;
      reportedReason: FaaFieldReportReason;
      reportedAt: string;
      reportedByUserId: string;
      note?: string;
    };

export interface ReportPayload {
  reason: FaaFieldReportReason;
  note?: string;
}
