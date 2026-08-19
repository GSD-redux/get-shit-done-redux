/**
 * prohibition-enforcement — the deterministic PRODUCER for test-tier prohibition verification
 * (#1259, ADR-550 Decision 5d "heavy half"; the D1 seam — a NEW deterministic gsd-tools
 * sub-command, NOT free-form workflow prose).
 *
 * Today `dispositionForProhibition()` (src/probe-core.cts) already carries the POLICY seam: with
 * non-empty `enforcementEvidence` AND `tier === 'test'` it returns `{ status: 'green' }` (the
 * branch at probe-core 420-427); with empty evidence it fails closed to flagged-unverified. But
 * NOTHING in the live pipeline ever produced `enforcementEvidence`, so the green branch was
 * unreachable. This module is the missing producer: it LOCATES the wired mechanical check from a
 * check descriptor, RUNS it and requires a genuine NON-VACUOUS pass, builds a typed
 * `enforcementEvidence` array on PASS, and emits the `dispositionForProhibition` verdict as JSON.
 * The green/fail-closed policy itself is untouched (no src/probe-core.cts edit).
 *
 * Accepts BOTH wired-check kinds (ADR-550 D2): a `node --test` negative test OR a lint/AST rule
 * (e.g. the in-tree `local/no-source-grep` rule — the D4 dogfood anchor, run via the project flat
 * config so the plugin loads). A missing, non-attested, or genuinely-non-passing check hard-gates
 * (flagged, non-green) in BOTH interactive and autonomous modes (ADR-550 D4 / D3) — never a silent
 * green.
 *
 * FAIL-FIRST IS MACHINE-PROVEN (#1279): the producer no longer greens on caller attestation. The
 * green verdict requires the injectable prover (`proveFailFirst`, default `defaultProveFailFirst`) to
 * INDEPENDENTLY run the check against a known violation fixture and observe it go red, AND the runner
 * to observe a real non-vacuous pass: `passed = proof.provenFailFirst === true && run.passed === true`.
 * Caller attestation (`CheckDescriptor.failFirst`) is demoted to a non-authoritative hint kept only
 * for backward route-JSON shape — no path greens on it alone (FF-08). The proof method is recorded in
 * the evidence (`failFirstProof`, FF-07). This replaces the #1259 caller-attested red-first property
 * with machine proof, closing the gap the ADR-550 D5d note tracked as a follow-up.
 *
 * Authored as strict TypeScript (`src/prohibition-enforcement.cts`) and compiled by
 * `tsc -p tsconfig.build.json` (`npm run build:lib`) to the gitignored runtime artifact
 * `gsd-core/bin/lib/prohibition-enforcement.cjs`. Do NOT hand-write the `.cjs`; it is emitted.
 *
 * DETERMINISM SCOPE: the DECISION layer is pure/deterministic and no-LLM — given a `runCheck` result
 * the disposition is same-input-same-output and mutation-survivable, and the parse/filter helpers
 * (`parseNodeTestSummary`, `tapTestNames`, `eslintJsonHasRule`, `eslintHasFatalError`, …) are pure.
 * The DEFAULT REAL runner is NOT pure — it spawns `node --test` / eslint, so its result depends on the
 * environment (eslint version + flat config, node version, the target file). That is why the runner is
 * an injectable seam (`runCheck`): the contract is unit-tested against injected results, mirroring the
 * injectable I/O pattern in `runProbeCli` / `ProbeCliOptions`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
// Import the leaf I/O module directly (core.cjs re-export spine retired in epic #1267).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error, ERROR_REASON } = io;
import { dispositionForProhibition } from './probe-core.cjs';
import type { ProhibitionDisposition } from './probe-core.cjs';

/** The two accepted wired-check kinds (ADR-550 D2). */
export type CheckKind = 'node-test' | 'lint-rule';

/**
 * A descriptor of the wired mechanical check that asserts the must-NOT. `kind` selects the
 * runner family; `target` is the negative-test file path (node-test) or the PATH to lint
 * (lint-rule); `rule` is the eslint rule id (lint-rule only — e.g. `local/no-source-grep`) and is
 * REQUIRED for the lint-rule kind (a lint-rule descriptor without it is not a valid wired check);
 * `failFirst` is a DEMOTED, non-authoritative hint kept only for backward route-JSON shape — the
 * machine prover (`proveFailFirst`) supersedes it, and NO path greens on attestation alone (FF-08,
 * #1279). The descriptor's `violationFixture` is what the prover actually uses to prove fail-first.
 */
export interface CheckDescriptor {
  kind: CheckKind;
  target: string;
  rule?: string;
  failFirst?: boolean;
  /**
   * Author-supplied path to a KNOWN-BAD subject the prover runs the check against to machine-prove
   * the check is fail-first (#1279). For `lint-rule`: a file whose content violates `rule` (the
   * prover lints it and requires the rule id to appear). For `node-test`: a subject the negative
   * test exercises via the `GSD_PROHIB_SUBJECT` env convention, expected to drive the test RED.
   * A generic producer cannot synthesize a violation for an arbitrary check, so this is required to
   * prove fail-first; ABSENT for node-test → the default prover fails closed (never attestation).
   */
  violationFixture?: string;
  /**
   * Author-supplied path to a KNOWN-CLEAN control subject (#1346; MANDATORY for the node-test kind as
   * of #1906). The prover runs the check against it as a CAUSATION CONTROL and requires it to stay
   * GREEN — proof that the RED on `violationFixture` was caused by the subject's CONTENT, not merely by
   * `GSD_PROHIB_SUBJECT` being set. A deceptive content-independent check reds on the clean subject too
   * → control fails → not proven. For the `node-test` kind this is now REQUIRED: ABSENT → the node-test
   * is UN-PROVABLE (fail-closed), never accepted under the weaker violation-only proof (#1906 supersedes
   * #1346's opt-in; ADR-1606 Decision 4). A supplied-but-missing path fails closed. The field stays
   * optional at the type level because the `lint-rule` kind needs no analog (its subject IS the linted
   * file — no `GSD_PROHIB_SUBJECT` indirection, so the "reds because the env var is set" gap can't exist).
   */
  cleanFixture?: string;
}

