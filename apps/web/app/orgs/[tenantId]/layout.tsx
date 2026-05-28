import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { loadOrgNavContext } from "../../../lib/page-auth";
import { LogoutButton } from "../../../components/LogoutButton";

export const dynamic = "force-dynamic";

const navLinkStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 40,
  padding: "0.4rem 0.7rem",
  borderRadius: 6,
  textDecoration: "none",
  color: "#1e293b",
  fontWeight: 600,
  fontSize: "0.9rem",
} as const;

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const result = await loadOrgNavContext(tenantId);
  if (!result.ok) {
    redirect(result.reason === "no-session" ? "/login" : "/orgs");
  }
  const { ctx } = result;

  return (
    <>
      <header
        style={{
          borderBottom: "1px solid #e2e8f0",
          background: "white",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <nav
          style={{
            maxWidth: 960,
            margin: "0 auto",
            padding: "0.6rem clamp(1rem, 4vw, 3rem)",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <Link
            href="/orgs"
            style={{
              ...navLinkStyle,
              fontWeight: 800,
              color: "#2563eb",
              paddingLeft: 0,
            }}
          >
            {ctx.orgName}
          </Link>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.25rem",
              flexWrap: "wrap",
            }}
          >
            <Link href={`/orgs/${tenantId}/aircraft`} style={navLinkStyle}>
              Aircraft
            </Link>
            <Link href={`/orgs/${tenantId}/alerts`} style={navLinkStyle}>
              Alerts
            </Link>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <LogoutButton />
          </div>
        </nav>
      </header>
      {children}
    </>
  );
}
