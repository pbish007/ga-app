import Link from "next/link";
import { redirect } from "next/navigation";

import { getOptionalSession } from "../../lib/page-auth";
import { pageShellStyles as s } from "../../lib/page-shell";
import { SignupForm } from "./SignupForm";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const session = await getOptionalSession();
  if (session) redirect("/orgs");

  return (
    <main style={{ ...s.main, maxWidth: 440 }}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href="/" style={s.link}>
          ← Home
        </Link>
      </p>
      <h1 style={s.h1}>Create your organization</h1>
      <p style={s.muted}>
        Self-service setup — you&rsquo;ll be the administrator and can add
        aircraft right away.
      </p>
      <SignupForm />
      <p style={s.legalCaution}>
        This application is a record-keeping tool. Airworthiness determination
        is the regulatory responsibility of the certificated mechanic and the
        aircraft owner.
      </p>
    </main>
  );
}
