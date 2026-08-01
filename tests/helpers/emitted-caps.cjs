'use strict';

/**
 * emitted-caps.cjs — the per-runtime emitted-byte cap decision (issue #2931,
 * epic #1671, Phase 4). Sibling law to `emitted-diff.cjs`'s conservation law:
 * same pure/IO split, same error-accumulation shape, same reserved-key guard.
 *
 * ── Why this module is pure ──────────────────────────────────────────────────
 * No fs, no git, no clock, no process. The expensive part — spawning an
 * install and measuring real emitted bytes — lives elsewhere; this module only
 * decides, given a `{ [runtime]: { [rel]: bytes } }` map and a cap table,
 * which artifacts violate, which are unmeasured, and which comply. Keeping the
 * decision pure makes every boundary (`cap-1`/`cap`/`cap+1`) a millisecond
 * table test and keeps the Stryker gate able to bite.
 *
 * ── Why the cap table is HARD-CODED here, not read from capability.json ─────
 * ADR-2719's guiding principle (already load-bearing in `emitted-diff.cjs`:
 * it never re-derives a byte, because asserting `emitted == transform(source)`
 * is the tautology ADR-2264's Amendment rejected) applies here too, one level
 * up: a cap that is DERIVED from the same descriptor it is meant to guard
 * (`capabilities/<rt>/capability.json`) would silently follow any edit to that
 * descriptor. Bump the descriptor, the guard bumps with it, and a real
 * regression sails through unnoticed. `EMITTED_CAPS` is a second, independent
 * source of truth, edited deliberately by a human who has to look Windsurf's
 * actual 12,000-byte platform limit in the eye — exactly the friction a guard
 * exists to provide.
 */

// ─── REASON enum ───────────────────────────────────────────────────────────

const REASON = Object.freeze({
  CAP_EXCEEDED: 'cap_exceeded',
  DEAD_RULE: 'dead_rule',
  UNKNOWN_RUNTIME: 'unknown_runtime',
  NO_ARTIFACTS: 'no_artifacts',
  INVALID_SIZES: 'invalid_sizes',
  INVALID_CAP_TABLE: 'invalid_cap_table',
  INVALID_CAP_VALUE: 'invalid_cap_value',
  RESERVED_KEY: 'reserved_key',
  UNSAFE_PATTERN: 'unsafe_pattern',
});

/**
 * Keys that can never legitimately name a runtime or an emitted path, and
 * that also happen to be the JS-object footguns. Mirrors
 * `emitted-diff.cjs`'s `RESERVED_ACK_KEYS`: rejected LOUDLY (REASON.RESERVED_KEY),
 * never silently dropped.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The declared per-runtime emitted-byte cap table. Exactly one real entry
 * today: Windsurf hard-caps a workspace workflow file at 12,000 bytes.
 *
 * Shape: `{ [runtime]: Array<{ pattern, maxBytes, note }> }`. `pattern` is a
 * simple glob, evaluated against the emitted-relative path: `*` matches
 * within one path segment (never crosses `/`), `**` matches across segments.
 * Frozen two levels deep so a test cannot mutate the shipped table out from
 * under a later assertion in the same run.
 */
const EMITTED_CAPS = Object.freeze({
  windsurf: Object.freeze([
    Object.freeze({
      pattern: 'workflows/*.md',
      maxBytes: 12000,
      note: 'Windsurf hard-caps workspace workflow files at 12,000 bytes.',
    }),
  ]),
});

// ─── Small predicates ────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeNameOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A legal byte count or cap value: a `number`, never a coerced string, never
 *  negative, NaN, Infinity, or fractional. `Number.isSafeInteger` alone
 *  already excludes NaN/Infinity/non-integers; `>= 0` excludes negatives. */
function isNonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** `..` traversal or a leading `/` in a cap-table pattern is never legitimate
 *  — every emitted-relative path in this repo is already relative and
 *  segment-clean, so either shape can only be an authoring mistake or a
 *  hostile table entry. */
function isUnsafePattern(pattern) {
  return pattern.includes('..') || pattern.startsWith('/');
}

