import Link from "next/link";

import { AircraftService, type AircraftDb } from "@ga/aircraft";
import { hasPermission } from "@ga/accounts";

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

  const { aircraft, canWrite } = await runPage(
    tenantId,
    "aircraft.read",
    async (tx, ctx) => {
      const svc = new AircraftService(tx as unknown as AircraftDb);
      const rows = await svc.listForTenant(ctx.tenantId);
      return {
        aircraft: rows,
        canWrite: hasPermission(ctx.membership, "aircraft.write"),
      };
    },
  );

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