/**
 * READ-BACK ADAPTER (#1278, plan 01-03): reconstruct a `CheckDescriptor` from the flat scalar keys
 * `projectProhibitions` emits onto a prohibition item (`check_kind` / `check_target` / `check_rule`,
 * src/probe-core.cts). This is the deterministic bridge from the projected descriptor back into the
 * merged #1259 producer request — the verify-phase caller reads the projected scalars, this rebuilds
 * the `{ kind, target, rule? }` request, and `runProhibitionEnforcement`'s EXISTING fail-closed LOCATE
 * guard (validKind/validTarget/validRule, below) is the single source of fail-closed truth.
 *
 * Contract:
 *   - `null`/`undefined`/non-object input -> `null`.
 *   - `check_kind` ABSENT -> `null` (no descriptor -> producer locates nothing -> fail-closed).
 *   - `check_kind` present -> `{ kind: check_kind, target: check_target }`, adding `rule: check_rule`
 *     ONLY when `check_rule` is a non-empty string, `violationFixture: check_violation_fixture`
 *     ONLY when that scalar is a non-empty string (composes #1278 locate with #1279 proof), and
 *     `cleanFixture: check_clean_fixture` ONLY when that scalar is non-empty (#1346 causation control).
 *   - `failFirst` is NEVER sourced from the projection — it stays a verify-time caller attestation
 *     (#1279 machine-proves it; out of scope here). The returned descriptor carries no `failFirst`.
 *   - The adapter does NOT strictly validate kind/target/rule: it faithfully reconstructs whatever
 *     scalars are present (e.g. `{check_kind:'lint-rule', check_target:'src/'}` with no `check_rule`
 *     reconstructs to `{kind:'lint-rule', target:'src/'}`), letting the existing LOCATE guard reject
 *     an under-specified descriptor (located:false, never green). It does NOT re-implement that guard.
 *   - Pure, deterministic, no-throw.
 */
export function descriptorFromProjection(
  projected: Record<string, unknown> | null | undefined,
): CheckDescriptor | null {
  if (!projected || typeof projected !== 'object') return null;
  if (!('check_kind' in projected)) return null;
  // The shared `parseMustHavesBlock` (src/frontmatter.cts) coerces /^\d+$/ scalar values to NUMBERS on
  // round-trip, so a numeric-looking check_kind/check_target/check_rule arrives here as a number. Normalize
  // ONLY string|number scalars back to string — a non-scalar (object/array/bool) or absent value yields ''
  // (never an `[object Object]` stringification, no `as string` lie over a number). This keeps the
  // descriptor honestly typed and the round-trip lossless across the full string domain; an under-specified
  // '' target/kind is rejected by the producer's locate guard (fail-closed; never green).
  const scalar = (v: unknown): string =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  const kind = scalar(projected.check_kind) as CheckKind;
  const target = scalar(projected.check_target);
  const descriptor: CheckDescriptor = { kind, target };
  // `rule` belongs only to the lint-rule kind; a stray check_rule on a node-test descriptor is dropped
  // (the projector never emits one there — defense in depth). failFirst is NOT sourced here (#1279).
  if (kind === 'lint-rule') {
    const rule = scalar(projected.check_rule);
    if (rule.trim().length > 0) descriptor.rule = rule;
  }
  // `violationFixture` (#1346) rides BOTH kinds — reconstruct it from `check_violation_fixture` so the
  // deterministic #1278 locate path and the #1279 machine-proof COMPOSE: a projected fixture lets the
  // default prover green end-to-end with zero hand-authoring. Absent/blank -> no fixture -> the prover
  // hard-gates (fail-closed; green requires a fixture), never fabricated.
  const fixture = scalar(projected.check_violation_fixture);
  if (fixture.trim().length > 0) descriptor.violationFixture = fixture;
  // `cleanFixture` (#1346) rides BOTH kinds — reconstruct it from `check_clean_fixture` so the
  // causation control runs end-to-end: when present the prover also requires the check to stay GREEN
  // against this known-clean subject (proving the violation RED is content-dependent). Absent/blank ->
  // no control (the documented residual remains; backward-compatible with the #1314 compose path).
  const clean = scalar(projected.check_clean_fixture);
  if (clean.trim().length > 0) descriptor.cleanFixture = clean;
  return descriptor;
}

/**
 * The result a check-runner returns: whether the check genuinely, non-vacuously PASSED. The runner
 * reports only what it can OBSERVE (a real clean pass) — it does NOT determine fail-first. Whether the
 * check is a `regression-must-fail-first` proof is now MACHINE-PROVEN by the separate `proveFailFirst`
 * seam (#1279), which runs the check against the descriptor's `violationFixture` and observes it go
 * red — not the caller's word (`CheckDescriptor.failFirst` is a demoted, non-authoritative hint).
 */
export interface CheckRunResult {
  passed: boolean;
}

/** A single typed enforcement-evidence record (the array `dispositionForProhibition` reads). */
export interface EnforcementEvidence {
  kind: CheckKind;
  target: string;
  rule?: string;
  /** Machine-proven fail-first (#1279): true ONLY when the prover observed the check go red on a
   * violation. No longer the caller's attestation — a green item always carries a proven `true`. */
  failFirst: boolean;
  passed: boolean;
  /** HOW fail-first was machine-proven (FF-07) — recorded from the proof result for provenance.
   * Additive; keeps the array shape `dispositionForProhibition` reads stable. */
  failFirstProof?: FailFirstProof['method'];
}