/**
 * Translate a `pattern` (already validated safe) into an anchored RegExp.
 * `*` -> one path segment (`[^/]*`); `**` -> across segments (`.*`). Every
 * other character is escaped, so a pattern is never accidentally read as a
 * richer regex than the two glob tokens it declares.
 */
function compileGlobPattern(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Stable comparator: runtime, then rel/pattern. Plain `<`/`>` on strings,
 *  not `localeCompare`, so ordering is locale-independent and reproducible. */
function byRuntimeThen(field) {
  return (a, b) => {
    if (a.runtime !== b.runtime) return a.runtime < b.runtime ? -1 : 1;
    if (a[field] === b[field]) return 0;
    return a[field] < b[field] ? -1 : 1;
  };
}

// ─── The decision ────────────────────────────────────────────────────────────

/**
 * Evaluate every measured emitted artifact against the declared cap table.
 *
 * ── The conservation law (by construction) ───────────────────────────────
 * Every `(runtime, rel)` key in `sizes` whose byte value is a legal
 * non-negative safe integer, and whose `runtime`/`rel` are not reserved
 * keys, is placed into EXACTLY ONE of `violations`, `unmeasured`, or
 * `compliant` — the single walk below assigns each such key to precisely one
 * push. A key excluded by a RESERVED_KEY or INVALID_SIZES error is not a
 * legitimate size measurement at all (its own error already names it), so it
 * is not counted as a fourth bucket; the law is over the WELL-FORMED subset,
 * exactly as `diffEmitted`'s conservation law is over the entries `parseAck`
 * accepted.
 *
 * Internal bookkeeping (which rule matched which path, for dead-rule
 * detection) is kept as index-based tracking, never as an object keyed by an
 * external string — so a hostile `rel`/`runtime` value cannot pollute
 * anything even transiently.
 *
 * @param {object} opts
 * @param {object} opts.sizes    { [runtime]: { [rel]: bytes } }
 * @param {object} [opts.capTable] defaults to the shipped `EMITTED_CAPS`
 * @returns {{
 *   violations: Array, unmeasured: Array, compliant: Array,
 *   deadRules: Array, errors: Array, ok: boolean
 * }}
 */
function evaluateEmittedCaps({ sizes, capTable = EMITTED_CAPS } = {}) {
  const errors = [];

  if (sizes === null || sizes === undefined) {
    errors.push({
      reason: REASON.INVALID_SIZES,
      receivedType: sizes === null ? 'null' : 'undefined',
      message: `sizes is required, got ${sizes === null ? 'null' : 'undefined'}`,
    });
  } else if (!isPlainObject(sizes)) {
    errors.push({
      reason: REASON.INVALID_SIZES,
      receivedType: typeNameOf(sizes),
      message: `sizes must be a plain object keyed by runtime, got ${typeNameOf(sizes)}`,
    });
  }

  if (capTable === null || capTable === undefined || !isPlainObject(capTable)) {
    errors.push({
      reason: REASON.INVALID_CAP_TABLE,
      receivedType: typeNameOf(capTable),
      message: `capTable must be a plain object keyed by runtime, got ${typeNameOf(capTable)}`,
    });
  }

  if (errors.length) {
    return { violations: [], unmeasured: [], compliant: [], deadRules: [], errors, ok: false };
  }

  const violations = [];
  const unmeasured = [];
  const compliant = [];
  const deadRules = [];

  // ── capTable validation, once, up front — never at compare time ──────────
  // Maps `runtime -> Array<{ regex, maxBytes, note, pattern, matches: number }>`
  // for runtimes that ARE known (present in `sizes`) and whose rules parsed
  // cleanly. Keyed on `runtime`, but only ever assigned via `Map.set`, never
  // bracket-property assignment — a hostile `__proto__` runtime name cannot
  // pollute anything here either.
  const compiledRules = new Map();
  const knownRuntimeNoArtifacts = new Set();

  for (const runtime of Object.keys(capTable)) {
    if (RESERVED_KEYS.has(runtime)) {
      errors.push({
        reason: REASON.RESERVED_KEY,
        scope: 'capTable-runtime',
        key: runtime,
        message: `capTable key "${runtime}" is reserved and can never be a real runtime name`,
      });
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(sizes, runtime)) {
      // A cap declared for a runtime that never even reported sizes. Not
      // installable/measured in this run at all — a hard error, distinct
      // from "measured but produced zero files" (REASON.NO_ARTIFACTS below).
      errors.push({
        reason: REASON.UNKNOWN_RUNTIME,
        runtime,
        message: `capTable declares caps for "${runtime}", but sizes has no entry for it`,
      });
      continue;
    }

    const rules = capTable[runtime];
    if (!Array.isArray(rules)) {
      errors.push({
        reason: REASON.INVALID_CAP_TABLE,
        runtime,
        message: `capTable.${runtime} must be an array of rules, got ${typeNameOf(rules)}`,
      });
      continue;
    }

    const parsed = [];
    rules.forEach((rule, index) => {
      if (!isPlainObject(rule)) {
        errors.push({
          reason: REASON.INVALID_CAP_TABLE,
          runtime,
          index,
          message: `capTable.${runtime}[${index}] must be an object with pattern/maxBytes`,
        });
        return;
      }

      const { pattern, maxBytes, note } = rule;

      let patternOk = true;
      if (typeof pattern !== 'string' || pattern.length === 0) {
        errors.push({
          reason: REASON.INVALID_CAP_TABLE,
          runtime,
          index,
          message: `capTable.${runtime}[${index}].pattern must be a non-empty string`,
        });
        patternOk = false;
      } else if (isUnsafePattern(pattern)) {
        errors.push({
          reason: REASON.UNSAFE_PATTERN,
          runtime,
          pattern,
          message: `capTable.${runtime}[${index}].pattern "${pattern}" contains a ".." traversal or a leading "/"`,
        });
        patternOk = false;
      }

      let capOk = true;
      if (!isNonNegativeSafeInteger(maxBytes)) {
        errors.push({
          reason: REASON.INVALID_CAP_VALUE,
          runtime,
          pattern: typeof pattern === 'string' ? pattern : null,
          value: maxBytes,
          message:
            `capTable.${runtime}[${index}].maxBytes must be a non-negative safe integer, `
            + `got ${JSON.stringify(maxBytes)} (${typeNameOf(maxBytes)})`,
        });
        capOk = false;
      }

      if (patternOk && capOk) {
        parsed.push({
          pattern,
          regex: compileGlobPattern(pattern),
          maxBytes,
          note: typeof note === 'string' ? note : undefined,
          matches: 0,
        });
      }
    });

    compiledRules.set(runtime, parsed);
  }

  // ── Walk sizes, sorted, and assign every well-formed key exactly once ────
  for (const runtime of Object.keys(sizes).sort()) {
    if (RESERVED_KEYS.has(runtime)) {
      errors.push({
        reason: REASON.RESERVED_KEY,
        scope: 'sizes-runtime',
        key: runtime,
        message: `sizes key "${runtime}" is reserved and can never be a real runtime name`,
      });
      continue;
    }

    const artifacts = sizes[runtime];
    if (!isPlainObject(artifacts)) {
      errors.push({
        reason: REASON.INVALID_SIZES,
        runtime,
        message: `sizes.${runtime} must be a plain object of { rel: bytes }, got ${typeNameOf(artifacts)}`,
      });
      continue;
    }

    const rels = Object.keys(artifacts);
    if (rels.length === 0) {
      errors.push({
        reason: REASON.NO_ARTIFACTS,
        runtime,
        message: `sizes.${runtime} produced no artifacts — never read "nothing to check" as "pass"`,
      });
      knownRuntimeNoArtifacts.add(runtime);
      continue;
    }

    const rules = compiledRules.get(runtime) || [];

    for (const rel of rels.sort()) {
      if (RESERVED_KEYS.has(rel)) {
        errors.push({
          reason: REASON.RESERVED_KEY,
          scope: 'sizes-rel',
          runtime,
          key: rel,
          message: `sizes.${runtime} key "${rel}" is reserved and can never be a real emitted path`,
        });
        continue;
      }

      const bytes = artifacts[rel];
      if (!isNonNegativeSafeInteger(bytes)) {
        errors.push({
          reason: REASON.INVALID_SIZES,
          runtime,
          rel,
          message:
            `sizes.${runtime}["${rel}"] must be a non-negative safe integer, `
            + `got ${JSON.stringify(bytes)} (${typeNameOf(bytes)})`,
        });
        continue;
      }

      const rule = rules.find((r) => r.regex.test(rel));
      if (!rule) {
        unmeasured.push({ runtime, rel, bytes });
        continue;
      }

      rule.matches += 1;
      if (bytes <= rule.maxBytes) {
        compliant.push({ runtime, rel, bytes, cap: rule.maxBytes });
      } else {
        violations.push({
          runtime,
          rel,
          bytes,
          cap: rule.maxBytes,
          delta: bytes - rule.maxBytes,
          reason: REASON.CAP_EXCEEDED,
          note: rule.note,
        });
      }
    }
  }

  // ── Dead rules: matched nothing across the WHOLE run ──────────────────────
  // Skipped for runtimes already flagged UNKNOWN_RUNTIME or NO_ARTIFACTS —
  // those are more specific, more actionable errors, and a rule for a
  // runtime with zero measured artifacts trivially matches nothing for a
  // reason this walk already named.
  for (const [runtime, rules] of compiledRules) {
    if (knownRuntimeNoArtifacts.has(runtime)) continue;
    for (const rule of rules) {
      if (rule.matches === 0) {
        deadRules.push({
          runtime,
          pattern: rule.pattern,
          cap: rule.maxBytes,
          reason: REASON.DEAD_RULE,
          message: `capTable.${runtime} rule "${rule.pattern}" matched zero emitted paths — a cap guarding nothing is rot`,
        });
      }
    }
  }

  violations.sort(byRuntimeThen('rel'));
  unmeasured.sort(byRuntimeThen('rel'));
  compliant.sort(byRuntimeThen('rel'));
  deadRules.sort(byRuntimeThen('pattern'));

  const ok = errors.length === 0 && violations.length === 0 && deadRules.length === 0;

  return { violations, unmeasured, compliant, deadRules, errors, ok };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Pure renderer. Tests assert on `evaluateEmittedCaps`'s structured result,
 * never on this string (CONTRIBUTING.md, "Prohibited: Raw Text Matching on
 * Test Outputs").
 *
 * The CAP_EXCEEDED message deliberately warns against the Goodhart's-Law
 * escape hatch: moving bytes behind an EAGERLY `@`-imported reference file
 * changes where the bytes are typed, not how many bytes load. An eager
 * `@`-import is inlined at load time, so the cap would read green while the
 * runtime still pays every byte — gaming the metric, not complying with it
 * (this exact failure mode is recorded in CONTEXT.md
 * `RULESET.WORKFLOW_SIZE_BUDGET`).
 */
function formatCapReport(result) {
  const parts = [];

  if (result.errors.length) {
    parts.push(
      `${result.errors.length} error(s):\n  ${result.errors.map((e) => e.message).join('\n  ')}`,
    );
  }

  if (result.violations.length) {
    const list = result.violations.map(
      (v) => `  ${v.runtime}: ${v.rel} is ${v.bytes} bytes — exceeds the ${v.cap}-byte cap by ${v.delta}`
        + (v.note ? ` (${v.note})` : ''),
    );
    parts.push(
      `${result.violations.length} emitted artifact(s) exceed their declared cap:\n${list.join('\n')}\n\n`
      + 'Moving these bytes behind an EAGERLY `@`-imported reference file is gaming this '
      + 'metric, not complying with it: an eager @-import is inlined before the cap is ever '
      + 'measured, so the runtime still pays every byte at load time (CONTEXT.md '
      + 'RULESET.WORKFLOW_SIZE_BUDGET). The fix is to reduce what actually loads.',
    );
  }

  if (result.deadRules.length) {
    const list = result.deadRules.map((r) => `  ${r.runtime}: "${r.pattern}" (cap ${r.cap}) matched nothing`);
    parts.push(`${result.deadRules.length} cap rule(s) matched zero emitted paths — a cap guarding nothing is rot:\n${list.join('\n')}`);
  }

  return parts.join('\n\n');
}

module.exports = {
  REASON,
  EMITTED_CAPS,
  evaluateEmittedCaps,
  formatCapReport,
};
