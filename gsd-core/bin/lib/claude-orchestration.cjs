"use strict";
/**
 * Claude Orchestration Capability — Workflow-tool backend detection + emitter
 *
 * #1143 — adopts Claude Code's Workflow tool (the engine behind `/effort ultracode`)
 * as an optional, runtime-gated parallel-execution backend for the GSD loop.
 *
 * This module is the pure, testable core of the capability. It owns two seams:
 *
 *   detectWorkflowBackend({ runtimeId, hostIntegration, config, agentSdkVersion })
 *     → { available: boolean, backend: 'workflow'|'inline', reason: string }
 *     Fail-closed: every miss degrades to `inline` (today's behaviour), so the
 *     core loop is byte-identical unless every gate opens. This is criteria 3 + 6.
 *
 *   emitWorkflowScript({ phaseDir, waves, runId, budgetTokens? })
 *     → { ok:true, script, summary } | { ok:false, reason }
 *     Maps GSD's wave/plan model 1:1 onto Workflow primitives:
 *       wave  → sequential `parallel()` stage barriers,
 *       plan  → `agent(brief, { agentType:'gsd-executor', isolation:'worktree' })`
 *         — UNLESS the plan's `use_worktree` is explicitly `false`, in which case
 *         `isolation` is omitted entirely for that plan (#2772 / #2285 finding 1:
 *         a submodule-touching plan must never be forced into worktree isolation
 *         the inline path (execute-phase.md step 2.5) would keep it out of),
 *       files_modified overlap → forces plans into separate sequential stages
 *         (the same overlap rule execute-phase already applies inline),
 *       resumeFromRunId → wired to the phase run id,
 *       budgetTokens → a shared token pool.
 *     The emitted script composes the SAME gsd-executor agent the inline path
 *     uses, with per-plan worktree isolation mirroring the inline path's own
 *     per-plan decision, so it produces the same artifacts/commits (criterion 2).
 *     It is a generated string consumed by the orchestrator; this module never
 *     invokes the Workflow tool itself.
 *
 * Design laws:
 *   - Gall's Law: ship a small working slice that composes existing primitives
 *     (gsd-executor + worktree isolation) rather than reinventing them.
 *   - Greenspun's Tenth Rule (cited in #1143): adopt the Workflow tool's
 *     barrier/pipeline/budget/resume semantics instead of hand-rolling them.
 *   - Postel's Law: liberal in input (missing fields → inline), conservative in
 *     output (workflow only when every gate opens).
 *   - Fail-closed: an unknown version, a missing descriptor, or a disabled
 *     toggle all resolve to `inline`, never to `workflow`.
 *
 * Zero external dependencies. Pure functions. Never throws on bad input.
 */
// ─── Constants ────────────────────────────────────────────────────────────────
/**
 * The Agent SDK version that introduced the Workflow tool (#1143 prior art).
 * Used as the default floor when config does not override it. A runtime reporting
 * an agentSdkVersion below this cannot host the Workflow backend.
 */
const WORKFLOW_TOOL_FLOOR_VERSION = '0.3.149';
/** Closed enum for the `claude_orchestration.execution_backend` config key. */
const BACKEND_VALUES = new Set(['auto', 'workflow', 'inline']);
/** Only this runtime can host the Workflow tool (Claude Code / Agent SDK). */
const WORKFLOW_RUNTIME = 'claude';
// ─── Semver helpers ───────────────────────────────────────────────────────────
/** Official-ish strict SemVer 2.0.0 numeric triple (+ optional pre/build). */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** True for a syntactically valid semver string. */
function isValidSemver(s) {
    return typeof s === 'string' && SEMVER_RE.test(s);
}
/**
 * Compare two semver strings.
 * Returns -1/0/1 in the usual sense. Garbage in either position → -1 (fail-closed:
 * an unparseable version is treated as "less than" any real floor, so detection
 * never accidentally enables the preview backend on an unknown SDK).
 *
 * Pre-release/build metadata are ignored for the comparison — only the numeric
 * major.minor.patch triple participates, matching how the Workflow-tool floor is
 * specified (a plain "0.3.149").
 */
