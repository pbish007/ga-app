import Link from "next/link";
import { redirect } from "next/navigation";

import { getOptionalSession } from "../lib/page-auth";
import { pageShellStyles as s } from "../lib/page-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getOptionalSession();
  if (session) redirect("/orgs");

  return (
    <main style={{ ...s.main, maxWidth: 640 }}>
      <h1 style={{ ...s.h1, fontSize: "clamp(1.6rem, 5vw, 2.1rem)" }}>
        General Aviation Maintenance
      </h1>
      <p style={{ ...s.muted, fontSize: "1.05rem" }}>
        Always know what maintenance is due, what is overdue, and whether your
        aircraft is legal to fly — and prove it to an inspector, insurer, or
        buyer.
      </p>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginTop: "1.5rem",
        }}
      >
        <Link href="/signup" style={s.buttonLink} data-testid="home-signup">
          Get started
        </Link>
        <Link
          href="/login"
          style={{
            ...s.buttonLink,
            background: "white",
            color: "#2563eb",
            border: "1px solid #2563eb",
          }}
          data-testid="home-login"
        >
          Sign in
        </Link>
      </div>

      <ul
        style={{
          marginTop: "2rem",
          paddingLeft: "1.1rem",
          color: "#333",
          lineHeight: 1.7,
        }}
      >
        <li>Track inspections, time/usage, and airworthiness in one place.</li>
        <li>Credential-gated maintenance sign-off with a frozen record.</li>
        <li>FAA today — built regime-ready for other jurisdictions.</li>
      </ul>

      <p style={{ marginTop: "2rem", fontSize: "0.85rem", color: "#888" }}>
        Service status: <Link href="/health" style={s.link}>/health</Link>
      </p>

      <p style={s.legalCaution}>
        This application is a record-keeping tool. Airworthiness determination
        is the regulatory responsibility of the certificated mechanic and the
        aircraft owner. Not for navigational use.
      </p>
    </main>
  );
}
