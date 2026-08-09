'use strict';
/**
 * Refactor-trigger command router — CLI subcommand dispatcher for
 * `gsd-tools refactor` (issue #1953).
 *
 * Follows `src/intel-command-router.cts` exactly: `routeHubCommandFamily`,
 * `makeInvalidArgs` for validation failures, `output(value, raw)` for
 * success, `_`-prefixed injection seams, lazy `require` of the heavy leaf
 * module (`complexity-trigger.cjs`) and the adjacent modules
 * (`git-base-branch.cjs`, `broken-windows.cjs`) inside the route function.
 *
 * Authoritative surfaces:
 *   .gsd/phase/feat-1953-complexity-triggered-refactor/42-router-contract.md
 *   .gsd/phase/feat-1953-complexity-triggered-refactor/41-api-contract.md
 *
 * `src/complexity-trigger.cts` stays a pure leaf (analyzer, evaluator,
 * baseline persistence) — this module owns capability-activation gating,
 * git invocation (via the `src/git-base-branch.cts` adapters), config
 * reads, CLI arg parsing, phase-directory resolution, and the optional
 * broken-windows ledger integration. It never duplicates the leaf's logic.
 *
 * Arg indexing:
 *   args[0] = 'refactor'   (family — matched by dispatchCapabilityCommand)
 *   args[1] = subcommand   (accept | decline | evaluate | status)
 *   args[2..] = flags      (--phase, --since, --reason, --raw)
 *
 * Seams: `_complexity` (complexity-trigger.cjs), `_git` (git-base-branch.cjs),
 * `_windows` (broken-windows.cjs — OPTIONAL; absent or a throwing `require`
 * is the documented degrade path, never an error), `_core` (output capture).
 * Production callers omit all four.
 */

import path from 'node:path';
import fs from 'node:fs';
import { retryRenameSync } from './shell-command-projection.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandRoutingHub = require('./command-routing-hub.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateMod = require('./capability-state.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityActivationMod = require('./capability-activation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');

// Type-only: erased at emit, so pulling in the leaf modules' exact exported
// shapes here does not violate the "lazy require of the heavy module inside
// the route function" rule — only the runtime `require(...)` calls below are
// deferred into the handlers.
import type * as ComplexityTriggerModule from './complexity-trigger.cjs';
import type { AnalyzedFile, Candidate, Evaluation, Proposal } from './complexity-trigger.cjs';
import type * as GitBaseBranchModule from './git-base-branch.cjs';
import type * as BrokenWindowsModule from './broken-windows.cjs';
import type { Ledger, WindowEntry } from './broken-windows.cjs';

const { output } = io;
const { makeInvalidArgs } = commandRoutingHub;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
const { isCapabilityActive } = capabilityStateMod;
const { resolveConfigKey } = capabilityActivationMod;
const { loadConfig } = configLoaderMod;
const { findPhaseInternal, listMilestonePhaseDirs } = phaseLocatorMod;
const { planningDir } = planningWorkspaceMod;

const CAPABILITY_ID = 'refactor-trigger';

// ─── Types ────────────────────────────────────────────────────────────────────

type ComplexityModule = typeof ComplexityTriggerModule;
type GitModule = typeof GitBaseBranchModule;
type WindowsModule = typeof BrokenWindowsModule;

interface CoreModule {
  output(value: unknown, raw: boolean): void;
}

// Default CoreModule implementation. `_core` seam overrides this entirely
// for test injection (captures output calls without writing to real stdout).
const _defaultCore: CoreModule = { output };

interface RouteRefactorTriggerCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: inject a mock complexity-trigger module. Defaults to the real module. */
  _complexity?: ComplexityModule;
  /** Test seam: inject a mock git-base-branch module. Defaults to the real module. */
  _git?: GitModule;
  /** Test seam: inject a mock broken-windows module. Defaults to the real module (optional capability). */
  _windows?: WindowsModule;
  /** Test seam: inject a mock core module to capture output calls. Defaults to the real module. */
  _core?: CoreModule;
}

// ─── Disabled response ──────────────────────────────────────────────────────

function disabledResponse(): { disabled: true; message: string } {
  return {
    disabled: true,
    message: 'refactor-trigger is not enabled. Enable with: gsd config-set refactor.trigger_enabled true',
  };
}

// ─── Arg parsing ────────────────────────────────────────────────────────────

// Positive integer, optionally zero-padded, optionally with dotted decimal
// sub-phase segments (1, 01, 12, 3.1). Rejects 0, negative, letters, and
// whitespace — matches the router contract's "positive integer or decimal
// phase id" rule.
const PHASE_VALUE_RE = /^0*[1-9]\d*(?:\.\d+)*$/;