function compareSemver(a, b) {
    if (!isValidSemver(a) || !isValidSemver(b))
        return -1;
    // Split numeric triple from pre-release/build metadata.
    const parseTriple = (s) => {
        const core = s.split('-')[0].split('+')[0].split('.');
        return [parseInt(core[0], 10), parseInt(core[1], 10), parseInt(core[2], 10)];
    };
    const hasPre = (s) => s.indexOf('-') !== -1;
    const preIdentifiers = (s) => (s.split('-')[1] || '').split('+')[0].split('.').filter((x) => x.length > 0);
    const am = parseTriple(a);
    const bm = parseTriple(b);
    for (let i = 0; i < 3; i++) {
        if (am[i] < bm[i])
            return -1;
        if (am[i] > bm[i])
            return 1;
    }
    // Numeric triple is equal. SemVer 2.0.0 §11 precedence:
    //   - a version WITH a pre-release tag is LOWER than the same triple WITHOUT one
    //     (keeps the floor fail-closed for pre-release builds of the GA floor);
    //   - two pre-releases of the same triple are ordered by their dot-separated
    //     identifiers (numeric < alphanumeric; numeric compared numerically,
    //     alphanumeric lexically; fewer identifiers < more).
    const aPre = hasPre(a);
    const bPre = hasPre(b);
    if (aPre && !bPre)
        return -1;
    if (!aPre && bPre)
        return 1;
    if (aPre && bPre) {
        const ai = preIdentifiers(a);
        const bi = preIdentifiers(b);
        const len = Math.min(ai.length, bi.length);
        for (let i = 0; i < len; i++) {
            const ax = ai[i];
            const bx = bi[i];
            const aNum = /^\d+$/.test(ax);
            const bNum = /^\d+$/.test(bx);
            if (aNum && bNum) {
                const an = parseInt(ax, 10);
                const bn = parseInt(bx, 10);
                if (an < bn)
                    return -1;
                if (an > bn)
                    return 1;
            }
            else if (aNum && !bNum) {
                return -1; // numeric identifiers always lower than alphanumeric
            }
            else if (!aNum && bNum) {
                return 1;
            }
            else {
                if (ax < bx)
                    return -1;
                if (ax > bx)
                    return 1;
            }
        }
        if (ai.length < bi.length)
            return -1;
        if (ai.length > bi.length)
            return 1;
    }
    return 0;
}
/** Inline result shorthand. */
function inline(reason, available = false) {
    return { available, backend: 'inline', reason };
}
/**
 * Resolve whether the Workflow-tool backend should activate.
 *
 * Gate ladder (all must pass for `workflow`; first miss wins, fail-closed):
 *   1. capability enabled (claude_orchestration.enabled truthy)
 *   2. runtime is Claude (the only runtime that exposes the Workflow tool)
 *   3. execution_backend !== 'inline'
 *   4. host descriptor signals nested+background dispatch (Workflow-tool capable)
 *   5. agentSdkVersion is a known, valid semver
 *   6. agentSdkVersion >= the configured floor (default WORKFLOW_TOOL_FLOOR_VERSION)
 *   7. execution_backend === 'workflow' OR 'auto' (both reach here; 'inline' exited at 3)
 *
 * Never throws. Destructures defensively.
 */
