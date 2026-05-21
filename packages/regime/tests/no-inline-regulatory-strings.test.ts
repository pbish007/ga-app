import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * F2.3 — guard against inline regulatory strings.
 *
 * Source: spec Rev. 3 §6 (F2 seam), PMB-16 Epic F definition of done.
 *
 * The regulatory wording of an FAA return-to-service statement (and
 * any future regime's release wording) MUST live in the regime
 * template tables — `regime_rts_templates.body`, `regime_credential_types.description`,
 * etc. — never as string constants inline in TypeScript code.
 *
 * The reason: a second regime (Canada CARS, Australia CASA, …) must be
 * a content-entry job. The minute a phrase like
 * "approved for return to service" is embedded in app code, that
 * promise breaks: somebody has to find and rewrite every site.
 *
 * This test scans the repo's TypeScript source for a known set of
 * regulatory phrases. Two zones are allow-listed:
 *
 *   1. SQL migration files (the only place regulatory text is allowed
 *      to live — that's the template seed itself).
 *   2. This very test file (the phrases are constants here).
 *
 * If a phrase appears anywhere else, the test fails with a clear list
 * of offending locations. To fix:
 *
 *   * Move the phrase to a new `regime_rts_templates` row (or another
 *     regime-owned table) via a SQL migration.
 *   * Read it through `RegimeClient.listRtsTemplates` (or sibling).
 *   * Reference the template by its code, never the body.
 */

interface ForbiddenPhrase {
  /** The literal substring to grep for (case-insensitive). */
  phrase: string;
  /**
   * Why this phrase is regulatory. Surfaces in failure messages so the
   * fix path is obvious.
   */
  reason: string;
}

const FORBIDDEN_PHRASES: ForbiddenPhrase[] = [
  {
    phrase: "approved for return to service",
    reason: "14 CFR §43.9/§43.11 RTS sign-off wording — lives in regime_rts_templates.body",
  },
  {
    phrase: "in airworthy condition",
    reason: "FAA annual/100-hour RTS phrasing — lives in regime_rts_templates.body",
  },
  {
    phrase: "14 CFR",
    reason: "FAA regulatory citation — belongs in regime catalog descriptions, never in app code",
  },
  {
    phrase: "Federal Aviation Regulations",
    reason: "FAA-specific regulatory body — must be regime-owned",
  },
  {
    phrase: "airworthiness directive",
    reason: "FAA-specific directive name — directive source rows live in regime_directive_sources",
  },
];

/** File extensions we treat as application source for this check. */
const SCANNED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Directories never traversed (build output, deps, etc.). */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".vercel",
  ".git",
  "coverage",
]);

/**
 * Scopes scanned.
 *
 * Production application code only — `apps/<x>/src` and
 * `packages/<x>/src`. We deliberately do NOT scan:
 *
 *   * `packages/<x>/tests` — verification code may legitimately quote
 *     regulatory phrases inside negative-assertion regexes
 *     (e.g. asserting an email template does NOT contain
 *     regulatory text) or seed a second regime to prove the seam.
 *   * `packages/db/migrations` — the regime template seed lives in
 *     SQL by design; that's the seam itself.
 *   * `packages/regime/src/seed` — bootstrap data that mirrors the SQL
 *     seed; defining the canonical FAA values is its job.
 *
 * Adding a new scope is a deliberate exception: think twice before
 * widening this list, and never add a tests/ dir.
 */
const SCAN_SCOPES: { type: "apps" | "packages"; subdir: string }[] = [
  { type: "apps", subdir: "src" },
  { type: "packages", subdir: "src" },
];

/**
 * Paths (relative to repo root) inside a scanned scope that ARE
 * still allowed. Keep minimal.
 */
const ALLOWED_SUBPATH_FRAGMENTS = [
  // The regime seed file mirrors the SQL seed and is the canonical
  // bootstrap of regime-owned text.
  ["packages", "regime", "src", "seed"].join(sep),
];

function findRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/regime/tests/<this file> → up three levels.
  return resolve(here, "..", "..", "..");
}

function walkSource(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkSource(full, out);
    } else if (SCANNED_EXTS.has(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

function collectScopedFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const { type, subdir } of SCAN_SCOPES) {
    const groupRoot = join(repoRoot, type);
    let groupEntries: string[];
    try {
      groupEntries = readdirSync(groupRoot);
    } catch {
      continue;
    }
    for (const entry of groupEntries) {
      if (SKIP_DIRS.has(entry)) continue;
      const candidate = join(groupRoot, entry, subdir);
      try {
        const s = statSync(candidate);
        if (s.isDirectory()) walkSource(candidate, files);
      } catch {
        // No src/ dir — skip silently.
      }
    }
  }
  return files;
}

function isAllowed(repoRelativePath: string): boolean {
  return ALLOWED_SUBPATH_FRAGMENTS.some((frag) =>
    repoRelativePath.includes(frag),
  );
}

describe("F2.3 — no inline regulatory strings in app code", () => {
  it("regulatory wording lives in regime tables, not source files", () => {
    const repoRoot = findRepoRoot();
    const files = collectScopedFiles(repoRoot);
    const violations: { file: string; phrase: string; reason: string }[] = [];

    for (const file of files) {
      const rel = relative(repoRoot, file);
      if (isAllowed(rel)) continue;
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const { phrase, reason } of FORBIDDEN_PHRASES) {
        if (text.includes(phrase.toLowerCase())) {
          violations.push({ file: rel, phrase, reason });
        }
      }
    }

    if (violations.length > 0) {
      const lines = violations.map(
        (v) => `  - ${v.file} contains "${v.phrase}" — ${v.reason}`,
      );
      throw new Error(
        [
          "Inline regulatory strings detected. Move the wording to a regime",
          "template (e.g. regime_rts_templates) and read it through RegimeClient.",
          "Offenders:",
          ...lines,
        ].join("\n"),
      );
    }

    expect(violations).toHaveLength(0);
  });
});
