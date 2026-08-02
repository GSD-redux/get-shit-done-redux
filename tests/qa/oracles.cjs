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

/**
 * Leaf JSON-key names whose CONTRACT is to point OUTSIDE the project directory —
 * `value-hygiene`'s absolute-path-leak sub-check allowlists these by LEAF key
 * name only (never by value, never by full path), so a legitimately-external
 * field never manufactures a finding. This is an allowlist of contractually
 * external fields, NOT a general suppression: adding a key here requires
 * actually knowing that field's contract — that EVERY value it ever holds is
 * expected to live outside `ctx.projectDir` — not just that it happened to fire
 * once. The sub-check still fires (as a SMELL) for any absolute path outside
 * the project on a key NOT in this set — see #2966 FIX 1.
 *
 * - `agents_dir` — `agent-install-check.cts`'s `getAgentsDir` /
 *   `checkAgentsInstalled`, surfaced on every `init` subcommand's response via
 *   `init.cts`'s `withProjectRoot`. Points at the INSTALL tree (the runtime's
 *   global config dir, or — for the `claude` runtime — the `agents/` directory
 *   bundled as a sibling of `gsd-core/`), never at the project: agents are
 *   installed once, not per-project.
 */
const EXTERNAL_PATH_ALLOWED_KEYS = Object.freeze(new Set(['agents_dir']));

/**
 * Extract the leaf key name from a `walk()`-built path (e.g. `"$.agents_dir"`
 * -> `"agents_dir"`, `"$.foo.bar[3]"` -> `"bar"` for the array element itself,
 * `"$.arr[3]"` -> `"arr"` is NOT how this parses — array indices are not key
 * names, so a leaf under an array index has no matching allowlist entry by
 * design; only a genuine object key can match `EXTERNAL_PATH_ALLOWED_KEYS`.
 *
 * @param {string} walkPath
 * @returns {string}
 */
function leafKeyOf(walkPath) {
  const segments = walkPath.split('.');
  const last = segments[segments.length - 1];
  const bracketIdx = last.indexOf('[');
  return bracketIdx === -1 ? last : last.slice(0, bracketIdx);
}

/** `json` field names checked by `monotonic-progress`, in no particular order. */
const PROGRESS_KEYS = ['total_plans', 'total_summaries', 'phases_completed'];

/**
 * Extract the active workstream id from an argv array, e.g.
 * `['--json-errors', '--ws', 'alpha', 'progress']` -> `'alpha'`. Returns `null`
 * when no `--ws` flag is present (the default/unnamed workstream) — never
 * `undefined`, so two "no workstream" entries compare equal via `===`.
 *
 * @param {unknown} argv
 * @returns {string | null}
 */
function workstreamFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  const idx = argv.indexOf('--ws');
  if (idx === -1 || idx + 1 >= argv.length) return null;
  const value = argv[idx + 1];
  return typeof value === 'string' ? value : null;
}

/**
 * The comparability scope for a `monotonic-progress` entry: two entries are
 * comparable only when their milestone (`milestone_version` + `milestone_name`,
 * the fields a real `progress`/`stats` payload actually exposes — see
 * `roadmap-parser.cts` `getMilestoneInfo`) AND active workstream (derived from
 * the invocation's own `argv`, since no payload observed in this codebase
 * carries a workstream field) all match. `milestone_version` alone is NOT
 * sufficient: a fixture/project whose ROADMAP.md never carries an explicit
 * `vX.Y` marker keeps reporting the same fallback `"v1.0"`/`"milestone"` pair
 * across a real milestone-complete boundary until a roadmap for the *next*
 * milestone is actually written (verified empirically against `milestone
 * complete` — see scenarios/milestone-rollover.json) — `milestone_name` is
 * threaded in alongside version for the same reason value-hygiene documents
 * elsewhere in this file: a cheap, purely-structural signal is preferred over
 * inferring intent from command names.
 *
 * @param {{json?: unknown, argv?: unknown}} entry
 * @returns {{milestoneVersion: unknown, milestoneName: unknown, workstream: string | null}}
 */
