/**
 * Health Diagnostic Rules — STATE.md consistency group (Phase 11, #3309,
 * ADR-3180 §8.2/§8.3/§8.5).
 *
 * Five rules, each a near-mechanical extraction of an already-working
 * `addIssue` call site in `cmdValidateHealth` (Gall's Law, design doc "Rule
 * table organization" / "Laws applied"):
 *
 *  - W024 (`verify.cts:1709-1729`) — STATE.md `state_head` commit-age
 *    freshness vs. git HEAD. GENUINE GAP, deliberately NOT migrated — see the
 *    `RULE_W024` comment below for exactly why.
 *  - W002 (`verify.cts:1731-1774`) — STATE.md references a phase token not
 *    declared anywhere (disk or ROADMAP).
 *  - W011 (`verify.cts:2104-2134`) — STATE's current-phase status disagrees
 *    with ROADMAP's `[x]` checkbox for that same phase.
 *  - W021 (`verify.cts:2270-2299`, the FIRST `addIssue('warning', 'W021', ...)`
 *    call site) — under the `'milestone-prefixed'` `phase_id_convention`, a
 *    phase's integer prefix implies a different milestone than the ROADMAP
 *    section it is actually listed under.
 *  - W026 (`verify.cts:2356-2399`, the SECOND `addIssue('warning', 'W021', ...)`
 *    call site — split off per the design doc's "New codes for the two split
 *    subjects" section, since one code covering two unrelated subjects is a
 *    genuine conflation) — STATE says the milestone is complete/archived, but
 *    ROADMAP (scoped to that same milestone) still lists a phase with no
 *    matching disk directory.
 *
 * - W002's original message interpolates `${slash('health')}`
 *   (`verify.cts:1770`) and W011's interpolates `${slash('progress')}`
 *   (`verify.cts:2126`) — both per-project runtime-resolved values
 *   (`formatGsdSlash`, `src/runtime-slash.cts`) this rule's
 *   `(snapshot) => Diagnostic[]` signature has no access to. Hardcodes the
 *   canonical `/gsd-health`/`/gsd-progress` hyphen form instead, mirroring
 *   the sibling "config.json validation" group's W016 rule
 *   (`src/health-diagnostic-rules/config-validation.cts`), which hardcodes
 *   `/gsd-ai-integration-phase` the same way for the identical reason.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 */

// Runtime values (SEVERITY/REMEDY_ACTION/REMEDY_RISK) are needed here, not
// just types, so this is a normal (non type-only) `import ... = require(...)`
// — unlike `health-diagnostic.cts`'s own type-only import of
// `planning-snapshot.cjs`, which never touches that module's runtime values.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- export= CommonJS module
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, adviseRemedy } = healthDiagnosticMod;
type Rule = healthDiagnosticMod.Rule;
type Diagnostic = healthDiagnosticMod.Diagnostic;

// Type-only; erased at compile time, no runtime require emitted — mirrors
// `health-diagnostic.cts`'s own import of `planning-snapshot.cjs`.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time
import type planningSnapshotMod = require('../planning-snapshot.cjs');
type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('../phase-id.cjs');
const { getMilestoneFromPhaseId, matchPhaseDirs, normalizePhaseName, extractPhaseToken, PHASE_NUMBER_TOKEN_SOURCE } =
  phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the single owner of the persisted status vocabulary
import stateDocumentMod = require('../state-document.cjs');
const { normalizeStateStatus } = stateDocumentMod;

// ─── W024 — STATE.md commit-age freshness (DELIBERATELY INERT) ─────────────

