/**
 * ADR-22 Drift-Guard Decision Module
 *
 * Implements the authority ladder and severity classification table from
 * ADR-22 (docs/adr/22-plan-drift-guard.md).
 *
 * Design constraints:
 *   - Pure module: no I/O, no require() calls, no side effects.
 *   - All inputs are validated; unknown values throw a TypeError.
 *   - Consumed by the `gsd-tools drift-guard` CLI seam and by tests.
 *
 * Authority ladder (rung values determine MISSING severity):
 *   grep=0  intel=1  treesitter=2  lsp=3  scip=4
 *
 * Hard-block threshold: rung >= 3 (lsp, scip) — these adapters can prove
 * absence, so MISSING is a definite error (severity HIGH, hardBlock true).
 */

/** The five authority adapter names defined by ADR-22. */
export type Authority = 'grep' | 'intel' | 'treesitter' | 'lsp' | 'scip';

/** Symbol verification verdict emitted by the source-grounding pass. */
export type VerificationStatus = 'VERIFIED' | 'MISSING' | 'AMBIGUOUS' | 'UNCHECKABLE';

/** Severity classification outcome. */
export type Severity = 'none' | 'needs-acknowledgement' | 'MEDIUM' | 'HIGH' | 'INFO';

/** Result of classifyDriftSeverity. */
export interface DriftSeverityResult {
  severity: Severity;
  hardBlock: boolean;
}

/**
 * Frozen map from authority name to its rung number.
 *
 * Rung determines whether a MISSING symbol triggers a hard block:
 * rung >= 3 (lsp, scip) → hard block; rung < 3 → acknowledgement only.
 */
export const AUTHORITY_RUNGS: Readonly<Record<Authority, number>> = Object.freeze({
  grep:       0,
  intel:      1,
  treesitter: 2,
  lsp:        3,
  scip:       4,
} as const);

/** Rung at which MISSING transitions to hard-block (inclusive). */
const HARD_BLOCK_RUNG_THRESHOLD = 3;

const VALID_AUTHORITIES = new Set<string>(Object.keys(AUTHORITY_RUNGS));
const VALID_STATUSES = new Set<string>(['VERIFIED', 'MISSING', 'AMBIGUOUS', 'UNCHECKABLE']);

/**
 * Validate and return an authority value, normalising undefined to 'grep'.
 *
 * Throws TypeError for any non-null unknown string value so callers surface
 * configuration errors at call time rather than silently defaulting.
 *
 * @param value - raw authority string from config or CLI arg
 * @returns a validated Authority value
 */
function validateAuthority(value: string | undefined | null): Authority {
  if (value === undefined || value === null || value === '') {
    return 'grep';
  }
  if (!VALID_AUTHORITIES.has(value)) {
    throw new TypeError(
      `Unknown authority: ${JSON.stringify(value)}. ` +
      `Valid values: ${[...VALID_AUTHORITIES].join(', ')}`
    );
  }
  return value as Authority;
}

/**
 * Return the effective authority after applying the ADR-22 auto-upgrade rule.
 *
 * Auto-upgrade rule: if the configured authority is 'grep' AND intel is
 * enabled (`intelEnabled === true`), upgrade to 'intel'. All other authority
 * values are returned unchanged regardless of intelEnabled.
 *
 * @param authority   - configured authority (undefined → 'grep')
 * @param intelEnabled - whether the intel capability is active in this project
 * @returns the effective Authority after upgrade
 * @throws TypeError if authority is not one of the five valid values
 */
export function getEffectiveAuthority(
  authority: string | undefined | null,
  intelEnabled: boolean,
): Authority {
  const validated = validateAuthority(authority);
  if (validated === 'grep' && intelEnabled === true) {
    return 'intel';
  }
  return validated;
}

/**
 * Classify a symbol verification result into a drift severity and hard-block flag.
 *
 * ADR-22 decision table:
 *
 * | Status       | Authority rung | severity               | hardBlock |
 * |------------- |--------------- |----------------------- |---------- |
 * | VERIFIED     | any            | 'none'                 | false     |
 * | MISSING      | rung >= 3      | 'HIGH'                 | true      |
 * | MISSING      | rung 0-2       | 'needs-acknowledgement'| false     |
 * | AMBIGUOUS    | any            | 'MEDIUM'               | false     |
 * | UNCHECKABLE  | any            | 'INFO'                 | false     |
 *
 * @param opts.status    - verdict from the source-grounding adapter
 * @param opts.authority - the effective authority adapter used
 * @returns { severity, hardBlock }
 * @throws TypeError for unknown status or authority values
 */
export function classifyDriftSeverity({
  status,
  authority,
}: {
  status: string;
  authority: string;
}): DriftSeverityResult {
  if (!VALID_STATUSES.has(status)) {
    throw new TypeError(
      `Unknown status: ${JSON.stringify(status)}. ` +
      `Valid values: ${[...VALID_STATUSES].join(', ')}`
    );
  }
  // authority validation (also catches unknown values)
  const validatedAuthority = validateAuthority(authority);
  const rung = AUTHORITY_RUNGS[validatedAuthority];

  switch (status as VerificationStatus) {
    case 'VERIFIED':
      return { severity: 'none', hardBlock: false };

    case 'MISSING':
      if (rung >= HARD_BLOCK_RUNG_THRESHOLD) {
        return { severity: 'HIGH', hardBlock: true };
      }
      return { severity: 'needs-acknowledgement', hardBlock: false };

    case 'AMBIGUOUS':
      return { severity: 'MEDIUM', hardBlock: false };

    case 'UNCHECKABLE':
      return { severity: 'INFO', hardBlock: false };
  }
}
