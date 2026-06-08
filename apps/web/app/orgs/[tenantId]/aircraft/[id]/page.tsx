import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";

import { schema as dbSchema, type OrgType } from "@ga/db";
import {
  AircraftNotFoundError,
  AircraftRegimeChangeService,
  AircraftService,
  ComponentService,
  type AircraftDb,
} from "@ga/aircraft";

import { FaaRegistrySection } from "../../../../../components/faa/FaaRegistrySection";
import { OwnershipHistoryPanel } from "../../../../../components/faa/OwnershipHistoryPanel";
import { runPage } from "../../../../../lib/page-auth";
import {
  NOT_AIRWORTHINESS_CAUTION,
  pageShellStyles as s,
} from "../../../../../lib/page-shell";

const { organizations, regimes } = dbSchema;

const OWNERSHIP_PANEL_ORG_TYPES: ReadonlyArray<OrgType> = ["shop", "owner"];

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
      const db = tx as unknown as AircraftDb;
      const aircraftSvc = new AircraftService(db);
      const componentSvc = new ComponentService(db);
      const regimeChangeSvc = new AircraftRegimeChangeService(db);
      try {
        const aircraft = await aircraftSvc.getById(ctx.tenantId, id);
        const [installed, regimeChanges, orgRow] = await Promise.all([
          componentSvc.listInstalledOnAircraft(ctx.tenantId, aircraft.id),
          regimeChangeSvc.listForAircraft(ctx.tenantId, aircraft.id),
          db
            .select({ orgType: organizations.orgType })
            .from(organizations)
            .where(eq(organizations.id, ctx.tenantId))
            .limit(1),
        ]);
        const orgType = (orgRow[0]?.orgType ?? null) as OrgType | null;
        const regimeIds = new Set<string>([aircraft.regimeId]);
        for (const change of regimeChanges) {
          regimeIds.add(change.fromRegimeId);
          regimeIds.add(change.toRegimeId);
        }
        const regimeRows = regimeIds.size
          ? await db
              .select({ id: regimes.id, code: regimes.code, name: regimes.name })
              .from(regimes)
              .where(inArray(regimes.id, [...regimeIds]))
          : [];
        const regimeByIdEntries = regimeRows.map(
          (r) => [r.id, { code: r.code, name: r.name }] as const,
        );
        return {
          aircraft,
          installed,
          regimeChanges,
          regimeById: Object.fromEntries(regimeByIdEntries),
          orgType,
        };
      } catch (err) {
        if (err instanceof AircraftNotFoundError) return null;
        throw err;
      }
    },
  );

  if (!data) notFound();

  const { aircraft, installed, regimeChanges, regimeById, orgType } = data;
  const currentRegime = regimeById[aircraft.regimeId];
  const showOwnershipHistory =
    orgType != null && OWNERSHIP_PANEL_ORG_TYPES.includes(orgType);

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
        <Link
          href={`/orgs/${tenantId}/aircraft/${aircraft.id}/squawks`}
          style={{ ...s.buttonLink, background: "#dc2626" }}
        >
          Squawks
        </Link>
        <Link
          href={`/orgs/${tenantId}/aircraft/${aircraft.id}/maintenance`}
          style={{ ...s.buttonLink, background: "#7c3aed" }}
        >
          Maintenance log
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
            <Row
              label="Regulatory regime"
              value={
                currentRegime
                  ? `${currentRegime.code} — ${currentRegime.name}`
                  : aircraft.regimeId
              }
            />
          </tbody>
        </table>
      </div>

      <h2 style={s.h2}>FAA Registry</h2>
      <FaaRegistrySection
        tenantId={tenantId}
        aircraftId={aircraft.id}
        registration={aircraft.registration}
        tenantFields={[
          { key: "make", label: "Make", value: aircraft.make },
          { key: "model", label: "Model", value: aircraft.model },
          { key: "serial_number", label: "Serial number", value: aircraft.serialNumber },
          {
            key: "year_manufactured",
            label: "Year manufactured",
            value:
              aircraft.yearManufactured != null
                ? String(aircraft.yearManufactured)
                : null,
          },
          { key: "owner_name", label: "Owner name", value: null },
          { key: "expiration_date", label: "Expiration date", value: null },
        ]}
      />

      {showOwnershipHistory ? (
        <OwnershipHistoryPanel
          tenantId={tenantId}
          aircraftId={aircraft.id}
        />
      ) : null}

      <h2 style={s.h2}>Regime history ({regimeChanges.length})</h2>
      {regimeChanges.length === 0 ? (
        <p style={s.muted}>
          No regime changes recorded. This aircraft has stayed on its birth regime.
        </p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>When</th>
                <th style={s.th}>From</th>
                <th style={s.th}>To</th>
                <th style={s.th}>Actor (user id)</th>
                <th style={s.th}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {regimeChanges.map((change) => {
                const from = regimeById[change.fromRegimeId];
                const to = regimeById[change.toRegimeId];
                return (
                  <tr key={change.id}>
                    <td style={s.td}>
                      {change.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td style={s.td}>{from ? from.code : change.fromRegimeId}</td>
                    <td style={s.td}>{to ? to.code : change.toRegimeId}</td>
                    <td style={s.td}>{change.actorUserId}</td>
                    <td style={s.td}>{change.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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
