/**
 * Wire-format types matching the BE serializers in
 * apps/web/lib/credentials-handler.ts. Kept here so client + server
 * components share one source of truth.
 */

export interface CredentialDto {
  id: string;
  user_id: string;
  regime_credential_type_id: string;
  certificate_number: string | null;
  ratings: string[];
  issued_on: string;
  expires_on: string | null;
  revoked_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActiveCredentialDto {
  id: string;
  user_id: string;
  regime_credential_type_id: string;
  credential_type_code: string;
  credential_type_name: string;
  authorizes_signoff: boolean;
  certificate_number: string | null;
  ratings: string[];
  issued_on: string;
  expires_on: string | null;
}

export interface CredentialTypeDto {
  id: string;
  code: string;
  name: string;
  authorizes_signoff: boolean;
}