function detectWorkflowBackend(input) {
    if (input === null || input === undefined || typeof input !== 'object') {
        return inline('capability_disabled');
    }
    const cfg = (input.config !== null && input.config !== undefined && typeof input.config === 'object')
        ? input.config
        : {};
    // 1. capability must be opted in (default-off — ships disabled).
    if (!cfg['claude_orchestration.enabled']) {
        return inline('capability_disabled');
    }
    // 2. only Claude can host the Workflow tool.
    if (input.runtimeId !== WORKFLOW_RUNTIME) {
        return inline('runtime_not_claude');
    }
    // 3. explicit inline opt-out short-circuits.
    let backendRaw = cfg['claude_orchestration.execution_backend'];
    if (typeof backendRaw !== 'string' || !BACKEND_VALUES.has(backendRaw)) {
        backendRaw = 'auto';
    }
    if (backendRaw === 'inline') {
        return inline('backend_inline');
    }
    // 4. the host dispatch descriptor must be the nesting-capable Claude-Code shape
    //    (a proxy for Workflow-tool presence). This is Claude-specific and already
    //    gated at step 2; `background:true` alone is true on several non-Claude hosts,
    //    so the proxy is only meaningful after the runtime check above. Note: this is
    //    NOT the canonical `shouldFlattenDispatch` rule (which keys on
    //    `backgroundDispatch`); the Workflow backend works precisely because a single
    //    tool-call orchestrates internally, sidestepping the backgroundDispatch:false
    //    limitation. Missing/false/foreign descriptor → fail-closed.
    const hi = input.hostIntegration;
    if (hi === null || hi === undefined || typeof hi !== 'object' || Array.isArray(hi)) {
        return inline('workflow_tool_unavailable');
    }
    const dispatch = hi.dispatch;
    if (typeof dispatch !== 'object' || dispatch === null || Array.isArray(dispatch)) {
        return inline('workflow_tool_unavailable');
    }
    const nested = dispatch['nested'];
    const background = dispatch['background'];
    if (nested !== true || background !== true) {
        return inline('workflow_tool_unavailable');
    }
    // 5. an unknown agentSdkVersion cannot be trusted to meet the floor.
    if (!isValidSemver(input.agentSdkVersion)) {
        return inline('agent_sdk_version_unknown');
    }
    // 6. version floor (config override > default constant).
    const floorRaw = cfg['claude_orchestration.min_agent_sdk_version'];
    const floor = typeof floorRaw === 'string' && isValidSemver(floorRaw) ? floorRaw : WORKFLOW_TOOL_FLOOR_VERSION;
    if (compareSemver(input.agentSdkVersion, floor) < 0) {
        return inline('agent_sdk_version_below_floor');
    }
    // 7. auto/workflow both reach the workflow backend once every gate passes.
    return { available: true, backend: 'workflow', reason: 'workflow_backend_active' };
}
/**
 * Partition a wave's plans into a near-minimal number of sequential stages (via
 * greedy first-fit — not guaranteed optimal for arbitrary overlap graphs, but
 * correct: no two plans sharing a file ever cohabit a stage) such that no two
 * plans in the same stage share a modified file. Each plan goes into the earliest
 * stage where it does not overlap any plan already there.
 *
 * A plan with an EMPTY files_modified set declares no files; it overlaps nothing
 * and coalesces into stage 0 (same behavior as the inline path, which also cannot
 * guard against undeclared concurrent writes — declare filesModified accurately).
 *
 * This is the same overlap rule execute-phase applies inline — the only difference
 * is the execution vehicle (Workflow `parallel()` vs one-agent-per-message).
 */
function partitionStages(plans) {
    const stages = [];
    for (const plan of plans) {
        const fileSet = new Set(plan.files_modified);
        let placed = false;
        for (const stage of stages) {
            let overlap = false;
            for (const f of fileSet) {
                if (stage.files.has(f)) {
                    overlap = true;
                    break;
                }
            }
            if (!overlap) {
                stage.plans.push(plan);
                for (const f of fileSet)
                    stage.files.add(f);
                placed = true;
                break;
            }
        }
        if (!placed) {
            stages.push({ plans: [plan], files: new Set(fileSet) });
        }
    }
    return stages.map((s) => s.plans.map((p) => p.id));
}
/**
 * Quote a free-text value for safe embedding as a JavaScript/Workflow double-quoted
 * string literal. Uses JSON.stringify so every JS-relevant escape (backslash, quote,
 * newline, tab, NUL, U+2028/U+2029, all control chars) is handled by the language
 * itself — there is no hand-rolled escape table to drift. Returns the value already
 * wrapped in its surrounding quotes.
 */