interface FlagRead {
  present: boolean;
  value: string;
  duplicated: boolean;
  /** True when `--flag` was followed by another flag-shaped token (or nothing) instead of a value. */
  flagShaped: boolean;
}

/**
 * Reads a `--flag value` or `--flag=value` occurrence from `args`. Repeated
 * occurrences are reported via `duplicated` (the last one wins in `value`,
 * but callers should treat `duplicated` as invalid input). A token
 * immediately following `--flag` that itself starts with `--` (or the flag
 * being the last token) is NOT consumed as a value — `flagShaped` is set and
 * `value` stays `''`, so `--phase --raw` never silently swallows `--raw`.
 */
function readFlag(args: string[], flag: string): FlagRead {
  let present = false;
  let value = '';
  let count = 0;
  let flagShaped = false;
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      count++;
      present = true;
      const next = args[i + 1];
      if (next === undefined) {
        value = '';
      } else if (next.startsWith('--')) {
        value = '';
        flagShaped = true;
      } else {
        value = next;
        flagShaped = false;
      }
    } else if (a.startsWith(eqPrefix)) {
      count++;
      present = true;
      value = a.slice(eqPrefix.length);
      flagShaped = false;
    }
  }
  return { present, value, duplicated: count > 1, flagShaped };
}

/**
 * Validate `--phase`: required, and a positive integer or decimal phase id.
 * Empty, whitespace-only, duplicated, `--phase=`, `--phase==N`, or a
 * flag-shaped value all fail. Missing entirely -> REFACTOR_USAGE (no value
 * was ever offered); present but invalid -> REFACTOR_INVALID_PHASE (a value
 * was given but rejected). Never throws.
 */
function requirePhaseArg(
  args: string[],
  complexity: ComplexityModule,
  usage: string,
): { ok: true; phase: string } | { ok: false; result: unknown } {
  const flag = readFlag(args, '--phase');
  if (!flag.present) {
    return { ok: false, result: makeInvalidArgs('phase', usage, complexity.REASON.REFACTOR_USAGE) };
  }
  const trimmed = flag.value.trim();
  if (flag.duplicated || flag.flagShaped || trimmed === '' || !PHASE_VALUE_RE.test(trimmed)) {
    return {
      ok: false,
      result: makeInvalidArgs(
        'phase',
        `Invalid --phase value: ${JSON.stringify(flag.value)}. ${usage}`,
        complexity.REASON.REFACTOR_INVALID_PHASE,
      ),
    };
  }
  return { ok: true, phase: trimmed };
}

// ─── Phase / path resolution ────────────────────────────────────────────────

interface ResolvedPhase {
  /** Project-relative, POSIX-separated phase directory (e.g. ".planning/phases/03-x"). */
  phaseDir: string;
  /** Zero-padded phase token (e.g. "03"), matching `${PADDED}-REFACTOR.md`. */
  padded: string;
}

/**
 * Resolve the on-disk phase directory for a validated `--phase` value. A
 * phase that cannot be located on disk (never planned, wrong number, an
 * archived milestone this call isn't scoped to) returns `null` — this is a
 * distinct fact from a git failure (git is fine; the phase just doesn't
 * exist), so callers report REFACTOR_INVALID_PHASE, never
 * REFACTOR_GIT_UNAVAILABLE, for this case.
 */
function resolvePhaseDirForArg(cwd: string, phaseArg: string): ResolvedPhase | null {
  const search = findPhaseInternal(cwd, phaseArg);
  if (!search || search.found !== true) return null;
  return { phaseDir: search.directory, padded: search.phase_number };
}

/**
 * Resolve `relFile` (a repo-relative path, typically from `git diff
 * --name-only`) against `cwd` and refuse a path that escapes the project
 * root. Returns the absolute path, or `null` when it escapes.
 *
 * Two layers: the string-level `startsWith` check is a cheap first gate but
 * confines only the SYMLINK's own path, not its target — a symlink
 * committed in the repo (e.g. `src/evil.cts -> /etc/passwd`) has an
 * in-tree path that passes the string check, and `fs.readFileSync` on it
 * would follow the link and read outside the root. `lstatSync` (which does
 * NOT follow symlinks, unlike `statSync`) is the second gate: anything that
 * is not a regular file — a symlink most of all — is refused outright.
 * Refusing rather than resolving-and-re-confining is deliberate: it is
 * simpler and strictly stricter (a symlink whose target legitimately lives
 * inside the root is still refused, which is an acceptable false positive
 * for this analyzer). An `lstatSync` failure (ENOENT on a broken symlink,
 * EACCES, a race) is treated the same as "not a regular file" — never
 * propagated — so callers can keep using their existing null-means-skip
 * convention (`REASON.REFACTOR_FILE_UNREADABLE`) uniformly.
 */
