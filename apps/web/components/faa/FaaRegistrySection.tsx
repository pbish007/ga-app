"use client";

import { useEffect, useMemo, useState } from "react";

import type { FaaFieldKey } from "@ga/db";

import { faaTokens, pageShellStyles as s } from "../../lib/page-shell";

import { FaaFreshnessPill } from "./FaaFreshnessPill";
import { FaaLookupBanner } from "./FaaLookupBanner";
import { SourceConflictChip } from "./SourceConflictChip";
import type {
  FaaFieldReportReason,
  FaaFieldState,
  ReportPayload,
} from "./types";
import {
  faaValueFor,
  useFaaLookup,
  type FaaLookupValue,
} from "./use-faa-lookup";

interface Decision {
  field_key: FaaFieldKey;
  decision: "accepted_faa" | "tenant_wins" | "faa_reported_wrong";
  faa_value: string | null;
  faa_value_hash: string;
  tenant_value: string | null;
  report_reason: FaaFieldReportReason | null;
  report_note: string | null;
  decided_by_user_id: string;
  decided_at: string;
}

interface TenantFieldValue {
  key: FaaFieldKey;
  label: string;
  value: string | null;
}

interface Props {
  tenantId: string;
  aircraftId: string;
  registration: string;
  /** Tenant-side known values for each FAA-prefillable field. */
  tenantFields: ReadonlyArray<TenantFieldValue>;
}

const containerStyle = {
  marginTop: "0.75rem",
  padding: "1rem",
  border: "1px solid " + faaTokens.actionSecondaryBorder,
  borderRadius: 6,
} as const;

/**
 * Profile-page FAA-registry surface. Hits the lookup endpoint with the
 * aircraft's stored N-number and renders the prefillable fields with
 * `SourceConflictChip` per the ux-pattern. Each chip POSTs to the
 * decisions endpoint — UPSERT keyed on `(aircraft_id, field_key)`.
 */
