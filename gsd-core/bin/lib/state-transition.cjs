"use strict";
/**
 * STATE.md Transition Module — ADR-1769.
 *
 * Phase 1 substrate: field-classification table, section constants, the pure
 * `transitionCore` dispatch, and the `beginPhase` intent (migrating
 * `cmdStateBeginPhase` in state.cts onto this seam).
 *
 * Sibling/super-module of the STATE.md Document Module (state-document.cjs):
 * consumes its `stateExtractField` / `stateReplaceField` primitives. Body
 * section headings live as constants here (single writer after migration).
 *
 * Pure core + injected I/O (ADR-1769 §3): the exported `transitionCore` is a
 * pure function `(content, intent, deps) → result`; adapters that own locks,
 * file I/O, and the disk-scan wrap it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATE_MD_SECTIONS = exports.FIELD_CLASSIFICATION = void 0;
exports.getFieldClassification = getFieldClassification;
exports.applyStatePreservation = applyStatePreservation;
exports.transitionCore = transitionCore;
exports.sliceCurrentPositionSection = sliceCurrentPositionSection;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frontmatter = require("./frontmatter.cjs");
const state_document_cjs_1 = require("./state-document.cjs");
const state_document_cjs_2 = require("./state-document.cjs");
const markdown_sectionizer_cjs_1 = require("./markdown-sectionizer.cjs");
const phase_lifecycle_cjs_1 = require("./phase-lifecycle.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const phaseIdMod = require("./phase-id.cjs");
const { extractFrontmatter, reconstructFrontmatter, stripFrontmatter } = frontmatter;
const { escapeRegex } = phaseIdMod;
// Stop predicate for section-body slicing: a level-2+ heading ends the section.
const STOP_H2_PLUS = (lv) => lv >= 2;
/**
 * Single source of truth for "which fields win when frontmatter and body
 * disagree". Transitions declare which body fields they touch; the core
 * consults the table to apply the preservation policy uniformly.
 *
 * Adding a new STATE.md field = one row here, not 9 transition edits.
 *
 * Field set verified against `buildStateFrontmatter` (state.cts:1474) — every
 * frontmatter key emitted there has a row here.
 *
 * Frozen null-prototype object: prevents prototype-pollution lookups
 * (`FIELD_CLASSIFICATION['toString']` returns undefined, not the inherited
 * function). Use `getFieldClassification()` for lookups.
 */
exports.FIELD_CLASSIFICATION = Object.freeze(Object.assign(Object.create(null), {
    // Schema
    gsd_state_version: { source: 'free', preservation: 'derive' },
    // Milestone (external — from ROADMAP.md)
    milestone: { source: 'external', preservation: 'preserve-if-placeholder' },
    milestone_name: { source: 'external', preservation: 'preserve-if-placeholder' },
    // Phase / plan position (body-derived)
    current_phase: { source: 'body', preservation: 'preserve-when-unchanged' },
    current_phase_name: { source: 'curated', preservation: 'preserve-always' }, // #1743, #1695
    current_plan: { source: 'body', preservation: 'preserve-when-unchanged' },
    // Status / lifecycle (body-derived; #1230 delta heuristic applies)
    status: { source: 'body', preservation: 'preserve-when-unchanged' },
    stopped_at: { source: 'body', preservation: 'preserve-when-unchanged' },
    paused_at: { source: 'body', preservation: 'preserve-when-unchanged' },
    // Activity log
    last_updated: { source: 'free', preservation: 'derive' }, // realClock.nowIso()
    last_activity: { source: 'body', preservation: 'derive' }, // always refresh on transition
    last_activity_desc: { source: 'body', preservation: 'preserve-when-unchanged' },
    // Progress block (disk-derived, except the curated progress ratchet)
    progress: { source: 'curated', preservation: 'preserve-always' }, // #3242, #1446
    'progress.total_phases': { source: 'disk', preservation: 'derive' },
    'progress.completed_phases': { source: 'disk', preservation: 'derive' },
    'progress.total_plans': { source: 'disk', preservation: 'derive' },
    'progress.completed_plans': { source: 'disk', preservation: 'derive' },
    'progress.percent': { source: 'disk', preservation: 'derive' },
}));
/**
 * Own-property classification lookup. Returns `null` for unknown fields
 * (including inherited prototype methods like `toString`/`valueOf`).
 */
function getFieldClassification(field) {
    if (!Object.prototype.hasOwnProperty.call(exports.FIELD_CLASSIFICATION, field))
        return null;
    return exports.FIELD_CLASSIFICATION[field];
}
/**
 * Pure, table-driven post-sync preservation. Mutates `postFm` in place to
 * mirror the pre-consolidation inline block (which also mutated in place) and
 * returns whether any field was restored.
 */
function applyStatePreservation(input) {
    const { preFm, postFm, preFmSnapshot, resync } = input;
    let mutated = false;
    // Curated progress ratchet (#3242/#1446; closes the #1264 class by routing
    // the policy through the table). Restored only when the table says preserve-
    // always AND this transition is not re-deriving from disk (!resync). sync and
    // the lifecycle transitions pass resync=true and recompute; patch/update and
    // body-only writes pass resync=false and keep the curated counters.
    const progressCls = getFieldClassification('progress');
    if (progressCls !== null &&
        progressCls.preservation === 'preserve-always' &&
        !resync &&
        preFm &&
        preFm['progress']) {
        // #2440: when the caller opts in (deriveProgressKeys), total_plans and
        // total_phases always take the derived (post-sync) value even under !resync.
        // This is used by cmdStatePlannedPhase where total_plans must correct upward
        // after plans are added. For body-only writes (state.update/patch without
        // the flag), the wholesale restore preserves everything as before — the
        // #3242 Bug A protection stays fully in force.
        if (input.deriveProgressKeys && postFm['progress']) {
            const curated = preFm['progress'];
            const derived = (postFm['progress'] ?? {});
            const merged = { ...derived };
            if (curated) {
                for (const [key, value] of Object.entries(curated)) {
                    if (key !== 'total_plans' && key !== 'total_phases') {
                        merged[key] = value;
                    }
                }
            }
            postFm['progress'] = merged;
        }
        else {
            postFm['progress'] = preFm['progress'];
        }
        mutated = true;
    }
    // status — #1230 body-delta heuristic. Table: preserve-when-unchanged.
    const statusCls = getFieldClassification('status');
    if (statusCls !== null &&
        statusCls.preservation === 'preserve-when-unchanged' &&
        input.postBodyStatus === input.preBodyStatus &&
        typeof preFmSnapshot['status'] === 'string' &&
        preFmSnapshot['status'].length > 0 &&
        preFmSnapshot['status'] !== 'unknown' &&
        postFm['status'] !== preFmSnapshot['status']) {
        postFm['status'] = preFmSnapshot['status'];
        mutated = true;
    }
    // stopped_at — same #1230 body-delta heuristic. Table: preserve-when-unchanged.
    const stoppedCls = getFieldClassification('stopped_at');
    if (stoppedCls !== null &&
        stoppedCls.preservation === 'preserve-when-unchanged' &&
        input.postBodyStoppedAt === input.preBodyStoppedAt &&
        typeof preFmSnapshot['stopped_at'] === 'string' &&
        preFmSnapshot['stopped_at'].length > 0 &&
        postFm['stopped_at'] !== preFmSnapshot['stopped_at']) {
        postFm['stopped_at'] = preFmSnapshot['stopped_at'];
        mutated = true;
    }
    // current_phase_name — curated (#1743/#1695). Table: preserve-always.
    const phaseNameCls = getFieldClassification('current_phase_name');
    if (phaseNameCls !== null &&
        phaseNameCls.preservation === 'preserve-always' &&
        input.postBodyPhaseSource === input.preBodyPhaseSource &&
        typeof preFmSnapshot['current_phase_name'] === 'string' &&
        preFmSnapshot['current_phase_name'].length > 0 &&
        postFm['current_phase_name'] !== preFmSnapshot['current_phase_name']) {
        postFm['current_phase_name'] = preFmSnapshot['current_phase_name'];
        mutated = true;
    }
    return { postFm, mutated };
}
// ----------------------------------------------------------------------------
// Body section constants (ADR-1769 §6 — single writer after migration)
// ----------------------------------------------------------------------------
/**
 * Top-level STATE.md section headings (H2). Aligned byte-for-byte with the
 * canonical template at `gsd-core/templates/state.md`. Sub-headings (H3) like
 * `### Decisions` / `### Pending Todos` / `### Blockers/Concerns` live under
 * `## Accumulated Context` and are not mutated by any Phase 1–7 transition;
 * they will be added here if a future transition needs them.
 *
 * Verified against `gsd-core/templates/state.md` (codex Phase 1 review).
 */
exports.STATE_MD_SECTIONS = {
    projectReference: '## Project Reference',
    currentPosition: '## Current Position',
    performanceMetrics: '## Performance Metrics',
    accumulatedContext: '## Accumulated Context',
    deferredItems: '## Deferred Items',
    sessionContinuity: '## Session Continuity',
};
// ----------------------------------------------------------------------------
// transitionCore — pure dispatch (ADR-1769 §3)
// ----------------------------------------------------------------------------
/**
 * Pure transition core. `(content, intent, deps) → result`.
 *
 * Discriminated-union dispatch via plain `switch` (ADR-1769 §2.7 Kernighan's
 * Law: debuggability over conciseness; the substrate sets the pattern).
 *
 * Phases 2–7 add cases for the remaining 9 intent kinds. A missing case is
 * a compile-time error (the function would not return on that path).
 */