/**
 * The result of machine-proving a check is fail-first (#1279). `provenFailFirst` is true ONLY when
 * the prover independently ran the check against a KNOWN VIOLATION and observed it go red (lint rule
 * flags the violation / negative test fails). `method` records HOW it was proven, for evidence
 * provenance. Any un-provable outcome (no fixture, toothless rule, throw, timeout) → `provenFailFirst:
 * false` (fail-closed) so attestation can never silently green a toothless check.
 */
export interface FailFirstProof {
  provenFailFirst: boolean;
  method?: 'violation-fixture';
}

/** Injectable options for `runProhibitionEnforcement` (defaults wire to the real runner). */
export interface EnforcementOptions {
  /** Runs the located check; injected in tests so no real subprocess is spawned. */
  runCheck?: (check: CheckDescriptor) => CheckRunResult;
  /**
   * Machine-proves the located check is fail-first by running it against the descriptor's
   * `violationFixture` and confirming it goes red (#1279). Injected in tests so no real subprocess is
   * spawned; defaults to the real `defaultProveFailFirst`. Mirrors the `runCheck` seam. Plan 03 wires
   * the result into the green decision; this plan only constructs the prover.
   */
  proveFailFirst?: (check: CheckDescriptor) => FailFirstProof;
  /** Verify mode — recorded for transparency; the hard-gate applies in BOTH modes (ADR-550 D4). */
  mode?: string;
  /** Project root for the default real runner (defaults to process.cwd()). */
  cwd?: string;
  /** Override the per-kind subprocess timeout (ms); defaults to 30s (node-test) / 60s (eslint).
   * Injected in tests to prove the fail-closed-on-timeout bound without a 30s wait. */
  timeoutMs?: number;
}

/** The producer's verdict: the disposition PLUS the located/kind/evidence provenance. */
export interface EnforcementResult extends ProhibitionDisposition {
  located: boolean;
  kind: CheckKind | null;
  evidence: EnforcementEvidence[];
  mode?: string;
}

/** node --test argv. Forces the TAP reporter so the summary counts are parseable + version-stable;
 * `--` before the target so a target starting with `-` is not parsed as a flag (option-injection). */
export function buildNodeTestArgs(check: CheckDescriptor): string[] {
  return ['--test', '--test-reporter=tap', '--', check.target];
}

/** eslint argv (the args AFTER the eslint CLI path). Runs the project flat config so plugin rules
 * (e.g. `local/*`) load — `--rule` CANNOT load a plugin, so we lint the TARGET path as JSON and
 * filter by rule id. `--no-warn-ignored` makes an eslint-IGNORED target return `[]` (not a length-1
 * "File ignored" result) so an ignored path fails closed via the vacuity guard, not a false green.
 * `--` before the target so a target starting with `-` is not parsed as a flag (option-injection). */
export function buildLintArgs(check: CheckDescriptor): string[] {
  return ['--no-warn-ignored', '--format', 'json', '--', check.target];
}

/**
 * Resolve the project's eslint CLI entry portably (no `npx` — not spawnable via `spawnSync` on
 * Windows). Resolves eslint's package.json from the target project's `node_modules` and derives
 * `bin/eslint.js`, so it is run as `node <cli>` (portable). Returns null if eslint is not installed
 * (→ the lint-rule check fails closed, never throws).
 */
