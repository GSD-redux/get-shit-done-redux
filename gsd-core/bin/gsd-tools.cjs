#!/usr/bin/env node

/**
 * GSD Tools — CLI utility for GSD workflow operations.
 *
 * Replaces repetitive inline bash patterns across ~50 GSD command/workflow/agent files.
 * Centralizes: config parsing, model resolution, phase lookup, git commits, summary verification.
 *
 * Usage: node gsd-tools.cjs <command> [args] [--raw] [--pick <field>]
 *
 * Atomic Commands:
 *   state load                         Load project config + state
 *   state json                         Output STATE.md frontmatter as JSON
 *   state update <field> <value>       Update a STATE.md field
 *   state get [section]                Get STATE.md content or section
 *   state patch --field val ...        Batch update STATE.md fields
 *   state begin-phase --phase N --name S --plans C  Update STATE.md for new phase start
 *   state signal-waiting --type T --question Q --options "A|B" --phase P  Write WAITING.json signal
 *   state signal-resume                Remove WAITING.json signal
 *   resolve-model <agent-type>         Get model for agent based on profile
 *   find-phase <phase>                 Find phase directory by number
 *   commit <message> [--files f1 f2] [--no-verify]   Commit planning docs
 *   commit-docs-guard enable|disable   Opt-in .git/hooks/pre-commit guard
 *                                       that refuses a commit staging
 *                                       .planning/ when commit_docs is false
 *   commit-to-subrepo <msg> --files f1 f2  Route commits to sub-repos
 *   verify-summary <path>              Verify a SUMMARY.md file
 *   generate-slug <text>               Convert text to URL-safe slug
 *   current-timestamp [format]         Get timestamp (full|date|filename)
 *   list-todos [area]                  Count and enumerate pending todos
 *   list-seeds [status]                List captured seeds (optional status filter)
 *   verify-path-exists <path>          Check file/directory existence
 *   quick-tasks-append --task <text>   Append a row to STATE.md's "Quick Tasks
 *                                      Completed" table (schema-backed via
 *                                      markdown-table.cjs; #2133/ADR-2143).
 *                                      Fails loud (non-zero exit) on a missing
 *                                      or unrecognized table instead of the old
 *                                      awk NF-2 silent-skip guess.
 *   config-ensure-section              Initialize .planning/config.json
 *   history-digest                     Aggregate all SUMMARY.md data
 *   summary-extract <path> [--fields]  Extract structured data from SUMMARY.md
 *   state-snapshot                     Structured parse of STATE.md
 *   phase-plan-index <phase>           Index plans with waves and status
 *   websearch <query>                  Search web via Brave API (if configured)
 *     [--limit N] [--freshness day|week|month]
 *
 * Phase Operations:
 *   phase next-decimal <phase>         Calculate next decimal phase number
 *   phase add <description> [--id ID]   Append new phase to roadmap + create dir
 *   phase insert <after> <description> Insert decimal phase after existing
 *   phase remove <phase> [--force]     Remove phase, renumber all subsequent
 *   phase complete <phase>             Mark phase done, update state + roadmap
 *
 * Roadmap Operations:
 *   roadmap get-phase <phase>          Extract phase section from ROADMAP.md
 *   roadmap analyze                    Full roadmap parse with disk status
 *   roadmap update-plan-progress <N>   Update progress table row from disk (PLAN vs SUMMARY counts)
 *   roadmap annotate-dependencies <N>  Add wave dependency notes + cross-cutting constraints to ROADMAP.md
 *   roadmap validate                   Validate phase ID convention compliance
 *   roadmap upgrade [--apply] --convention milestone-prefixed  Migrate phase IDs to M-NN convention
 *
 * Requirements Operations:
 *   requirements mark-complete <ids>   Mark requirement IDs as complete in REQUIREMENTS.md
 *                                      Accepts: REQ-01,REQ-02 or REQ-01 REQ-02 or [REQ-01, REQ-02]
 *   requirements ready-ids <plan-path> <ids>  Read-only: which of <ids> are safe to mark-complete now
 *                                      (no sibling *-PLAN.md in the same phase dir still missing its SUMMARY for that ID)
 *   requirements revert-phase <ids>   Revert requirement IDs out of Complete (checkbox + traceability row);
 *                                      gaps_found-only, never call on the pass path
 *
 * Milestone Operations:
 *   milestone complete <version> (--confirm | --dry-run)
 *                                      Archive milestone, create MILESTONES.md — one of the two is required
 *     --confirm                      REQUIRED to mutate (#3726): the archive is irreversible (ROADMAP/
 *                                    REQUIREMENTS archived, phase dirs MOVED, STATE.md rewritten), so
 *                                    without this flag the command refuses and mutates nothing
 *     --dry-run                      Preview what would move, mutates nothing (no --confirm needed; #2118)
 *     [--name <name>]
 *     [--no-archive-phases]          Skip moving phase dirs to milestones/vX.Y-phases/ (archived by default)
 *     [--archive-quick]              Move .planning/quick/* dirs to milestones/vX.Y-quick/ + reset the
 *                                    Quick Tasks Completed table (#2142; opt-in, default OFF)
 *
 *   milestone archive-quick <version>  Move .planning/quick/* dirs to milestones/vX.Y-quick/ + reset the
 *                                      Quick Tasks Completed table, WITHOUT the milestone complete close-out
 *                                      (no ROADMAP/REQUIREMENTS/MILESTONES.md writes, no completion guards);
 *                                      safe against an already-completed milestone (#2142 escalation)
 *     [--dry-run]                     Preview what would move, mutates nothing
 *
 * User Story Validation:
 *   user-story validate --story "..."  Validate "As a / I want to / so that" format
 *                                      Returns JSON { valid, errors[], slots: {role,capability,outcome} | null }
 *                                      --pick valid  Emit bare boolean (for workflow boolean checks)
 *
 * Drift Guard (ADR-22):
 *   drift-guard authority                Resolve effective source-grounding authority
 *                                        (reads plan_review.source_grounding_authority + intel.enabled from config)
 *   drift-guard severity --status <S>    Classify a symbol verdict into { severity, hardBlock }
 *     [--authority <A>]                  Status: VERIFIED|MISSING|AMBIGUOUS|UNCHECKABLE
 *                                        Authority: grep|intel|treesitter|lsp|scip (default: config-resolved)
 *   drift-guard phase-status [--phase N]     Compare STATE.md vs ROADMAP.md phase status
 *
 * Validation:
 *   validate consistency               Check phase numbering, disk/roadmap sync
 *   validate health [--repair]         Check .planning/ integrity, optionally repair
 *   validate agents                    Check GSD agent installation status
 *
 * Planning Snapshot:
 *   planning inspect                   Read-only schema-v1 canonical planning snapshot
 *                                      (milestone identity, active phase, per-phase
 *                                      verification/roadmap-acceptance/UAT evidence kept
 *                                      separate, requirement rows with mapped-phase
 *                                      traceability, plan/task rows with planned+changed
 *                                      file provenance, and independent accepted_phases /
 *                                      completed_plans fractions). Takes no arguments.
 *
 * Progress:
 *   progress [json|table|bar]          Render progress in various formats
 *
 * Todos:
 *   todo complete <filename>           Move todo from pending to completed
 *
 * UAT Audit:
 *   audit-uat                           Scan all phases for unresolved UAT/verification items
 *   uat render-checkpoint --file <path> Render the current UAT checkpoint block
 *   uat classify-coverage --summary <path> Classify a SUMMARY coverage block into auto-passed vs human-UAT (#1602)
 *
 * Open Artifact Audit:
 *   audit-open [--json]                 Scan all .planning/ artifact types for unresolved items
 *
 * Intel:
 *   intel query <term>             Query intel files for a term
 *   intel status                   Show intel file freshness
 *   intel update                   Trigger intel refresh (returns agent spawn hint)
 *   intel diff                     Show changed intel entries since last snapshot
 *   intel snapshot                 Save current intel state as diff baseline
 *   intel patch-meta <file>        Update _meta.updated_at in an intel file
 *   intel validate                 Validate intel file structure
 *   intel extract-exports <file>   Extract exported symbols from a source file
 *   intel api-surface               Render api-map.json into API-SURFACE.md
 *
 * Scaffolding:
 *   scaffold context --phase <N>       Create CONTEXT.md template
 *   scaffold uat --phase <N>           Create UAT.md template
 *   scaffold verification --phase <N>  Create VERIFICATION.md template
 *   scaffold phase-dir --phase <N>     Create phase directory
 *     --name <name>
 *
 * Frontmatter CRUD:
 *   frontmatter get <file> [--field k] Extract frontmatter as JSON
 *   frontmatter set <file> --field k   Update single frontmatter field
 *     --value jsonVal
 *   frontmatter merge <file>           Merge JSON into frontmatter
 *     --data '{json}'
 *   frontmatter validate <file>        Validate required fields
 *     --schema plan|summary|verification
 *
 * Verification Suite:
 *   verify plan-structure <file>       Check PLAN.md structure + tasks
 *   verify phase-completeness <phase>  Check all plans have summaries
 *   verify references <file>           Check @-refs + paths resolve
 *   verify commits <h1> [h2] ...      Batch verify commit hashes
 *   verify artifacts <plan-file>       Check must_haves.artifacts
 *   verify key-links <plan-file>       Check must_haves.key_links
 *   verify schema-drift <phase> [--skip]  Detect schema file changes without push
 *   verify codebase-drift                Detect structural drift since last codebase map (#2003)
 *
 * Template Fill:
 *   template fill summary --phase N    Create pre-filled SUMMARY.md
 *     [--plan M] [--name "..."]
 *     [--fields '{json}']
 *   template fill plan --phase N       Create pre-filled PLAN.md
 *     [--plan M] [--type execute|tdd]
 *     [--wave N] [--fields '{json}']
 *   template fill verification         Create pre-filled VERIFICATION.md
 *     --phase N [--fields '{json}']
 *
 * State Progression:
 *   state advance-plan                 Increment plan counter
 *   state record-metric --phase N      Record execution metrics
 *     --plan M --duration Xmin
 *     [--tasks N] [--files N]
 *   state update-progress              Recalculate progress bar
 *   state add-decision --summary "..."  Add decision to STATE.md
 *     [--phase N] [--rationale "..."]
 *     [--summary-file path] [--rationale-file path]
 *   state add-blocker --text "..."     Add blocker
 *     [--text-file path]
 *   state resolve-blocker --text "..." Remove blocker
 *   state record-session               Update session continuity
 *     --stopped-at "..."
 *     [--resume-file path]
 *
 * Compound Commands (workflow-specific initialization):
 *   init execute-phase <phase>         All context for execute-phase workflow
 *   init plan-phase <phase>            All context for plan-phase workflow
 *   init new-project                   All context for new-project workflow
 *   init new-milestone                 All context for new-milestone workflow
 *   init quick <description>           All context for quick workflow
 *   init resume                        All context for resume-project workflow
 *   init verify-work <phase>           All context for verify-work workflow
 *   init phase-op <phase>              Generic phase operation context
 *   init todos [area]                  All context for todo workflows
 *   init milestone-op                  All context for milestone operations
 *   init map-codebase                  All context for map-codebase workflow
 *   init progress                      All context for progress workflow
 *
 * Documentation:
 *   docs-init                            Project context for docs-update workflow
 *
 * Learnings:
 *   learnings list                       List all global learnings (JSON)
 *   learnings query --tag <tag>          Query learnings by tag
 *   learnings copy                       Copy from current project's LEARNINGS.md
 *   learnings prune --older-than <dur>   Remove entries older than duration (e.g. 90d)
 *   learnings delete <id>                Delete a learning by ID
 *
 * Loop Extension Point Queries (ADR-857 phase 3c):
 *   loop render-hooks <point>            Resolve + render active Capability hooks at a loop point
 *                                        [--config-dir <path>] [--runtime <r>] [--active-cap <capId>]
 *                                        Returns JSON envelope { point, activeHooks, rendered }
 *                                        Valid points: discuss:pre/post, plan:pre/post,
 *                                        execute:pre/wave:pre/wave:post/post, verify:pre/post, ship:pre/post
 *                                        --runtime: override the auto-detected runtime (#2003) so the config
 *                                                   dir resolves to that runtime's home even when
 *                                                   .planning/config.json persists a different runtime.
 *
 * Capability State (ADR-857 phase 4b):
 *   capability state [--config-dir <path>] [--runtime <r>]  Resolve per-capability install/surface/hook-activation state
 *                                           Returns JSON envelope { runtimeConfigDir, capabilities[] }
 *                                           --config-dir: runtime config dir (default: auto-detect current runtime)
 *                                           --runtime: override the auto-detected runtime (#2003); bypasses the
 *                                                      GSD_RUNTIME → config.runtime → 'claude' precedence so a
 *                                                      repo with a persisted runtime can still resolve another
 *                                                      runtime's config dir (e.g. driving Claude Code from a
 *                                                      repo that persists runtime:"codex").
 *
 * GSD-2 Migration:
 *   from-gsd2 [--path <dir>] [--force] [--dry-run]
 *             Import a GSD-2 (.gsd/) project back to GSD v1 (.planning/) format
 */

const fs = require('fs');
const path = require('path');

// #2002 — self-healing runtime build. The compiled ./lib/*.cjs modules this
// entrypoint require()s below are gitignored build artifacts (ADR-457), shipped
// prebuilt in the npm tarball. The Claude Code plugin-marketplace channel never
// runs `npm run build:lib` or bin/install.js, so on that path they can be
// absent and every command dies at module load. Compile them once (lock-guarded,
// idempotent, a no-op when already built) before the ./lib requires run.
const { ensureRuntimeBuild } = require('./ensure-runtime-build.cjs');
try {
  ensureRuntimeBuild();
} catch (bootErr) {
  process.stderr.write((bootErr && bootErr.message ? bootErr.message : String(bootErr)) + '\n');
  // Fatal bootstrap failure before the CLI's ExitError/runMain machinery (which
  // lives in ./lib) is available to load, so a direct exit is the only option.
  // #3910: this call runs BEFORE ./lib/cli-exit.cjs is even required, so the
  // registered-exit seam (runMain/ExitError/terminateNow) does not exist yet
  // at this point in the process's lifetime — there is nothing to route
  // through. This is the second (and only other) sanctioned allowlist entry
  // for local/require-registered-exit, alongside terminateNow's own body.
  // #3914: n/no-process-exit and local/require-registered-exit are
  // complementary, not predecessor/successor (see eslint.config.mjs and
  // docs/adr/3889-process-exit-contract.md) — both remain 'error' on this
  // glob, so both need a disable directive here.
  // eslint-disable-next-line n/no-process-exit, local/require-registered-exit
  process.exit(1);
}

const { ExitError, runMain, resolveContractVersion } = require('./lib/cli-exit.cjs');
const io = require('./lib/io.cjs');
const { error, ERROR_REASON, setJsonErrorMode, output, formatDiagnosticToken } = io;
const projectRoot = require('./lib/project-root.cjs');
// Resolve findProjectRoot lazily at call time rather than binding it at module
// load. It is sourced from project-root.cjs; a call-time lookup is robust
// against any require/load-ordering edge where the export isn't bound yet
// when this entrypoint is first required (#604).
const findProjectRoot = (...args) => projectRoot.findProjectRoot(...args);

// #1754: CLI skew detection — warn (stderr, non-blocking) if this gsd-tools.cjs
// is NOT the project-local install while a project-local install exists. Catches
// the shadowing scenario from #1748 (stale global canary shadowing project-local).
try {
  const _skew = require('./lib/cli-skew-check.cjs');
  const _skewRoot = findProjectRoot(process.cwd());
  if (_skewRoot) {
    const _skewLocal = path.join(_skewRoot, '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs');
    const _skewWarn = _skew.checkCliSkew({
      resolvedPath: path.resolve(__filename),
      projectRoot: _skewRoot,
      projectLocalExists: fs.existsSync(_skewLocal),
    });
    if (_skewWarn) process.stderr.write(_skewWarn + '\n');
  }
} catch { /* advisory — never block */ }

const { resolveActiveWorkstream, applyResolvedWorkstreamEnv, peekActiveWorkstream } = require('./lib/active-workstream-store.cjs');
const state = require('./lib/state.cjs');
const phase = require('./lib/phase.cjs');
const roadmap = require('./lib/roadmap.cjs');
// #3024: resolve skills root for the sync-skills workflow (install.js is not
// shipped in installed trees; gsd-tools IS shipped, so the workflow calls this).
const { getGlobalSkillsBase, isRegisteredRuntimeId } = require('./lib/runtime-homes.cjs');
// #1561 — assumption-delta advisory checkpoint detector (pure function).
const { detectAssumptionDelta } = require('./lib/assumption-delta.cjs');
const verify = require('./lib/verify.cjs');
const config = require('./lib/config.cjs');
const estimateCli = require('./lib/estimate-cli.cjs');
const template = require('./lib/template.cjs');
const milestone = require('./lib/milestone.cjs');
const commands = require('./lib/commands.cjs');
const runtimeIdentity = require('./lib/runtime-identity.cjs');
const init = require('./lib/init.cjs');
const frontmatter = require('./lib/frontmatter.cjs');
const workstream = require('./lib/workstream.cjs');
const docs = require('./lib/docs.cjs');
const learnings = require('./lib/learnings.cjs');
const gapChecker = require('./lib/gap-checker.cjs');
const { routeStateCommand } = require('./lib/state-command-router.cjs');
const { routeVerifyCommand } = require('./lib/verify-command-router.cjs');
const { routeEvalCommand } = require('./lib/eval-command-router.cjs');
const evalMod = require('./lib/eval.cjs');
const { routeVerificationCommand } = require('./lib/verification-command-router.cjs');
const { routePlanningCommand } = require('./lib/planning-command-router.cjs');
const verification = require('./lib/verification.cjs');
const { routeInitCommand } = require('./lib/init-command-router.cjs');
// Stale-bake guard (#1688): warns once when model config changed since agents
// were last baked on static-frontmatter runtimes (codex/opencode). Lazy-required
// here, invoked from case 'init' below.
const { warnIfStaleBake } = require('./lib/stale-bake-guard.cjs');
const loopResolver = require('./lib/loop-resolver.cjs');
const brokenWindows = require('./lib/broken-windows.cjs');
const { routePhaseCommand } = require('./lib/phase-command-router.cjs');
const { routePhasesCommand } = require('./lib/phases-command-router.cjs');
const { routeValidateCommand } = require('./lib/validate-command-router.cjs');
const { routeRoadmapCommand } = require('./lib/roadmap-command-router.cjs');
const { routeCapabilityCommand } = require('./lib/capability-command-router.cjs');
const { routeAgentCommand, AGENT_FAILURE_CLASSES } = require('./lib/agent-command-router.cjs');
const smartEntryMod = require('./lib/smart-entry.cjs');
const { routeCheckCommand } = require('./lib/check-command-router.cjs');
const { routeTaskCommand } = require('./lib/task-command-router.cjs');
const { parseNamedArgsOrExit, parseMultiwordArg } = require('./lib/command-arg-projection.cjs');
const { cmdGitBaseBranch } = require('./lib/git-base-branch.cjs');
const { getEffectiveAuthority, classifyDriftSeverity, comparePhaseStatus } = require('./lib/plan-drift-guard.cjs');

// ─── Bridge collapsed (Phase 4) ────────────────────────────────────────────────
// Non-family commands now run through their CJS handlers directly. Keep the
// helper contract so existing call sites remain unchanged during the phase
// sequence; it always returns false so callers fall through to CJS.

/**
 * Retired bridge-era shim for non-family dispatch.
 *
 * Always returns false so command handlers continue down the CJS path.
 * Kept only to avoid churn while legacy call sites are being deleted.
 *
 * @param {object} opts
 * @param {string} opts.registryCommand - legacy bridge placeholder
 * @param {string[]} opts.registryArgs - legacy bridge placeholder
 * @param {string} opts.legacyCommand - original gsd-tools command name
 * @param {string[]} opts.legacyArgs - original args
 * @param {string} opts.cwd - project dir
 * @param {boolean} opts.raw - raw output mode
 * @param {Function} opts.error - error reporter
 * @param {Function} opts.output - output emitter (output)
 */
function _dispatchNonFamily({ registryCommand, registryArgs, legacyCommand, legacyArgs, cwd, raw, error, output }) {
  void registryCommand;
  void registryArgs;
  void legacyCommand;
  void legacyArgs;
  void cwd;
  void raw;
  void error;
  void output;
  return false;
}

// ─── ADR-959: Capability Command Dispatch ─────────────────────────────────────

/**
 * Dispatch a command via the capability registry's commandFamilies index.
 *
 * Consulted in the `default` case of `runCommand` BEFORE the unknown-command
 * error is emitted. Returns:
 *   true  — command was "consumed" (found in registry, or a dispatch error was
 *            emitted); "Unknown command" is suppressed in all consumed cases.
 *   false — command not found in the registry (including prototype-pollution
 *            guard hits and missing/empty commandFamilies); caller falls through
 *            to the existing unknown-command error path.
 * Behavior-preserving when commandFamilies is empty ({}).
 *
 * Injectable for tests:
 * - `registry` defaults to require('./lib/capability-registry.cjs')
 * - `requireModule` defaults to a confinement-checked loader that resolves the
 *   module path relative to bin/lib/ and asserts it stays within that directory
 *   before requiring — defense-in-depth against corrupted/hand-edited registry entries.
 *
 * @param {object}   opts
 * @param {string}   opts.command        The command name (top-level gsd-tools command)
 * @param {string[]} opts.args           Remaining args passed to the router
 * @param {string}   opts.cwd            Project working directory
 * @param {boolean}  opts.raw            Raw output mode flag
 * @param {Function} opts.error          Error reporter (io.error)
 * @param {object}   [opts.registry]     Injectable registry (for tests)
 * @param {Function} [opts.requireModule] Injectable module loader (for tests)
 * @returns {boolean} true if the command was dispatched, false otherwise
 */
function dispatchCapabilityCommand({ command, args, cwd, raw, error, registry, requireModule }) {
  // Prototype-pollution guard: reject reserved property names as command keys
  if (command === '__proto__' || command === 'constructor' || command === 'prototype') {
    return false;
  }

  // Resolve defaults (injectable for tests)
  const reg = registry !== undefined ? registry : require('./lib/capability-registry.cjs');

  // Default requireModule: confined to bin/lib/ — validate the module name is a
  // safe bare .cjs basename (no path separators, no directory traversal), then
  // resolve and assert confinement, then require the RESOLVED absolute path so
  // the checked representation and the required representation are identical.
  const libDir = path.join(__dirname, 'lib');
  const defaultRequireModule = function (m) {
    // Step 1: validate m is a bare .cjs basename — same conservative pattern the
    // generator uses. Rejects any value with path separators (/, \, ..) or
    // missing the .cjs extension before we even touch the filesystem.
    if (typeof m !== 'string' || !/^[A-Za-z0-9._-]+\.cjs$/.test(m)) {
      throw new Error('capability module must be a bare .cjs basename: ' + JSON.stringify(m));
    }
    // Step 2: confinement check — belt-and-suspenders even after the basename
    // validation above. Resolved path must be inside libDir (not equal to it,
    // and must start with libDir + sep so "libDir-suffix" can't sneak through).
    const resolved = path.resolve(libDir, m);
    if (resolved === libDir || !resolved.startsWith(libDir + path.sep)) {
      throw new Error('capability module path escapes bin/lib/: ' + JSON.stringify(m));
    }
    // Step 3: require the resolved absolute path — the SAME representation that
    // was checked above, not the concatenated './lib/' + m string.
    return require(resolved);
  };
  const loadModule = requireModule !== undefined ? requireModule : defaultRequireModule;

  // Look up the command family in the registry
  const families = reg && reg.commandFamilies;
  if (!families || typeof families !== 'object') return false;

  const entry = families[command];
  if (!entry || typeof entry !== 'object') return false;

  // Resolve and call the router
  let mod;
  try {
    mod = loadModule(entry.module);
  } catch (_) {
    // Module not found, load error, or confinement violation — surface a
    // diagnostic and return true (consumed) so "Unknown command" is suppressed.
    error('capability command "' + command + '" module "' + entry.module + '" failed to load');
    return true; // consumed — don't emit "Unknown command"
  }

  // Own-property guard: prevent invoking inherited prototype methods
  // (constructor, toString, hasOwnProperty, etc.) as a router when the registry
  // entry names one of those. Must come before the typeof check.
  if (!mod || !Object.prototype.hasOwnProperty.call(mod, entry.router)) {
    error('capability command "' + command + '" router "' + entry.router + '" is not an own export of module "' + entry.module + '"');
    return true; // consumed — don't emit "Unknown command"
  }
  const fn = mod[entry.router];
  if (typeof fn !== 'function') {
    // Router export not found — surface a diagnostic and return true (consumed)
    // so "Unknown command" is suppressed.
    error('capability command "' + command + '" router "' + entry.router + '" is not a function in module "' + entry.module + '"');
    return true; // consumed — don't emit "Unknown command"
  }

  let _result;
  try {
    _result = fn({ args, cwd, raw, error });
  } catch (e) {
    if (e instanceof ExitError) throw e; // intentional structured error from the router (honors --json-errors) — propagate untouched
    error(
      'capability command "' + command + '" router "' + entry.router + '" in module "' + entry.module + '" threw: ' + (e && e.message ? e.message : String(e)),
      ERROR_REASON.SDK_FAIL_FAST,
    );
  }
  if (_result && typeof _result.then === 'function') {
    error(
      'capability command "' + command + '" router "' + entry.router + '" in module "' + entry.module + '" must be synchronous (returned a Promise); async capability routers are not supported.',
      ERROR_REASON.SDK_FAIL_FAST,
    );
  }
  return true;
}

/**
 * Require a THIRD-PARTY capability's router module from its install root, confined to that root.
 * The module name must be a bare `.cjs` basename (same conservative pattern the generator enforces).
 * The install root is realpath-resolved (defeating symlinked path components) and the resolved
 * module must live strictly inside it; the module file is then realpath-checked so a symlinked file
 * cannot escape the root either. ADR-1244 Phase 5 (D7).
 *
 * @param {string} installRoot Absolute install-root dir of the owning capability
 * @param {string} m           Bare `.cjs` module basename from the capability manifest
 * @returns {*} the required module
 */
function defaultRequireFromInstallRoot(installRoot, m) {
  if (typeof m !== 'string' || !/^[A-Za-z0-9._-]+\.cjs$/.test(m)) {
    throw new Error('capability module must be a bare .cjs basename: ' + JSON.stringify(m));
  }
  // Realpath the root so a symlinked ancestor can't widen confinement.
  const realRoot = fs.realpathSync(installRoot);
  const resolved = path.resolve(realRoot, m);
  if (resolved === realRoot || !resolved.startsWith(realRoot + path.sep)) {
    throw new Error('capability module path escapes its install root: ' + JSON.stringify(m));
  }
  // The module file itself must not be a symlink pointing outside the root.
  const realResolved = fs.realpathSync(resolved);
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
    throw new Error('capability module resolves outside its install root (symlink): ' + JSON.stringify(m));
  }
  return require(realResolved);
}

/**
 * Dispatch a THIRD-PARTY (installed overlay) capability command family — ADR-1244 Phase 5 (D7).
 * This is where third-party code executes, so it is doubly gated:
 *   - CONSENT: `loadRegistry({ includeInstalled })` excludes `_pending` (unconsented) capabilities,
 *     and only third-party caps that declared `commands` appear in `_overlay.commandRoots`. A capId
 *     absent from `commandRoots` is first-party (handled by dispatchCapabilityCommand) or not an
 *     installed overlay — we fall through.
 *   - CONFINEMENT: the router module is `require()`'d FROM the capability's install root, confined to
 *     that root (basename validation + realpath containment), so a manifest can never reach code
 *     outside its own bundle.
 * Returns true when consumed (suppress "Unknown command"), false to fall through.
 *
 * @param {object} opts
 * @param {Function} [opts.loadRegistry]  Injectable overlay loader (for tests)
 * @param {Function} [opts.requireModule] Injectable (installRoot, module) loader (for tests)
 */
