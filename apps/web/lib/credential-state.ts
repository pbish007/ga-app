/**
 * Canonical credential state derivation, shared by every credential card.
 *
 * The 60-day `expiring` window matches the IA biennial renewal cycle
 * (March 31) — gives a Director of Maintenance two months to chase a
 * renewal before it blocks signoffs. See PMB-154 §3 for rationale.
 */

export type CredentialState =
  | "current"
  | "expiring"
  | "expired"
  | "revoked"
  | "none";

export interface CredentialLike {
  expiresOn: string | null;
  revokedAt: string | null | Date;
}

const MS_PER_DAY = 86_400_000;
const EXPIRING_WINDOW_DAYS = 60;

function parseYmd(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  // Construct in UTC so we don't drift across timezones at the day boundary.
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export function getCredentialState(
  credential: CredentialLike,
  now: Date = new Date(),
): CredentialState {
  if (credential.revokedAt !== null && credential.revokedAt !== undefined) {
    return "revoked";
  }
  if (credential.expiresOn === null) return "current";
  const expires = parseYmd(credential.expiresOn);
  if (!expires) return "current";
  const today = startOfUtcDay(now);
  if (expires.getTime() <= today.getTime()) return "expired";
  const days = Math.floor((expires.getTime() - today.getTime()) / MS_PER_DAY);
  if (days <= EXPIRING_WINDOW_DAYS) return "expiring";
  return "current";
}

export function daysUntilExpiry(
  expiresOn: string | null,
  now: Date = new Date(),
): number | null {
  if (!expiresOn) return null;
  const expires = parseYmd(expiresOn);
  if (!expires) return null;
  const today = startOfUtcDay(now);
  return Math.floor((expires.getTime() - today.getTime()) / MS_PER_DAY);
}

export function badgeLabel(
  state: CredentialState,
  daysRemaining: number | null,
): string {
  switch (state) {
    case "current":
      return "Current";
    case "expiring":
      return daysRemaining !== null
        ? `Expires in ${daysRemaining}d`
        : "Expiring";
    case "expired":
      return "Expired";
    case "revoked":
      return "Revoked";
    case "none":
      return "No certs";
  }
}

/**
 * Worst-case status across a set of credentials, used by the team-level
 * Credential List table: expired > revoked > expiring > current > none.
 */
export function worstState(
  credentials: CredentialLike[],
  now: Date = new Date(),
): CredentialState {
  if (credentials.length === 0) return "none";
  let worst: CredentialState = "current";
  const order: Record<CredentialState, number> = {
    none: 0,
    current: 1,
    expiring: 2,
    revoked: 3,
    expired: 4,
  };
  for (const c of credentials) {
    const s = getCredentialState(c, now);
    if (order[s] > order[worst]) worst = s;
  }
  return worst;
}