function quoteString(s) {
    return JSON.stringify(s);
}
/**
 * #2686 — the single decision of whether a resolved executor model is emittable,
 * and what to emit. Shared by `agentOptions` (the emission) and the provenance
 * comment (the claim about it) so the two can never disagree — a generated
 * comment asserting something the generator does not actually do is the exact
 * failure #2686 was filed for.
 *
 * Returns the model to emit, or `undefined` for "emit nothing":
 *   - non-string        → malformed config; omit rather than throw, matching the
 *                         defensive typeof guard `mapClaudeOverrideForRuntime`
 *                         already carries in model-resolver for the same reason.
 *   - empty/whitespace  → #2517: emitting `model: ""` 404s on runtimes without
 *                         native tier aliases. Trimmed, so `" "` is also "none".
 *   - "inherit"         → same rule; matched case-insensitively after trimming,
 *                         since config is user-authored free text.
 *
 * NOTE it does NOT reject unscriptable characters — that is a hard input error,
 * not a silent omission, and is rejected up front by `emitWorkflowScript` so the
 * caller sees a reason instead of quietly losing their model routing.
 */
function emittableModel(executorModel) {
    if (typeof executorModel !== 'string')
        return undefined;
    const trimmed = executorModel.trim();
    if (trimmed.length === 0)
        return undefined;
    if (trimmed.toLowerCase() === 'inherit')
        return undefined;
    return trimmed;
}
/**
 * Render the `agent()` options object for a single plan — `isolation: "worktree"`
 * ONLY when the plan's `use_worktree` is not explicitly `false` (#2772 / #2285
 * finding 1). This is the single place that decides worktree isolation for the
 * Workflow backend; it must never diverge from the inline path's per-plan gate.
 */
function agentOptions(p, executorModel) {
    const parts = ['agentType: "gsd-executor"'];
    if (p.use_worktree !== false)
        parts.push('isolation: "worktree"');
    // #2686: carry the resolved executor model so this backend honors
    // model_overrides / model_policy / model_profile exactly as the inline path.
    const model = emittableModel(executorModel);
    if (model !== undefined)
        parts.push('model: ' + quoteString(model));
    return '{ ' + parts.join(', ') + ' }';
}
/**
 * True if `s` is a safe identifier/path token to interpolate into the generated
 * script WITHOUT requiring a string-literal context — i.e. it contains no
 * character that could terminate a comment line (`\n`/`\r`), break out of a
 * string literal (`"` / `\`), or smuggle a NUL/control sequence. Used for
 * `phaseDir`, `runId`, `wave.id`, and `plan.id`, which are identifiers/paths and
 * must never legitimately contain such characters. Rejecting them at validation
 * (rather than silently flattening) keeps the emitted script faithful to input.
 */
