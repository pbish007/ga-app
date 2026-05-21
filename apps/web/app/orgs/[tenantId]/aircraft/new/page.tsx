import { runPage } from "../../../../../lib/page-auth";
import {
  NOT_AIRWORTHINESS_CAUTION,
  pageShellStyles as s,
} from "../../../../../lib/page-shell";

import { NewAircraftForm } from "./NewAircraftForm";

export const dynamic = "force-dynamic";

interface PageParams {
  tenantId: string;
}

export default async function NewAircraftPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { tenantId } = await params;

  // Permission gate. The form itself is a client component, but the
  // route requires `aircraft.write` membership to render.
  await runPage(tenantId, "aircraft.write", async () => null);

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Add aircraft</h1>
      <p style={s.muted}>
        All fields are required unless marked optional. The regime
        (FAA) is set automatically.
      </p>
      <NewAircraftForm tenantId={tenantId} />
      <p style={s.legalCaution}>{NOT_AIRWORTHINESS_CAUTION}</p>
    </main>
  );
}
