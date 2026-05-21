import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { and, eq } from "drizzle-orm";

import {
  AircraftNotFoundError,
  AircraftService,
  SquawkService,
  type AircraftDb,
} from "@ga/aircraft";
import type { Squawk } from "@ga/db";
import {
  computeProgramDue,
  rollupAirworthiness,
  type ComplianceStatus,
  type DueSoonThresholds,
  type IntervalDefinition,
  type ProgramDue,
} from "@ga/compliance";
import { schema } from "@ga/db";

import { runPage } from "../../../../../../lib/page-auth";
import {
  NOT_AIRWORTHINESS_CAUTION,
  pageShellStyles as s,
} from "../../../../../../lib/page-shell";

export const dynamic = "force-dynamic";

interface PageParams {
  tenantId: string;
  id: string;
}

export default async function ComplianceDashboardPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { tenantId, id } = await params;

  const data = await runPage(
    tenantId,
    "aircraft.read",
    async (tx, ctx) => {
      const db = tx as unknown as AircraftDb;
      const aircraftSvc = new AircraftService(db);

      let aircraft;
      try {
        aircraft = await aircraftSvc.getById(ctx.tenantId, id);
      } catch (err) {
        if (err instanceof AircraftNotFoundError) return null;
        throw err;
      }

      const airframeTime = Number(aircraft.airframeTotalTime);

      // Load active subscriptions.
      const subs = await (db as Parameters<typeof and>[0] extends never ? never : typeof db)
        .select()
        .from(schema.aircraftInspectionSubscriptions)
        .where(
          and(
            eq(schema.aircraftInspectionSubscriptions.aircraftId, aircraft.id),
            eq(schema.aircraftInspectionSubscriptions.tenantId, ctx.tenantId),
            eq(schema.aircraftInspectionSubscriptions.active, true),
          ),
        );

      const programResults: {
        programId: string;
        programCode: string;
        programName: string;
        result: ProgramDue;
      }[] = [];

      for (const sub of subs) {
        const [tpl] = await (db as typeof db)
          .select()
          .from(schema.regimeInspectionProgramTemplates)
          .where(eq(schema.regimeInspectionProgramTemplates.id, sub.programId));

        if (!tpl) continue;

        const intervalRows = await (db as typeof db)
          .select()
          .from(schema.regimeInspectionProgramIntervals)
          .where(
            eq(schema.regimeInspectionProgramIntervals.templateId, sub.programId),
          );

        const intervals: IntervalDefinition[] = intervalRows.map((row) => ({
          kind: row.kind as IntervalDefinition["kind"],
          value: Number(row.value),
          unit: row.unit,
        }));

        const anchor = {
          at: sub.lastCompliedAt ?? sub.createdAt,
          airframeTime: sub.lastCompliedAirframeTime
            ? Number(sub.lastCompliedAirframeTime)
            : 0,
          cycles: sub.lastCompliedCycles ?? 0,
        };

        const current = { now: new Date(), airframeTime, cycles: 0 };

        const thresholds: DueSoonThresholds = {
          days: sub.dueSoonDaysThreshold,
          hours: Number(sub.dueSoonHoursThreshold),
        };

        programResults.push({
          programId: tpl.id,
          programCode: tpl.code,
          programName: tpl.name,
          result: computeProgramDue(intervals, anchor, current, thresholds),
        });
      }

      const squawkSvc = new SquawkService(db);
      const openGroundingSquawks = await squawkSvc.listOpenGroundingForAircraft(
        ctx.tenantId,
        aircraft.id,
      );

      const inspectionStatus = rollupAirworthiness(
        programResults.map((p) => p.result),
      );
      // E1.3 — an open grounding squawk overrides the inspection rollup.
      const airworthinessStatus: ComplianceStatus =
        openGroundingSquawks.length > 0 ? "overdue" : inspectionStatus;

      return {
        aircraft,
        airframeTime,
        programResults,
        airworthinessStatus,
        openGroundingSquawks,
      };
    },
  );

  if (!data) notFound();

  const {
    aircraft,
    airframeTime,
    programResults,
    airworthinessStatus,
    openGroundingSquawks,
  } = data;

  return (
    <main style={s.main}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href={`/orgs/${tenantId}/aircraft/${aircraft.id}`} style={s.link}>
          ← {aircraft.registration}
        </Link>
      </p>
      <h1 style={s.h1}>Compliance Dashboard</h1>
      <p style={s.muted}>
        {aircraft.registration} · {aircraft.make} {aircraft.model} ·{" "}
        {airframeTime.toFixed(1)} hours
      </p>

      <AirworthinessIndicator status={airworthinessStatus} />

      {openGroundingSquawks.length > 0 ? (
        <GroundingSquawksPanel
          tenantId={tenantId}
          aircraftId={aircraft.id}
          squawks={openGroundingSquawks}
        />
      ) : null}

      {programResults.length === 0 ? (
        <p style={{ marginTop: "1.5rem", color: "#666" }}>
          No inspection programs are subscribed to this aircraft. Subscribe to
          programs in the aircraft settings to track compliance.
        </p>
      ) : (
        <div style={{ marginTop: "1.5rem" }}>
          {programResults.map(({ programId, programCode, programName, result }) => (
            <ProgramCard
              key={programId}
              code={programCode}
              name={programName}
              result={result}
            />
          ))}
        </div>
      )}

      <p style={s.legalCaution}>{NOT_AIRWORTHINESS_CAUTION}</p>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<ComplianceStatus, string> = {
  ok: "#16a34a",
  due_soon: "#d97706",
  overdue: "#dc2626",
};

const STATUS_BG: Record<ComplianceStatus, string> = {
  ok: "#f0fdf4",
  due_soon: "#fffbeb",
  overdue: "#fef2f2",
};

const STATUS_LABEL: Record<ComplianceStatus, string> = {
  ok: "OK",
  due_soon: "Due Soon",
  overdue: "OVERDUE",
};

function StatusBadge({ status }: { status: ComplianceStatus }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.2rem 0.6rem",
        borderRadius: 4,
        fontSize: "0.8rem",
        fontWeight: 700,
        letterSpacing: "0.02em",
        color: STATUS_COLOR[status],
        background: STATUS_BG[status],
        border: `1px solid ${STATUS_COLOR[status]}33`,
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function GroundingSquawksPanel({
  tenantId,
  aircraftId,
  squawks,
}: {
  tenantId: string;
  aircraftId: string;
  squawks: Squawk[];
}) {
  return (
    <div
      style={{
        marginTop: "1rem",
        padding: "0.85rem 1rem",
        background: "#fef2f2",
        border: "1px solid #dc2626",
        borderRadius: 8,
      }}
    >
      <p style={{ margin: 0, fontWeight: 700, color: "#7f1d1d" }}>
        {squawks.length} open grounding{" "}
        {squawks.length === 1 ? "squawk" : "squawks"} ground this aircraft
      </p>
      <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem", color: "#7f1d1d" }}>
        {squawks.slice(0, 3).map((sq) => (
          <li key={sq.id} style={{ fontSize: "0.9rem" }}>
            {sq.description}
          </li>
        ))}
      </ul>
      <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
        <Link
          href={`/orgs/${tenantId}/aircraft/${aircraftId}/squawks`}
          style={{ ...s.link, color: "#7f1d1d" }}
        >
          Review and resolve squawks →
        </Link>
      </p>
    </div>
  );
}

function AirworthinessIndicator({ status }: { status: ComplianceStatus }) {
  const headline =
    status === "overdue"
      ? "One or more inspections are OVERDUE"
      : status === "due_soon"
        ? "Inspections coming due soon"
        : "All inspections current";

  return (
    <div
      style={{
        marginTop: "1rem",
        padding: "1rem 1.25rem",
        borderRadius: 8,
        border: `2px solid ${STATUS_COLOR[status]}`,
        background: STATUS_BG[status],
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
      }}
    >
      <span
        style={{ fontSize: "1.5rem", lineHeight: 1 }}
        aria-hidden="true"
      >
        {status === "overdue" ? "✗" : status === "due_soon" ? "⚠" : "✓"}
      </span>
      <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontWeight: 700,
            color: STATUS_COLOR[status],
            fontSize: "1rem",
          }}
        >
          {headline}
        </p>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "#666", marginTop: 2 }}>
          Aircraft-level airworthiness indicator
        </p>
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