function transitionCore(content, intent, deps) {
    switch (intent.kind) {
        case 'beginPhase':
            return beginPhaseCore(content, intent, deps);
        case 'advancePlan':
            return advancePlanCore(content, deps);
        case 'completePhase':
            return completePhaseCore(content, intent, deps);
        case 'plannedPhase':
            return plannedPhaseCore(content, intent, deps);
        case 'milestoneSwitch':
            return milestoneSwitchCore(content, intent, deps);
        case 'milestoneComplete':
            return milestoneCompleteCore(content, intent, deps);
        case 'patch':
            return patchCore(content, intent);
        case 'update':
            return updateCore(content, intent);
        case 'prune':
            return pruneCore(content, intent);
        case 'sync':
            return syncCore(content, intent, deps);
        case 'rebuild':
            return rebuildCore(content, intent, deps);
    }
}
// ----------------------------------------------------------------------------
// beginPhase — intent implementation (Phase 1)
// ----------------------------------------------------------------------------
/**
 * Apply a `beginPhase` transition to STATE.md content.
 *
 * Phase 1 scope (this file): the Status field update only. Subsequent
 * behaviors land via RED-GREEN cycles per the ADR-1769 migration plan:
 *   - Current Phase, Current Phase Name, Current Plan, Total Plans
 *   - Current Position section mutation
 *   - Idempotency guard (#3127)
 *   - Resume vs first-time branching
 *   - #1255 / #1257 format-detection parity
 *
 * Adapters that acquire the STATE.md lock and call this core live in
 * state.cts and consume the existing `readModifyWriteStateMd` post-sync
 * machinery (preserves the #1230 delta heuristic without re-implementing it).
 */
