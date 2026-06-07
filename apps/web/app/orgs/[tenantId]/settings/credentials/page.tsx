import Link from "next/link";

import type { AccountsDb } from "@ga/accounts";

import { runPage } from "../../../../../lib/page-auth";
import { pageShellStyles as s } from "../../../../../lib/page-shell";
import {
  loadTeamCredentialSummary,
  type TeamCredentialSummaryRow,
} from "../../../../../lib/credentials/team-list";

import { CredentialStatusBadge } from "../../../../../components/credentials/CredentialStatusBadge";
import { worstState } from "../../../../../lib/credential-state";

export const dynamic = "force-dynamic";

interface PageParams {
  tenantId: string;
}

export default async function CredentialsListPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { tenantId } = await params;

  const rows = await runPage(
    tenantId,
    "credential.manage",
    (tx): Promise<TeamCredentialSummaryRow[]> =>
      loadTeamCredentialSummary(tx as unknown as AccountsDb, tenantId),
  );

  return (
    <main style={s.main}>
      <p style={{ marginBottom: "0.5rem" }}>
        <Link href={`/orgs/${tenantId}/aircraft`} style={s.link}>
          ← Back
        </Link>
      </p>
      <h1 style={s.h1}>Settings · Credentials</h1>
      <p style={s.muted}>
        Certificate records for compliance and signoff.
      </p>

      {rows.length === 0 ? (
        <p style={{ marginTop: "2rem" }}>
          No team members yet. Add people from the Team settings page.
        </p>
      ) : (
        <div style={{ ...s.tableWrap, marginTop: "1.5rem" }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Member</th>
                <th style={s.th}>Role</th>
                <th style={s.th}>Credentials</th>
                <th style={s.th}>Status</th>
                <th style={s.th} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const state = worstState(row.credentials);
                const summary =
                  row.credentials.length === 0
                    ? "(none)"
                    : row.credentials.map((c) => c.typeName).join(" · ");
                return (
                  <tr key={row.userId}>
                    <td style={s.td}>
                      <strong>{row.email}</strong>
                    </td>
                    <td style={s.td}>{row.role}</td>
                    <td style={s.td}>{summary}</td>
                    <td style={s.td}>
                      <CredentialStatusBadge state={state} />
                    </td>
                    <td style={s.td}>
                      <Link
                        href={`/orgs/${tenantId}/settings/credentials/${row.userId}`}
                        style={s.link}
                        data-testid={`credential-row-link-${row.userId}`}
                      >
                        Edit →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ ...s.muted, marginTop: "1.5rem", fontSize: "0.85rem" }}>
        Showing {rows.length} of {rows.length} team member
        {rows.length === 1 ? "" : "s"}
      </p>
    </main>
  );
}