function formatMargin(
  remainingDays: number | null,
  remainingHours: number | null,
  remainingCycles: number | null,
): string {
  if (remainingHours !== null) {
    const abs = Math.abs(remainingHours);
    return remainingHours < 0
      ? `${abs.toFixed(1)} hours overdue`
      : `${abs.toFixed(1)} hours remaining`;
  }
  if (remainingDays !== null) {
    const abs = Math.round(Math.abs(remainingDays));
    return remainingDays < 0
      ? `${abs} days overdue`
      : `${abs} days remaining`;
  }
  if (remainingCycles !== null) {
    const abs = Math.abs(remainingCycles);
    return remainingCycles < 0
      ? `${abs} cycles overdue`
      : `${abs} cycles remaining`;
  }
  return "—";
}

function ProgramCard({
  code,
  name,
  result,
}: {
  code: string;
  name: string;
  result: ProgramDue;
}) {
  const cardStyle: CSSProperties = {
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    marginBottom: "1rem",
    overflow: "hidden",
  };

  const headerStyle: CSSProperties = {
    padding: "0.75rem 1rem",
    background: "#fafafa",
    borderBottom: "1px solid #e5e7eb",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    flexWrap: "wrap",
  };

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <div>
          <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>{name}</span>
          <span style={{ color: "#9ca3af", fontSize: "0.8rem", marginLeft: "0.5rem" }}>
            {code}
          </span>
        </div>
        <StatusBadge status={result.status} />
      </div>

      {result.intervals.length === 0 ? (
        <p style={{ margin: "0.75rem 1rem", color: "#666", fontSize: "0.9rem" }}>
          Custom program — no tracked intervals.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ ...s.table, minWidth: 400 }}>
            <thead>
              <tr>
                <th style={s.th}>Type</th>
                <th style={s.th}>Due at</th>
                <th style={s.th}>Margin</th>
                <th style={s.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {result.intervals.map((iv, i) => {
                const dueLabel =
                  iv.dueAt
                    ? iv.dueAt.toISOString().slice(0, 10)
                    : iv.dueAtAirframeTime !== null
                      ? `${iv.dueAtAirframeTime.toFixed(1)} hrs TT`
                      : iv.dueAtCycles !== null
                        ? `${iv.dueAtCycles} cycles`
                        : "—";

                const marginLabel = formatMargin(
                  iv.remainingDays,
                  iv.remainingHours,
                  iv.remainingCycles,
                );

                const isDriver = result.driver?.interval === iv.interval;

                return (
                  <tr key={i} style={isDriver ? { background: STATUS_BG[iv.status] } : undefined}>
                    <td style={s.td}>
                      <span style={{ fontWeight: isDriver ? 700 : 400 }}>
                        {iv.interval.value} {iv.interval.unit}
                        {isDriver && (
                          <span
                            style={{ color: "#9ca3af", fontSize: "0.75rem", marginLeft: "0.3rem" }}
                          >
                            (driver)
                          </span>
                        )}
                      </span>
                    </td>
                    <td style={s.td}>{dueLabel}</td>
                    <td
                      style={{
                        ...s.td,
                        color: STATUS_COLOR[iv.status],
                        fontWeight: iv.status !== "ok" ? 600 : 400,
                      }}
                    >
                      {marginLabel}
                    </td>
                    <td style={s.td}>
                      <StatusBadge status={iv.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