function beginPhaseCore(content, intent, deps) {
    const updated = [];
    // #1255: body-field replacements operate on body only (frontmatter stripped),
    // not on the full content. The YAML `status:` key matches `^Status:\s*`
    // before the body pipe-table row if full content is passed.
    const existingFm = extractFrontmatter(content);
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    let body = stripFrontmatter(content);
    const reassemble = (b) => hasFrontmatter
        ? `---\n${reconstructFrontmatter(existingFm)}\n---\n\n${b}`
        : b;
    const today = deps.clock.localToday();
    // Consult the field-classification table for the frontmatter keys this
    // transition touches (codex Phase 1 review: "table not consulted by
    // transitionCore"). The table tracks FRONTMATTER keys (lowercase: `status`,
    // `current_phase`, `last_activity`); body field names like `Status` /
    // `Current Phase` are aliases and aren't enforced here — they're driven by
    // the first-time/resume branching below, which encodes the same rules.
    // Phase 2+ will dispatch preservation based on this lookup.
    for (const fmKey of ['status', 'current_phase', 'current_plan', 'last_activity']) {
        const cls = getFieldClassification(fmKey);
        if (cls === null) {
            throw new Error(`transitionCore beginPhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
                `add a row per ADR-1769 §4 before touching it.`);
        }
    }
    // Helper: try to replace a body field; push to `updated` on success.
    // Body field names (Title Case: 'Status', 'Current Phase') are not in the
    // table — they're body-side aliases of classified frontmatter keys.
    const tryField = (name, value) => {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(body, name, value);
        if (replaced !== null) {
            body = replaced;
            updated.push(name);
        }
    };
    // #3127 idempotency guard: if Status already contains "Executing Phase N" for
    // the current phase number, this is a resume (e.g. --wave N continue). Skip
    // the first-time-only fields so mid-flight state (Current Plan, Total Plans,
    // Current Phase Name, Last Activity Description) is preserved.
    // Extract from body (not full content) so the YAML `status:` key cannot
    // shadow the body Status field (#1255).
    const currentStatus = (0, state_document_cjs_1.stateExtractField)(body, 'Status') || '';
    const isAlreadyExecuting = new RegExp(`Executing Phase\\s+${escapeRegex(String(intent.phaseNumber))}\\b`, 'i').test(currentStatus);
    // Status update (applies on both first-time and resume — Status is always refreshed).
    tryField('Status', `Executing Phase ${intent.phaseNumber}`);
    // Last Activity date — safe to refresh on resume (tracks when execute-phase ran).
    tryField('Last Activity', today);
    if (!isAlreadyExecuting) {
        // First-time execution: set all progress fields.
        tryField('Last Activity Description', `Phase ${intent.phaseNumber} execution started`);
        tryField('Current Phase', String(intent.phaseNumber));
        if (intent.phaseName) {
            tryField('Current Phase Name', intent.phaseName);
        }
        tryField('Current Plan', '1');
        if (intent.planCount) {
            tryField('Total Plans in Phase', String(intent.planCount));
        }
        // **Current focus:** body text line (#1104).
        const focusLabel = intent.phaseName
            ? `Phase ${intent.phaseNumber} — ${intent.phaseName}`
            : `Phase ${intent.phaseNumber}`;
        const focusPattern = /(\*\*Current focus:\*\*\s*).*/i;
        if (focusPattern.test(body)) {
            body = body.replace(focusPattern, (_match, prefix) => `${prefix}${focusLabel}`);
            updated.push('Current focus');
        }
        // ## Current Position section mutation (#1104, #1365).
        // `locateCurrentPosition` (fence-aware, tokenizeHeadings-based) locates
        // the section; mirrors state.cts:2261-2324 byte-for-behaviour.
        body = mutateCurrentPositionFirstTime(body, intent, today, updated);
    }
    else {
        // Resume path: only update Last activity timestamp in Current Position
        // (do not touch Plan:, Phase:, Status:, stopped_at, progress.percent).
        body = mutateCurrentPositionResume(body, intent, today, updated);
    }
    return { content: reassemble(body), updated };
}
/**
 * Find the `## Current Position` section, return its `{start, end}` byte
 * offsets in `body` (end is exclusive — first byte of the next section or
 * body.length). Returns `null` when the section is absent.
 *
 * ADR-1372 T6: tokenizeHeadings-based locator (fence-aware).
 */
function locateCurrentPosition(body) {
    const hs = (0, markdown_sectionizer_cjs_1.tokenizeHeadings)(body);
    const idx = hs.findIndex(h => h.level === 2 && /^current\s+position$/i.test(h.text));
    if (idx === -1)
        return null;
    const h = hs[idx];
    const lines = body.split('\n');
    const hl = lines[h.line - 1];
    const start = h.offset + hl.length + 1;
    let end = body.length;
    for (let j = idx + 1; j < hs.length; j++) {
        if (STOP_H2_PLUS(hs[j].level)) {
            end = hs[j].offset - 1;
            break;
        }
    }
    return { start, end };
}
/**
 * Return the body text of the `## Current Position` section, or `null` when it
 * is absent. Reuses the fence-aware `locateCurrentPosition` locator (ADR-1372).
 *
 * Exposed so callers that must read a position field (e.g. `cmdStatePrune`,
 * #1776) can scope extraction to the canonical section instead of the whole
 * document — where `stateExtractField`'s pipe-table fallback could otherwise
 * latch onto an unrelated `| Phase | N |` row elsewhere in STATE.md. This
 * scopes the *caller*; the shared extractor is left broad for every other use.
 */
function sliceCurrentPositionSection(body) {
    const span = locateCurrentPosition(body);
    return span === null ? null : body.slice(span.start, span.end);
}
/**
 * First-time ## Current Position mutation: update Phase / Plan / Status /
 * Last activity lines. Mirrors state.cts:2261-2324 byte-for-behaviour
 * (inline regex first, pipe-table fallback via stateReplaceField — #1257).
 *
 * F2 (#2245 review, MAJOR): a prior revision of this function used
 * `collectSection`/`replaceSection` here, whose default `levelBounded: true`
 * only stops the section at the next heading of level <= the opener's own
 * level (H1/H2 for a `##`-opened section) — an H3+ subsection nested under
 * `## Current Position` was NOT a stop boundary and got folded into
 * `sectionBody`, so the field regexes below (which run with the `m` flag,
 * matching ANY line start in the body) could clobber a same-named line
 * inside that subsection (the #2130/#2067/#2080 truncation/clobber class).
 * Restored to the fence-aware `locateCurrentPosition` locator (which stops
 * at ANY heading level >= 2, `STOP_H2_PLUS` — H2 through H6) + manual splice,
 * exactly matching the `mutateCurrentPositionResume`/
 * `mutateCurrentPositionForAdvance` siblings below, both of which use
 * `locateCurrentPosition` directly.
 */
function mutateCurrentPositionFirstTime(body, intent, today, updated) {
    const span = locateCurrentPosition(body);
    if (span === null)
        return body;
    let sectionBody = body.slice(span.start, span.end);
    // Phase line — inline first, then pipe-table fallback (#1257).
    const phaseLabel = `${intent.phaseNumber}${intent.phaseName ? ` (${intent.phaseName})` : ''} — EXECUTING`;
    if (/^Phase:/m.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Phase:.*$/m, `Phase: ${phaseLabel}`);
    }
    else {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Phase', phaseLabel);
        if (replaced !== null)
            sectionBody = replaced;
    }
    // Plan line.
    const planValue = `1 of ${intent.planCount || '?'}`;
    if (/^Plan:/m.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Plan:.*$/m, `Plan: ${planValue}`);
    }
    else {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Plan', planValue);
        if (replaced !== null)
            sectionBody = replaced;
    }
    // Status line.
    const statusValue = `Executing Phase ${intent.phaseNumber}`;
    if (/^Status:/m.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Status:.*$/m, `Status: ${statusValue}`);
    }
    else {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Status', statusValue);
        if (replaced !== null)
            sectionBody = replaced;
    }
    // Last activity line. The inline value carries date + narrative.
    const activityValue = `${today} — Phase ${intent.phaseNumber} execution started`;
    if (/^Last activity:/im.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Last activity:.*$/im, `Last activity: ${activityValue}`);
    }
    else {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Last Activity', activityValue) ??
            (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Last activity', activityValue);
        if (replaced !== null)
            sectionBody = replaced;
    }
    updated.push('Current Position');
    return body.slice(0, span.start) + sectionBody + body.slice(span.end);
}
/**
 * Resume ## Current Position mutation: only update Last activity line
 * (preserves Plan/Phase/Status — #3127). Mirrors state.cts:2329-2363
 * byte-for-behaviour.
 */
function mutateCurrentPositionResume(body, intent, today, updated) {
    const span = locateCurrentPosition(body);
    if (span === null)
        return body;
    let sectionBody = body.slice(span.start, span.end);
    const resumeActivity = `Last activity: ${today} — Phase ${intent.phaseNumber} execution resumed (wave continue)`;
    if (/^Last activity:/im.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Last activity:.*$/im, resumeActivity);
        updated.push('Last activity (resume)');
    }
    else {
        // Pipe-table format fallback (#1255).
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Last Activity', resumeActivity) ??
            (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Last activity', resumeActivity);
        if (replaced !== null) {
            sectionBody = replaced;
            updated.push('Last activity (resume)');
        }
    }
    return body.slice(0, span.start) + sectionBody + body.slice(span.end);
}
/**
 * Update fields within the ## Current Position section for advancePlan.
 * Mirrors `updateCurrentPositionFields` (state.cts:496) byte-for-behaviour:
 * only replaces Status / Last Activity when the existing value is a known
 * template default (Knuth invariant: preserve executor-authored values).
 * Plan is always replaced (system-derived, never executor-authored).
 *
 * Cannot import `updateCurrentPositionFields` from state.cjs directly (circular
 * dep: state.cjs → state-transition.cjs → state.cjs), so the mutation is
 * inlined here using the same primitives.
 */
function mutateCurrentPositionForAdvance(content, fields, statusDefaults, lastActivityDefaults) {
    const span = locateCurrentPosition(content);
    if (span === null)
        return content;
    let sectionBody = content.slice(span.start, span.end);
    let mutated = false;
    if (fields.status) {
        const replaced = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(sectionBody, 'Status', statusDefaults, fields.status);
        if (replaced !== null && replaced !== sectionBody) {
            sectionBody = replaced;
            mutated = true;
        }
    }
    if (fields.lastActivity) {
        const replaced = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(sectionBody, 'Last Activity', lastActivityDefaults, fields.lastActivity) ??
            (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(sectionBody, 'Last activity', lastActivityDefaults, fields.lastActivity);
        if (replaced !== null && replaced !== sectionBody) {
            sectionBody = replaced;
            mutated = true;
        }
    }
    if (fields.plan) {
        // Plan is always replaced — system-derived, not executor-authored.
        if (/^Plan:/m.test(sectionBody)) {
            sectionBody = sectionBody.replace(/^Plan:.*$/m, `Plan: ${fields.plan}`);
            mutated = true;
        }
        else {
            const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Plan', fields.plan);
            if (replaced !== null) {
                sectionBody = replaced;
                mutated = true;
            }
        }
    }
    if (!mutated)
        return content;
    return content.slice(0, span.start) + sectionBody + content.slice(span.end);
}
// ----------------------------------------------------------------------------
// advancePlan — intent implementation (Phase 2)
// ----------------------------------------------------------------------------
/**
 * Apply an `advancePlan` transition to STATE.md content.
 *
 * Parses Current Plan / Total Plans (legacy separate fields or compound
 * "Plan: X of Y" format), increments the plan number, updates body fields
 * and the ## Current Position section. When currentPlan >= totalPlans,
 * takes the phase-complete branch (sets Status to "Phase complete — ready
 * for verification") instead of advancing.
 *
 * Uses `stateReplaceFieldIfTemplate` (template-default-aware) to preserve
 * executor-authored field values (Knuth invariant from cmdStateAdvancePlan).
 *
 * Returns `data.advanced` / `data.currentPlan` / `data.totalPlans` for the
 * adapter to construct CLI output.
 */
function advancePlanCore(content, deps) {
    const today = deps.clock.localToday();
    // #1255: body-field replacements operate on body only (frontmatter stripped),
    // not on the full content. The YAML `status:` key matches `^Status:\s*`
    // before the body field if full content is passed (codex Phase 2 review:
    // HIGH blocking finding — same pattern beginPhaseCore already handles).
    const existingFm = extractFrontmatter(content);
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    let body = stripFrontmatter(content);
    const reassemble = (b) => hasFrontmatter
        ? `---\n${reconstructFrontmatter(existingFm)}\n---\n\n${b}`
        : b;
    // Parse plan number — legacy first, then compound.
    const legacyPlan = (0, state_document_cjs_1.stateExtractField)(content, 'Current Plan');
    const legacyTotal = (0, state_document_cjs_1.stateExtractField)(content, 'Total Plans in Phase');
    const planField = (0, state_document_cjs_1.stateExtractField)(content, 'Plan');
    let currentPlan;
    let totalPlans;
    let useCompoundFormat = false;
    if (legacyPlan && legacyTotal) {
        currentPlan = parseInt(legacyPlan, 10);
        totalPlans = parseInt(legacyTotal, 10);
    }
    else if (planField) {
        currentPlan = parseInt(planField, 10);
        const ofMatch = planField.match(/of\s+(\d+)/);
        totalPlans = ofMatch ? parseInt(ofMatch[1], 10) : NaN;
        useCompoundFormat = true;
    }
    else {
        currentPlan = NaN;
        totalPlans = NaN;
    }
    if (isNaN(currentPlan) || isNaN(totalPlans)) {
        return { content: reassemble(body), updated: [], data: { error: true } };
    }
    const updated = [];
    const statusDefaults = state_document_cjs_2.KNOWN_TEMPLATE_DEFAULTS['Status'];
    const lastActivityDefaults = state_document_cjs_2.KNOWN_TEMPLATE_DEFAULTS['Last Activity'];
    if (currentPlan >= totalPlans) {
        // Phase-complete branch.
        body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Status', statusDefaults, 'Phase complete — ready for verification') || body;
        body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Last Activity', lastActivityDefaults, today) || body;
        body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Last activity', lastActivityDefaults, today) || body;
        body = mutateCurrentPositionForAdvance(body, {
            status: 'Phase complete — ready for verification',
            lastActivity: today,
        }, statusDefaults, lastActivityDefaults);
        updated.push('Status', 'Last Activity', 'Current Position');
        return {
            content: reassemble(body),
            updated,
            data: { advanced: false, reason: 'last_plan', current_plan: currentPlan, total_plans: totalPlans, status: 'ready_for_verification' },
        };
    }
    // Normal advance branch.
    const newPlan = currentPlan + 1;
    let planDisplayValue;
    if (useCompoundFormat) {
        planDisplayValue = planField.replace(/^\d+/, String(newPlan));
        body = (0, state_document_cjs_1.stateReplaceField)(body, 'Plan', planDisplayValue) || body;
    }
    else {
        planDisplayValue = `${newPlan} of ${totalPlans}`;
        body = (0, state_document_cjs_1.stateReplaceField)(body, 'Current Plan', String(newPlan)) || body;
    }
    body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Status', statusDefaults, 'Ready to execute') || body;
    body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Last Activity', lastActivityDefaults, today) || body;
    body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Last activity', lastActivityDefaults, today) || body;
    body = mutateCurrentPositionForAdvance(body, {
        status: 'Ready to execute',
        lastActivity: today,
        plan: planDisplayValue,
    }, statusDefaults, lastActivityDefaults);
    updated.push('Current Plan', 'Status', 'Last Activity', 'Current Position');
    return {
        content: reassemble(body),
        updated,
        data: { advanced: true, previous_plan: currentPlan, current_plan: newPlan, total_plans: totalPlans },
    };
}
// ----------------------------------------------------------------------------
// completePhase — intent implementation (Phase 3)
// ----------------------------------------------------------------------------
/**
 * Apply a `completePhase` transition to STATE.md content.
 *
 * Migrates the inline STATE.md transform that lived inside `cmdPhaseComplete`
 * (phase.cts) onto the substrate. Owns the field-classification-governed body
 * mutations: Current Phase (preserving the `of total` shape and phase name),
 * Current Phase Name, Status (`All phases complete` on the last phase, else
 * `Ready to plan` per ADR-2207), Current Plan (`Not started`), Last Activity + Description,
 * and the Completed/Total Phases + Progress percent block (re-derived from the
 * roadmap via the injected `roadmapProvider`).
 *
 * The adapter (`cmdPhaseComplete`) retains two concerns that are NOT pure field
 * updates: `updatePerformanceMetricsSection` (a section table upsert) and
 * `syncStateFrontmatter` (the disk-scan post-sync). It also retains the
 * multi-file atomic transaction (`writePlanningFileSet`) that writes ROADMAP,
 * REQUIREMENTS, and STATE together — `readModifyWriteStateMd` is not used here
 * because STATE.md is committed atomically with the other two files.
 *
 * Behavior is byte-for-byte with the pre-migration `phase.cts:1671-1772` block
 * (verified by characterization tests in tests/state-transition.test.cjs).
 */
function completePhaseCore(content, intent, deps) {
    const updated = [];
    const today = deps.clock.localToday();
    // Consult the field-classification table for the frontmatter keys this
    // transition touches (same guard beginPhaseCore applies). A missing row is a
    // substrate defect — fail loudly rather than silently re-encoding policy.
    for (const fmKey of [
        'current_phase',
        'current_phase_name',
        'status',
        'current_plan',
        'last_activity',
        'last_activity_desc',
        'progress',
    ]) {
        const cls = getFieldClassification(fmKey);
        if (cls === null) {
            throw new Error(`transitionCore completePhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
                `add a row per ADR-1769 §4 before touching it.`);
        }
    }
    // #1255: body-field replacements operate on body only (frontmatter stripped),
    // so the YAML `status:` / `current_phase:` keys cannot shadow the body fields.
    const existingFm = extractFrontmatter(content);
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    let body = stripFrontmatter(content);
    const reassemble = (b) => hasFrontmatter
        ? `---\n${reconstructFrontmatter(existingFm)}\n---\n\n${b}`
        : b;
    // Current Phase — preserve the existing `of <total>` shape and the phase name
    // in parens (mirrors phase.cts:1675-1697 byte-for-behaviour).
    const phaseValue = intent.nextPhaseNum || intent.phaseNum;
    const nextPhaseDisplayName = intent.nextPhaseName;
    const existingPhaseField = (0, state_document_cjs_1.stateExtractField)(body, 'Current Phase') || (0, state_document_cjs_1.stateExtractField)(body, 'Phase');
    let newPhaseValue = String(phaseValue);
    if (existingPhaseField) {
        const totalMatch = existingPhaseField.match(/of\s+(\d+)/);
        const nameMatch = existingPhaseField.match(/\(([^)]+)\)/);
        if (totalMatch) {
            const total = totalMatch[1];
            const nameStr = nextPhaseDisplayName
                ? ` (${nextPhaseDisplayName})`
                : nameMatch
                    ? ` (${nameMatch[1]})`
                    : '';
            newPhaseValue = `${phaseValue} of ${total}${nameStr}`;
        }
        else if (nextPhaseDisplayName) {
            newPhaseValue = `${phaseValue} — ${nextPhaseDisplayName}`;
        }
    }
    const phaseAfter = (0, state_document_cjs_1.stateReplaceFieldWithFallback)(body, 'Current Phase', 'Phase', newPhaseValue);
    if (phaseAfter !== body) {
        body = phaseAfter;
        updated.push('Current Phase');
    }
    // Current Phase Name — only written when a next-phase display name is known
    // (#1743/#1695: classified curated/preserve-always, so an absent name does
    // NOT clear an existing curated value).
    if (nextPhaseDisplayName) {
        const after = (0, state_document_cjs_1.stateReplaceField)(body, 'Current Phase Name', nextPhaseDisplayName);
        if (after) {
            body = after;
            updated.push('Current Phase Name');
        }
    }
    // Status — `All phases complete` on the final phase (ADR-2207), otherwise
    // `Ready to plan`. Milestone termination (`<version> milestone complete`) is
    // owned solely by the milestone-close verb (milestoneCompleteCore).
    const statusValue = intent.isLastPhase ? 'All phases complete' : 'Ready to plan';
    const statusAfter = (0, state_document_cjs_1.stateReplaceFieldWithFallback)(body, 'Status', null, statusValue);
    if (statusAfter !== body) {
        body = statusAfter;
        updated.push('Status');
    }
    // Current Plan — reset for the next phase.
    const planAfter = (0, state_document_cjs_1.stateReplaceFieldWithFallback)(body, 'Current Plan', 'Plan', 'Not started');
    if (planAfter !== body) {
        body = planAfter;
        updated.push('Current Plan');
    }
    // Last Activity — prefer the prose `Last activity:` line (date + narrative)
    // when present, else the bold `Last Activity:` date field.
    const lastActivityDescription = `Phase ${intent.phaseNum} complete${intent.nextPhaseNum ? `, transitioned to Phase ${intent.nextPhaseNum}` : ''}`;
    if (/^Last activity:/m.test(body)) {
        const after = (0, state_document_cjs_1.stateReplaceField)(body, 'Last activity', `${today} — ${lastActivityDescription}`);
        if (after) {
            body = after;
            updated.push('Last Activity');
        }
    }
    else {
        const after = (0, state_document_cjs_1.stateReplaceField)(body, 'Last Activity', today);
        if (after) {
            body = after;
            updated.push('Last Activity');
        }
    }
    const ladAfter = (0, state_document_cjs_1.stateReplaceField)(body, 'Last Activity Description', lastActivityDescription);
    if (ladAfter) {
        body = ladAfter;
        updated.push('Last Activity Description');
    }
    // Progress block — re-derive completed/total phases from the roadmap when
    // available (milestone-wide source of truth), then recompute the percent.
    // Only runs when a Completed Phases field exists (the existing guard).
    const completedRaw = (0, state_document_cjs_1.stateExtractField)(body, 'Completed Phases');
    if (completedRaw !== null) {
        let newCompleted = parseInt(completedRaw, 10);
        let derivedTotalPhases = null;
        const roadmapContent = deps.roadmapProvider ? deps.roadmapProvider() : null;
        if (roadmapContent) {
            const derived = (0, phase_lifecycle_cjs_1.deriveProgressFromRoadmap)(roadmapContent);
            if (derived.completedPhases !== null)
                newCompleted = derived.completedPhases;
            if (derived.totalPhases !== null)
                derivedTotalPhases = derived.totalPhases;
        }
        const completedAfter = (0, state_document_cjs_1.stateReplaceField)(body, 'Completed Phases', String(newCompleted));
        if (completedAfter) {
            body = completedAfter;
            updated.push('Completed Phases');
        }
        const totalRaw = (0, state_document_cjs_1.stateExtractField)(body, 'Total Phases');
        const totalPhases = derivedTotalPhases || (totalRaw ? parseInt(totalRaw, 10) : null);
        if (totalPhases && totalPhases > 0) {
            const newPercent = (0, phase_lifecycle_cjs_1.clampPercent)(newCompleted, totalPhases);
            const progAfter = (0, state_document_cjs_1.stateReplaceField)(body, 'Progress', `${newPercent}%`);
            if (progAfter) {
                body = progAfter;
                updated.push('Progress');
            }
            // Inline `percent:` token (frontmatter / progress sub-block).
            body = body.replace(/(percent:\s*)\d+/, `$1${newPercent}`);
        }
    }
    return { content: reassemble(body), updated };
}
// ----------------------------------------------------------------------------
// plannedPhase — intent implementation (Phase 4)
// ----------------------------------------------------------------------------
/**
 * Apply a `plannedPhase` transition to STATE.md content.
 *
 * Migrates `cmdStatePlannedPhase` (state.cts) onto the substrate. Updates the
 * per-phase body fields after plan-phase runs: Status (template-aware — only
 * replaces handler-generated values, preserving executor-authored ones),
 * Total Plans in Phase, Last Activity (template-aware), Last Activity
 * Description, and the ## Current Position section. The adapter wraps this in
 * `readModifyWriteStateMd({ resync: false })` so the milestone-wide progress.*
 * frontmatter is NOT re-derived from a half-planned disk snapshot (#500 RC1).
 *
 * Uses `mutateCurrentPositionForAdvance` (the inlined twin of state.cts's
 * `updateCurrentPositionFields`) so the Knuth template-default invariant
 * applies inside the Current Position section too.
 */
function plannedPhaseCore(content, intent, deps) {
    const updated = [];
    const today = deps.clock.localToday();
    for (const fmKey of ['status', 'last_activity', 'last_activity_desc']) {
        const cls = getFieldClassification(fmKey);
        if (cls === null) {
            throw new Error(`transitionCore plannedPhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
                `add a row per ADR-1769 §4 before touching it.`);
        }
    }
    // #1255: body-field replacements operate on body only.
    const existingFm = extractFrontmatter(content);
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    let body = stripFrontmatter(content);
    const reassemble = (b) => hasFrontmatter
        ? `---\n${reconstructFrontmatter(existingFm)}\n---\n\n${b}`
        : b;
    const statusDefaults = state_document_cjs_2.KNOWN_TEMPLATE_DEFAULTS['Status'];
    const lastActivityDefaults = state_document_cjs_2.KNOWN_TEMPLATE_DEFAULTS['Last Activity'];
    // Status — template-aware (preserve executor-authored values).
    const statusAfter = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Status', statusDefaults, 'Ready to execute');
    if (statusAfter !== null && statusAfter !== body) {
        body = statusAfter;
        updated.push('Status');
    }
    // Total Plans in Phase — system-derived; always replaced when a count is given.
    if (intent.planCount !== null && intent.planCount !== undefined) {
        const result = (0, state_document_cjs_1.stateReplaceField)(body, 'Total Plans in Phase', String(intent.planCount));
        if (result) {
            body = result;
            updated.push('Total Plans in Phase');
        }
    }
    // Last Activity — template-aware.
    const lastActivityAfter = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Last Activity', lastActivityDefaults, today);
    if (lastActivityAfter !== null && lastActivityAfter !== body) {
        body = lastActivityAfter;
        updated.push('Last Activity');
    }
    // Last Activity Description.
    const ladResult = (0, state_document_cjs_1.stateReplaceField)(body, 'Last Activity Description', `Phase ${intent.phaseNumber} planning complete — ${intent.planCount || '?'} plans ready`);
    if (ladResult) {
        body = ladResult;
        updated.push('Last Activity Description');
    }
    // ## Current Position section — Status + Last activity (template-aware).
    const beforePos = body;
    body = mutateCurrentPositionForAdvance(body, {
        status: 'Ready to execute',
        lastActivity: `${today} — Phase ${intent.phaseNumber} planning complete`,
    }, statusDefaults, lastActivityDefaults);
    if (body !== beforePos)
        updated.push('Current Position');
    // #2400 Bug B: sync progress.total_plans to the frontmatter when a plan count
    // is given. This writes the explicitly-provided count — it is NOT a re-derivation
    // from disk (#500 RC1 is about deriving from a half-planned snapshot, not about
    // refusing to write an explicitly-passed argument).
    if (intent.planCount !== null && intent.planCount !== undefined && hasFrontmatter) {
        const fmProgress = existingFm['progress'] || {};
        if (fmProgress['total_plans'] !== intent.planCount) {
            fmProgress['total_plans'] = intent.planCount;
            existingFm['progress'] = fmProgress;
            updated.push('progress.total_plans');
        }
    }
    return { content: reassemble(body), updated };
}
// ----------------------------------------------------------------------------
// milestoneSwitch — intent implementation (Phase 4)
// ----------------------------------------------------------------------------
/**
 * Apply a `milestoneSwitch` transition to STATE.md content.
 *
 * Migrates `cmdStateMilestoneSwitch` (state.cts) onto the substrate. Resets
 * STATE.md for a new milestone cycle: rewrites the frontmatter (milestone,
 * milestone_name, status='planning', last_updated, last_activity, and the
 * progress block zeroed) and rewrites the ## Current Position body to the
 * "defining requirements" starting state. `gsd_state_version` is preserved.
 * Body content OUTSIDE Current Position (e.g. Accumulated Context) is
 * preserved.
 *
 * This is a destructive reset intent: it intentionally overwrites the curated
 * `progress` / `current_phase_name` fields (classified preserve-always) because
 * a new milestone starts from zero. That is the intent's contract, not a
 * violation of the field-classification table — the table governs the steady-
 * state RMW transitions; a milestone boundary is an explicit reset.
 *
 * The adapter wraps this in `acquireStateLock` + `platformWriteSync` (NOT
 * `readModifyWriteStateMd`) because milestoneSwitch rebuilds frontmatter
 * directly and must not run the steady-state `syncStateFrontmatter` post-sync.
 */
function milestoneSwitchCore(content, intent, deps) {
    const today = deps.clock.localToday();
    const updated = [
        'milestone',
        'milestone_name',
        'status',
        'last_updated',
        'last_activity',
        'progress',
        'Current Position',
    ];
    const existingFm = extractFrontmatter(content);
    const body = stripFrontmatter(content);
    const resolvedName = (intent.name && intent.name.trim()) || 'milestone';
    // ## Current Position reset body (mirrors state.cts:2371-2375).
    const resetPositionBody = `\nPhase: Not started (defining requirements)\n` +
        `Plan: —\n` +
        `Status: Defining requirements\n` +
        `Last activity: ${today} — Milestone ${intent.version} started\n\n`;
    let newBody;
    const hs = (0, markdown_sectionizer_cjs_1.tokenizeHeadings)(body);
    const posIdx = hs.findIndex((h) => h.level === 2 && /^current\s+position$/i.test(h.text));
    if (posIdx !== -1) {
        const h = hs[posIdx];
        const lines = body.split('\n');
        const hl = lines[h.line - 1];
        const bodyStart = h.offset + hl.length + 1;
        let bodyEnd = body.length;
        for (let j = posIdx + 1; j < hs.length; j++) {
            if (STOP_H2_PLUS(hs[j].level)) {
                bodyEnd = hs[j].offset - 1;
                break;
            }
        }
        newBody = body.slice(0, bodyStart) + resetPositionBody + body.slice(bodyEnd);
    }
    else {
        const preface = body.trim().length > 0 ? body : '# Project State\n';
        newBody = `${preface.trimEnd()}\n\n## Current Position\n${resetPositionBody}`;
    }
    // Rebuilt frontmatter — curated fields are intentionally reset (milestone
    // boundary). gsd_state_version is preserved.
    const fm = {
        gsd_state_version: existingFm['gsd_state_version'] || '1.0',
        milestone: intent.version,
        milestone_name: resolvedName,
        status: 'planning',
        last_updated: deps.clock.nowIso(),
        last_activity: today,
        progress: {
            total_phases: 0,
            completed_phases: 0,
            total_plans: 0,
            completed_plans: 0,
            percent: 0,
        },
    };
    const yamlStr = reconstructFrontmatter(fm);
    const assembled = `---\n${yamlStr}\n---\n\n${newBody.replace(/^\n+/, '')}`;
    return { content: assembled, updated };
}
// ----------------------------------------------------------------------------
// milestoneComplete — intent implementation (Phase 5)
// ----------------------------------------------------------------------------
/**
 * Replace a section's ENTIRE body with `newBody`, discarding whatever was
 * there — the "wholesale reset" write pattern used by milestoneComplete's
 * closure write (## Current Position / ## Operator Next Steps). Retires the
 * fence-blind raw regex `(##\s*<heading>\s*\n)([\s\S]*?)(?=\n##|$)`, which a
 * literal `##` inside a fenced code block in the section body could fool into
 * stopping early (the #2130/#2067/#2080 truncation class) — heading location
 * here goes through `tokenizeHeadings`, which is fence-aware.
 *
 * Byte-parity note: the retired regex's greedy `\s*` (before its mandatory
 * `\n`) swallowed any blank line(s) immediately after the heading into the
 * discarded match, and its non-greedy body match always left exactly ONE
 * newline unconsumed before the next heading (or EOF), regardless of how many
 * blank lines originally separated the section from what followed. Both
 * edges are reproduced explicitly (rather than delegated to `collectSection`'s
 * `trimEnd()`-based body, which trims a *different* amount and would drift
 * the surrounding blank-line count) so `newBody`'s own leading/trailing
 * formatting is exactly what appears in the output.
 *
 * Returns `null` when no heading matches `headingPredicate` (mirrors the
 * retired regex's `pattern.test(body)` miss) — callers fall back to their own
 * append-a-new-section path.
 */
function resetSectionVerbatim(content, headingPredicate, newBody) {
    const headings = (0, markdown_sectionizer_cjs_1.tokenizeHeadings)(content);
    const idx = headings.findIndex(headingPredicate);
    if (idx === -1)
        return null;
    const target = headings[idx];
    const lines = content.split('\n');
    const headingLineEnd = target.offset + lines[target.line - 1].length + 1;
    // Swallow blank line(s) immediately after the heading (mirrors the retired
    // regex's greedy `\s*` folding them into the discarded match).
    //
    // F7 (#2245 review, nit): recognise a CRLF blank line (`\r\n`), not only a
    // bare LF — a lone `content[bodyStart] === '\n'` check never advances past
    // a `\r` byte, so on a CRLF STATE.md the blank line right after the
    // heading fell into the DISCARDED [bodyStart, bodyEnd) span instead of the
    // KEPT prefix, silently dropping one blank line (contradicting this
    // function's own byte-parity docstring).
    let bodyStart = headingLineEnd;
    while (bodyStart < content.length) {
        if (content[bodyStart] === '\n') {
            bodyStart += 1;
            continue;
        }
        if (content[bodyStart] === '\r' && content[bodyStart + 1] === '\n') {
            bodyStart += 2;
            continue;
        }
        break;
    }
    // Stop at the next heading of level >= 2 (mirrors the retired regex's
    // literal `##` lookahead, which matches any ATX heading two-or-more levels
    // deep); leave exactly one newline unconsumed before it, or run to EOF.
    let bodyEnd = content.length;
    for (let j = idx + 1; j < headings.length; j++) {
        if (STOP_H2_PLUS(headings[j].level)) {
            bodyEnd = headings[j].offset - 1;
            break;
        }
    }
    return content.slice(0, bodyStart) + newBody + content.slice(bodyEnd);
}
/**
 * Apply a `milestoneComplete` transition to STATE.md content.
 *
 * Migrates the STATE.md write path inside `cmdMilestoneComplete` (milestone.cts)
 * onto the substrate. Owns the closure write: Status (`<version> milestone
 * complete`), Last Activity, Last Activity Description, a ## Current Position
 * reset to the "Awaiting next milestone" state, and a ## Operator Next Steps
 * reset pointing at the next-milestone command.
 *
 * The adapter (`cmdMilestoneComplete`) retains `writeStateMd` (the writer that
 * owns the lock + steady-state syncStateFrontmatter post-sync) and resolves the
 * runtime-specific next-milestone slash command, injecting it via
 * `intent.nextMilestoneCommand` so the core stays pure.
 *
 * Behavior is byte-for-byte with the pre-migration milestone.cts:314-353 block.
 */
function milestoneCompleteCore(content, intent, deps) {
    const updated = [];
    const today = deps.clock.localToday();
    const version = intent.version;
    for (const fmKey of ['status', 'last_activity', 'last_activity_desc']) {
        const cls = getFieldClassification(fmKey);
        if (cls === null) {
            throw new Error(`transitionCore milestoneComplete: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
                `add a row per ADR-1769 §4 before touching it.`);
        }
    }
    // #1255: body-field replacements operate on body only.
    const existingFm = extractFrontmatter(content);
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    let body = stripFrontmatter(content);
    const reassemble = (b) => hasFrontmatter
        ? `---\n${reconstructFrontmatter(existingFm)}\n---\n\n${b}`
        : b;
    // Status — `<version> milestone complete`.
    const statusAfter = (0, state_document_cjs_1.stateReplaceFieldWithFallback)(body, 'Status', null, `${version} milestone complete`);
    if (statusAfter !== body) {
        body = statusAfter;
        updated.push('Status');
    }
    // Last Activity.
    const lastActivityAfter = (0, state_document_cjs_1.stateReplaceFieldWithFallback)(body, 'Last Activity', 'Last activity', today);
    if (lastActivityAfter !== body) {
        body = lastActivityAfter;
        updated.push('Last Activity');
    }
    // Last Activity Description.
    const ladAfter = (0, state_document_cjs_1.stateReplaceFieldWithFallback)(body, 'Last Activity Description', null, `${version} milestone completed and archived`);
    if (ladAfter !== body) {
        body = ladAfter;
        updated.push('Last Activity Description');
    }
    // ## Current Position reset — stop resume/progress flows pointing at closed
    // execution instructions.
    const closedPositionBody = `\nPhase: Milestone ${version} complete\n` +
        `Plan: —\n` +
        `Status: Awaiting next milestone\n` +
        `Last activity: ${today} — Milestone ${version} completed and archived\n\n`;
    const positionReset = resetSectionVerbatim(body, (h) => h.level === 2 && /^current\s+position$/i.test(h.text), closedPositionBody);
    if (positionReset !== null) {
        body = positionReset;
    }
    else {
        body = `${body.trimEnd()}\n\n## Current Position\n${closedPositionBody}`;
    }
    updated.push('Current Position');
    // ## Operator Next Steps — normalize stale tails that can persist after close.
    const operatorReset = resetSectionVerbatim(body, (h) => h.level === 2 && /^operator\s+next\s+steps$/i.test(h.text), `\n- Start the next milestone with ${intent.nextMilestoneCommand}\n\n`);
    if (operatorReset !== null) {
        body = operatorReset;
    }
    else {
        body = `${body.trimEnd()}\n\n## Operator Next Steps\n\n- Start the next milestone with ${intent.nextMilestoneCommand}\n`;
    }
    updated.push('Operator Next Steps');
    return { content: reassemble(body), updated };
}
// ----------------------------------------------------------------------------
// patch — intent implementation (Phase 6)
// ----------------------------------------------------------------------------
/**
 * Apply a `patch` transition to STATE.md content.
 *
 * Migrates `cmdStatePatch` (state.cts) onto the substrate. Applies each
 * caller-supplied `{field: value}` pair via `stateReplaceField` over the full
 * content (body + frontmatter — patch can target either), tracking which fields
 * were updated vs. not found.
 *
 * The curated-field preservation that fixes #1743/#1695 is NOT in this core —
 * it lives in `readModifyWriteStateMd`'s post-sync delta (table-driven via
 * `getFieldClassification('current_phase_name').preservation === 'preserve-always'`).
 * `patch` consulting the table "refuses to overwrite" curated fields implicitly:
 * when the patch does not change a curated field's body source line, the
 * existing frontmatter value wins over the sync re-derivation. The adapter
 * still owns field-name validation (security) and the resync-progress decision.
 *
 * `data.updated` / `data.failed` mirror the pre-migration CLI output shape.
 */
function patchCore(content, intent) {
    const updated = [];
    const failed = [];
    let result = content;
    for (const [field, value] of Object.entries(intent.patches)) {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(result, field, value);
        if (replaced !== null) {
            result = replaced;
            updated.push(field);
        }
        else {
            failed.push(field);
        }
    }
    return { content: result, updated, data: { updated, failed } };
}
// ----------------------------------------------------------------------------
// update — intent implementation (Phase 7)
// ----------------------------------------------------------------------------
/**
 * Apply an `update` transition to STATE.md content.
 *
 * Migrates `cmdStateUpdate` (state.cts) onto the substrate. A single-field
 * body-only update (the field is replaced in the body; frontmatter is preserved
 * as-is and re-synced by the adapter's `readModifyWriteStateMd` post-sync).
 * Mirrors the pre-migration body-strip/reassemble contract.
 */
function updateCore(content, intent) {
    const existingFm = extractFrontmatter(content);
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    const body = stripFrontmatter(content);
    const result = (0, state_document_cjs_1.stateReplaceField)(body, intent.field, intent.value);
    if (result === null) {
        return { content, updated: [], data: { updated: false } };
    }
    const reassembled = hasFrontmatter
        ? `---\n${reconstructFrontmatter(existingFm)}\n---\n\n${result}`
        : result;
    return { content: reassembled, updated: [intent.field], data: { updated: true } };
}
// Stop predicate for prune section slicing: a level-2 OR level-3 heading ends
// the section (mirrors state.cts STOP_H2_H3 — Decisions / Recently Completed /
// Blockers / Performance Metrics live at H2 or H3).
const STOP_H2_H3 = (lv) => lv === 2 || lv === 3;
/**
 * Apply a `prune` transition to STATE.md content.
 *
 * Migrates the section-pruning half of `cmdStatePrune` (state.cts) onto the
 * substrate. Pure `content → {content, archivedSections}` given a cutoff phase:
 * archives Decisions / Recently Completed / resolved Blockers / Performance
 * Metrics table rows whose phase number is <= cutoff. ADR-1372 T6
 * tokenizeHeadings + untrimmed-span splicing, byte-identical to the pre-migration
 * `prunePass`.
 *
 * The adapter owns currentPhase derivation (with the #1760 `Phase` / `Current
 * Phase` fallback), keepRecent/dryRun, and STATE-ARCHIVE.md writes.
 */
function pruneCore(content, intent) {
    const cutoff = intent.cutoff;
    const sections = [];
    let c = content;
    // Helper: locate a heading matching pred, extract untrimmed body [bs, se),
    // apply transform, splice back. All prune sections stop at level 2 or 3.
    const pruneSectionSpan = (pred, transform, sectionName) => {
        const hs = (0, markdown_sectionizer_cjs_1.tokenizeHeadings)(c);
        const i = hs.findIndex((h) => pred(h.level, h.text));
        if (i === -1)
            return;
        const h = hs[i];
        const ls = c.split('\n');
        const hl = ls[h.line - 1];
        const bs = h.offset + hl.length + 1;
        let se = c.length;
        for (let j = i + 1; j < hs.length; j++) {
            if (STOP_H2_H3(hs[j].level)) {
                se = hs[j].offset - 1;
                break;
            }
        }
        const body = c.slice(bs, se);
        const { keep, archive } = transform(body);
        if (archive.length > 0) {
            sections.push({ section: sectionName, count: archive.length, lines: archive });
            c = c.slice(0, bs) + keep.join('\n') + c.slice(se);
        }
    };
    pruneSectionSpan((lv, text) => (lv === 2 || lv === 3) && /^(?:Decisions|Decisions Made|Accumulated.*Decisions)$/i.test(text), (body) => {
        const keep = [], archive = [];
        for (const line of body.split('\n')) {
            const phaseMatch = line.match(/^\s*-\s*\[Phase\s+(\d+)/i);
            if (phaseMatch && parseInt(phaseMatch[1], 10) <= cutoff) {
                archive.push(line);
            }
            else {
                keep.push(line);
            }
        }
        return { keep, archive };
    }, 'Decisions');
    pruneSectionSpan((lv, text) => (lv === 2 || lv === 3) && /^recently\s+completed$/i.test(text), (body) => {
        const keep = [], archive = [];
        for (const line of body.split('\n')) {
            const phaseMatch = line.match(/Phase\s+(\d+)/i);
            if (phaseMatch && parseInt(phaseMatch[1], 10) <= cutoff) {
                archive.push(line);
            }
            else {
                keep.push(line);
            }
        }
        return { keep, archive };
    }, 'Recently Completed');
    pruneSectionSpan((lv, text) => (lv === 2 || lv === 3) && /^(?:Blockers|Blockers\/Concerns|Blockers\s*&\s*Concerns)$/i.test(text), (body) => {
        const keep = [], archive = [];
        for (const line of body.split('\n')) {
            const isResolved = /~~.*~~|\[RESOLVED\]/i.test(line);
            const phaseMatch = line.match(/Phase\s+(\d+)/i);
            if (isResolved && phaseMatch && parseInt(phaseMatch[1], 10) <= cutoff) {
                archive.push(line);
            }
            else {
                keep.push(line);
            }
        }
        return { keep, archive };
    }, 'Blockers (resolved)');
    pruneSectionSpan((lv, text) => (lv === 2 || lv === 3) && /^performance\s+metrics$/i.test(text), (body) => {
        const keep = [], archive = [];
        for (const line of body.split('\n')) {
            const tableRowMatch = line.match(/^\|\s*(\d+)\s*\|/);
            if (tableRowMatch) {
                const rowPhase = parseInt(tableRowMatch[1], 10);
                if (rowPhase <= cutoff) {
                    archive.push(line);
                }
                else {
                    keep.push(line);
                }
            }
            else {
                keep.push(line);
            }
        }
        return { keep, archive };
    }, 'Performance Metrics');
    const totalPruned = sections.reduce((sum, s) => sum + s.count, 0);
    return {
        content: c,
        updated: totalPruned > 0 ? ['pruned'] : [],
        data: { archivedSections: sections, totalPruned },
    };
}
// ----------------------------------------------------------------------------
// sync — intent implementation (Phase 7)
// ----------------------------------------------------------------------------
/**
 * Apply a `sync` transition to STATE.md content.
 *
 * Migrates the body-write half of `cmdStateSync` (state.cts) onto the substrate.
 * Updates Total Plans in Phase, the Progress bar, and Last Activity from
 * disk-derived numbers (injected via the intent). Returns the per-field change
 * log via `data.changes` so the adapter can build the CLI output.
 *
 * #1761: when the current milestone cannot be bounded to a versioned phase set,
 * the adapter passes `percent: null` and this core leaves Progress untouched
 * (rather than silently writing fallback-derived wrong values).
 */
function syncCore(content, intent, deps) {
    const today = deps.clock.localToday();
    const changes = [];
    let modified = content;
    const updated = [];
    if (intent.totalPlansInPhase !== null) {
        const currentPlansField = (0, state_document_cjs_1.stateExtractField)(modified, 'Total Plans in Phase');
        if (currentPlansField && parseInt(currentPlansField, 10) !== intent.totalPlansInPhase) {
            changes.push(`Total Plans in Phase: ${currentPlansField} -> ${intent.totalPlansInPhase}`);
            const result = (0, state_document_cjs_1.stateReplaceField)(modified, 'Total Plans in Phase', String(intent.totalPlansInPhase));
            if (result) {
                modified = result;
                updated.push('Total Plans in Phase');
            }
        }
    }
    if (intent.percent !== null) {
        const currentProgress = (0, state_document_cjs_1.stateExtractField)(modified, 'Progress');
        if (currentProgress) {
            const currentPercent = parseInt(currentProgress.replace(/[^\d]/g, ''), 10);
            if (currentPercent !== intent.percent) {
                const barWidth = 10;
                const filled = Math.round((intent.percent / 100) * barWidth);
                const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
                const progressStr = `[${bar}] ${intent.percent}%`;
                changes.push(`Progress: ${currentProgress} -> ${progressStr}`);
                const result = (0, state_document_cjs_1.stateReplaceField)(modified, 'Progress', progressStr);
                if (result) {
                    modified = result;
                    updated.push('Progress');
                }
            }
        }
    }
    const lastActivityResult = (0, state_document_cjs_1.stateReplaceField)(modified, 'Last Activity', today);
    if (lastActivityResult) {
        const oldActivity = (0, state_document_cjs_1.stateExtractField)(modified, 'Last Activity');
        if (oldActivity !== today) {
            changes.push(`Last Activity: ${oldActivity} -> ${today}`);
            updated.push('Last Activity');
        }
        modified = lastActivityResult;
    }
    return { content: modified, updated, data: { changes } };
}
// ----------------------------------------------------------------------------
// rebuild — intent implementation (ADR-1817, capstone 11th transition)
// ----------------------------------------------------------------------------
//
// Implements the body-structure derivability contract (ADR-1817 §2–§6):
//   - §2  re-derives derived sections (## Current Position prose, By Phase table
//         inside ## Performance Metrics), preserves curated sections verbatim
//         (## Accumulated Context, ## Deferred Items, ## Project Reference, ##
//         Session Continuity's prose fields) and unknown sections.
//   - §3  every mutation appends a structured entry to ## Rebuild Log
//         (ADR-1411 provenance principle — never drop silently).
//   - §4  idempotency: a no-mutation rebuild appends NO log entry, so two
//         successive runs on a clean file are byte-identical.
//   - §5  non-overlapping with sync (sync = 3 frontmatter fields, lightweight,
//         auto-triggered; rebuild = body structure, heavier, manual).
//   - §6  orthogonal to auto_prune_state (rebuild reconciles with current
//         canonical sources; prune removes by retention policy).
//
// Section ordering is invariant: rebuild rewrites content IN PLACE; it does
// not reorder, insert (other than ## Rebuild Log when absent), or remove
// sections.
const REBUILD_LOG_SECTION = '## Rebuild Log';
const REBUILD_LOG_TRUNCATION_LIMIT = 512;
/**
 * Truncate a string for inclusion in a rebuild log entry. Per ADR-1817 §3 the
 * `before` / `after` fields are bounded to REBUILD_LOG_TRUNCATION_LIMIT chars
 * to prevent unbounded log growth when the drifted content is large.
 */
function truncateForLog(s) {
    if (s.length <= REBUILD_LOG_TRUNCATION_LIMIT)
        return s;
    return s.slice(0, REBUILD_LOG_TRUNCATION_LIMIT - 3) + '...';
}
/**
 * Apply a `rebuild` transition to STATE.md content. Pure core per ADR-1769 §3
 * and ADR-1817 §1. Returns `{ content, updated, data }` where `data.mutated`
 * is false when no drift was found (idempotency contract, ADR-1817 §4).
 */
function rebuildCore(content, _intent, deps) {
    const timestamp = deps.clock.nowIso();
    const log = [];
    let modified = content;
    // §2 Decision: re-derive derived sections, preserve others. Order is
    // oldest-section-first so log entries appear in body order.
    modified = reconcileCurrentPosition(modified, timestamp, log);
    modified = reconcileByPhaseTable(modified, deps, timestamp, log);
    modified = stripTemplatePlaceholders(modified, timestamp, log);
    modified = deduplicateSessionArchive(modified, timestamp, log);
    // §3 + §4: append the audit log ONLY when mutations occurred. The
    // log-appends-only-on-mutation rule is what makes idempotency byte-identical
    // (without it, the second invocation would always append a no-op entry).
    if (log.length > 0) {
        modified = appendRebuildLogSection(modified, log);
    }
    const updated = log.length > 0 ? ['rebuild'] : [];
    return {
        content: modified,
        updated,
        data: {
            mutated: log.length > 0,
            mutations: log.length,
            log,
        },
    };
}
/**
 * §2 — re-derive `## Current Position` prose fields from frontmatter.
 *
 * Drift class: `Phase:`, `Status:` etc. in body contradict frontmatter after
 * a milestone switch or prune (epic #1817). The body prose is re-derivable
 * because `buildStateFrontmatter` already derives the canonical values from
 * disk; rebuild pushes those back into the body prose.
 *
 * Implementation: pull each canonical value from frontmatter and replace the
 * body field via `stateReplaceField`. Skip silently when frontmatter lacks
 * the key (Leaky-Abstractions guard — don't synthesize values the canonical
 * source doesn't have).
 */
function reconcileCurrentPosition(content, timestamp, log) {
    const fm = extractFrontmatter(content);
    if (!fm || typeof fm !== 'object')
        return content;
    let modified = content;
    // Phase prose: frontmatter `current_phase` overrides body `**Current Phase:**`.
    // The body `Phase:` prose line (e.g. "Phase: 3 of 12 (Test Phase)") is owned
    // by other transitions (beginPhase / completePhase) and reconstructed from
    // total-phase counts; rebuild reconciles only the `**Current Phase:**` body
    // field that frontmatter is the canonical source for.
    const fmPhase = fm.current_phase;
    if (typeof fmPhase === 'string' || typeof fmPhase === 'number') {
        const canonicalPhase = String(fmPhase);
        const existing = (0, state_document_cjs_1.stateExtractField)(modified, 'Current Phase');
        if (existing !== null && existing !== canonicalPhase) {
            const replaced = (0, state_document_cjs_1.stateReplaceField)(modified, 'Current Phase', canonicalPhase);
            if (replaced !== null) {
                modified = replaced;
                log.push({
                    timestamp,
                    kind: 'current-position-reconciled',
                    section: exports.STATE_MD_SECTIONS.currentPosition,
                    before: truncateForLog(existing),
                    after: truncateForLog(canonicalPhase),
                    reason: "frontmatter 'current_phase' is canonical; body 'Current Phase' was stale",
                });
            }
        }
    }
    // Phase name prose.
    const fmPhaseName = fm.current_phase_name;
    if (typeof fmPhaseName === 'string' || typeof fmPhaseName === 'number') {
        const canonicalName = String(fmPhaseName);
        const existing = (0, state_document_cjs_1.stateExtractField)(modified, 'Current Phase Name');
        if (existing !== null && existing !== canonicalName) {
            const replaced = (0, state_document_cjs_1.stateReplaceField)(modified, 'Current Phase Name', canonicalName);
            if (replaced !== null) {
                modified = replaced;
                log.push({
                    timestamp,
                    kind: 'current-position-reconciled',
                    section: exports.STATE_MD_SECTIONS.currentPosition,
                    before: truncateForLog(existing),
                    after: truncateForLog(canonicalName),
                    reason: "frontmatter 'current_phase_name' is canonical; body 'Current Phase Name' was stale",
                });
            }
        }
    }
    return modified;
}
/**
 * §2 — re-derive the `**By Phase:**` table inside `## Performance Metrics`
 * from the injected `phaseInventoryProvider`. Drift class: orphaned rows for
 * phases from a prior milestone, or zero-padded phase IDs that were renamed
 * (epic #1817).
 *
 * Leaky-Abstractions guard (ADR-1817 §1): when `phaseInventoryProvider` is
 * absent (no disk scan wired), this step is a no-op. The core stays pure and
 * testable without disk I/O.
 */
function reconcileByPhaseTable(content, deps, timestamp, log) {
    if (!deps.phaseInventoryProvider)
        return content;
    const inventory = deps.phaseInventoryProvider();
    if (!inventory || inventory.length === 0)
        return content;
    // The canonical table shape (from gsd-core/templates/state.md):
    //   | Phase | Plans | Total | Avg/Plan |
    //   |-------|-------|-------|----------|
    //   | -     | -     | -     | -        |
    // rebuild renders one row per inventory record (Phase N: P plans). The
    // Total/Avg columns are runtime-collected by other commands; rebuild does
    // NOT re-derive them and resets them to '-' so future plan-completion
    // repopulates. The canonical reconciliation target is the row SET.
    const tableRows = inventory.map((r) => `| ${r.number} | ${r.planCount} | - | - |`);
    const canonicalTable = [
        '| Phase | Plans | Total | Avg/Plan |',
        '|-------|-------|-------|----------|',
        ...tableRows,
    ];
    // Line-based splice: find `**By Phase:**` line, then walk forward collecting
    // the table block (header + separator + body rows), replace the block with
    // the canonical table preceded by a single blank-line separator.
    const lines = content.split('\n');
    const markerIdx = lines.findIndex((l) => l.trim() === '**By Phase:**');
    if (markerIdx === -1)
        return content; // unknown shape — preserve verbatim
    // Walk forward from markerIdx+1 to find the table block span. Skip leading
    // blank lines; once we see the first table row, consume subsequent table
    // rows; stop at the first non-table line after we've started.
    let blockStart = -1;
    let blockEnd = -1;
    for (let i = markerIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        const isTable = trimmed.startsWith('|') && trimmed.endsWith('|');
        if (blockStart === -1) {
            if (isTable) {
                blockStart = i;
                blockEnd = i + 1;
            }
            else if (trimmed === '')
                continue;
            else
                break; // non-table, non-blank before any row — unknown shape
        }
        else {
            if (isTable)
                blockEnd = i + 1;
            else
                break;
        }
    }
    if (blockStart === -1)
        return content; // no table found
    // Replace lines[blockStart..blockEnd) with canonicalTable.
    const beforeBlock = lines.slice(0, markerIdx + 1);
    const afterBlock = lines.slice(blockEnd);
    // Splice: `**By Phase:**` + blank + canonicalTable rows + (whatever came after)
    const newLines = [...beforeBlock, '', ...canonicalTable, ...afterBlock];
    const candidate = newLines.join('\n');
    if (candidate === content)
        return content;
    log.push({
        timestamp,
        kind: 'by-phase-table-reconciled',
        section: exports.STATE_MD_SECTIONS.performanceMetrics,
        before: truncateForLog(lines.slice(blockStart, blockEnd).join('\n')),
        after: truncateForLog(canonicalTable.join('\n')),
        reason: 'phase dirs on disk are canonical; rows for missing phases dropped, missing phases added',
    });
    return candidate;
}
/**
 * §2 + epic-#1817 drift class — template-placeholder field values left in
 * place when an AI agent wrote partial state. The canonical template uses
 * `[X]`, `[Y]`, `[Phase name]`, `[date]`, `[N]`, etc. (see
 * `gsd-core/templates/state.md`). Rebuild clears any `**Field:** [placeholder]`
 * line where the value still matches the placeholder shape.
 *
 * "Clears" means: leaves the field in place with the literal text `(pending)`,
 * signalling that rebuild recognized the placeholder but had no canonical
 * source to substitute. This is honest — better than silently leaving `[X]`
 * which looks like a value.
 */
const TEMPLATE_PLACEHOLDER_VALUE = /^\s*\[[^\]]{1,200}\]\s*$|^\s*-\s*$/;
function stripTemplatePlaceholders(content, timestamp, log) {
    // Scan body `**Field:** value` lines; when value matches the placeholder
    // shape, replace with `(pending)`. We deliberately do NOT touch fields that
    // other transitions actively maintain (syncCore's three, beginPhase's set,
    // etc.) — only the template placeholder rows that nothing has touched.
    const lines = content.split('\n');
    const replacements = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/^\s*\*\*([^*]+):\*\*\s*(.*)$/);
        if (!m)
            continue;
        const fieldName = m[1];
        const value = m[2];
        if (TEMPLATE_PLACEHOLDER_VALUE.test(value)) {
            const cleared = `**${fieldName}:** (pending)`;
            replacements.push({ lineIdx: i, before: line, after: cleared, fieldName });
        }
    }
    if (replacements.length === 0)
        return content;
    for (const r of replacements) {
        lines[r.lineIdx] = r.after;
        log.push({
            timestamp,
            kind: 'placeholder-removed',
            section: exports.STATE_MD_SECTIONS.currentPosition,
            before: truncateForLog(r.before.trim()),
            after: truncateForLog(r.after),
            reason: `field ${JSON.stringify(r.fieldName)} still carried template placeholder ${JSON.stringify(r.before.match(/\*\*[^*]+:\*\*\s*(.*)$/)?.[1]?.trim() ?? '')}; no canonical source available — replaced with (pending)`,
        });
    }
    return lines.join('\n');
}
/**
 * §2 + epic-#1817 drift class — duplicate `## Session Continuity Archive`
 * blocks from repeated `state record-session` calls on a corrupt file. The
 * canonical template has one `## Session Continuity` section; archived blocks
 * may accumulate as `### Session — <timestamp>` H3 sub-sections under it.
 * Rebuild keeps the most-recent N (default 3) and drops older duplicates,
 * logging each drop.
 *
 * Conservative scope: only acts when the section has more than 3 H3
 * `### Session —` sub-headings; otherwise it's a no-op (preserve verbatim).
 */
const DEFAULT_MAX_SESSION_ARCHIVES = 3;
// `tokenizeHeadings` strips leading `#` markers — `h.text` for `### Session — X`
// is just `Session — X`. Match the bare heading text.
const SESSION_ARCHIVE_H3 = /^Session\s+—/;
function deduplicateSessionArchive(content, timestamp, log) {
    const hs = (0, markdown_sectionizer_cjs_1.tokenizeHeadings)(content);
    // Find `## Session Continuity` H2.
    const sectionIdx = hs.findIndex((h) => h.level === 2 && h.text === 'Session Continuity');
    if (sectionIdx === -1)
        return content;
    // Find the section span: from this H2's offset to the next H2 (or EOF).
    const sectionStart = hs[sectionIdx].offset;
    let sectionEnd = content.length;
    for (let i = sectionIdx + 1; i < hs.length; i++) {
        if (hs[i].level === 2) {
            sectionEnd = hs[i].offset;
            break;
        }
    }
    // Count `### Session — …` H3 sub-headings inside the section.
    const archiveHeadings = hs.filter((h) => h.level === 3 && h.offset >= sectionStart && h.offset < sectionEnd && SESSION_ARCHIVE_H3.test(h.text));
    if (archiveHeadings.length <= DEFAULT_MAX_SESSION_ARCHIVES)
        return content;
    // Keep the most-recent N by offset (last N in document order; if timestamps
    // in the H3 text are in chronological order — the template convention —
    // last-N == most-recent-N).
    const dropCount = archiveHeadings.length - DEFAULT_MAX_SESSION_ARCHIVES;
    const toDrop = archiveHeadings.slice(0, dropCount);
    // Compute the byte spans to drop: each archived H3 spans from its offset to
    // the next H3 (or to sectionEnd). Drop with one preceding blank line so we
    // don't leave a dangling separator.
    let mutated = content;
    // Process from the bottom up so offsets don't shift mid-edit.
    for (let i = toDrop.length - 1; i >= 0; i--) {
        const h = toDrop[i];
        let spanEnd = sectionEnd;
        // Find next H3 at-or-after h.offset (within the section).
        for (const candidate of hs) {
            if (candidate.level === 3 && candidate.offset > h.offset && candidate.offset < sectionEnd) {
                spanEnd = candidate.offset;
                break;
            }
        }
        const dropStart = h.offset;
        const before = mutated.slice(0, dropStart);
        const after = mutated.slice(spanEnd);
        const droppedText = mutated.slice(dropStart, spanEnd);
        mutated = before + after;
        log.push({
            timestamp,
            kind: 'session-archive-deduplicated',
            section: exports.STATE_MD_SECTIONS.sessionContinuity,
            before: truncateForLog(droppedText),
            after: '',
            reason: `archived session ${JSON.stringify(h.text)} exceeded the ${DEFAULT_MAX_SESSION_ARCHIVES}-most-recent retention; dropped`,
        });
    }
    return mutated;
}
/**
 * §3 — append a structured audit entry to `## Rebuild Log`. Per ADR-1817 §3
 * the section is created if absent; existing entries are preserved verbatim
 * (append-only).
 *
 * Format (yaml-ish, human-readable, machine-parseable):
 *
 *   ## Rebuild Log
 *
 *   - timestamp: 2026-06-29T19:30:00Z
 *     kind: placeholder-removed
 *     section: ## Current Position
 *     before: ...
 *     after: ...
 *     reason: ...
 */
function appendRebuildLogSection(content, entries) {
    const lines = content.split('\n');
    // Render the new entry block.
    const rendered = [];
    for (const e of entries) {
        rendered.push(`- timestamp: ${e.timestamp}`);
        rendered.push(`  kind: ${e.kind}`);
        rendered.push(`  section: ${e.section}`);
        rendered.push(`  before: ${e.before.replace(/\n/g, ' \\n ')}`);
        rendered.push(`  after: ${e.after.replace(/\n/g, ' \\n ')}`);
        rendered.push(`  reason: ${e.reason.replace(/\n/g, ' \\n ')}`);
    }
    // Locate an existing `## Rebuild Log` section.
    const sectionHeaderIdx = lines.findIndex((l) => l.trim() === REBUILD_LOG_SECTION);
    if (sectionHeaderIdx === -1) {
        // Create the section at end-of-file, separated by a blank line.
        const needsLeadingBlank = lines.length > 0 && lines[lines.length - 1].trim() !== '';
        const trailer = needsLeadingBlank ? ['', REBUILD_LOG_SECTION, '', ...rendered] : [REBUILD_LOG_SECTION, '', ...rendered];
        return [...lines, ...trailer].join('\n');
    }
    // Append to the existing section. Find the end of the existing log entries
    // (walk forward until the next H2 or EOF). Insert before that boundary.
    let insertAt = sectionHeaderIdx + 1;
    while (insertAt < lines.length) {
        const l = lines[insertAt];
        if (/^##\s/.test(l))
            break;
        insertAt++;
    }
    // Preserve a blank-line separator before the new entries if the prior line
    // is non-blank and non-header.
    const sep = [];
    if (insertAt > 0 && lines[insertAt - 1].trim() !== '' && lines[insertAt - 1].trim() !== REBUILD_LOG_SECTION) {
        sep.push('');
    }
    const next = [...lines.slice(0, insertAt), ...sep, ...rendered, ...lines.slice(insertAt)];
    return next.join('\n');
}
