import Link from "next/link";
import { redirect } from "next/navigation";

import {
  listUserOrganizations,
  requireUser,
  type UserOrganization,
} from "../../lib/page-auth";
import { pageShellStyles as s } from "../../lib/page-shell";
import { LogoutButton } from "../../components/LogoutButton";

export const dynamic = "force-dynamic";

const ORG_TYPE_LABEL: Record<UserOrganization["orgType"], string> = {
  owner: "Owner / operator",
  club: "Flying club",
  school: "Flight school",
  shop: "Maintenance shop",
};

export default async function OrgsIndexPage() {
  const { userId, email } = await requireUser();
  const orgs = await listUserOrganizations(userId);

  // Single membership: skip the chooser and drop straight into the org.
  if (orgs.length === 1) {
    redirect(`/orgs/${orgs[0]!.tenantId}/aircraft`);
  }

  return (
    <main style={s.main}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ ...s.h1, marginBottom: 0 }}>Your organizations</h1>
        <LogoutButton />
      </div>
      <p style={s.muted}>Signed in as {email}</p>

      {orgs.length === 0 ? (
        <div style={{ marginTop: "1.5rem" }}>
          <p>You aren&rsquo;t a member of any organization yet.</p>
          <Link href="/signup" style={s.buttonLink}>
            Create an organization
          </Link>
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: "1.25rem 0 0",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          {orgs.map((o) => (
            <li key={o.tenantId}>
              <Link
                href={`/orgs/${o.tenantId}/aircraft`}
                style={{
                  display: "block",
                  padding: "0.85rem 1rem",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  textDecoration: "none",
                  color: "inherit",
                  background: "white",
                  minHeight: 44,
                }}
              >
                <div style={{ fontWeight: 700, color: "#2563eb" }}>{o.name}</div>
                <div style={{ fontSize: "0.85rem", color: "#666" }}>
                  {ORG_TYPE_LABEL[o.orgType]} · your role: {o.role}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p style={s.legalCaution}>
        This application is a record-keeping tool. Airworthiness determination
        is the regulatory responsibility of the certificated mechanic and the
        aircraft owner.
      </p>
    </main>
  );
}