function progressScopeOf(entry) {
  const json = entry && entry.json;
  const isPlainObject = json !== null && typeof json === 'object' && !Array.isArray(json);
  return {
    milestoneVersion: isPlainObject ? json.milestone_version : undefined,
    milestoneName: isPlainObject ? json.milestone_name : undefined,
    workstream: workstreamFromArgv(entry && entry.argv),
  };
}

/**
 * @param {ReturnType<typeof progressScopeOf>} a
 * @param {ReturnType<typeof progressScopeOf>} b
 * @returns {boolean}
 */
function scopeEqual(a, b) {
  return a.milestoneVersion === b.milestoneVersion
    && a.milestoneName === b.milestoneName
    && a.workstream === b.workstream;
}

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

/**
 * @typedef {{ ok: true } | { ok: false, severity: string, detail: string, subject?: object }} OracleOutcome
 *
 * `subject` — OPTIONAL structured data backing `detail`, present where the oracle knows a
 * machine-checkable shape (e.g. `{ argv: string[] }` for a command-scoped finding,
 * `{ key: string, value: unknown }` for a value-hygiene leaf, `{ missing: string }` for
 * read-only-idempotence's absent-input case). `detail` remains a human-readable string for
 * console/report output; tests MUST assert on `subject`, never on substrings of `detail`
 * (CONTRIBUTING.md "Prohibited: Raw Text Matching on Test Outputs").
 */

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
      'never a violation — UNLESS its leaf key name is in EXTERNAL_PATH_ALLOWED_KEYS (a field whose contract is to ' +
      'point outside the project, e.g. agents_dir), which is skipped entirely: not a smell, not a violation. Without ' +
      'ctx.projectDir the path check is skipped rather than guessed.',
    check(ctx) {
      try {
        /** @type {{message: string, key: string, value: unknown}[]} */
        const violations = [];
        /** @type {{message: string, key: string, value: unknown}[]} */
        const smells = [];
        const seen = new WeakSet();
        const json = ctx && ctx.result ? ctx.result.json : undefined;
        const projectDir = ctx && typeof ctx.projectDir === 'string' ? ctx.projectDir : null;
        // Resolved once per runOracles call (this check runs exactly once per ctx), not once
        // per candidate string below — projectDir is the same value for every leaf in the walk.
        const resolvedProjectDir = projectDir !== null ? resolveForCompare(projectDir) : null;
        walk(json, (leaf, path) => {
          if (typeof leaf === 'number' && Number.isNaN(leaf)) {
            violations.push({ message: `NaN at ${path}`, key: path, value: leaf });
          } else if (typeof leaf === 'string' && SENTINEL_STRINGS.has(leaf)) {
            violations.push({ message: `sentinel string ${JSON.stringify(leaf)} at ${path}`, key: path, value: leaf });
          } else if (
            resolvedProjectDir !== null &&
            typeof leaf === 'string' &&
            nodePath.isAbsolute(leaf) &&
            !isUnderProjectDir(resolveForCompare(leaf), resolvedProjectDir) &&
            !EXTERNAL_PATH_ALLOWED_KEYS.has(leafKeyOf(path))
          ) {
            smells.push({
              message: `absolute path ${JSON.stringify(leaf)} at ${path} is outside ctx.projectDir ${JSON.stringify(projectDir)}`,
              key: path,
              value: leaf,
            });
          }
        }, seen, '$');
        if (violations.length) {
          return {
            ok: false,
            severity: SEVERITY.VIOLATION,
            subject: { key: violations[0].key, value: violations[0].value },
            detail: violations.map((v) => v.message).join('; '),
          };
        }
        if (smells.length) {
          return {
            ok: false,
            severity: SEVERITY.SMELL,
            subject: { key: smells[0].key, value: smells[0].value },
            detail: smells.map((s) => s.message).join('; '),
          };
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
        const missing = [];
        if (!ctx.repeatResult) {
          missing.push('repeatResult');
          findings.push('ctx.readOnly is true but ctx.repeatResult is missing — idempotence cannot be checked');
        } else if (ctx.result) {
          if (!deepEqual(ctx.result.json, ctx.repeatResult.json, new WeakMap())) {
            findings.push('repeatResult.json is not deep-equal to result.json');
          }
        }
        if (!(ctx.statsBefore instanceof Map)) {
          missing.push('statsBefore');
          findings.push('ctx.readOnly is true but ctx.statsBefore is missing — idempotence cannot be checked');
        }
        if (!(ctx.statsAfter instanceof Map)) {
          missing.push('statsAfter');
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
        if (!findings.length) return { ok: true };
        const subject = missing.length ? { missing: missing.join(', ') } : { mismatches: findings };
        return { ok: false, severity: SEVERITY.VIOLATION, subject, detail: findings.join('; ') };
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
      'Numeric total_plans/total_summaries/phases_completed fields must never decrease across history + result, ' +
      'in walk order, WITHIN a comparable scope (VIOLATION). A scope is the pair of {milestone_version + ' +
      'milestone_name} from the payload and the active workstream derived from the invocation\'s own argv ' +
      '(`--ws <name>`, see `progressScopeOf`). Two consecutive observations are compared using a THREE-WAY rule ' +
      'keyed on whether each one\'s payload carries a milestone scope at all (`hasScope`, true when the payload ' +
      'has `milestone_version` and/or `milestone_name`; see below):\n' +
      '  1. BOTH have scope -> compare via `scopeEqual` (milestone_version + milestone_name + workstream). Same ' +
      '     scope: a decrease is a VIOLATION. Different scope: a milestone/workstream boundary crossing legally ' +
      '     resets the counters, so this resets the comparison SILENTLY — expected behavior, never reported (not ' +
      '     a violation, not a smell). See #2966 FIX 2(a). This observation becomes the new reference point.\n' +
      '  2. NEITHER has scope -> they share the same (absent) milestone scope by construction, so the SAME ' +
      '     `scopeEqual` comparison applies (it degenerates to comparing `undefined === undefined` plus ' +
      '     workstream, e.g. a `--ws` switch still resets silently even with no milestone fields at all): a ' +
      '     same-scope decrease is a VIOLATION. This is the branch a prior fix got wrong (see WHY THE BLANKET ' +
      '     SKIP WAS WRONG below) and is the one #2966 FIX 2(b) restores. This observation becomes the new ' +
      '     reference point.\n' +
      '  3. MIXED (one has scope, the other does not) -> genuinely indeterminate; this pair is not compared, and ' +
      '     — unlike branches 1/2 — the mixed observation does NOT replace the reference point, so the NEXT ' +
      '     entry is compared against the last observation whose scope-category matched. This is the `roadmap ' +
      '     analyze` (no milestone fields) sitting between two `progress` observations (milestone fields) case ' +
      '     that motivated scope-awareness in the first place: it must not mask a real same-scope decrease on ' +
      '     either side of it.\n\n' +
      'WHY THE BLANKET SKIP WAS WRONG: an earlier version of this oracle skipped ANY entry lacking both milestone ' +
      'fields entirely — it neither compared it nor let it become the reference point. That was meant to fix ' +
      'branch 3 above, but it silently also disabled branch 2: a minimal payload like `{ total_summaries: n }` ' +
      '(no milestone fields at all, e.g. the oracle\'s own self-test fixtures) could never trigger a violation no ' +
      'matter how far it decreased, because it could never be compared against anything. That is a false ' +
      'NEGATIVE in the exact defect this oracle exists to catch, and it is strictly worse than the false ' +
      'POSITIVE the blanket skip was trying to fix — it was caught only by the full remote suite\'s self-tests, ' +
      'not by any local check. Do not re-broaden this to a blanket "no scope fields -> skip" rule; keep the ' +
      'three-way branch above, where "neither has scope" is fully comparable and only a genuine MIX is skipped.',
    check(ctx) {
      try {
        const history = ctx && Array.isArray(ctx.history) ? ctx.history : [];
        const entries = ctx && ctx.result ? [...history, ctx.result] : history;
        /** @type {{key:string, from:number, to:number, fromIndex:number, toIndex:number}[]} */
        const violations = [];
        for (const key of PROGRESS_KEYS) {
          /** @type {{value:number, index:number, scope:ReturnType<typeof progressScopeOf>, hasScope:boolean} | undefined} */
          let prev;
          entries.forEach((entry, index) => {
            const json = entry && entry.json;
            if (json === null || typeof json !== 'object' || Array.isArray(json)) return;
            const value = json[key];
            if (typeof value !== 'number' || Number.isNaN(value)) return;
            const scope = progressScopeOf(entry);
            const hasScope = scope.milestoneVersion !== undefined || scope.milestoneName !== undefined;
            if (prev === undefined) {
              prev = { value, index, scope, hasScope };
              return;
            }
            if (prev.hasScope !== hasScope) {
              // Branch 3: mixed — genuinely indeterminate. Skip this comparison AND leave
              // `prev` untouched, so the next entry is still compared against the last
              // scope-category-matching observation (see JSDoc above).
              return;
            }
            // Branch 1 (both scoped) and Branch 2 (neither scoped) are the SAME check:
            // `scopeEqual` naturally degenerates to comparing undefined===undefined plus
            // workstream when neither side carries milestone fields.
            if (scopeEqual(prev.scope, scope) && value < prev.value) {
              violations.push({
                key, from: prev.value, to: value, fromIndex: prev.index, toIndex: index,
              });
            }
            prev = { value, index, scope, hasScope };
          });
        }
        if (violations.length) {
          const first = violations[0];
          return {
            ok: false,
            severity: SEVERITY.VIOLATION,
            subject: { key: first.key, from: first.from, to: first.to, fromIndex: first.fromIndex, toIndex: first.toIndex },
            detail: violations
              .map((v) => `${v.key} decreased from ${v.from} (entry ${v.fromIndex}) to ${v.to} (entry ${v.toIndex})`)
              .join('; '),
          };
        }
        return { ok: true };
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
        const argv = Array.isArray(result.argv) ? result.argv : [];
        const argvDisplay = argv.length ? argv.join(' ') : '(no argv)';
        const errorValue = result.json && typeof result.json === 'object' ? result.json.error : undefined;
        return {
          ok: false,
          severity: SEVERITY.SMELL,
          subject: { argv },
          detail: `command "${argvDisplay}" exited 0 but carries result.json.error = ${JSON.stringify(errorValue)}`,
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
        const argv = Array.isArray(result.argv) ? result.argv : [];
        const argvDisplay = argv.length ? argv.join(' ') : '(no argv)';
        return {
          ok: false,
          severity: SEVERITY.SMELL,
          subject: { argv },
          detail: `command "${argvDisplay}" emits KIND.PROSE only; no typed surface exists to assert on`,
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
        const argv = Array.isArray(result.argv) ? result.argv : [];
        const argvDisplay = argv.length ? argv.join(' ') : '(no argv)';
        return {
          ok: false,
          severity: SEVERITY.SMELL,
          subject: { argv },
          detail:
            `command "${argvDisplay}" emitted unstructured-error text under --json-errors, conflicting docs: ` +
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
 *   violations: { id: string, detail: string, subject?: object }[],
 *   smells: { id: string, detail: string, subject?: object }[],
 *   readonly failed: { id: string, detail: string, subject?: object }[],
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
    if (outcome && outcome.subject !== undefined) {
      finding.subject = outcome.subject;
    }
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
