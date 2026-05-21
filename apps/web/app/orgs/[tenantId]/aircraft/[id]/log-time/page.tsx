import Link from "next/link";
import { notFound } from "next/navigation";

import { AircraftNotFoundError, AircraftService, type AircraftDb } from "@ga/aircraft";

import { runPage } from "../../../../../../lib/page-auth";
import {
  NOT_AIRWORTHINESS_CAUTION,
  pageShellStyles as s,
} from "../../../../../../lib/page-shell";
import { LogTimeForm } from "./LogTimeForm";

export const dynamic = "force-dynamic";

interface PageParams {
  tenantId: string;
  id: string;
}

export default async function LogTimePage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { tenantId, id } = await params;

  const aircraft = await runPage(
    tenantId,
    "aircraft.write",
    async (tx, ctx) => {
      const svc = new AircraftService(tx as unknown as AircraftDb);
      try {
        return await svc.getById(ctx.tenantId, id);
      } catch (err) {
        if (err instanceof AircraftNotFoundError) return null;
        throw err;
      }
    },
  );

  if (!aircraft) notFound();

  return (
    <main style={s.main}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link
          href={`/orgs/${tenantId}/aircraft/${aircraft.id}`}
          style={s.link}
        >
          ← {aircraft.registration}
        </Link>
      </p>
      <h1 style={s.h1}>Log flight time</h1>
      <p style={s.muted}>
        {aircraft.make} {aircraft.model} · {aircraft.registration}
      </p>

      <LogTimeForm
        tenantId={tenantId}
        aircraftId={aircraft.id}
        currentTt={Number(aircraft.airframeTotalTime)}
        registration={aircraft.registration}
      />

      <p style={s.legalCaution}>{NOT_AIRWORTHINESS_CAUTION}</p>
    </main>
  );
}
