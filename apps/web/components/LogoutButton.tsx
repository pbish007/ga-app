"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Posts to /api/auth/logout (clears the session cookie) then sends the
 * user back to the marketing home. Styled as a compact text button so it
 * sits in the nav without dominating it.
 */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Clearing the cookie is best-effort; navigate regardless.
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={busy}
      style={{
        background: "transparent",
        border: "1px solid #cbd5e1",
        borderRadius: 6,
        padding: "0.35rem 0.7rem",
        fontSize: "0.85rem",
        color: "#334155",
        cursor: busy ? "default" : "pointer",
        minHeight: 36,
        touchAction: "manipulation",
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