/**
 * W024's real check (`verify.cts:1709-1729`) calls
 * `readStateHeadFreshness(cwd, fm['state_head'])`, which shells out to `git
 * log` to count commits between the frontmatter's `state_head` and the
 * current HEAD. That is ambient I/O (git history), not `.planning/` content —
 * confirmed against `src/planning-snapshot.cts`'s full 15-field
 * `PlanningSnapshot` interface: no field wraps `readStateHeadFreshness` or
 * exposes a commits-behind count.
 *
 * §8.1 rule 1 requires a rule's signature to be `(snapshot) => Diagnostic[]`
 * with no ambient I/O inside `check` — so this rule does NOT call
 * `readStateHeadFreshness` itself (that would violate the constraint the
 * skeleton's own `Rule.check` type exists to enforce). Adding a 16th
 * `PlanningSnapshot` field (e.g. `stateHeadFreshness: {value:
 * {commitsBehind, stateHead}, scope}`) is the fix, but is out of this
 * group's scope (`src/planning-snapshot.cts` is a shared file this task was
 * not dispatched to extend).
 *
 * Registered here, `check` always returning `[]`, so the code table stays
 * complete per §8.2's 1:1 invariant (every code the old `verify.cts` emitted
 * has exactly one `Rule` entry) rather than silently dropping W024 from the
 * table. This is a documented, deliberate deferral pending the 16th snapshot
 * field — flagged prominently rather than quietly ported as a no-op.
 */
const RULE_W024: Rule = {
  code: 'W024',
  severity: SEVERITY.WARNING,
  description: 'STATE.md was written many commits ago — treat its contents as approximate',
  repairable: false,
  check: (_snapshot: PlanningSnapshot): Diagnostic[] => [],
};

// ─── W002 — STATE.md references an undeclared phase token ──────────────────

/**
 * The "valid phase" set the original code builds from
 * `collectDiskPhases(planBase)` (disk dir tokens) + ROADMAP heading tokens +
 * `forEachArchivedPhaseToken` (archived milestone-phase-dir tokens,
 * `verify.cts:1748`). This rebuilds the disk+ROADMAP two-thirds from parsed
 * snapshot fields only: `phaseDirs.value` (disk dir names, tokenized the same
 * way `collectDiskPhaseEntries` does — via `extractPhaseToken`) and
 * `roadmapDeclaredPhases.value.map(p => p.phaseId)` (ROADMAP-declared phase
 * ids). Archived-phase-token coverage is NOT included — no
 * `PlanningSnapshot` field exposes archived milestone-phase-dir tokens
 * (confirmed against the 15-field interface). Omitting it makes this valid
 * set a SUBSET of the original's, which can only make MORE STATE.md phase
 * tokens look "invalid" (never fewer) — a conservative, safe direction; a
 * project with archived phases still referenced from STATE.md is the
 * fixture shape that would expose a false positive, and none of this
 * group's fixtures exercise archives, so this gap is disclosed rather than
 * silently absorbed.
 *
 * UPDATE (#3652): archived-phase-token coverage IS now included, via the
 * additive `snapshot.archivedPhaseTokens` field
 * (`src/planning-snapshot.cts`, added for this fix) — the disclosed gap
 * above is closed; the paragraph is kept for the "conservative direction"
 * reasoning, which still explains why every OTHER omission in this
 * function is safe.
 */
function buildValidPhaseSet(snapshot: PlanningSnapshot): Set<string> {
  const valid = new Set<string>();
  for (const dir of snapshot.phaseDirs.value) {
    // #612: the pre-migration source of this third was
    // `collectDiskPhases(planBase, convention)`, whose keys came from the
    // convention-aware extractor. Left convention-less here, a bracket repo's
    // `GSD.02-05-slug` contributes `GSD.02` instead of `05`, so every STATE.md
    // reference to a real phase falls outside the valid set and W002 fires on
    // all of them.
    const token = extractPhaseToken(dir, snapshot.phaseIdConvention);
    if (token) valid.add(token);
  }
  for (const entry of snapshot.roadmapDeclaredPhases.value) {
    valid.add(entry.phaseId);
  }
  for (const token of snapshot.archivedPhaseTokens.value) {
    valid.add(token);
  }
  return valid;
}

/** Mirrors `verify.cts:1749-1758`'s zero-padding normalization exactly. */
function normalizePhaseTokenSet(valid: Set<string>): Set<string> {
  const normalized = new Set<string>();
  for (const p of valid) {
    normalized.add(p);
    const dotIdx = p.indexOf('.');
    const head = dotIdx === -1 ? p : p.slice(0, dotIdx);
    const tail = dotIdx === -1 ? '' : p.slice(dotIdx);
    if (/^\d+$/.test(head)) {
      normalized.add(head.padStart(2, '0') + tail);
    }
  }
  return normalized;
}

