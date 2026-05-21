"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { pageShellStyles as s } from "../../../../../../../lib/page-shell";

const SEVERITY_OPTIONS: {
  value: "informational" | "deferred" | "grounding";
  label: string;
  hint: string;
  color: string;
}[] = [
  {
    value: "informational",
    label: "Informational",
    hint: "Note only — no airworthiness impact.",
    color: "#1d4ed8",
  },
  {
    value: "deferred",
    label: "Deferred",
    hint: "Acknowledged; work deferred per MEL or operator policy.",
    color: "#d97706",
  },
  {
    value: "grounding",
    label: "Grounding",
    hint: "Aircraft is NOT airworthy until this is resolved.",
    color: "#dc2626",
  },
];

interface Props {
  tenantId: string;
  aircraftId: string;
  registration: string;
}

interface PendingPhoto {
  documentId: string;
  filename: string;
  uploading: boolean;
  error?: string;
}

export function FileSquawkForm({ tenantId, aircraftId, registration }: Props) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<
    "informational" | "deferred" | "grounding"
  >("deferred");
  const [occurredAt, setOccurredAt] = useState(() => isoLocalNow());
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const descriptionTrimmed = description.trim();
  const canSubmit =
    descriptionTrimmed.length > 0 &&
    !submitting &&
    !photos.some((p) => p.uploading);

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset input so the same file can be re-picked
    if (!file) return;

    const pending: PendingPhoto = {
      documentId: "",
      filename: file.name,
      uploading: true,
    };
    setPhotos((prev) => [...prev, pending]);

    const form = new FormData();
    form.append("file", file);
    form.append("tenant_id", tenantId);
    form.append("document_type", "squawk_photo");

    try {
      const res = await fetch("/api/attachments", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPhotos((prev) =>
          prev.map((p) =>
            p === pending
              ? {
                  ...pending,
                  uploading: false,
                  error: body.error ?? `Upload failed (${res.status})`,
                }
              : p,
          ),
        );
        return;
      }
      const body = (await res.json()) as { id: string };
      setPhotos((prev) =>
        prev.map((p) =>
          p === pending
            ? { ...pending, documentId: body.id, uploading: false }
            : p,
        ),
      );
    } catch (err) {
      setPhotos((prev) =>
        prev.map((p) =>
          p === pending
            ? {
                ...pending,
                uploading: false,
                error: err instanceof Error ? err.message : "Upload failed",
              }
            : p,
        ),
      );
    }
  }

  function removePhoto(idx: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const photoDocumentIds = photos
        .filter((p) => p.documentId && !p.uploading && !p.error)
        .map((p) => p.documentId);
      const res = await fetch(
        `/api/orgs/${tenantId}/aircraft/${aircraftId}/squawks`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            description: descriptionTrimmed,
            severity,
            occurred_at: new Date(occurredAt).toISOString(),
            photo_document_ids: photoDocumentIds,
          }),
        },
      );
      if (res.status === 201) {
        router.push(`/orgs/${tenantId}/aircraft/${aircraftId}/squawks`);
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `Request failed (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <label style={s.field}>
        <span style={s.label}>What happened?</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="e.g. Pitot tube blocked; airspeed reads 0 in climb"
          disabled={submitting}
          style={{
            ...s.input,
            minHeight: 96,
            fontFamily: "inherit",
            resize: "vertical",
          }}
          autoFocus
        />
      </label>

      <label style={s.field}>
        <span style={s.label}>When?</span>
        <input
          type="datetime-local"
          value={occurredAt}
          onChange={(e) => setOccurredAt(e.target.value)}
          style={s.input}
          disabled={submitting}
        />
      </label>

      <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
        <legend style={{ ...s.label, marginBottom: "0.35rem" }}>Severity</legend>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {SEVERITY_OPTIONS.map((opt) => {
            const selected = severity === opt.value;
            return (
              <label
                key={opt.value}
                style={{
                  display: "flex",
                  gap: "0.6rem",
                  alignItems: "flex-start",
                  padding: "0.65rem 0.85rem",
                  minHeight: 44,
                  borderRadius: 6,
                  border: `1px solid ${selected ? opt.color : "#d1d5db"}`,
                  background: selected ? `${opt.color}11` : "white",
                  cursor: "pointer",
                  touchAction: "manipulation",
                }}
              >
                <input
                  type="radio"
                  name="severity"
                  value={opt.value}
                  checked={selected}
                  onChange={() => setSeverity(opt.value)}
                  disabled={submitting}
                  style={{ marginTop: 4, accentColor: opt.color }}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <strong style={{ color: opt.color }}>{opt.label}</strong>
                  <span style={{ fontSize: "0.85rem", color: "#4b5563" }}>{opt.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
        <legend style={{ ...s.label, marginBottom: "0.35rem" }}>Photos (optional)</legend>
        {photos.length > 0 ? (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: "0 0 0.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.35rem",
            }}
          >
            {photos.map((photo, i) => (
              <li
                key={`${photo.filename}-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.5rem 0.65rem",
                  background: photo.error ? "#fef2f2" : "#f9fafb",
                  border: `1px solid ${photo.error ? "#fecaca" : "#e5e7eb"}`,
                  borderRadius: 6,
                }}
              >
                <span style={{ flex: 1, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {photo.filename}
                  {photo.uploading ? " · uploading…" : photo.error ? ` · ${photo.error}` : " · ready"}
                </span>
                <button
                  type="button"
                  onClick={() => removePhoto(i)}
                  disabled={submitting}
                  style={{
                    background: "transparent",
                    border: "1px solid #d1d5db",
                    borderRadius: 4,
                    padding: "0.25rem 0.55rem",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                    minHeight: 32,
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label
          style={{
            ...s.buttonLink,
            background: "white",
            color: "#1f2937",
            border: "1px solid #d1d5db",
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          Add photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handlePhotoChange}
            disabled={submitting}
            style={{ display: "none" }}
          />
        </label>
        <p style={{ fontSize: "0.8rem", color: "#6b7280", marginTop: "0.5rem" }}>
          Photos upload immediately so a flaky connection mid-submit does not
          lose your work. Tap the file-squawk button when you are done.
        </p>
      </fieldset>

      {error ? (
        <p
          role="alert"
          style={{
            color: "#b91c1c",
            background: "#fef2f2",
            padding: "0.75rem 1rem",
            borderRadius: 4,
            border: "1px solid #fecaca",
            margin: 0,
          }}
        >
          {error}
        </p>
      ) : null}

      <div>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          style={{
            ...s.button,
            background: canSubmit ? "#dc2626" : "#d1d5db",
            cursor: canSubmit ? "pointer" : "not-allowed",
            width: "100%",
          }}
        >
          {submitting ? "Filing…" : `File squawk for ${registration}`}
        </button>
      </div>
    </div>
  );
}

function isoLocalNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