function resolveConfinedPath(cwd: string, relFile: string): string | null {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, relFile);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  try {
    if (!fs.lstatSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function artifactFileName(padded: string, complexity: ComplexityModule): string {
  return `${padded}${complexity.PROPOSAL_SUFFIX}`;
}

function artifactAbsPath(cwd: string, phaseDir: string, padded: string, complexity: ComplexityModule): string {
  return path.join(cwd, phaseDir, artifactFileName(padded, complexity));
}

function candidateKey(file: string, name: string): string {
  return `${file}::${name}`;
}

// ─── Atomic write (proposal + ledger) ───────────────────────────────────────

/**
 * Atomic publish: write a sibling `.tmp.<pid>` file, then rename over the
 * target via `retryRenameSync` (transient-Windows-lock-tolerant — matches
 * `local/require-fs-op-fallback`, ADR-1703 Phase 6). On any failure, best-
 * effort unlinks the temp file and rethrows.
 */
function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    retryRenameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ─── Config reads ───────────────────────────────────────────────────────────

/**
 * Read `refactor.complexity_threshold` / `refactor.complexity_jump_delta` /
 * `refactor.trigger_strict` via the same four-level precedence walk
 * (`resolveConfigKey`) the capability-activation gate uses: loadConfig
 * result -> workstream config.json -> root config.json -> registry
 * `configSchema` default. Reading the frozen first-party registry directly
 * is deliberate (not `capability-loader.cjs`'s `loadRegistry`): with
 * `includeInstalled` omitted, `loadRegistry()` returns the exact same frozen
 * object — refactor-trigger is first-party, so the overlay/consent machinery
 * has nothing to add here and this avoids the extra indirection.
 */
function readEvalConfig(cwd: string): { threshold: unknown; jumpDelta: unknown; strict: boolean; windowsEnforce: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require('./capability-registry.cjs') as Record<string, unknown>;
  const config = loadConfig(cwd);
  const threshold = resolveConfigKey('refactor.complexity_threshold', { config, cwd, registry }).value;
  const jumpDelta = resolveConfigKey('refactor.complexity_jump_delta', { config, cwd, registry }).value;
  const strict = resolveConfigKey('refactor.trigger_strict', { config, cwd, registry }).value;
  // Read via the SAME four-level precedence walk as the `refactor.*` keys
  // above — reusing `resolveConfigKey`/`loadConfig`/the frozen registry
  // rather than a second config reader. A missing key resolves to the
  // registry default (false), matching "treat a missing key as falsy".
  const windowsEnforce = resolveConfigKey('workflow.windows_enforce', { config, cwd, registry }).value;
  return { threshold, jumpDelta, strict: Boolean(strict), windowsEnforce: Boolean(windowsEnforce) };
}

// ─── Strict-mode enforcement-gap warning (#1953) ────────────────────────────

const WINDOWS_ENFORCE_REMEDIATION = 'gsd config-set workflow.windows_enforce true';

/**
 * `refactor.trigger_strict` only ever APPENDS a deviation window to the
 * broken-windows ledger — a ship only actually stops when the separate
 * `workflow.windows_enforce` toggle is also on. A user who enables only
 * `refactor.trigger_strict` gets tracking with no enforcement and, absent
 * this warning, no signal that this is the case. Fires strictly on TRIGGERED
 * evaluates with strict mode on, mirroring the existing ledger-recording
 * gate: either the broken-windows capability could not record the window at
 * all (`ledgerRecorded === false` — the existing degrade path), or it did,
 * but `workflow.windows_enforce` is falsy. Never fires with strict off.
 */
function strictNotEnforcingWarning(
  complexity: ComplexityModule,
  ledgerRecorded: boolean,
  windowsEnforce: boolean,
): { reason: string; message: string } | null {
  if (!ledgerRecorded) {
    return {
      reason: complexity.REASON.REFACTOR_STRICT_NOT_ENFORCING,
      message: 'refactor.trigger_strict is on, but the broken-windows capability is unavailable, so ship will not '
        + `actually be blocked. Install the broken-windows capability, then run: ${WINDOWS_ENFORCE_REMEDIATION}`,
    };
  }
  if (!windowsEnforce) {
    return {
      reason: complexity.REASON.REFACTOR_STRICT_NOT_ENFORCING,
      message: 'refactor.trigger_strict is on, but workflow.windows_enforce is off, so ship will not actually be '
        + `blocked. Run: ${WINDOWS_ENFORCE_REMEDIATION}`,
    };
  }
  return null;
}

// ─── Broken-windows integration (strict mode; OPTIONAL) ─────────────────────

function windowsLedgerPath(cwd: string, windows: WindowsModule): string {
  return path.join(cwd, '.planning', windows.LEDGER_FILE_NAME);
}

function readLedgerOrEmpty(cwd: string, windows: WindowsModule): Ledger | null {
  const ledgerPath = windowsLedgerPath(cwd, windows);
  try {
    const raw = fs.readFileSync(ledgerPath, 'utf8');
    return windows.parseLedger(raw);
  } catch (e: unknown) {
    const code = (e && typeof e === 'object' && 'code' in e) ? String((e as { code?: unknown }).code) : '';
    if (code === 'ENOENT') return windows.emptyLedger(new Date().toISOString());
    return null; // unreadable/malformed — degrade rather than throw
  }
}

/**
 * Structural identity match (#1953 defect 2): a deviation window's identity
 * is the typed `phase`/`file`/`line` triple `appendWindow` already persists
 * — never the human-readable `description` prose. A reworded description or
 * a user editing `WINDOWS.md` prose can never break dedup.
 */
function findOpenDeviationEntry(ledger: Ledger, phase: string, file: string, line: number): WindowEntry | null {
  return ledger.entries.find(
    (e) => e.status === 'open' && e.kind === 'deviation' && e.phase === phase && e.file === file && e.line === line,
  ) ?? null;
}

/**
 * Shared require-or-degrade + ledger-read boilerplate for
 * `recordStrictWindow` / `resolveLedgerWindow` (#1953 defect 5a). `_windows`
 * unavailable (module absent, or its `require` throws) or the ledger
 * unreadable both degrade to a `{ ok: false, note }` result — never an
 * error, never throws.
 */
function loadWindowsOrDegrade(
  cwd: string,
  windowsOverride: WindowsModule | undefined,
): { ok: true; windows: WindowsModule; ledger: Ledger } | { ok: false; note: string } {
  let windows: WindowsModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    windows = windowsOverride ?? (require('./broken-windows.cjs') as WindowsModule);
  } catch {
    return { ok: false, note: 'broken-windows capability unavailable — proposal recorded locally only' };
  }
  const ledger = readLedgerOrEmpty(cwd, windows);
  if (ledger === null) {
    return { ok: false, note: 'broken-windows ledger unreadable — proposal recorded locally only' };
  }
  return { ok: true, windows, ledger };
}

/**
 * Strict-mode window append (step 9 of `evaluate`). Degrades to
 * `{ recorded: false, note }` per `loadWindowsOrDegrade` — never an error,
 * never throws. Idempotent: re-evaluating the same still-untriaged phase
 * finds the existing OPEN entry (matched structurally on phase + target
 * file/line) and does not append a second one.
 */
function recordStrictWindow(
  cwd: string,
  padded: string,
  target: Candidate,
  windowsOverride: WindowsModule | undefined,
): { recorded: boolean; note?: string } {
  const loaded = loadWindowsOrDegrade(cwd, windowsOverride);
  if (!loaded.ok) return { recorded: false, note: loaded.note };
  const { windows, ledger } = loaded;

  if (findOpenDeviationEntry(ledger, padded, target.file, target.startLine)) {
    return { recorded: true, note: 'already recorded for this phase (idempotent)' };
  }

  const key = candidateKey(target.file, target.name);
  const description = `${key} — complexity ${target.score}` +
    (target.baseline !== null ? ` (baseline ${target.baseline}, delta ${target.delta})` : '');

  const now = new Date().toISOString();
  try {
    const result = windows.appendWindow(
      ledger,
      { kind: 'deviation', phase: padded, file: target.file, line: target.startLine, description },
      { now },
    );
    writeTextAtomic(windowsLedgerPath(cwd, windows), windows.renderLedger(result.ledger));
    return { recorded: true };
  } catch (e) {
    return { recorded: false, note: `failed to record broken-windows entry: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Resolve (mark fixed/waived) the ledger window matching phase + target
 * file/line, if any. Never throws. Mirrors `recordStrictWindow`'s
 * `{ recorded, note }` degrade shape (#1953 defect 2): every
 * `resolved: false` path carries a `note` naming the real reason, so
 * `accept`/`decline` never tell a user "it failed" without saying why.
 */
function resolveLedgerWindow(
  cwd: string,
  padded: string,
  file: string,
  line: number,
  kind: 'accept' | 'decline',
  reasonText: string,
  windowsOverride: WindowsModule | undefined,
): { resolved: boolean; note?: string } {
  const loaded = loadWindowsOrDegrade(cwd, windowsOverride);
  if (!loaded.ok) return { resolved: false, note: loaded.note };
  const { windows, ledger } = loaded;

  const entry = findOpenDeviationEntry(ledger, padded, file, line);
  if (!entry) {
    return { resolved: false, note: 'no open broken-windows entry found for this phase/target — nothing to resolve' };
  }
  const now = new Date().toISOString();
  try {
    const updated = kind === 'accept'
      ? windows.markFixed(ledger, entry.id, { now })
      : windows.markWaived(ledger, entry.id, reasonText || 'declined', { now });
    writeTextAtomic(windowsLedgerPath(cwd, windows), windows.renderLedger(updated));
    return { resolved: true };
  } catch (e) {
    return { resolved: false, note: `failed to resolve broken-windows entry: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── evaluate ────────────────────────────────────────────────────────────────

const EVALUATE_USAGE = 'Usage: gsd-tools refactor evaluate --phase <N> [--since <ref>] [--raw]';

function handleEvaluate(
  args: string[],
  cwd: string,
  raw: boolean,
  c: CoreModule,
  complexity: ComplexityModule,
  git: GitModule,
  windowsOverride: WindowsModule | undefined,
): unknown {
  const rest = args.slice(2);
  const phaseCheck = requirePhaseArg(rest, complexity, EVALUATE_USAGE);
  if (!phaseCheck.ok) return phaseCheck.result;

  // Step 3: resolve PHASE_DIR + anchor (phaseStartCommit, or --since override).
  const resolved = resolvePhaseDirForArg(cwd, phaseCheck.phase);
  if (resolved === null) {
    c.output({ verdict: complexity.VERDICT.SKIPPED, reason: complexity.REASON.REFACTOR_INVALID_PHASE, phase: phaseCheck.phase }, raw);
    return undefined;
  }
  const { phaseDir, padded } = resolved;

  const sinceFlag = readFlag(rest, '--since');
  const sinceOverride = sinceFlag.present && !sinceFlag.flagShaped ? sinceFlag.value.trim() : '';
  const sinceRef = sinceOverride !== '' ? sinceOverride : git.phaseStartCommit(cwd, phaseDir);
  if (sinceRef === null) {
    c.output({ verdict: complexity.VERDICT.SKIPPED, reason: complexity.REASON.REFACTOR_GIT_UNAVAILABLE, phase: padded }, raw);
    return undefined;
  }

  const touched = git.changedFilesSince(cwd, sinceRef);
  if (touched === null) {
    c.output({ verdict: complexity.VERDICT.SKIPPED, reason: complexity.REASON.REFACTOR_GIT_UNAVAILABLE, phase: padded }, raw);
    return undefined;
  }

  // Step 4: empty touched set.
  if (touched.length === 0) {
    c.output({ verdict: complexity.VERDICT.BELOW_THRESHOLD, reason: complexity.REASON.REFACTOR_NO_TOUCHED_FILES, phase: padded }, raw);
    return undefined;
  }

  // Step 5: filter with isAnalyzablePath; read each survivor. A read failure
  // (or a path that escapes the project root) skips that one file with a
  // reason and the run continues — never aborts the evaluation.
  const analyzed: AnalyzedFile[] = [];
  // Only files that were SUCCESSFULLY analyzed feed nextBaseline's prune set
  // — an unreadable file must never wipe that file's baseline history via
  // the "file in analyzedFiles but function missing" prune rule.
  const successfullyAnalyzedFiles: string[] = [];
  for (const relFile of touched) {
    if (!complexity.isAnalyzablePath(relFile)) continue;
    const confined = resolveConfinedPath(cwd, relFile);
    if (confined === null) {
      analyzed.push({ file: relFile, ok: false, reason: complexity.REASON.REFACTOR_FILE_UNREADABLE });
      continue;
    }
    let source: string;
    try {
      source = fs.readFileSync(confined, 'utf8');
    } catch {
      analyzed.push({ file: relFile, ok: false, reason: complexity.REASON.REFACTOR_FILE_UNREADABLE });
      continue;
    }
    const result = complexity.analyzeSource(source);
    if (!result.ok) {
      analyzed.push({ file: relFile, ok: false, reason: result.reason });
    } else {
      analyzed.push({ file: relFile, ok: true, method: result.method, functions: result.functions });
      successfullyAnalyzedFiles.push(relFile);
    }
  }

  // Step 6.
  const planningDirPath = planningDir(cwd);
  const baselineRead = complexity.readBaseline(planningDirPath);
  const evalConfig = readEvalConfig(cwd);
  const evaluation: Evaluation = complexity.evaluateCandidates({
    analyzed,
    baseline: baselineRead.baseline,
    threshold: evalConfig.threshold,
    jumpDelta: evalConfig.jumpDelta,
  });

  // Step 7.
  let artifactWritten = false;
  let artifactPath: string | null = null;
  let artifactWriteError: string | null = null;
  if (evaluation.verdict === complexity.VERDICT.TRIGGERED && evaluation.target) {
    const target = evaluation.target;
    const proposal: Proposal = {
      schema_version: complexity.SCHEMA_VERSION,
      status: 'proposed',
      phase: padded,
      target_file: target.file,
      target_function: target.name,
      score: target.score,
      baseline: target.baseline,
      delta: target.delta,
      metric: 'decision-points',
      recorded_at: new Date().toISOString(),
      resolved_at: null,
      reason: target.reasons.join(','),
      candidates: evaluation.candidates,
    };
    artifactPath = artifactAbsPath(cwd, phaseDir, padded, complexity);
    try {
      writeTextAtomic(artifactPath, complexity.renderProposal(proposal));
      artifactWritten = true;
    } catch (e) {
      artifactWriteError = e instanceof Error ? e.message : String(e);
    }
  }

  // Step 8: baseline write failure is reported but does not fail the command.
  const nextBaselineValue = complexity.nextBaseline(
    baselineRead.baseline,
    analyzed,
    { analyzedFiles: successfullyAnalyzedFiles, phase: padded },
  );
  const baselineWrite = complexity.writeBaseline(planningDirPath, nextBaselineValue);

  // Step 9: strict mode, TRIGGERED only.
  let ledgerRecorded: boolean | undefined;
  let ledgerNote: string | undefined;
  const warnings: Array<{ reason: string; message: string }> = [];
  if (evalConfig.strict && evaluation.verdict === complexity.VERDICT.TRIGGERED && evaluation.target) {
    const strictResult = recordStrictWindow(cwd, padded, evaluation.target, windowsOverride);
    ledgerRecorded = strictResult.recorded;
    ledgerNote = strictResult.note;

    const warning = strictNotEnforcingWarning(complexity, ledgerRecorded, evalConfig.windowsEnforce);
    if (warning) warnings.push(warning);
  }

  const result: Record<string, unknown> = {
    verdict: evaluation.verdict,
    phase: padded,
    candidates: evaluation.candidates,
    target: evaluation.target,
    skipped: evaluation.skipped,
    threshold_used: evaluation.thresholdUsed,
    jump_delta_used: evaluation.jumpDeltaUsed,
    artifact_written: artifactWritten,
    artifact_path: artifactPath,
    baseline_write: baselineWrite.ok,
  };
  if (artifactWriteError !== null) result.artifact_write_error = artifactWriteError;
  if (!baselineWrite.ok && baselineWrite.reason) result.baseline_write_reason = baselineWrite.reason;
  if (ledgerRecorded !== undefined) result.ledger_recorded = ledgerRecorded;
  if (ledgerNote !== undefined) result.ledger_note = ledgerNote;
  if (warnings.length > 0) result.warnings = warnings;

  c.output(result, raw);
  return undefined;
}

// ─── status ──────────────────────────────────────────────────────────────────

const STATUS_USAGE = 'Usage: gsd-tools refactor status [--phase <N>] [--raw]';

function scanProposals(
  cwd: string,
  complexity: ComplexityModule,
): Array<{ phase: string; target_file: string; target_function: string; status: string; score: number }> {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const results: Array<{ phase: string; target_file: string; target_function: string; status: string; score: number }> = [];
  // #1953 (phase-enumeration-drift guard): phase-directory enumeration has one
  // owner (`listMilestonePhaseDirs`, src/phase-locator.cts). Called unscoped
  // (no `cwd` in opts) to preserve this scan's prior all-phases-directory
  // reach — the only behavior change is that sentinel directories (backlog
  // `0-*` / icebox `999-*`, per the canonical `isSentinelPhaseId`) are now
  // excluded, and the enumeration order is `comparePhaseNum`-sorted rather
  // than raw filesystem order.
  const { value: dirs } = listMilestonePhaseDirs(phasesDir);
  for (const dirName of dirs) {
    const full = path.join(phasesDir, dirName);
    let files: string[];
    try {
      files = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const fileName of files) {
      if (!fileName.endsWith(complexity.PROPOSAL_SUFFIX)) continue;
      try {
        const text = fs.readFileSync(path.join(full, fileName), 'utf8');
        const proposal = complexity.parseProposal(text);
        if (proposal) {
          results.push({
            phase: proposal.phase,
            target_file: proposal.target_file,
            target_function: proposal.target_function,
            status: proposal.status,
            score: proposal.score,
          });
        }
      } catch {
        continue;
      }
    }
  }
  return results;
}

function handleStatus(args: string[], cwd: string, raw: boolean, c: CoreModule, complexity: ComplexityModule): unknown {
  const rest = args.slice(2);
  const phaseFlag = readFlag(rest, '--phase');
  if (!phaseFlag.present) {
    c.output({ proposals: scanProposals(cwd, complexity) }, raw);
    return undefined;
  }

  const trimmed = phaseFlag.value.trim();
  if (phaseFlag.duplicated || phaseFlag.flagShaped || trimmed === '' || !PHASE_VALUE_RE.test(trimmed)) {
    return makeInvalidArgs(
      'phase',
      `Invalid --phase value: ${JSON.stringify(phaseFlag.value)}. ${STATUS_USAGE}`,
      complexity.REASON.REFACTOR_INVALID_PHASE,
    );
  }

  const resolved = resolvePhaseDirForArg(cwd, trimmed);
  if (resolved === null) {
    c.output({ found: false, phase: trimmed }, raw);
    return undefined;
  }
  const artifactPath = artifactAbsPath(cwd, resolved.phaseDir, resolved.padded, complexity);
  let text: string;
  try {
    text = fs.readFileSync(artifactPath, 'utf8');
  } catch {
    c.output({ found: false, phase: resolved.padded }, raw);
    return undefined;
  }
  const proposal = complexity.parseProposal(text);
  if (proposal === null) {
    c.output({ found: false, phase: resolved.padded }, raw);
    return undefined;
  }
  c.output({ found: true, phase: resolved.padded, proposal }, raw);
  return undefined;
}

// ─── accept / decline ──────────────────────────────────────────────────────

/**
 * Re-measure the target function's CURRENT complexity score by re-reading
 * and re-analyzing `proposal.target_file` — `accept` re-anchors to the
 * post-refactor score and `decline` to the current (unchanged) score, and
 * both need the LIVE value, not the frozen `proposal.score` snapshot from
 * evaluate-time. Falls back to `proposal.score` when the file is gone,
 * unreadable, unparseable, or the function can no longer be found (e.g.
 * renamed) — reanchorBaseline always needs *a* number, and the proposal's
 * last-known score is the least-surprising fallback.
 */
function measureCurrentScore(cwd: string, proposal: Proposal, complexity: ComplexityModule): number {
  const confined = resolveConfinedPath(cwd, proposal.target_file);
  if (confined === null) return proposal.score;
  let source: string;
  try {
    source = fs.readFileSync(confined, 'utf8');
  } catch {
    return proposal.score;
  }
  const result = complexity.analyzeSource(source);
  if (!result.ok) return proposal.score;
  const fn = result.functions.find((f) => f.name === proposal.target_function);
  return fn ? fn.score : proposal.score;
}

function dispositionUsage(kind: 'accept' | 'decline'): string {
  return kind === 'accept'
    ? 'Usage: gsd-tools refactor accept --phase <N> [--raw]'
    : 'Usage: gsd-tools refactor decline --phase <N> --reason "<text>" [--raw]';
}

function handleDisposition(
  kind: 'accept' | 'decline',
  args: string[],
  cwd: string,
  raw: boolean,
  c: CoreModule,
  complexity: ComplexityModule,
  windowsOverride: WindowsModule | undefined,
): unknown {
  const rest = args.slice(2);
  const usage = dispositionUsage(kind);

  const phaseCheck = requirePhaseArg(rest, complexity, usage);
  if (!phaseCheck.ok) return phaseCheck.result;

  let reasonText = '';
  if (kind === 'decline') {
    const reasonFlag = readFlag(rest, '--reason');
    const trimmedReason = reasonFlag.value.trim();
    if (!reasonFlag.present || reasonFlag.flagShaped || trimmedReason === '') {
      return makeInvalidArgs('reason', usage, complexity.REASON.REFACTOR_DECLINE_REASON_EMPTY);
    }
    reasonText = reasonFlag.value;
  }

  const resolved = resolvePhaseDirForArg(cwd, phaseCheck.phase);
  if (resolved === null) {
    return makeInvalidArgs(
      'phase',
      `No refactor proposal found for phase ${phaseCheck.phase}.`,
      complexity.REASON.REFACTOR_ARTIFACT_NOT_FOUND,
    );
  }
  const artifactPath = artifactAbsPath(cwd, resolved.phaseDir, resolved.padded, complexity);
  let text: string;
  try {
    text = fs.readFileSync(artifactPath, 'utf8');
  } catch {
    return makeInvalidArgs(
      'phase',
      `No refactor proposal found for phase ${resolved.padded}.`,
      complexity.REASON.REFACTOR_ARTIFACT_NOT_FOUND,
    );
  }
  const proposal = complexity.parseProposal(text);
  if (proposal === null) {
    return makeInvalidArgs(
      'phase',
      `Refactor proposal for phase ${resolved.padded} is unreadable.`,
      complexity.REASON.REFACTOR_ARTIFACT_NOT_FOUND,
    );
  }
  if (proposal.status !== 'proposed') {
    return makeInvalidArgs(
      'phase',
      `Refactor proposal for phase ${resolved.padded} is already ${proposal.status}.`,
      complexity.REASON.REFACTOR_ALREADY_DISPOSITIONED,
    );
  }

  const key = candidateKey(proposal.target_file, proposal.target_function);
  const now = new Date().toISOString();
  const liveScore = measureCurrentScore(cwd, proposal, complexity);
  const targetCandidate = proposal.candidates.find(
    (cand) => cand.file === proposal.target_file && cand.name === proposal.target_function,
  ) ?? proposal.candidates[0] ?? null;

  const updatedProposal: Proposal = {
    ...proposal,
    status: kind === 'accept' ? 'accepted' : 'declined',
    resolved_at: now,
    reason: kind === 'accept' ? proposal.reason : reasonText,
  };
  writeTextAtomic(artifactPath, complexity.renderProposal(updatedProposal));

  const planningDirPath = planningDir(cwd);
  const baselineRead = complexity.readBaseline(planningDirPath);
  const nextBaselineValue = complexity.reanchorBaseline(baselineRead.baseline, key, liveScore, { phase: resolved.padded });
  const baselineWrite = complexity.writeBaseline(planningDirPath, nextBaselineValue);

  const ledgerResult = resolveLedgerWindow(
    cwd,
    resolved.padded,
    proposal.target_file,
    targetCandidate ? targetCandidate.startLine : -1,
    kind,
    reasonText,
    windowsOverride,
  );

  const dispositionResult: Record<string, unknown> = {
    status: updatedProposal.status,
    phase: resolved.padded,
    target: key,
    reanchored_to: liveScore,
    baseline_write: baselineWrite.ok,
    ledger_resolved: ledgerResult.resolved,
  };
  if (ledgerResult.note !== undefined) dispositionResult.ledger_note = ledgerResult.note;

  c.output(dispositionResult, raw);
  return undefined;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Shared capability-active gate + lazy `complexity-trigger.cjs` require
 * (#1953 defect 5b) — identical across all four subcommand handlers. Emits
 * the disabled response and returns `undefined` without invoking `run` when
 * the capability is off; otherwise resolves the module (respecting the
 * `_complexity` test seam) and hands it to `run`.
 */
function withActiveComplexity(
  cwd: string,
  raw: boolean,
  c: CoreModule,
  complexityOverride: ComplexityModule | undefined,
  run: (complexity: ComplexityModule) => unknown,
): unknown {
  if (!isCapabilityActive(CAPABILITY_ID, cwd)) {
    c.output(disabledResponse(), raw);
    return undefined;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const complexity: ComplexityModule = complexityOverride ?? (require('./complexity-trigger.cjs') as ComplexityModule);
  return run(complexity);
}

function routeRefactorTriggerCommand({ args, cwd, raw, error, _complexity, _git, _windows, _core }: RouteRefactorTriggerCommandOptions): void {
  const c: CoreModule = _core ?? _defaultCore;

  routeHubCommandFamily({
    family: 'refactor',
    args,
    // Alphabetical for a stable unknown-subcommand message, matching intel/graphify.
    subcommands: ['accept', 'decline', 'evaluate', 'status'],
    handlers: {
      evaluate: () => withActiveComplexity(cwd, raw, c, _complexity, (complexity) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const git: GitModule = _git ?? (require('./git-base-branch.cjs') as GitModule);
        return handleEvaluate(args, cwd, raw, c, complexity, git, _windows);
      }),
      status: () => withActiveComplexity(cwd, raw, c, _complexity, (complexity) => handleStatus(args, cwd, raw, c, complexity)),
      accept: () => withActiveComplexity(
        cwd, raw, c, _complexity,
        (complexity) => handleDisposition('accept', args, cwd, raw, c, complexity, _windows),
      ),
      decline: () => withActiveComplexity(
        cwd, raw, c, _complexity,
        (complexity) => handleDisposition('decline', args, cwd, raw, c, complexity, _windows),
      ),
    },
    unknownMessage: (subcommand: string, available: string[]) =>
      `Unknown refactor subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export = {
  routeRefactorTriggerCommand,
};