const UNSCRIPTABLE_CHAR_RE = /[\r\n"\\\x00-\x1f\x7f\u2028\u2029]/;
function isScriptableIdentifier(s) {
    if (typeof s !== 'string' || s.length === 0)
        return false;
    return !UNSCRIPTABLE_CHAR_RE.test(s);
}
/**
 * Emit a Workflow script mapping the phase's wave/plan model onto Workflow
 * primitives. Pure and deterministic: identical input yields an identical string.
 *
 * Returns ok:false (never throws) on invalid input — empty waves, missing runId,
 * a wave with no plans, etc.
 */
function emitWorkflowScript(input) {
    if (input === null || input === undefined || typeof input !== 'object') {
        return { ok: false, reason: 'invalid_input' };
    }
    const { phaseDir, waves, runId, executorModel } = input;
    // Identifiers/paths interpolated into the generated script must be free of any
    // character that could terminate a comment, break out of a string literal, or
    // smuggle control bytes — reject up front (security: #1143 review Finding 1).
    if (!isScriptableIdentifier(phaseDir)) {
        return { ok: false, reason: 'phaseDir must be a non-empty string without newlines/quotes/backslash/control chars' };
    }
    if (!isScriptableIdentifier(runId)) {
        return { ok: false, reason: 'runId must be a non-empty string without newlines/quotes/backslash/control chars' };
    }
    // #2686 security: the resolved model is interpolated into BOTH an object
    // literal (safe under quoteString) and a `//` provenance comment (NOT safe
    // under quoteString — U+2028/U+2029 are LineTerminators that end a single-line
    // comment in every engine, so a hostile model id would make the rest of the
    // line live code). Reject the whole emission rather than silently dropping the
    // model: an unscriptable id is malformed input, and `resolveWaveDispatch` maps
    // an emit failure to the inline backend WITH a reason, so the user sees it.
    // Only a STRING carrying such a character is rejected. A non-string is a
    // malformed config rather than an injection attempt, and stays on the existing
    // defensive path: `emittableModel` omits it and emission proceeds.
    if (typeof executorModel === 'string' && UNSCRIPTABLE_CHAR_RE.test(executorModel)) {
        return { ok: false, reason: 'executorModel must not contain newlines/quotes/backslash/control/line-separator chars' };
    }
    if (!Array.isArray(waves) || waves.length === 0) {
        return { ok: false, reason: 'waves must be a non-empty array' };
    }
    // Wave ids must be unique ACROSS waves, not just plan ids within one (#2590).
    // Each wave emits a `phase("Wave <id>")` call plus a matching meta.phases
    // entry, and the Workflow tool matches phase titles by exact string — two
    // waves sharing an id would collapse into one progress group and misattribute
    // every agent in the second wave to the first.
    const seenWaveIds = new Set();
    for (let i = 0; i < waves.length; i++) {
        const w = waves[i];
        if (w === null || typeof w !== 'object' || typeof w.id !== 'string') {
            return { ok: false, reason: 'waves[' + i + '] must be { id, plans: non-empty[] }' };
        }
        if (!isScriptableIdentifier(w.id)) {
            return { ok: false, reason: 'waves[' + i + '].id must not contain newlines/quotes/backslash/control chars' };
        }
        if (seenWaveIds.has(w.id)) {
            return { ok: false, reason: 'duplicate wave id "' + w.id + '" — wave ids must be unique (phase titles must map 1:1)' };
        }
        seenWaveIds.add(w.id);
        if (!Array.isArray(w.plans) || w.plans.length === 0) {
            return { ok: false, reason: 'waves[' + i + '] must have a non-empty plans array' };
        }
        const seenIds = new Set();
        for (let j = 0; j < w.plans.length; j++) {
            const p = w.plans[j];
            if (p === null || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.brief !== 'string' || !Array.isArray(p.files_modified)) {
                return { ok: false, reason: 'waves[' + i + '].plans[' + j + '] must be { id, brief, files_modified[] }' };
            }
            if (!isScriptableIdentifier(p.id)) {
                return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].id must not contain newlines/quotes/backslash/control chars' };
            }
            if (p.use_worktree !== undefined && typeof p.use_worktree !== 'boolean') {
                return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].use_worktree must be a boolean if present' };
            }
            if (seenIds.has(p.id)) {
                return { ok: false, reason: 'waves[' + i + '] has duplicate plan id "' + p.id + '"' };
            }
            seenIds.add(p.id);
            for (const f of p.files_modified) {
                if (typeof f !== 'string' || f.length === 0) {
                    return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].files_modified entries must be non-empty strings' };
                }
            }
        }
    }
    const budgetTokens = (typeof input.budgetTokens === 'number' && Number.isFinite(input.budgetTokens) && input.budgetTokens > 0)
        ? Math.floor(input.budgetTokens)
        : null;
    const lines = [];
    // `export const meta = {…}` MUST be the first statement in the script — the
    // Workflow tool rejects the whole script otherwise (#2590). Leading comments
    // are not statements, but the meta block is emitted first regardless so the
    // contract holds under the strictest reading of "first statement".
    //
    // meta.phases must be a PURE LITERAL (no variables, calls, spreads, or
    // template interpolation), and its titles are matched EXACTLY against the
    // phase() calls emitted below.
    lines.push('export const meta = {');
    lines.push('  name: ' + quoteString('gsd-execute-' + runId) + ',');
    lines.push('  description: ' + quoteString('GSD wave dispatch for ' + phaseDir) + ',');
    lines.push('  phases: [');
    for (const w of waves) {
        lines.push('    { title: ' + quoteString('Wave ' + w.id) + ', detail: '
            + quoteString(w.plans.length + ' plan(s)') + ' },');
    }
    lines.push('  ],');
    lines.push('}');
    lines.push('');
    lines.push('// GSD Workflow script — generated by the claude-orchestration capability (#1143)');
    lines.push('// phase: ' + phaseDir);
    lines.push('// BETA: preview-grade; on any failure the orchestrator falls back to inline dispatch.');
    lines.push('// Composes the SAME gsd-executor agent as the inline path, so artifacts (SUMMARY.md)');
    lines.push('// and commits are produced identically. Worktree isolation is per-plan (use_worktree)');
    lines.push('// and mirrors execute-phase.md step 2.5\'s submodule gate exactly (#2772 / #2285).');
    // #2686 / ADR-1411: state which model was applied — or that none resolved —
    // so an opted-in user can SEE the routing decision instead of having to read
    // the emitted options. A fallback must be a visible value, never silent.
    //
    // SECURITY: this is a `//` comment, and U+2028/U+2029 are ECMAScript
    // LineTerminators that END a single-line comment in every engine — the ES2019
    // change legalized them inside string LITERALS only, so `quoteString` alone is
    // NOT sufficient here even though it is sufficient in the object literal
    // above. An unscriptable model id would otherwise close the comment and make
    // the remainder live top-level code. `emitWorkflowScript` rejects such ids
    // before reaching this point (see the validation above), which is what makes
    // interpolating here safe.
    const provenanceModel = emittableModel(executorModel);
    if (provenanceModel !== undefined) {
        lines.push('// model: ' + quoteString(provenanceModel) + ' (resolved for gsd-executor, same source as the inline path)');
    }
    else {
        lines.push('// model: none applied — resolved to "inherit"/empty, so each agent inherits the');
        lines.push('// orchestrator model (#2517: emitting an empty model 404s on some runtimes).');
    }
    lines.push('//');
    // resumeFromRunId is a Workflow TOOL INPUT parameter, not a script function —
    // calling it threw "resumeFromRunId is not defined" (#2590). The run id is
    // carried in summary.resumeRunId for the caller to pass as that input.
    lines.push('// resume: pass ' + quoteString(runId) + ' as the Workflow tool\'s resumeFromRunId input');
    lines.push('// (it is a tool parameter, NOT a script function).');
    if (budgetTokens !== null) {
        // `budget` is a read-only object ({ total, spent(), remaining() }) supplied
        // by the caller's token directive — a script cannot SET it, and `budget(n)`
        // threw "budget is not a function" (#2590). Recorded as intent only.
        lines.push('// budget: ' + budgetTokens + ' output tokens intended for this run; `budget` is');
        lines.push('// read-only in a Workflow script — set it via the caller\'s token directive.');
    }
    lines.push('');
    const stagesByWave = [];
    let totalPlans = 0;
    for (let wi = 0; wi < waves.length; wi++) {
        const wave = waves[wi];
        const stages = partitionStages(wave.plans);
        stagesByWave.push(stages);
        totalPlans += wave.plans.length;
        lines.push('// Wave ' + wave.id);
        // Title must match this wave's meta.phases entry EXACTLY.
        lines.push('phase(' + quoteString('Wave ' + wave.id) + ')');
        for (let si = 0; si < stages.length; si++) {
            const stagePlanIds = stages[si];
            // Resolve back to plan objects for briefs (ids are unique within a wave — validated above).
            const stagePlans = stagePlanIds.map((id) => wave.plans.find((p) => p.id === id));
            if (stages.length > 1) {
                lines.push('// Stage ' + si + (si > 0 ? ' (sequential — files_modified overlap)' : ''));
            }
            // parallel() takes an ARRAY OF THUNKS — `parallel(agent(…), agent(…))`
            // threw "parallel() expects an array of functions" (#2590). Passing
            // agent() results directly would also start every agent eagerly, before
            // parallel() could bound concurrency.
            lines.push('await parallel([');
            for (const p of stagePlans) {
                lines.push('  () => agent(' + quoteString(p.brief) + ', ' + agentOptions(p, executorModel) + '),');
            }
            lines.push('])');
        }
        if (wi < waves.length - 1)
            lines.push('');
    }
    lines.push('// Each agent writes SUMMARY.md on its worktree branch; commits land there');
    lines.push('// and are merged by the orchestrator exactly as in inline wave dispatch.');
    const script = lines.join('\n');
    return {
        ok: true,
        script,
        summary: {
            waves: waves.length,
            plans: totalPlans,
            stagesByWave,
            resumeRunId: runId,
            budgetTokens,
        },
    };
}
/**
 * #2285 — single composed decision seam for a PRE-wave dispatch-backend selector
 * (e.g. the `execute:wave:pre` claude-orchestration contribution). Composes
 * `detectWorkflowBackend` (gate ladder) with `emitWorkflowScript` (wave→plan
 * mapping) into ONE call so the orchestrator (and its CLI wrapper,
 * `claude-orchestration resolve-wave-dispatch`) never has to re-implement the
 * two-step "detect, then maybe emit" sequencing.
 *
 * Fail-closed at every layer, matching the two composed functions:
 *   - `detectWorkflowBackend` resolving anything other than `'workflow'` →
 *     `inline` immediately; `emitWorkflowScript` is never invoked (no wasted
 *     work, no risk of a bad emit masking a correct inline fallback).
 *   - `detectWorkflowBackend` resolves `'workflow'` but `emitWorkflowScript`
 *     fails (`ok:false` — e.g. a malformed wave manifest) → `inline`, carrying
 *     the emit failure reason so the caller can surface it. Never a partial or
 *     broken script.
 *
 * This is the designated non-CLI-router, non-test caller of
 * `detectWorkflowBackend` and `emitWorkflowScript` — the standalone CLI
 * subcommands (`detect-backend`, `emit-workflow`) remain for inspection/
 * debugging, but the orchestrator's real per-wave dispatch decision goes
 * through this seam.
 *
 * Never throws on bad input.
 */
function resolveWaveDispatch(input) {
    if (input === null || input === undefined || typeof input !== 'object') {
        return { backend: 'inline', reason: 'invalid_input' };
    }
    const detected = detectWorkflowBackend({
        runtimeId: input.runtimeId,
        hostIntegration: input.hostIntegration,
        config: input.config,
        agentSdkVersion: input.agentSdkVersion,
    });
    if (detected.backend !== 'workflow') {
        return { backend: 'inline', reason: detected.reason };
    }
    const emitted = emitWorkflowScript({
        phaseDir: input.phaseDir,
        waves: input.waves,
        runId: input.runId,
        budgetTokens: input.budgetTokens,
        executorModel: input.executorModel,
    });
    if (!emitted.ok) {
        return { backend: 'inline', reason: 'emit_failed: ' + emitted.reason };
    }
    return {
        backend: 'workflow',
        reason: detected.reason,
        script: emitted.script,
        summary: emitted.summary,
    };
}
module.exports = {
    detectWorkflowBackend,
    emitWorkflowScript,
    resolveWaveDispatch,
    compareSemver,
    isValidSemver,
    WORKFLOW_TOOL_FLOOR_VERSION,
    BACKEND_VALUES,
    WORKFLOW_RUNTIME,
};