const RULE_W002: Rule = {
  code: 'W002',
  severity: SEVERITY.WARNING,
  description: 'STATE.md references invalid phase',
  repairable: false,
  check: (snapshot: PlanningSnapshot): Diagnostic[] => {
    const validPhases = buildValidPhaseSet(snapshot);
    // Mirrors `verify.cts:1765`'s `if (normalizedValid.size > 0)` guard
    // exactly — a project with zero declared phases emits nothing, never a
    // false positive on every STATE.md phase mention.
    if (validPhases.size === 0) return [];
    const normalizedValid = normalizePhaseTokenSet(validPhases);
    const sortedValid = [...validPhases].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );

    const diagnostics: Diagnostic[] = [];
    // #4257: the valid set above is WORKSTREAM-scoped by construction (every
    // source field is read from `planningPaths(cwd)`'s base, which resolves
    // under `.planning/workstreams/<active-ws>/`), and per-workstream phase
    // numbering is deliberate — so under a workstream the message must NAME
    // that scope rather than make an unqualified project-wide claim (a
    // reference to a phase declared only in a SIBLING workstream reads as
    // "undeclared" against this list; that is the scope speaking, not drift).
    // Root scope (`workstream === null`, flat or root-planning projects)
    // keeps the byte-identical message — no clause is appended when none
    // applies.
    const scopeClause = snapshot.workstream ? ` in workstream ${snapshot.workstream}` : '';
    for (const ref of snapshot.statePhaseTokens.value) {
      const dotIdx = ref.indexOf('.');
      const head = dotIdx === -1 ? ref : ref.slice(0, dotIdx);
      const tail = dotIdx === -1 ? '' : ref.slice(dotIdx);
      const padded = /^\d+$/.test(head) ? head.padStart(2, '0') + tail : ref;
      if (normalizedValid.has(ref) || normalizedValid.has(padded)) continue;
      diagnostics.push({
        code: 'W002',
        severity: SEVERITY.WARNING,
        message: `STATE.md references phase ${ref}, but only phases ${sortedValid.join(', ')} are declared${scopeClause}`,
        remedy: adviseRemedy(
          'Review STATE.md manually before changing it; /gsd-health --repair will not overwrite an existing STATE.md for phase mismatches',
        ),
      });
    }
    return diagnostics;
  },
};

// ─── W011 — STATE current-phase status vs. ROADMAP checkbox disagree ───────

/**
 * `currentPhaseLabel.value` is a prose string (e.g. `"3 of 8 (User Auth)"`),
 * not a clean phase id — the leading integer (optionally letter-suffixed /
 * dotted, the same `PHASE_NUMBER_TOKEN_SOURCE` grammar) is the "current
 * phase" proxy the original `verify.cts:2109-2113` derives via its own
 * `**Current Phase:**`/`Current Phase:` regex + `.replace(/^0+/, '')`. That
 * literal field name does not exist in the current `state.md` template
 * (which uses `Phase: [X] of [Y] ([Phase name])` under `## Current
 * Position`) — `currentPhaseLabel` is the parsed owner of that exact field,
 * so extracting its leading number is the equivalent-intent read against
 * the template STATE.md actually ships. #3280: the label's ladder
 * (`buildStateFields`, `src/planning-snapshot.cts`) now leads with the
 * frontmatter `current_phase` scalar — the key `gsd-tools state update` /
 * `state begin-phase` persist — so a bare `"2"` is the expected value on
 * the machine-readable format, and this leading-number extraction handles
 * it identically.
 */
function currentPhaseIdFromLabel(label: string | null): string | null {
  if (!label) return null;
  const m = label.match(new RegExp(`^0*(${PHASE_NUMBER_TOKEN_SOURCE})`));
  return m ? m[1] : null;
}

