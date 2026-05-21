import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";

import {
  AircraftNotFoundError,
  AircraftService,
  SquawkService,
  type AircraftDb,
} from "@ga/aircraft";
import type { SquawkSeverity, SquawkStatus } from "@ga/db";

import { hasPermission } from "@ga/accounts";
import { runPage } from "../../../../../../lib/page-auth";
import {
  NOT_AIRWORTHINESS_CAUTION,
  pageShellStyles as s,
} from "../../../../../../lib/page-shell";
import { ResolveSquawkButton } from "./ResolveSquawkButton";

export const dynamic = "force-dynamic";

interface PageParams {
  tenantId: string;
  id: string;
}

export default async function SquawksPage({
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
      const squawkSvc = new SquawkService(tx as unknown as AircraftDb);
      try {
        const aircraft = await aircraftSvc.getById(ctx.tenantId, id);
        const squawks = await squawkSvc.listForAircraft(ctx.tenantId, aircraft.id);
        const canWrite = hasPermission(ctx.membership, "aircraft.write");
        return { aircraft, squawks, canWrite };
      } catch (err) {
        if (err instanceof AircraftNotFoundError) return null;
        throw err;
      }
    },
  );

  if (!data) notFound();
  const { aircraft, squawks, canWrite } = data;

  const groundingOpen = squawks.filter(
    (sq) => sq.severity === "grounding" && sq.status === "open",
  );

  return (
    <main style={s.main}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href={`/orgs/${tenantId}/aircraft/${aircraft.id}`} style={s.link}>
          ← {aircraft.registration}
        </Link>
      </p>
      <h1 style={s.h1}>Squawks</h1>
      <p style={s.muted}>
        {aircraft.make} {aircraft.model} · {aircraft.registration}
      </p>

      {canWrite ? (
        <div style={{ marginTop: "1rem" }}>
          <Link
            href={`/orgs/${tenantId}/aircraft/${aircraft.id}/squawks/new`}
            style={{ ...s.buttonLink, background: "#dc2626" }}
          >
            File a squawk
          </Link>
        </div>
      ) : null}

      {groundingOpen.length > 0 ? (
        <div
          role="alert"
          style={{
            marginTop: "1rem",
            padding: "0.85rem 1rem",
            background: "#fef2f2",
            border: "2px solid #dc2626",
            borderRadius: 8,
            color: "#7f1d1d",
          }}
        >
          <strong>{aircraft.registration} is grounded.</strong>{" "}
          {groundingOpen.length} open grounding{" "}
          {groundingOpen.length === 1 ? "squawk" : "squawks"} block airworthiness.
        </div>
      ) : null}

      <div style={{ marginTop: "1.5rem" }}>
        {squawks.length === 0 ? (
          <p style={s.muted}>No squawks have been filed for this aircraft.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {squawks.map((sq) => (
              <SquawkCard
                key={sq.id}
                tenantId={tenantId}
                squawkId={sq.id}
                description={sq.description}
                severity={sq.severity}
                status={sq.status}
                occurredAt={sq.occurredAt}
                resolvedAt={sq.resolvedAt}
                resolutionNotes={sq.resolutionNotes}
                canResolve={canWrite && sq.status === "open"}
              />
            ))}
          </ul>
        )}
      </div>

      <p style={s.legalCaution}>{NOT_AIRWORTHINESS_CAUTION}</p>
    </main>
  );
}

const SEVERITY_COLOR: Record<SquawkSeverity, string> = {
  informational: "#1d4ed8",
  deferred: "#d97706",
  grounding: "#dc2626",
};

const SEVERITY_BG: Record<SquawkSeverity, string> = {
  informational: "#eff6ff",
  deferred: "#fffbeb",
  grounding: "#fef2f2",
};

const SEVERITY_LABEL: Record<SquawkSeverity, string> = {
  informational: "Informational",
  deferred: "Deferred",
  grounding: "Grounding",
};

interface SquawkCardProps {
  tenantId: string;
  squawkId: string;
  description: string;
  severity: SquawkSeverity;
  status: SquawkStatus;
  occurredAt: Date;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
  canResolve: boolean;
}

function SquawkCard({
  tenantId,
  squawkId,
  description,
  severity,
  status,
  occurredAt,
  resolvedAt,
  resolutionNotes,
  canResolve,
}: SquawkCardProps) {
  const cardStyle: CSSProperties = {
    border: `1px solid ${status === "resolved" ? "#d1d5db" : SEVERITY_COLOR[severity]}33`,
    background: status === "resolved" ? "#f9fafb" : SEVERITY_BG[severity],
    borderRadius: 8,
    padding: "0.85rem 1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
  };
  return (
    <li style={cardStyle}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <span
          style={{
            padding: "0.15rem 0.55rem",
            borderRadius: 4,
            fontSize: "0.75rem",
            fontWeight: 700,
            color: SEVERITY_COLOR[severity],
            background: "white",
            border: `1px solid ${SEVERITY_COLOR[severity]}55`,
          }}
        >
          {SEVERITY_LABEL[severity]}
        </span>
        <span
          style={{
            padding: "0.15rem 0.55rem",
            borderRadius: 4,
            fontSize: "0.75rem",
            fontWeight: 700,
            color: status === "resolved" ? "#065f46" : "#92400e",
            background: status === "resolved" ? "#d1fae5" : "#fef3c7",
          }}
        >
          {status === "resolved" ? "Resolved" : "Open"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: "0.8rem", color: "#6b7280" }}>
          {occurredAt.toISOString().slice(0, 10)}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: "0.95rem", whiteSpace: "pre-wrap" }}>{description}</p>
      {status === "resolved" ? (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#374151" }}>
          Resolved {resolvedAt ? resolvedAt.toISOString().slice(0, 10) : ""}
          {resolutionNotes ? ` · ${resolutionNotes}` : ""}
        </p>
      ) : null}
      {canResolve ? (
        <div style={{ marginTop: "0.25rem" }}>
          <ResolveSquawkButton tenantId={tenantId} squawkId={squawkId} />
        </div>
      ) : null}
    </li>
  );
}
