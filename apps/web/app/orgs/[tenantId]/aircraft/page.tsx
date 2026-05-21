import Link from "next/link";
import { sql } from "drizzle-orm";

import { AircraftService, type AircraftDb } from "@ga/aircraft";
import { hasPermission } from "@ga/accounts";
import { executeRows } from "@ga/notifications";

import { runPage } from "../../../../lib/page-auth";
import {
  NOT_AIRWORTHINESS_CAUTION,
  pageShellStyles as s,
} from "../../../../lib/page-shell";

export const dynamic = "force-dynamic";

interface PageParams {
  tenantId: string;
}

const listStyles = {
  list: {
    listStyle: "none",
    margin: "1rem 0 0",
    padding: 0,
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.75rem",
  },
  card: {
    display: "block",
    padding: "0.85rem 1rem",
    border: "1px solid #ddd",
    borderRadius: 8,
    textDecoration: "none",
    color: "inherit",
    background: "white",
    /* ensure at least 44px tap height */
    minHeight: 44,
  },
  cardReg: {
    fontWeight: 700,
    fontSize: "1.05rem",
    color: "#2563eb",
    marginBottom: "0.15rem",
  },
  cardMeta: {
    fontSize: "0.875rem",
    color: "#666",
  },
};

export default async function AircraftListPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { tenantId } = await params;

  const { aircraft, canWrite, alertCounts } = await runPage(
    tenantId,
    "aircraft.read",
    async (tx, ctx) => {
      const svc = new AircraftService(tx as unknown as AircraftDb);
      const rows = await svc.listForTenant(ctx.tenantId);
      const counts = await executeRows<{ level: string; count: string }>(
        tx,
        sql`
          select level, count(*)::text as count
            from notifications
           where user_id = ${ctx.userId}
             and seen_at is null
           group by level
        `,
      );
      const byLevel = Object.fromEntries(
        counts.map((r) => [r.level, Number(r.count)]),
      );
      return {
        aircraft: rows,
        canWrite: hasPermission(ctx.membership, "aircraft.write"),
        alertCounts: {
          overdue: byLevel.overdue ?? 0,
          dueSoon: byLevel.due_soon ?? 0,
        },
      };
    },
  );

  const totalAlerts = alertCounts.overdue + alertCounts.dueSoon;

  return (
    <main style={s.main}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap" as const,
          marginBottom: "0.5rem",
        }}
      >
        <h1 style={{ ...s.h1, marginBottom: 0 }}>Aircraft</h1>
        {canWrite && (
          <Link
            href={`/orgs/${tenantId}/aircraft/new`}
            style={s.buttonLink}
            data-testid="new-aircraft-link"
          >
            + Add aircraft
          </Link>
        )}
      </div>
      <p style={s.muted}>{aircraft.length} on file</p>

      {totalAlerts > 0 && (
        <Link
          href={`/orgs/${tenantId}/alerts`}
          data-testid="alerts-banner"
          style={{
            display: "block",
            padding: "0.75rem 1rem",
            background: alertCounts.overdue > 0 ? "#fef2f2" : "#fffbeb",
            border: `1px solid ${alertCounts.overdue > 0 ? "#dc2626" : "#d97706"}`,
            borderRadius: 8,
            margin: "1rem 0",
            textDecoration: "none",
            color: "inherit",
            minHeight: 44,
          }}
        >
          <strong style={{ color: alertCounts.overdue > 0 ? "#991b1b" : "#92400e" }}>
            {alertCounts.overdue > 0
              ? `${alertCounts.overdue} overdue`
              : null}
            {alertCounts.overdue > 0 && alertCounts.dueSoon > 0 ? ", " : ""}
            {alertCounts.dueSoon > 0 ? `${alertCounts.dueSoon} due soon` : null}
          </strong>{" "}
          <span style={{ fontSize: "0.9rem", color: "#444" }}>
            — open alerts →
          </span>
        </Link>
      )}

      {aircraft.length === 0 ? (
        <p style={{ marginTop: "2rem" }}>
          No aircraft yet.
          {canWrite
            ? " Add the first one using the button above."
            : " Ask an administrator to add one."}
        </p>
      ) : (
        <ul style={listStyles.list}>
          {aircraft.map((a) => (
            <li key={a.id}>
              <Link
                href={`/orgs/${tenantId}/aircraft/${a.id}`}
                style={listStyles.card}
              >
                <div style={listStyles.cardReg}>{a.registration}</div>
                <div style={listStyles.cardMeta}>
                  {a.make} {a.model}
                  {a.yearManufactured ? ` · ${a.yearManufactured}` : ""} ·{" "}
                  {Number(a.airframeTotalTime).toFixed(1)} hrs
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p style={s.legalCaution}>{NOT_AIRWORTHINESS_CAUTION}</p>
    </main>
  );
}
