import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, desc } from "drizzle-orm";

import { schema as dbSchema } from "@ga/db";

import { isPlatformAdmin } from "../../../../lib/auth/platform-admin";
import { getDb, getDirectDb } from "../../../../lib/db";
import { getOptionalSession } from "../../../../lib/page-auth";
import { pageShellStyles as s } from "../../../../lib/page-shell";

import { ImportWizard, type RegimeOption, type TenantOption } from "./ImportWizard";

export const dynamic = "force-dynamic";

const { organizations, regimes } = dbSchema;

export default async function NewImportPage() {
  const session = await getOptionalSession();
  if (!session) redirect("/login?next=/admin/imports/new");
  const db = getDb();
  const ok = await isPlatformAdmin(session.user.id, { db });
  if (!ok) redirect("/orgs");
  const directDb = getDirectDb();

  const tenantRowsRaw = await directDb
    .select({
      id: organizations.id,
      name: organizations.name,
      defaultRegimeId: organizations.defaultRegimeId,
    })
    .from(organizations)
    .orderBy(desc(organizations.createdAt));
  const tenants: TenantOption[] = tenantRowsRaw.map((t) => ({
    id: t.id,
    name: t.name,
    defaultRegimeId: t.defaultRegimeId,
  }));

  const regimeRowsRaw = await db
    .select({
      id: regimes.id,
      code: regimes.code,
      name: regimes.name,
      jurisdiction: regimes.jurisdiction,
    })
    .from(regimes)
    .orderBy(asc(regimes.name));
  const regimeOptions: RegimeOption[] = regimeRowsRaw.map((r) => ({
    id: r.id,
    code: r.code,
    label: `${r.name} (${r.jurisdiction})`,
  }));

  return (
    <main style={s.main}>
      <nav
        style={{
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
          fontSize: "0.9rem",
        }}
      >
        <Link href="/admin/imports" style={s.link}>
          ← Imports
        </Link>
        <Link href="/admin/tenants" style={s.link}>
          Tenants
        </Link>
      </nav>
      <h1 style={s.h1}>New import</h1>
      <p style={s.muted}>
        Backfill a tenant from a spreadsheet. Four steps: setup → map → validate
        → commit. Empty cells are treated as "field absent" — the per-entity
        validator decides whether that's an error.
      </p>

      <ImportWizard tenants={tenants} regimes={regimeOptions} />
    </main>
  );
}
