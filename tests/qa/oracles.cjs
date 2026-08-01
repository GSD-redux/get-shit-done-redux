'use strict';

/**
 * oracles.cjs — the QA-walk assertion set for `RunResult` values produced by
 * `tests/qa/result.cjs`.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `CONTRIBUTING.md` → "Prohibited: Raw Text Matching on Test Outputs" and
 * `RULESET.TESTS.no-source-grep.tmp-file-traps` forbid two things an oracle
 * might otherwise reach for: (1) inspecting a child process's raw stdout /
 * stderr text, and (2) reading the *content* of a file the system under test
 * wrote. `result.cjs` is the single place raw bytes are turned into the typed
 * `RunResult` (`{kind, exitCode, argv, json, err, pointer, warnings}`); every
 * oracle in this file therefore asserts ONLY on:
 *
 *   - `RunResult.kind` (one of the frozen `KIND` values),
 *   - parsed `json` / `err` fields (already-structured data, never prose),
 *   - `fs.statSync` FACTS handed in via `ctx.statsBefore` / `ctx.statsAfter`
 *     (`size`, `mtimeMs`, `isFile()`) — never file *contents*.
 *
 * No oracle here calls `fs.readFileSync` on an SUT-written artifact, and none
 * does substring/regex matching against a raw output string. Where a check
 * looks like it could be tempted into substring matching (value-hygiene,
 * below) it deliberately uses strict equality against a closed sentinel set
 * instead, which is what keeps it honest.
 *
 * ORACLE 3 AND ABSOLUTE PATHS
 * ───────────────────────────
 * `value-hygiene` flags a string only when it is *exactly* one of
 * `'undefined' | 'null' | 'NaN' | '[object Object]'` (the canonical
 * stringification artifacts of a real bug — a coercion that dropped a value).
 * It never does a substring/`.includes()` scan for a fragment like `null` or
 * `undefined` inside a larger string. That distinction matters because
 * `init` legitimately returns absolute filesystem paths, and an absolute path
 * can coincidentally *contain* a directory or file segment that looks like
 * one of those words (e.g. a user-named directory). A substring scan would
 * flag those as defects; a strict-equality scan against the closed sentinel
 * set structurally cannot, because a real path is never bit-for-bit equal to
 * `'undefined'` etc. False positives are worse than a missed defect for a QA
 * tool — they train operators to ignore the tool — so this oracle is
 * deliberately conservative.
 *
 * SEVERITY MODEL: VIOLATION vs SMELL
 * ───────────────────────────────────
 * The original nine oracles encoded today's engine behavior as the spec:
 * anything the engine currently does was, by construction, "legal" — the
 * harness could confirm the status quo but never say "this works but is
 * questionable." `SEVERITY` splits `check(ctx)` outcomes into two kinds:
 *
 *   - `SEVERITY.VIOLATION` — the documented contract is broken. This is what
 *     `failed` (and therefore `failed.length === 0` build gates) has always
 *     meant, and it keeps meaning exactly that after this change.
 *   - `SEVERITY.SMELL` — behavior that is legal today, does not fail any
 *     documented contract, but is evidence worth a human's attention (a
 *     design trade-off, a doc/code disagreement, a leaking value). A smell
 *     is reported in `runOracles(ctx).smells` and MUST NEVER appear in
 *     `failed` — it must never break a build. Its only job is to keep a
 *     known trade-off visible instead of silently invisible.
 *
 * A `check(ctx)` that fails now returns `{ ok: false, severity, detail }`;
 * `severity` defaults to `SEVERITY.VIOLATION` for every original oracle.
 */

const nodePath = require('node:path');
const { KIND } = require('./result.cjs');
const { resolveForCompare, isUnderProjectDir } = require('./paths.cjs');

/** Severity of a failed oracle outcome. A SMELL is evidence, not a verdict — it never fails a build. */
const SEVERITY = Object.freeze({ VIOLATION: 'violation', SMELL: 'smell' });

/** Exact-match sentinel strings that indicate a value was coerced by mistake. */
const SENTINEL_STRINGS = new Set(['undefined', 'null', 'NaN', '[object Object]']);

/** `json` field names checked by `monotonic-progress`, in no particular order. */
const PROGRESS_KEYS = ['total_plans', 'total_summaries', 'phases_completed'];