function dispatchOverlayCapabilityCommand({ command, args, cwd, raw, error, loadRegistry, requireModule }) {
  if (command === '__proto__' || command === 'constructor' || command === 'prototype') {
    return false;
  }

  let reg;
  try {
    const load = loadRegistry !== undefined ? loadRegistry : require('./lib/capability-loader.cjs').loadRegistry;
    reg = load({ includeInstalled: true, cwd });
  } catch (_) {
    return false; // overlay load failed — fall through to "Unknown command"
  }

  const families = reg && reg.commandFamilies;
  const commandRoots = reg && reg._overlay && reg._overlay.commandRoots;
  if (!families || typeof families !== 'object' || !commandRoots || typeof commandRoots !== 'object') {
    return false; // no installed overlay command families
  }

  const entry = families[command];
  if (!entry || typeof entry !== 'object') return false;

  // Only THIRD-PARTY overlay caps are dispatched here. A capId present in commandRoots is an
  // accepted, committed (consented) overlay cap; a capId absent is first-party or not an overlay.
  const capId = entry.capId;
  if (typeof capId !== 'string' || !Object.prototype.hasOwnProperty.call(commandRoots, capId)) {
    return false;
  }
  const installRoot = commandRoots[capId];
  if (typeof installRoot !== 'string' || !installRoot) return false;

  const loadModule = requireModule !== undefined ? requireModule : defaultRequireFromInstallRoot;
  let mod;
  try {
    mod = loadModule(installRoot, entry.module);
  } catch (_) {
    error('capability command "' + command + '" module "' + entry.module + '" failed to load from its install root');
    return true; // consumed — don't emit "Unknown command"
  }

  if (!mod || !Object.prototype.hasOwnProperty.call(mod, entry.router)) {
    error('capability command "' + command + '" router "' + entry.router + '" is not an own export of module "' + entry.module + '"');
    return true;
  }
  const fn = mod[entry.router];
  if (typeof fn !== 'function') {
    error('capability command "' + command + '" router "' + entry.router + '" is not a function in module "' + entry.module + '"');
    return true;
  }

  let _result;
  try {
    _result = fn({ args, cwd, raw, error });
  } catch (e) {
    if (e instanceof ExitError) throw e;
    error(
      'capability command "' + command + '" router "' + entry.router + '" in module "' + entry.module + '" threw: ' + (e && e.message ? e.message : String(e)),
      ERROR_REASON.SDK_FAIL_FAST,
    );
  }
  if (_result && typeof _result.then === 'function') {
    error(
      'capability command "' + command + '" router "' + entry.router + '" in module "' + entry.module + '" must be synchronous (returned a Promise); async capability routers are not supported.',
      ERROR_REASON.SDK_FAIL_FAST,
    );
  }
  return true;
}

