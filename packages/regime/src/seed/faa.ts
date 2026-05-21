/**
 * The FAA regime is seeded in migration 0001_create_regimes.sql.
 * This constant is the ONLY place in application code that names the
 * FAA regime by string — every other code path resolves the regime
 * through {@link RegimeClient} and reads name/jurisdiction/templates
 * from the row.
 *
 * Downstream epics MUST NOT switch on this value to branch behavior.
 * It exists solely so that bootstrap code (onboarding, defaults, tests)
 * can look up "the regime we know is seeded" without hard-coding a
 * UUID.
 */
export const DEFAULT_REGIME_CODE = "FAA" as const;
export type DefaultRegimeCode = typeof DEFAULT_REGIME_CODE;
