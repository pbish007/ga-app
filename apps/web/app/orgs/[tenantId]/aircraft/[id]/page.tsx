import Link from "next/link";
import { notFound } from "next/navigation";

import {
  AircraftNotFoundError,
  AircraftService,
  ComponentService,
  type AircraftDb,
} from "@ga/aircraft";

import { runPage } from "../../../../../lib/page-auth";
import {
  NOT_AIRWORTHINESS_CAUTION,
  pageShellStyles as s,
} from "../../../../../lib/page-shell";

export const dynamic = "force-dynamic";

interface PageParams {
  tenantId: string;
  id: string;
}

export default async function AircraftDetailPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { tenantId, id } = await params;

  const data = await runPage(
    tenantId,
    "aircraft.read",
    async (tx, ctx) => {
      const aircraftSvc = new AircraftService(tx as unknown as AircraftDb);
      const componentSvc = new ComponentService(tx as unknown as AircraftDb);
      try {
        const aircraft = await aircraftSvc.getById(ctx.tenantId, id);
        const installed = await componentSvc.listInstalledOnAircraft(
          ctx.tenantId,
          aircraft.id,
        );
        return { aircraft, installed };
      } catch (err) {
        if (err instanceof AircraftNotFoundError) return null;
        throw err;
      }
    },
  );

  if (!data) notFound();

  const { aircraft, installed } = data;

  return (
    <main style={s.main}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href={`/orgs/${tenantId}/aircraft`} style={s.link}>
          ← All aircraft
        </Link>
      </p>
      <h1 style={s.h1}>{aircraft.registration}</h1>
      <p style={s.muted}>
        {aircraft.make} {aircraft.model}
        {aircraft.yearManufactured ? ` · ${aircraft.yearManufactured}` : ""}
      </p>

      <div style={{ marginTop: "1rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <Link
          href={`/orgs/${tenantId}/aircraft/${aircraft.id}/log-time`}
          style={s.buttonLink}
        >
          Log flight time
        </Link>
        <Link
          href={`/orgs/${tenantId}/aircraft/${aircraft.id}/compliance`}
          style={{ ...s.buttonLink, background: "#059669" }}
        >
          Compliance
        </Link>
      </div>

      <h2 style={s.h2}>Profile</h2>
      <div style={s.tableWrap}>
        <table style={s.table}>
          <tbody>
            <Row label="Registration" value={aircraft.registration} />
            <Row label="Serial number" value={aircraft.serialNumber} />
            <Row
              label="Category / class"
              value={`${aircraft.category} / ${aircraft.aircraftClass}`}
            />
            <Row
              label="Airframe total time"
              value={`${Number(aircraft.airframeTotalTime).toFixed(1)} hours`}
            />
            <Row
              label="Time source"
              value={aircraft.timeSource === "hobbs" ? "Hobbs" : "Tach"}
            />
          </tbody>
        </table>
      </div>

      <h2 style={s.h2}>Installed components ({installed.length})</h2>
      {installed.length === 0 ? (
        <p>No components are currently installed.</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Kind</th>
                <th style={s.th}>Serial</th>
                <th style={s.th}>Make / Model</th>
                <th style={s.th}>Installed</th>
                <th style={s.th}>Airframe TT at install</th>
              </tr>
            </thead>
            <tbody>
              {installed.map((row) => (
                <tr key={row.installation.id}>
                  <td style={s.td}>{row.component.kind}</td>
                  <td style={s.td}>{row.component.serialNumber}</td>
                  <td style={s.td}>
                    {row.component.make ?? "—"} {row.component.model ?? ""}
                  </td>
                  <td style={s.td}>
                    {row.installation.installedAt.toISOString().slice(0, 10)}
                  </td>
                  <td style={s.td}>
                    {Number(row.installation.installedAtAircraftTotalTime).toFixed(1)}
                  </td>
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td
        style={{
          ...s.td,
          fontWeight: 600,
          background: "#fafafa",
          width: "40%",
        }}
      >
        {label}
      </td>
      <td style={s.td}>{value}</td>
    </tr>
  );
}