// ─── ADR-2346 (epic #2345): host dispatch table ───────────────────────────────
// Layer-2 of the two-layer dispatch. Core, non-capability host commands live
// here — NOT in the capability registry (ADR-959's commandFamilies is reserved
// for toggleable feature capabilities: graphify/audit/intel). A host command
// like `state` is core, non-toggleable, carries no tier/activationKey, so it
// cannot be a capability. Each entry maps a top-level command to its standard
// `route*Command` router (the same routers the hardcoded `case` arms called).
// Consulted in runCommand's `default` case, after capability + overlay
// dispatch, before the unknown-command error. A migrated command's `case` arm
// is removed at cutover so it reaches here; an unmigrated command still hits
  // its `case` (collision structurally impossible, same property as ADR-959).

  // ─── ADR-2346 P3: resolve/git/config/research host routers ────────────────
  // Each body was relocated VERBATIM from its `case` arm (cutover: the arm is
  // removed so dispatch reaches HOST_COMMAND_ROUTERS). Closures over module-
  // scope libs (commands/config/output/error/_dispatchNonFamily) are preserved;
  // only per-dispatch values (args/cwd/raw/defaultValue/workstreamContext)
  // arrive via the destructured context.

  function routeResolveModel({ args, cwd, raw }) {
    commands.cmdResolveModel(cwd, args[1], raw);
  }

  function routeResolveGranularity({ args, cwd, raw }) {
    const granArgs = args.slice(1);
    let granOverride;
    const granPositionals = [];
    for (let i = 0; i < granArgs.length; i++) {
      const a = granArgs[i];
      if (a === '--granularity' && granArgs[i + 1] !== undefined && !granArgs[i + 1].startsWith('--')) {
        if (granOverride === undefined) { granOverride = granArgs[++i]; } else { ++i; }
      } else {
        granPositionals.push(a);
      }
    }
    commands.cmdResolveGranularity(cwd, granPositionals[0], raw, granOverride);
  }

  function routeResolveExecution({ args, cwd, raw }) {
    const execArgs = args.slice(1);
    let effortOverride;
    let fastModeOverride;
    let attempt;
    let failureClass;
    let host;
    const positionals = [];
    // #2296: the valid classes come from the classifier's own frozen enum, so
    // this validator can never drift from what `agent classify-failure` emits.
    const validFailureClasses = Object.values(AGENT_FAILURE_CLASSES);
    const setFailureClass = (v) => {
      if (!validFailureClasses.includes(v)) {
        error(
          `--failure-class must be one of: ${validFailureClasses.join(', ')}`,
          ERROR_REASON.USAGE,
        );
      }
      failureClass = v;
    };
    for (let i = 0; i < execArgs.length; i++) {
      const a = execArgs[i];
      if (a.startsWith('--effort=')) {
        effortOverride = a.slice('--effort='.length);
        continue;
      }
      if (a.startsWith('--fast-mode=')) {
        const v = a.slice('--fast-mode='.length);
        fastModeOverride = v === 'true' ? true : v === 'false' ? false : undefined;
        continue;
      }
      if (a.startsWith('--attempt=')) {
        const v = a.slice('--attempt='.length);
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 0) error('--attempt requires a non-negative integer', ERROR_REASON.USAGE);
        attempt = n;
        continue;
      }
      if (a.startsWith('--failure-class=')) {
        setFailureClass(a.slice('--failure-class='.length));
        continue;
      }
      if (a === '--effort') {
        const val = execArgs[i + 1];
        if (val === undefined || val.startsWith('--')) error('Missing value for --effort', ERROR_REASON.USAGE);
        effortOverride = val;
        i++;
        continue;
      }
      if (a === '--fast-mode') {
        const val = execArgs[i + 1];
        if (val === undefined || val.startsWith('--')) error('Missing value for --fast-mode', ERROR_REASON.USAGE);
        fastModeOverride = val === 'true' ? true : val === 'false' ? false : undefined;
        i++;
        continue;
      }
      if (a === '--attempt') {
        const val = execArgs[i + 1];
        if (val === undefined || val.startsWith('--')) error('Missing value for --attempt', ERROR_REASON.USAGE);
        const n = parseInt(val, 10);
        if (!Number.isInteger(n) || n < 0) error('--attempt requires a non-negative integer', ERROR_REASON.USAGE);
        attempt = n;
        i++;
        continue;
      }
      if (a === '--failure-class') {
        const val = execArgs[i + 1];
        if (val === undefined || val.startsWith('--')) error('Missing value for --failure-class', ERROR_REASON.USAGE);
        setFailureClass(val);
        i++;
        continue;
      }
      if (a === '--host') {
        const val = execArgs[i + 1];
        if (val === undefined || val.startsWith('--')) error('Missing value for --host', ERROR_REASON.USAGE);
        host = val;
        i++;
        continue;
      }
      if (a === '--raw') continue;
      if (a.startsWith('-')) error(`Unknown flag for resolve-execution: ${a}`, ERROR_REASON.USAGE);
      positionals.push(a);
    }
    if (positionals.length === 0) error('agent-type required', ERROR_REASON.USAGE);
    if (positionals.length > 1) error(`resolve-execution requires exactly one agent-type argument; got: ${positionals.join(', ')}`, ERROR_REASON.USAGE);
    const agentTypeArg = positionals[0];
    commands.cmdResolveExecution(cwd, agentTypeArg, raw, {
      effortOverride,
      fastModeOverride,
      attempt,
      failureClass,
      host,
    });
  }

  function routeGit({ args, cwd }) {
    const subcommand = args[1];
    if (subcommand !== 'base-branch') {
      error(
        `Unknown git subcommand: ${subcommand || '(none)'}. Available: base-branch`,
        ERROR_REASON.SDK_UNKNOWN_COMMAND,
      );
      return;
    }
    cmdGitBaseBranch(cwd, args.slice(2));
  }

  function routeConfigEnsureSection({ args, cwd, raw }) {
    const handled = _dispatchNonFamily({
      registryCommand: 'config-ensure-section',
      registryArgs: args.slice(1),
      legacyCommand: 'config-ensure-section',
      legacyArgs: args.slice(1),
      cwd,
      raw,
      error,
      output: output,
    });
    if (!handled) config.cmdConfigEnsureSection(cwd, raw);
  }

  function routeConfigSet({ args, cwd, raw }) {
    const handled = _dispatchNonFamily({
      registryCommand: 'config-set',
      registryArgs: args.slice(1),
      legacyCommand: 'config-set',
      legacyArgs: args.slice(1),
      cwd,
      raw,
      error,
      output: output,
    });
    if (!handled) config.cmdConfigSet(cwd, args[1], args[2], raw);
  }

  function routeConfigSetModelProfile({ args, cwd, raw }) {
    const handled = _dispatchNonFamily({
      registryCommand: 'config-set-model-profile',
      registryArgs: args.slice(1),
      legacyCommand: 'config-set-model-profile',
      legacyArgs: args.slice(1),
      cwd,
      raw,
      error,
      output: output,
    });
    if (!handled) config.cmdConfigSetModelProfile(cwd, args[1], raw);
  }

  function routeConfigGet({ args, cwd, raw, defaultValue }) {
    const configGetSdkArgs = defaultValue !== undefined
      ? [args[1], '--default', defaultValue]
      : args.slice(1);
    const handled = _dispatchNonFamily({
      registryCommand: 'config-get',
      registryArgs: configGetSdkArgs,
      legacyCommand: 'config-get',
      legacyArgs: args.slice(1),
      cwd,
      raw,
      error,
      output: output,
    });
    if (!handled) config.cmdConfigGet(cwd, args[1], raw, defaultValue);
  }

  function routeConfigNewProject({ args, cwd, raw }) {
    const handled = _dispatchNonFamily({
      registryCommand: 'config-new-project',
      registryArgs: args.slice(1),
      legacyCommand: 'config-new-project',
      legacyArgs: args.slice(1),
      cwd,
      raw,
      error,
      output: output,
    });
    if (!handled) config.cmdConfigNewProject(cwd, args[1], raw);
  }

  function routeConfigPath({ cwd, raw, workstreamContext }) {
    config.cmdConfigPath(cwd, raw, workstreamContext);
  }

  async function routeMigrateConfig({ cwd, raw }) {
    await config.cmdMigrateConfig(cwd, raw);
  }

  function routeResearchStore({ args, cwd, raw }) {
    const researchStore = require('./lib/research-store.cjs');
    const subcommand = args[1];
    const homeDir = process.env.HOME || require('os').homedir();
    if (subcommand === 'get') {
      const key = args[2];
      if (!key || key.startsWith('--')) {
        error('Usage: gsd-tools research-store get <key> [--kind <k>]', ERROR_REASON.USAGE);
      }
      if (!researchStore.isValidResearchKey(key)) {
        error('research-store: <key> must be a 64-char sha256 hex (use research-plan to obtain keys)', ERROR_REASON.USAGE);
      }
      const result = researchStore.getResearch(cwd, key, { homeDir });
      output(result, raw);
    } else if (subcommand === 'put') {
      const key = args[2];
      if (!key || key.startsWith('--')) {
        error('Usage: gsd-tools research-store put <key> --content <str> --source <s> --provider <p> --confidence <c> --kind <k>', ERROR_REASON.USAGE);
      }
      if (!researchStore.isValidResearchKey(key)) {
        error('research-store: <key> must be a 64-char sha256 hex (use research-plan to obtain keys)', ERROR_REASON.USAGE);
      }
      const contentIdx = args.indexOf('--content');
      const sourceIdx = args.indexOf('--source');
      const providerIdx = args.indexOf('--provider');
      const confidenceIdx = args.indexOf('--confidence');
      const kindIdx = args.indexOf('--kind');
      function getFlagValue(idx, flagName) {
        if (idx === -1) return null;
        const val = args[idx + 1];
        if (val === undefined || val.startsWith('--')) {
          error(`research-store put: missing value for ${flagName}`, ERROR_REASON.USAGE);
        }
        return val;
      }
      const content = getFlagValue(contentIdx, '--content');
      const source = getFlagValue(sourceIdx, '--source');
      const provider = getFlagValue(providerIdx, '--provider');
      const confidence = getFlagValue(confidenceIdx, '--confidence');
      const kind = getFlagValue(kindIdx, '--kind');
      if (!content || !source || !provider || !confidence || !kind) {
        error('Usage: gsd-tools research-store put <key> --content <str> --source <s> --provider <p> --confidence <c> --kind <k>', ERROR_REASON.USAGE);
      }
      const entry = researchStore.putResearch(cwd, key, { content, source, provider, confidence, kind }, { homeDir });
      output(entry, raw);
    } else {
      error('Unknown research-store subcommand. Available: get, put', ERROR_REASON.SDK_UNKNOWN_COMMAND);
    }
  }

  function routeResearchPlan({ args, cwd, raw }) {
    const researchProvider = require('./lib/research-provider.cjs');
    const inputIdx = args.indexOf('--input');
    const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : null;
    if (!inputPath || inputPath.startsWith('--')) {
      error('Usage: gsd-tools research-plan --input <path>', ERROR_REASON.USAGE);
    }
    let planInput;
    try {
      const raw_ = fs.readFileSync(path.resolve(inputPath), 'utf8');
      planInput = JSON.parse(raw_);
    } catch (readErr) {
      error(`research-plan: cannot read/parse --input file: ${inputPath}`, ERROR_REASON.USAGE);
    }
    if (planInput === null || typeof planInput !== 'object' || Array.isArray(planInput)) {
      error('research-plan: --input must be an object with a questions array', ERROR_REASON.USAGE);
    }
    if (!Array.isArray(planInput.questions)) {
      error('research-plan: --input must be an object with a questions array', ERROR_REASON.USAGE);
    }
    const { ecosystem = '', config: planConfig = {}, questions } = planInput;
    const homeDir = process.env.HOME || require('os').homedir();
    const plan = researchProvider.planResearch({ questions, ecosystem, config: planConfig, cwd, homeDir });
    output(plan, raw);
  }

  // ─── ADR-2346 P4: leaf host routers (all remaining commands) ───────────
  // Each body relocated verbatim from its `case` arm; inner break; → return;.

  function routeAgent({ args, cwd, raw, error }) {
    routeAgentCommand({ args, raw });
  }

  function routeSmartEntry({ args, cwd, raw, error }) {
    smartEntryMod.runSmartEntry(cwd, args, raw);
  }

  function routeCheck({ args, cwd, raw, error }) {
    routeCheckCommand({ args, cwd, raw });
  }

  function routeFindPhase({ args, cwd, raw, error }) {
    // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
          // SDK handler: findPhase in sdk/src/query/phase.ts.
          const handled = _dispatchNonFamily({
            registryCommand: 'find-phase',
            registryArgs: args.slice(1),
            legacyCommand: 'find-phase',
            legacyArgs: args.slice(1),
            cwd,
            raw,
            error,
            output: output,
          });
          if (!handled) phase.cmdFindPhase(cwd, args[1], raw);
  }

  function routeCommit({ args, cwd, raw, error }) {
    const amend = args.includes('--amend');
          const noVerify = args.includes('--no-verify');
          const filesIndex = args.indexOf('--files');
          // Collect all positional args between command name and first flag,
          // then join them — handles both quoted ("multi word msg") and
          // unquoted (multi word msg) invocations from different shells
          const endIndex = filesIndex !== -1 ? filesIndex : args.length;
          const messageArgs = args.slice(1, endIndex).filter(a => !a.startsWith('--'));
          const message = messageArgs.join(' ') || undefined;
          const files = filesIndex !== -1 ? args.slice(filesIndex + 1).filter(a => !a.startsWith('--')) : [];
          commands.cmdCommit(cwd, message, files, raw, amend, noVerify);
  }

  function routeCheckCommit({ args, cwd, raw, error }) {
    commands.cmdCheckCommit(cwd, raw);
  }

  function routeCommitDocsGuard({ args, cwd, raw, error }) {
    const subcommand = args[1];
    if (subcommand === 'enable') {
      commands.cmdCommitDocsGuardEnable(cwd, raw);
    } else if (subcommand === 'disable') {
      commands.cmdCommitDocsGuardDisable(cwd, raw);
    } else {
      error('Unknown commit-docs-guard subcommand. Available: enable, disable', ERROR_REASON.SDK_UNKNOWN_COMMAND);
    }
  }

  function routeCommitToSubrepo({ args, cwd, raw, error }) {
    const message = args[1];
          const filesIndex = args.indexOf('--files');
          const files = filesIndex !== -1 ? args.slice(filesIndex + 1).filter(a => !a.startsWith('--')) : [];
          commands.cmdCommitToSubrepo(cwd, message, files, raw);
  }

  function routePrSubrepo({ args, cwd, raw, error }) {
    const message = args[1];
          // #3884: the commit message is an optional leading positional the
          // caller owns (args[1]) — but when it is OMITTED, args[1] is itself
          // the first flag (e.g. `--repo`), and a static `positionals: 2`
          // treats that flag's own value as an unexpected trailing positional
          // before cmdPrSubrepo's own "commit message required" guard ever
          // runs. Widen the boundary only when args[1] genuinely looks like a
          // message (not flag-shaped), mirroring the same fix applied to
          // `state complete-phase`.
          const messagePresent = message !== undefined && !message.startsWith('--');
          const { repo, branch } = parseNamedArgsOrExit(args, { valueFlags: ['repo', 'branch'], positionals: messagePresent ? 2 : 1 }, error);
          commands.cmdPrSubrepo(cwd, repo, branch, message, raw);
  }

  function routeVerifySummary({ args, cwd, raw, error }) {
    const summaryPath = args[1];
          const countIndex = args.indexOf('--check-count');
          const checkCount = countIndex !== -1 ? parseInt(args[countIndex + 1], 10) : 2;
          verify.cmdVerifySummary(cwd, summaryPath, checkCount, raw);
  }

  function routeTemplate({ args, cwd, raw, error }) {
    const subcommand = args[1];
          if (subcommand === 'select') {
            template.cmdTemplateSelect(cwd, args[2], raw);
          } else if (subcommand === 'fill') {
            const templateType = args[2];
            const { phase, plan, name, type, wave, fields: fieldsRaw } = parseNamedArgsOrExit(args, { valueFlags: ['phase', 'plan', 'name', 'type', 'wave', 'fields'], positionals: 3 }, error);
            let fields = {};
            if (fieldsRaw) {
              const { safeJsonParse } = require('./lib/security.cjs');
              const result = safeJsonParse(fieldsRaw, { label: '--fields' });
              if (!result.ok) error(result.error);
              fields = result.value;
            }
            template.cmdTemplateFill(cwd, templateType, {
              phase, plan, name, fields,
              type: type || 'execute',
              wave: wave || '1',
            }, raw);
          } else {
            error('Unknown template subcommand. Available: select, fill', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeTask({ args, cwd, raw, error }) {
    routeTaskCommand({ args, cwd, raw });
  }

  function routeFrontmatter({ args, cwd, raw, error }) {
    // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
          // SDK handler: sdk/src/query/frontmatter.ts + frontmatter-mutation.ts.
          // CJS fallback: frontmatter.cjs (cooperating sibling).
          const subcommand = args[1];
          const file = args[2];
          const FRONTMATTER_SDK_MAP = {
            get: 'frontmatter.get',
            set: 'frontmatter.set',
            merge: 'frontmatter.merge',
            validate: 'frontmatter.validate',
          };
          if (subcommand in FRONTMATTER_SDK_MAP) {
            const handled = _dispatchNonFamily({
              registryCommand: FRONTMATTER_SDK_MAP[subcommand],
              registryArgs: args.slice(2),
              legacyCommand: 'frontmatter',
              legacyArgs: args.slice(1),
              cwd,
              raw,
              error,
              output: output,
            });
            if (handled) return;
          }
          // CJS fallback (SDK unavailable or unknown subcommand)
          if (subcommand === 'get') {
            frontmatter.cmdFrontmatterGet(cwd, file, parseNamedArgsOrExit(args, { valueFlags: ['field'], positionals: 3 }, error).field, raw);
          } else if (subcommand === 'set') {
            const { field, value } = parseNamedArgsOrExit(args, { valueFlags: ['field', 'value'], positionals: 3 }, error);
            frontmatter.cmdFrontmatterSet(cwd, file, field, value !== null ? value : undefined, raw);
          } else if (subcommand === 'merge') {
            frontmatter.cmdFrontmatterMerge(cwd, file, parseNamedArgsOrExit(args, { valueFlags: ['data'], positionals: 3 }, error).data, raw);
          } else if (subcommand === 'validate') {
            frontmatter.cmdFrontmatterValidate(cwd, file, parseNamedArgsOrExit(args, { valueFlags: ['schema'], positionals: 3 }, error).schema, raw);
          } else {
            error('Unknown frontmatter subcommand. Available: get, set, merge, validate', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeEval({ args, cwd, raw, error }) {
    routeEvalCommand({ evalMod, args, cwd, raw, error });
  }

  function routeVerification({ args, cwd, raw, error }) {
    routeVerificationCommand({
            verification,
            args,
            cwd,
            raw,
            error,
          });
  }

  function routeGenerateSlug({ args, cwd, raw, error }) {
    // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
          // SDK handler: generateSlug in sdk/src/query/utils.ts.
          const handled = _dispatchNonFamily({
            registryCommand: 'generate-slug',
            registryArgs: args.slice(1),
            legacyCommand: 'generate-slug',
            legacyArgs: args.slice(1),
            cwd,
            raw,
            error,
            output: output,
          });
          if (!handled) commands.cmdGenerateSlug(args[1], raw);
  }

  function routeCurrentTimestamp({ args, cwd, raw, error }) {
    // Keep this command on the CJS fast path.
          // Rationale: it is a pure local formatter and avoids SDK bridge startup
          // in tight subprocess loops where Windows CI has shown intermittent
          // native crashes (0xC0000005 / 3221225477).
          commands.cmdCurrentTimestamp(args[1] || 'full', raw);
  }

  function routeRuntimeIdentity({ raw }) {
    // #3146: report this runtime's package identity so a shipped workflow can
    // tell whether it reached THIS package's gsd-tools or a colliding one.
    // Kept on the CJS fast path for the same reason as current-timestamp — the
    // launcher preamble spawns it once per workflow run, so SDK bridge startup
    // would be a per-run tax on every workflow.
    runtimeIdentity.cmdRuntimeIdentity(raw);
  }

  function routeSkillsRoot({ args, raw, error }) {
    // #3024: resolve the global skills base directory for a runtime.
    // The sync-skills workflow previously shelled out to install.js --skills-root,
    // but install.js is not shipped in installed trees. gsd-tools IS shipped, so
    // the workflow now calls `gsd-tools query skills-root <runtime>` instead.
    const runtime = args[1];
    if (!runtime) {
      error('Usage: gsd-tools query skills-root <runtime>');
    }
    // Defect B (#3024): validate the runtime id against the shipped capability
    // registry's canonical runtime set BEFORE resolving anything.
    // getGlobalSkillsBase falls through getGlobalConfigDir's unknown-runtime
    // branch to claude's skills root for ANY id it doesn't recognize, so an
    // unknown, empty/whitespace-only, path-traversal, or shell-metacharacter
    // runtime arg would otherwise silently resolve to claude's path instead of
    // failing loudly. isRegisteredRuntimeId does an own-property lookup (not a
    // bare index), rejecting `__proto__`/`constructor`/`prototype` runtime
    // ids, and is the SAME validator install.js's `--skills-root` entry point
    // calls, so the two shipped entry points can never diverge on which
    // runtime ids they accept.
    if (!isRegisteredRuntimeId(runtime)) {
      error(`Unknown runtime "${runtime}" — must be a registered runtime id`);
    }
    const trimmedRuntime = typeof runtime === 'string' ? runtime.trim() : '';
    const skillsRoot = getGlobalSkillsBase(trimmedRuntime);
    if (skillsRoot === null) {
      error(`No skills root found for runtime "${trimmedRuntime}"`);
    }
    output({ skills_root: skillsRoot }, raw, skillsRoot);
  }

  function routeProjectInstructionFile({ args, cwd, raw, error }) {
    // #1529: pure runtime→filename projection. Backs the
          // `gsd_run query project-instruction-file --runtime <r>` call in
          // new-project.md so the bash workflow and profile-output.cjs share one
          // source of truth (getProjectInstructionFile in runtime-name-policy.cjs).
          // No SDK bridge — pure local lookup, runs before .planning/ exists.
          const { getProjectInstructionFile } = require('./lib/runtime-name-policy.cjs');
          // Parse --runtime <value> (space or = form); default to empty so the
          // safe AGENTS.md cross-agent default applies.
          const pifArgs = args.slice(1);
          let pifRuntime = '';
          for (let i = 0; i < pifArgs.length; i++) {
            const a = pifArgs[i];
            if (a === '--runtime' && pifArgs[i + 1] !== undefined) { pifRuntime = pifArgs[++i]; continue; }
            if (a.startsWith('--runtime=')) { pifRuntime = a.slice('--runtime='.length); continue; }
            // First positional that isn't a flag also works (lenient); otherwise ignore unknown flags.
            if (!a.startsWith('-') && !pifRuntime) { pifRuntime = a; }
          }
          const filename = getProjectInstructionFile(pifRuntime);
          process.stdout.write(filename + '\n');
  }

  function routeListTodos({ args, cwd, raw, error }) {
    commands.cmdListTodos(cwd, args[1], raw);
  }

  function routeListSeeds({ args, cwd, raw, error }) {
    commands.cmdListSeeds(cwd, args[1], raw);
  }

  function routeVerifyPathExists({ args, cwd, raw, error }) {
    commands.cmdVerifyPathExists(cwd, args[1], raw);
  }

  function routeQuickTasksAppend({ args, cwd, raw, error }) {
    // #2133 / ADR-2143 §3,§7: schema-backed replacement for fast.md's inline
          // `awk NF-2` Quick Tasks column arithmetic. Row construction is delegated
          // to the pure appendQuickTaskRow (markdown-table.cjs); this case only
          // handles the I/O (read STATE.md, resolve date/commit, write STATE.md).
          const qtaArgs = args.slice(1);
          // Ambiguous boundary (ADR-3473 §8.4 Item 2 note): this command accepts
          // EITHER a positional free-text description (qtaArgs[0]) OR --task
          // <value> — the same token index is a caller-owned positional in one
          // input shape and a flag in the other, which a single fixed
          // `positionals` cursor cannot represent. `positionals: 'rest'`
          // disables the boundary walk (as with `init quick`) so extraction
          // (used for the --task form) and the `|| args[1]` fallback (used for
          // the positional form) both keep working unchanged.
          // #3356 defect 1: `--quick-id` / `--slug` / `--directory` are
          // OPTIONAL widenings. A caller with no quick id or task directory
          // (fast.md, the original #2133 caller) omits them and keeps the
          // exact prior ordinal-`#`/`'—'`-Directory row. A caller that DOES
          // have a real quick id + task dir (i.e. can match `workflows/
          // quick.md`'s own Step 7c row for the same inputs) supplies them
          // and gets the byte-equivalent canonical row `quick.md:632`
          // documents — closing the false-equivalence gap `quick.md:627`
          // claims. `--directory` wins outright when given explicitly;
          // otherwise a supplied `--quick-id` + `--slug` pair derives the
          // canonical permalink the same way `workflows/quick.md` renders it.
          const qtaParsed = parseNamedArgsOrExit(
            qtaArgs,
            { valueFlags: ['task', 'quick-id', 'slug', 'directory'], positionals: 'rest' },
            error,
          );
          const qtaTask = qtaParsed.task || args[1];
          if (!qtaTask) {
            error('quick-tasks-append requires --task <description> (or a positional description)', ERROR_REASON.USAGE);
          }
          const qtaQuickId = qtaParsed['quick-id'] || undefined;
          const qtaSlug = qtaParsed['slug'] || undefined;
          const qtaDirectory = qtaParsed['directory']
            || (qtaQuickId && qtaSlug ? `[${qtaQuickId}-${qtaSlug}](./quick/${qtaQuickId}-${qtaSlug}/)` : undefined);

          const statePath = path.join(cwd, '.planning', 'STATE.md');
          if (!fs.existsSync(statePath)) {
            error(`quick-tasks-append: STATE.md not found at ${statePath}`, ERROR_REASON.USAGE);
          }

          const date = new Date().toISOString().slice(0, 10);
          const { execGit } = require('./lib/shell-command-projection.cjs');
          const hashResult = execGit(['rev-parse', '--short', 'HEAD'], { cwd });
          const commit = hashResult.exitCode === 0 && hashResult.stdout ? hashResult.stdout : '—';

          const { appendQuickTaskRow } = require('./lib/markdown-table.cjs');

          // #2242 review fix: route the read -> mutate -> write cycle through
          // state.readModifyWriteStateMd (lib/state.cjs) instead of a raw
          // fs.readFileSync + fs.writeFileSync pair, so the whole read-modify-write
          // is atomic under STATE.md's lockfile — closing the lost-update race a
          // raw read/write pair left open (cf. #500/#905/#1230). This mirrors the
          // pattern every other STATE.md-mutating case in state.cts uses (e.g.
          // cmdStateAddBlocker, cmdStateAddDecision): a mutable outer variable
          // captures the pure helper's side output, and a fail-loud reason throws
          // ExitError from INSIDE the transform (readModifyWriteStateMd's finally
          // still releases the lock before the throw propagates; the transform
          // throws before returning new content, so nothing is ever written).
          let mutation;
          // #3356 defect 2: this write touches only the Quick Tasks body
          // table — a single appended row — so it must not trigger the
          // default full re-derive of the disk-derived `progress.*`
          // frontmatter block. `{ resync: false }` mirrors every other
          // body-only STATE.md writer's convention (src/state.cts's own
          // docstring on `readModifyWriteStateMd` prescribes it); this route
          // was the lone outlier still passing no options at all.
          state.readModifyWriteStateMd(statePath, (content) => {
            const result = appendQuickTaskRow(content, {
              description: qtaTask,
              date,
              commit,
              quickId: qtaQuickId,
              directory: qtaDirectory,
            });
            if (!result.ok) {
              // Mirrors fast.md's old "skip with a brief log" behaviour (#2133): this
              // is an expected, recoverable condition (no table / unrecognized
              // schema), not a hard crash. ExitError sets a non-zero exit code (so
              // fast.md's `|| echo ...` fallback fires) without calling
              // process.exit() directly — stdout stays flushed and untouched.
              throw new ExitError(1, `⚠ quick-tasks-append: ${result.reason}`);
            }
            mutation = result.value;
            return result.value.content;
          }, cwd, { resync: false });

          output({ ok: true, row: mutation.row, variant: mutation.variant }, raw, mutation.row);
  }

  /**
   * ADR-2782 Phase 5b (#2799) — the seam that lets `invoke_reviewers` iterate declared lanes.
   *
   * Replaces ~640 lines of hand-authored per-CLI bash with three subcommands:
   *   plan    --selected a,b   → resolved lanes (slug, section, availability) as JSON
   *   invoke  --slug X         → probe + run one lane, writing its review/stub into the run dir
   *   sections --selected a,b  → ordered `slug<TAB>reviewsSection`, for write_reviews
   *
   * Lanes run SEQUENTIALLY (the workflow loops and calls `invoke` once per lane) because the
   * original legs did — parallel invocation trips provider rate limits.
   */
  async function routeReviewLane({ args, cwd, raw, error }) {
    const cp = require('node:child_process');
    const fsx = require('node:fs');
    const os = require('node:os');
    const { REVIEWER_LANES, mergeReviewerLanes } = require('./lib/review-lane-descriptor.cjs');
    const { resolveLanePlan } = require('./lib/review-lane-invocation.cjs');
    const runner = require('./lib/review-lane-runner.cjs');
    const cfgLoader = require('./lib/config-loader.cjs');
    const capabilityLoader = require('./lib/capability-loader.cjs');

    const flag = (name) => {
      const i = args.indexOf(name);
      return i !== -1 && args[i + 1] && !String(args[i + 1]).startsWith('--') ? args[i + 1] : null;
    };
    const sub = args[1];
    // Fail fast on an unrecognized subcommand. Without this check, `sub` fell through
    // to the `sub !== 'invoke'` usage-error branch far below (after loading the
    // capability registry AND building a per-lane plan for every lane — which itself
    // spawns one child `query resolve-execution` process per lane via `effortFor`,
    // up to 12 subprocess spawns for the default lane set) before ever reporting the
    // error. That made an invalid subcommand slow instead of instant, and under bench
    // load (many sequential node spawns) `review-lane bogus` could exceed a caller's
    // spawn timeout and be killed before writing anything to stderr — the CI-observed
    // failure was empty stdout AND stderr, not the expected usage message (#3148).
    // `plan`/`invoke` are the only subs that need the expensive plan-building path
    // below; `sections`/`flags` return earlier still. Anything else errors here, before
    // any of that work starts.
    if (!['plan', 'invoke', 'sections', 'flags'].includes(sub)) {
      error("Usage: review-lane <plan|invoke|sections|flags> [--selected a,b] [--run-dir D] [--repo-root R]");
      return;
    }
    const runDir = flag('--run-dir') || '.';
    const repoRoot = flag('--repo-root') || cwd;

    // Resolved config, read ONCE. Reading in-process (rather than shelling out to config-get per
    // key, as the legs did) is what removes the stringly `"null"` sentinel the bash had to test for.
    // `loadConfigResolved` returns a PROVENANCE WRAPPER (`{config, source, degraded, reason}`),
    // not the config — using the wrapper directly silently resolves every key to undefined, which
    // reads exactly like "nothing configured" and drops every model override without an error.
    let resolved = {};
    try { resolved = (cfgLoader.loadConfigResolved(cwd) || {}).config || {}; } catch { resolved = {}; }
    const configGet = (key) => {
      let cur = resolved;
      for (const part of String(key).split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : undefined;
      }
      return cur;
    };

    const selected = (flag('--selected') || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    // ADR-2782 D8 (#2927): the lane map is first-party ∪ INSTALLED overlay
    // `reviewer` bodies, first-party winning on slug collision. Before this merge
    // the map was built from the frozen REVIEWER_LANES array alone, so an installed,
    // consented third-party reviewer lane was roster-visible (deriveReviewerSlugs)
    // and disclosed at install (collectReviewerLaneSurfaces) but never selectable,
    // plannable, or invocable — `sections`/`flags`/`plan`/`invoke` all consumed this
    // one map. The overlay body is field-identical to a ReviewerLane (ADR-2782 D1,
    // "no translation layer"), so `mergeReviewerLanes` is a pure merge, not a
    // projection. loadRegistry is TOTAL and never throws on a malformed overlay
    // (it skips the cap with a warning), and mergeReviewerLanes is total in turn,
    // so a bad third-party manifest cannot take the first-party lanes down with it.
    // `includeInstalled` is what merges project + global overlay caps into the
    // registry; without it the base is first-party-only and this is a no-op.
    let mergedLanes = REVIEWER_LANES;
    try {
      const registry = capabilityLoader.loadRegistry({ includeInstalled: true, cwd });
      mergedLanes = mergeReviewerLanes(REVIEWER_LANES, registry);
    } catch {
      // A registry load failure must never block first-party review. Degrade to the
      // static set — identical to pre-fix behavior — rather than crashing review-lane.
      mergedLanes = REVIEWER_LANES;
    }
    const laneBySlug = new Map(mergedLanes.map((l) => [l.slug, l]));
    const chosen = selected.length ? selected : mergedLanes.map((l) => l.slug);

    if (sub === 'sections') {
      const rows = chosen
        .map((s) => laneBySlug.get(s))
        .filter(Boolean)
        .map((l) => `${l.slug}\t${l.reviewsSection}`);
      process.stdout.write(rows.join('\n') + (rows.length ? '\n' : ''));
      return;
    }

    // Phase 6 (#2800, closes #2272). The reviewer-flag lists in
    // plan-review-convergence.md, autonomous.md and next.md were hand-enumerated in three places
    // and had drifted apart: `--coderabbit` was missing from all three and had been silently
    // falling back to `--codex`. One declared source, three consumers.
    //
    // Emits FLAGS, not slugs: `antigravity` declares two (`--antigravity`, `--agy`), so the flag
    // count (13) is deliberately not the lane count (12). Same output contract as `sections` —
    // one token per line, descriptor order, and no trailing newline on an empty result.
    if (sub === 'flags') {
      const rows = chosen
        .map((s) => laneBySlug.get(s))
        .filter(Boolean)
        .flatMap((l) => (Array.isArray(l.flags) ? l.flags : []))
        // Shape-filtered, not merely non-empty. All three consumers read this through an
        // UNQUOTED `$(gsd_run review-lane flags)` so the newline-separated output word-splits
        // into loop items — which is the intent. Phase 2 (#2795) admits third-party overlay
        // lanes into this same descriptor, so an overlay declaring `--foo bar` would inject a
        // second loop item, and one declaring a glob character would expand against the cwd.
        // Emitting only well-formed flags keeps that from reaching the shell at all.
        .filter((f) => typeof f === 'string' && /^--[a-z0-9][a-z0-9-]*$/.test(f));
      process.stdout.write(rows.join('\n') + (rows.length ? '\n' : ''));
      return;
    }

    // Effort argv is resolved per lane by the host's own execution policy, through the SAME
    // `resolve-execution` surface the bash legs used (`--host <slug>`), so the host's negotiated
    // effortSurface still decides whether an argument is emitted and the catalog still owns the
    // syntax (ADR-1239 #2481, ADR-443's escalation ladder). `cmdResolveExecution` writes to
    // stdout and exits, so it cannot be called in-process for a value — this spawns the same
    // bounded query the legs did, once per selected lane. A lane whose slug is not a known host
    // resolves to no effort argument at all.
    //
    // NOT `--raw` and NOT `--pick` (#2295). `--raw` prints only the resolved EFFORT ('low') with
    // no host-specific rendering at all. `--pick effort_argv_string` used to be the answer — the
    // rendered array re-joined into a string ('-c model_reasoning_effort=low') — but the caller
    // then had to `.split(/\s+/)` that string back apart to get an argv array, and re-splitting a
    // string the callee just joined is a lossy round trip: any argv element that legitimately
    // contains a space would come back split into two argv elements, corrupting the very argv it
    // was rendered to preserve. Reading the UNPICKED object instead gives both `effort_argv` (a
    // real string array, used verbatim, no re-splitting) and `effort_argv_value` (the bare level,
    // #2295's `plan.effort`) from the one spawn.
    const EMPTY_EFFORT = { argv: [], value: null };
    const effortFor = (slug) => {
      try {
        const r = cp.spawnSync(
          process.execPath,
          [__filename, 'query', 'resolve-execution', 'gsd-plan-checker', '--host', slug],
          { cwd, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
        );
        if (r.status !== 0) return EMPTY_EFFORT;
        let parsed;
        try {
          parsed = JSON.parse(String(r.stdout || ''));
        } catch { return EMPTY_EFFORT; }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_EFFORT;
        const argv = Array.isArray(parsed.effort_argv)
          ? parsed.effort_argv.filter((a) => typeof a === 'string' && a !== '')
          : [];
        const value = typeof parsed.effort_argv_value === 'string' && parsed.effort_argv_value
          ? parsed.effort_argv_value
          : null;
        return { argv, value };
      } catch { return EMPTY_EFFORT; }
    };

    /**
     * Per-lane prompt budget (#2797 semantics, preserved exactly).
     *
     * `-1` is the UNSET sentinel and falls back to the central `review.max_prompt_tokens`, because
     * `0` is a legitimate value meaning "do not trim this lane". Treating 0 as unset would silently
     * switch a user who deliberately disabled trimming onto the global budget.
     *
     * Only the budget VALUE is resolved here. Assembly and trimming stay in `prompt-budget`, which
     * already owns that machinery and is already tested; the workflow calls it and hands the
     * trimmed file back via `--prompt-file`. Re-implementing it inside the runner would fork a
     * tested surface for no gain.
     */
    const budgetFor = (lane) => {
      if (!lane.promptBudgetKey) return null;
      const per = configGet(lane.promptBudgetKey);
      const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
      if (isNum(per) && per !== -1) return per;
      const global = configGet('review.max_prompt_tokens');
      return isNum(global) ? global : null;
    };

    const plans = chosen.map((slug) => {
      const lane = laneBySlug.get(slug);
      if (!lane) return { slug, ok: false, reason: 'malformed_lane', detail: 'no such declared lane' };
      // Per-lane isolation. resolveLanePlan is documented total, but this map is the seam where a
      // single throw would take down EVERY selected lane rather than the one that is malformed —
      // and "a cross-AI review that silently drops a lane" is the failure this epic exists to end,
      // so losing all of them to one bad manifest is strictly worse. Belt and braces on purpose.
      let r;
      try {
        const effort = effortFor(slug);
        r = resolveLanePlan({ lane, configGet, runDir, repoRoot, effortArgs: effort.argv, effortValue: effort.value });
      } catch (e) {
        return { slug, ok: false, reason: 'malformed_lane', detail: `resolver threw: ${e && e.message ? e.message : String(e)}` };
      }
      return r.ok
        ? {
            slug,
            ok: true,
            section: lane.reviewsSection,
            transport: r.plan.transport,
            promptBudget: budgetFor(lane),
            promptPath: r.plan.transport === 'spawn' ? r.plan.stdin : r.plan.promptPath,
            plan: r.plan,
          }
        : { slug, ok: false, reason: r.reason, detail: r.detail };
    });

    if (sub === 'plan') {
      output(plans.map(({ plan, ...rest }) => rest), raw);
      return;
    }

    if (sub !== 'invoke') {
      error("Usage: review-lane <plan|invoke|sections|flags> [--selected a,b] [--run-dir D] [--repo-root R]");
      return;
    }

    const slug = flag('--slug');
    if (!slug) { error('review-lane invoke requires --slug'); return; }
    const entry = plans.find((p) => p.slug === slug);
    if (!entry || !entry.ok) {
      output({ slug, ok: false, reason: entry ? entry.reason : 'malformed_lane', detail: entry ? entry.detail : 'unknown lane' }, raw);
      return;
    }

    // EVERY spawn bounded — `DEFECT.UNBOUNDED-SUBPROCESS` (CONTEXT.md:772). A frozen sync spawn
    // cannot be interrupted by --test-force-exit and hangs a whole CI chunk to its 10-minute kill.
    const deps = {
      spawn: (binary, argv, opts) => {
        // #3086: on Windows, reviewer CLIs (gemini, codex, etc.) are installed
        // as .cmd shims. spawnSync with a bare name + shell:false fails with
        // ENOENT (CreateProcess cannot start .cmd). Apply the same #2667 shim
        // gate used in runWithTimeout: detect .cmd/.bat and mediate through
        // cmd.exe /d /s /c with an explicit argv array (no shell:true).
        //
        // #3275: descriptors declare BARE names, so the gate above never saw an
        // extension — resolve through the shared PATH+PATHEXT resolver FIRST
        // (the same one `hasBinary` uses, so probe and spawn can never disagree
        // about what the lane's binary is). POSIX keeps the bare name: Node's own
        // PATH search already worked there, and the #3275 acceptance contract
        // holds macOS/Linux behavior unchanged. A name that resolves to nothing
        // falls back to the declared name so the ENOENT still surfaces (#3086).
        // #3411: the resolve-then-mediate pair is one seam call now. Both halves had
        // private copies here; `projectSpawnInvocation` owns them, so a fix to either
        // reaches every spawn site instead of only this one.
        //
        // Unlike execTool, this lane adopts the RESOLVED path even for a non-batch
        // binary: that is the behavior #3445 shipped and `deps.hasBinary` answers
        // from the same resolver, so probe and spawn must agree on the exact file.
        const { projectSpawnInvocation } = require('./lib/shell-command-projection.cjs');
        const { command: spawnBinary, args: spawnArgv, windowsVerbatimArguments } = projectSpawnInvocation(binary, argv);
        const r = cp.spawnSync(spawnBinary, spawnArgv, {
          input: opts.input,
          encoding: 'utf8',
          timeout: opts.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024 * 1024,
          shell: false, // argv array only — never a shell string (no interpolation of config values)
          // #2483: a lane's declared env pairs merged OVER this process's environment, for this
          // child only. Passing a fresh object leaves `process.env` untouched, so nothing leaks
          // into the orchestrating session or into the next lane.
          ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
          ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
        return {
          status: r.status,
          stdout: r.stdout || '',
          stderr: r.stderr || '',
          errorCode: r.error && r.error.code ? r.error.code : undefined,
        };
      },
      httpJson: async (url, opts) => {
        try {
          const res = await fetch(url, {
            method: opts.method,
            headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
            body: opts.body,
            signal: AbortSignal.timeout(opts.timeoutMs),
          });
          return { ok: res.ok, status: res.status, body: await res.text() };
        } catch (e) {
          return { ok: false, status: 0, body: '', error: e && e.message ? e.message : String(e) };
        }
      },
      readFile: (p) => fsx.readFileSync(p, 'utf8'),
      writeFile: (p, c) => fsx.writeFileSync(p, c, 'utf8'),
      exists: (p) => fsx.existsSync(p),
      // PATH scan rather than spawning `command -v` / `where`. Two reasons: it spawns nothing at
      // all (a probe that costs a process is a probe you avoid running, which is how the original
      // Kimi probe ended up unbounded), and `shell: true` with an args array is deprecated in
      // Node 26 (DEP0190) because the arguments are concatenated rather than escaped.
      //
      // #3275: the scan lives in `resolveSpawnBinary` now, SHARED with `deps.spawn`
      // above. Two private copies of "what is this declared binary?" is how the
      // defect hid: the probe resolved WITH PATHEXT while spawn resolved WITHOUT,
      // so a lane reported available for a spawn that could never start. One
      // resolver, both seams — if one changes, the other changes with it.
      hasBinary: (name) => resolveSpawnBinary(name) !== null,
      configGet,
      homeDir: os.homedir(),
      warn: (m) => process.stderr.write(`${m}\n`),
    };

    // ADR-1517 reviewer instances resolve THROUGH a lane rather than being lanes themselves
    // (ADR-2782 D8), so they reuse this seam with three substitutions instead of duplicating the
    // lane's invocation. Everything the lane declares — probe, channels, timeout, empty-output
    // policy, handler — then applies to the instance unchanged, which is the whole reason to route
    // them here: a cross-cutting fix reaches instances for free.
    const asIdentity = flag('--as');
    const instanceModel = flag('--model');
    const instanceAgent = flag('--agent');

    if (asIdentity) {
      // Write under the INSTANCE name so two instances of one adapter never overwrite each other.
      const safe = String(asIdentity).replace(/[^A-Za-z0-9._-]/g, '-');
      entry.plan.reviewPath = `${runDir.replace(/\/+$/, '')}/gsd-review-${safe}.md`;
      entry.plan.errPath = `${runDir.replace(/\/+$/, '')}/gsd-review-${safe}.err`;
      if (entry.plan.transport === 'spawn' && entry.plan.outputTarget.kind === 'file') {
        // A file-arg lane names its output inside argv; retarget both together or the runner reads
        // the lane's file while the tool writes the instance's.
        const old = entry.plan.outputTarget.path;
        entry.plan.argv = entry.plan.argv.map((a) => (a === old ? entry.plan.reviewPath : a));
        entry.plan.outputTarget = { kind: 'file', path: entry.plan.reviewPath };
      }
    }

    // The instance's own model replaces whatever the lane resolved from config. Opaque
    // pass-through: it reaches the tool as one argv element and is never shell-interpolated.
    //
    // Done by RE-RESOLVING with an overridden config rather than by patching argv afterwards. A
    // post-hoc splice has to guess where the flag belongs when the lane resolved no model at all
    // (the placeholder expanded to nothing, so there is no position to find), and guessing puts it
    // before a subcommand — `opencode --model M run …`, the same defect the argv template exists to
    // prevent. Re-resolving lets the lane's own `{{model}}` placeholder decide the position.
    if (instanceModel) {
      const lane = laneBySlug.get(entry.slug);
      const key = lane && lane.modelConfigKey;
      // A lane that declares NO model key accepts no model override at all (`cursor`, `qwen`,
      // `coderabbit`). `review.reviewer_instances` validates that `cli` is a known slug but never
      // that the slug accepts a model, so a user can configure {"cli":"cursor","model":"gpt-5"},
      // get a clean config-set and a clean run, and never learn their model was ignored. Say so —
      // a review silently produced by a different model than the one configured is exactly the
      // "looked like it worked" failure this epic exists to end.
      if (!key) {
        process.stderr.write(
          `reviewer instance model '${instanceModel}' ignored: lane '${entry.slug}' accepts no ` +
          `model override (it declares no modelConfigKey). The review will use the CLI's own default.\n`,
        );
      }
      const instanceEffort = effortFor(entry.slug);
      const overridden = resolveLanePlan({
        lane,
        configGet: (k) => (key && k === key ? instanceModel : configGet(k)),
        runDir,
        repoRoot,
        effortArgs: instanceEffort.argv,
        effortValue: instanceEffort.value,
      });
      if (overridden.ok) {
        // Preserve any instance retargeting already applied above.
        const { reviewPath, errPath } = entry.plan;
        entry.plan = overridden.plan;
        if (asIdentity) {
          entry.plan.reviewPath = reviewPath;
          entry.plan.errPath = errPath;
          if (entry.plan.transport === 'spawn' && entry.plan.outputTarget.kind === 'file') {
            const old = entry.plan.outputTarget.path;
            entry.plan.argv = entry.plan.argv.map((a) => (a === old ? reviewPath : a));
            entry.plan.outputTarget = { kind: 'file', path: reviewPath };
          }
        }
      }
    }

    // `--agent` is OpenCode's native subagent flag and is honoured only by adapters that have the
    // concept; ignored elsewhere rather than passed to a tool that would reject it.
    if (instanceAgent && entry.slug === 'opencode' && entry.plan.transport === 'spawn') {
      const runIdx = entry.plan.argv.indexOf('run');
      const insertAt = runIdx === -1 ? 0 : runIdx + 1;
      entry.plan.argv = [
        ...entry.plan.argv.slice(0, insertAt),
        '--agent',
        instanceAgent,
        ...entry.plan.argv.slice(insertAt),
      ];
    }

    // `--prompt-file` lets the caller substitute a budget-trimmed prompt. Applied to whichever
    // channel this lane actually reads from, so one flag serves both transports.
    const promptOverride = flag('--prompt-file');
    if (promptOverride) {
      if (entry.plan.transport === 'spawn') {
        if (entry.plan.stdin) entry.plan.stdin = promptOverride;
      } else {
        entry.plan.promptPath = promptOverride;
      }
    }

    // ADR-2782 D5 rule 4: re-resolve the consented destination at INVOCATION. `undefined` (no
    // consent record, or a record predating rule 1) means "nothing to compare" and ALLOWS — a
    // first-party lane ships inside the SHA-pinned distribution and is never consent-gated, so
    // denying on absence would break every existing local-model user.
    let consentedHost;
    if (entry.plan.transport === 'openai-http') {
      try {
        const consent = require('./lib/capability-consent.cjs');
        const projectRoot = require('./lib/project-root.cjs').consentProjectRoot(cwd);
        // The capability id is kebab; the lane slug may be snake (lm_studio / lm-studio).
        const capId = String(entry.slug).replace(/_/g, '-');
        consentedHost = consent.readConsentedReviewerHost({ projectRoot, id: capId });
      } catch { consentedHost = undefined; }
    }

    const result = await runner.runLane(entry.plan, deps, {
      consentedHost,
      explicitlyRequested: args.includes('--explicit'),
      repoRoot,
    });
    output(result, raw);
  }

  function routeNormalizeTestCommand({ args, cwd, raw, error }) {
    // #1857: rewrite a resolved test command to a one-shot form so a
          // watch-mode runner (vitest/jest) cannot hang a verification gate. Shared
          // by the regression gate and the post-merge gate. args[1] is the raw
          // resolved command; --cwd (already parsed into `cwd`) locates package.json.
          const testCommandNormalizer = require('./lib/normalize-test-command.cjs');
          testCommandNormalizer.cmdNormalizeTestCommand(cwd, args[1]);
  }

  function routeDispatchShouldFlatten({ args, cwd, raw, error }) {
    // #1708 / #853: typed query replacing the `RUNTIME === 'codex'` prose rule.
          //
          // Resolves the current runtime (GSD_RUNTIME > config.runtime > per-install
          // .gsd-runtime marker > 'claude'),
          // looks up registry.runtimes[id].runtime.hostIntegration.dispatch, and
          // calls shouldFlattenDispatch(dispatch) from host-integration.cjs.
          //
          // Fail-closed: any unknown runtime, missing dispatch, or thrown error
          // yields `true` (inline — the always-safe default).
          //
          // Output:
          //   --raw   → prints exactly `true` or `false`
          //   --json  → prints { runtime, shouldFlatten, dispatch }
          //   default → same as --raw
          try {
            // Resolve runtime using the same precedence as `config-get runtime`.
            const { resolveRuntime } = require('./lib/runtime-slash.cjs');
            const runtimeId = resolveRuntime(cwd);

            // Look up dispatch from the capability registry.
            const registry = require('./lib/capability-registry.cjs');
            const runtimeEntry = registry.runtimes != null
              ? registry.runtimes[runtimeId]
              : null;
            const dispatch = runtimeEntry?.runtime?.hostIntegration?.dispatch ?? null;

            // Call shouldFlattenDispatch from host-integration.cjs.
            const hostIntegration = require('./lib/host-integration.cjs');
            const shouldFlat = dispatch !== null
              ? hostIntegration.shouldFlattenDispatch(dispatch)
              : true; // fail-closed: unknown runtime → inline

            const jsonIdx = args.indexOf('--json');
            if (jsonIdx !== -1) {
              output({
                runtime: runtimeId,
                shouldFlatten: shouldFlat,
                dispatch: dispatch,
              }, raw);
            } else {
              // --raw or default: print exactly true or false
              process.stdout.write(shouldFlat ? 'true' : 'false');
            }
          } catch {
            // Fail-closed on any error: inline is always safe.
            process.stdout.write('true');
          }
  }

  /**
   * #3737 — strict read of the project-level worktree opt-out from
   * `.planning/config.json`. True ONLY when `workflow.use_worktrees` is the
   * boolean `false`; an absent key, unreadable/malformed config, or any
   * non-boolean value (including the string "false") degrades to false —
   * worktrees are ON by default, so the degraded answer is "not opted out".
   * Direct file read, deliberately NOT loadConfig: this resolver backs
   * sentinel writes and must never trigger config normalization/rewrites
   * (same discipline as resolveDispatchIsolationDecision's resolveRuntime
   * comment above). Never throws.
   */
  function projectWorktreesOptedOut(cwd) {
    // #3972: single owner — planning-workspace's worktreesOptedOut ladder
    // (scoped own-key, root inheritance under the ws gate, strict === false).
    // Kept as a local name so routeDispatchIsolation's call sites read the
    // same as they did in #3938/#3963; the logic itself now lives beside
    // planningDir/planningRoot where every isolation surface can share it.
    try {
      const { worktreesOptedOut } = require('./lib/planning-workspace.cjs');
      return worktreesOptedOut(cwd);
    } catch {
      return false;
    }
  }

  function routeDispatchIsolation({ args, cwd, raw, error }) {
    // #2584 Phase 3 (#2627): typed query exposing the negotiated
    // `dispatch.isolation` to the execute-phase wave scheduler, so the
    // scheduler branches on a declared capability instead of on a runtime id.
    // Direct sibling of `dispatch-should-flatten` above, which exists (#1708 /
    // #853) for exactly this reason — it replaced a `RUNTIME === 'codex'`
    // prose rule.
    //
    // Resolves the current runtime (GSD_RUNTIME > config.runtime > per-install
    // .gsd-runtime marker > 'claude'),
    // reads registry.runtimes[id].runtime.hostIntegration.dispatch.isolation,
    // and validates it against the closed vocabulary.
    //
    // Fail-closed: unknown runtime, missing/undeclared/out-of-vocabulary value,
    // or any thrown error yields `none` — sequential execution, never an
    // unsafe parallel path (ADR-1239, "Fail-closed").
    //
    // Output:
    //   --raw   → prints exactly harness-worktree | orchestrator-worktree | none
    //   --json  → prints { runtime, isolation, exec }
    //   default → same as --raw
    //
    // `exec` is the resolved orchestratorExec argv/cwd shape, present only for
    // `orchestrator-worktree`. It requires `--cwd-target` (the GSD-created
    // worktree path) and optionally `--prompt`; without a target there is
    // nothing to bind, so `exec` is null.
    //
    // #3045 CORE REDESIGN: this is now the SOLE resolver of "what isolation
    // applies to this dispatch", and — as an unconditional side effect — it
    // PERSISTS that resolved decision (mode + harnessFlag + phase/plan
    // identifiers, written together in one atomic write) to the sentinel the
    // guard hooks read. Previously the sentinel was written by prose-gated
    // shell blocks in `executor-isolation-dispatch.md` that a model was told
    // to "read and run" — a prose-gated writer for a guard against
    // prose-gated values is the same defect class the guard exists to close.
    // The workflow MUST call this query to learn ISOLATION at all, so
    // recording here is structurally unskippable. `--phase`/`--plan` are
    // optional identifiers threaded through from the caller (workflow shell
    // variables); `--force-isolation <mode>` lets a caller that has
    // additional context this resolver cannot see (the #2474 per-plan
    // submodule intersection, computed in shell in
    // `per-plan-worktree-gate.md`) override the naturally-resolved mode
    // while still going through this single write path. Best-effort: a
    // sentinel write failure here must never fail the wave.
    const decision = resolveDispatchIsolationDecision({ args, cwd });
    const runtimeId = decision.runtimeId;
    let { isolation, exec, harnessFlag } = decision;

    // `--force-isolation <mode>` overrides the naturally-resolved mode with
    // context this resolver has no way to see on its own (e.g. the #2474
    // per-plan submodule intersection). Invalid/unrecognized values are
    // ignored rather than erroring — this is a best-effort recording call,
    // not a hard usage gate. Forcing to 'none' clears harnessFlag/exec since
    // neither applies to sequential dispatch.
    const forceIdx = args.indexOf('--force-isolation');
    const forcedIsolation = forceIdx !== -1 ? args[forceIdx + 1] : undefined;
    if (forcedIsolation && DISPATCH_ISOLATION_VOCABULARY.has(forcedIsolation)) {
      isolation = forcedIsolation;
      if (isolation === 'none') {
        harnessFlag = null;
        exec = null;
      }
    }

    const phaseIdx = args.indexOf('--phase');
    const phaseArg = phaseIdx !== -1 && args[phaseIdx + 1] && !args[phaseIdx + 1].startsWith('--')
      ? args[phaseIdx + 1]
      : null;
    const planIdx = args.indexOf('--plan');
    const planArg = planIdx !== -1 && args[planIdx + 1] && !args[planIdx + 1].startsWith('--')
      ? args[planIdx + 1]
      : null;

    // #3737: the project-level opt-out (workflow.use_worktrees === false) is
    // decided HERE, before the sentinel write — not only in the workflow
    // shell blocks that run after this resolve. Pre-fix, any plain re-query
    // (config re-read, wave transition, second plan dispatch) re-persisted
    // the naturally-resolved host capability over the `--force-isolation
    // none` record the dispatch-isolation reference mandates, and the guard
    // then denied the sequential dispatch the config explicitly asked for.
    // Applied AFTER --force-isolation so the documented rule holds: the
    // opt-out wins on every host, over both the natural resolution and any
    // force. Strict `=== false`: the default is worktrees ON, so an absent
    // key, an unreadable/malformed config, or a non-boolean value degrades
    // to "not opted out" (mirrors readConfigJsonBoolean's no-coercion
    // discipline in lib/init.cjs).
    if (projectWorktreesOptedOut(cwd)) {
      isolation = 'none';
      harnessFlag = null;
      exec = null;
    }

    // Side-effect write (#3045 CORE REDESIGN) — see the doc comment above.
    // Never allowed to affect this query's own stdout contract or throw.
    try {
      writeDispatchIsolationSentinel(cwd, { isolation, harnessFlag, phase: phaseArg, plan: planArg });
    } catch {
      // writeDispatchIsolationSentinel already swallows its own errors into
      // a { recorded: false } result; this catch is defense in depth only.
    }

    if (args.indexOf('--json') !== -1) {
      output({ runtime: runtimeId, isolation, exec, harnessFlag }, raw);
    } else {
      process.stdout.write(isolation);
    }
  }

  // #3714 follow-up — the dispatch seam gated only on PRESENCE of an explicit
  // pin, never on its VALUE, so an Anthropic-flavored global default
  // (~/.gsd/defaults.json model_overrides["gsd-executor"] = "sonnet"/"opus"/
  // "claude-*") reached `codex exec --model sonnet`: the documented #2310/
  // #2311 400 on a passive-posture host (ADR-1239/ADR-2313). It also let a
  // repo-committed .planning/config.json inject shell-hostile argv (a
  // `-c approval_policy=never` suffix, `$(...)`/`;` command injection,
  // embedded control characters) straight onto exec's argv.
  //
  // This mirrors — deliberately, not by re-derivation — the same VALUE
  // policy bin/install.js's generateCodexAgentToml() already applies to the
  // identical model_overrides["gsd-executor"] config key for the .toml
  // surface (bin/install.js ~3983-4046): trim; a whitespace-only value drops
  // silently (#3241, no warning); an Anthropic-flavored value
  // (isAnthropicFlavoredModel, single-sourced on bin/lib/model-catalog.cjs
  // per #3241 specifically so it cannot diverge across Codex-posture
  // surfaces) drops WITH a warning; a real pin survives verbatim. Two
  // additions beyond the .toml surface, both specific to this seam: the
  // 'inherit' sentinel (case/whitespace-insensitive) is a no-op here already
  // and must stay one, and a value that doesn't look like a model id at all
  // (the injection case above — the .toml surface never had to consider this
  // because TOML string-quoting isn't a shell argv boundary) is dropped with
  // a warning rather than ever reaching child_process argv.
  // Single source of truth for the model-id "allowed characters" notion
  // (#3714 follow-up — "Generative Fix Divergence"): the accept regex
  // (MODEL_ID_CHARSET_RE, used to ADMIT a pin) and the sanitizer keep-class
  // (MODEL_ID_SANITIZE_STRIP_RE, used to RENDER a rejected pin into a
  // warning) are both derived from this one character-class body so they
  // cannot drift apart again the way they already did once (the '@' added
  // for Vertex pins landed in the accept regex but not the sanitizer,
  // rendering "text-bison@002" as "text-bison?002" in the warning). '@' is
  // included for Vertex model-version pins ("text-bison@002",
  // "chat-bison@001"), which are legitimate model ids reachable through a
  // custom model_provider.
  // This body is interpolated raw into BOTH a positive character class
  // (MODEL_ID_CHARSET_RE, `[BODY]`) and a negated one
  // (MODEL_ID_SANITIZE_STRIP_RE, `[^BODY]`) below — only plain characters
  // and `x-y` ranges are safe here. A class metacharacter (`^`, `]`, `\`)
  // would mean different things in the two derived regexes if ever added.
  const MODEL_ID_CHARSET_BODY = 'A-Za-z0-9._:/@-';
  // The first character must be alphanumeric (#3714 hardening): a leading
  // '.', '_', ':', '/', or '@' has no legitimate model-id use case and, for
  // resolveOrchestratorExec's documented role as a GENERAL descriptor→argv
  // seam other hosts may adopt, a leading '@' or '/' is exactly the shape an
  // @-response-file or /-switch parser would key on. The leading-dash shape
  // is enforced separately by LEADING_DASH_RE below — it is NOT relaxed
  // here, since a flag-shaped value ("-c", "--config") must still fail the
  // resolver's own unsafe_leading_dash_model guard path via that dedicated
  // check, not this charset.
  const MODEL_ID_CHARSET_RE = new RegExp(`^[A-Za-z0-9][${MODEL_ID_CHARSET_BODY}]*$`);
  // Keep-class for sanitizing a REJECTED pin before it reaches the warning
  // (a guaranteed-reachable raw-to-TTY sink — the dispatch step runs with no
  // `2>` redirect). Built from the same MODEL_ID_CHARSET_BODY as the accept
  // regex above, so every character the matcher accepts also survives the
  // sanitizer unchanged, and a widened charset can never diverge from its
  // rendering again.
  //
  // This `g`-flagged instance is for internal `.replace()` use ONLY — a
  // `/g` regex is stateful (`.lastIndex` persists across calls) and
  // `.test()` on it alternates true/false/true across repeated calls on the
  // same string, a false-green trap for any test that reaches for `.test()`
  // instead of `.replace()`. To make that trap impossible rather than just
  // documenting it, this `g`-flagged object is never exported; the exported
  // `MODEL_ID_SANITIZE_STRIP_RE` below is a separate, non-global instance
  // built from the same body, safe for `.test()`/`.match()` in tests.
  const MODEL_ID_SANITIZE_STRIP_RE_G = new RegExp(`[^${MODEL_ID_CHARSET_BODY}]`, 'g');
  // Non-global companion of MODEL_ID_SANITIZE_STRIP_RE_G, exported for
  // tests. Do not use with `.replace()` on a value containing more than one
  // disallowed character — it only replaces the first match. Production
  // code must use the `g`-flagged instance above instead.
  const MODEL_ID_SANITIZE_STRIP_RE = new RegExp(`[^${MODEL_ID_CHARSET_BODY}]`);
  // A model id has no legitimate reason to be long; this also keeps a
  // pathological pin away from the Windows argv ceiling (execFileSync aborts
  // if argv > 32,767 chars — CLAUDE.md "Windows ARGV Overflow"). A pin over
  // this length is DROPPED WITH A WARNING like every other rejection, never
  // truncated into argv — a truncated model id is a different model id.
  const MODEL_ID_MAX_LENGTH = 200;
  const _dispatchModelPinDropWarned = new Set();
  function _warnDispatchModelPinDropped(agentName, rawValue, reason) {
    const key = `${agentName}::${rawValue}::${reason}`;
    if (_dispatchModelPinDropWarned.has(key)) return;
    _dispatchModelPinDropWarned.add(key);
    // Sanitize BEFORE truncating: every value that reaches this warning
    // failed the model-id charset test by definition (or, for the
    // over-length case, still only ever contains charset-legal bytes) —
    // sanitizing first catches raw control/escape bytes (ESC, BEL, CSI
    // sequences) using the identity-sanitizing pattern already used for
    // --as at gsd-tools.cjs:1526. Sanitizing before truncating also ensures
    // a truncated escape sequence can never survive (e.g. an SGR sequence
    // cut before its reset, leaving sticky terminal state) — truncation
    // only ever cuts already-safe characters.
    const sanitized = String(rawValue).replace(MODEL_ID_SANITIZE_STRIP_RE_G, '?');
    const safe = sanitized.length > 64 ? `${sanitized.slice(0, 64)}…` : sanitized;
    process.stderr.write(
      `gsd: warning — dispatch model pin for agent "${agentName}" (value "${safe}") ${reason}; ` +
      `dropping it so the spawned executor falls back to the session model.\n`,
    );
  }
  // A value starting with '-' (or '--') is a flag/option shape, not a model
  // id — `-c`, `--config`, `-`, `--`, `-p` are unsafe to hand to
  // resolveOrchestratorExec, whose own `unsafe_leading_dash_model` guard
  // rejects them and fails the WHOLE resolution to `{ ok: false }` ->
  // exec:null -> a FATAL wave abort (executor-isolation-dispatch.md:299-303),
  // even on hosts (e.g. kimi-code) that declare no modelFlag at all and
  // previously ignored the pin entirely. This check MUST run BEFORE
  // MODEL_ID_CHARSET_RE below: the charset is anchored to `[A-Za-z0-9]` at
  // the first character, so every dash-leading value already fails the
  // charset test and would otherwise be swallowed by the generic "unsafe
  // characters" message, losing the more specific and more actionable
  // flag/option diagnosis. Reject here, at the VALUE-policy layer, so a
  // leading-dash value degrades to "no model" like every other rejected
  // shape, instead of reaching a resolver whose failure mode is fatal
  // rather than a graceful drop.
  const LEADING_DASH_RE = /^-/;
  /**
   * Resolve the VALUE policy for an explicit dispatch model pin. `rawValue`
   * is whatever resolveAgentModelOverride(..., null) returned — a string
   * pin, the 'inherit' sentinel, or null/''/undefined for "no explicit pin".
   * Returns the trimmed model string to embed, or `undefined` to emit no
   * --model flag at all. Never throws; never fails closed to an error —
   * every rejection degrades to "no model" (drop-and-warn), matching the
   * documented desired behavior of falling back to the session model rather
   * than aborting the wave.
   */
  function resolveDispatchModelPin(agentName, rawValue) {
    if (typeof rawValue !== 'string') return undefined; // not a string -> no model
    const trimmed = rawValue.trim();
    if (trimmed === '') return undefined; // whitespace-only -> no model, no warning (#3241)
    if (trimmed.toLowerCase() === 'inherit') return undefined; // sentinel -> no model, no warning
    const { isAnthropicFlavoredModel } = require('./lib/model-catalog.cjs');
    if (isAnthropicFlavoredModel(trimmed)) {
      _warnDispatchModelPinDropped(agentName, rawValue, 'is an Anthropic-flavored model/alias, not a valid Codex model');
      return undefined;
    }
    if (LEADING_DASH_RE.test(trimmed)) {
      _warnDispatchModelPinDropped(agentName, rawValue, 'looks like a flag/option, not a model id (leading "-")');
      return undefined;
    }
    if (!MODEL_ID_CHARSET_RE.test(trimmed)) {
      _warnDispatchModelPinDropped(agentName, rawValue, 'does not look like a model id (unsafe characters)');
      return undefined;
    }
    if (trimmed.length > MODEL_ID_MAX_LENGTH) {
      _warnDispatchModelPinDropped(agentName, rawValue, `exceeds the maximum model id length (${MODEL_ID_MAX_LENGTH} characters)`);
      return undefined;
    }
    return trimmed;
  }

  const DISPATCH_ISOLATION_VOCABULARY = new Set(['harness-worktree', 'orchestrator-worktree', 'none']);

  /**
   * Shared, side-effect-free resolution of the negotiated dispatch isolation:
   * runtime (GSD_RUNTIME > config.runtime > per-install .gsd-runtime marker >
   * 'claude') → declared
   * `dispatch.isolation` → harness-flag / orchestrator-exec degrade rules.
   * Extracted (#2486) so `routeDispatchIsolation` (the #3045 recording
   * dispatch path) and `routeInspectDispatchIsolation` (the read-only
   * inspection path) share exactly one negotiation implementation and cannot
   * drift apart. Resolution only — the caller decides whether the decision is
   * recorded to the sentinel.
   */
  function resolveDispatchIsolationDecision({ args, cwd }) {
    let isolation = 'none';
    let runtimeId = null;
    let exec = null;
    let harnessFlag = null;
    try {
      // Deliberately `resolveRuntime`, NOT `resolveActiveRuntime`/`loadConfig`:
      // loadConfig normalizes and rewrites legacy keys back to disk, and this
      // resolver backs the sentinel-free `inspect-dispatch-isolation` verb,
      // which must never write. resolveRuntime reads config.json directly.
      //
      // KNOWN LIMITATION, tracked separately: resolveRuntime stops at
      // GSD_RUNTIME > config.runtime > 'claude' and does not consult the
      // per-install `.gsd-runtime` marker, so on a non-Claude install whose
      // project config carries no `runtime` key this resolves 'claude'. That is
      // open-gsd/gsd-core#2395 — a pre-existing defect in the canonical
      // resolver, not introduced here, and deliberately NOT fixed in this PR
      // (its blast radius reaches every consumer of that resolver, so it is
      // being handled on its own).
      const { resolveRuntime } = require('./lib/runtime-slash.cjs');
      runtimeId = resolveRuntime(cwd);

      const registry = require('./lib/capability-registry.cjs');
      const runtimeEntry = registry.runtimes != null
        ? registry.runtimes[runtimeId]
        : null;
      const declared = runtimeEntry?.runtime?.hostIntegration?.dispatch?.isolation ?? null;
      if (typeof declared === 'string' && DISPATCH_ISOLATION_VOCABULARY.has(declared)) {
        isolation = declared;
      }

      if (isolation === 'harness-worktree') {
        const declaredFlag = runtimeEntry?.runtime?.harnessIsolationFlag ?? null;
        // A host claiming harness isolation with no declared flag gives the
        // scheduler nothing to pass — degrade to sequential rather than
        // dispatch unisolated executors believing they are isolated.
        if (typeof declaredFlag === 'string' && declaredFlag.length > 0) {
          harnessFlag = declaredFlag;
        } else {
          isolation = 'none';
        }
      }

      if (isolation === 'orchestrator-worktree') {
        const cwdIdx = args.indexOf('--cwd-target');
        const cwdTarget = cwdIdx !== -1 ? args[cwdIdx + 1] : '';
        if (cwdTarget) {
          const promptIdx = args.indexOf('--prompt');
          const promptArg = promptIdx !== -1 ? args[promptIdx + 1] : undefined;
          const hostIntegration = require('./lib/host-integration.cjs');
          // #3714: resolve an EXPLICIT, non-sentinel per-agent model pin for the
          // spawned worktree executor. Passing `null` as the runtime resolver
          // (3rd arg) is LOAD-BEARING, not an oversight — it is what keeps
          // profile/tier-derived models out of argv. Codex's `modelMode: passive`
          // posture (ADR-1239) and ADR-2313 forbid GSD driving model selection on
          // this host; only an operator's EXPLICIT override may cross this seam.
          // resolveAgentModelOverride(..., null) returns a value ONLY when the
          // operator pinned one explicitly (measured: unpinned -> null,
          // "inherit" -> "inherit" meaning "use the ambient session model, don't
          // pass a flag", "" -> null, profile-only -> null). Do NOT swap in
          // resolve-model / a full model-resolver here: that resolver falls back
          // to a default (e.g. "sonnet") for the unpinned/profile-only cases,
          // and emitting that on Codex's exec argv is exactly the documented
          // #2310/#2311 regression (a model unknown to Codex forced into a
          // passive-posture host).
          //
          // Presence of a pin is necessary but not sufficient: resolveDispatchModelPin
          // applies the same VALUE policy the install-side .toml surface already
          // applies to this config key (trim / drop-inherit / drop-Anthropic-flavored
          // with a warning / drop-non-model-id-charset with a warning) so a global
          // Anthropic-flavored default or an injected config value never reaches argv.
          //
          // This whole VALUE policy — including its warning — is gated on the
          // resolved runtime's descriptor actually declaring a non-empty
          // `modelFlag`. The policy runs at this host-NEUTRAL site, so a host
          // with no modelFlag at all (kimi, kimi-code, opencode) was never
          // going to emit a --model regardless of the pin's value; running the
          // policy anyway produced a stderr warning claiming "dropping it so
          // the spawned executor falls back to the session model" on every
          // dispatch for such a host — misleading today, and actively wrong if
          // a Claude-capable host ever declares a modelFlag. When the
          // descriptor declares no modelFlag, skip the policy entirely: no
          // model, no warning, argv byte-identical to before this pin policy
          // existed.
          const declaresModelFlag = typeof runtimeEntry?.runtime?.orchestratorExec?.modelFlag === 'string' &&
            runtimeEntry.runtime.orchestratorExec.modelFlag.length > 0;
          let model;
          if (declaresModelFlag) {
            const { readGsdEffectiveModelOverrides, resolveAgentModelOverride } =
              require('./lib/install-model-override-resolver.cjs');
            const pinned = resolveAgentModelOverride(
              'gsd-executor', readGsdEffectiveModelOverrides(cwd), null);
            model = resolveDispatchModelPin('gsd-executor', pinned);
          }
          const resolution = hostIntegration.resolveOrchestratorExec(
            runtimeEntry?.runtime?.orchestratorExec,
            cwdTarget,
            promptArg,
            model,
          );
          // A host declaring orchestrator-worktree whose exec descriptor does not
          // resolve halts THIS wave's dispatch: isolation is forced to 'none' here,
          // and executor-isolation-dispatch.md:299-303 treats a null exec as FATAL
          // (exit 1) after the worktree has already been created — it does not
          // degrade to sequential execution. resolveDispatchModelPin rejects any
          // leading-dash value (flag/option shape) before it ever reaches this
          // resolver specifically so it cannot trip the resolver's own
          // `unsafe_leading_dash_model` guard and turn a bad config value into
          // this fatal path; every other unresolvable model value likewise
          // degrades to "no --model" (session model fallback) rather than to
          // resolution.ok === false.
          if (resolution.ok) {
            exec = { command: resolution.command, args: resolution.args, cwd: resolution.cwd };
          } else {
            isolation = 'none';
          }
        }
      }
    } catch {
      isolation = 'none';
      exec = null;
      harnessFlag = null;
    }
    return { runtimeId, isolation, exec, harnessFlag };
  }

  function routeInspectDispatchIsolation({ args, cwd, raw }) {
    // #2486: sentinel-free sibling of `dispatch-isolation` for INSPECTION
    // surfaces — /gsd:health's W025 check and /gsd:settings' Worktrees
    // branching. The dispatch verb above intentionally records its resolved
    // decision to the isolation sentinel as an unconditional side effect
    // (#3045 CORE REDESIGN): correct for executor dispatch, where the record
    // must be structurally unskippable — but wrong for a read-only
    // diagnostic. A health check that records a phase:null/plan:null
    // sentinel can hard-block every executor dispatch for the sentinel's
    // lifetime, across sessions sharing the main checkout. Inspection
    // surfaces call this verb instead. Two claims, both narrower than
    // "side-effect-free", and both exactly true (#2486 review, Majors 2 & 4):
    //
    //  1. SENTINEL-FREE, not write-free. This route writes nothing itself, and
    //     in particular never writes .gsd/dispatch-isolation-sentinel.json —
    //     the only write that can hard-block a later executor dispatch. It is
    //     NOT an unconditional claim of total filesystem purity: like every
    //     gsd-tools invocation, it runs the shared bootstrap and
    //     active-workstream resolution first. As of #3579's root-cause fix
    //     that bootstrap resolves via the non-mutating peekActiveWorkstream
    //     (never unlinks); an actual stale/invalid pointer is still
    //     self-healed, but only by whichever verb's own getActiveWorkstream
    //     call later consumes it for real — this inspection route makes no
    //     such call, so it is now also side-effect-free on the pointer file.
    //
    //  2. SHARED NEGOTIATION, for the arguments this verb accepts. Both verbs
    //     call resolveDispatchIsolationDecision, so the natural resolution
    //     cannot drift. It is NOT a claim of byte-identical output for every
    //     argv: routeDispatchIsolation applies --force-isolation AFTER the
    //     shared helper returns, so the same argv could otherwise yield
    //     'none' there and the declared capability here. Rather than let a
    //     caller receive a silently different answer, this verb REJECTS the
    //     recording-only knobs outright — they exist to be recorded, and a
    //     read has nothing to record.
    const RECORDING_ONLY_ARGS = ['--force-isolation', '--phase', '--plan'];
    const rejected = RECORDING_ONLY_ARGS.filter((flag) => args.indexOf(flag) !== -1);
    if (rejected.length > 0) {
      error(
        `inspect-dispatch-isolation: ${rejected.join(', ')} ${rejected.length === 1 ? 'is a' : 'are'} recording-only argument${rejected.length === 1 ? '' : 's'} and cannot be used on the inspection verb — it resolves the runtime's DECLARED capability and records nothing. Use 'query dispatch-isolation' if you need the override applied and the decision recorded.`,
        ERROR_REASON.USAGE,
      );
    }
    const { runtimeId, isolation, exec, harnessFlag } = resolveDispatchIsolationDecision({ args, cwd });
    if (args.indexOf('--json') !== -1) {
      output({ runtime: runtimeId, isolation, exec, harnessFlag }, raw);
    } else {
      process.stdout.write(isolation);
    }
  }

  /**
   * Atomically persist the resolved dispatch-isolation decision to the
   * run-scoped sentinel both isolation guard hooks read
   * (hooks/gsd-agent-isolation-guard.js, hooks/gsd-cursor-subagent-start.js;
   * shared reader hooks/lib/isolation-sentinel.js). Extracted so
   * `routeDispatchIsolation` (the #3045 CORE REDESIGN primary write path)
   * and `routeRecordDispatchIsolation` (the explicit verb, kept for the
   * per-plan degrade call site and back-compat/tests) share exactly one
   * write implementation. Never throws — returns `{ recorded, path, error? }`.
   */
  function writeDispatchIsolationSentinel(cwd, { isolation, harnessFlag = null, phase = null, plan = null }) {
    const nodePath = require('path');
    const nodeFs = require('fs');
    const sentinelDir = nodePath.join(cwd, '.gsd');
    const sentinelPath = nodePath.join(sentinelDir, 'dispatch-isolation-sentinel.json');
    const payload = {
      isolation,
      harness_flag: harnessFlag || null,
      phase: phase || null,
      plan: plan || null,
      written_at: Date.now(),
    };
    try {
      nodeFs.mkdirSync(sentinelDir, { recursive: true });
      // Atomic write: unique temp file + rename, so a concurrent reader (a
      // guard hook firing mid-write) never observes a partially-written
      // sentinel. Unique per-process+time so concurrent orchestrator-worktree
      // invocations sharing the same sentinelDir never collide on the temp name.
      const tmpPath = `${sentinelPath}.tmp-${process.pid}-${Date.now()}`;
      nodeFs.writeFileSync(tmpPath, JSON.stringify(payload));
      nodeFs.renameSync(tmpPath, sentinelPath);
      return { recorded: true, path: '.gsd/dispatch-isolation-sentinel.json' };
    } catch (err) {
      return { recorded: false, path: '.gsd/dispatch-isolation-sentinel.json', error: err && err.message };
    }
  }

  function routeRecordDispatchIsolation({ args, cwd, raw, error }) {
    // #3045: `routeDispatchIsolation` (the `dispatch-isolation` query) is now
    // the PRIMARY write path for the sentinel (CORE REDESIGN) — it records
    // as an unconditional side effect of resolving ISOLATION, which the
    // workflow must call to learn the value at all. This verb remains as an
    // explicit fallback for callers that resolve isolation through some
    // other means (or need to force a specific value, e.g. a caller with no
    // access to `--force-isolation` context) and for direct test coverage of
    // the write primitive. Both verbs share exactly one write implementation
    // (`writeDispatchIsolationSentinel`) so there is only one atomic-write
    // code path to reason about.
    //
    // Best-effort: a write failure here must never fail the workflow — the
    // guard hooks' own sentinel-absent path degrades to a conservative
    // registry+config check, so a missing sentinel is safe, just less precise.
    //
    // Output: { recorded: true|false, path, error? }
    const VALID_ISOLATION = new Set(['harness-worktree', 'orchestrator-worktree', 'none']);
    const isoIdx = args.indexOf('--isolation');
    const isolation = isoIdx !== -1 ? args[isoIdx + 1] : undefined;
    if (!isolation || !VALID_ISOLATION.has(isolation)) {
      error(
        'Usage: record-dispatch-isolation --isolation <harness-worktree|orchestrator-worktree|none> ' +
        '[--harness-flag <flag>|--harness-flag=<flag>] [--phase <n>] [--plan <id>]',
        ERROR_REASON.USAGE,
      );
      return;
    }
    // #3045 MAJOR: the space-separated form rejects any value starting with
    // `--` (to avoid swallowing a missing value followed by another flag),
    // but that is exactly the shape of Cursor's real `harnessIsolationFlag`
    // — it declares the bare CLI flag `--worktree`
    // (gsd-core/bin/lib/capability-registry.cjs), which could therefore
    // never be persisted. (Windsurf declares NO `harnessIsolationFlag` at
    // all — its `hostIntegration.dispatch.isolation` is `none`; per
    // ADR-1239 it "genuinely cannot benefit" from worktree isolation
    // because it lacks named/concurrent subagent dispatch, so this is not a
    // gap to close for Windsurf.) The `--harness-flag=<value>` equals form
    // (mirrors the `--cwd=<path>` convention already used by this
    // dispatcher's top-level arg parsing above) carries the value
    // unambiguously and is never subject to that guard — any future runtime
    // whose registered flag happens to be bare-CLI-shaped benefits the same
    // way Cursor's does.
    let harnessFlag = null;
    const flagEqArg = args.find((a) => a.startsWith('--harness-flag='));
    if (flagEqArg) {
      const value = flagEqArg.slice('--harness-flag='.length);
      harnessFlag = value.length > 0 ? value : null;
    } else {
      const flagIdx = args.indexOf('--harness-flag');
      harnessFlag = flagIdx !== -1 && args[flagIdx + 1] && !args[flagIdx + 1].startsWith('--')
        ? args[flagIdx + 1]
        : null;
    }
    const phaseIdx = args.indexOf('--phase');
    const phase = phaseIdx !== -1 && args[phaseIdx + 1] && !args[phaseIdx + 1].startsWith('--')
      ? args[phaseIdx + 1]
      : null;
    const planIdx = args.indexOf('--plan');
    const plan = planIdx !== -1 && args[planIdx + 1] && !args[planIdx + 1].startsWith('--')
      ? args[planIdx + 1]
      : null;

    const result = writeDispatchIsolationSentinel(cwd, { isolation, harnessFlag, phase, plan });
    output(result, raw);
  }

  function routeResolveDispatchType({ args, cwd, raw, error }) {
    // #2508 Phase 4 Option A: resolve a requested GSD subagent name to the
           // type an Agent() call should use on the current runtime. On
           // named-dispatch runtimes (Claude, OpenCode, …) the name is returned
           // unchanged; on built-in-only runtimes (kimi-code) it maps to the
           // closest built-in (coder/explore/plan) by role-suffix heuristic.
           // The persona rides ${AGENT_SKILLS_*} (Phase 3 / #2510) regardless.
           //
           // Output:
           //   --raw (default) → prints the resolved type (e.g. "gsd-planner" or "plan")
           //   --json          → prints { runtime, requested, resolved, dispatch }
           try {
             const requestedIdx = args.indexOf('--requested');
             const requested = requestedIdx !== -1 ? args[requestedIdx + 1] : '';
             const { resolveRuntime } = require('./lib/runtime-slash.cjs');
             const runtimeId = resolveRuntime(cwd);
             const registry = require('./lib/capability-registry.cjs');
             const runtimeEntry = registry.runtimes != null
               ? registry.runtimes[runtimeId]
               : null;
             const dispatch = runtimeEntry?.runtime?.hostIntegration?.dispatch ?? null;
             const hostIntegration = require('./lib/host-integration.cjs');
             const resolved = hostIntegration.resolveDispatchType(requested, dispatch);
             const jsonIdx = args.indexOf('--json');
             if (jsonIdx !== -1) {
               output({ runtime: runtimeId, requested, resolved, dispatch }, raw);
             } else {
               process.stdout.write(String(resolved));
             }
           } catch {
             // Fail-closed: on any error, echo the requested name unchanged
             // (named-dispatch is the GSD default; degrading to it preserves
             // behavior for every runtime already in the field).
             const requestedIdx = args.indexOf('--requested');
             const requested = requestedIdx !== -1 ? args[requestedIdx + 1] : '';
             process.stdout.write(String(requested));
           }
  }

  function routeResolveAgent({ args, cwd, raw, error }) {
    // #1689: resolve a per-plan agent_hint specialist name to the subagent_type
           // an Agent() call should use. Returns the name unchanged when a
           // matching agent file exists in the active runtime's agent dir(s);
           // 'gsd-executor' when the name is absent, blank, or does not resolve.
           // Fail-closed is the fallback (gsd-executor) — never echo an
           // unvalidated name, which would make Agent() error and block the wave.
           //
           // Output:
           //   --raw (default) -> prints the resolved type (the hint, or 'gsd-executor')
           //   --json          -> prints { runtime, requested, resolved, fallback }
    const FALLBACK = 'gsd-executor';
    try {
      const nameIdx = args.indexOf('--name');
      const requested = nameIdx !== -1 ? args[nameIdx + 1] : '';
      const { resolveRuntime } = require('./lib/runtime-slash.cjs');
      const runtimeId = resolveRuntime(cwd);
      const { resolveAgentHint } = require('./lib/agent-install-check.cjs');
      let resolved = FALLBACK;
      let resolvedOk = false; // true only when resolveAgentHint returned a hit
      if (requested && !requested.startsWith('-')) {
        const hit = resolveAgentHint(requested, runtimeId, cwd);
        if (hit !== null) {
          resolved = hit;
          resolvedOk = true;
        }
      }
      // `fallback` = we did NOT honor a resolvable hint (absent/flag-shaped name,
      // the named agent did not resolve, or resolution errored). Requesting
      // gsd-executor explicitly and resolving to it is NOT a fallback.
      const fellBack = !resolvedOk;
      const jsonIdx = args.indexOf('--json');
      if (jsonIdx !== -1) {
        output({ runtime: runtimeId, requested: requested || null, resolved, fallback: fellBack }, raw);
      } else {
        process.stdout.write(String(resolved));
      }
    } catch {
      // Fail-closed: degrade to the legacy executor on any error so dispatch
      // never blocks on resolution.
      process.stdout.write(FALLBACK);
    }
  }

  function routeAgentSkills({ args, cwd, raw, error }) {
    // --json emits typed IR { agent_type, block, skills_count } for test assertions
          // (#455). Default (no flag) outputs raw XML so workflow shell expansions work.
          const jsonIdx = args.indexOf('--json');
          const agentSkillsJsonMode = jsonIdx !== -1;
          if (agentSkillsJsonMode) args.splice(jsonIdx, 1);
          init.cmdAgentSkills(cwd, args[1], raw, agentSkillsJsonMode);
  }

  function routeSkillManifest({ args, cwd, raw, error }) {
    init.cmdSkillManifest(cwd, args, raw);
  }

  function routeHistoryDigest({ args, cwd, raw, error }) {
    commands.cmdHistoryDigest(cwd, raw);
  }

  function routePhases({ args, cwd, raw, error }) {
    routePhasesCommand({
            phase,
            milestone,
            args,
            cwd,
            raw,
            error,
          });
  }

  function routeAssumptionDelta({ args, cwd, raw, error }) {
    // #1561 — advisory architecture checkpoint. `scan <phase>` reads the
          // phase section via the same resolver as roadmap.get-phase and runs the
          // deterministic detectAssumptionDelta, emitting the typed IR as JSON.
          const sub = args[1];
          if (sub === 'scan') {
            const phaseNum = args[2];
            // Reject missing or flag-shaped phase values (QA matrix: values that
            // look like flags). `scan --json` must not treat "--json" as a phase.
            if (!phaseNum || phaseNum.startsWith('-')) {
              error('Usage: assumption-delta scan <phase> [--terms <csv>]', ERROR_REASON.SDK_UNKNOWN_COMMAND);
              return;
            }
            // Optional --terms <csv> override (replaces the pluralization cues;
            // optional/chosen keep defaults). An EMPTY value ("") or a flag-shaped
            // value restores the curated defaults (does NOT disable pluralization).
            // Terms are normalized (deduped, alphanumeric-only, capped) by
            // detectAssumptionDelta's resolveTerms.
            let termsOverride;
            const termsIdx = args.indexOf('--terms');
            const termsVal = termsIdx !== -1 ? args[termsIdx + 1] : undefined;
            if (typeof termsVal === 'string' && !termsVal.startsWith('-')) {
              const list = termsVal
                .split(',')
                .map((t) => t.trim().toLowerCase())
                .filter((t) => t.length > 0);
              termsOverride = list.length > 0 ? { pluralization: list } : undefined;
            }
            // An unresolvable phase section is not a negative verdict. Feeding
            // `''` to the detector reported "examined, found nothing" for a
            // probe that never had input — no ROADMAP.md, or a phase number
            // absent from it, both read as a confident `detected:false`
            // (ADR-3889 failure class (c), #3909). Exit stays 0: this is an
            // ADR-2980 degraded result carried in the payload, and ADR-3889 P8
            // pins the gsd-tools exit projection at v1.
            const section = roadmap.getRoadmapPhaseWithFallback(cwd, phaseNum);
            if (typeof section !== 'string' || section.trim() === '') {
              output({ skipped: true, reason: 'phase_unresolved' }, raw);
              return;
            }
            const result = detectAssumptionDelta(section, termsOverride);
            output(result, raw);
            return;
          }
          error(`Unknown assumption-delta subcommand: ${sub}. Available: scan`, ERROR_REASON.SDK_UNKNOWN_COMMAND);
  }

  function routeRequirements({ args, cwd, raw, error }) {
    const subcommand = args[1];
          if (subcommand === 'mark-complete') {
            milestone.cmdRequirementsMarkComplete(cwd, args.slice(2), raw);
          } else if (subcommand === 'ready-ids') {
            // #2388: read-only shared-ID gate — computes which of the given
            // requirement IDs are safe to hand to mark-complete right now
            // (no sibling *-PLAN.md in the same phase dir still missing its
            // *-SUMMARY.md for that ID).
            milestone.cmdRequirementsReadyIds(cwd, args.slice(2), raw);
          } else if (subcommand === 'revert-phase') {
            // #2388: gaps_found-only revert — flips this phase's own
            // requirement IDs back out of Complete (checkbox + traceability
            // row) before the gap report renders.
            milestone.cmdRequirementsRevertPhase(cwd, args.slice(2), raw);
          } else {
            error('Unknown requirements subcommand. Available: mark-complete, ready-ids, revert-phase', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeGapAnalysis({ args, cwd, raw, error }) {
    // Post-planning gap checker (#2493) — unified REQUIREMENTS.md +
          // CONTEXT.md <decisions> coverage report against PLAN.md files.
          gapChecker.cmdGapAnalysis(cwd, args.slice(1), raw);
  }

  function routeMilestone({ args, cwd, raw, error }) {
    const subcommand = args[1];
          if (subcommand === 'complete') {
            const milestoneName = parseMultiwordArg(args, 'name');
            // #1871: archive phase dirs by default on milestone complete so the next
            // new-milestone never inherits un-archived dirs. --no-archive-phases opts out.
            const archivePhases = !args.includes('--no-archive-phases');
            const force = args.includes('--force');
            // #2118: --dry-run prints a preview plan without mutating.
            const dryRun = args.includes('--dry-run');
            // #2142: quick-task archival is opt-in (default OFF) — unlike
            // --no-archive-phases' inverted shape, absence of this flag means
            // "do nothing" rather than "skip a default-on behavior".
            const archiveQuick = args.includes('--archive-quick');
            // #3726: explicit mutation opt-in — without --confirm (and without
            // --dry-run) the command refuses before touching anything. Distinct
            // from --force, which bypasses the narrow scope guards only.
            const confirm = args.includes('--confirm');
            milestone.cmdMilestoneComplete(cwd, args[2], { name: milestoneName, archivePhases, force, dryRun, archiveQuick, confirm }, raw);
          } else if (subcommand === 'archive-quick') {
            // #2142 escalation: narrow archival-only entry point (does NOT
            // touch ROADMAP/REQUIREMENTS/MILESTONES.md, runs no completion
            // guards) — safe to call against an already-completed milestone,
            // unlike `milestone complete --archive-quick`.
            const dryRun = args.includes('--dry-run');
            milestone.cmdQuickArchive(cwd, args[2], { dryRun }, raw);
          } else {
            error('Unknown milestone subcommand. Available: complete, archive-quick', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeProgress({ args, cwd, raw, error }) {
    const subcommand = args[1] || 'json';
          commands.cmdProgressRender(cwd, subcommand, raw);
  }

  function routeUat({ args, cwd, raw, error }) {
    const subcommand = args[1];
          if (subcommand === 'render-checkpoint') {
            const uat = require('./lib/uat.cjs');
            const options = parseNamedArgsOrExit(args, { valueFlags: ['file'], positionals: 2 }, error);
            uat.cmdRenderCheckpoint(cwd, options, raw);
          } else if (subcommand === 'classify-coverage') {
            const coverage = require('./lib/coverage.cjs');
            const options = parseNamedArgsOrExit(args, { valueFlags: ['summary', 'file'], positionals: 2 }, error);
            coverage.cmdClassify(cwd, options, raw);
          } else {
            error('Unknown uat subcommand. Available: render-checkpoint, classify-coverage', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeStats({ args, cwd, raw, error }) {
    const subcommand = args[1] || 'json';
          commands.cmdStats(cwd, subcommand, raw);
  }

  function routeTodo({ args, cwd, raw, error }) {
    const subcommand = args[1];
          if (subcommand === 'complete') {
            commands.cmdTodoComplete(cwd, args[2], raw);
          } else if (subcommand === 'match-phase') {
            commands.cmdTodoMatchPhase(cwd, args[2], raw);
          } else {
            error('Unknown todo subcommand. Available: complete, match-phase', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeScaffold({ args, cwd, raw, error }) {
    const scaffoldType = args[1];
          // `--name` is multi-word (consumed separately by parseMultiwordArg,
          // below) — a token count the single-token-per-flag boundary walk
          // cannot represent. `positionals: 'rest'` disables that walk for
          // this call, matching the existing (unchanged) permissive behavior
          // for --name; --phase extraction is unaffected either way.
          const scaffoldOptions = {
            phase: parseNamedArgsOrExit(args, { valueFlags: ['phase'], positionals: 'rest' }, error).phase,
            name: parseMultiwordArg(args, 'name'),
          };
          commands.cmdScaffold(cwd, scaffoldType, scaffoldOptions, raw);
  }

  function routeLoop({ args, cwd, raw, error }) {
    // loop render-hooks <point>
          const loopSubcommand = args[1];
          if (loopSubcommand === 'render-hooks') {
            let loopConfigDir = null;
            const configDirEqArg = args.find(arg => arg.startsWith('--config-dir='));
            const configDirIdx = args.indexOf('--config-dir');
            if (configDirEqArg) {
              const value = configDirEqArg.slice('--config-dir='.length).trim();
              if (!value) error('Missing value for --config-dir', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
              loopConfigDir = value;
            } else if (configDirIdx !== -1) {
              const value = args[configDirIdx + 1];
              if (!value || value.startsWith('--')) {
                error('Missing value for --config-dir', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
              }
              loopConfigDir = value;
            }
            // --active-cap <capId>: parse and validate before delegating
            let loopActiveCap = undefined;
            const activeCapEqArg = args.find(arg => arg.startsWith('--active-cap='));
            const activeCapIdx = args.indexOf('--active-cap');
            if (activeCapEqArg) {
              const value = activeCapEqArg.slice('--active-cap='.length).trim();
              if (!value) error('Missing value for --active-cap (e.g. --active-cap tdd)', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
              loopActiveCap = value;
            } else if (activeCapIdx !== -1) {
              const value = args[activeCapIdx + 1];
              if (!value || value.startsWith('--')) {
                error('Missing value for --active-cap (e.g. --active-cap tdd)', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
              }
              loopActiveCap = value;
            }
            // --runtime <r> (#2003): explicit runtime override so the config-dir
            // resolution bypasses the persisted-runtime fallback (GSD_RUNTIME →
            // config.runtime). Mirrors the --config-dir dual-form (--runtime X /
            // --runtime=X) and the capability-set --runtime precedent.
            let loopRuntime = undefined;
            const runtimeEqArg = args.find(arg => arg.startsWith('--runtime='));
            const runtimeIdx = args.indexOf('--runtime');
            if (runtimeEqArg) {
              const value = runtimeEqArg.slice('--runtime='.length).trim();
              if (!value) error('Missing value for --runtime', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
              loopRuntime = value;
            } else if (runtimeIdx !== -1) {
              const value = args[runtimeIdx + 1];
              if (!value || value.startsWith('--')) {
                error('Missing value for --runtime', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
              }
              loopRuntime = value;
            }
            loopResolver.cmdLoopRenderHooks(cwd, args[2], raw, {
              configDir: loopConfigDir ? path.resolve(loopConfigDir) : undefined,
              activeCap: loopActiveCap,
              runtime: loopRuntime,
            });
          } else {
            error(
              `Unknown loop subcommand: ${loopSubcommand}. Available: render-hooks`,
              ERROR_REASON ? ERROR_REASON.SDK_UNKNOWN_COMMAND : undefined,
            );
          }
  }

  function routePhasePlanIndex({ args, cwd, raw, error }) {
    phase.cmdPhasePlanIndex(cwd, args[1], raw);
  }

  function routeStateSnapshot({ args, cwd, raw, error }) {
    state.cmdStateSnapshot(cwd, raw);
  }

  function routeSummaryExtract({ args, cwd, raw, error }) {
    const summaryPath = args[1];
          const fieldsIndex = args.indexOf('--fields');
          const fields = fieldsIndex !== -1 ? args[fieldsIndex + 1].split(',') : null;
          commands.cmdSummaryExtract(cwd, summaryPath, fields, raw);
  }

  async function routeWebsearch({ args, cwd, raw, error }) {
    const query = args[1];
          const limitIdx = args.indexOf('--limit');
          const freshnessIdx = args.indexOf('--freshness');
          await commands.cmdWebsearch(query, {
            limit: limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10,
            freshness: freshnessIdx !== -1 ? args[freshnessIdx + 1] : null,
          }, raw);
  }

  function routeWorkstream({ args, cwd, raw, error }) {
    const subcommand = args[1];
          if (subcommand === 'create') {
            const migrateNameIdx = args.indexOf('--migrate-name');
            const noMigrate = args.includes('--no-migrate');
            workstream.cmdWorkstreamCreate(cwd, args[2], {
              migrate: !noMigrate,
              migrateName: migrateNameIdx !== -1 ? args[migrateNameIdx + 1] : null,
            }, raw);
          } else if (subcommand === 'list') {
            workstream.cmdWorkstreamList(cwd, raw);
          } else if (subcommand === 'status') {
            workstream.cmdWorkstreamStatus(cwd, args[2], raw);
          } else if (subcommand === 'complete') {
            workstream.cmdWorkstreamComplete(cwd, args[2], {}, raw);
          } else if (subcommand === 'set') {
            workstream.cmdWorkstreamSet(cwd, args[2], raw);
          } else if (subcommand === 'get') {
            workstream.cmdWorkstreamGet(cwd, raw);
          } else if (subcommand === 'progress') {
            workstream.cmdWorkstreamProgress(cwd, raw);
          } else {
            error('Unknown workstream subcommand. Available: create, list, status, complete, set, get, progress', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeWorktree({ args, cwd, raw, error }) {
    const subcommand = args[1];
          const worktreeSafety = require('./lib/worktree-safety.cjs');
          if (subcommand === 'cleanup-wave') {
            worktreeSafety.cmdWorktreeCleanupWave(cwd, args.slice(2));
          } else if (subcommand === 'record-agent') {
            worktreeSafety.cmdWorktreeRecordAgent(cwd, args.slice(2));
          } else if (subcommand === 'reap-orphans') {
            worktreeSafety.cmdWorktreeReapOrphans(cwd);
          } else if (subcommand === 'base-check') {
            require('./lib/worktree-base-ref.cjs').cmdWorktreeBaseCheck(cwd, args.slice(2));
          } else if (subcommand === 'set-baseref') {
            require('./lib/worktree-base-ref.cjs').cmdWorktreeSetBaseRef(cwd, args.slice(2));
          } else if (subcommand === 'create') {
            worktreeSafety.cmdWorktreeCreate(cwd, args.slice(2));
          } else {
            error('Unknown worktree subcommand. Available: cleanup-wave, record-agent, reap-orphans, base-check, set-baseref, create', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeDocsInit({ args, cwd, raw, error }) {
    // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
          // SDK handler: docsInit in sdk/src/query/docs-init.ts.
          const handled = _dispatchNonFamily({
            registryCommand: 'docs-init',
            registryArgs: args.slice(1),
            legacyCommand: 'docs-init',
            legacyArgs: args.slice(1),
            cwd,
            raw,
            error,
            output: output,
          });
          if (!handled) docs.cmdDocsInit(cwd, raw);
  }

  function routeLearnings({ args, cwd, raw, error }) {
    const subcommand = args[1];
          if (subcommand === 'list') {
            learnings.cmdLearningsList(raw);
          } else if (subcommand === 'query') {
            const tagIdx = args.indexOf('--tag');
            const tag = tagIdx !== -1 ? args[tagIdx + 1] : null;
            if (!tag) error('Usage: gsd-tools learnings query --tag <tag>', ERROR_REASON.USAGE);
            learnings.cmdLearningsQuery(tag, raw);
          } else if (subcommand === 'copy') {
            learnings.cmdLearningsCopy(cwd, raw);
          } else if (subcommand === 'prune') {
            const olderIdx = args.indexOf('--older-than');
            const olderThan = olderIdx !== -1 ? args[olderIdx + 1] : null;
            if (!olderThan) error('Usage: gsd-tools learnings prune --older-than <duration>', ERROR_REASON.USAGE);
            learnings.cmdLearningsPrune(olderThan, raw);
          } else if (subcommand === 'delete') {
            const id = args[2];
            if (!id) error('Usage: gsd-tools learnings delete <id>', ERROR_REASON.USAGE);
            learnings.cmdLearningsDelete(id, raw);
          } else {
            error('Unknown learnings subcommand. Available: list, query, copy, prune, delete', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeWindows({ args, cwd, raw, error }) {
    // windows status | append | waive | fixed  (issue #1950)
    // All subcommands emit JSON; `--raw` is accepted for forward-compat with
    // capture-stdout hooks but is a no-op (output shape is JSON in both modes).
    const subcommand = args[1];
    const rest = args.slice(2);
    try {
      if (subcommand === 'status') {
        brokenWindows.cmdWindowsStatus(cwd, { raw });
      } else if (subcommand === 'append') {
        brokenWindows.cmdWindowsAppend(cwd, rest, { raw });
      } else if (subcommand === 'waive') {
        brokenWindows.cmdWindowsWaive(cwd, rest, { raw });
      } else if (subcommand === 'fixed') {
        brokenWindows.cmdWindowsMarkFixed(cwd, rest, { raw });
      } else {
        error(
          `Unknown windows subcommand: ${subcommand || '(none)'}. Available: status, append, waive, fixed`,
          ERROR_REASON.SDK_UNKNOWN_COMMAND,
        );
      }
    } catch (e) {
      // ADR-3889: error() now throws ExitError instead of calling
      // process.exit(1) directly, so an ExitError raised by error() INSIDE
      // this try (e.g. the "Unknown windows subcommand" call above, or one
      // inside cmdWindowsStatus/Append/Waive/MarkFixed) lands HERE instead of
      // terminating uncatchably. It must be re-thrown unconditionally, before
      // the WindowsError name check below, or it falls through to the
      // generic branch and gets re-wrapped with a wrong message/reason,
      // discarding the original exit code.
      if (e instanceof ExitError) throw e;
      // WindowsError carries a REASON code; surface it through the structured
      // error path so tests can assert on the typed reason.
      if (e && e.name === 'WindowsError' && typeof e.reason === 'string') {
        error(e.message || 'broken-windows error', e.reason);
      }
      // Non-WindowsError: surface the message verbatim and exit non-zero.
      error(`broken-windows: ${(e && e.message) ? e.message : String(e)}`, ERROR_REASON.UNKNOWN);
    }
  }

  function routeTeamsStatus({ args, cwd, raw, error }) {
    const teamsStatus = require('./lib/teams-status.cjs');
          teamsStatus.cmdTeamsStatus(cwd, { active: args.includes('--active') });
  }

  // #3023 follow-up (adversarial review finding): the shared hook bundle's
  // directory name is runtime-descriptor-driven (bin/install.js
  // `hostBehaviors.sharedHooksDirName`; default 'hooks', pi renames it to
  // 'gsd-hooks'). A hardcoded 'hooks' literal in GSD_PREFIX_MANAGED_DIRS left
  // this scan blind to a renamed bundle: `fs.existsSync(configDir/hooks)` is
  // false for a pi install, so the ENTIRE gsd-hooks/ tree — including any
  // user-added file inside it — was invisible to detect-custom-files and
  // therefore never backed up before the next clean-install wipe (silent
  // data loss).
  //
  // Resolution order, mirroring bin/install.js's own resolveSharedHooksDirName:
  //   1. Read the per-install runtime marker written by the installer at
  //      <configDir>/gsd-core/.gsd-runtime (#2297).
  //   2. Look up that runtime's `hostBehaviors.sharedHooksDirName` in the
  //      SHIPPED capability registry (./lib/capability-registry.cjs — a data
  //      module in the same installed tree as this file). Deliberately NOT
  //      `require('bin/install.js')`: that file is never shipped into an
  //      installed tree (the #3024/#2071 bug class), so only the shipped data
  //      module is read here.
  //
  // Asymmetric fallback: when the runtime or its descriptor cannot be
  // determined (an install predating the marker, an unreadable/corrupt
  // registry, or an unrecognized runtime id) this does NOT guess a single
  // name — it returns every known candidate name instead. Over-scanning is
  // safe here: a candidate directory that does not exist is silently skipped
  // by the caller's `fs.existsSync` guard, and a file already tracked in the
  // manifest is never reported as custom. Under-scanning is the actual bug
  // being fixed: it would make a user's file vanish on the next wipe without
  // ever being backed up.
  function resolveSharedHooksDirCandidates(configDir) {
    const DEFAULT_NAME = 'hooks';
    // A resolved name is joined onto configDir and read back — reject
    // anything that isn't a plain, separator-free segment so a corrupt
    // registry value can never walk the scan outside the config root.
    const isSafeSegment = (name) =>
      typeof name === 'string' &&
      name.trim() !== '' &&
      name.trim() === name &&
      name !== '.' &&
      name !== '..' &&
      !name.includes('/') &&
      !name.includes('\\');

    let registry = null;
    try {
      registry = require('./lib/capability-registry.cjs');
    } catch {
      registry = null;
    }

    const knownNames = new Set([DEFAULT_NAME]);
    if (registry && registry.runtimes && typeof registry.runtimes === 'object') {
      for (const desc of Object.values(registry.runtimes)) {
        const name = desc && desc.runtime && desc.runtime.hostBehaviors &&
          desc.runtime.hostBehaviors.sharedHooksDirName;
        if (isSafeSegment(name)) knownNames.add(name);
      }
    }

    let runtimeId = null;
    try {
      const markerPath = path.join(configDir, 'gsd-core', '.gsd-runtime');
      const raw = fs.readFileSync(markerPath, 'utf8').trim();
      runtimeId = raw || null;
    } catch {
      runtimeId = null;
    }

    if (runtimeId && registry && registry.runtimes && registry.runtimes[runtimeId]) {
      const desc = registry.runtimes[runtimeId];
      const name = desc && desc.runtime && desc.runtime.hostBehaviors &&
        desc.runtime.hostBehaviors.sharedHooksDirName;
      return [isSafeSegment(name) ? name : DEFAULT_NAME];
    }

    // Runtime undeterminable: scan every known candidate (see asymmetric
    // fallback comment above).
    return Array.from(knownNames);
  }

  async function routeDetectCustomFiles({ args, cwd, raw, error }) {
    const configDirIdx = args.indexOf('--config-dir');
          const configDir = configDirIdx !== -1 ? args[configDirIdx + 1] : null;
          if (!configDir) {
            error('Usage: gsd-tools detect-custom-files --config-dir <path>', ERROR_REASON.USAGE);
          }
          const resolvedConfigDir = path.resolve(configDir);
          if (!fs.existsSync(resolvedConfigDir)) {
            error(`Config directory not found: ${resolvedConfigDir}`, ERROR_REASON.USAGE);
          }

          const manifestPath = path.join(resolvedConfigDir, 'gsd-file-manifest.json');
          if (!fs.existsSync(manifestPath)) {
            // No manifest — cannot determine what is custom. Return empty list
            // (same behaviour as saveLocalPatches in install.js when no manifest).
            const out = { custom_files: [], custom_count: 0, manifest_found: false };
            process.stdout.write(JSON.stringify(out, null, 2));
            return;
          }

          let manifest;
          try {
            manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
          } catch {
            const out = { custom_files: [], custom_count: 0, manifest_found: false, error: 'manifest parse error' };
            process.stdout.write(JSON.stringify(out, null, 2));
            return;
          }

          const manifestKeys = new Set(Object.keys(manifest.files || {}));

          // GSD-managed directories to scan for user-added files. Whole-owned
          // roots are wiped recursively; shared runtime roots are pruned by the
          // same gsd-* top-level prefix used by install.js _removeGsdEntries.
          const GSD_WHOLE_MANAGED_DIRS = [
            'gsd-core',
            path.join('commands', 'gsd'),
          ];
          const GSD_PREFIX_MANAGED_DIRS = [
            'agents',
            ...resolveSharedHooksDirCandidates(resolvedConfigDir),
            'skills',
          ];

          function collectCustomFiles(dir, baseDir, manifestKeys, out) {
            if (!fs.existsSync(dir)) return;
            const stat = fs.statSync(dir);
            if (stat.isFile()) {
              const relPath = path.relative(baseDir, dir).replace(/\\/g, '/');
              if (!manifestKeys.has(relPath)) {
                out.push(relPath);
              }
              return;
            }
            if (!stat.isDirectory()) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                collectCustomFiles(fullPath, baseDir, manifestKeys, out);
                continue;
              }
              // Use forward slashes for cross-platform manifest key compatibility
              const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
              if (!manifestKeys.has(relPath)) {
                out.push(relPath);
              }
            }
          }

          const customFiles = [];
          for (const managedDir of GSD_WHOLE_MANAGED_DIRS) {
            const absDir = path.join(resolvedConfigDir, managedDir);
            if (!fs.existsSync(absDir)) continue;
            collectCustomFiles(absDir, resolvedConfigDir, manifestKeys, customFiles);
          }
          for (const managedDir of GSD_PREFIX_MANAGED_DIRS) {
            const absDir = path.join(resolvedConfigDir, managedDir);
            if (!fs.existsSync(absDir)) continue;
            for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
              if (!entry.name.startsWith('gsd-')) continue;
              collectCustomFiles(path.join(absDir, entry.name), resolvedConfigDir, manifestKeys, customFiles);
            }
          }

          const out = {
            custom_files: customFiles,
            custom_count: customFiles.length,
            manifest_found: true,
            manifest_version: manifest.version || null,
          };
          process.stdout.write(JSON.stringify(out, null, 2));
  }

  // ─── restore-custom-files (#1854) ───────────────────────────────────────────
  // The counterpart to detect-custom-files. `backup_custom_files` copies
  // user-added files into <config-dir>/gsd-user-files-backup/ before the
  // clean-install wipe; until #1854 nothing ever read them back — the update
  // workflow just printed "Restore them after the update if needed" and moved
  // on. (`/gsd:update --reapply` covers the OTHER bucket: shipped files the
  // user MODIFIED, kept in gsd-local-patches/.)
  //
  // Two modes, both emitting the same JSON report:
  //   plan (default)  — walk the backup, run the compatibility pass, write nothing
  //   --apply         — same, then copy the eligible entries back
  //
  // Invariants: the backup is never deleted; a shipped file is never clobbered;
  // an existing differing file is never clobbered; one failed entry never
  // aborts the rest; nothing is written outside the config dir.
  const RESTORE_OUTCOME = Object.freeze({
    ELIGIBLE: 'eligible',
    RESTORED: 'restored',
    SKIPPED_DESTINATION_MANAGED: 'skipped_destination_managed',
    SKIPPED_DESTINATION_EXISTS: 'skipped_destination_exists',
    SKIPPED_COPY_FAILED: 'skipped_copy_failed',
    SKIPPED_UNSAFE_PATH: 'skipped_unsafe_path',
  });

  const RESTORE_WARNING = Object.freeze({
    DESTINATION_MANAGED: 'destination_managed',
    DESTINATION_EXISTS: 'destination_exists',
    MISSING_REFERENCED_PATH: 'missing_referenced_path',
    MISSING_REFERENCED_COMMAND: 'missing_referenced_command',
    FRONTMATTER_MISSING_FIELD: 'frontmatter_missing_field',
    WRITE_FAILED: 'write_failed',
  });

  // Compatibility scanning reads backed-up files whole. Cap the read so a
  // stray large artifact in the backup cannot balloon memory; oversized files
  // still restore, they just skip the (advisory) content scan.
  const RESTORE_SCAN_MAX_BYTES = 1024 * 1024;
  const RESTORE_BACKUP_DIR_NAME = 'gsd-user-files-backup';

  // Referenced shipped paths (`@gsd-core/workflows/foo.md`) and slash commands
  // (`/gsd:plan-phase`) are the two references a custom skill most commonly
  // makes into GSD itself, and the two that a release most commonly renames.
  const RESTORE_GSD_PATH_RE = /gsd-core\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:md|cjs|js|json|sh)/g;
  const RESTORE_SLASH_COMMAND_RE = /\/gsd:[a-z0-9][a-z0-9-]*/g;

  /**
   * Walk the backup tree, refusing to follow symlinks. Returns entries in
   * stable sorted order; `unsafe` marks a link we saw but will not traverse
   * or copy (reported for auditability rather than silently dropped).
   */
  function collectBackupEntries(dir, baseDir, out) {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const fullPath = path.join(dir, entry.name);
      // Path separators are normalized unconditionally: backslash-shaped
      // relative paths reach Linux too (backups copied between machines).
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) {
        out.push({ relPath, unsafe: true });
        continue;
      }
      if (entry.isDirectory()) {
        collectBackupEntries(fullPath, baseDir, out);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push({ relPath, unsafe: false });
    }
    return out;
  }

  // Why these three checks rather than security.cjs's `validatePath`: that seam
  // resolves symlinks with realpathSync and then tests containment, so a link
  // whose target sits inside the config dir passes. For a restore that is still
  // wrong — writing through any link overwrites whatever it points at instead
  // of materializing a regular file at the backed-up path. These checks reject
  // links outright, which is strictly stricter than validatePath, not a
  // reimplementation of it. Do not "simplify" this to validatePath.

  /** True when `target` resolves strictly inside `root`. */
  function isInsideDir(root, target) {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /**
   * True when `target` itself exists and is a symlink. `fs.existsSync` and
   * `copyFileSync` both FOLLOW links, so a symlinked destination would let a
   * restore write through to the link's target — outside the config dir —
   * even though every ancestor is a real directory.
   */
  function isSymlinkPath(target) {
    try {
      return fs.lstatSync(target).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * True when the deepest already-existing ancestor of `target` is a symlink.
   * A symlinked parent directory would let a copy land outside the config dir
   * even though the joined path looks contained.
   */
  function hasSymlinkedAncestor(root, target) {
    let cursor = path.dirname(path.resolve(target));
    const stop = path.resolve(root);
    while (cursor.length >= stop.length && cursor.startsWith(stop)) {
      let st;
      try {
        st = fs.lstatSync(cursor);
      } catch {
        cursor = path.dirname(cursor);
        if (cursor === stop) return false;
        continue;
      }
      if (st.isSymbolicLink()) return true;
      if (cursor === stop) return false;
      cursor = path.dirname(cursor);
    }
    return false;
  }

  /**
   * Best-effort compatibility pass of one backed-up file against the NEWLY
   * installed release. Every finding is advisory — a warning never blocks a
   * restore, it just travels with the entry into the report.
   */
  function scanRestoreCompatibility(srcPath, relPath, configDir) {
    const warnings = [];
    let size = 0;
    try {
      size = fs.statSync(srcPath).size;
    } catch {
      return warnings;
    }
    if (size > RESTORE_SCAN_MAX_BYTES) return warnings;

    let content;
    try {
      content = fs.readFileSync(srcPath, 'utf8');
    } catch {
      return warnings;
    }

    const missingPaths = new Set();
    for (const match of content.match(RESTORE_GSD_PATH_RE) || []) {
      if (!fs.existsSync(path.join(configDir, match))) missingPaths.add(match);
    }
    for (const missing of missingPaths) {
      warnings.push({
        code: RESTORE_WARNING.MISSING_REFERENCED_PATH,
        detail: `references ${missing}, which the installed release does not ship`,
      });
    }

    const missingCommands = new Set();
    for (const match of content.match(RESTORE_SLASH_COMMAND_RE) || []) {
      const verb = match.slice('/gsd:'.length);
      if (!fs.existsSync(path.join(configDir, 'commands', 'gsd', `${verb}.md`))) {
        missingCommands.add(match);
      }
    }
    for (const missing of missingCommands) {
      warnings.push({
        code: RESTORE_WARNING.MISSING_REFERENCED_COMMAND,
        detail: `references ${missing}, which the installed release does not provide`,
      });
    }

    // Skills and agents/commands are frontmatter-driven surfaces: a file the
    // runtime cannot parse is restored-but-dead, which is worth saying out loud.
    const base = relPath.split('/').pop();
    const isFrontmatterSurface = base === 'SKILL.md'
      || relPath.startsWith('agents/')
      || relPath.startsWith('commands/');
    if (isFrontmatterSurface) {
      const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
      const missingFields = [];
      if (!block) {
        missingFields.push('name', 'description');
      } else {
        if (!/^name:\s*\S/m.test(block[1])) missingFields.push('name');
        if (!/^description:\s*\S/m.test(block[1])) missingFields.push('description');
      }
      if (missingFields.length > 0) {
        warnings.push({
          code: RESTORE_WARNING.FRONTMATTER_MISSING_FIELD,
          detail: `frontmatter is missing required field(s): ${missingFields.join(', ')}`,
        });
      }
    }

    return warnings;
  }

  function routeRestoreCustomFiles({ args, error }) {
    // Last-wins so a duplicated flag resolves rather than erroring, matching
    // the rest of the gsd-tools flag surface.
    let configDir = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--config-dir') continue;
      configDir = args[i + 1] === undefined ? null : args[i + 1];
    }
    const apply = args.includes('--apply');

    if (configDir === null || configDir.trim() === '' || configDir.startsWith('--')) {
      error('Usage: gsd-tools restore-custom-files --config-dir <path> [--apply]', ERROR_REASON.USAGE);
    }
    const resolvedConfigDir = path.resolve(configDir);
    if (!fs.existsSync(resolvedConfigDir)) {
      error(`Config directory not found: ${resolvedConfigDir}`, ERROR_REASON.USAGE);
    }

    // lstat, not stat: a symlinked backup root would let the walk read files
    // from anywhere on disk and present them as the user's own backup.
    const backupDir = path.join(resolvedConfigDir, RESTORE_BACKUP_DIR_NAME);
    let backupFound = false;
    try {
      backupFound = fs.lstatSync(backupDir).isDirectory();
    } catch {
      backupFound = false;
    }

    // The manifest describes what the NEW release ships. Without it the
    // destination-managed check has no source of truth — degrade to restoring
    // without that check rather than refusing to restore the user's own data.
    let manifestKeys = new Set();
    let manifestFound = false;
    const manifestPath = path.join(resolvedConfigDir, 'gsd-file-manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        // Shape, not just type (ADR-227): `files` must be a plain object for
        // its keys to mean "paths this release ships". An array or a scalar
        // yields numeric-index keys that silently match nothing, which would
        // report a usable manifest while the managed-path check is dead.
        const files = manifest && manifest.files;
        const isPlainObject = typeof files === 'object'
          && files !== null
          && !Array.isArray(files);
        if (isPlainObject) {
          manifestKeys = new Set(Object.keys(files));
          manifestFound = true;
        }
      } catch {
        manifestFound = false;
      }
    }

    const entries = [];
    for (const found of backupFound ? collectBackupEntries(backupDir, backupDir, []) : []) {
      const { relPath } = found;
      const srcPath = path.join(backupDir, relPath);
      const destPath = path.join(resolvedConfigDir, relPath);

      if (found.unsafe
        || !isInsideDir(resolvedConfigDir, destPath)
        || isSymlinkPath(destPath)
        || hasSymlinkedAncestor(resolvedConfigDir, destPath)) {
        entries.push({
          path: relPath,
          outcome: RESTORE_OUTCOME.SKIPPED_UNSAFE_PATH,
          warnings: [],
        });
        continue;
      }

      const warnings = scanRestoreCompatibility(srcPath, relPath, resolvedConfigDir);

      if (manifestFound && manifestKeys.has(relPath)) {
        warnings.unshift({
          code: RESTORE_WARNING.DESTINATION_MANAGED,
          detail: 'the installed release now ships this path — restoring would overwrite it',
        });
        entries.push({ path: relPath, outcome: RESTORE_OUTCOME.SKIPPED_DESTINATION_MANAGED, warnings });
        continue;
      }

      // An identical destination is a no-op restore, not a conflict: re-running
      // the restore after a successful one must stay quiet and idempotent.
      let destDiffers = false;
      if (fs.existsSync(destPath)) {
        try {
          destDiffers = !fs.readFileSync(destPath).equals(fs.readFileSync(srcPath));
        } catch {
          destDiffers = true;
        }
      }
      if (destDiffers) {
        warnings.unshift({
          code: RESTORE_WARNING.DESTINATION_EXISTS,
          detail: 'a different file already exists at this path — restoring would overwrite it',
        });
        entries.push({ path: relPath, outcome: RESTORE_OUTCOME.SKIPPED_DESTINATION_EXISTS, warnings });
        continue;
      }

      if (!apply) {
        entries.push({ path: relPath, outcome: RESTORE_OUTCOME.ELIGIBLE, warnings });
        continue;
      }

      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        entries.push({ path: relPath, outcome: RESTORE_OUTCOME.RESTORED, warnings });
      } catch (err) {
        const code = err && err.code ? String(err.code) : 'ERROR';
        entries.push({
          path: relPath,
          outcome: RESTORE_OUTCOME.SKIPPED_COPY_FAILED,
          warnings: warnings.concat([{
            code: RESTORE_WARNING.WRITE_FAILED,
            detail: `could not write the destination [${code}] — the backup copy is unchanged`,
          }]),
        });
      }
    }

    const restoredCount = entries.filter(e => e.outcome === RESTORE_OUTCOME.RESTORED).length;
    const eligibleCount = entries.filter(
      e => e.outcome === RESTORE_OUTCOME.ELIGIBLE || e.outcome === RESTORE_OUTCOME.RESTORED,
    ).length;

    process.stdout.write(JSON.stringify({
      backup_dir: backupDir,
      backup_found: backupFound,
      manifest_found: manifestFound,
      applied: apply,
      entries,
      eligible_count: eligibleCount,
      restored_count: restoredCount,
      skipped_count: entries.length - eligibleCount,
      warning_count: entries.reduce((sum, e) => sum + e.warnings.length, 0),
    }, null, 2));
  }

  function routeFromGsd2({ args, cwd, raw, error }) {
    const gsd2Import = require('./lib/gsd2-import.cjs');
          gsd2Import.cmdFromGsd2(args.slice(1), cwd, raw);
  }

  async function routePromptBudget({ args, cwd, raw, error }) {
    const promptBudget = require('./lib/prompt-budget.cjs');

          // ── Collect multi-value --plan-file flags ──────────────────────────
          const planFiles = [];
          for (let i = 1; i < args.length; i++) {
            if (args[i] === '--plan-file' && args[i + 1] && !args[i + 1].startsWith('--')) {
              planFiles.push(args[i + 1]);
              i++;
            }
          }

          // ── Parse single-value flags ───────────────────────────────────────
          const flagMap = new Map();
          for (let i = 1; i < args.length; i++) {
            const current = args[i];
            const next = args[i + 1];
            if (!current.startsWith('--')) continue;
            if (!next || next.startsWith('--')) {
              if (!flagMap.has(current)) flagMap.set(current, null);
              continue;
            }
            if (!flagMap.has(current)) flagMap.set(current, next);
            i++;
          }
          const getFlag = (flag) => flagMap.get(flag) ?? null;

          const budgetStr = getFlag('--budget');
          const instructionsFile = getFlag('--instructions-file');
          const roadmapFile = getFlag('--roadmap-file');
          const outputPromptFile = getFlag('--output-prompt');
          const outputMetadataFile = getFlag('--output-metadata');
          const safetyMarginStr = getFlag('--safety-margin-pct');
          const projectMdHeadLinesStr = getFlag('--project-md-head-lines');
          const projectFile = getFlag('--project-file');
          const contextFile = getFlag('--context-file');
          const researchFile = getFlag('--research-file');
          const requirementsFile = getFlag('--requirements-file');

          // ── Validate required args ─────────────────────────────────────────
          if (!budgetStr) {
            throw new ExitError(1, 'Error: --budget <N> is required');
          }
          const budget = parseInt(budgetStr, 10);
          if (!Number.isFinite(budget) || budget <= 0) {
            throw new ExitError(1, 'Error: --budget must be a positive integer');
          }
          if (!instructionsFile) {
            throw new ExitError(1, 'Error: --instructions-file <path> is required');
          }
          if (!roadmapFile) {
            throw new ExitError(1, 'Error: --roadmap-file <path> is required');
          }
          if (planFiles.length === 0) {
            throw new ExitError(1, 'Error: at least one --plan-file <path> is required');
          }
          if (!outputPromptFile) {
            throw new ExitError(1, 'Error: --output-prompt <path> is required');
          }
          if (!outputMetadataFile) {
            throw new ExitError(1, 'Error: --output-metadata <path> is required');
          }

          // ── Validate and read required files ──────────────────────────────
          async function readRequired(filePath, flagName) {
            const resolved = path.resolve(filePath);
            try {
              return await fs.promises.readFile(resolved, 'utf8');
            } catch (err) {
              if (err && err.code === 'ENOENT') {
                throw new ExitError(1, `Error: file not found for ${flagName}: ${resolved}`);
              }
              throw new ExitError(1, `Error: cannot read file for ${flagName}: ${resolved}`);
            }
          }

          async function readOptional(filePath) {
            if (!filePath) return null;
            const resolved = path.resolve(filePath);
            try {
              return await fs.promises.readFile(resolved, 'utf8');
            } catch (err) {
              if (err && err.code === 'ENOENT') return null;
              throw new ExitError(1, `Error: cannot read optional file: ${resolved}`);
            }
          }

          const instructions = await readRequired(instructionsFile, '--instructions-file');
          const roadmap = await readRequired(roadmapFile, '--roadmap-file');
          const plans = await Promise.all(planFiles.map(async (p) => {
            const resolved = path.resolve(p);
            try {
              const content = await fs.promises.readFile(resolved, 'utf8');
              return { file: path.basename(p), content };
            } catch (err) {
              if (err && err.code === 'ENOENT') {
                throw new ExitError(1, `Error: plan file not found: ${resolved}`);
              }
              throw new ExitError(1, `Error: cannot read plan file: ${resolved}`);
            }
          }));

          const projectMd = await readOptional(projectFile);
          const context = await readOptional(contextFile);
          const research = await readOptional(researchFile);
          const requirements = await readOptional(requirementsFile);

          // ── Build options ─────────────────────────────────────────────────
          const options = {};
          if (safetyMarginStr !== null) {
            const pct = parseInt(safetyMarginStr, 10);
            if (Number.isFinite(pct)) options.safetyMarginPct = pct;
          }
          if (projectMdHeadLinesStr !== null) {
            const lines = parseInt(projectMdHeadLinesStr, 10);
            if (Number.isFinite(lines)) options.projectMdHeadLines = lines;
          }

          // ── Call applyBudget ──────────────────────────────────────────────
          const sections = { instructions, roadmap, plans, projectMd, context, research, requirements };
          const { prompt, metadata } = promptBudget.applyBudget({ sections, budget, options });

          // ── Write outputs ─────────────────────────────────────────────────
          await fs.promises.writeFile(path.resolve(outputMetadataFile), JSON.stringify(metadata, null, 2));
          await fs.promises.writeFile(path.resolve(outputPromptFile), prompt);

          if (metadata.hardFailed) {
            throw new ExitError(2);
          }
  }

  // `gsd_run query context-predicates` — selector surface for the CONTEXT.md
  // predicate fact-store (ADR-1671, #2928 Phase 1 row S9). Parses the
  // repo-root CONTEXT.md LIVE via the compiled context-predicates.cjs on
  // every call — it never reads the committed docs/CONTEXT-INDEX.json (that
  // artifact is a CI drift-guard byproduct, not a query source, so it can
  // never go stale relative to the live predicates it answers about).
  //
  // Selectors: --class <CLASS>, --prefix <dotted.prefix>, --contains <text>.
  // At least one is required. When more than one is given they are ANDed
  // together — the same documented precedence selectPredicates() itself
  // implements (see context-predicates.cjs doc comment: "Select predicates
  // by one or more optional criteria (ANDed together)"); no selector is
  // silently dropped or overridden by another.
  //
  // Flag parsing mirrors routePromptBudget's Map-based flagMap: the three
  // known flags are recognized in both the space-separated `--flag value`
  // form and the inline-assignment `--flag=value` form (the latter is the
  // escape hatch for a flag-shaped selector value, e.g. `--contains=--dry-run`
  // — #2928 review finding C; the space-separated form has no such escape by
  // design, since a following `--...` token always reads as a missing value).
  // `--class=` (empty value) and `--class==A` (double-equals typo shape)
  // are rejected the same way under either form. On a duplicate flag the
  // FIRST occurrence wins (`Map.set` only fires when the key is absent),
  // which is deterministic across repeated invocations with identical argv.
  //
  // Prototype-pollution safety: selector values are only ever compared via
  // `===`/`.startsWith()`/`.includes()` against ordinary string fields — this
  // route never uses a user-supplied string as an object property key
  // (`obj[userValue] = ...`), so `--class __proto__` / `constructor` /
  // `prototype` are just non-matching ordinary strings, not property-access
  // vectors. `flagMap` itself is a `Map`, immune to prototype pollution by
  // construction.
  function routeContextPredicates({ args, cwd, raw, error }) {
    const { parsePredicates, selectPredicates } = require('./lib/context-predicates.cjs');

    const KNOWN_FLAGS = new Set(['--class', '--prefix', '--contains']);
    const flagMap = new Map();
    for (let i = 1; i < args.length; i++) {
      const current = args[i];
      if (typeof current !== 'string' || !current.startsWith('--')) continue;

      // Inline-assignment escape hatch (`--flag=value`, mirrors the `--config-dir=`/
      // `--runtime=` convention in routeUpdateContext elsewhere in this file). This is
      // the ONLY way to pass a flag-shaped selector value (e.g. searching CONTEXT.md
      // for the literal substring "--dry-run"): the space-separated form below always
      // treats a following `--...` token as a missing value, by design, so it has no
      // escape hatch on its own (#2928 review finding C).
      const eqFlag = [...KNOWN_FLAGS].find((f) => current.startsWith(`${f}=`));
      if (eqFlag) {
        const value = current.slice(eqFlag.length + 1);
        // Reject an empty value (`--class=`) and the `--class==A` double-equals typo
        // shape (a value starting with `=`) the same way the pre-existing malformed-
        // assignment behavior did — never silently accept "=A" as a literal value.
        if (value === '' || value.startsWith('=')) {
          error(`context-predicates: ${eqFlag} requires a non-empty value`, ERROR_REASON.USAGE);
          return;
        }
        if (!flagMap.has(eqFlag)) flagMap.set(eqFlag, value);
        continue;
      }

      if (!KNOWN_FLAGS.has(current)) {
        error(`Unknown flag for context-predicates: ${current}`, ERROR_REASON.USAGE);
        return;
      }
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        if (!flagMap.has(current)) flagMap.set(current, null);
        continue;
      }
      if (!flagMap.has(current)) flagMap.set(current, next);
      i++;
    }

    const hasClass = flagMap.has('--class');
    const hasPrefix = flagMap.has('--prefix');
    const hasContains = flagMap.has('--contains');

    if (!hasClass && !hasPrefix && !hasContains) {
      error(
        'Usage: gsd-tools query context-predicates --class <CLASS> | --prefix <dotted.prefix> | --contains <text> ' +
        '(selectors are ANDed when combined)',
        ERROR_REASON.USAGE,
      );
      return;
    }

    const requireNonEmpty = (flagName, rawValue) => {
      if (rawValue === null || rawValue === undefined || rawValue.trim() === '') {
        error(`context-predicates: ${flagName} requires a non-empty value`, ERROR_REASON.USAGE);
        return null;
      }
      return rawValue;
    };

    const opts = {};
    if (hasClass) {
      const v = requireNonEmpty('--class', flagMap.get('--class'));
      if (v === null) return;
      opts.klass = v;
    }
    if (hasPrefix) {
      const v = requireNonEmpty('--prefix', flagMap.get('--prefix'));
      if (v === null) return;
      opts.prefix = v;
    }
    if (hasContains) {
      const v = requireNonEmpty('--contains', flagMap.get('--contains'));
      if (v === null) return;
      opts.contains = v;
    }

    const contextMdPath = path.join(__dirname, '..', '..', 'CONTEXT.md');
    let markdown;
    try {
      markdown = fs.readFileSync(contextMdPath, 'utf8');
    } catch (err) {
      error(`context-predicates: cannot read ${contextMdPath}: ${err && err.message}`, ERROR_REASON.USAGE);
      return;
    }

    const { predicates } = parsePredicates(markdown);
    const matches = selectPredicates(predicates, opts);

    output({ matched: matches.length, predicates: matches }, raw);
  }

  function routeUpdateContext({ args, cwd, raw, error }) {
    // #498: resolve the installed GSD version, scope, runtime, and config dir
          // for /gsd:update. Replaces ~280 lines of inline bash in update.md with a
          // tested projection. Emits the contract as JSON: { installedVersion,
          // scope, runtime, gsdDir }. Optional --config-dir / --runtime carry the
          // workflow's execution_context hints (the one thing only it can know).
          const { loadUpdateContext } = require('./lib/update-context.cjs');
          const ucArgs = args.slice(1);
          let preferredConfigDir = '';
          let preferredRuntime = '';
          for (let i = 0; i < ucArgs.length; i++) {
            const a = ucArgs[i];
            if (a.startsWith('--config-dir=')) { preferredConfigDir = a.slice('--config-dir='.length); continue; }
            if (a.startsWith('--runtime=')) { preferredRuntime = a.slice('--runtime='.length); continue; }
            if (a === '--config-dir') {
              const v = ucArgs[i + 1];
              if (v === undefined || v.startsWith('--')) error('Missing value for --config-dir', ERROR_REASON.USAGE);
              preferredConfigDir = v; i++; continue;
            }
            if (a === '--runtime') {
              const v = ucArgs[i + 1];
              if (v === undefined || v.startsWith('--')) error('Missing value for --runtime', ERROR_REASON.USAGE);
              preferredRuntime = v; i++; continue;
            }
            if (a === '--json') continue; // JSON is the only output; accepted for symmetry
            if (a.startsWith('-')) error(`Unknown flag for update-context: ${a}`, ERROR_REASON.USAGE);
          }
          const ctx = loadUpdateContext({ preferredConfigDir, preferredRuntime });
          process.stdout.write(JSON.stringify(ctx) + '\n');
  }

  async function routeClassifyConfidence({ args, cwd, raw, error }) {
    const researchProvider = require('./lib/research-provider.cjs');
          const providerIdx = args.indexOf('--provider');
          const provider = providerIdx !== -1 ? args[providerIdx + 1] : null;
          if (!provider || provider.startsWith('--')) {
            error('Usage: gsd-tools query classify-confidence --provider <id> [--package <name> --ecosystem <npm|pypi|crates>] [--verified]', ERROR_REASON.USAGE);
          }
          const verified = args.includes('--verified');
          const pkgIdx = args.indexOf('--package');
          const pkg = pkgIdx !== -1 ? args[pkgIdx + 1] : null;
          const ecoIdx = args.indexOf('--ecosystem');
          const ecosystem = ecoIdx !== -1 ? args[ecoIdx + 1] : null;
          let legitimacyVerdict = null;
          if (pkg && (!pkg.startsWith('--'))) {
            const VALID_ECOSYSTEMS = new Set(['npm', 'pypi', 'crates']);
            if (!ecosystem || ecosystem.startsWith('--') || !VALID_ECOSYSTEMS.has(ecosystem)) {
              error('Usage: gsd-tools query classify-confidence --provider <id> [--package <name> --ecosystem <npm|pypi|crates>] [--verified]', ERROR_REASON.USAGE);
            }
            const pkgLegitimacy = require('./lib/package-legitimacy.cjs');
            const results = await pkgLegitimacy.checkPackages({ ecosystem, packages: [pkg] }, {});
            legitimacyVerdict = results[0] ? results[0].verdict : null;
          }
          const confidence = researchProvider.classifyConfidence({ provider, verifiedAgainstOfficial: verified, legitimacyVerdict });
          output({ provider, package: pkg || null, ecosystem: ecosystem || null, legitimacyVerdict, verified, confidence }, raw);
  }

  async function routePackageLegitimacy({ args, cwd, raw, error }) {
    const pkgLegitimacy = require('./lib/package-legitimacy.cjs');
          const subcommand = args[1];
          if (subcommand !== 'check') {
            error('Unknown package-legitimacy subcommand. Available: check', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
          const ecoIdx = args.indexOf('--ecosystem');
          const ecosystem = ecoIdx !== -1 ? args[ecoIdx + 1] : null;
          const VALID_ECOSYSTEMS = new Set(['npm', 'pypi', 'crates']);
          if (!ecosystem || !VALID_ECOSYSTEMS.has(ecosystem)) {
            error('Usage: gsd-tools package-legitimacy check --ecosystem <npm|pypi|crates> <pkg1> ...', ERROR_REASON.USAGE);
          }
          // Collect positional package names.
          // Only --ecosystem takes a value. Every non-flag arg is a package name.
          // Any unknown --flag is a usage error (do not silently skip+consume the next arg).
          const packages = [];
          for (let i = 2; i < args.length; i++) {
            const a = args[i];
            if (a === '--ecosystem') { i++; continue; }
            if (a.startsWith('--')) {
              error(`package-legitimacy: unknown flag ${a}`, ERROR_REASON.USAGE);
            }
            packages.push(a);
          }
          if (packages.length === 0) {
            error('Usage: gsd-tools package-legitimacy check --ecosystem <eco> <pkg1> <pkg2> ...', ERROR_REASON.USAGE);
          }
          let pkgResults;
          try {
            pkgResults = await pkgLegitimacy.checkPackages({ ecosystem, packages }, {});
          } catch (pkgErr) {
            error(`package-legitimacy: ${pkgErr && pkgErr.message ? pkgErr.message : String(pkgErr)}`, ERROR_REASON.UNKNOWN);
          }
          output(pkgResults, raw);
  }

  function routeEffort({ args, cwd, raw, error }) {
    const subcommand = args[1];
          if (subcommand === 'sync') {
            const effortSyncArgs = args.slice(2);
            let dryRun = true;
            let effortSyncConfigDir;
            let effortSyncRuntime;
            for (let i = 0; i < effortSyncArgs.length; i++) {
              const a = effortSyncArgs[i];
              if (a === '--apply') { dryRun = false; continue; }
              if (a === '--dry-run') { dryRun = true; continue; }
              if (a.startsWith('--config-dir=')) { effortSyncConfigDir = a.slice('--config-dir='.length); continue; }
              if (a === '--config-dir') {
                const v = effortSyncArgs[i + 1];
                if (!v || v.startsWith('--')) error('Missing value for --config-dir', ERROR_REASON.USAGE);
                effortSyncConfigDir = v; i++; continue;
              }
              if (a.startsWith('--runtime=')) { effortSyncRuntime = a.slice('--runtime='.length); continue; }
              if (a === '--runtime') {
                const v = effortSyncArgs[i + 1];
                if (!v || v.startsWith('--')) error('Missing value for --runtime', ERROR_REASON.USAGE);
                effortSyncRuntime = v; i++; continue;
              }
              if (a === '--raw') continue;
              if (a.startsWith('-')) error(`Unknown flag for effort sync: ${a}`, ERROR_REASON.USAGE);
              error(`effort sync takes no positional arguments; got: ${a}`, ERROR_REASON.USAGE);
            }
            commands.cmdEffortSync(cwd, raw, { dryRun, configDir: effortSyncConfigDir, runtime: effortSyncRuntime });
          } else {
            error('Unknown effort subcommand. Available: sync', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          }
  }

  function routeUserStory({ args, cwd, raw, error }) {
    const subcommand = args[1];
          if (subcommand !== 'validate') {
            error(`Unknown user-story subcommand: ${subcommand || '(none)'}. Available: validate`, ERROR_REASON.SDK_UNKNOWN_COMMAND);
            return;
          }

          const storyIdx = args.indexOf('--story');
          const story = (storyIdx !== -1 && args[storyIdx + 1] && !args[storyIdx + 1].startsWith('--'))
            ? args[storyIdx + 1]
            : '';

          // Canonical extraction regex — requires non-whitespace content in each slot
          // (\S.*? ensures the slot isn't whitespace-only).
          // Named groups: role / capability / outcome.
          const USER_STORY_RE = /^As a (\S.*?), I want to (\S.*?), so that (\S.*?)\.$/;

          const errors = [];
          const trimmed = story.trim();
          let slots = null;

          if (!trimmed) {
            errors.push('Story is empty. Required format: "As a [role], I want to [capability], so that [outcome]."');
          } else {
            // Per-clause guards produce targeted, actionable error messages before
            // attempting the full regex. Guards are ordered: role → capability → outcome → period.
            if (!/^As a \S/i.test(trimmed)) {
              errors.push('Story must start with "As a [user role]," (role must be non-empty).');
            }
            if (!/, I want to \S/i.test(trimmed)) {
              errors.push('Story must include ", I want to [capability]," (capability must be non-empty).');
            }
            if (!/, so that \S/i.test(trimmed)) {
              errors.push('Story must include ", so that [outcome]." (outcome must be non-empty).');
            }
            if (!trimmed.endsWith('.')) {
              errors.push('Story must end with a period (.).');
            }
            // Full-regex check only when per-clause guards all passed — avoids
            // redundant "format mismatch" noise on top of specific error messages.
            if (errors.length === 0) {
              const m = USER_STORY_RE.exec(trimmed);
              if (!m) {
                errors.push('Story does not match the canonical format: "As a [role], I want to [capability], so that [outcome]."');
              } else {
                slots = { role: m[1], capability: m[2], outcome: m[3] };
              }
            }
          }

          output({ valid: errors.length === 0, errors, slots }, raw);
  }

  function routeDriftGuard({ args, cwd, raw, error }) {
    // ADR-22: deterministic authority resolution + severity classification.
          // Subcommands:
          //   drift-guard authority                          → effective authority string
          //   drift-guard severity --status <S> [--authority <A>]  → {severity, hardBlock}
          const subcommand = args[1];

          // Read config.json directly for both plan_review.source_grounding_authority
          // and intel.enabled. Neither key is in the config-loader.cjs whitelist that
          // config-loader.cjs's loadConfig() whitelist does not return; plan_review is only in config.cjs's private
          // buildConfig(), and intel is a federated capability config key.
          let configuredAuthority = 'grep';
          let intelEnabled = false;
          try {
            const { planningDir } = require('./lib/planning-workspace.cjs');
            const cfgPath = require('path').join(planningDir(cwd), 'config.json');
            if (require('fs').existsSync(cfgPath)) {
              const rawCfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf-8'));
              if (rawCfg && rawCfg.plan_review && rawCfg.plan_review.source_grounding_authority) {
                configuredAuthority = String(rawCfg.plan_review.source_grounding_authority);
              }
              if (rawCfg && rawCfg.intel && rawCfg.intel.enabled === true) {
                intelEnabled = true;
              }
            }
          } catch {
            // not fatal — defaults apply
          }

          const effectiveAuthority = getEffectiveAuthority(configuredAuthority, intelEnabled);

          if (subcommand === 'authority') {
            // Pass rawValue as 3rd arg so --raw returns unquoted string (not JSON)
            output(effectiveAuthority, raw, effectiveAuthority);
            return;
          }

          if (subcommand === 'severity') {
            const statusIdx = args.indexOf('--status');
            const statusVal = statusIdx !== -1 ? args[statusIdx + 1] : undefined;
            if (!statusVal || statusVal.startsWith('--')) {
              error('drift-guard severity requires --status <VERIFIED|MISSING|AMBIGUOUS|UNCHECKABLE>', ERROR_REASON.SDK_UNKNOWN_COMMAND);
              return;
            }
            const authIdx = args.indexOf('--authority');
            const authVal = authIdx !== -1 ? args[authIdx + 1] : undefined;
            const authorityForClassify = (authVal && !authVal.startsWith('--'))
              ? authVal
              : effectiveAuthority;
            const result = classifyDriftSeverity({ status: statusVal, authority: authorityForClassify });
            output(result, raw);
            return;
          }

          if (subcommand === 'phase-status') {
            // #1956: deterministic STATE.md-vs-ROADMAP.md phase-status drift.
            const { planningDir } = require('./lib/planning-workspace.cjs');
            const { stateExtractField, stateCurrentPositionSlice } = require('./lib/state-document.cjs');
            const { findRoadmapProgressTable } = require('./lib/roadmap-parser.cjs');
            const { phaseKeyFromProse } = require('./lib/phase-id.cjs');
            // STATE.md's YAML frontmatter carries its own lowercase `status:`
            // scalar ahead of the body's `## Current Position` prose "Status:"
            // line; stateExtractField's non-scoped regex would otherwise match
            // that frontmatter line first (it comes first in the file) and
            // silently report the wrong value. Strip frontmatter so extraction
            // is scoped to the body.
            const { stripFrontmatter } = require('./lib/frontmatter.cjs');

            const phaseIdx = args.indexOf('--phase');
            const phaseArg = (phaseIdx !== -1 && args[phaseIdx + 1] && !args[phaseIdx + 1].startsWith('--'))
              ? args[phaseIdx + 1]
              : undefined;

            const dir = planningDir(cwd);
            const statePath = path.join(dir, 'STATE.md');
            const roadmapPath = path.join(dir, 'ROADMAP.md');

            let stateContent = null;
            try {
              stateContent = fs.readFileSync(statePath, 'utf-8');
            } catch {
              // missing_state below
            }
            if (stateContent === null) {
              const phase = phaseArg !== undefined ? phaseKeyFromProse(phaseArg) : null;
              output({
                verdict: 'uncheckable',
                reason: 'missing_state',
                phase,
                stateStatus: null,
                roadmapStatus: null,
                authority: 'STATE.md',
              }, raw);
              return;
            }

            let roadmapContent = null;
            try {
              roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
            } catch {
              // missing_roadmap below
            }

            const stateBody = stripFrontmatter(stateContent);
            // #1956 fix: scope extraction to `## Current Position` (or `###`
            // in the bootstrap template) so a historical `Phase:` / `Status:`
            // line in an archive section (e.g. `## Session Continuity
            // Archive`) can't shadow the real one — same #2956 scope state.cts
            // uses for current_phase, via the shared owner in
            // state-document.cjs.
            //
            // Deliberately NO whole-body fallback here. `state.cts`'s WRITE
            // path falls back to the whole body when no Current Position
            // heading is found (legacy behavior it must preserve for
            // backward-compatible writes) — but that fallback is wrong for a
            // READ that feeds a drift finding: a STATE.md with no Current
            // Position heading is exactly the shape that let a stray historical
            // `Status:` line elsewhere in the body shadow the real value and
            // fabricate a 'drifted' verdict. A guess is worse than an
            // abstention for a drift detector, so an absent Current Position
            // section reports 'uncheckable' instead of guessing from the whole
            // document.
            const currentPositionBody = stateCurrentPositionSlice(stateBody);
            if (currentPositionBody === null) {
              const phase = phaseArg !== undefined ? phaseKeyFromProse(phaseArg) : null;
              output({
                verdict: 'uncheckable',
                reason: 'no_current_position',
                phase,
                stateStatus: null,
                roadmapStatus: null,
                authority: 'STATE.md',
              }, raw);
              return;
            }

            // Resolve the target phase: --phase if given, else whatever
            // STATE.md's Current Position reports as current.
            const phase = phaseArg !== undefined
              ? phaseKeyFromProse(phaseArg)
              : phaseKeyFromProse(stateExtractField(currentPositionBody, 'Phase'));

            if (roadmapContent === null) {
              output({
                verdict: 'uncheckable',
                reason: 'missing_roadmap',
                phase,
                stateStatus: null,
                roadmapStatus: null,
                authority: 'STATE.md',
              }, raw);
              return;
            }

            const stateStatus = stateExtractField(currentPositionBody, 'Status');

            // #1956/#2012: scoped to `## Progress` first (decoy-avoidance) —
            // see findRoadmapProgressTable's doc comment (roadmap-parser.cts).
            const table = findRoadmapProgressTable(roadmapContent);
            const matchedRow = table
              ? table.rows.find((row) => phaseKeyFromProse(row.Phase) === phase && phase !== null)
              : undefined;

            if (!matchedRow) {
              const result = comparePhaseStatus({ stateStatus, roadmapStatus: null });
              output({
                verdict: 'uncheckable',
                reason: 'phase_not_in_roadmap',
                phase,
                stateStatus,
                roadmapStatus: null,
                stateRank: result.stateRank,
                roadmapRank: result.roadmapRank,
                authority: 'STATE.md',
              }, raw);
              return;
            }

            const roadmapStatus = matchedRow.Status;
            const result = comparePhaseStatus({ stateStatus, roadmapStatus });
            output({
              verdict: result.verdict,
              phase,
              stateStatus,
              roadmapStatus,
              stateRank: result.stateRank,
              roadmapRank: result.roadmapRank,
              authority: 'STATE.md',
            }, raw);
            return;
          }

          error(
            `Unknown drift-guard subcommand: ${subcommand || '(none)'}. Available: authority, severity, phase-status`,
            ERROR_REASON.SDK_UNKNOWN_COMMAND,
          );
  }


/**
 * #3275: resolve a DECLARED command name to the file a spawn can actually start.
 *
 * Lane descriptors (src/review-lane-descriptor.cts) declare BARE, platform-unaware
 * binary names ('codex', 'gemini', 'kimi', 'agy'), and `review-lane invoke`'s
 * `deps.spawn` + `deps.hasBinary` both need the on-disk form of that name. Before
 * this helper existed they disagreed: `hasBinary` scanned PATH WITH PATHEXT (so
 * probes reported lanes AVAILABLE on Windows) while `spawn` received the bare name
 * — `CreateProcess` performs no PATHEXT resolution, so every spawn-transport lane
 * ENOENT'd there, and the #3086 `.cmd`/`.bat` cmd.exe mediation gate never fired
 * because the declared name never carried an extension. One shared resolver is the
 * only shape that cannot drift back apart.
 *
 * win32: tries PATHEXT entries ONLY — never the bare name. npm global installs
 * drop an EXTENSIONLESS POSIX sh shim (`...\npm\codex`) next to `codex.CMD`; a
 * bare-name-first scan resolves to it, the mediation gate sees no `.cmd`, and the
 * ENOENT returns unchanged (field-reported on Windows 11 — see the #3275 issue
 * comment pinning exactly this pitfall).
 *
 * POSIX: answers EXISTENCE only (the old `hasBinary` contract, preserved
 * byte-for-byte) by scanning PATH for the bare name. `deps.spawn` does NOT consult
 * this on POSIX — the bare name goes to spawnSync unchanged and Node's own PATH
 * search does the work, so macOS/Linux behavior is untouched (#3275 acceptance).
 *
 * Path-like names (any '/' or '\') bypass the PATH scan: the name is already an
 * address, so it passes through when the file exists and is a file.
 *
 * #3411: the scan itself now lives in the declared platform seam
 * (`src/shell-command-projection.cts` → `resolveExecutableBinary`). This function is
 * the `bin/` entry point onto it and holds no copy of the logic — `CONTEXT.md`
 * declares that file "All OS-facing I/O; single platform seam", and a private
 * duplicate here is what made it untrue.
 */
function resolveSpawnBinary(name, platform = process.platform, env = process.env) {
  const { resolveExecutableBinary } = require('./lib/shell-command-projection.cjs');
  return resolveExecutableBinary(name, { platform, env });
}

const HOST_COMMAND_ROUTERS = {
  // Each entry wraps its `route*Command` router so it receives the module-scope
  // lib the old `case` arm passed, plus the per-dispatch context
  // { args, cwd, raw, error }. Closes over module-scope libs (state/phase/…)
  // exactly as the old inline arms did — byte-identical dispatch.
  state: (ctx) => routeStateCommand({ state, ...ctx }),
  phase: (ctx) => routePhaseCommand({ phase, ...ctx }),
  roadmap: (ctx) => routeRoadmapCommand({ roadmap, ...ctx }),
  verify: (ctx) => routeVerifyCommand({ verify, ...ctx }),
  // validate additionally binds the module-scope `output` emitter.
  validate: (ctx) => routeValidateCommand({ verify, output, ...ctx }),
  // init preserves the #1688 stale-bake warning (best-effort, swallowed) that
  // ran before the router in the old `case 'init':` arm.
  init: (ctx) => {
    try { warnIfStaleBake(ctx.cwd); } catch { /* guard must never break init */ }
    routeInitCommand({ init, ...ctx });
  },
  // capability → routeCapabilityCommand (ADR-2346 P2). The router is async
  // (install/upgrade/consent ops await the lifecycle); dispatchHostCommand
  // awaits it. The router imports its own io/cli-exit/deps, so no module
  // injection needed — it receives {args,cwd,raw} (+error, ignored).
  capability: routeCapabilityCommand,
  // ADR-2346 P3: resolve/git/config/research host routers. Each body was
  // relocated verbatim from its `case` arm to a module-scope function above.
  'resolve-model': routeResolveModel,
  'resolve-granularity': routeResolveGranularity,
  'resolve-execution': routeResolveExecution,
  git: routeGit,
  'config-ensure-section': routeConfigEnsureSection,
  'config-set': routeConfigSet,
  'config-set-model-profile': routeConfigSetModelProfile,
  'config-get': routeConfigGet,
  // Phase-effort estimation (#2630, ADR-2629). A PAIR of verbs, so leaves
  // rather than a family — ADR-2346 promotes to a family only at >=3.
  'estimate-check': ({ args, cwd, raw }) => estimateCli.cmdEstimateCheck(cwd, args.slice(1), raw),
  'estimate-calibration': ({ args, cwd, raw }) => estimateCli.cmdEstimateCalibration(cwd, args.slice(1), raw),
  'estimate-calibrate': ({ args, cwd, raw }) => estimateCli.cmdEstimateCalibrate(cwd, args.slice(1), raw),
  'config-new-project': routeConfigNewProject,
  'config-path': routeConfigPath,
  'migrate-config': routeMigrateConfig,
  'research-store': routeResearchStore,
  'research-plan': routeResearchPlan,
  // ADR-2346 P4: all remaining leaf commands
    'agent': routeAgent,
    'smart-entry': routeSmartEntry,
    'check': routeCheck,
    'find-phase': routeFindPhase,
    'commit': routeCommit,
    'check-commit': routeCheckCommit,
    'commit-docs-guard': routeCommitDocsGuard,
    'commit-to-subrepo': routeCommitToSubrepo,
    'pr-subrepo': routePrSubrepo,
    'verify-summary': routeVerifySummary,
    'template': routeTemplate,
    'task': routeTask,
    'frontmatter': routeFrontmatter,
    'eval': routeEval,
    'verification': routeVerification,
    'generate-slug': routeGenerateSlug,
    'current-timestamp': routeCurrentTimestamp,
    'runtime-identity': routeRuntimeIdentity,
    'project-instruction-file': routeProjectInstructionFile,
    'list-todos': routeListTodos,
    'list-seeds': routeListSeeds,
    'verify-path-exists': routeVerifyPathExists,
    'quick-tasks-append': routeQuickTasksAppend,
    'normalize-test-command': routeNormalizeTestCommand,
    'dispatch-should-flatten': routeDispatchShouldFlatten,
    'dispatch-isolation': routeDispatchIsolation,
    'inspect-dispatch-isolation': routeInspectDispatchIsolation,
    'record-dispatch-isolation': routeRecordDispatchIsolation,
    'resolve-dispatch-type': routeResolveDispatchType,
    'resolve-agent': routeResolveAgent,
    'agent-skills': routeAgentSkills,
    'skill-manifest': routeSkillManifest,
    'history-digest': routeHistoryDigest,
    'phases': routePhases,
    // #2790: read-only schema-v1 planning snapshot. The router imports its own
    // io/planning-inspect deps, so it needs no module injection — it receives
    // { args, cwd, raw, error } and ignores the rest of the dispatch context.
    'planning': routePlanningCommand,
    'assumption-delta': routeAssumptionDelta,
    'requirements': routeRequirements,
    'gap-analysis': routeGapAnalysis,
    'milestone': routeMilestone,
    'progress': routeProgress,
    'uat': routeUat,
    'stats': routeStats,
    'todo': routeTodo,
    'scaffold': routeScaffold,
    'loop': routeLoop,
    'phase-plan-index': routePhasePlanIndex,
    'state-snapshot': routeStateSnapshot,
    'summary-extract': routeSummaryExtract,
    'websearch': routeWebsearch,
    'workstream': routeWorkstream,
    'worktree': routeWorktree,
    'docs-init': routeDocsInit,
    'learnings': routeLearnings,
    'teams-status': routeTeamsStatus,
    'detect-custom-files': routeDetectCustomFiles,
    'restore-custom-files': routeRestoreCustomFiles,
    'from-gsd2': routeFromGsd2,
    'prompt-budget': routePromptBudget,
    'context-predicates': routeContextPredicates,
    'review-lane': routeReviewLane,
    'update-context': routeUpdateContext,
    'classify-confidence': routeClassifyConfidence,
    'package-legitimacy': routePackageLegitimacy,
    'effort': routeEffort,
    'user-story': routeUserStory,
    'drift-guard': routeDriftGuard,
    'windows': routeWindows,
    'skills-root': routeSkillsRoot,
};

// Returns true when consumed (suppress "Unknown command"), false to fall
// through. Prototype-pollution-safe: own-property lookup rejects
// `__proto__`/`constructor`/`prototype` command keys (same guard as
// dispatchCapabilityCommand).
async function dispatchHostCommand({ command, args, cwd, raw, error, defaultValue, workstreamContext }) {
  if (
    command === '__proto__' ||
    command === 'constructor' ||
    command === 'prototype'
  ) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(HOST_COMMAND_ROUTERS, command)) {
    return false;
  }
  const router = HOST_COMMAND_ROUTERS[command];
  if (typeof router !== 'function') return false;
  // `await` so async host routers (e.g. capability's install/upgrade ops)
  // complete before runCommand returns; sync routers pass through unchanged.
  await router({ args, cwd, raw, error, defaultValue, workstreamContext });
  return true; // consumed — don't emit "Unknown command"
}

// ─── Arg parsing helpers ──────────────────────────────────────────────────────

// ─── run-with-timeout (#2351) ─────────────────────────────────────────────────
// Portable, coreutils-independent wall-clock cap for a spawned command. Replaces
// the GNU-only `timeout <n> …` calls that were hardcoded across gsd
// workflow/agent files: stock macOS ships neither `timeout` nor `gtimeout`, so
// those calls exited 127 ("command not found") and a passing build/test was
// misreported as a FAILURE. The resolution lives here ONCE — every call site
// invokes `gsd_run run-with-timeout <secs> [--] <cmd> [args…]` instead of
// hand-rolling a `command -v timeout` probe per file.
//
// Exit-code contract (kept identical to GNU `timeout` so the existing per-site
// dispatch — `-eq 124` for timeout, `-eq 0` for pass, non-zero for fail — is
// unchanged):
//   • command exits normally       → exit with the command's own code
//   • wall-clock budget exceeded    → exit 124
//   • command killed by a signal    → exit 128+signum
//   • command not found / not exec  → exit 127 / 126 (spawn ENOENT / EACCES)
//   • bad wrapper args              → exit 2 (usage — a workflow-authoring bug)
//   • <secs> == 0                   → run with NO timer (matches `timeout 0`)
//   • blank / negative / NaN <secs> → exit 2 (usage — fails SAFE, never unbounded)
//
// The wrapped command's argv is OPAQUE: this executes BEFORE gsd-tools' own
// global-flag parsing (see main()), so a wrapped `--raw`/`--cwd`/`--pick` passes
// through verbatim rather than being consumed by this dispatcher. stdio is
// inherited so shell pipes (`echo x | gsd_run run-with-timeout …`) and redirects
// keep working. No shell is spawned (argv array) — no injection surface beyond
// the old `timeout … bash -c "$CMD"`.
function runWithTimeout(argv) {
  const { spawn } = require('node:child_process');
  const os = require('node:os');

  const USAGE = 'Usage: gsd_run run-with-timeout <seconds> [--] <command> [args...]';
  const usageError = (msg) => new ExitError(2, `run-with-timeout: ${msg}\n${USAGE}`);

  const rawSecs = argv[0];
  if (rawSecs === undefined) throw usageError('missing <seconds>');
  // Accept a bare number or a GNU-style trailing `s` unit (the only unit callers
  // use). A blank/whitespace value is a USAGE ERROR — never a silent "no timer",
  // which would drop the wall-clock bound if a config value ever resolved to "".
  const secsText = String(rawSecs).trim().replace(/s$/, '');
  const secs = Number(secsText);
  if (secsText === '' || !Number.isFinite(secs) || secs < 0) {
    throw usageError(`invalid <seconds>: ${rawSecs}`);
  }

  let i = 1;
  if (argv[i] === '--') i += 1; // optional POSIX end-of-options separator
  const cmd = argv[i];
  if (cmd === undefined) throw usageError('missing <command>');
  const cmdArgs = argv.slice(i + 1);

  const isWin = process.platform === 'win32';
  // Detached (own process group) on POSIX so a timeout can reap the WHOLE tree —
  // a bare child.kill() misses grandchildren (e.g. a test runner's workers) and
  // would not actually bound the wall clock. Windows has no POSIX process
  // groups; a direct kill is the best portable option there.
  const detached = !isWin && secs > 0;
  const spawnFailureCode = (err) =>
    (err && err.code === 'ENOENT' ? 127 : err && err.code === 'EACCES' ? 126 : 125);
  // #2667: on Windows, a `.cmd`/`.bat`/`.exe` command cannot be spawned directly
  // — Node's CVE-2024-27980 hardening (April 2024, all active lines incl. 22.x)
  // throws EINVAL when child_process.spawn is given a `.cmd`/`.bat` without a
  // shell, so e.g. `run-with-timeout 120 -- node_modules/.bin/fallow.cmd` silently
  // produced empty stdout + exit 125 and the fallow pre-pass no-op'd.
  //
  // We do NOT use `shell: true` for this: with `shell:true`, Node space-joins the
  // unescaped cmdArgs into a cmd.exe command string (DEP0190) — that would re-open
  // a shell-injection surface and violate the recorded no-shell-for-argv-array
  // contract (DEFECT.UNBOUNDED-SUBPROCESS, CONTEXT.md:772). Instead we spawn
  // `cmd.exe /c <cmd> <args>` with an explicit argv ARRAY, which is what Node's
  // own exec does internally and keeps every arg a discrete, un-interpolated
  // token. The gate is NARROW: it fires ONLY for the Windows shim extensions,
  // never for the `bash -c` callers (command is `bash`, no such suffix), so the 7
  // bash callers keep their array-only argv on every platform. POSIX untouched.
  // NOTE: .exe is INTENTIONALLY excluded — real PE executables (node.exe, etc.)
  // spawn fine directly and mediating them through cmd.exe /c breaks the timeout
  // cap's process-group kill (the wrapped child escapes reap → exit 124 never
  // fires) and risks cmd.exe mis-parsing an arg like `-e "setTimeout(()=>{})"`.
  // Only .cmd/.bat are the CVE-2024-27980 EINVAL cases that require mediation.
  const winShim = isWin && /\.(cmd|bat)$/i.test(path.basename(cmd));
  const spawnCmd = winShim ? (process.env.ComSpec || 'cmd.exe') : cmd;
  const spawnArgs = winShim ? ['/d', '/s', '/c', cmd, ...cmdArgs] : cmdArgs;
  // Node's setTimeout delay is a 32-bit signed ms int; a larger value silently
  // clamps to 1ms → a spurious immediate timeout. Cap the budget (~24.8 days).
  const timerMs = Math.min(Math.round(secs * 1000), 2 ** 31 - 1);

  // Resolve with the numeric exit code — never process.exit() (banned by
  // n/no-process-exit). main() returns this code and runMain() maps it to
  // process.exitCode, so stdout/stderr flush and cleanup hooks still fire.
  return new Promise((resolve) => {
    let child;
    try {
      // #2667: on win32 `.cmd`/`.bat`/`.exe`, spawn cmd.exe with an explicit argv
      // array (spawnCmd/spawnArgs) rather than the shim directly — preserves the
      // array-only, no-shell-string argv contract. `detached` is always false on
      // win32, so it never co-occurs with the cmd.exe mediation.
      child = spawn(spawnCmd, spawnArgs, { stdio: 'inherit', detached });
    } catch (err) {
      process.stderr.write(`run-with-timeout: ${cmd}: ${err && err.message ? err.message : 'failed to start'}\n`);
      resolve(spawnFailureCode(err));
      return;
    }

    const killTree = (signal) => {
      try {
        if (detached && child.pid) {
          try { process.kill(-child.pid, signal); return; } catch { /* group already gone */ }
        }
        child.kill(signal);
      } catch { /* already exited */ }
    };

    let timedOut = false;
    let killTimer = null;
    // Backstop SIGKILL for a descendant that traps SIGTERM. The child keeps the
    // event loop alive until this fires, so it stays ref'd (not unref'd).
    const armEscalation = () => {
      if (!killTimer) killTimer = setTimeout(() => killTree('SIGKILL'), 3000);
    };

    const timer = secs > 0
      ? setTimeout(() => { timedOut = true; killTree('SIGTERM'); armEscalation(); }, timerMs)
      : null;

    // Forward an interrupt to the child tree rather than dying and orphaning it
    // (GNU `timeout` forwards received signals). Without this, SIGINT/SIGTERM to
    // the wrapper — Ctrl-C, CI cancellation — would leave the detached child
    // running unbounded with no supervisor left to enforce the cap.
    const onSignal = (sig) => { killTree(sig); armEscalation(); };
    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    const finish = (exitCode) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      resolve(exitCode);
    };

    child.on('error', (err) => {
      process.stderr.write(`run-with-timeout: ${cmd}: ${err && err.message ? err.message : 'failed to start'}\n`);
      finish(spawnFailureCode(err));
    });

    child.on('exit', (code, signal) => {
      if (timedOut) {
        // The direct child exited on our SIGTERM, but a SIGTERM-trapping descendant
        // may still hold the inherited stdio — orphaning it would hang a captured
        // or piped gate. Reap the whole group SYNCHRONOUSLY here; the escalation
        // timer can't fire once we resolve and the loop drains.
        killTree('SIGKILL');
        finish(124); // matches GNU `timeout`
        return;
      }
      if (signal) {
        const num = os.constants.signals[signal] || 0;
        finish(num ? 128 + num : 1); // bash's 128+signum convention
        return;
      }
      finish(code == null ? 1 : code);
    });
  });
}

// ─── CLI Router ───────────────────────────────────────────────────────────────

// Top-level usage string — emitted by `gsd-tools` (no args) and by
// `gsd-tools --help` / any `--help` request below.
// CR feedback: the command list must enumerate every top-level command
// supported by the dispatcher so `--help` is actually useful for
// discovery; previously it was a partial subset that didn't include
// phase / roadmap / milestone / progress / etc.
//
// Module-scoped (not function-local) so it can be exported and compared
// against HOST_COMMAND_ROUTERS in a parity test (DEFECT.GENERATIVE-FIX) —
// this string and HOST_COMMAND_ROUTERS/SKIP_ROOT_RESOLUTION are three
// independently hand-maintained sites and nothing previously caught them
// drifting apart when a query command was added to only one or two.
const TOP_LEVEL_USAGE = 'Usage: gsd-tools <command> [args] [--raw] [--pick <field>] [--cwd <path>] [--project-dir <path>] [--ws <name>] [--json-errors] [--exit-contract=<v>]\n' +
  'Commands: agent, agent-skills, assumption-delta, audit-open, audit-uat, check, check-commit, commit, commit-docs-guard, commit-to-subrepo, pr-subrepo, ' +
  'config-ensure-section, config-get, config-new-project, config-path, config-set, migrate-config, normalize-test-command, ' +
  'context-predicates, current-timestamp, detect-custom-files, docs-init, drift-guard, effort, extract-messages, find-phase, ' +
  'from-gsd2, frontmatter, gap-analysis, generate-claude-md, generate-claude-profile, ' +
  'generate-dev-preferences, generate-slug, graphify, history-digest, init, intel, ' +
  'capability, classify-confidence, git, learnings, list-seeds, list-todos, loop, milestone, package-legitimacy, phase, phase-plan-index, phases, planning, profile-questionnaire, ' +
  'profile-sample, progress, project-instruction-file, prompt-budget, quick-tasks-append, requirements, research-plan, research-store, resolve-granularity, resolve-model, restore-custom-files, roadmap, runtime-identity, scaffold, smart-entry, state, ' +
  'config-set-model-profile, dispatch-isolation, dispatch-should-flatten, inspect-dispatch-isolation, record-dispatch-isolation, estimate-calibrate, estimate-calibration, estimate-check, resolve-agent, resolve-dispatch-type, ' +
  'resolve-execution, review-lane, skill-manifest, skills-root, state-snapshot, stats, summary-extract, teams-status, todo, uat, update-context, verification, websearch, windows, ' +
  'task, template, user-story, validate, verify, verify-path-exists, verify-summary, eval, workstream, worktree\n\n' +
  'Global flags:\n' +
  '  --raw              Emit raw output without post-processing\n' +
  '  --pick <field>     Extract a single field from JSON output (dot/bracket notation)\n' +
  '  --cwd <path>       Override working directory for project-root resolution\n' +
  '  --project-dir <path>  Explicit project root; skips the ancestor walk-up entirely (must already contain .planning/)\n' +
  '  --ws <name>        Override active workstream (or set GSD_WORKSTREAM)\n' +
  '  --json-errors      Emit structured JSON error objects on stderr (or set GSD_JSON_ERRORS=1)\n' +
  '  --exit-contract=<v>  Exit-code contract version: v1 (default) or v2 (or set GSD_EXIT_CONTRACT)\n\n' +
  'For command-specific argument requirements, invoke the command without args ' +
  '(e.g. `gsd-tools phase add`) — the resulting error lists what is required.';

// Multi-repo guard: resolve project root for commands that read/write .planning/.
// Skip for pure-utility commands that don't touch .planning/ to avoid unnecessary
// filesystem traversal on every invocation.
// 'loop' and 'capability' are intentionally NOT in SKIP_ROOT_RESOLUTION.
// Both are registry/config queries that resolve activation via
// .planning/config.json; they need the project root (cwd) for correct
// `when` key resolution. If one is ever moved to SKIP_ROOT_RESOLUTION,
// move the other at the same time (keep them consistent).
//
// Module-scoped for the same reason as TOP_LEVEL_USAGE above — kept
// module-private and exposed to the dispatch-table/help-string/skip-list
// parity test only through the read-only skipsRootResolution() predicate
// below (never as the live Set itself; see that function's doc comment).
const SKIP_ROOT_RESOLUTION = new Set([
  'generate-slug', 'current-timestamp', 'verify-path-exists',
  // #3146: runtime-identity is a pure local read of baked package coordinates.
  // It is probed from whatever cwd a workflow happens to be in — including
  // outside any project — so it must never require a resolvable project root.
  'runtime-identity',
  // #2844: verify-summary was previously skipped, leaving relative file-claim
  // paths resolved against the raw process.cwd() — invoking from a subdirectory
  // manufactured "missing files" on an otherwise-correct SUMMARY. It now goes
  // through findProjectRoot so claims resolve against the project root.
  'template', 'frontmatter', 'detect-custom-files',
  // #1854: restore-custom-files operates on a runtime config dir passed
  // explicitly via --config-dir; it never reads .planning/.
  'restore-custom-files',
  'worktree', 'prompt-budget',
  // context-predicates is a pure repo-root CONTEXT.md read (like
  // prompt-budget); it never touches .planning/, so it needs no project
  // root resolution and must work from any cwd (including one with no
  // .planning/ directory at all).
  'context-predicates',
  'research-store', 'research-plan', 'package-legitimacy', 'classify-confidence',
  'user-story', // pure string validation — no .planning/ access needed
  // #1529: pure runtime→filename projection via getProjectInstructionFile; no
  // .planning/ access needed, and resolving project root would break workflow
  // invocations that run before .planning/ exists (new-project Step 1).
  'project-instruction-file',
  // #1579: eval.score is pure arithmetic (covered/total + infra weights); it
  // needs no .planning/ access, so skip the findProjectRoot traversal.
  'eval',
]);

// Read-only accessor for SKIP_ROOT_RESOLUTION (DEFECT.MUTABLE-EXPORTED-SET,
// #2928 review). The Set above stays module-private and mutable internally
// (main() only ever calls .has() on it), but exporting the live Set directly
// would let any importer call .add()/.delete() on it — Object.freeze() does
// not lock Set.prototype.add/delete, so freezing the instance would not have
// closed this — and silently change dispatch behavior for every caller in the
// process. Export this predicate instead; it exposes membership without
// exposing a mutation surface.
function skipsRootResolution(command) {
  return SKIP_ROOT_RESOLUTION.has(command);
}

/**
 * Resolve the worktree root for a given cwd, warning to stderr when git
 * could not determine it (reason 'git_timed_out') rather than silently
 * trusting a best-effort fallback (#3050). Extracted from main() so it can
 * be driven directly in tests via injected deps.
 *
 * @param {string} cwd
 * @param {{ existsSync?: (p: string) => boolean, resolveWorktreeRoot?: (cwd: string) => { root: string, reason: string }, writeWarning?: (msg: string) => void }} [deps]
 * @returns {string} resolved cwd
 */
function resolveMainWorktreeCwd(cwd, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const resolveWorktreeRoot = deps.resolveWorktreeRoot || require('./lib/worktree-safety.cjs').resolveWorktreeRoot;
  const writeWarning = deps.writeWarning || ((msg) => process.stderr.write(msg));

  if (existsSync(path.join(cwd, '.planning'))) {
    return cwd;
  }
  const { root: worktreeRoot, reason: worktreeRootReason } = resolveWorktreeRoot(cwd);
  if (worktreeRootReason === 'git_timed_out') {
    writeWarning(
      'WARNING: could not determine the git worktree root (git timed out). ' +
      'Planning artifacts (STATE.md, ROADMAP.md, etc.) may be written to the ' +
      `wrong tree — proceeding with "${worktreeRoot}" as a best-effort fallback. ` +
      'Retry the command; if this persists, check for a stalled filesystem mount ' +
      'or a stale git index lock (.git/index.lock) in this worktree.\n'
    );
  }
  return worktreeRoot;
}

async function main() {
  let args = process.argv.slice(2);

  // These two global-flag blocks (--json-errors, --exit-contract) MUST run
  // BEFORE the run-with-timeout interception below. run-with-timeout treats
  // args[0] (post `query` stripping) as the sentinel and otherwise passes the
  // remaining argv straight to the wrapped child — it never reaches the
  // dispatcher's "Unknown command" fallback, but a global flag left in LEADING
  // position (e.g. `--exit-contract=v2 run-with-timeout ...`) would be spliced
  // out too late if these ran after, since neither block currently exists
  // below this point to consume it. Splicing here, before run-with-timeout's
  // own argv slicing, is what keeps both flags position-independent for every
  // command, run-with-timeout included. Do not move these back below the
  // run-with-timeout block (#confirmed regression: leading --exit-contract=v2
  // and leading --json-errors both broke run-with-timeout when these blocks
  // sat after it).

  // --json-errors / GSD_JSON_ERRORS=1: when active, error() emits structured
  // JSON ({ ok: false, reason: <ERROR_REASON code>, message }) to stderr
  // instead of "Error: <text>". Lets test suites assert on typed reason codes
  // per CONTRIBUTING.md "Prohibited: Raw Text Matching" (#2974).
  //
  // Detect early — before any flag parsing that can fire error() — so even
  // --cwd and workstream-resolution failures emit structured stderr (#3310).
  // The argv splice must happen here too, otherwise the dispatcher below sees
  // "--json-errors" as an unknown command. Default off — human operators keep
  // their plain-text diagnostic.
  const jsonErrorsIdx = args.indexOf('--json-errors');
  if (jsonErrorsIdx !== -1) {
    setJsonErrorMode(true);
    args.splice(jsonErrorsIdx, 1);
  } else if (process.env.GSD_JSON_ERRORS === '1') {
    setJsonErrorMode(true);
  }

  // --exit-contract=<v> / GSD_EXIT_CONTRACT: resolve FIRST, before the splice
  // below, so an invalid value (e.g. `v3`, or an empty `--exit-contract=`)
  // throws EARLY — matching the --json-errors block's own "detect early,
  // before any flag parsing that can fire error()" rationale above. This also
  // memoizes the resolved version into the shared contract-version cell so a
  // later terminateNow()/runMain() call projects against it correctly.
  //
  // The argv splice must happen here too, otherwise the dispatcher below sees
  // "--exit-contract=<v>" as an unknown command when the flag is given in
  // LEADING position (argv[0] is what the dispatcher treats as the command
  // name). Splice EVERY occurrence, not just the first — findExitContractFlag
  // only consults the first match, so a stray second token would otherwise
  // survive into the dispatcher and reproduce the same "Unknown command".
  resolveContractVersion({ argv: process.argv, env: process.env });
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'string' && args[i].startsWith('--exit-contract=')) {
      args.splice(i, 1);
    }
  }

  // #2351: run-with-timeout bounds a spawned command's wall clock portably
  // (coreutils-independent). It MUST intercept HERE, before the remaining
  // flag parsing below — the wrapped command's argv is opaque and may itself
  // contain --raw / --cwd / --pick that this dispatcher would otherwise
  // consume. (--json-errors / --exit-contract are handled above this block,
  // not below, precisely so they keep working with run-with-timeout.)
  {
    let rwt = args;
    if (rwt[0] === 'query') rwt = rwt.slice(1);
    if (rwt[0] === 'run-with-timeout') {
      // Return the child's exit code; runMain() maps it to process.exitCode.
      return runWithTimeout(rwt.slice(1));
    }
  }

  // Optional cwd override for sandboxed subagents running outside project root.
  let cwd = process.cwd();
  const cwdEqArg = args.find(arg => arg.startsWith('--cwd='));
  const cwdIdx = args.indexOf('--cwd');
  if (cwdEqArg) {
    const value = cwdEqArg.slice('--cwd='.length).trim();
    if (!value) error('Missing value for --cwd', ERROR_REASON.USAGE);
    args.splice(args.indexOf(cwdEqArg), 1);
    cwd = path.resolve(value);
  } else if (cwdIdx !== -1) {
    const value = args[cwdIdx + 1];
    if (!value || value.startsWith('--')) error('Missing value for --cwd', ERROR_REASON.USAGE);
    args.splice(cwdIdx, 2);
    cwd = path.resolve(value);
  }

  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    error(`Invalid --cwd: ${cwd}`, ERROR_REASON.USAGE);
  }

  // #3881: --project-dir <path> is a documented (docs/CONFIGURATION.md,
  // "Project-Root Resolution in Multi-Repo Workspaces") explicit override of
  // the project root. It is idempotent under findProjectRoot's ancestor
  // walk-up — i.e. it short-circuits the walk-up rather than seeding it —
  // so it MUST be validated and applied here, before findProjectRoot ever
  // runs, and its result must skip that call entirely below. A relative
  // value resolves against process.cwd(), matching --cwd's own resolution.
  let projectDirExplicit = false;
  const projectDirEqArg = args.find(arg => arg.startsWith('--project-dir='));
  const projectDirIdx = args.indexOf('--project-dir');
  let projectDirValue;
  if (projectDirEqArg) {
    projectDirValue = projectDirEqArg.slice('--project-dir='.length).trim();
    if (!projectDirValue) error('Missing value for --project-dir', ERROR_REASON.USAGE);
    args.splice(args.indexOf(projectDirEqArg), 1);
  } else if (projectDirIdx !== -1) {
    projectDirValue = args[projectDirIdx + 1];
    if (!projectDirValue || projectDirValue.startsWith('--')) error('Missing value for --project-dir', ERROR_REASON.USAGE);
    args.splice(projectDirIdx, 2);
  }
  if (projectDirValue !== undefined) {
    const resolvedProjectDir = path.resolve(projectDirValue);
    if (!fs.existsSync(resolvedProjectDir) || !fs.statSync(resolvedProjectDir).isDirectory()) {
      error(`Invalid --project-dir: ${resolvedProjectDir} (path does not exist or is not a directory)`, ERROR_REASON.USAGE);
    }
    const resolvedProjectDirPlanning = path.join(resolvedProjectDir, '.planning');
    if (!fs.existsSync(resolvedProjectDirPlanning) || !fs.statSync(resolvedProjectDirPlanning).isDirectory()) {
      error(`Invalid --project-dir: ${resolvedProjectDir} (no .planning/ directory found — --project-dir must name the project root itself, not an ancestor to walk up from)`, ERROR_REASON.USAGE);
    }
    cwd = resolvedProjectDir;
    projectDirExplicit = true;
  }

  // Resolve worktree root: in a linked worktree, .planning/ lives in the main worktree.
  // However, in monorepo worktrees where the subdirectory itself owns .planning/,
  // skip worktree resolution — the CWD is already the correct project root.
  cwd = resolveMainWorktreeCwd(cwd);

  // Optional workstream override for parallel milestone work.
  // Priority: --ws flag > GSD_WORKSTREAM env var > session/shared pointer > null.
  let workstreamContext = null;
  try {
    // #3579 root-cause fix: this bootstrap resolution only decides whether to
    // populate GSD_WORKSTREAM env for downstream routing — it is a check, not
    // the consuming read. Using the mutating getActiveWorkstream here
    // self-healed (cleared) a present-but-unresolvable pointer BEFORE the
    // dispatched command's own resolution/diagnostic ran, so a second read in
    // the same process (e.g. a subcommand's own getActiveWorkstream call, or
    // a fail-safe guard's diagnoseUnresolvedActiveWorkstream) observed
    // already-cleared state — silently falling through to a fallback marker
    // it should never have inherited (isolation violation), or losing the
    // evidence a diagnostic needed to explain why nothing resolved. peek
    // shares the identical resolution logic and only differs by never
    // calling adapter.clear(); self-heal still happens, exactly once, at
    // whichever call site actually consumes the workstream for real.
    workstreamContext = resolveActiveWorkstream(cwd, args, process.env, {
      getStored: peekActiveWorkstream,
    });
    args = workstreamContext.args;
    // Set env var so all modules (planningDir, planningPaths) auto-resolve workstream paths.
    applyResolvedWorkstreamEnv(workstreamContext, process.env);
  } catch (err) {
    error(err.message || String(err));
  }

  const rawIndex = args.indexOf('--raw');
  const raw = rawIndex !== -1;
  if (rawIndex !== -1) args.splice(rawIndex, 1);

  // --pick <name>: extract a single field from JSON output (replaces jq dependency).
  // Supports dot-notation (e.g., --pick workflow.research) and bracket notation
  // for arrays (e.g., --pick directories[-1]).
  const pickIdx = args.indexOf('--pick');
  let pickField = null;
  if (pickIdx !== -1) {
    pickField = args[pickIdx + 1];
    if (!pickField || pickField.startsWith('--')) error('Missing value for --pick', ERROR_REASON.USAGE);
    args.splice(pickIdx, 2);
  }

  // --default <value>: for config-get, return this value instead of erroring
  // when the key is absent. Allows workflows to express optional config reads
  // without defensive `2>/dev/null || true` boilerplate (#1893).
  const defaultIdx = args.indexOf('--default');
  let defaultValue = undefined;
  if (defaultIdx !== -1) {
    defaultValue = args[defaultIdx + 1];
    if (defaultValue === undefined) defaultValue = '';
    args.splice(defaultIdx, 2);
  }

  let command = args[0];

  // Accept `query` as a meta-prefix for canonical dotted/spaced commands.
  // Workflows may call `node gsd-tools.cjs query <command>` directly.
  if (command === 'query') {
    args.shift();
    command = args[0];
  }

  // #3243: accept dotted canonical form (e.g. `state.update`) as well as the
  // spaced form (`state update`). Some workflow callers pass the dotted
  // canonical form directly; this normalization keeps both forms valid.
  //
  // Split on the FIRST dot only — `check.decision-coverage-plan` becomes
  // command='check', args=['check','decision-coverage-plan',...rest].
  // Guard: head and rest must both be non-empty (rejects leading-dot args like
  // ".hidden" and bare-dot ".").
  const originalCommand = command; // preserved for "Unknown command" suggestion
  if (typeof command === 'string' && command.includes('.')) {
    const dotIdx = command.indexOf('.');
    const head = command.slice(0, dotIdx);
    const rest = command.slice(dotIdx + 1);
    if (head && rest) {
      command = head;
      args = [head, rest, ...args.slice(1)];
    }
  }

  if (!command) {
    error(TOP_LEVEL_USAGE);
  }

  // #3019: a `--help` / `-h` flag in argv must render the top-level usage
  // and exit 0 — not error out with "Unknown flag". The previous shape
  // erred on agent-hallucinated flags, but it also blocked humans from
  // discovering the command surface via subcommand help requests routed
  // through this dispatcher. Rendering top-level usage on --help is strictly
  // better UX than the old short-circuit that printed unrelated usage text.
  const HELP_FLAGS = new Set(['-h', '--help', '-?', '--h', '--usage']);
  if (args.some((a) => HELP_FLAGS.has(a))) {
    process.stdout.write(TOP_LEVEL_USAGE + '\n');
    return;
  }

  // Reject version flags. AI agents sometimes hallucinate --version on tool
  // invocations; silently ignoring it can cause destructive operations to
  // proceed unchecked. (Help flags are handled above.)
  const NEVER_VALID_FLAGS = new Set(['--version', '-v']);
  for (const arg of args) {
    if (NEVER_VALID_FLAGS.has(arg)) {
      error(`Unknown flag: ${arg}\ngsd-tools does not accept version flags. Run "gsd-tools" with no arguments for usage.`, ERROR_REASON.USAGE);
    }
  }

  // #3881: an explicit --project-dir already IS the resolved project root
  // (validated above) — findProjectRoot's ancestor walk-up must not run
  // over it, per docs/CONFIGURATION.md's documented idempotence.
  if (!projectDirExplicit && !SKIP_ROOT_RESOLUTION.has(command)) {
    cwd = findProjectRoot(cwd);
  }

  // When --pick is active, capture stdout and extract the requested field.
  // ADR-3473 §8.4 (#3365, #3358): an absent field or non-JSON command output
  // is a failure ("I could not answer"), never a demotion to an empty answer
  // at exit 0. `resolveAtFileOutput` MUST run before JSON.parse — @file:
  // payloads (io.cjs output() writes these for JSON > 50KB) are not
  // themselves JSON text, so resolving late would make every large result a
  // false "output was not JSON" (negative space N8).
  if (pickField) {
    const captured = await captureStdoutSyncWrites(async () => {
      await runCommand(command, args, cwd, raw, defaultValue, originalCommand, workstreamContext);
    });
    const resolved = resolveAtFileOutput(captured);
    let obj;
    try {
      obj = JSON.parse(resolved);
    } catch {
      error(`--pick ${formatDiagnosticToken(pickField)}: command output was not JSON`, ERROR_REASON.PICK_OUTPUT_NOT_JSON);
      return;
    }
    const { found, value } = extractField(obj, pickField);
    if (!found) {
      const rootDescription = isPlainRecord(obj)
        ? `available top-level keys: ${Object.keys(obj).map(formatKeyForDiagnosticList).join(', ') || '(none)'}`
        : `the command's output is a JSON ${describeJsonRootType(obj)}, not an object with that field`;
      error(`--pick ${formatDiagnosticToken(pickField)}: field not found; ${rootDescription}`, ERROR_REASON.PICK_FIELD_ABSENT);
      return;
    }
    // N1/N2: `null` and `''` are answers, not failures — an absent field
    // above already exited non-zero, so reaching here means the field EXISTS
    // and this is its real value (including `0` and `false`, #3365).
    const result = value === null || value === undefined ? '' : String(value);
    fs.writeSync(1, result);
    return;
  }

  // Intercept stdout to transparently resolve @file: references (#1891).
  // io.cjs output() writes @file:<path> when JSON > 50KB. The --pick path
  // already resolves this, but the normal path wrote @file: to stdout, forcing
  // every workflow to have a bash-specific `if [[ "$INIT" == @file:* ]]` check
  // that breaks on PowerShell and other non-bash shells.
  const captured = await captureStdoutSyncWrites(async () => {
    await runCommand(command, args, cwd, raw, defaultValue, originalCommand, workstreamContext);
  });
  fs.writeSync(1, resolveAtFileOutput(captured));
}

function captureStdoutSyncWrites(run) {
  const originalWriteSync = fs.writeSync;
  let captured = '';

  fs.writeSync = function patchedWriteSync(fd, data, ...rest) {
    if (fd === 1) {
      if (Buffer.isBuffer(data)) {
        captured += data.toString('utf-8');
        return data.length;
      }
      const text = String(data);
      captured += text;
      let encoding = 'utf-8';
      if (typeof rest[1] === 'string') encoding = rest[1];
      return Buffer.byteLength(text, encoding);
    }
    return originalWriteSync.call(fs, fd, data, ...rest);
  };

  const restore = () => {
    fs.writeSync = originalWriteSync;
  };

  return Promise.resolve()
    .then(() => run())
    .then(() => {
      restore();
      return captured;
    }, (err) => {
      restore();
      // The wrapped command may have written to stdout BEFORE it threw — e.g. a --raw
      // command that emits a JSON result/error envelope and THEN throws ExitError to set a
      // non-zero exit code (capability set/disable on an unknown id). Without this flush that
      // captured output is silently discarded (the success-path flush at the call site never
      // runs on a throw). Emit it now; the error still propagates so the exit code is preserved.
      if (captured) {
        try { originalWriteSync.call(fs, 1, resolveAtFileOutput(captured)); } catch { /* best-effort flush */ }
      }
      throw err;
    });
}

function resolveAtFileOutput(captured) {
  if (!captured.startsWith('@file:')) return captured;
  return fs.readFileSync(captured.slice(6), 'utf-8');
}

// A plain object root/intermediate value — everything else (null, an array,
// a number, a string, a boolean) is treated as non-object for NAMED-key
// lookup purposes (#3365 / #3358, ADR-3473 §8.4): only bracket notation may
// reach into an array.
function isPlainRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Describes the JSON root's shape for a --pick "field not found" message
// when the root is NOT a plain object (so listing "top-level keys" would be
// meaningless).
function describeJsonRootType(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

// A command's JSON output can be a USER-authored document (e.g. `frontmatter
// get`), so its top-level keys are untrusted the same way an argv token is.
// `formatDiagnosticToken` (io.cjs) is the shared escape (see its JSDoc for
// why `error()` cannot do this itself); this thin wrapper reuses that exact
// escaping but strips the surrounding quotes JSON.stringify adds, so a key
// list reads as "a, b, c" rather than the noisier "\"a\", \"b\", \"c\"" while
// a key containing \n/\r/\t/other C0 bytes still cannot forge a second
// stderr "Error:" line or span more than one line.
function formatKeyForDiagnosticList(key) {
  return formatDiagnosticToken(key).slice(1, -1);
}

/**
 * Extract a field from an object using dot-notation and bracket syntax.
 * Supports: 'field', 'parent.child', 'arr[-1]', 'arr[0]'
 *
 * Returns a discriminated `{ found, value }` rather than a bare value so a
 * caller can distinguish "the field exists and is null/''/0/false" (an
 * ANSWER, exit 0) from "no such field" (an absence, exit non-zero) — #3365.
 * Reports NOT-FOUND for: a missing key; a dotted path that dies partway; an
 * array index out of range (after negative-index normalization); a bracket
 * applied to a non-array; and any key lookup against a non-object (null, a
 * number, a string, a boolean, or an array root).
 */
function extractField(obj, fieldPath) {
  const parts = fieldPath.split('.');
  let current = obj;
  for (const part of parts) {
    const bracketMatch = part.match(/^(.+?)\[(-?\d+)]$/);
    if (bracketMatch) {
      const key = bracketMatch[1];
      const index = parseInt(bracketMatch[2], 10);
      if (!isPlainRecord(current)) return { found: false, value: undefined };
      const arr = current[key];
      if (!Array.isArray(arr)) return { found: false, value: undefined };
      const resolvedIndex = index < 0 ? arr.length + index : index;
      if (resolvedIndex < 0 || resolvedIndex >= arr.length) return { found: false, value: undefined };
      current = arr[resolvedIndex];
    } else {
      if (!isPlainRecord(current)) return { found: false, value: undefined };
      if (!Object.prototype.hasOwnProperty.call(current, part)) return { found: false, value: undefined };
      current = current[part];
    }
  }
  return { found: true, value: current };
}

async function runCommand(command, args, cwd, raw, defaultValue, originalCommand, workstreamContext = null) {
  switch (command) {

    default: {
      // ADR-959: try capability-registry dispatch before emitting the unknown-command error.
      // An unmigrated command still hits its hardcoded `case` above — untouched.
      // A migrated command's `case` is removed at cutover, so it reaches here and
      // dispatchCapabilityCommand routes it to the capability's registered router.
      // commandFamilies now includes migrated capabilities (e.g. graphify → graphify-command-router.cjs);
      // this returns true when a registered capability owns the command, false otherwise.
      if (dispatchCapabilityCommand({ command, args, cwd, raw, error })) break;

      // ADR-1244 Phase 5 (D7): if no first-party family owns the command, try an INSTALLED
      // THIRD-PARTY (overlay) capability — dispatched only if committed/consented and only by
      // require()-ing its router FROM the capability's install root (confined to that root).
      if (dispatchOverlayCapabilityCommand({ command, args, cwd, raw, error })) break;

      // ADR-2346 (epic #2345): host dispatch table — core, non-capability
      // commands (state, …) routed via their `route*Command` router instead of
      // a hardcoded `case` arm. Tried after capability/overlay dispatch and
      // before the unknown-command error.
      if (await dispatchHostCommand({ command, args, cwd, raw, error, defaultValue, workstreamContext })) break;

      // #3243: if the caller passed a dotted form (e.g. "foo.bar"), the shim
      // above split it so `command` here is the head ("foo"). Use
      // originalCommand to reconstruct the original dotted form and suggest
      // the spaced equivalent — surfacing a useful diagnostic instead of just
      // "Unknown command: foo".
      const wasDotted =
        typeof originalCommand === 'string' &&
        originalCommand !== command &&
        originalCommand.includes('.');
      let suggestion = '';
      if (wasDotted) {
        const dotIdx = originalCommand.indexOf('.');
        const head = originalCommand.slice(0, dotIdx);
        const rest = originalCommand.slice(dotIdx + 1);
        suggestion = ` — did you mean: "${head} ${rest}"?`;
      }
      error(`Unknown command: ${command}${suggestion}`, ERROR_REASON.SDK_UNKNOWN_COMMAND);
    }
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
if (require.main === module) {
  runMain(main);
}

// ─── Exports (for tests) ──────────────────────────────────────────────────────
// ADR-959: export dispatchCapabilityCommand so tests can exercise it with
// synthetic registry + requireModule injections.
// ADR-1244 Phase 5: export dispatchOverlayCapabilityCommand + defaultRequireFromInstallRoot for
// the third-party overlay dispatch + install-root confinement tests.
module.exports = {
  dispatchCapabilityCommand,
  dispatchOverlayCapabilityCommand,
  defaultRequireFromInstallRoot,
  dispatchHostCommand,
  HOST_COMMAND_ROUTERS,
  TOP_LEVEL_USAGE,
  skipsRootResolution,
  resolveMainWorktreeCwd,
  // #3275: exported for tests — the shared PATH+PATHEXT resolver behind
  // review-lane invoke's `deps.spawn` / `deps.hasBinary` seams.
  resolveSpawnBinary,
  // #3714 follow-up: exported for tests — the dispatch model-pin VALUE
  // policy (charset accept/render parity, max-length boundary, leading-char
  // anchor) is otherwise unreachable from outside the dispatchOverlayCapabilityCommand closure.
  resolveDispatchModelPin,
  MODEL_ID_CHARSET_RE,
  // The shared character-class body both MODEL_ID_CHARSET_RE and
  // MODEL_ID_SANITIZE_STRIP_RE are derived from — exported so a test can
  // assert its own expected charset literal EQUALS this value, making a
  // silent widening of the production body fail the test instead of only
  // the (unexported) regexes built from it.
  MODEL_ID_CHARSET_BODY,
  // Non-global companion of the internal g-flagged sanitize regex — see the
  // comment at its definition for why the g-flagged instance is never
  // exported.
  MODEL_ID_SANITIZE_STRIP_RE,
  MODEL_ID_MAX_LENGTH,
};

