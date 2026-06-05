"use client";

import { useMemo, useState } from "react";

import { colorTokens, pageShellStyles as s } from "../../../../../../lib/page-shell";

import { CredentialCard } from "../../../../../../components/credentials/CredentialCard";
import { CredentialDeleteConfirm } from "../../../../../../components/credentials/CredentialDeleteConfirm";
import { CredentialFormModal } from "../../../../../../components/credentials/CredentialFormModal";
import type {
  CredentialDto,
  CredentialTypeDto,
} from "../../../../../../components/credentials/types";

interface Props {
  tenantId: string;
  userId: string;
  userDisplayName: string;
  initialCredentials: CredentialDto[];
  credentialTypes: CredentialTypeDto[];
  initialTypeNames: Record<string, string>;
}

type Modal =
  | { kind: "create" }
  | { kind: "edit"; credential: CredentialDto }
  | { kind: "delete"; credential: CredentialDto }
  | { kind: "none" };

export function UserCredentialsClient({
  tenantId,
  userId,
  userDisplayName,
  initialCredentials,
  credentialTypes,
  initialTypeNames,
}: Props) {
  const [credentials, setCredentials] = useState<CredentialDto[]>(
    initialCredentials,
  );
  const [typeNames, setTypeNames] = useState<Record<string, string>>(
    initialTypeNames,
  );
  const [modal, setModal] = useState<Modal>({ kind: "none" });

  const typeNameLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of credentialTypes) map.set(t.id, t.name);
    return map;
  }, [credentialTypes]);

  function nameFor(credential: CredentialDto): string {
    return (
      typeNames[credential.id] ??
      typeNameLookup.get(credential.regime_credential_type_id) ??
      "Certificate"
    );
  }

  function handleSaved(updated: CredentialDto) {
    setCredentials((prev) => {
      const idx = prev.findIndex((c) => c.id === updated.id);
      if (idx === -1) return [updated, ...prev];
      const next = prev.slice();
      next[idx] = updated;
      return next;
    });
    setTypeNames((prev) => ({
      ...prev,
      [updated.id]:
        typeNameLookup.get(updated.regime_credential_type_id) ??
        prev[updated.id] ??
        "Certificate",
    }));
  }

  function handleDeleted(revoked: CredentialDto) {
    setCredentials((prev) => prev.filter((c) => c.id !== revoked.id));
  }

  const addButton = (
    <button
      type="button"
      style={{ ...s.button }}
      onClick={() => setModal({ kind: "create" })}
      data-testid="credential-add-button"
    >
      + Add certificate
    </button>
  );

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          marginTop: "1rem",
        }}
      >
        <h2 style={{ ...s.h2, marginTop: 0 }}>Certificates</h2>
        {addButton}
      </div>

      {credentials.length === 0 ? (
        <div
          style={{
            border: `1px solid ${colorTokens.cardBorder}`,
            borderRadius: 6,
            padding: 20,
            background: "#fafafa",
            marginTop: "1rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            alignItems: "flex-start",
          }}
          data-testid="credential-empty-state"
        >
          <strong>No certificate records</strong>
          <p style={{ margin: 0, color: "#374151" }}>
            {userDisplayName} cannot sign off maintenance entries until at
            least one authorizing certificate is added.
          </p>
          {addButton}
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
            marginTop: "1rem",
          }}
        >
          {credentials.map((credential) => (
            <CredentialCard
              key={credential.id}
              credential={credential}
              typeName={nameFor(credential)}
              userDisplayName={userDisplayName}
              onEdit={() => setModal({ kind: "edit", credential })}
              onDelete={() => setModal({ kind: "delete", credential })}
            />
          ))}
        </div>
      )}

      <CredentialFormModal
        mode="create"
        open={modal.kind === "create"}
        onClose={() => setModal({ kind: "none" })}
        onSaved={handleSaved}
        tenantId={tenantId}
        userId={userId}
        userDisplayName={userDisplayName}
        credentialTypes={credentialTypes}
      />

      {modal.kind === "edit" ? (
        <CredentialFormModal
          mode="edit"
          open
          onClose={() => setModal({ kind: "none" })}
          onSaved={handleSaved}
          tenantId={tenantId}
          userId={userId}
          credential={modal.credential}
          userDisplayName={userDisplayName}
          credentialTypes={credentialTypes}
        />
      ) : null}

      <CredentialDeleteConfirm
        open={modal.kind === "delete"}
        onClose={() => setModal({ kind: "none" })}
        onDeleted={handleDeleted}
        tenantId={tenantId}
        credential={modal.kind === "delete" ? modal.credential : null}
        typeName={
          modal.kind === "delete" ? nameFor(modal.credential) : "Certificate"
        }
        userDisplayName={userDisplayName}
      />
    </>
  );
}
