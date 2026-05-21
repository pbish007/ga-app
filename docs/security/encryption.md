# Encryption posture — TLS in transit + at-rest

> **Scope:** GA App production, Phase A (Neon Free + Vercel Blob). Phase B
> retains the same posture; only the backup retention window changes.
> **Issue of record:** [PMB-24](/PMB/issues/PMB-24).
> **Owner of last resort:** CTO.

This document captures what is enforced today, who enforces it, and the lever
an operator pulls to verify continued enforcement during routine ops. The
J3.1 acceptance criterion is that this posture is documented, linked from
[PMB-9](/PMB/issues/PMB-9), and that an automated check catches a regression.

---

## 1. TLS in transit

| Hop                                      | Termination point      | Enforcement                                                              | Verification                                                                                              |
| ---------------------------------------- | ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **Browser → app**                        | Vercel edge            | Managed certs; HTTPS redirect on by default for the production domain    | `curl -vI https://ga-app-taupe.vercel.app` shows the cert chain (Google Trust Services, `*.vercel.app`, TLS 1.3) and `HTTP/2 200` |
| **App (Vercel Function) → Postgres (Neon)** | Neon endpoint          | `sslmode=require` is mandated by the connection string contract          | `assertSslRequired()` at process startup ([apps/web/lib/db.ts:20](../../apps/web/lib/db.ts)) + `pnpm verify:tls` |
| **App → Vercel Blob (PUT)**              | Vercel Blob API        | `@vercel/blob` SDK uses HTTPS; the SDK has no plaintext mode             | SDK source + the `https://` URL returned on every `put()` call                                            |
| **Browser / app → Blob object**          | Vercel Blob CDN        | Public Blob URLs are `https://*.public.blob.vercel-storage.com/...`      | `curl -vI <returned-url>` — scheme is HTTPS, no HTTP variant is served                                    |

### Why `sslmode=require` and not just default

Postgres clients negotiate TLS by default if the server offers it, but the
default `sslmode=prefer` will silently fall back to plaintext if the server
ever stops offering TLS. `require` rejects the connection instead. We
enforce it at two layers:

- **Application:** `packages/db/src/env.ts:assertSslRequired` runs on the
  first connection open in `apps/web/lib/db.ts`. A missing or weaker
  `sslmode` raises before the first query.
- **Migrations / ops:** `packages/db/scripts/migrate.sh` and
  `packages/db/scripts/drill-verify.sh` refuse to run against a URL that
  doesn't include `sslmode=require` (or stricter).

### The automated check (J3.1 acceptance criterion)

`packages/db/scripts/check-tls.mjs` is the gate:

- Runs as `pnpm verify:tls` from the repo root.
- Wired as `apps/web` `prebuild` — **every Vercel production build runs it
  with the injected `DATABASE_URL`**. A regression to `sslmode=disable`,
  `prefer`, or an empty value hard-fails the deploy (exit 71) before
  Next.js compiles.
- Wired into CI ([.github/workflows/ci.yml](../../.github/workflows/ci.yml))
  with two fixture URLs — one compliant, one with `sslmode=disable` — so the
  gate logic itself stays under test.
- In production builds with no `DATABASE_URL` set the script hard-fails
  (exit 70) rather than soft-skipping. PR-only CI without a secret stays
  green.

---

## 2. Encryption at rest

| Store                | Provider     | Default?  | Algorithm        | Key custody                                | Operator lever                                                                                         |
| -------------------- | ------------ | --------- | ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Postgres data + WAL** | Neon         | Yes, always | AES-256          | Provider-managed (AWS KMS under the hood)  | Neon does not expose a toggle — encryption is mandatory on every tier. Provider docs: <https://neon.tech/docs/security/security-overview> |
| **Vercel Blob objects** | Vercel Blob  | Yes, always | AES-256 (S3-style) | Provider-managed                           | No customer-facing toggle. Provider docs: <https://vercel.com/docs/storage/vercel-blob#security>        |

### KMS posture (Phase A → MVP)

- We do **not** run a customer-managed KMS today. Both Neon and Vercel Blob
  manage the keys for us. This is acceptable for MVP — Phase A's threat
  model is "tenant data must not be readable from a stolen storage volume
  or backup," which provider-managed AES-256 covers.
- Moving to customer-managed keys is a Phase C/V1 question driven by
  enterprise tenant procurement, not by safety. When that lever is needed,
  it will land as a separate epic under [PMB-9](/PMB/issues/PMB-9). Do not
  introduce a BYOK abstraction speculatively — it tangles every storage
  call site.

---

## 3. Continued-enforcement lever (routine ops)

A future operator (oncall, CEO, or a follow-on engineer hire) can re-verify
the posture cold without touching this doc:

1. **Run `pnpm verify:tls` against the production env.**
   ```sh
   vercel env pull .env.production --environment=production
   set -a; source .env.production; set +a
   pnpm verify:tls
   rm .env.production
   ```
   Expect: `check-tls: OK — DATABASE_URL, DATABASE_URL_DIRECT enforce TLS …`.
   A non-zero exit is the regression signal — open an incident issue under
   [PMB-9](/PMB/issues/PMB-9).

2. **Inspect the live cert chain.**
   ```sh
   curl -vI https://ga-app-taupe.vercel.app 2>&1 | grep -E '^\*  (subject|issuer|expire)'
   ```
   Expect a managed cert (today Google Trust Services on a `*.vercel.app`
   wildcard) with at least 14 days until expiry. Vercel rotates these
   automatically; a stale cert is a Vercel platform incident, not a GA
   App issue.

3. **Confirm Neon is still terminating TLS.**
   ```sh
   psql "$DATABASE_URL_DIRECT" -c "SHOW ssl;"
   ```
   Expect `ssl | on`.

4. **Sample a Blob URL is HTTPS-only.**
   ```sh
   curl -sI http://<a-stored-blob-url-with-http-scheme>
   ```
   Expect a redirect to HTTPS or a connection refusal — Vercel Blob does
   not serve plaintext.

This procedure runs in well under five minutes and produces auditable
output. No screenshot or console click-through is required to satisfy the
J3.1 verification cadence.

---

## 4. What we explicitly do not promise

- **No FIPS 140-2 attestation.** Neon and Vercel both run on AWS, which is
  FIPS-validated for the modules they use, but we do not pass that
  attestation through to customers today.
- **No HIPAA or PCI controls.** Aviation maintenance records are not
  regulated under HIPAA/PCI; we do not claim those controls.
- **No customer-managed encryption keys (CMEK / BYOK).** See §2 KMS posture.

If a tenant procurement question raises any of these, route it to the CTO
and treat it as a Phase C epic — not a runtime change.
