import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";

import { schema } from "@ga/db";

import { isPlatformAdmin } from "../../../../lib/auth/platform-admin";
import { getDb } from "../../../../lib/db";
import { getOptionalSession } from "../../../../lib/page-auth";
import { pageShellStyles as s } from "../../../../lib/page-shell";
import { ProvisionTenantForm, type RegimeOption } from "./ProvisionTenantForm";

export const dynamic = "force-dynamic";

const { regimes } = schema;

export default async function NewTenantPage() {
  const session = await getOptionalSession();
  if (!session) redirect("/login?next=/admin/tenants/new");

  const db = getDb();
  const ok = await isPlatformAdmin(session.user.id, { db });
  if (!ok) redirect("/orgs");

  const regimeRows = await db
    .select({
      id: regimes.id,
      code: regimes.code,
      name: regimes.name,
      jurisdiction: regimes.jurisdiction,
    })
    .from(regimes)
    .where(eq(regimes.active, true))
    .orderBy(asc(regimes.name));

  const regimeOptions: RegimeOption[] = regimeRows.map((r) => ({
    id: r.id,
    code: r.code,
    label: `${r.name} (${r.jurisdiction})`,
  }));

  return (
    <main style={{ ...s.main, maxWidth: 640 }}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href="/admin/tenants" style={s.link}>
          ← All tenants
        </Link>
      </p>
      <h1 style={s.h1}>Provision a tenant</h1>
      <p style={s.muted}>
        Stand up a new organization with an initial administrator. Platform
        admin only — signed in as {session.user.email}.
      </p>
      <ProvisionTenantForm regimes={regimeOptions} />
    </main>
  );
}