function resolveEslintCli(cwd: string): string | null {
  try {
    const pkg = require.resolve('eslint/package.json', { paths: [cwd] });
    const cli = path.join(path.dirname(pkg), 'bin', 'eslint.js');
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/** Basename of a path, separator-agnostic (handles `\` and `/` so node-test names compare stably
 * across OSes / node versions that report the file-test by differing path forms). */
function baseOf(p: string): string {
  return typeof p === 'string' ? (p.split(/[\\/]/).pop() ?? p) : '';
}

/**
 * Pure parser for the `node --test` TAP summary. A genuine pass is NON-VACUOUS: exit 0 is NOT enough
 * (an empty / all-skipped / deleted-negative-test file exits 0 with `# tests 0`). Mutation-pinned by
 * unit tests so a threshold flip is caught.
 */
export function parseNodeTestSummary(out: string): { tests: number; pass: number; fail: number; cancelled: number } {
  const num = (re: RegExp): number => {
    const m = typeof out === 'string' ? out.match(re) : null;
    return m ? Number(m[1]) : 0;
  };
  return {
    tests: num(/^# tests (\d+)/m),
    pass: num(/^# pass (\d+)/m),
    fail: num(/^# fail (\d+)/m),
    cancelled: num(/^# cancelled (\d+)/m),
  };
}

/**
 * Pure: did a `node --test` run go RED on the violation fixture? True iff the TAP summary reports at
 * least one failure (`# fail >= 1`). The default node-test prover requires this — a negative test
 * that does NOT go red against a known-bad subject is toothless and must not prove fail-first.
 * Mutation-pinned (`>= 1` boundary): a mutant flipping `>=`→`>` (or the threshold) is caught by the
 * `# fail 1` unit case. An unparseable summary yields `fail: 0` → false (fail-closed for the prover).
 */
export function isNodeTestRed(out: string): boolean {
  return parseNodeTestSummary(out).fail >= 1;
}

/** The names of REAL (run) tests from TAP `ok N - <name>` / `not ok N - <name>` lines. A line with a
 * `# SKIP` / `# TODO` directive is EXCLUDED — a skipped/todo negative test never executed, so it must
 * not count toward non-vacuity (#1259 m1). */
export function tapTestNames(out: string): string[] {
  if (typeof out !== 'string') return [];
  const names: string[] = [];
  const re = /^(?:not )?ok \d+ - (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const rest = m[1];
    if (/\s#\s*(?:SKIP|TODO)\b/i.test(rest)) continue; // skipped/todo did not run
    names.push(rest.replace(/\s+#\s.*$/, '').trim());
  }
  return names;
}

/**
 * A non-vacuous node-test pass: at least one test, at least one pass, zero failures — AND at least
 * one reported test whose name is NOT merely the target file. `node --test <file>` counts a file
 * with ZERO `test()` calls as one passing "test" named after the file, so the counts alone cannot
 * tell an empty/deleted negative test from a real one (the #1259 BL-01 false-green). Requiring a
 * named test distinct from the file closes that hole.
 *
 * KNOWN CONSTRAINT (fail-closed, not a hole): a real test whose `test('...')` name is EXACTLY the
 * target file's basename emits TAP indistinguishable from an empty file and is conservatively
 * rejected (non-green). A wired negative test must carry a descriptive name, not be named after its
 * own file — a benign authoring constraint, and the safe direction if violated.
 */
export function isNonVacuousNodeTestPass(out: string, target: string): boolean {
  const s = parseNodeTestSummary(out);
  // >=1 test, >=1 pass, ZERO failures AND ZERO cancelled (a cancelled run is not a clean pass, m1).
  if (!(s.tests >= 1 && s.pass >= 1 && s.fail === 0 && s.cancelled === 0)) return false;
  // Compare BASENAMES: node reports the file-test by varying path forms across OS / node version
  // (absolute, relative, normalized), so an exact-string compare misfires. A real test name (e.g.
  // "guards the must-NOT") has no separators, so its basename never equals the target file's.
  const tgtBase = baseOf(target);
  return tapTestNames(out).some((n) => baseOf(n) !== tgtBase);
}

/** The names of FAILING (run) tests from TAP `not ok N - <name>` lines, excluding `# SKIP`/`# TODO`
 * directives (a skipped/todo line never ran). The fail-first analog of `tapTestNames`. */
export function tapFailedTestNames(out: string): string[] {
  if (typeof out !== 'string') return [];
  const names: string[] = [];
  const re = /^not ok \d+ - (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const rest = m[1];
    if (/\s#\s*(?:SKIP|TODO)\b/i.test(rest)) continue; // skipped/todo did not run
    names.push(rest.replace(/\s+#\s.*$/, '').trim());
  }
  return names;
}

/**
 * A NON-VACUOUS node-test RED — the fail-first proof analog of `isNonVacuousNodeTestPass`. True iff
 * the run reports `# fail >= 1` AND at least one FAILING test is named DISTINCTLY from the target file.
 *
 * Why the distinct-name guard: a violation fixture that makes the negative test CRASH at load
 * (ENOENT / throw-on-require / syntax error) emits a FILE-NAMED `not ok 1 - <file>` with `# fail 1`.
 * That is a crash, NOT the negative assertion firing red — so it must not "prove" the test is a
 * regression guard (the RED-side mirror of the BL-01 vacuity hole on the pass side). Requiring a
 * failing test named distinctly from the file closes that hole, symmetric with the clean-pass guard.
 *
 * KNOWN CONSTRAINT (fail-closed, not a hole): a negative test whose `test('...')` name is EXACTLY its
 * own file basename is conservatively rejected — same benign authoring constraint, same safe direction.
 */
export function isNonVacuousNodeTestRed(out: string, target: string): boolean {
  if (!isNodeTestRed(out)) return false; // no `# fail >= 1` summary -> not red (fail-closed)
  const tgtBase = baseOf(target);
  return tapFailedTestNames(out).some((n) => baseOf(n) !== tgtBase);
}

/** Number of file results in an eslint `--format json` report (0 if unparseable / not an array). */
export function eslintFileResultCount(jsonText: string): number {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Messages array of a single eslint file-result (empty if absent / wrong shape). */
function eslintMessages(file: unknown, key: 'messages' | 'suppressedMessages'): Array<{ ruleId?: unknown; fatal?: unknown }> {
  return file && typeof file === 'object' && Array.isArray((file as Record<string, unknown>)[key])
    ? ((file as Record<string, unknown>)[key] as Array<{ ruleId?: unknown; fatal?: unknown }>)
    : [];
}

/**
 * True if the eslint `--format json` report has a FATAL / parse error — meaning the rule never got
 * to run on the target. A prohibition gate must fail closed on "the rule didn't execute" (#1259 B1),
 * NOT treat a length-1 fatal result as "clean". Unparseable report -> true (fail-closed).
 */
export function eslintHasFatalError(jsonText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return true;
  }
  if (!Array.isArray(parsed)) return true;
  for (const file of parsed) {
    const fec = file && typeof file === 'object' ? (file as { fatalErrorCount?: unknown }).fatalErrorCount : undefined;
    if (typeof fec === 'number' && fec > 0) return true;
    if (eslintMessages(file, 'messages').some((m) => m && m.fatal === true)) return true;
  }
  return false;
}

/** True if the eslint `--format json` report has ANY message for `rule` — in EITHER `messages` or
 * `suppressedMessages` (an inline `// eslint-disable` of the rule is still a violation, #1259 B1).
 * Unparseable -> true (fail-closed: treat an unreadable report as a violation, not a silent pass). */
export function eslintJsonHasRule(jsonText: string, rule: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return true;
  }
  if (!Array.isArray(parsed)) return true;
  for (const file of parsed) {
    for (const key of ['messages', 'suppressedMessages'] as const) {
      for (const msg of eslintMessages(file, key)) {
        if (msg && typeof msg === 'object' && msg.ruleId === rule) return true;
      }
    }
  }
  return false;
}

/**
 * The default REAL check runner (used when no `runCheck` is injected). Reports only an OBSERVED,
 * genuinely-non-vacuous pass; guarded so a missing tool / non-zero exit yields a non-passing result,
 * NEVER an uncaught throw (the no-throw contract). It does NOT determine fail-first — that is the
 * separate `proveFailFirst` seam's job (machine-proven against the violation fixture, #1279).
 *   - node-test: runs `node --test` (TAP) and requires a NON-VACUOUS pass (>=1 test, >=1 pass, 0 fail
 *     AND a reported test named distinctly from the file). A bare exit 0 for an empty/zero-test file
 *     — which `node --test` counts as one passing "test" named after the file — is NOT a pass (the
 *     #1259 BL-01 false-green fix).
 *   - lint-rule: runs the project eslint as `node <eslint-cli> --format json <target>` (flat config
 *     loads `local/*` plugins) and requires the target to actually lint (>=1 file result) AND ZERO
 *     messages for the specific rule id. `--rule` cannot load a plugin rule, so we filter the
 *     structured report by `ruleId` instead (the #1259 SF-01 fix).
 *
 * Both kinds spawn via `process.execPath` (never bare `node`/`npx` — not portably spawnable via
 * `spawnSync` on Windows) with arg arrays (no shell → no injection from a caller-supplied target).
 */
/**
 * Env for spawned checks: strip `NODE_TEST_CONTEXT` and `NODE_OPTIONS` so an AMBIENT test-runner
 * context (e.g. running verify under `node --test`, which sets `NODE_TEST_CONTEXT=child-v8`) cannot
 * turn the child `node --test` into a silent v8-reporter worker that emits no parseable TAP — which
 * would otherwise corrupt the verdict. Deterministic, environment-independent execution.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}

// Bounded subprocess limits (DEFECT.UNBOUNDED-SUBPROCESS): a stuck wired test / eslint must not hang
// verify forever. On timeout the child is killed and only PARTIAL output survives -> no `# pass`
// summary / unparseable JSON -> fail-closed (degraded, non-passing).
// `maxBuffer` caps output so a runaway producer is cut off (safe direction) rather than OOMing the verifier.
const NODE_TEST_TIMEOUT_MS = 30_000;
const ESLINT_TIMEOUT_MS = 60_000;
const CHECK_MAX_BUFFER = 16 * 1024 * 1024;

/** Resolve the effective timeout: only a POSITIVE override is honored — `0` (which Node treats as
 * "no timeout") or a negative value falls back to the bounded default, so the subprocess is ALWAYS
 * bounded (a `timeoutMs: 0` injection can never disable the bound). */
function posTimeout(timeoutMs: number | undefined, def: number): number {
  return typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : def;
}

/** POSIX only: `detached` makes the child a process-GROUP LEADER, which is what lets us reap its whole
 * subtree via `process.kill(-pid)`. Windows has no equivalent (a negative PID is not a process group
 * there), so it keeps the plain single-child kill `spawnSync`'s `timeout` already does. */
const CAN_REAP_GROUP = process.platform !== 'win32';

/**
 * Run a bounded check subprocess, return its stdout, NEVER throw — and never let a descendant outlive
 * the call.
 *
 * WHY NOT `execFileSync`: its `timeout` signals the DIRECT CHILD ONLY. `node --test` defaults to
 * `--test-isolation=process` (Node >= 22), so the direct child is a RUNNER that re-execs a per-file
 * WORKER, and the worker is what actually executes the subject. On timeout the runner is killed while
 * the worker is never signalled at all: it is reparented to PID 1 and, if the subject hangs, busy-loops
 * forever burning a core. The verdict still failed closed, so nothing observable broke — which is
 * exactly why this leaked unnoticed across days of green runs.
 *
 * So: spawn detached (the child leads its own group) and SIGKILL the whole GROUP in a `finally`.
 * SIGKILL rather than SIGTERM because a subject stuck in a tight loop blocks the event loop, so a
 * JS-level signal handler could never run — only an uncatchable signal is guaranteed to land. The reap
 * is unconditional rather than timeout-only, so the invariant stays simple and testable: NO descendant
 * of a bounded check survives the call.
 *
 * Rejected alternative: `--test-isolation=none` forks no worker, so the direct child is the hanging
 * process and the existing kill would reach it. Measured, it is strictly WORSE — the subject then runs
 * inside the runner, whose SIGTERM queues behind the blocked event loop and is never processed, so the
 * bounded timeout stops working and verify hangs instead of failing closed.
 */
function runBoundedCapture(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): string {
  let pid: number | undefined;
  try {
    // The cast exists ONLY because @types/node omits `detached` from SpawnSyncOptions; libuv honors it
    // for `spawnSync` exactly as for `spawn`. Verified on this runtime, not assumed: with `detached`
    // the child reports `pgid === pid` (it leads its own group), without it the child inherits the
    // caller's group — which is what makes `process.kill(-pid)` below address the subtree and not us.
    const opts = {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
      timeout,
      maxBuffer: CHECK_MAX_BUFFER,
      detached: CAN_REAP_GROUP,
    } as unknown as SpawnSyncOptionsWithStringEncoding;
    const res = spawnSync(file, args, opts);
    pid = res.pid;
    // A non-zero exit is NOT an error here: a RED proof run and a failing check both exit non-zero by
    // design, and `spawnSync` reports stdout either way. That makes the partial-output recovery the old
    // `catch (e) => e.stdout` blocks performed inherent rather than exceptional.
    return typeof res.stdout === 'string' ? res.stdout : '';
  } catch {
    return ''; // spawn itself failed -> no output -> every caller's vacuity guard fails closed
  } finally {
    if (CAN_REAP_GROUP && typeof pid === 'number' && pid > 0) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* group already empty — nothing to reap */ }
    }
  }
}

/**
 * Spawn the negative `node --test` against a single subject (set via the `GSD_PROHIB_SUBJECT`
 * convention, #1279) and return its TAP output. Reuses the bounded-subprocess machinery
 * (`process.execPath`, arg arrays → no shell, `childEnv`, bounded `timeout`/`maxBuffer`) and NEVER
 * throws — a RED run exits non-zero, but `runBoundedCapture` returns the TAP (with its `# fail`
 * summary) on stdout regardless of exit code. The prover calls this once per subject: the KNOWN-BAD violation fixture
 * (expect RED) and, for the #1346 causation control, the KNOWN-CLEAN control subject (expect GREEN).
 */
function runNodeTestWithSubject(check: CheckDescriptor, cwd: string, subject: string, timeoutMs?: number): string {
  return runBoundedCapture(
    process.execPath,
    buildNodeTestArgs(check),
    cwd,
    { ...childEnv(), GSD_PROHIB_SUBJECT: subject },
    posTimeout(timeoutMs, NODE_TEST_TIMEOUT_MS),
  );
}

function defaultRunCheck(check: CheckDescriptor, cwd: string, timeoutMs?: number): CheckRunResult {
  try {
    if (check.kind === 'node-test') {
      // A failing/timed-out run exits non-zero or is killed (partial TAP on stdout, no `# pass`
      // summary). Parse what we have: a real failure or timeout -> not a non-vacuous pass -> false.
      const out = runBoundedCapture(
        process.execPath,
        buildNodeTestArgs(check),
        cwd,
        childEnv(),
        posTimeout(timeoutMs, NODE_TEST_TIMEOUT_MS),
      );
      return { passed: isNonVacuousNodeTestPass(out, check.target) };
    }
    if (check.kind === 'lint-rule') {
      const eslintCli = resolveEslintCli(cwd);
      if (!eslintCli) return { passed: false }; // eslint not installed -> fail closed, never throw
      // eslint exits non-zero when ANY error is present; the JSON report is still on stdout.
      // A timeout/kill leaves no parseable JSON -> eslintHasFatalError(unparseable) -> fail-closed.
      const json = runBoundedCapture(
        process.execPath,
        [eslintCli, ...buildLintArgs(check)],
        cwd,
        childEnv(),
        posTimeout(timeoutMs, ESLINT_TIMEOUT_MS),
      );
      // PASS requires: the target actually linted (>=1 file result), NO fatal/parse error (the rule
      // must have RUN — #1259 B1), and ZERO messages for the rule (in messages OR suppressedMessages).
      const lintedSomething = eslintFileResultCount(json) >= 1;
      return {
        passed: lintedSomething && !eslintHasFatalError(json) && !eslintJsonHasRule(json, check.rule as string),
      };
    }
    // Unknown kind — defensive; the LOCATE guard already rejects it.
    return { passed: false };
  } catch {
    return { passed: false };
  }
}

/**
 * The default REAL fail-first prover (#1279; used when no `proveFailFirst` is injected). It runs the
 * wired check against the descriptor's `violationFixture` (a KNOWN-BAD subject) and requires it to go
 * RED — the machine proof that replaces caller attestation. Like `defaultRunCheck`, it is the
 * impure/injectable seam (spawns eslint / `node --test`), reuses the identical bounded-subprocess
 * machinery (`childEnv`/`posTimeout`/`CHECK_MAX_BUFFER`, `runBoundedCapture(process.execPath, …)`, arg
 * arrays → no shell), and NEVER throws — every un-provable path returns `{ provenFailFirst: false }`.
 *
 *   - lint-rule: lint the `violationFixture` via the project flat config (so `local/*` plugins load)
 *     and require the target to actually lint (>=1 file result) AND no fatal/parse error AND the rule
 *     id to appear in the report (messages OR suppressedMessages — an inline-disabled violation still
 *     proves the rule has teeth, #1259 B1). Absent fixture / unresolvable eslint → not proven.
 *   - node-test: spawn the negative test (TAP) with `GSD_PROHIB_SUBJECT` set to the `violationFixture`
 *     — the CONVENTION (#1279) by which a negative test reads its subject-under-test — and require a
 *     NON-VACUOUS red (`isNonVacuousNodeTestRed`: `# fail >= 1` AND a failing test named distinctly
 *     from the file, so a load-CRASH on the bad subject is not mistaken for the assertion firing red).
 *     A toothless test that passes anyway → not proven. Absent fixture → not proven (fail-closed;
 *     NEVER falls back to attestation).
 */
function defaultProveFailFirst(check: CheckDescriptor, cwd: string, timeoutMs?: number): FailFirstProof {
  try {
    if (check.kind === 'lint-rule') {
      const fixture = check.violationFixture;
      if (!fixture) return { provenFailFirst: false }; // can't prove without a known violation -> hard-gate
      const eslintCli = resolveEslintCli(cwd);
      if (!eslintCli) return { provenFailFirst: false }; // eslint not installed -> fail closed, never throw
      // eslint exits non-zero on any error; the JSON report is still on stdout. A timeout/kill
      // leaves no parseable JSON -> eslintHasFatalError(unparseable) -> not proven (fail-closed).
      const json = runBoundedCapture(
        process.execPath,
        [eslintCli, ...buildLintArgs({ ...check, target: fixture })],
        cwd,
        childEnv(),
        posTimeout(timeoutMs, ESLINT_TIMEOUT_MS),
      );
      // Proven iff: the fixture actually linted (>=1 file result), the rule RAN (no fatal/parse
      // error), and the rule id appears (the violation was flagged -> the rule has teeth).
      const proven = eslintFileResultCount(json) >= 1
        && !eslintHasFatalError(json)
        && eslintJsonHasRule(json, check.rule as string);
      return { provenFailFirst: proven, method: 'violation-fixture' };
    }
    if (check.kind === 'node-test') {
      const fixture = check.violationFixture;
      // Fail-CLOSED on a missing/typo'd/stale fixture path, SYMMETRIC with the lint-rule path's
      // `eslintFileResultCount >= 1` guard. Without the existence check, a non-existent fixture makes
      // `GSD_PROHIB_SUBJECT` point at a missing file; an honest negative test reading that subject
      // throws ENOENT *inside its callback* — a failing test named DISTINCTLY from the file, which
      // `isNonVacuousNodeTestRed` would accept as proof. That is fail-OPEN: a typo forges a green from
      // a setup crash, not from the prohibition firing. Requiring the fixture to exist before spawning
      // closes the realistic typo/stale-path case (#1279 review, Major 1).
      //
      // CAUSATION (#1346; MANDATORY as of #1906): existence + a non-vacuous red is necessary but not
      // sufficient — a deceptive negative test that reds merely BECAUSE `GSD_PROHIB_SUBJECT` is set
      // (rather than because the subject's CONTENT violates the must-NOT) would otherwise be accepted.
      // The `cleanFixture` control below proves content-dependence (red on bad AND green on clean) and is
      // now REQUIRED for the node-test kind: absent it, the check is un-provable (fail-closed), not
      // accepted under the weaker violation-only proof (#1906 supersedes #1346's opt-in; ADR-1606 D4).
      // Resolve the fixture against `cwd` (NOT the verify process's cwd): the spawned test reads
      // `GSD_PROHIB_SUBJECT` and resolves a relative subject against `cwd`, so the existence check must
      // use the SAME base or it could pass here yet ENOENT in the child (re-opening the fail-open hole).
      if (!fixture || !fs.existsSync(path.resolve(cwd, fixture))) return { provenFailFirst: false };
      // Run the negative test against the KNOWN-BAD subject and require a NON-VACUOUS red.
      const redOut = runNodeTestWithSubject(check, cwd, fixture, timeoutMs);
      if (!isNonVacuousNodeTestRed(redOut, check.target)) return { provenFailFirst: false, method: 'violation-fixture' };
      // #1906 CAUSATION CONTROL (MANDATORY for node-test — supersedes #1346's opt-in, ADR-1606 D4): the
      // clean control subject is REQUIRED. Run the SAME test against it and require it to stay GREEN,
      // proving the red above was caused by the subject's CONTENT — a deceptive test that reds merely
      // because GSD_PROHIB_SUBJECT is SET reds here too → not content-dependent → not proven. ABSENT →
      // the control cannot run → un-provable → fail-closed (NOT accepted under the weaker violation-only
      // proof). This is the one behavior change vs #1346: absent `cleanFixture` was previously proven.
      const clean = check.cleanFixture;
      if (!clean) return { provenFailFirst: false, method: 'violation-fixture' };
      // A supplied-but-missing/typo'd control path can't run the control → fail-closed, symmetric
      // with the violation-fixture existence guard (resolve against the SAME `cwd` as the child).
      if (!fs.existsSync(path.resolve(cwd, clean))) return { provenFailFirst: false, method: 'violation-fixture' };
      const cleanOut = runNodeTestWithSubject(check, cwd, clean, timeoutMs);
      if (!isNonVacuousNodeTestPass(cleanOut, check.target)) return { provenFailFirst: false, method: 'violation-fixture' };
      return { provenFailFirst: true, method: 'violation-fixture' };
    }
    // Unknown kind — defensive; the LOCATE guard already rejects it.
    return { provenFailFirst: false };
  } catch {
    return { provenFailFirst: false };
  }
}

export { defaultProveFailFirst };

/**
 * LOCATE -> PROVE fail-first -> RUN -> build enforcementEvidence -> dispositionForProhibition.
 *
 * (1) LOCATE: if no well-formed check descriptor is locatable -> fail-closed
 *     (`dispositionForProhibition` with empty evidence) plus `{ located: false, kind: null, evidence: [] }`.
 * (2) PROVE + RUN: machine-prove fail-first via `proveFailFirst` (default `defaultProveFailFirst`) AND
 *     run the check via `runCheck`. The green AND is `proof.provenFailFirst === true && run.passed ===
 *     true` — caller attestation is NOT consulted (FF-08). A check that cannot be proven fail-first, or
 *     that does not genuinely (non-vacuously) PASS -> fail-closed disposition with `located: true` (a
 *     real located miss, non-green, flagged) in BOTH modes.
 * (3) PASS: build a typed `enforcementEvidence` array (recording the proof method) and call
 *     `dispositionForProhibition` — the non-empty array flips a test-tier item to green.
 *
 * Pure/deterministic DECISION layer: the only impure seams are the injectable `runCheck`/`proveFailFirst`;
 * given their results the disposition is same-input-same-output and mutation-survivable.
 */
export function runProhibitionEnforcement(
  prohibition: unknown,
  check: CheckDescriptor | null | undefined,
  options: EnforcementOptions = {},
): EnforcementResult {
  const mode = options.mode;

  // (1) LOCATE — no locatable, well-formed wired check -> fail-closed, located: false. The kind must
  // be one of the two known kinds; the target must be a non-empty string; a lint-rule descriptor MUST
  // also carry a non-empty `rule` id (its target is the lint PATH, not the rule). An under-specified
  // descriptor is not a valid wired check, so it is not locatable (does not rely on the runner failing).
  const c = check && typeof check === 'object' ? check : null;
  const validKind = !!c && (c.kind === 'node-test' || c.kind === 'lint-rule');
  const validTarget = !!c && typeof c.target === 'string' && c.target.trim().length > 0;
  const validRule = !!c && (c.kind !== 'lint-rule' || (typeof c.rule === 'string' && c.rule.trim().length > 0));
  if (!c || !validKind || !validTarget || !validRule) {
    const disposition = dispositionForProhibition(prohibition, { enforcementEvidence: [] });
    return { ...disposition, located: false, kind: null, evidence: [], ...(mode ? { mode } : {}) };
  }

  const runCheck = options.runCheck ?? ((toRun: CheckDescriptor) => defaultRunCheck(toRun, options.cwd ?? process.cwd(), options.timeoutMs));
  const proveFailFirst = options.proveFailFirst ?? ((toProve: CheckDescriptor) => defaultProveFailFirst(toProve, options.cwd ?? process.cwd(), options.timeoutMs));

  // (2) PROVE fail-first (MACHINE) + RUN. The prover must INDEPENDENTLY run the check against the
  // descriptor's violation fixture and observe it go red (`proof.provenFailFirst`), AND the runner
  // must observe a genuine NON-VACUOUS pass. Caller attestation (`c.failFirst`) is NOT consulted for
  // the green verdict (FF-08) — a check that cannot be machine-proven fail-first hard-gates (never
  // green) in BOTH modes, even if attested.
  // No-throw contract end-to-end: even a (test-injected) prover/runner that throws must fail closed,
  // never propagate. The default real prover/runner already never throw.
  let proof: FailFirstProof;
  try {
    proof = proveFailFirst(c);
  } catch {
    proof = { provenFailFirst: false };
  }
  let run: CheckRunResult;
  try {
    run = runCheck(c);
  } catch {
    run = { passed: false };
  }
  // The `&&` and `=== true` are mutation-load-bearing — both directions (proven-red AND clean-pass)
  // must hold for green; Plan 01/02 guards pin them.
  const passed = proof.provenFailFirst === true && run.passed === true;

  if (!passed) {
    // NOT machine-proven fail-first OR did not genuinely pass -> fail-closed, located: true (an actual
    // located miss/fail). Hard-gate applies in BOTH modes; the disposition stays non-green / flagged.
    const disposition = dispositionForProhibition(prohibition, { enforcementEvidence: [] });
    return {
      ...disposition,
      located: true,
      kind: c.kind,
      evidence: [],
      ...(mode ? { mode } : {}),
    };
  }

  // (3) PASS -> build typed enforcementEvidence and let the policy flip a test-tier item green.
  // `failFirst: true` here means MACHINE-PROVEN (the green AND required `proof.provenFailFirst`),
  // and `failFirstProof` records HOW it was proven (FF-07).
  const evidence: EnforcementEvidence[] = [{
    kind: c.kind,
    target: c.target,
    ...(typeof c.rule === 'string' ? { rule: c.rule } : {}),
    failFirst: true,
    passed: true,
    ...(proof.method ? { failFirstProof: proof.method } : {}),
  }];
  const disposition = dispositionForProhibition(prohibition, { enforcementEvidence: evidence });
  return {
    ...disposition,
    located: true,
    kind: c.kind,
    evidence,
    ...(mode ? { mode } : {}),
  };
}

/**
 * Parse a `{ prohibition, check, mode }` request from a JSON file path or inline `--json` string.
 * Returns null on any parse failure (the caller surfaces a structured error, never a throw).
 */
function parseRequest(args: string[]): { prohibition: unknown; check: CheckDescriptor | null; mode?: string } | null {
  // args[0] = 'check', args[1] = 'prohibition-enforcement', args[2] = <json-file-path | --json>
  const jsonFlagIdx = args.indexOf('--json');
  let payload = '';
  if (jsonFlagIdx !== -1 && typeof args[jsonFlagIdx + 1] === 'string') {
    payload = args[jsonFlagIdx + 1];
  } else if (typeof args[2] === 'string' && args[2]) {
    try {
      payload = fs.readFileSync(args[2], 'utf-8');
    } catch {
      return null;
    }
  } else {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const checkRaw = parsed['check'];
    const check: CheckDescriptor | null = (checkRaw && typeof checkRaw === 'object')
      ? (checkRaw as CheckDescriptor)
      : null;
    const modeRaw = parsed['mode'];
    const mode = typeof modeRaw === 'string' ? modeRaw : undefined;
    return { prohibition: parsed['prohibition'] ?? null, check, ...(mode ? { mode } : {}) };
  } catch {
    return null;
  }
}

/**
 * CLI surface: `gsd_run check prohibition-enforcement <request.json>` (or `--json '<inline>'`).
 * Parses the request, runs the producer, and emits the result as JSON. Honors the no-throw
 * contract: malformed input -> structured `error(...)`, never an uncaught throw.
 */
export function routeProhibitionEnforcement(args: string[], raw: boolean): void {
  const req = parseRequest(args);
  if (!req) {
    error(
      'prohibition-enforcement requires a JSON request: check prohibition-enforcement <request.json> | --json \'{"prohibition":{...},"check":{...}}\'',
      ERROR_REASON.SDK_MISSING_ARG,
    );
    return;
  }
  const result = runProhibitionEnforcement(req.prohibition, req.check, req.mode ? { mode: req.mode } : {});
  output(result, raw, undefined);
}

export {};
