"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { pageShellStyles as s } from "../../lib/page-shell";

const ORG_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "owner", label: "Owner / operator (single aircraft)" },
  { value: "club", label: "Flying club" },
  { value: "school", label: "Flight school" },
  { value: "shop", label: "Maintenance shop" },
];

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgType, setOrgType] = useState("owner");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    email.trim().length > 0 &&
    password.length >= 8 &&
    orgName.trim().length > 0 &&
    !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          org_name: orgName.trim(),
          org_type: orgType,
        }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          tenant_id?: string;
        };
        router.push(
          body.tenant_id ? `/orgs/${body.tenant_id}/aircraft` : "/orgs",
        );
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `Sign up failed (${res.status}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "1.5rem" }}
    >
      <label style={s.field}>
        <span style={s.label}>Organization name</span>
        <input
          type="text"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          placeholder="e.g. Blue Sky Aviation"
          disabled={submitting}
          style={s.input}
          autoFocus
          required
        />
      </label>

      <label style={s.field}>
        <span style={s.label}>Organization type</span>
        <select
          value={orgType}
          onChange={(e) => setOrgType(e.target.value)}
          disabled={submitting}
          style={s.select}
        >
          {ORG_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label style={s.field}>
        <span style={s.label}>Your email</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          style={s.input}
          required
        />
      </label>

      <label style={s.field}>
        <span style={s.label}>Password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          style={s.input}
          minLength={8}
          required
        />
        <span style={{ fontSize: "0.8rem", color: "#666" }}>
          At least 8 characters.
        </span>
      </label>

      {error ? (
        <p
          role="alert"
          style={{
            margin: 0,
            color: "#b91c1c",
            background: "#fef2f2",
            padding: "0.65rem 0.85rem",
            borderRadius: 6,
            border: "1px solid #fecaca",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!canSubmit}
        style={{
          ...s.button,
          width: "100%",
          background: canSubmit ? "#2563eb" : "#9db8f0",
          cursor: canSubmit ? "pointer" : "not-allowed",
        }}
      >
        {submitting ? "Creating…" : "Create organization"}
      </button>

      <p style={{ margin: 0, fontSize: "0.95rem", color: "#444" }}>
        Already have an account?{" "}
        <Link href="/login" style={s.link}>
          Sign in
        </Link>
      </p>
    </form>
  );
}
