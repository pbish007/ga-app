import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";

import {
  AircraftNotFoundError,
  AircraftService,
  MaintenanceEntryService,
  type AircraftDb,
} from "@ga/aircraft";
import type { MaintenanceEntry } from "@ga/db";
import { hasPermission } from "@ga/accounts";

import { runPage } from "../../../../../../lib/page-auth";
import {
  NOT_AIRWORTHINESS_CAUTION,
  pageShellStyles as s,
} from "../../../../../../lib/page-shell";
import { SignEntryButton } from "./SignEntryButton";

export const dynamic = "force-dynamic";

interface PageParams {
  tenantId: string;
  id: string;
}

const ENTRY_TYPE_LABEL: Record<string, string> = {
  maintenance: "Maintenance",
  annual_inspection: "Annual inspection",
  "100_hour_inspection": "100-hour inspection",
  inspection_program: "Inspection program",
  ad_compliance: "AD compliance",
};

export default async function MaintenanceLogPage({
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
      const entrySvc = new MaintenanceEntryService(db);
      try {
        const aircraft = await aircraftSvc.getById(ctx.tenantId, id);
        const entries = await entrySvc.listForAircraft(ctx.tenantId, aircraft.id);
        const canWrite = hasPermission(ctx.membership, "aircraft.write");
        return {
          aircraft,
          entries,
          canWrite,
          regimeId: aircraft.regimeId,
          currentUserId: ctx.userId,
        };
      } catch (err) {
        if (err instanceof AircraftNotFoundError) return null;
        throw err;
      }
    },
  );

  if (!data) notFound();
  const { aircraft, entries, canWrite, regimeId, currentUserId } = data;

  const drafts = entries.filter((e) => !e.signedAt);
  const signed = entries.filter((e) => e.signedAt);

  return (
    <main style={s.main}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href={`/orgs/${tenantId}/aircraft/${aircraft.id}`} style={s.link}>
          ← {aircraft.registration}
        </Link>
      </p>
      <h1 style={s.h1}>Maintenance log</h1>
      <p style={s.muted}>
        {aircraft.make} {aircraft.model} · {aircraft.registration}
      </p>

      {canWrite ? (
        <div style={{ marginTop: "1rem" }}>
          <Link
            href={`/orgs/${tenantId}/aircraft/${aircraft.id}/maintenance/new`}
            style={s.buttonLink}
            data-testid="new-maintenance-entry-link"
          >
            + New entry
          </Link>
        </div>
      ) : null}

      {drafts.length > 0 ? (
        <>
          <h2 style={s.h2}>Drafts ready to sign ({drafts.length})</h2>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            {drafts.map((entry) => (
              <EntryCard
                key={entry.id}
                tenantId={tenantId}
                entry={entry}
                canSign={canWrite}
                regimeId={regimeId}
                currentUserId={currentUserId}
              />
            ))}
          </ul>
        </>
      ) : null}

      <h2 style={s.h2}>Signed entries ({signed.length})</h2>
      {signed.length === 0 ? (
        <p style={s.muted}>No signed maintenance entries on file for this aircraft.</p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          {signed.map((entry) => (
            <EntryCard
              key={entry.id}
              tenantId={tenantId}
              entry={entry}
              canSign={false}
              regimeId={regimeId}
              currentUserId={currentUserId}
            />
          ))}
        </ul>
      )}

      <p style={s.legalCaution}>{NOT_AIRWORTHINESS_CAUTION}</p>
    </main>
  );
}

function EntryCard({
  tenantId,
  entry,
  canSign,
  regimeId,
  currentUserId,
}: {
  tenantId: string;
  entry: MaintenanceEntry;
  canSign: boolean;
  regimeId: string;
  currentUserId: string;
}) {
  const isSigned = !!entry.signedAt;
  const cardStyle: CSSProperties = {
    border: `1px solid ${isSigned ? "#d1d5db" : "#fcd34d"}`,
    background: isSigned ? "#f9fafb" : "#fffbeb",
    borderRadius: 8,
    padding: "0.85rem 1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
  };
  const label = ENTRY_TYPE_LABEL[entry.entryType] ?? entry.entryType;

  return (
    <li style={cardStyle}>
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            padding: "0.15rem 0.55rem",
            borderRadius: 4,
            fontSize: "0.75rem",
            fontWeight: 700,
            color: isSigned ? "#065f46" : "#92400e",
            background: isSigned ? "#d1fae5" : "#fef3c7",
          }}
        >
          {isSigned ? "Signed" : "Draft"}
        </span>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.8rem", color: "#6b7280" }}>
          {entry.performedOn}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: "0.95rem", whiteSpace: "pre-wrap" }}>
        {entry.workPerformed}
      </p>
      <p style={{ margin: 0, fontSize: "0.85rem", color: "#4b5563" }}>
        Airframe TT: {Number(entry.aircraftTotalTime).toFixed(1)} h
      </p>
      {isSigned && entry.rtsRenderedBody ? (
        <details
          style={{
            marginTop: "0.25rem",
            fontSize: "0.85rem",
            color: "#374151",
            background: "white",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            padding: "0.5rem 0.75rem",
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontWeight: 600,
              minHeight: 32,
              padding: "0.25rem 0",
            }}
          >
            View return-to-service statement
          </summary>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontFamily: "inherit",
              margin: "0.5rem 0 0",
              fontSize: "0.85rem",
            }}
          >
            {entry.rtsRenderedBody}
          </pre>
          {entry.signedByCertificateNumber ? (
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "#6b7280" }}>
              Signed by certificate {entry.signedByCertificateNumber}
            </p>
          ) : null}
        </details>
      ) : null}
      {canSign && !isSigned ? (
        <div style={{ marginTop: "0.25rem" }}>
          <SignEntryButton
            tenantId={tenantId}
            entryId={entry.id}
            regimeId={regimeId}
            userId={currentUserId}
          />
        </div>
      ) : null}
    </li>
  );
}