const RULE_W011: Rule = {
  code: 'W011',
  severity: SEVERITY.WARNING,
  description: 'STATE.md current-phase status disagrees with ROADMAP.md checkbox',
  repairable: false,
  check: (snapshot: PlanningSnapshot): Diagnostic[] => {
    const phaseId = currentPhaseIdFromLabel(snapshot.currentPhaseLabel.value);
    if (phaseId === null) return [];
    const checked = snapshot.roadmapPhaseCheckboxes.value[phaseId];
    if (checked !== true) return [];
    // #3280: the state writer persists `status` through `normalizeStateStatus`
    // (`state.cts`'s syncStateFrontmatter), whose completion token is
    // `completed` — an exact `'complete' || 'done'` comparison rejects the
    // exact vocabulary the product writes and turns every legitimately
    // completed frontmatter STATE.md into a false positive. Route the
    // comparison through the same seam that owns the vocabulary
    // (`state-document.cjs`'s `normalizeStateStatus`) rather than growing a
    // second bespoke token list here.
    const statusVal = (snapshot.stateStatus.value ?? '').trim();
    if (normalizeStateStatus(statusVal, null) === 'completed') return [];
    return [
      {
        code: 'W011',
        severity: SEVERITY.WARNING,
        message: `STATE.md says current phase is ${phaseId} (status: ${statusVal.toLowerCase() || 'unknown'}) but ROADMAP.md shows it as [x] complete — state files may be out of sync`,
        remedy: adviseRemedy('Run /gsd-progress to re-derive current position, or manually update STATE.md'),
      },
    ];
  },
};

// ─── W021 — phase_id_convention integer-prefix/milestone mismatch ──────────

const RULE_W021: Rule = {
  code: 'W021',
  severity: SEVERITY.WARNING,
  description:
    "Phase's integer prefix implies a different milestone than its ROADMAP section (phase_id_convention: milestone-prefixed)",
  repairable: false,
  check: (snapshot: PlanningSnapshot): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [];

    // Two INDEPENDENT gates, evaluated in the order the pre-migration
    // `cmdValidateHealth` block emitted them (milestone-prefixed first, then
    // bracket). They are deliberately NOT written as if/else: the two read
    // DIFFERENT config bases and can both be true at once.
    //
    //   milestone-prefixed — `snapshot.config` (ROOT config only), exactly as
    //     this gate has always read it. Federating THIS one silently moved a
    //     legacy convention's answer in BOTH directions on workstream repos: a
    //     W021 that fires at base vanishing, and one silent at base firing.
    //   bracket — `snapshot.phaseIdConvention` (federated workstream -> root),
    //     because the bracket reads this half reports on are themselves
    //     federated; gating it on the root answer would split the check against
    //     the reads it describes.
    //
    // A workstream that overrides a `milestone-prefixed` ROOT to `bracket` is
    // the case that makes the distinction observable, and it is the reason an
    // early `return` here would be a bug: the root-configured M-NN gate must
    // still fire, or the repo looks healthier than it is.
    const rootConvention = snapshot.config.value?.['phase_id_convention'];
    if (rootConvention === 'milestone-prefixed') {
      diagnostics.push(...checkMilestonePrefixW021(snapshot));
    }

    // #612: an ADDITIVE sibling branch — the milestone-prefixed gate above is
    // untouched. Gated strictly on the ACTIVE convention, never on
    // project_code presence: reads are selected per convention, and a CHECK
    // that can fail a repo runs only for the convention that repo opted into.
    if (snapshot.phaseIdConvention === 'bracket') {
      for (const mm of snapshot.roadmapBracketIncoherences.value) {
        diagnostics.push({
          code: 'W021',
          severity: SEVERITY.WARNING,
          message:
            mm.kind === 'missing-bracket'
              ? `Phase ${mm.phaseId}: heading is not in bracket form under the 'bracket' convention (expected \`[CODE.${mm.sectionMilestone}] ${mm.phaseId}:\`)`
              : `Phase ${mm.phaseId}: bracket milestone ${mm.phaseMilestone} does not match its section milestone ${mm.sectionMilestone}`,
          remedy: adviseRemedy(
            'Bracket migration lands with the #612 migrator (PR-3); until then, manually align the bracket milestone in this heading to match the enclosing section.',
          ),
        });
      }
    }

    return diagnostics;
  },
};

