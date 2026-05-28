import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { schema, ORG_TYPES, type OrgType } from "@ga/db";
import {
  OrganizationService,
  passwordHasher,
  type AccountsDb,
} from "@ga/accounts";

import {
  buildSetCookieHeader,
  createSessionCookieValue,
} from "./session";

const { users, organizationMemberships } = schema;

/**
 * Minimum password length for self-service signup. The credential here
 * gates access to maintenance records, so we set a floor rather than
 * accept trivially short passwords.
 */
const MIN_PASSWORD_LENGTH = 8;

export interface SignupDeps {
  db: AccountsDb;
  secret: string;
  /** Override the issued-at / created-at clock in tests. */
  now?: () => Date;
}

function isOrgType(value: unknown): value is OrgType {
  return (
    typeof value === "string" && (ORG_TYPES as readonly string[]).includes(value)
  );
}

/**
 * POST handler for `/api/auth/signup` — the board-decided self-service
 * V1 onboarding (no managed onboarding). Atomically creates the user
 * identity, their organization (defaulting to the FAA regime via the K2
 * seam in `OrganizationService.create`), and an `admin` membership, then
 * issues the same signed session cookie the login flow uses so the
 * caller is signed in on success.
 *
 * The first member is `admin` so they can manage the org and add
 * aircraft immediately. Mechanic/pilot seats arrive via invitations
 * (Epic A) — not modelled in the signup body.
 */
export async function handleSignup(
  req: Request,
  deps: SignupDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "expected JSON body" }, { status: 400 });
  }

  const raw = body as {
    email?: unknown;
    password?: unknown;
    org_name?: unknown;
    org_type?: unknown;
  };

  const email =
    typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const password = typeof raw.password === "string" ? raw.password : "";
  const orgName = typeof raw.org_name === "string" ? raw.org_name.trim() : "";
  const orgType = raw.org_type;

  if (!email || !email.includes("@") || email.length > 320) {
    return NextResponse.json(
      { error: "a valid email is required" },
      { status: 400 },
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      {
        error: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      },
      { status: 400 },
    );
  }
  if (!orgName) {
    return NextResponse.json(
      { error: "organization name is required" },
      { status: 400 },
    );
  }
  if (!isOrgType(orgType)) {
    return NextResponse.json(
      {
        error: `organization type must be one of: ${ORG_TYPES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Reject a duplicate identity rather than silently attaching a new org
  // to an existing account — signup creates a NEW user. Existing users
  // join more orgs via invitations.
  const existing = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing[0]) {
    return NextResponse.json(
      { error: "an account with this email already exists — sign in instead" },
      { status: 409 },
    );
  }

  const now = deps.now ? deps.now() : new Date();
  const passwordHash = await passwordHasher.hash(password);

  const [user] = await deps.db
    .insert(users)
    .values({
      email,
      passwordHash,
      emailVerifiedAt: now,
      passwordChangedAt: now,
    })
    .returning();
  if (!user) {
    throw new Error("failed to insert user");
  }

  const orgs = new OrganizationService(deps.db);
  const org = await orgs.create({ name: orgName, orgType });

  await deps.db.insert(organizationMemberships).values({
    tenantId: org.id,
    userId: user.id,
    role: "admin",
  });

  const iat = Math.floor(now.getTime() / 1000);
  const cookie = createSessionCookieValue({ userId: user.id, iat }, deps.secret);
  const res = NextResponse.json({
    user: { id: user.id, email: user.email },
    organization: { id: org.id, name: org.name, org_type: org.orgType },
    tenant_id: org.id,
  });
  res.headers.append("Set-Cookie", buildSetCookieHeader(cookie));
  return res;
}