export function FaaRegistrySection({
  tenantId,
  aircraftId,
  registration,
  tenantFields,
}: Props) {
  const { status: lookupStatus, retry } = useFaaLookup({
    tenantId,
    rawNNumber: registration,
  });

  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [busyKey, setBusyKey] = useState<FaaFieldKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(tenantId)}/aircraft/${encodeURIComponent(aircraftId)}/faa-decisions`,
          { headers: { accept: "application/json", "x-tenant-id": tenantId } },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { decisions: Decision[] };
        if (cancelled) return;
        const next: Record<string, Decision> = {};
        for (const d of body.decisions) next[d.field_key] = d;
        setDecisions(next);
      } catch {
        // soft fail — chip just defaults to "no decision yet"
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [tenantId, aircraftId]);

  async function postDecision(args: {
    fieldKey: FaaFieldKey;
    decision: Decision["decision"];
    faaValue: string | null;
    tenantValue: string | null;
    reportReason?: FaaFieldReportReason;
    reportNote?: string;
  }): Promise<void> {
    setBusyKey(args.fieldKey);
    setError(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(tenantId)}/aircraft/${encodeURIComponent(aircraftId)}/faa-decisions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tenant-id": tenantId,
          },
          body: JSON.stringify({
            field_key: args.fieldKey,
            decision: args.decision,
            faa_value: args.faaValue,
            tenant_value: args.tenantValue,
            report_reason: args.reportReason,
            report_note: args.reportNote,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as
        | { decision: Decision }
        | { error: string };
      if (!res.ok || !("decision" in body)) {
        setError(
          "error" in body && typeof body.error === "string"
            ? body.error
            : `Decision failed (${res.status})`,
        );
        return;
      }
      setDecisions((prev) => ({ ...prev, [args.fieldKey]: body.decision }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  const freshness =
    lookupStatus.kind === "loaded" &&
    (lookupStatus.response.kind === "match" ||
      lookupStatus.response.kind === "no_match")
      ? lookupStatus.response.freshness
      : null;

  const matchValue: FaaLookupValue | null =
    lookupStatus.kind === "loaded" && lookupStatus.response.kind === "match"
      ? lookupStatus.response.value
      : null;

  const expirationFaa =
    matchValue && matchValue.expiration_date
      ? matchValue.expiration_date
      : null;

  const renderable = useMemo(() => {
    return tenantFields.map((tf) => {
      const state = deriveFieldState({
        tenantValue: tf.value,
        lookupStatus,
        decision: decisions[tf.key],
        fieldKey: tf.key,
      });
      return { ...tf, state };
    });
  }, [tenantFields, lookupStatus, decisions]);

  return (
    <section style={containerStyle} data-testid="faa-registry-section">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.75rem",
          marginBottom: "0.75rem",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "1rem" }}>FAA Registry</h3>
        <FaaFreshnessPill pgLoadedAt={freshness?.pg_loaded_at ?? null} />
      </div>

      {lookupStatus.kind === "loaded" &&
      lookupStatus.response.kind !== "match" ? (
        <FaaLookupBanner response={lookupStatus.response} onRetry={retry} />
      ) : null}

      <div style={s.tableWrap}>
        <table style={s.table}>
          <tbody>
            <tr>
              <td
                style={{
                  ...s.td,
                  fontWeight: 600,
                  background: "#fafafa",
                  width: "40%",
                }}
              >
                Registration expiration (FAA)
              </td>
              <td style={s.td}>
                {expirationFaa
                  ? expirationFaa
                  : lookupStatus.kind === "loading"
                    ? "Checking FAA Registry…"
                    : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h4
        style={{
          marginTop: "1rem",
          marginBottom: "0.25rem",
          fontSize: "0.95rem",
        }}
      >
        Field-by-field conflict status
      </h4>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {renderable.map((row) => (
          <li
            key={row.key}
            style={{
              padding: "0.5rem 0",
              borderBottom: "1px solid #eee",
            }}
          >
            <div style={{ fontWeight: 600 }}>{row.label}</div>
            <div
              style={{
                fontSize: "0.85rem",
                color: faaTokens.textSecondary,
                marginTop: 2,
              }}
            >
              Tenant value: {row.value && row.value.length > 0 ? row.value : "—"}
            </div>
            <SourceConflictChip
              sourceName="FAA Registry"
              fieldLabel={row.label}
              state={row.state}
              busy={busyKey === row.key}
              onAccept={() =>
                postDecision({
                  fieldKey: row.key,
                  decision: "accepted_faa",
                  faaValue: matchValue ? faaValueFor(matchValue, row.key) : null,
                  tenantValue: row.value,
                })
              }
              onDecline={() =>
                postDecision({
                  fieldKey: row.key,
                  decision: "tenant_wins",
                  faaValue: matchValue ? faaValueFor(matchValue, row.key) : null,
                  tenantValue: row.value,
                })
              }
              onReport={(payload: ReportPayload) =>
                postDecision({
                  fieldKey: row.key,
                  decision: "faa_reported_wrong",
                  faaValue: matchValue ? faaValueFor(matchValue, row.key) : null,
                  tenantValue: row.value,
                  reportReason: payload.reason,
                  reportNote: payload.note,
                })
              }
              onReopen={() => {
                setDecisions((prev) => {
                  const next = { ...prev };
                  delete next[row.key];
                  return next;
                });
              }}
            />
          </li>
        ))}
      </ul>

      {error ? (
        <p
          role="alert"
          style={{
            marginTop: "0.75rem",
            color: "#b91c1c",
            fontSize: "0.85rem",
          }}
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

function deriveFieldState(args: {
  tenantValue: string | null;
  lookupStatus: ReturnType<typeof useFaaLookup>["status"];
  decision: Decision | undefined;
  fieldKey: FaaFieldKey;
}): FaaFieldState {
  const { tenantValue, lookupStatus, decision, fieldKey } = args;

  if (lookupStatus.kind === "loading") return { kind: "loading" };
  if (lookupStatus.kind === "idle") return { kind: "no_faa_data" };

  if (lookupStatus.response.kind === "lookup_unavailable") {
    return {
      kind: "faa_lookup_error",
      errorKind: lookupStatus.response.error_kind,
    };
  }
  if (lookupStatus.response.kind === "no_match") {
    return { kind: "no_faa_data" };
  }

  const faaValue = faaValueFor(lookupStatus.response.value, fieldKey);
  const syncedAt = lookupStatus.response.freshness.pg_loaded_at ?? "";

  if (decision) {
    switch (decision.decision) {
      case "accepted_faa":
        return {
          kind: "accepted_faa",
          faaValue: decision.faa_value ?? faaValue ?? "",
          acceptedAt: decision.decided_at,
          acceptedByUserId: decision.decided_by_user_id,
        };
      case "tenant_wins":
        return {
          kind: "tenant_wins",
          tenantValue: decision.tenant_value ?? tenantValue ?? "",
          lastDeclinedFaaValueHash: decision.faa_value_hash,
          decidedAt: decision.decided_at,
          decidedByUserId: decision.decided_by_user_id,
        };
      case "faa_reported_wrong":
        return {
          kind: "faa_reported_wrong",
          tenantValue: decision.tenant_value ?? tenantValue ?? "",
          reportedReason: decision.report_reason ?? "other",
          reportedAt: decision.decided_at,
          reportedByUserId: decision.decided_by_user_id,
          note: decision.report_note ?? undefined,
        };
    }
  }

  if (faaValue == null) return { kind: "no_faa_data" };
  const tenant = (tenantValue ?? "").trim();
  if (tenant.length === 0) {
    return { kind: "conflict", faaValue, tenantValue: "", lastSyncedAt: syncedAt };
  }
  if (tenant === faaValue) {
    return { kind: "aligned", faaValue, lastSyncedAt: syncedAt };
  }
  return {
    kind: "conflict",
    faaValue,
    tenantValue: tenant,
    lastSyncedAt: syncedAt,
  };
}