/** The milestone-prefixed half of W021, unchanged by #612. */
function checkMilestonePrefixW021(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const entry of snapshot.roadmapDeclaredPhases.value) {
    // `entry.milestone === null` means the builder never found this phase
    // heading inside any versioned (`v\d+\.\d+`) section — the original
    // `checkMilestonePrefixMismatches` only ever iterates phases found
    // WITHIN a section, so a phase outside any section is equivalently
    // never checked here.
    if (entry.milestone === null) continue;
    const expectedMilestone = getMilestoneFromPhaseId(entry.phaseId);
    if (expectedMilestone === null || expectedMilestone === entry.milestone) continue;
    diagnostics.push({
      code: 'W021',
      severity: SEVERITY.WARNING,
      message: `Phase ${entry.phaseId}: integer prefix implies ${expectedMilestone} but listed under ${entry.milestone}`,
      remedy: adviseRemedy('gsd-tools roadmap upgrade --convention milestone-prefixed'),
    });
  }
  return diagnostics;
}

// ─── W026 — STATE says milestone complete but ROADMAP lists unstarted phase ─

const RULE_W026: Rule = {
  code: 'W026',
  severity: SEVERITY.WARNING,
  description: 'STATE says milestone complete but ROADMAP lists an unstarted phase for that milestone',
  repairable: false,
  check: (snapshot: PlanningSnapshot): Diagnostic[] => {
    const statusVal = (snapshot.stateStatus.value ?? '').trim().toLowerCase();
    if (!/milestone complete|archived/.test(statusVal)) return [];

    // `currentMilestoneRoadmapPhaseIds` is already scoped to the current
    // milestone (`extractCurrentMilestone(roadmapRaw, cwd)`, the same
    // `<details>`/`<summary>`-tolerant owner `verify.cts:2364` used) — no
    // separate `currentMilestone` resolution/filter needed here (see the
    // field's own doc comment on `PlanningSnapshot` for why
    // `roadmapDeclaredPhases`'s `milestone` attribution is the wrong fit).
    const unstarted: string[] = [];
    for (const phaseId of snapshot.currentMilestoneRoadmapPhaseIds.value) {
      const normalized = normalizePhaseName(phaseId);
      // `allPhaseDirNames` — every directory under `phases/`, UNWINDOWED by
      // ROADMAP-declaration membership — mirrors the original's own
      // unwindowed `phaseDirNames2` (`verify.cts:2372-2382`, a direct
      // `readdirSync` of the phases dir), not the current-milestone-windowed
      // `phaseDirs`.
      // #612: the directory read widens with the heading read that produced
      // `currentMilestoneRoadmapPhaseIds`, or every bracket phase resolves to
      // nothing, reads as unstarted, and this UNGATED warning false-fires on
      // any bracket repo whose STATE says the milestone is complete. #2528
      // moved the read onto the shared selector; the convention rides along,
      // since the selector's primary match IS the `phaseTokenMatches` call this
      // line used to make directly.
      const hasDirectory =
        matchPhaseDirs(snapshot.allPhaseDirNames.value, normalized, snapshot.phaseIdConvention).matches.length > 0;
      if (!hasDirectory) unstarted.push(phaseId);
    }
    if (unstarted.length === 0) return [];

    return [
      {
        code: 'W026',
        severity: SEVERITY.WARNING,
        message: `STATE says milestone complete but ROADMAP lists ${unstarted.length} unstarted phase(s) (e.g. Phase ${unstarted[0]})`,
        remedy: adviseRemedy(
          'Run validate consistency or re-run complete-milestone after verifying all phases are done',
        ),
      },
    ];
  },
};

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [RULE_W024, RULE_W002, RULE_W011, RULE_W021, RULE_W026];

export = { RULES };
