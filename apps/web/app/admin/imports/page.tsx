import Link from "next/link";
import { redirect } from "next/navigation";

import { isPlatformAdmin } from "../../../lib/auth/platform-admin";
import { getDb } from "../../../lib/db";
import { getOptionalSession } from "../../../lib/page-auth";
import { pageShellStyles as s } from "../../../lib/page-shell";

export const dynamic = "force-dynamic";

export default async function AdminImportsLandingPage() {
  const session = await getOptionalSession();
  if (!session) redirect("/login?next=/admin/imports");
  const db = getDb();
  const ok = await isPlatformAdmin(session.user.id, { db });
  if (!ok) redirect("/orgs");

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
        <Link href="/orgs" style={s.link}>
          ← Organizations
        </Link>
        <Link href="/admin/tenants" style={s.link}>
          Tenants
        </Link>
        <Link href="/admin/audit" style={s.link}>
          Audit feed
        </Link>
      </nav>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ ...s.h1, marginBottom: 0 }}>Imports</h1>
        <Link href="/admin/imports/new" style={s.buttonLink}>
          New import
        </Link>
      </div>
      <p style={s.muted}>
        Platform admin only — signed in as {session.user.email}.
      </p>
      <p style={{ marginTop: "1.25rem" }}>
        Spreadsheet / paper backfill for a tenant. Pick the target table, upload
        a CSV (or XLSX), map columns to fields, review validation errors, then
        commit. The full lifecycle is covered by the four-step wizard.
      </p>
      <p style={s.muted}>
        Looking for an existing job?{" "}
        <Link href="/admin/imports/new" style={s.link}>
          Start the wizard
        </Link>{" "}
        and open the job URL it produces — each job has a deep-linkable status
        page.
      </p>
    </main>
  );
}
