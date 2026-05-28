"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { pageShellStyles as s } from "../../lib/page-shell";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (res.ok) {
        router.push("/orgs");
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(
        res.status === 401
          ? "Email or password is incorrect."
          : body.error ?? `Sign in failed (${res.status}).`,
      );
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
        <span style={s.label}>Email</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          style={s.input}
          autoFocus
          required
        />
      </label>

      <label style={s.field}>
        <span style={s.label}>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          style={s.input}
          required
        />
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
        {submitting ? "Signing in…" : "Sign in"}
      </button>

      <p style={{ margin: 0, fontSize: "0.95rem", color: "#444" }}>
        New here?{" "}
        <Link href="/signup" style={s.link}>
          Create an organization
        </Link>
      </p>
    </form>
  );
}
