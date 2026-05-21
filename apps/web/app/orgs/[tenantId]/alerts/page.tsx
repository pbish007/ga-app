import Link from "next/link";
import { sql } from "drizzle-orm";

import { executeRows, listUnseenNotificationsForUser } from "@ga/notifications";

import { runPage } from "../../../../lib/page-auth";
import {
  NOT_AIRWORTHINESS_CAUTION,
  pageShellStyles as s,
} from "../../../../lib/page-shell";

export const dynamic = "force-dynamic";

interface PageParams {
  tenantId: string;
}

interface AlertView {
  id: string;
  level: "due_soon" | "overdue";
  subject: string;
  body: string;
  aircraftId: string;
  registration: string | null;
  createdAt: Date;
}

const styles = {
  list: {
    listStyle: "none",
    margin: "1rem 0 0",
    padding: 0,
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.75rem",
  },
  card: (level: "due_soon" | "overdue") => ({
    padding: "0.85rem 1rem",
    border: `1px solid ${level === "overdue" ? "#dc2626" : "#d97706"}`,
    background: level === "overdue" ? "#fef2f2" : "#fffbeb",
    borderRadius: 8,
    minHeight: 44,
  }),
  badge: (level: "due_soon" | "overdue") => ({
    display: "inline-block",
    padding: "0.1rem 0.5rem",
    borderRadius: 999,
    fontSize: "0.75rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    background: level === "overdue" ? "#dc2626" : "#d97706",
    color: "white",
    marginRight: "0.5rem",
  }),
  subject: { fontWeight: 700, fontSize: "1rem", marginBottom: "0.25rem" },
  body: { fontSize: "0.9rem", color: "#444", whiteSpace: "pre-wrap" as const },
  meta: { fontSize: "0.8rem", color: "#666", marginTop: "0.5rem" },
};

export default async function AlertsPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { tenantId } = await params;

  const alerts = await runPage(tenantId, "aircraft.read", async (tx, ctx) => {
    const rows = await listUnseenNotificationsForUser(tx, ctx.userId);
    // Enrich with the aircraft registration so the list reads like the
    // dashboard. One query per page load is fine — the list is bounded.
    const ids = Array.from(new Set(rows.map((r) => r.aircraftId)));
    const regMap = new Map<string, string>();
    if (ids.length > 0) {
      const acRows = await executeRows<{ id: string; registration: string }>(
        tx,
        sql`
          select id, registration from aircraft
           where id = any(${ids})
        `,
      );
      for (const a of acRows) regMap.set(a.id, a.registration);
    }
    return rows.map<AlertView>((r) => ({
      id: r.id,
      level: r.level,
      subject: r.subject,
      body: r.body,
      aircraftId: r.aircraftId,
      registration: regMap.get(r.aircraftId) ?? null,
      createdAt: r.createdAt,
    }));
  });

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Alerts</h1>
      <p style={s.muted}>
        {alerts.length === 0
          ? "No unseen alerts."
          : `${alerts.length} unseen alert${alerts.length === 1 ? "" : "s"}`}
      </p>

      {alerts.length > 0 && (
        <ul style={styles.list}>
          {alerts.map((alert) => (
            <li key={alert.id} style={styles.card(alert.level)}>
              <div style={styles.subject}>
                <span style={styles.badge(alert.level)}>
                  {alert.level === "overdue" ? "Overdue" : "Due soon"}
                </span>
                {alert.subject}
              </div>
              <div style={styles.body}>{alert.body}</div>
              <div style={styles.meta}>
                {alert.registration ? (
                  <Link
                    href={`/orgs/${tenantId}/aircraft/${alert.aircraftId}/compliance`}
                    style={s.link}
                  >
                    Open {alert.registration} compliance
                  </Link>
                ) : null}
                <span style={{ marginLeft: alert.registration ? "0.75rem" : 0 }}>
                  {alert.createdAt.toISOString().slice(0, 10)}
                </span>
                <form
                  action={`/api/orgs/${tenantId}/notifications/${alert.id}/seen`}
                  method="post"
                  style={{ display: "inline-block", marginLeft: "0.75rem" }}
                >
                  <button type="submit" style={{ ...s.button, padding: "0.35rem 0.75rem", minHeight: 32, fontSize: "0.85rem" }}>
                    Mark seen
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p style={s.legalCaution}>{NOT_AIRWORTHINESS_CAUTION}</p>
    </main>
  );
}