/**
 * Deep-walk an arbitrary JSON-ish value, invoking `visit(primitive, path)` for
 * every non-object leaf. Cycle-safe via a `WeakSet` of visited objects/arrays,
 * so a self-referential structure terminates instead of recursing forever.
 *
 * @param {unknown} value
 * @param {(leaf: unknown, path: string) => void} visit
 * @param {WeakSet<object>} seen
 * @param {string} path
 */
function walk(value, visit, seen, path) {
  if (value === null || typeof value !== 'object') {
    visit(value, path);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, visit, seen, `${path}[${i}]`));
    return;
  }
  for (const key of Object.keys(value)) {
    walk(value[key], visit, seen, `${path}.${key}`);
  }
}

/**
 * Structural equality for JSON-ish values. Cycle-tolerant via a `WeakMap` that
 * pairs "already compared" object references, so a self-referential structure
 * terminates instead of recursing forever.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {WeakMap<object, unknown>} seen
 * @returns {boolean}
 */
function deepEqual(a, b, seen) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key], seen)) return false;
  }
  return true;
}

/** @typedef {{ ok: true } | { ok: false, severity: string, detail: string }} OracleOutcome */

/**
 * Frozen array of `{ id, describe, check(ctx) -> OracleOutcome }` oracles.
 *
 * `ctx` shape (all optional except `result`):
 *   { result, prevResult, repeatResult, statsBefore, statsAfter, history,
 *     liveCommands, readOnly }
 *
 * Every `check` is wrapped in its own try/catch so a bug in one oracle can
 * never take the whole walk down — an oracle that throws is converted into a
 * `{ok:false}` naming the exception rather than crashing `runOracles`.
 */
