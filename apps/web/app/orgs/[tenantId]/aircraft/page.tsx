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
      <h1 style={s.h1}>Aircraft</h1>
      <p style={s.muted}>{aircraft.length} on file</p>

      {canWrite ? (
        <p style={{ marginTop: "1.5rem" }}>
          <Link
            href={`/orgs/${tenantId}/aircraft/new`}
            style={s.link}
            data-testid="new-aircraft-link"
          >
            + Add aircraft
          </Link>
        </p>
      ) : null}

      {aircraft.length === 0 ? (
        <p style={{ marginTop: "2rem" }}>
          No aircraft yet.
          {canWrite
            ? " Add the first one using the link above."
            : " Ask an administrator to add one."}
        </p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Registration</th>
                <th style={s.th}>Make / Model</th>
                <th style={s.th}>S/N</th>
                <th style={s.th}>Year</th>
                <th style={s.th}>Airframe TT</th>
                <th style={s.th}>Time source</th>
              </tr>
            </thead>
            <tbody>
              {aircraft.map((a) => (
                <tr key={a.id}>
                  <td style={s.td}>
                    <Link
                      href={`/orgs/${tenantId}/aircraft/${a.id}`}
                      style={s.link}
                    >
                      {a.registration}
                    </Link>
                  </td>
                  <td style={s.td}>
                    {a.make} {a.model}
                  </td>
                  <td style={s.td}>{a.serialNumber}</td>
                  <td style={s.td}>{a.yearManufactured ?? "—"}</td>
                  <td style={s.td}>{Number(a.airframeTotalTime).toFixed(1)}</td>
                  <td style={s.td}>{a.timeSource}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={s.legalCaution}>{NOT_AIRWORTHINESS_CAUTION}</p>
    </main>
  );
}
