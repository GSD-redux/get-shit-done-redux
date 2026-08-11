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

// ─── #1956 cross-artifact phase-status drift ────────────────────────────────

/** Verdict from comparing one phase's status across STATE.md and ROADMAP.md. */
export type PhaseStatusVerdict = 'consistent' | 'lag' | 'drifted' | 'uncheckable';

/** Result of comparePhaseStatus. */
export interface PhaseStatusResult {
  verdict: PhaseStatusVerdict;
  stateRank: number | null;
  roadmapRank: number | null;
}

/**
 * Frozen map from lowercased phase-status text to a shared ordinal rank,
 * covering the union of the STATE.md "Current Position" vocabulary
 * (gsd-core/templates/state.md) and the FULL ROADMAP.md "## Progress" table
 * Status column vocabulary declared by gsd-core/templates/roadmap.md:133 —
 * `Not started | In progress | Complete | Deferred`.
 *
 * The two vocabularies overlap on 'in progress', which is rank 1 in both —
 * no conflict. 'deferred' is rank 0 (no work done) — see comparePhaseStatus's
 * doc comment for how a deferred/non-rank-0 mismatch is classified; it is NOT
 * simply numeric distance from rank 0 like an ordinary lag.
 */
const PHASE_STATUS_RANKS: Readonly<Record<string, number>> = Object.freeze({
  // STATE.md "Current Position" vocabulary
  'ready to plan':    0,
  'planning':         0,
  'ready to execute': 1,
  'in progress':      1,
  'phase complete':   2,
  // ROADMAP.md "## Progress" table Status column vocabulary
  'not started':      0,
  'complete':         2,
  'deferred':         0,
} as const);

/** Rank at which a status asserts work is DONE (terminal, not comparative). */
const TERMINAL_RANK = 2;

/**
 * Normalize a raw phase-status string for lookup/comparison: trims
 * surrounding whitespace and lowercases. Returns null for missing/empty
 * values. Single owner of this normalization so `resolvePhaseStatusRank` and
 * the 'deferred' declared-intent check in `comparePhaseStatus` cannot drift
 * apart on what counts as "empty".
 */
function normalizePhaseStatusText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

/**
 * Resolve a raw phase-status string to its shared ordinal rank, or null when
 * the value is missing/empty/unrecognized. Case-insensitive, trims
 * surrounding whitespace.
 *
 * @param value - raw status text from STATE.md or ROADMAP.md
 * @returns the resolved rank, or null if unresolvable
 */
function resolvePhaseStatusRank(value: string | null | undefined): number | null {
  const normalized = normalizePhaseStatusText(value);
  if (normalized === null) return null;
  if (!Object.prototype.hasOwnProperty.call(PHASE_STATUS_RANKS, normalized)) return null;
  return PHASE_STATUS_RANKS[normalized];
}

/**
 * Compare a phase's status as reported by STATE.md against the same phase's
 * status as reported by ROADMAP.md's "## Progress" table, and classify the
 * result.
 *
 * Unlike classifyDriftSeverity, this never throws for an unrecognized
 * status: the inputs are user document text (prose a human or agent typed
 * into STATE.md/ROADMAP.md), not config, so an unrecognized value is data —
 * surfaced as 'uncheckable' — not a programming error.
 *
 * Rank 2 ('phase complete' / 'Complete') is TERMINAL: it asserts the work is
 * DONE. If exactly one side reports rank 2 and the other does not, that is
 * always 'drifted', regardless of numeric distance — a document claiming
 * "done" while another claims "still going" is a direct contradiction, not
 * mere lag. This is the issue's canonical example: complete in STATE.md but
 * in progress in ROADMAP.md.
 *
 * 'Deferred' is a second declared-intent rank-0 status (gsd-core/templates/
 * roadmap.md:133's full vocabulary: `Not started | In progress | Complete |
 * Deferred`) that is NOT ordinary lag from rank 0: it is an explicit
 * decision to STOP work, not merely "hasn't started yet". If exactly one
 * side declares 'deferred' and the other side's rank is >= 1 (work is
 * reported as in progress or complete), that is always 'drifted' — a phase
 * declared deferred while the other document says work is happening is a
 * direct contradiction, checked here (like the terminal-completeness rule
 * above) BEFORE the numeric distance comparison. 'Deferred' against a
 * rank-0 status on the other side (e.g. 'Not started') stays 'consistent' —
 * both agree no work has happened.
 *
 * Otherwise, ranks are compared numerically: equal → 'consistent';
 * off-by-one → 'lag'; off-by-two-or-more → 'drifted'.
 *
 * @param opts.stateStatus   - raw Status value from STATE.md's Current Position
 * @param opts.roadmapStatus - raw Status cell from ROADMAP.md's Progress table
 * @returns { verdict, stateRank, roadmapRank }
 */
export function comparePhaseStatus({
  stateStatus,
  roadmapStatus,
}: {
  stateStatus: string | null | undefined;
  roadmapStatus: string | null | undefined;
}): PhaseStatusResult {
  const stateRank = resolvePhaseStatusRank(stateStatus);
  const roadmapRank = resolvePhaseStatusRank(roadmapStatus);

  if (stateRank === null || roadmapRank === null) {
    return { verdict: 'uncheckable', stateRank, roadmapRank };
  }

  const stateIsTerminal = stateRank === TERMINAL_RANK;
  const roadmapIsTerminal = roadmapRank === TERMINAL_RANK;
  if (stateIsTerminal !== roadmapIsTerminal) {
    return { verdict: 'drifted', stateRank, roadmapRank };
  }

  const stateIsDeferred = normalizePhaseStatusText(stateStatus) === 'deferred';
  const roadmapIsDeferred = normalizePhaseStatusText(roadmapStatus) === 'deferred';
  if (stateIsDeferred !== roadmapIsDeferred) {
    const otherRank = stateIsDeferred ? roadmapRank : stateRank;
    if (otherRank >= 1) {
      return { verdict: 'drifted', stateRank, roadmapRank };
    }
  }

  const diff = Math.abs(stateRank - roadmapRank);
  if (diff === 0) {
    return { verdict: 'consistent', stateRank, roadmapRank };
  }
  if (diff === 1) {
    return { verdict: 'lag', stateRank, roadmapRank };
  }
  return { verdict: 'drifted', stateRank, roadmapRank };
}