const ORACLES = Object.freeze([
  Object.freeze({
    id: 'exit-contract',
    describe: 'result.kind must not be UNEXPECTED_EXIT or TIMEOUT.',
    check(ctx) {
      try {
        const kind = ctx && ctx.result && ctx.result.kind;
        if (kind === KIND.UNEXPECTED_EXIT || kind === KIND.TIMEOUT) {
          return { ok: false, severity: SEVERITY.VIOLATION, detail: `result.kind is "${kind}"` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, severity: SEVERITY.VIOLATION, detail: `exit-contract threw: ${err && err.message}` };
      }
    },
  }),

  Object.freeze({
    id: 'json-contract',
    describe:
      'result.kind must not be UNSTRUCTURED_ERROR; a STRUCTURED_ERROR must carry err.ok===false and a non-empty err.reason.',
    check(ctx) {
      try {
        const result = ctx && ctx.result;
        const kind = result && result.kind;
        if (kind === KIND.UNSTRUCTURED_ERROR) {
          return {
            ok: false,
            severity: SEVERITY.VIOLATION,
            detail: 'result.kind is "unstructured-error" (raw error text; --json-errors was ignored)',
          };
        }
        if (kind === KIND.STRUCTURED_ERROR) {
          const err = result.err;
          if (!err || typeof err !== 'object') {
            return {
              ok: false,
              severity: SEVERITY.VIOLATION,
              detail: `result.err is ${JSON.stringify(err)}, expected an object`,
            };
          }
          if (err.ok !== false) {
            return {
              ok: false,
              severity: SEVERITY.VIOLATION,
              detail: `result.err.ok is ${JSON.stringify(err.ok)}, expected false`,
            };
          }
          if (typeof err.reason !== 'string' || err.reason === '') {
            return {
              ok: false,
              severity: SEVERITY.VIOLATION,
              detail: `result.err.reason is ${JSON.stringify(err.reason)}, expected a non-empty string`,
            };
          }
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, severity: SEVERITY.VIOLATION, detail: `json-contract threw: ${err && err.message}` };
      }
    },
  }),

  Object.freeze({
    id: 'value-hygiene',
    describe:
      'result.json must not contain a NaN number or a string exactly equal to a coercion-artifact sentinel ' +
      '(VIOLATION). When ctx.projectDir is supplied, an absolute-path string outside it is reported as a SMELL — ' +
      'never a violation, since paths like init\'s are legitimate, but a payload leaking a path outside the project ' +
      'is worth a human look. Without ctx.projectDir the path check is skipped rather than guessed.',
    check(ctx) {
      try {
        const violations = [];
        const smells = [];
        const seen = new WeakSet();
        const json = ctx && ctx.result ? ctx.result.json : undefined;
        const projectDir = ctx && typeof ctx.projectDir === 'string' ? ctx.projectDir : null;
        // Resolved once per runOracles call (this check runs exactly once per ctx), not once
        // per candidate string below — projectDir is the same value for every leaf in the walk.
        const resolvedProjectDir = projectDir !== null ? resolveForCompare(projectDir) : null;
        walk(json, (leaf, path) => {
          if (typeof leaf === 'number' && Number.isNaN(leaf)) {
            violations.push(`NaN at ${path}`);
          } else if (typeof leaf === 'string' && SENTINEL_STRINGS.has(leaf)) {
            violations.push(`sentinel string ${JSON.stringify(leaf)} at ${path}`);
          } else if (
            resolvedProjectDir !== null &&
            typeof leaf === 'string' &&
            nodePath.isAbsolute(leaf) &&
            !isUnderProjectDir(resolveForCompare(leaf), resolvedProjectDir)
          ) {
            smells.push(`absolute path ${JSON.stringify(leaf)} at ${path} is outside ctx.projectDir ${JSON.stringify(projectDir)}`);
          }
        }, seen, '$');
        if (violations.length) {
          return { ok: false, severity: SEVERITY.VIOLATION, detail: violations.join('; ') };
        }
        if (smells.length) {
          return { ok: false, severity: SEVERITY.SMELL, detail: smells.join('; ') };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, severity: SEVERITY.VIOLATION, detail: `value-hygiene threw: ${err && err.message}` };
      }
    },
  }),

  Object.freeze({
    id: 'read-only-idempotence',
    describe:
      'For commands documented as read-only: repeatResult.json must deep-equal result.json, and statsBefore/statsAfter must be identical on every key. ' +
      'An oracle asked to check idempotence without the data to check it FAILS (VIOLATION) rather than passing vacuously — missing repeatResult, ' +
      'statsBefore, or statsAfter is itself a finding, named explicitly in the detail.',
    check(ctx) {
      try {
        if (!ctx || !ctx.readOnly) return { ok: true };
        const findings = [];
        if (!ctx.repeatResult) {
          findings.push('ctx.readOnly is true but ctx.repeatResult is missing — idempotence cannot be checked');
        } else if (ctx.result) {
          if (!deepEqual(ctx.result.json, ctx.repeatResult.json, new WeakMap())) {
            findings.push('repeatResult.json is not deep-equal to result.json');
          }
        }
        if (!(ctx.statsBefore instanceof Map)) {
          findings.push('ctx.readOnly is true but ctx.statsBefore is missing — idempotence cannot be checked');
        }
        if (!(ctx.statsAfter instanceof Map)) {
          findings.push('ctx.readOnly is true but ctx.statsAfter is missing — idempotence cannot be checked');
        }
        const before = ctx.statsBefore instanceof Map ? ctx.statsBefore : new Map();
        const after = ctx.statsAfter instanceof Map ? ctx.statsAfter : new Map();
        const beforeKeys = new Set(before.keys());
        const afterKeys = new Set(after.keys());
        const sameKeys =
          beforeKeys.size === afterKeys.size && [...beforeKeys].every((k) => afterKeys.has(k));
        if (!sameKeys) {
          findings.push(
            `statsBefore/statsAfter key sets differ: before=[${[...beforeKeys].join(',')}] after=[${[...afterKeys].join(',')}]`,
          );
        } else {
          for (const key of beforeKeys) {
            const b = before.get(key);
            const a = after.get(key);
            if (b && a && b.size !== a.size) {
              findings.push(`stat "${key}".size changed: ${b.size} -> ${a.size}`);
            }
            if (b && a && b.mtimeMs !== a.mtimeMs) {
              findings.push(`stat "${key}".mtimeMs changed: ${b.mtimeMs} -> ${a.mtimeMs}`);
            }
          }
        }
        return findings.length
          ? { ok: false, severity: SEVERITY.VIOLATION, detail: findings.join('; ') }
          : { ok: true };
      } catch (err) {
        return {
          ok: false,
          severity: SEVERITY.VIOLATION,
          detail: `read-only-idempotence threw: ${err && err.message}`,
        };
      }
    },
  }),

  Object.freeze({
    id: 'monotonic-progress',
    describe:
      'Numeric total_plans/total_summaries/phases_completed fields must never decrease across history + result, in walk order.',
    check(ctx) {
      try {
        const history = ctx && Array.isArray(ctx.history) ? ctx.history : [];
        const entries = ctx && ctx.result ? [...history, ctx.result] : history;
        const findings = [];
        for (const key of PROGRESS_KEYS) {
          let prevValue;
          let prevIndex = -1;
          entries.forEach((entry, index) => {
            const json = entry && entry.json;
            if (json === null || typeof json !== 'object' || Array.isArray(json)) return;
            const value = json[key];
            if (typeof value !== 'number' || Number.isNaN(value)) return;
            if (prevValue !== undefined && value < prevValue) {
              findings.push(
                `${key} decreased from ${prevValue} (entry ${prevIndex}) to ${value} (entry ${index})`,
              );
            }
            prevValue = value;
            prevIndex = index;
          });
        }
        return findings.length
          ? { ok: false, severity: SEVERITY.VIOLATION, detail: findings.join('; ') }
          : { ok: true };
      } catch (err) {
        return { ok: false, severity: SEVERITY.VIOLATION, detail: `monotonic-progress threw: ${err && err.message}` };
      }
    },
  }),

  Object.freeze({
    id: 'routing-validity',
    describe:
      'A result.json.recommended / recommended_command token must name a command present in ctx.liveCommands.',
    check(ctx) {
      try {
        const json = ctx && ctx.result ? ctx.result.json : undefined;
        if (json === null || typeof json !== 'object' || Array.isArray(json)) return { ok: true };
        const field = Object.prototype.hasOwnProperty.call(json, 'recommended')
          ? 'recommended'
          : Object.prototype.hasOwnProperty.call(json, 'recommended_command')
            ? 'recommended_command'
            : null;
        if (field === null) return { ok: true };
        const value = json[field];
        if (typeof value !== 'string') return { ok: true };
        const liveCommands = ctx && Array.isArray(ctx.liveCommands) ? ctx.liveCommands : [];
        if (!liveCommands.includes(value)) {
          return {
            ok: false,
            severity: SEVERITY.VIOLATION,
            detail: `${field}=${JSON.stringify(value)} is not in ctx.liveCommands`,
          };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, severity: SEVERITY.VIOLATION, detail: `routing-validity threw: ${err && err.message}` };
      }
    },
  }),

  Object.freeze({
    id: 'determinism',
    describe: 'When a repeatResult is present, its kind must match the original result.kind.',
    check(ctx) {
      try {
        if (!ctx || !ctx.repeatResult || !ctx.result) return { ok: true };
        if (ctx.repeatResult.kind !== ctx.result.kind) {
          return {
            ok: false,
            severity: SEVERITY.VIOLATION,
            detail: `repeatResult.kind "${ctx.repeatResult.kind}" !== result.kind "${ctx.result.kind}"`,
          };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, severity: SEVERITY.VIOLATION, detail: `determinism threw: ${err && err.message}` };
      }
    },
  }),

  Object.freeze({
    id: 'soft-error-exit-zero',
    describe:
      'SMELL, not a violation: result.kind === KIND.SOFT_ERROR means the operation reported failure through a ' +
      'payload key ({error:...}) while exiting 0. Every shell caller\'s `if ! cmd; then` is blind to that failure. ' +
      'This is legal today (42 call sites use output({error:...})) and is deliberately NOT changed here — the ' +
      'blast radius of changing it is CRITICAL — but it is reported so the trade stays visible instead of invisible.',
    check(ctx) {
      try {
        const result = ctx && ctx.result;
        if (!result || result.kind !== KIND.SOFT_ERROR) return { ok: true };
        const argv = Array.isArray(result.argv) ? result.argv.join(' ') : '(no argv)';
        const errorValue = result.json && typeof result.json === 'object' ? result.json.error : undefined;
        return {
          ok: false,
          severity: SEVERITY.SMELL,
          detail: `command "${argv}" exited 0 but carries result.json.error = ${JSON.stringify(errorValue)}`,
        };
      } catch (err) {
        return { ok: false, severity: SEVERITY.SMELL, detail: `soft-error-exit-zero threw: ${err && err.message}` };
      }
    },
  }),

  Object.freeze({
    id: 'untyped-success',
    describe:
      'SMELL, not a violation: result.kind === KIND.PROSE means the command only emits rendered text with no ' +
      'typed surface to assert on. CONTRIBUTING.md forbids asserting on rendered text, so a prose-only command is ' +
      'permanently unassertable by this harness — the gap is in the product, not the test.',
    check(ctx) {
      try {
        const result = ctx && ctx.result;
        if (!result || result.kind !== KIND.PROSE) return { ok: true };
        const argv = Array.isArray(result.argv) ? result.argv.join(' ') : '(no argv)';
        return {
          ok: false,
          severity: SEVERITY.SMELL,
          detail: `command "${argv}" emits KIND.PROSE only; no typed surface exists to assert on`,
        };
      } catch (err) {
        return { ok: false, severity: SEVERITY.SMELL, detail: `untyped-success threw: ${err && err.message}` };
      }
    },
  }),

  Object.freeze({
    id: 'contract-conflict',
    describe:
      'SMELL, not a violation: fires only when ctx.jsonErrorMode === true and result.kind === KIND.UNSTRUCTURED_ERROR. ' +
      'Deliberately overlaps json-contract, which reports the same observation as a VIOLATION of the documented ' +
      'contract in docs/json-errors.md ("On any error, exactly one JSON line is written to stderr and the process ' +
      'exits with code 1"). This oracle instead reports that the two controlling documents disagree: src/cli-exit.cts ' +
      'runMain returns for an ExitError before reaching the json-error branch, so CLI usage errors emit plain text by ' +
      'design. A reader of both oracles sees the breach (json-contract) and the reason it is ambiguous (contract-conflict).',
    check(ctx) {
      try {
        const result = ctx && ctx.result;
        if (!ctx || ctx.jsonErrorMode !== true) return { ok: true };
        if (!result || result.kind !== KIND.UNSTRUCTURED_ERROR) return { ok: true };
        const argv = Array.isArray(result.argv) ? result.argv.join(' ') : '(no argv)';
        return {
          ok: false,
          severity: SEVERITY.SMELL,
          detail:
            `command "${argv}" emitted unstructured-error text under --json-errors, conflicting docs: ` +
            'docs/json-errors.md says "On any error, exactly one JSON line is written to stderr and the process ' +
            'exits with code 1", but src/cli-exit.cts runMain returns for an ExitError before the json-error branch, ' +
            'so CLI usage errors emit plain text by design',
        };
      } catch (err) {
        return { ok: false, severity: SEVERITY.SMELL, detail: `contract-conflict threw: ${err && err.message}` };
      }
    },
  }),
]);

/**
 * Run every oracle against `ctx` and bucket the outcomes by severity.
 *
 * Each `check` is additionally guarded here (belt-and-suspenders on top of
 * each oracle's own try/catch) so a defect in one oracle can never abort the
 * walk for the rest. An outcome with no recognized `severity` is treated as
 * `SEVERITY.VIOLATION` — the conservative default, so a bug in an oracle can
 * never silently downgrade a break into a smell.
 *
 * The returned object carries a `failed` GETTER that is an alias for
 * `violations` ONLY — it deliberately excludes `smells`. This preserves the
 * meaning every existing caller already relies on (`failed.length === 0` as
 * a build gate): a SMELL must never fail a build. Smells are evidence for a
 * human, surfaced separately in `.smells`, never folded into the pass/fail
 * verdict.
 *
 * @param {object} ctx
 * @returns {{
 *   passed: string[],
 *   violations: { id: string, detail: string }[],
 *   smells: { id: string, detail: string }[],
 *   readonly failed: { id: string, detail: string }[],
 * }}
 */
function runOracles(ctx) {
  const passed = [];
  const violations = [];
  const smells = [];
  for (const oracle of ORACLES) {
    let outcome;
    try {
      outcome = oracle.check(ctx);
    } catch (err) {
      outcome = { ok: false, severity: SEVERITY.VIOLATION, detail: `${oracle.id} threw: ${err && err.message}` };
    }
    if (outcome && outcome.ok) {
      passed.push(oracle.id);
      continue;
    }
    const finding = { id: oracle.id, detail: (outcome && outcome.detail) || 'oracle failed with no detail' };
    if (outcome && outcome.severity === SEVERITY.SMELL) {
      smells.push(finding);
    } else {
      violations.push(finding);
    }
  }
  return {
    passed,
    violations,
    smells,
    get failed() {
      return violations;
    },
  };
}

module.exports = { ORACLES, runOracles, SEVERITY };
