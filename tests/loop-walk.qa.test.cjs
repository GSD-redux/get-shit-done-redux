'use strict';

/**
 * loop-walk.qa.test.cjs — self-tests for the loop QA walk harness itself
 * (`tests/qa/{result,oracles,loop-walk,mutations,scenario,fixtures/index}.cjs`).
 *
 * This file proves the harness's own building blocks behave as documented:
 * the `RunResult` classifier, every oracle (both its pass AND its fail path —
 * an oracle that cannot fail is decoration), the scenario DSL's validation,
 * fixture-ref resolution, the mutation catalog, and finally a real end-to-end
 * walk of the greenfield-happy-path scenario against the actual CLI.
 */

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { getLiveCommandTokens } = require('./helpers/live-command-registry.cjs');

const { KIND, classify } = require('./qa/result.cjs');
const { ORACLES, runOracles, SEVERITY } = require('./qa/oracles.cjs');
const { LoopWalk } = require('./qa/loop-walk.cjs');
const { MUTATIONS, apply, NOOP } = require('./qa/mutations.cjs');
const { loadScenario, runScenario, assertWiringIsLive } = require('./qa/scenario.cjs');
const { buildReport } = require('./qa/report.cjs');
const { resolveRef } = require('./qa/fixtures/index.cjs');
const { resolveWithin, resolveForCompare } = require('./qa/paths.cjs');
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
const { evaluateUatPassed } = require('../gsd-core/bin/lib/uat-predicate.cjs');

const execFileAsync = promisify(execFile);

/**
 * Recursively collect every `.md` file under `dir` (absolute paths).
 *
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collectFixtureMarkdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFixtureMarkdownFiles(abs, out);
    } else if (entry.isFile() && abs.endsWith('.md')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Is `content` conceptually "a document with a frontmatter block", ignoring any
 * leading blank lines and/or leading HTML comment(s) (e.g. the #2371 provenance
 * marker)?
 *
 * WHY skip leading comments/blanks rather than requiring byte-0 `---`: the whole
 * point of this predicate is to catch DEFECT 1's shape — a provenance comment
 * placed BEFORE the frontmatter fence, which makes `extractFrontmatter` (which
 * only recognizes `---` at byte 0, `gsd-core/bin/lib/frontmatter.cjs`) silently
 * return `{}`. A predicate that itself required byte-0 `---` would only ever
 * fire on already-correct fixtures and could never catch this regression class —
 * it would be exactly as vacuous as the bug it exists to guard against.
 *
 * @param {string} content
 * @returns {boolean}
 */
function hasFrontmatterShape(content) {
  const lines = content.split(/\r?\n/);
  let i = 0;
  let inComment = false;
  while (i < lines.length) {
    const line = lines[i];
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      i += 1;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inComment = true;
      i += 1;
      continue;
    }
    break;
  }
  return lines[i] === '---';
}

/** Looks up an oracle by id, failing loudly if the catalog ever drops one. */
function getOracle(id) {
  const found = ORACLES.find((o) => o.id === id);
  assert.ok(found, `test setup: oracle "${id}" not found in ORACLES`);
  return found;
}

describe('RunResult classification', () => {
  test('classifies a JSON object at exit 0 as JSON', () => {
    const raw = { exitCode: 0, stdout: JSON.stringify({ total_plans: 3 }), stderr: '', argv: ['progress'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.JSON);
    assert.deepStrictEqual(result.json, { total_plans: 3 });
  });

  test('classifies non-JSON stdout at exit 0 as PROSE', () => {
    const raw = { exitCode: 0, stdout: 'Project initialized successfully.', stderr: '', argv: ['init'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.PROSE);
  });

  test('classifies empty stdout and stderr at exit 0 as EMPTY', () => {
    const raw = { exitCode: 0, stdout: '', stderr: '', argv: ['noop'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.EMPTY);
  });

  test('classifies a JSON payload carrying an "error" key at exit 0 as SOFT_ERROR', () => {
    const raw = { exitCode: 0, stdout: JSON.stringify({ error: 'no phases found' }), stderr: '', argv: ['progress'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.SOFT_ERROR);
  });

  test('classifies exit 1 with a warning line before the JSON envelope as STRUCTURED_ERROR', () => {
    const stderr = [
      'gsd-tools: warning: unknown config key(s) in .planning/config.json: foo',
      JSON.stringify({ ok: false, reason: 'bad-config', message: 'config invalid' }),
    ].join('\n');
    const raw = { exitCode: 1, stdout: '', stderr, argv: ['review-lane'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.STRUCTURED_ERROR);
    assert.strictEqual(result.err.reason, 'bad-config');
  });

  test('classifies non-JSON stderr at exit 1 as UNSTRUCTURED_ERROR', () => {
    const raw = { exitCode: 1, stdout: '', stderr: 'Fatal: something went wrong', argv: ['bad'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.UNSTRUCTURED_ERROR);
  });

  test('classifies an exit code outside {0,1} as UNEXPECTED_EXIT', () => {
    const raw = { exitCode: 2, stdout: '', stderr: '', argv: ['weird'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.UNEXPECTED_EXIT);
  });

  test('classifies a timed-out invocation as TIMEOUT regardless of exit code', () => {
    const raw = { exitCode: null, stdout: '', stderr: '', timedOut: true, argv: ['slow'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.TIMEOUT);
  });

  test('classifies a bare JSON number 0 as JSON (non-object scalar)', () => {
    const raw = { exitCode: 0, stdout: '0', stderr: '', argv: ['x'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.JSON);
    assert.strictEqual(result.json, 0);
  });

  test('classifies a bare JSON string "s" as JSON (non-object scalar)', () => {
    const raw = { exitCode: 0, stdout: '"s"', stderr: '', argv: ['x'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.JSON);
    assert.strictEqual(result.json, 's');
  });

  test('classifies a bare JSON array [] as JSON (not probed for an error key)', () => {
    const raw = { exitCode: 0, stdout: '[]', stderr: '', argv: ['x'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.JSON);
    assert.deepStrictEqual(result.json, []);
  });

  test('classifies a bare JSON null as JSON, not SOFT_ERROR', () => {
    const raw = { exitCode: 0, stdout: 'null', stderr: '', argv: ['x'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.JSON);
    assert.strictEqual(result.json, null);
  });

  test('classifies a bare JSON true as JSON', () => {
    const raw = { exitCode: 0, stdout: 'true', stderr: '', argv: ['x'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.JSON);
    assert.strictEqual(result.json, true);
  });

  test('exit 1 with a healthy JSON-looking stdout still classifies as an error (exit code outranks payload)', () => {
    const raw = { exitCode: 1, stdout: JSON.stringify({ ok: true, total_plans: 5 }), stderr: '', argv: ['progress'] };
    const result = classify(raw);
    assert.notStrictEqual(result.kind, KIND.JSON);
    assert.strictEqual(result.kind, KIND.UNSTRUCTURED_ERROR);
  });

  test('warnings array captures all stderr lines except the last', () => {
    const stderr = ['line1', 'line2', JSON.stringify({ ok: false, reason: 'r', message: 'm' })].join('\n');
    const raw = { exitCode: 1, stdout: '', stderr, argv: ['x'] };
    const result = classify(raw);
    assert.deepStrictEqual(result.warnings, ['line1', 'line2']);
  });

  test('an @file: pointer is followed and its JSON payload parsed', (t) => {
    const dir = createTempDir('gsd-runresult-pointer-');
    t.after(() => cleanup(dir));
    const payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify({ ok: true, phases: 4 }), 'utf-8');
    const raw = { exitCode: 0, stdout: `@file:${payloadPath}`, stderr: '', argv: ['big-output'] };
    const result = classify(raw);
    assert.strictEqual(result.kind, KIND.JSON);
    assert.strictEqual(result.pointer, payloadPath);
    assert.deepStrictEqual(result.json, { ok: true, phases: 4 });
  });

  test('an unreadable @file: pointer classifies as UNSTRUCTURED_ERROR rather than throwing', () => {
    const pointerPath = '/definitely/not/a/real/path-xyz.json';
    const raw = { exitCode: 0, stdout: `@file:${pointerPath}`, stderr: '', argv: ['big-output'] };
    const io = {
      readFileSync: () => {
        throw new Error('injected: pointee unreadable');
      },
    };
    const result = classify(raw, io);
    assert.strictEqual(result.kind, KIND.UNSTRUCTURED_ERROR);
    assert.strictEqual(result.pointer, pointerPath);
  });
});

describe('oracle self-tests', () => {
  test('ORACLES has exactly 9 entries (8 violation-severity + 1 smell-severity) (#3913)', () => {
    // #3913: soft-error-exit-zero deleted (inert SMELL; the exit contract now
    // models the same condition), untyped-success promoted SMELL -> VIOLATION.
    assert.strictEqual(ORACLES.length, 9);
  });

  test('exit-contract passes on a clean context', () => {
    const outcome = getOracle('exit-contract').check({ result: { kind: KIND.JSON } });
    assert.strictEqual(outcome.ok, true);
  });

  test('exit-contract fails on a broken context (TIMEOUT)', () => {
    const outcome = getOracle('exit-contract').check({ result: { kind: KIND.TIMEOUT } });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
  });

  test('json-contract passes on a clean context (well-formed STRUCTURED_ERROR)', () => {
    const outcome = getOracle('json-contract').check({
      result: { kind: KIND.STRUCTURED_ERROR, err: { ok: false, reason: 'bad-thing' } },
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('json-contract fails on a broken context (UNSTRUCTURED_ERROR)', () => {
    const outcome = getOracle('json-contract').check({ result: { kind: KIND.UNSTRUCTURED_ERROR } });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
  });

  test('value-hygiene passes on a clean context', () => {
    const outcome = getOracle('value-hygiene').check({ result: { json: { a: 1, note: 'fine' } } });
    assert.strictEqual(outcome.ok, true);
  });

  test('value-hygiene VIOLATION on a NaN leaf', () => {
    const outcome = getOracle('value-hygiene').check({ result: { json: { a: Number.NaN } } });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
  });

  test('value-hygiene VIOLATION on each coercion-artifact sentinel string', () => {
    for (const sentinel of ['undefined', 'null', 'NaN', '[object Object]']) {
      const outcome = getOracle('value-hygiene').check({ result: { json: { a: sentinel } } });
      assert.strictEqual(outcome.ok, false, `sentinel ${JSON.stringify(sentinel)} should violate`);
      assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
      assert.strictEqual(typeof outcome.detail, 'string');
      assert.ok(outcome.detail.length > 0);
    }
  });

  test('value-hygiene SMELL (not a violation) on an absolute path outside ctx.projectDir', (t) => {
    const projectDir = createTempDir('gsd-hygiene-outside-');
    const outsideDir = createTempDir('gsd-hygiene-outside-sibling-');
    t.after(() => {
      cleanup(projectDir);
      cleanup(outsideDir);
    });
    const outcome = getOracle('value-hygiene').check({
      result: { json: { p: path.join(outsideDir, 'leak.md') } },
      projectDir,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.SMELL);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
    // Confirm the severity split is honored end-to-end via runOracles too.
    const { violations, smells } = runOracles({ result: { json: { p: path.join(outsideDir, 'leak.md') } }, projectDir });
    assert.strictEqual(violations.some((v) => v.id === 'value-hygiene'), false);
    assert.strictEqual(smells.some((s) => s.id === 'value-hygiene'), true);
  });

  test('value-hygiene has no finding for an in-project path, including one that does not exist yet', (t) => {
    const projectDir = createTempDir('gsd-hygiene-inproject-');
    t.after(() => cleanup(projectDir));
    // `init` returns paths for files the agent has not written yet — realpath
    // throws ENOENT on those, and the oracle must not crash or false-positive.
    const notYetWritten = path.join(projectDir, '.planning', 'NOT-YET.md');
    let outcome;
    assert.doesNotThrow(() => {
      outcome = getOracle('value-hygiene').check({ result: { json: { p: notYetWritten } }, projectDir });
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('value-hygiene has no finding when ctx.projectDir is absent (skips, does not guess)', () => {
    const outcome = getOracle('value-hygiene').check({ result: { json: { p: '/some/unrelated/absolute/path' } } });
    assert.strictEqual(outcome.ok, true);
  });

  test('value-hygiene has no finding (not even a SMELL) for an allowlisted external-path key like agents_dir', (t) => {
    const projectDir = createTempDir('gsd-hygiene-allowlist-');
    const outsideDir = createTempDir('gsd-hygiene-allowlist-outside-');
    t.after(() => {
      cleanup(projectDir);
      cleanup(outsideDir);
    });
    const outcome = getOracle('value-hygiene').check({
      result: { json: { agents_dir: path.join(outsideDir, 'agents') } },
      projectDir,
    });
    assert.strictEqual(outcome.ok, true);
    const { violations, smells } = runOracles({
      result: { json: { agents_dir: path.join(outsideDir, 'agents') } },
      projectDir,
    });
    assert.strictEqual(violations.some((v) => v.id === 'value-hygiene'), false);
    assert.strictEqual(smells.some((s) => s.id === 'value-hygiene'), false);
  });

  test('value-hygiene still SMELLs on a non-allowlisted out-of-project key even when agents_dir is also present', (t) => {
    const projectDir = createTempDir('gsd-hygiene-mixed-');
    const outsideDir = createTempDir('gsd-hygiene-mixed-outside-');
    t.after(() => {
      cleanup(projectDir);
      cleanup(outsideDir);
    });
    const outcome = getOracle('value-hygiene').check({
      result: {
        json: {
          agents_dir: path.join(outsideDir, 'agents'),
          leaked_path: path.join(outsideDir, 'leak.md'),
        },
      },
      projectDir,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.SMELL);
    assert.strictEqual(outcome.subject.key, '$.leaked_path');
  });

  test('value-hygiene SMELLs on a sibling-prefix path (containment is path-segment, not string-prefix)', (t) => {
    const projectDir = createTempDir('gsd-hygiene-sibling-');
    t.after(() => cleanup(projectDir));
    // `${projectDir}-evil` starts with the exact same characters as `projectDir`,
    // so a naive string-prefix/`.startsWith()` containment check would (wrongly)
    // treat it as inside. Path-segment containment must not.
    const siblingPath = path.join(`${projectDir}-evil`, 'x');
    const outcome = getOracle('value-hygiene').check({ result: { json: { p: siblingPath } }, projectDir });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.SMELL);
  });

  test('value-hygiene has no finding for a live-command TOKEN under actions[].command (regression guard — FAILS pre-fix, measured)', (t) => {
    const projectDir = createTempDir('gsd-hygiene-command-token-');
    t.after(() => cleanup(projectDir));
    const outcome = getOracle('value-hygiene').check({
      result: { json: { actions: [{ id: 'a', command: '/gsd:progress' }] } },
      projectDir,
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('value-hygiene SMELLs on a genuine absolute-path leak stored under a key named "command"', (t) => {
    const projectDir = createTempDir('gsd-hygiene-command-path-leak-');
    t.after(() => cleanup(projectDir));
    const outcome = getOracle('value-hygiene').check({
      result: { json: { actions: [{ id: 'a', command: '/Users/someone/elsewhere/bin/tool' }] } },
      projectDir,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.SMELL);
    assert.strictEqual(outcome.subject.key, '$.actions[0].command');
  });

  // #3913 P9 SEC-1: the shape-based exemption was too loose — `String.startsWith`
  // against a live-command prefix with NO constraint on the remainder let a
  // leaked path through as long as its first bytes happened to match a real
  // token prefix. Fixed by requiring the string's first whitespace-delimited
  // word to be an EXACT member of getLiveCommandTokens().

  test('F1a: a leaked path sharing a prefix with a real token ("/gsd-x/../../../Users/someone/.ssh/id_rsa") IS a SMELL (failing-first against the pre-fix startsWith exemption)', (t) => {
    const projectDir = createTempDir('gsd-hygiene-sec1-traversal-');
    t.after(() => cleanup(projectDir));
    const outcome = getOracle('value-hygiene').check({
      result: { json: { command: '/gsd-x/../../../Users/someone/.ssh/id_rsa' } },
      projectDir,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.SMELL);
  });

  test('F1b: a leaked path sharing a colon-style prefix ("/gsd:/etc/passwd") IS a SMELL', (t) => {
    const projectDir = createTempDir('gsd-hygiene-sec1-colon-');
    t.after(() => cleanup(projectDir));
    const outcome = getOracle('value-hygiene').check({
      result: { json: { command: '/gsd:/etc/passwd' } },
      projectDir,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.SMELL);
  });

  test('F1c: an exact live-command token ("/gsd-progress") is exempt (regression guard)', (t) => {
    const projectDir = createTempDir('gsd-hygiene-sec1-exact-');
    t.after(() => cleanup(projectDir));
    const outcome = getOracle('value-hygiene').check({
      result: { json: { command: '/gsd-progress' } },
      projectDir,
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('F1d: a live-command token carrying trailing arguments ("/gsd-plan-phase 2") is exempt (the case a naive exact-match-on-the-whole-string breaks)', (t) => {
    const projectDir = createTempDir('gsd-hygiene-sec1-args-');
    t.after(() => cleanup(projectDir));
    const outcome = getOracle('value-hygiene').check({
      result: { json: { command: '/gsd-plan-phase 2' } },
      projectDir,
    });
    assert.strictEqual(outcome.ok, true);
  });

  // Forward guard, not a regression test: 'progress' matches neither the
  // live-command-token exemption nor the path-leak detection under either
  // the pre-#3913-SEC-1 (startsWith) or post-fix (exact-token) shape, so
  // this cannot currently fail against either — it exists to catch a FUTURE
  // change that starts false-positiving on ordinary non-path, non-token
  // command values.
  test('forward guard: value-hygiene is unaffected by a "command" value that is neither a live-command token nor an absolute path', (t) => {
    const projectDir = createTempDir('gsd-hygiene-command-plain-');
    t.after(() => cleanup(projectDir));
    const outcome = getOracle('value-hygiene').check({
      result: { json: { actions: [{ id: 'a', command: 'progress' }] } },
      projectDir,
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('value-hygiene does not crash on a cyclic json object', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    let outcome;
    assert.doesNotThrow(() => {
      outcome = getOracle('value-hygiene').check({ result: { json: cyclic } });
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('value-hygiene does not crash on non-object json', () => {
    const outcome = getOracle('value-hygiene').check({ result: { json: 'just a plain string' } });
    assert.strictEqual(outcome.ok, true);
  });

  test('read-only-idempotence passes on a clean context', () => {
    const outcome = getOracle('read-only-idempotence').check({
      readOnly: true,
      result: { json: { a: 1 } },
      repeatResult: { json: { a: 1 } },
      statsBefore: new Map([['f.md', { size: 10, mtimeMs: 100 }]]),
      statsAfter: new Map([['f.md', { size: 10, mtimeMs: 100 }]]),
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('read-only-idempotence fails on a broken context (repeatResult.json diverges)', () => {
    const outcome = getOracle('read-only-idempotence').check({
      readOnly: true,
      result: { json: { a: 1 } },
      repeatResult: { json: { a: 2 } },
      statsBefore: new Map([['f.md', { size: 10, mtimeMs: 100 }]]),
      statsAfter: new Map([['f.md', { size: 10, mtimeMs: 100 }]]),
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
  });

  test('monotonic-progress passes on a clean context', () => {
    const outcome = getOracle('monotonic-progress').check({
      history: [{ json: { total_plans: 1 } }],
      result: { json: { total_plans: 3 } },
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('monotonic-progress fails on a broken context (value decreased)', () => {
    // Neither observation carries milestone_version/milestone_name at all (branch 2 of the
    // three-way scope rule, #2966 FIX 2b) — they share the same (absent) scope by construction,
    // so this MUST still compare normally and violate. A prior fix over-broadened the "skip when
    // scope is unknowable" rule to skip ANY scope-less payload, which silently disabled this exact
    // check for a minimal payload like this one; only the full remote suite caught it.
    const outcome = getOracle('monotonic-progress').check({
      history: [{ json: { total_plans: 5 } }],
      result: { json: { total_plans: 2 } },
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(outcome.subject.key, 'total_plans');
    assert.strictEqual(outcome.subject.from, 5);
    assert.strictEqual(outcome.subject.to, 2);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
  });

  test('monotonic-progress: a decrease with total_summaries (the exact self-test shape) still violates when neither side has scope', () => {
    // Regression coverage for the #2966 self-test payload shape reported by the full suite:
    // `{ total_summaries: n }`, no milestone fields, no argv at all.
    const outcome = getOracle('monotonic-progress').check({
      history: [{ json: { total_summaries: 3 } }],
      result: { json: { total_summaries: 1 } },
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(outcome.subject.key, 'total_summaries');
    assert.strictEqual(outcome.subject.from, 3);
    assert.strictEqual(outcome.subject.to, 1);
  });

  test('monotonic-progress: a decrease WITHIN the same milestone_version is a VIOLATION', () => {
    const outcome = getOracle('monotonic-progress').check({
      history: [{ json: { total_plans: 5, milestone_version: 'v1.0', milestone_name: 'milestone' }, argv: ['progress'] }],
      result: { json: { total_plans: 2, milestone_version: 'v1.0', milestone_name: 'milestone' }, argv: ['progress'] },
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(outcome.subject.key, 'total_plans');
    assert.strictEqual(outcome.subject.from, 5);
    assert.strictEqual(outcome.subject.to, 2);
  });

  test('monotonic-progress: the SAME decrease ACROSS a milestone_version change is NOT reported at all (silent reset, not even a SMELL)', () => {
    const ctx = {
      history: [{ json: { total_plans: 5, milestone_version: 'v1.0', milestone_name: 'milestone' }, argv: ['progress'] }],
      result: { json: { total_plans: 2, milestone_version: 'v2.0', milestone_name: 'Milestone Two' }, argv: ['progress'] },
    };
    const outcome = getOracle('monotonic-progress').check(ctx);
    assert.strictEqual(outcome.ok, true, 'a milestone-version boundary crossing must reset silently, not fire at all');

    // Confirm this never reaches `runOracles(ctx).failed` NOR `.smells` — a boundary
    // crossing is expected behavior, not evidence worth a human look (#2966 FIX 2a).
    const { failed, smells } = runOracles(ctx);
    assert.strictEqual(failed.find((f) => f.id === 'monotonic-progress'), undefined);
    assert.strictEqual(smells.find((s) => s.id === 'monotonic-progress'), undefined);
  });

  test('monotonic-progress: a decrease ACROSS a --ws workstream switch is NOT reported at all (silent reset, not even a SMELL)', () => {
    const ctx = {
      history: [{ json: { total_plans: 5 }, argv: ['--ws', 'alpha', 'progress'] }],
      result: { json: { total_plans: 0 }, argv: ['--ws', 'beta', 'progress'] },
    };
    const outcome = getOracle('monotonic-progress').check(ctx);
    assert.strictEqual(outcome.ok, true, 'a workstream boundary crossing must reset silently, not fire at all');
    const { failed, smells } = runOracles(ctx);
    assert.strictEqual(failed.find((f) => f.id === 'monotonic-progress'), undefined);
    assert.strictEqual(smells.find((s) => s.id === 'monotonic-progress'), undefined);
  });

  test('monotonic-progress: a subsequent same-scope decrease AFTER a boundary crossing is still a VIOLATION (the reset re-arms the check)', () => {
    const outcome = getOracle('monotonic-progress').check({
      history: [
        { json: { total_plans: 5, milestone_version: 'v1.0', milestone_name: 'milestone' }, argv: ['progress'] },
        { json: { total_plans: 0, milestone_version: 'v2.0', milestone_name: 'Milestone Two' }, argv: ['progress'] },
        { json: { total_plans: 3, milestone_version: 'v2.0', milestone_name: 'Milestone Two' }, argv: ['progress'] },
      ],
      result: { json: { total_plans: 1, milestone_version: 'v2.0', milestone_name: 'Milestone Two' }, argv: ['progress'] },
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(outcome.subject.from, 3);
    assert.strictEqual(outcome.subject.to, 1);
  });

  test('monotonic-progress: a MIXED pair (one scoped, one not) is skipped — genuinely indeterminate, not a boundary guess', () => {
    // Mirrors `roadmap analyze`'s real payload shape sitting between two scoped `progress`
    // observations: neither milestone_version nor milestone_name present on the middle entry.
    // Branch 3 of the three-way rule (#2966 FIX 2c): that ONE pairing is skipped and does not
    // become the new reference point, so the surrounding same-scope comparison still applies —
    // see the next test.
    const ctx = {
      history: [
        { json: { total_plans: 5, milestone_version: 'v1.0', milestone_name: 'milestone' }, argv: ['progress'] },
        { json: { total_plans: 1 }, argv: ['roadmap', 'analyze'] },
      ],
      result: { json: { total_plans: 5, milestone_version: 'v1.0', milestone_name: 'milestone' }, argv: ['progress'] },
    };
    const outcome = getOracle('monotonic-progress').check(ctx);
    assert.strictEqual(outcome.ok, true, 'the scope-less entry must be invisible to the comparison, not a violation or a smell');
    const { failed, smells } = runOracles(ctx);
    assert.strictEqual(failed.find((f) => f.id === 'monotonic-progress'), undefined);
    assert.strictEqual(smells.find((s) => s.id === 'monotonic-progress'), undefined);
  });

  test('monotonic-progress: a scope-less observation does not mask a real same-scope decrease around it', () => {
    const outcome = getOracle('monotonic-progress').check({
      history: [
        { json: { total_plans: 5, milestone_version: 'v1.0', milestone_name: 'milestone' }, argv: ['progress'] },
        { json: { total_plans: 1 }, argv: ['roadmap', 'analyze'] },
      ],
      result: { json: { total_plans: 2, milestone_version: 'v1.0', milestone_name: 'milestone' }, argv: ['progress'] },
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(outcome.subject.from, 5);
    assert.strictEqual(outcome.subject.to, 2);
  });

  // #3913 P9 matrix "A" — routing-validity was rescoped to validate the fields
  // that actually carry command tokens (actions[].command, next.command)
  // instead of demanding a token from the bare `recommended` action id, which
  // is an id by design (src/smart-entry.cts:766) and never a command token.

  test('A1: a bare-id recommended paired with a matching actions[].command PASSES', () => {
    // Failing-first: against the pre-#3913 oracles.cjs this fails because the
    // old check demanded ctx.liveCommands.includes(json.recommended) directly
    // ("discuss-phase" is not a command token). Red/green captured manually
    // (see PR evidence); this is the permanent regression test.
    const outcome = getOracle('routing-validity').check({
      result: {
        json: {
          recommended: 'discuss-phase',
          actions: [{ id: 'discuss-phase', label: 'Discuss', command: '/gsd:discuss-phase', recommended: true }],
        },
      },
      liveCommands: ['/gsd:discuss-phase'],
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('A2 (positive control): actions[].command naming a NON-live command still FAILS', () => {
    // Without this, deleting the routing-validity check entirely would also
    // satisfy A1 — this proves the oracle can still produce a VIOLATION.
    const outcome = getOracle('routing-validity').check({
      result: {
        json: {
          recommended: 'discuss-phase',
          actions: [{ id: 'discuss-phase', label: 'Discuss', command: '/gsd:not-a-live-command', recommended: true }],
        },
      },
      liveCommands: ['/gsd:discuss-phase'],
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
    assert.strictEqual(outcome.subject.value, '/gsd:not-a-live-command');
  });

  // Forward guard, not a regression test: a payload with nothing for the
  // oracle to inspect returns ok under both the old and new oracle shape
  // (the old oracle also returned ok for this input) — it exists to catch a
  // FUTURE change that starts engaging on an empty/no-routing payload.
  test('forward guard — A4: a payload with no recommended and no actions/next.command is not engaged (ok)', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { situation: 'complete', summary: 'done' } },
      liveCommands: ['/gsd:discuss-phase'],
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('routing-validity also validates next.command (state-contract shape)', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { next: { command: '/gsd:not-live', label: 'x', reason: 'y' } } },
      liveCommands: ['/gsd:discuss-phase'],
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(outcome.subject.key, 'next.command');
  });

  // #3913 P9 SEC-2: routing-validity enumerated only actions[].command and
  // next.command, so a non-live token in ANY other field-shape was invisible
  // to the oracle. Fixed by walking the entire payload for any string whose
  // first word matches the live-command prefix set. Each F2a case is
  // failing-first against the pre-fix two-field-path version.

  const F2A_LIVE_COMMANDS = ['/gsd-progress'];

  test('F2a: a non-live token in recommended_command is a VIOLATION', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { recommended_command: '/gsd-nope' } },
      liveCommands: F2A_LIVE_COMMANDS,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(outcome.subject.value, '/gsd-nope');
  });

  test('F2a: a non-live token as a bare STRING next is a VIOLATION', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { next: '/gsd-nope' } },
      liveCommands: F2A_LIVE_COMMANDS,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(outcome.subject.value, '/gsd-nope');
  });

  test('F2a: a non-live token in steps[].command is a VIOLATION', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { steps: [{ command: '/gsd-nope' }] } },
      liveCommands: F2A_LIVE_COMMANDS,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(outcome.subject.key, 'steps[0].command');
    assert.strictEqual(outcome.subject.value, '/gsd-nope');
  });

  test('F2b: a LIVE token in recommended_command, string next, and steps[].command each PASS', () => {
    for (const json of [
      { recommended_command: '/gsd-progress' },
      { next: '/gsd-progress' },
      { steps: [{ command: '/gsd-progress' }] },
    ]) {
      const outcome = getOracle('routing-validity').check({ result: { json }, liveCommands: F2A_LIVE_COMMANDS });
      assert.strictEqual(outcome.ok, true, `expected ok for ${JSON.stringify(json)}`);
    }
  });

  test('F2: a non-live token surfaces through next as an array of {command} entries', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { next: [{ command: '/gsd-nope' }] } },
      liveCommands: F2A_LIVE_COMMANDS,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
  });

  test('F2: a non-live token surfaces when actions is an object map instead of an array', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { actions: { a: { command: '/gsd-nope' } } } },
      liveCommands: F2A_LIVE_COMMANDS,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
  });

  test('F2: a non-live token surfaces via actions[].next.command', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { actions: [{ next: { command: '/gsd-nope' } }] } },
      liveCommands: F2A_LIVE_COMMANDS,
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
  });

  test('shared predicate: a live token routing-validity vouches for is exactly what value-hygiene exempts', (t) => {
    const projectDir = createTempDir('gsd-shared-predicate-');
    t.after(() => cleanup(projectDir));
    const routing = getOracle('routing-validity').check({
      result: { json: { recommended_command: '/gsd-progress' } },
      liveCommands: F2A_LIVE_COMMANDS,
    });
    assert.strictEqual(routing.ok, true);
    const hygiene = getOracle('value-hygiene').check({
      result: { json: { command: '/gsd-progress' } },
      projectDir,
    });
    assert.strictEqual(hygiene.ok, true);
  });

  test('determinism passes on a clean context', () => {
    const outcome = getOracle('determinism').check({
      result: { kind: KIND.JSON },
      repeatResult: { kind: KIND.JSON },
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('determinism fails on a broken context (repeat kind diverges)', () => {
    const outcome = getOracle('determinism').check({
      result: { kind: KIND.JSON },
      repeatResult: { kind: KIND.PROSE },
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
  });

  // #3913 D1/D2 — soft-error-exit-zero was deleted outright: it was an inert
  // SMELL (never reaches `failed`) restating a condition the exit contract
  // now models directly (v1 exit 0 / v2 exit 80 for an output({error}) path).

  test('D1: soft-error-exit-zero appears in no oracle in ORACLES', () => {
    assert.strictEqual(ORACLES.some((o) => o.id === 'soft-error-exit-zero'), false);
  });

  test('D2: runOracles over a KIND.SOFT_ERROR result produces no finding with id soft-error-exit-zero', () => {
    const ctx = { result: { kind: KIND.SOFT_ERROR, argv: ['progress'], json: { error: 'no phases found' } } };
    const { violations, smells, failed } = runOracles(ctx);
    assert.strictEqual(violations.some((f) => f.id === 'soft-error-exit-zero'), false);
    assert.strictEqual(smells.some((f) => f.id === 'soft-error-exit-zero'), false);
    assert.strictEqual(failed.some((f) => f.id === 'soft-error-exit-zero'), false);
  });

  // #3913 C — untyped-success promoted SEVERITY.SMELL -> SEVERITY.VIOLATION.
  // Nothing else in the repo asserts "the recommended token matches a live
  // command" for a PROSE-only surface, so this stays a real, enforced guard
  // rather than being deleted alongside soft-error-exit-zero.

  test('C3: untyped-success passes (is not engaged) on a non-PROSE context', () => {
    const outcome = getOracle('untyped-success').check({ result: { kind: KIND.JSON, argv: ['progress'] } });
    assert.strictEqual(outcome.ok, true);
  });

  test('C1 + C2: untyped-success is a VIOLATION on a PROSE result, and reaches runOracles(...).failed', () => {
    // C1: severity is VIOLATION, not SMELL.
    const ctx = { result: { kind: KIND.PROSE, argv: ['init'] } };
    const outcome = getOracle('untyped-success').check(ctx);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.VIOLATION);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
    assert.deepEqual(outcome.subject.argv, ['init'], 'subject.argv must name the offending command');

    // C2 — the anti-vacuity test for the whole phase: a promotion that is
    // cosmetic would still route this finding to `smells`, where it can never
    // redden a build. Failing-first: against the pre-#3913 oracles.cjs this
    // fails because the finding lands in `smells`, not `failed` (red/green
    // captured manually; see PR evidence). This is the permanent regression
    // test for that identity.
    const { violations, smells, failed } = runOracles(ctx);
    assert.strictEqual(smells.some((s) => s.id === 'untyped-success'), false);
    assert.strictEqual(violations.some((v) => v.id === 'untyped-success'), true);
    assert.strictEqual(failed.some((f) => f.id === 'untyped-success'), true);
  });

  test('contract-conflict passes on a clean context', () => {
    const outcome = getOracle('contract-conflict').check({
      jsonErrorMode: true,
      result: { kind: KIND.JSON, argv: ['progress'] },
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('contract-conflict SMELLs (not a violation) when --json-errors still produced unstructured error text', () => {
    const ctx = { jsonErrorMode: true, result: { kind: KIND.UNSTRUCTURED_ERROR, argv: ['bad-usage'] } };
    const outcome = getOracle('contract-conflict').check(ctx);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.SMELL);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
    assert.deepEqual(outcome.subject.argv, ['bad-usage'], 'subject.argv must name the offending command');
    const { violations, smells } = runOracles(ctx);
    assert.strictEqual(violations.some((v) => v.id === 'contract-conflict'), false);
    assert.strictEqual(smells.some((s) => s.id === 'contract-conflict'), true);
  });
});

describe('severity model', () => {
  test('a smell must never appear in failed (the contract that keeps smells from breaking builds)', () => {
    // #3913: untyped-success was promoted to a VIOLATION and can no longer
    // serve as the SMELL example here — contract-conflict is now the sole
    // remaining SMELL-severity oracle.
    const ctx = { jsonErrorMode: true, result: { kind: KIND.UNSTRUCTURED_ERROR, argv: ['bad-usage'] } };
    const { failed, smells } = runOracles(ctx);
    assert.ok(smells.some((s) => s.id === 'contract-conflict'));
    assert.strictEqual(failed.some((f) => f.id === 'contract-conflict'), false);
  });

  test('failed.length === violations.length for a context producing both a violation and a smell', () => {
    // value-hygiene fires a VIOLATION on the NaN leaf; contract-conflict fires
    // a SMELL on the UNSTRUCTURED_ERROR kind under jsonErrorMode. Both fire
    // from the same ctx.
    const ctx = { jsonErrorMode: true, result: { kind: KIND.UNSTRUCTURED_ERROR, argv: ['bad-usage'], json: { a: Number.NaN } } };
    const { failed, violations, smells } = runOracles(ctx);
    assert.ok(violations.length > 0);
    assert.ok(smells.length > 0);
    assert.strictEqual(failed.length, violations.length);
  });

  test('SEVERITY is frozen and has exactly the expected keys', () => {
    assert.strictEqual(Object.isFrozen(SEVERITY), true);
    assert.deepStrictEqual(Object.keys(SEVERITY).sort(), ['SMELL', 'VIOLATION'].sort());
    assert.strictEqual(SEVERITY.VIOLATION, 'violation');
    assert.strictEqual(SEVERITY.SMELL, 'smell');
  });
});

describe('scenario DSL validation', () => {
  let expectedPoints;

  before(() => {
    expectedPoints = new Set();
    for (const entry of LOOP_HOST_CONTRACT) {
      for (const point of entry.points) expectedPoints.add(point);
    }
  });

  function writeScenarioFile(t, obj) {
    const dir = createTempDir('gsd-scenario-dsl-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'scenario.json');
    fs.writeFileSync(file, JSON.stringify(obj), 'utf-8');
    return file;
  }

  test('loadScenario rejects an empty steps array', (t) => {
    const file = writeScenarioFile(t, { name: 'empty-steps', fixture: 'greenfield', steps: [] });
    assert.throws(() => loadScenario(file), /"steps"/);
  });

  test('loadScenario rejects an unknown fixture', (t) => {
    const file = writeScenarioFile(t, {
      name: 'bad-fixture',
      fixture: 'nonexistent-fixture',
      steps: [{ at: 'discuss:pre' }],
    });
    assert.throws(() => loadScenario(file), /nonexistent-fixture/);
  });

  test('loadScenario rejects an "at" point not present in the generated loop contract', (t) => {
    const file = writeScenarioFile(t, {
      name: 'bad-point',
      fixture: 'greenfield',
      steps: [{ at: 'totally-bogus-point' }],
    });
    assert.throws(() => loadScenario(file), /totally-bogus-point/);
  });

  test('loadScenario rejects a non-boolean "jsonErrors" field, naming it', (t) => {
    const file = writeScenarioFile(t, {
      name: 'bad-json-errors',
      fixture: 'greenfield',
      steps: [{ at: 'discuss:pre', jsonErrors: 'yes' }],
    });
    assert.throws(() => loadScenario(file), /jsonErrors/);
  });

  test('loadScenario rejects a malformed expect entry', (t) => {
    const file = writeScenarioFile(t, {
      name: 'bad-expect',
      fixture: 'greenfield',
      steps: [{ at: 'discuss:pre', expect: [{ foo: 'bar' }] }],
    });
    assert.throws(() => loadScenario(file), /expect\[0\]/);
  });

  test('the legal point set derives from loop-host-contract.cjs: a known-good point loads', (t) => {
    const knownGoodPoint = [...expectedPoints][0];
    assert.strictEqual(expectedPoints.has(knownGoodPoint), true);
    const file = writeScenarioFile(t, {
      name: 'known-good',
      fixture: 'greenfield',
      steps: [{ at: knownGoodPoint }],
    });
    const scenario = loadScenario(file);
    assert.strictEqual(scenario.steps[0].at, knownGoodPoint);
  });

  test('the legal point set derives from loop-host-contract.cjs: a fabricated point throws', (t) => {
    const fabricatedPoint = 'zzz:not-a-real-point';
    assert.strictEqual(expectedPoints.has(fabricatedPoint), false);
    const file = writeScenarioFile(t, {
      name: 'fabricated',
      fixture: 'greenfield',
      steps: [{ at: fabricatedPoint }],
    });
    assert.throws(() => loadScenario(file), /zzz:not-a-real-point/);
  });
});

describe('fixture refs', () => {
  test("resolveRef('@project/minimal') returns non-empty content", () => {
    const text = resolveRef('@project/minimal');
    assert.strictEqual(typeof text, 'string');
    assert.ok(text.length > 0);
  });

  test('resolveRef throws on an unknown ref, naming the ref', () => {
    assert.throws(() => resolveRef('@nope/nope'), /@nope\/nope/);
  });
});

describe('mutations', () => {
  const SAMPLE_ARTIFACT_TEXT = [
    '---',
    'title: sample',
    'phase: 1',
    '---',
    '',
    '## Phase 1',
    '',
    '| 1 | Task | Status |',
    '| --- | --- | --- |',
    '| 1 | Do the thing | pending |',
    '',
    'Some body text describing the phase.',
  ].join('\n');

  test('MUTATIONS has exactly 11 entries', () => {
    assert.strictEqual(MUTATIONS.length, 11);
  });

  test('every mutation id is unique', () => {
    const ids = MUTATIONS.map((m) => m.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  test('apply("truncate-frontmatter", ...) shortens text and drops the closing delimiter', () => {
    const result = apply('truncate-frontmatter', SAMPLE_ARTIFACT_TEXT);
    assert.notStrictEqual(result, SAMPLE_ARTIFACT_TEXT);
    assert.ok(result.length < SAMPLE_ARTIFACT_TEXT.length);
  });

  test('apply("crlf", ...) converts line endings to CRLF', () => {
    const result = apply('crlf', SAMPLE_ARTIFACT_TEXT);
    assert.notStrictEqual(result, SAMPLE_ARTIFACT_TEXT);
    assert.ok(result.includes('\r\n'));
  });

  test('apply("bom", ...) prefixes text with a byte-order-mark', () => {
    const result = apply('bom', SAMPLE_ARTIFACT_TEXT);
    assert.notStrictEqual(result, SAMPLE_ARTIFACT_TEXT);
    assert.strictEqual(result.charCodeAt(0), 0xfeff);
  });

  test('apply("empty", ...) replaces text with an empty string', () => {
    const result = apply('empty', SAMPLE_ARTIFACT_TEXT);
    assert.strictEqual(result, '');
  });

  test('apply("duplicate-phase-id", ...) duplicates the first phase-id line', () => {
    const result = apply('duplicate-phase-id', SAMPLE_ARTIFACT_TEXT);
    assert.notStrictEqual(result, SAMPLE_ARTIFACT_TEXT);
  });

  test('apply("nonsequential-phases", ...) renumbers phase-id occurrences when present', () => {
    const result = apply('nonsequential-phases', SAMPLE_ARTIFACT_TEXT);
    assert.notStrictEqual(result, NOOP);
    assert.notStrictEqual(result, SAMPLE_ARTIFACT_TEXT);
  });

  test('apply("nonsequential-phases", ...) returns the NOOP sentinel when no phase-id occurs', () => {
    const noPhaseText = ['# Just a title', '', 'No phase markers in this document.'].join('\n');
    const result = apply('nonsequential-phases', noPhaseText);
    assert.strictEqual(result, NOOP);
  });

  test('apply("unicode-headings", ...) replaces every heading\'s text', () => {
    const result = apply('unicode-headings', SAMPLE_ARTIFACT_TEXT);
    assert.notStrictEqual(result, SAMPLE_ARTIFACT_TEXT);
  });

  test('apply("oversized", ...) pads text past a target larger than the current size', () => {
    const targetBytes = Buffer.byteLength(SAMPLE_ARTIFACT_TEXT, 'utf8') + 50;
    const result = apply('oversized', SAMPLE_ARTIFACT_TEXT, { targetBytes });
    assert.notStrictEqual(result, SAMPLE_ARTIFACT_TEXT);
    assert.ok(Buffer.byteLength(result, 'utf8') > targetBytes);
  });

  test('apply("escaped-pipes", ...) injects an escaped-pipe cell into the first table row', () => {
    const result = apply('escaped-pipes', SAMPLE_ARTIFACT_TEXT);
    assert.notStrictEqual(result, SAMPLE_ARTIFACT_TEXT);
  });

  test('apply("crlf", ...) is idempotent and never produces \\r\\r\\n', () => {
    const once = apply('crlf', SAMPLE_ARTIFACT_TEXT);
    const twice = apply('crlf', once);
    assert.strictEqual(twice, once);
    assert.strictEqual(twice.includes('\r\r\n'), false);
  });

  test('apply("oversized", ...) at targetBytes - 1 (input already over target) leaves input unchanged', () => {
    const input = 'A'.repeat(10);
    const result = apply('oversized', input, { targetBytes: 9 });
    assert.strictEqual(result, input);
  });

  test('apply("oversized", ...) at targetBytes === input size pads to exactly one byte over', () => {
    const input = 'A'.repeat(10);
    const result = apply('oversized', input, { targetBytes: 10 });
    assert.strictEqual(Buffer.byteLength(result, 'utf8'), 11);
  });

  test('apply("oversized", ...) at targetBytes + 1 (input under target) pads to one byte over', () => {
    const input = 'A'.repeat(10);
    const result = apply('oversized', input, { targetBytes: 11 });
    assert.strictEqual(Buffer.byteLength(result, 'utf8'), 12);
  });

  test('apply(...) throws on an unknown mutation id', () => {
    assert.throws(() => apply('not-a-real-mutation', 'x'), /not-a-real-mutation/);
  });

  describe('file mutations', () => {
    let mutDir;

    beforeEach(() => {
      mutDir = createTempDir('gsd-mutations-file-');
    });

    afterEach(() => {
      cleanup(mutDir);
    });

    test('apply("delete", ...) removes the file on disk', () => {
      const relPath = 'artifact.md';
      fs.writeFileSync(path.join(mutDir, relPath), SAMPLE_ARTIFACT_TEXT, 'utf-8');
      apply('delete', { dir: mutDir, relPath });
      assert.strictEqual(fs.existsSync(path.join(mutDir, relPath)), false);
    });

    test('apply("symlink", ...) replaces the file with a symlink or hardlink of identical size', () => {
      const relPath = 'artifact.md';
      const abs = path.join(mutDir, relPath);
      fs.writeFileSync(abs, SAMPLE_ARTIFACT_TEXT, 'utf-8');
      const sizeBefore = fs.statSync(abs).size;
      apply('symlink', { dir: mutDir, relPath });
      const lstat = fs.lstatSync(abs);
      const sizeAfter = fs.statSync(abs).size;
      assert.strictEqual(sizeAfter, sizeBefore);
      assert.strictEqual(lstat.isSymbolicLink() || lstat.isFile(), true);
    });
  });
});

describe('path containment', () => {
  test('resolveWithin rejects a traversing relPath, naming it and the base', (t) => {
    const dir = createTempDir('gsd-pathguard-');
    t.after(() => cleanup(dir));
    assert.throws(() => resolveWithin(dir, '../../etc/hosts'), (err) => {
      assert.ok(err instanceof Error);
      assert.strictEqual(err.code, 'EPATHESCAPE');
      assert.strictEqual(err.attemptedPath, '../../etc/hosts');
      assert.strictEqual(err.base, dir);
      return true;
    });
  });

  test('resolveWithin rejects an absolute relPath', (t) => {
    const dir = createTempDir('gsd-pathguard-abs-');
    t.after(() => cleanup(dir));
    assert.throws(() => resolveWithin(dir, '/etc/hosts'), (err) => {
      assert.strictEqual(err.code, 'EPATHESCAPE');
      assert.strictEqual(err.attemptedPath, '/etc/hosts');
      assert.strictEqual(err.base, dir);
      return true;
    });
  });

  test('resolveWithin rejects a sibling-prefix escape (path-segment, not string-prefix, containment)', (t) => {
    const dir = createTempDir('gsd-pathguard-sibling-');
    t.after(() => cleanup(dir));
    assert.throws(() => resolveWithin(dir, `../${path.basename(dir)}-evil/x`), /escapes/);
  });

  test('resolveWithin accepts an in-project path that does not exist yet', (t) => {
    const dir = createTempDir('gsd-pathguard-notyet-');
    t.after(() => cleanup(dir));
    const resolved = resolveWithin(dir, 'deep/not/created/yet.md');
    assert.strictEqual(typeof resolved, 'string');
    assert.ok(resolved.length > 0);
  });

  test('LoopWalk#writeArtifact rejects a traversing relPath', (t) => {
    const walk = LoopWalk.create({ fixture: 'greenfield', prefix: 'gsd-pathguard-write-' });
    t.after(() => walk.cleanup());
    assert.throws(() => walk.writeArtifact('../../escaped.md', 'x'), /escapes|absolute/);
    assert.strictEqual(fs.existsSync(path.join(path.dirname(walk.dir), 'escaped.md')), false);
  });

  test('LoopWalk#writeArtifact still writes a legitimate in-project path after the guard', (t) => {
    const walk = LoopWalk.create({ fixture: 'greenfield', prefix: 'gsd-pathguard-write-ok-' });
    t.after(() => walk.cleanup());
    walk.writeArtifact('.planning/PROJECT.md', '# ok\n');
    assert.strictEqual(fs.existsSync(path.join(walk.dir, '.planning', 'PROJECT.md')), true);
  });

  test('mutations apply("delete", ...) rejects a traversing relPath', (t) => {
    const mutDir = createTempDir('gsd-pathguard-delete-');
    t.after(() => cleanup(mutDir));
    assert.throws(() => apply('delete', { dir: mutDir, relPath: '../../../../etc/hosts' }), /escapes|absolute/);
  });

  test('mutations apply("symlink", ...) rejects a traversing relPath', (t) => {
    const mutDir = createTempDir('gsd-pathguard-symlink-');
    t.after(() => cleanup(mutDir));
    assert.throws(() => apply('symlink', { dir: mutDir, relPath: '../../../../etc/hosts' }), /escapes|absolute/);
  });

  test('loadScenario rejects a mutate.target that traverses out of the project, at load time', (t) => {
    const dir = createTempDir('gsd-pathguard-scenario-mutate-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({
      name: 'traversal-mutate',
      fixture: 'greenfield',
      steps: [{ at: 'plan:pre', mutate: { id: 'crlf', target: '../../evil.md' }, run: [['progress']] }],
    }));
    assert.throws(() => loadScenario(file), /evil|\.\./);
  });

  test('loadScenario rejects an absolute mutate.target, at load time', (t) => {
    const dir = createTempDir('gsd-pathguard-scenario-mutate-abs-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({
      name: 'absolute-mutate',
      fixture: 'greenfield',
      steps: [{ at: 'plan:pre', mutate: { id: 'crlf', target: '/etc/evil.md' }, run: [['progress']] }],
    }));
    assert.throws(() => loadScenario(file), /absolute/);
  });

  test('loadScenario rejects an agent.write key that traverses out of the project, at load time', (t) => {
    const dir = createTempDir('gsd-pathguard-scenario-write-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({
      name: 'traversal-write',
      fixture: 'greenfield',
      steps: [{ at: 'plan:pre', agent: { write: { '../../escaped.md': '@project/minimal' } }, run: [['progress']] }],
    }));
    assert.throws(() => loadScenario(file), /escaped|\.\./);
  });

  test('loadScenario rejects an absolute agent.write key, at load time', (t) => {
    const dir = createTempDir('gsd-pathguard-scenario-write-abs-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({
      name: 'absolute-write',
      fixture: 'greenfield',
      steps: [{ at: 'plan:pre', agent: { write: { '/etc/evil.md': '@project/minimal' } }, run: [['progress']] }],
    }));
    assert.throws(() => loadScenario(file), /etc|absolute/i);
  });
});

describe('greenfield walk (end-to-end)', () => {
  let liveCommands;

  before(() => {
    // tests/helpers/live-command-registry.cjs's real API: getLiveCommandTokens()
    // returns a memoized Set<string> of every live slash-command token derived
    // from commands/gsd/*.md frontmatter (e.g. "/gsd-plan-phase"). The
    // routing-validity oracle (#3913) checks command tokens carried by
    // result.json.actions[].command / result.json.next.command against this
    // set — never the bare result.json.recommended action id.
    liveCommands = [...getLiveCommandTokens()];
  });

  test('runs every step of the greenfield-happy-path scenario clean (A3: the real smart-entry --json payload passes routing-validity)', () => {
    const scenarioPath = path.join(__dirname, 'qa', 'scenarios', 'greenfield-happy-path.json');
    const scenario = loadScenario(scenarioPath);
    const report = runScenario(scenario, { LoopWalk, runOracles, liveCommands });

    assert.strictEqual(report.steps.length, scenario.steps.length);
    for (const step of report.steps) {
      assert.deepStrictEqual(step.expectFailures, []);
      assert.deepStrictEqual(step.oracleFailures, []);
    }
    assert.strictEqual(report.ok, true);

    // #3913: this scenario's corpus previously carried exactly two firing
    // smells — soft-error-exit-zero on state-snapshot, and untyped-success on
    // smart-entry (before it gained a --json surface). Both are now fixed:
    // soft-error-exit-zero is deleted outright, and adding --json to
    // smart-entry gives it a typed surface so untyped-success (now a
    // VIOLATION) never fires against it. So this corpus is genuinely
    // smell-free — asserting `totalSmells === 0` is the honest anti-vacuity
    // check here. The harness's ability to actually SPEAK a finding (not just
    // report nothing) is exercised elsewhere: every oracle's own pass/fail
    // self-test above, the C1/C2 promoted-violation tests, and the wiring
    // self-test below.
    const allSmells = report.steps.flatMap((step) =>
      step.smells.map((smell) => ({ at: step.at, id: smell.id, subject: smell.subject, detail: smell.detail })));
    assert.strictEqual(
      allSmells.length,
      0,
      `expected the greenfield walk to be smell-free after #3913, found ${allSmells.length}:\n${JSON.stringify(allSmells, null, 2)}`,
    );
  });
});

describe('scenario discovery (mutations wired for real)', () => {
  /**
   * Every `.json` scenario file under `tests/qa/scenarios/`, EXCLUDING
   * underscore-prefixed ones (`_selftest-must-fail.json`) — an
   * underscore-prefixed scenario is deliberately broken (see
   * `assertWiringIsLive`) and must never run as a normal walk.
   *
   * @returns {string[]} absolute file paths.
   */
  function discoverScenarioFiles() {
    const scenariosDir = path.join(__dirname, 'qa', 'scenarios');
    return fs
      .readdirSync(scenariosDir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
      .sort()
      .map((name) => path.join(scenariosDir, name));
  }

  test('discovery excludes underscore-prefixed self-test scenarios', () => {
    const names = discoverScenarioFiles().map((p) => path.basename(p));
    assert.ok(names.includes('greenfield-happy-path.json'));
    assert.ok(names.includes('perturbation-crlf.json'));
    assert.ok(names.includes('perturbation-truncated-frontmatter.json'));
    assert.ok(names.includes('perturbation-delete-artifact.json'));
    assert.strictEqual(names.includes('_selftest-must-fail.json'), false);
  });

  test('every discovered scenario holds its own expectations and runs to completion; every perturbation applies its mutation', () => {
    const liveCommands = [...getLiveCommandTokens()];
    const allFiles = discoverScenarioFiles();
    const perturbationFiles = allFiles.filter((p) => path.basename(p).startsWith('perturbation-'));
    const nonPerturbationFiles = allFiles.filter((p) => !path.basename(p).startsWith('perturbation-'));
    assert.ok(perturbationFiles.length >= 3, 'expected at least the crlf, truncated-frontmatter, and delete-artifact scenarios');
    assert.ok(nonPerturbationFiles.length >= 1, 'expected at least one non-perturbation scenario — otherwise this widening silently narrows back to a perturbation-only loop');

    // Anti-vacuity for perturbations specifically: a mutation that changes
    // nothing observable in ANY scenario is indistinguishable from a
    // mutation that was never applied (see `scenario.cjs`'s
    // `mutationObserved` computation). At least one mutated step across the
    // whole perturbation set must show a genuinely different result from its
    // own clean baseline — if none ever does, that is a finding about which
    // engine surfaces are sensitive to corruption, not something to paper
    // over by weakening this assertion.
    let anyMutationObserved = false;

    // Widened to EVERY discovered scenario, not just perturbations: scoping
    // the `expectFailures`/`report.ok` contract checks to `perturbation-*`
    // was itself the #3597 blind spot in miniature — `multi-workstream`, the
    // exact scenario this PR fixes, is not a perturbation scenario, so the
    // old perturbation-only loop could never have seen it fail.
    for (const file of allFiles) {
      const isPerturbation = path.basename(file).startsWith('perturbation-');
      const scenario = loadScenario(file);
      const report = runScenario(scenario, { LoopWalk, runOracles, liveCommands });

      assert.strictEqual(report.steps.length, scenario.steps.length, `${scenario.name}: a step went missing from the report`);
      for (const step of report.steps) {
        assert.strictEqual(
          step.oracleFailures.some((f) => f.id === 'step-exception'),
          false,
          `${scenario.name}: step at "${step.at}" crashed the harness: ${JSON.stringify(step.oracleFailures)}`,
        );
      }

      // A scenario reporting `ok: false` used to be invisible here — this
      // loop only ever checked that the harness did not CRASH, never that
      // the scenario's own declared expectations held (#3597, the test-side
      // half; the gate-side half is `collectFindings` collecting
      // `expectFailures` in `scripts/qa-smell-ratchet.cjs`). That blind spot
      // is exactly what let `multi-workstream` fail on every CI run since
      // 2026-08-10 without reddening anything. The `expectFailures`
      // assertion comes first deliberately because it names WHICH
      // expectation broke, whereas `report.ok` alone only says something did.
      assert.deepStrictEqual(
        report.steps.flatMap((s) => s.expectFailures),
        [],
        `${scenario.name}: a declared expectation failed — the scenario's own contract is broken`,
      );
      assert.strictEqual(
        report.ok,
        true,
        `${scenario.name}: scenario reported ok:false`,
      );

      if (!isPerturbation) continue;

      const mutatedStep = report.steps.find((s) => s.mutation);
      assert.ok(mutatedStep, `${scenario.name}: no step recorded a mutation — mutations remain unwired`);
      assert.strictEqual(mutatedStep.mutationNoop, false, `${scenario.name}: mutation no-oped on a real roadmap artifact`);

      if (mutatedStep.mutationObserved) anyMutationObserved = true;
    }

    assert.strictEqual(
      anyMutationObserved,
      true,
      'no perturbation scenario produced an observable mutation against its probed surface — '
        + 'every corruption was silently absorbed',
    );
  });

  test('B2: across every discovered scenario, the count of steps classified KIND.PROSE is exactly 0 (#3913)', () => {
    // Asserted over the ENUMERATED corpus, not sampled — the promoted
    // untyped-success oracle is only safe to run as a VIOLATION because no
    // executed step anywhere in the corpus emits KIND.PROSE today. A future
    // prose-only step reddens the build via untyped-success, which is the
    // intended behavior (see oracles.cjs's describe text for that oracle).
    const liveCommands = [...getLiveCommandTokens()];
    const allFiles = discoverScenarioFiles();
    assert.ok(allFiles.length > 0, 'expected at least one scenario file — otherwise this count is vacuous');
    let proseSteps = 0;
    let totalSteps = 0;
    for (const file of allFiles) {
      const scenario = loadScenario(file);
      const report = runScenario(scenario, { LoopWalk, runOracles, liveCommands });
      for (const step of report.steps) {
        totalSteps += 1;
        if (step.kind === KIND.PROSE) proseSteps += 1;
      }
    }
    assert.ok(totalSteps > 0, 'expected at least one executed step across the corpus');
    assert.strictEqual(proseSteps, 0, `expected 0 KIND.PROSE steps across ${totalSteps} executed steps`);
  });
});

describe('wiring self-test (anti-vacuity)', () => {
  test('the self-test scenario proves the expect/oracle assertion machinery actually fires', () => {
    const liveCommands = [...getLiveCommandTokens()];
    const report = assertWiringIsLive({ LoopWalk, runOracles, liveCommands });
    assert.strictEqual(report.ok, false);
    assert.ok(report.steps.some((s) => s.expectFailures.length > 0));
  });
});

describe('fixture integrity', () => {
  /**
   * Absolute path to `tests/qa/fixtures/`, the corpus every QA scenario/fixture-ref
   * draws from (see `tests/qa/fixtures/index.cjs`'s `resolveRef`).
   */
  const FIXTURES_ROOT = path.join(__dirname, 'qa', 'fixtures');

  /**
   * Every fixture `.md` file, read once, keyed by absolute path — every test below
   * reuses this instead of re-walking the tree.
   *
   * WHY module-content, not module-frontmatter: this guards against defect classes
   * where a provenance comment (or any other byte-0 preamble) silently defeats
   * `extractFrontmatter`, which only recognizes a frontmatter block that starts at
   * byte 0 of the file (`gsd-core/bin/lib/frontmatter.cjs` — `content.startsWith('---\n')`).
   */
  const fixtureFiles = collectFixtureMarkdownFiles(FIXTURES_ROOT);

  test('discovered at least the known fixture directories (sanity, not vacuous)', () => {
    assert.ok(fixtureFiles.length > 0, 'expected at least one fixture .md file under tests/qa/fixtures');
  });

  test('every fixture that is frontmatter-shaped (optionally preceded by a leading comment) parses to a NON-EMPTY object', () => {
    const offenders = [];
    for (const file of fixtureFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (!hasFrontmatterShape(content)) continue;
      const fm = extractFrontmatter(content, file);
      if (Object.keys(fm).length === 0) {
        offenders.push(path.relative(FIXTURES_ROOT, file));
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `fixture(s) are frontmatter-shaped but extractFrontmatter returned {} (frontmatter not at byte 0 — ` +
        `likely a leading comment ahead of the fence — or malformed): ${JSON.stringify(offenders)}`,
    );
  });

  test('every fixture carries the #2371 provenance marker somewhere in the file', () => {
    const offenders = [];
    for (const file of fixtureFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (!content.includes('provenance:')) {
        offenders.push(path.relative(FIXTURES_ROOT, file));
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `fixture(s) missing the #2371 provenance marker: ${JSON.stringify(offenders)}`,
    );
  });

  describe('UAT fixtures flip the REAL evaluateUatPassed verdict', () => {
    let dir;

    beforeEach(() => {
      dir = createTempDir('gsd-uat-fixture-integrity-');
    });

    afterEach(() => {
      cleanup(dir);
    });

    test('the passing UAT fixture yields passed:true, no_uat_artifacts:false', () => {
      const content = fs.readFileSync(path.join(FIXTURES_ROOT, 'uat', 'current-test-passing.md'), 'utf-8');
      fs.writeFileSync(path.join(dir, 'feature-UAT.md'), content, 'utf-8');
      const report = evaluateUatPassed(dir);
      assert.strictEqual(report.passed, true);
      assert.strictEqual(report.no_uat_artifacts, false);
      assert.ok(report.checks.length > 0, 'expected at least one real parsed check');
    });

    test('the failing UAT fixture yields passed:false, no_uat_artifacts:false', () => {
      const content = fs.readFileSync(path.join(FIXTURES_ROOT, 'uat', 'current-test-failing.md'), 'utf-8');
      fs.writeFileSync(path.join(dir, 'feature-UAT.md'), content, 'utf-8');
      const report = evaluateUatPassed(dir);
      assert.strictEqual(report.passed, false);
      assert.strictEqual(report.no_uat_artifacts, false);
      assert.ok(report.checks.length > 0, 'expected at least one real parsed check');
    });
  });
});

describe('walk isolation', () => {
  test('two LoopWalk instances never share a project directory', (t) => {
    const walkA = LoopWalk.create({ fixture: 'greenfield', prefix: 'gsd-walk-isolation-a-' });
    const walkB = LoopWalk.create({ fixture: 'greenfield', prefix: 'gsd-walk-isolation-b-' });
    t.after(() => {
      walkA.cleanup();
      walkB.cleanup();
    });
    assert.notStrictEqual(walkA.dir, walkB.dir);
  });

  test('a read-only command does not change the stat snapshot', (t) => {
    const walk = LoopWalk.create({ fixture: 'greenfield', prefix: 'gsd-walk-isolation-readonly-' });
    t.after(() => walk.cleanup());
    const statsBefore = walk.statSnapshot();
    walk.run('progress');
    const statsAfter = walk.statSnapshot();
    assert.deepStrictEqual(statsBefore, statsAfter);
  });
});

describe('worktree-concurrency (dedicated — trajectory 9 is not expressible as a single scenario)', () => {
  /**
   * WHY THIS IS A DEDICATED TEST, NOT A `scenarios/*.json` FILE
   * ────────────────────────────────────────────────────────────
   * `scenario.cjs#runScenario` drives exactly one `LoopWalk` through a
   * strictly sequential `steps` array — `LoopWalk#run` itself is built on
   * `execFileSync` (see `loop-walk.cjs`), so within the DSL there is no way to
   * have two `gsd-tools` invocations genuinely in flight at the same wall-clock
   * moment. "Two LoopWalk instances driving simultaneously" (issue #2966's
   * ninth trajectory) is therefore implemented here directly against
   * `child_process.execFile` (async) so both subprocesses are launched before
   * either has resolved — real concurrency, not two sequential calls dressed
   * up as one.
   */

  /** Absolute path to the gsd-tools entry point, mirrored from `helpers.cjs`'s `TOOLS_PATH`. */
  const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  /**
   * Runs a single `gsd-tools --json-errors <argv>` invocation asynchronously
   * against `dir`, sanitizing ambient `GSD_*` env vars exactly as
   * `LoopWalk#run` does (see that method's header for why), and pinning the
   * clock so both concurrent invocations are reproducible.
   *
   * @param {string} dir
   * @param {string[]} argv
   * @returns {Promise<{stdout: string, startedAtMs: number, finishedAtMs: number}>}
   */
  async function runConcurrent(dir, argv) {
    /** @type {Record<string, string|undefined>} */
    const sanitize = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GSD_')) sanitize[key] = undefined;
    }
    const env = { ...sanitize, GSD_TEST_MODE: '1', GSD_NOW_MS: '1767225600000' };
    const startedAtMs = Date.now();
    const { stdout } = await execFileAsync(
      process.execPath,
      [TOOLS_PATH, '--json-errors', ...argv],
      { cwd: dir, encoding: 'utf-8', env, timeout: 60000 },
    );
    return { stdout: stdout.trim(), startedAtMs, finishedAtMs: Date.now() };
  }

  test('two LoopWalk projects driven via genuinely concurrent async subprocesses stay isolated', async (t) => {
    const walkA = LoopWalk.create({ fixture: 'greenfield', prefix: 'gsd-concurrency-a-' });
    const walkB = LoopWalk.create({ fixture: 'greenfield', prefix: 'gsd-concurrency-b-' });
    t.after(() => {
      walkA.cleanup();
      walkB.cleanup();
    });

    walkA.writeArtifact('.planning/PROJECT.md', resolveRef('@project/minimal'));
    walkA.writeArtifact('.planning/ROADMAP.md', resolveRef('@roadmap/three-phase'));
    walkB.writeArtifact('.planning/PROJECT.md', resolveRef('@project/minimal'));
    walkB.writeArtifact('.planning/ROADMAP.md', resolveRef('@roadmap/three-phase'));

    // Both promises are created (and their subprocesses spawned) in the same
    // synchronous tick, BEFORE either `await`s — this is what makes the two
    // invocations genuinely concurrent rather than sequential-looking-parallel.
    const promiseA = runConcurrent(walkA.dir, ['init', 'new-project']);
    const promiseB = runConcurrent(walkB.dir, ['init', 'new-project']);
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    // Proof of genuine overlap: A's subprocess was still running when B's was
    // launched (both started before either finished). If the harness had
    // silently serialized these (e.g. a shared lock), one start time would be
    // >= the other's finish time.
    const overlapped = resultA.startedAtMs < resultB.finishedAtMs && resultB.startedAtMs < resultA.finishedAtMs;
    assert.ok(
      overlapped,
      `expected the two subprocess invocations to overlap in wall-clock time (A: ${resultA.startedAtMs}-${resultA.finishedAtMs}, B: ${resultB.startedAtMs}-${resultB.finishedAtMs})`,
    );

    const jsonA = JSON.parse(resultA.stdout);
    const jsonB = JSON.parse(resultB.stdout);

    // Isolation: each concurrent run must observe and report its OWN project
    // root, never the other's — a shared-state bug (e.g. a global cwd) would
    // show up here as both reporting the same root.
    assert.strictEqual(resolveForCompare(jsonA.project_root), resolveForCompare(walkA.dir));
    assert.strictEqual(resolveForCompare(jsonB.project_root), resolveForCompare(walkB.dir));
    assert.notStrictEqual(resolveForCompare(jsonA.project_root), resolveForCompare(jsonB.project_root));

    // Both saw their own freshly-written PROJECT.md/ROADMAP.md, independent of
    // the other walk's concurrent writes to a different temp directory.
    assert.strictEqual(jsonA.project_exists, true);
    assert.strictEqual(jsonB.project_exists, true);
  });
});

describe('qa-smell-ratchet gate (#3597)', () => {
  /**
   * Build a one-scenario, one-step report object that mirrors the shape
   * `tests/qa/report.cjs`'s `buildReport()` produces, so `collectFindings`
   * (from `scripts/qa-smell-ratchet.cjs`) can be exercised directly without
   * running a real 20-scenario walk against the CLI. Every field present on
   * a real report is present here — including `totals.violations`, which
   * `buildReport` computes as `violations.length + expectFailures.length`
   * per step, not `violations.length` alone.
   *
   * @param {{expectFailures?: string[], violations?: Array<{id:string,detail:string}>, smells?: Array<{id:string,subject?:string,detail:string}>}} params
   * @returns {object} a synthetic report object
   */
  function reportWithStep({ expectFailures = [], violations = [], smells = [] }) {
    const step = {
      at: 'execute:post',
      argv: ['--ws', 'alpha', 'progress'],
      kind: 'json',
      expectFailures,
      violations,
      smells,
      mutation: null,
      mutationNoop: false,
      mutationObserved: false,
      repro: 'cd /tmp/x && node gsd-core/bin/gsd-tools.cjs --ws alpha progress',
    };
    return {
      reportVersion: 1,
      meta: { nodeVersion: 'v24.0.0', platform: 'linux', generatedAt: '2026-01-01T00:00:00.000Z' },
      totals: {
        scenarios: 1,
        steps: 1,
        violations: expectFailures.length + violations.length,
        smells: smells.length,
        mutationsApplied: 0,
        mutationsObserved: 0,
      },
      scenarios: [
        {
          name: 'synthetic-scenario',
          ok: (expectFailures.length + violations.length) === 0,
          fixture: 'greenfield',
          steps: [step],
        },
      ],
      smellSummary: [],
    };
  }

  /**
   * Build a single step object, EXACTLY like `reportWithStep`'s inline step —
   * except `expectFailures`/`violations`/`smells` are only set on `step` when
   * explicitly present in `fields`. Passing `{}` produces a step where all
   * three keys are ABSENT entirely (not empty arrays), which is what
   * exercises `collectFindings`'s `step.violations || []` /
   * `step.expectFailures || []` / `step.smells || []` defensive fallbacks —
   * `reportWithStep` alone can never omit a key, since it always assigns all
   * three with `= []` defaults.
   *
   * @param {{expectFailures?: string[], violations?: Array<object>, smells?: Array<object>, at?: string, argv?: string[]}} [fields]
   * @returns {object}
   */
  function buildStep(fields = {}) {
    const step = {
      at: fields.at || 'execute:post',
      argv: fields.argv || ['--ws', 'alpha', 'progress'],
      kind: 'json',
      mutation: null,
      mutationNoop: false,
      mutationObserved: false,
      repro: 'cd /tmp/x && node gsd-core/bin/gsd-tools.cjs --ws alpha progress',
    };
    if (fields.expectFailures !== undefined) step.expectFailures = fields.expectFailures;
    if (fields.violations !== undefined) step.violations = fields.violations;
    if (fields.smells !== undefined) step.smells = fields.smells;
    return step;
  }

  /**
   * Build a full synthetic report spanning one or more scenarios (each with
   * its own, possibly empty, `steps` array) — a sibling to `reportWithStep`
   * for shapes it cannot express (multiple scenarios; zero-step scenarios).
   * `totalViolations` is supplied explicitly by the caller so each PARITY
   * case can assert against the exact combined count it intends
   * `report.totals.violations` to carry, mirroring how `buildReport()`
   * computes that field for real reports.
   *
   * @param {Array<{name: string, steps: object[]}>} scenarioDefs
   * @param {number} totalViolations
   * @returns {object}
   */
  function reportWithScenarios(scenarioDefs, totalViolations) {
    return {
      reportVersion: 1,
      meta: { nodeVersion: 'v24.0.0', platform: 'linux', generatedAt: '2026-01-01T00:00:00.000Z' },
      totals: {
        scenarios: scenarioDefs.length,
        steps: scenarioDefs.reduce((sum, s) => sum + s.steps.length, 0),
        violations: totalViolations,
        smells: 0,
        mutationsApplied: 0,
        mutationsObserved: 0,
      },
      scenarios: scenarioDefs.map((s) => ({
        name: s.name,
        ok: true,
        fixture: 'greenfield',
        steps: s.steps,
      })),
      smellSummary: [],
    };
  }

  /**
   * Build a report via the REAL `buildReport()` (tests/qa/report.cjs) rather
   * than hand-computing `totals.violations`. Every other PARITY case above
   * hardcodes `expectFailures.length + violations.length` itself — the same
   * formula `buildReport` uses internally — so a change to `buildReport`'s
   * own violation-counting formula would leave those cases green while the
   * gate silently drifted from the report it reads (exactly the #3597
   * defect class). Routing at least one case through the real builder is
   * what makes this test capable of catching that drift.
   *
   * @param {Array<{name: string, steps: Array<{at?: string, argv?: string[], kind?: string, oracleFailures?: object[], expectFailures?: string[], smells?: object[]}>}>} scenarioDefs
   * @returns {object} a real report document produced by `buildReport()`
   */
  function realBuiltReport(scenarioDefs) {
    const scenarioReports = scenarioDefs.map((s) => ({
      name: s.name,
      ok: true,
      fixture: 'greenfield',
      steps: s.steps.map((step) => ({
        at: step.at || 'execute:post',
        argv: step.argv || ['--ws', 'alpha', 'progress'],
        kind: step.kind || 'json',
        expectFailures: step.expectFailures || [],
        oracleFailures: step.oracleFailures || [],
        smells: step.smells || [],
        mutation: null,
        mutationNoop: false,
        mutationObserved: false,
      })),
    }));
    return buildReport(scenarioReports, {
      nodeVersion: 'v24.0.0',
      platform: 'linux',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  test('requiring the ratchet does NOT run a full walk — proven by running require() to completion in a CHILD PROCESS (#3597)', () => {
    // WHY AN IN-PROCESS ELAPSED-TIME CHECK IS INSUFFICIENT (and banned):
    // `runMain` (`scripts/lib/cli-exit.cjs:38`) defers through
    // `Promise.resolve().then(() => main())` — a microtask — so a synchronous
    // `require()` call ALWAYS returns before `main()` has had any chance to
    // run, REGARDLESS of whether the `require.main === module` guard exists
    // at all. Proven with a synthetic module whose `main()` blocks for
    // 4000ms: `require()` of it still returns in ~2ms. Both "typeof
    // collectFindings === 'function'" and "elapsed < Nms" pass identically
    // against the UNGUARDED file, so an in-process timing assertion proves
    // nothing about the guard — it is vacuous. It is also a wall-clock
    // assertion, which CLAUDE.md's test rules ban outright ("Clock Seams: Do
    // not assert on wall-clock time").
    //
    // WHY A CHILD PROCESS IS THE ONLY THING THAT ACTUALLY OBSERVES THE GUARD:
    // spawning `node -e "require(<path>)"` and letting the event loop drain
    // to natural completion (rather than measuring how fast `require()`
    // returns) lets whatever `runMain` scheduled actually run. Loaded via
    // `-e`, the required module's own `module` object is never
    // `require.main` (that identity belongs to the `-e` pseudo-module), so a
    // genuinely guarded file never calls `runMain(main)` and its process
    // never prints `main()`'s "qa-smell-ratchet: ..." summary line. Against
    // the pre-#3597 unguarded shape, `runMain(main)` always fires and that
    // line DOES appear in the child's output. That presence/absence is the
    // only thing that actually distinguishes guarded from unguarded.
    const scriptPath = path.join(__dirname, '..', 'scripts', 'qa-smell-ratchet.cjs');
    const repoRoot = path.join(__dirname, '..');
    const result = spawnSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(scriptPath)})`],
      { cwd: repoRoot, timeout: 120000, encoding: 'utf-8' },
    );
    assert.strictEqual(
      result.status,
      0,
      `child process exited non-zero (status=${result.status}): stdout=${result.stdout} stderr=${result.stderr}`,
    );
    const combined = `${result.stdout || ''}${result.stderr || ''}`;
    // This is the discriminating assertion: `jsonOut` defaults to `null` in
    // `parseArgs` (scripts/qa-smell-ratchet.cjs), so no report is written
    // even under the unguarded pre-fix shape run via `node -e` — asserting
    // the ABSENCE of qa-report.json would be vacuously true either way. The
    // presence/absence of the "qa-smell-ratchet:" summary line is the only
    // thing that actually distinguishes a guarded require() from an
    // unguarded one (see the WHY comments above).
    assert.strictEqual(
      combined.includes('qa-smell-ratchet:'),
      false,
      'require()ing the ratchet printed main()\'s summary line in a child process — the require.main guard did not prevent a full walk',
    );

    // `collectFindings` remains reachable in-process, as documented.
    const ratchet = require('../scripts/qa-smell-ratchet.cjs');
    assert.strictEqual(typeof ratchet.collectFindings, 'function');
  });

  test('collectFindings surfaces a scenario expectation failure — a failing scenario must reach the gate', () => {
    const { collectFindings } = require('../scripts/qa-smell-ratchet.cjs');
    // This is the #3597 defect: `multi-workstream` failed this exact way on
    // every CI run from 2026-08-10 onward while the ratchet printed
    // "0 violations" and exited 0 — because `collectFindings` never read
    // `step.expectFailures` at all.
    const report = reportWithStep({ expectFailures: ['path "percent": expected 100, got null'] });
    const found = collectFindings(report);
    assert.strictEqual(found.expectationFailures.length, 1);
    const [entry] = found.expectationFailures;
    assert.strictEqual(entry.scenario, 'synthetic-scenario');
    assert.strictEqual(entry.at, 'execute:post');
    assert.strictEqual(entry.detail, 'path "percent": expected 100, got null');
    assert.deepStrictEqual(entry.argv, ['--ws', 'alpha', 'progress']);
    assert.ok(entry.repro);
  });

  test('an expectation failure is NOT reported as an oracle violation (the two stay distinguishable)', () => {
    const { collectFindings } = require('../scripts/qa-smell-ratchet.cjs');
    const report = reportWithStep({ expectFailures: ['path "percent": expected 100, got null'] });
    const found = collectFindings(report);
    // Tied to the new bucket: pre-fix, `collectFindings` returned
    // `{smells: [], violations: []}` for this exact input (it never read
    // `step.expectFailures` at all), so both `deepStrictEqual([])` arms below
    // passed unchanged whether the fix was present or not. Asserting the
    // expectation failure was actually collected is what makes this test
    // capable of failing against that pre-fix shape.
    assert.strictEqual(found.expectationFailures.length, 1);
    assert.deepStrictEqual(found.violations, []);
    assert.deepStrictEqual(found.smells, []);
  });

  test('an expectation failure is never fingerprinted, so it can never be baselined or acked away', () => {
    const { collectFindings } = require('../scripts/qa-smell-ratchet.cjs');
    const report = reportWithStep({ expectFailures: ['path "percent": expected 100, got null'] });
    const found = collectFindings(report);
    for (const failure of found.expectationFailures) {
      assert.strictEqual(
        failure.key,
        undefined,
        'an expectation failure must not carry a fingerprint `key` — a key would make it acknowledgeable via smell-baseline.json / smell-acks/, letting a real scenario failure be silenced like a smell',
      );
    }
  });

  test('PARITY: the gate counts exactly what report.totals.violations counts', () => {
    // The #3597 root cause was a silent disagreement between these two
    // counters: `report.totals.violations` (built by `buildReport`) already
    // counted `expectFailures`, but `collectFindings` (consumed by the gate)
    // did not — so the gate under-counted relative to the report it was
    // reading.
    const { collectFindings } = require('../scripts/qa-smell-ratchet.cjs');
    const cases = [
      reportWithStep({}),
      reportWithStep({ expectFailures: ['a'] }),
      reportWithStep({ violations: [{ id: 'exit-contract', detail: 'boom' }] }),
      reportWithStep({ expectFailures: ['a', 'b'], violations: [{ id: 'exit-contract', detail: 'boom' }] }),
      // A step whose expectFailures/violations/smells keys are ABSENT
      // entirely (not empty arrays) — exercises collectFindings's `|| []`
      // defensive fallbacks.
      reportWithScenarios([{ name: 'absent-keys-scenario', steps: [buildStep({})] }], 0),
      // Two scenarios, each contributing at least one expectation failure
      // and/or violation, with totals.violations set to the true combined
      // count across BOTH scenarios.
      reportWithScenarios(
        [
          {
            name: 'scenario-one',
            steps: [
              buildStep({ expectFailures: ['a'] }),
              buildStep({ violations: [{ id: 'exit-contract', detail: 'boom' }] }),
            ],
          },
          { name: 'scenario-two', steps: [buildStep({ expectFailures: ['b', 'c'] })] },
        ],
        4,
      ),
      // A scenario whose steps array is EMPTY.
      reportWithScenarios([{ name: 'empty-steps-scenario', steps: [] }], 0),
      // Built via the REAL buildReport() (see realBuiltReport's doc comment
      // above for why this case, specifically, is load-bearing).
      realBuiltReport([{ name: 'real-scenario', steps: [{ expectFailures: ['a'] }] }]),
      realBuiltReport([
        {
          name: 'real-scenario-one',
          steps: [
            { expectFailures: ['a'] },
            { oracleFailures: [{ id: 'exit-contract', detail: 'boom' }] },
          ],
        },
        { name: 'real-scenario-two', steps: [{ expectFailures: ['b', 'c'] }] },
      ]),
    ];
    for (const report of cases) {
      const found = collectFindings(report);
      assert.strictEqual(
        found.violations.length + found.expectationFailures.length,
        report.totals.violations,
      );
    }
  });

  test('a clean report yields no findings at all (anti-vacuity: the assertions above can pass honestly)', () => {
    const { collectFindings } = require('../scripts/qa-smell-ratchet.cjs');
    const found = collectFindings(reportWithStep({}));
    assert.deepStrictEqual(found.violations, []);
    assert.deepStrictEqual(found.expectationFailures, []);
    assert.deepStrictEqual(found.smells, []);
  });
});

describe('smell-baseline.json pruning (#3913 matrix E)', () => {
  const BASELINE_PATH = path.join(__dirname, 'qa', 'smell-baseline.json');

  /** @returns {{version: number, smells: Array<{key:string,id:string,scenario:string,issue:unknown,reason?:string}>}} */
  function readBaseline() {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  }

  test('E1: smell-baseline.json contains zero entries with id soft-error-exit-zero or untyped-success', () => {
    const baseline = readBaseline();
    const stale = baseline.smells.filter(
      (s) => s.id === 'soft-error-exit-zero' || s.id === 'untyped-success',
    );
    assert.deepStrictEqual(
      stale,
      [],
      `expected zero soft-error-exit-zero/untyped-success entries, found: ${JSON.stringify(stale)}`,
    );
  });

  // The real post-condition phase 8 drove toward: the baseline is EMPTY, not
  // merely "every entry (if any) is well-formed". Asserting emptiness
  // directly is what actually pins today's state — a loop over `[]` below
  // would trivially pass regardless of whether the fix ever shipped.
  test('E3a: smell-baseline.json currently carries zero entries', () => {
    const baseline = readBaseline();
    assert.deepStrictEqual(baseline.smells, [], `expected an empty baseline, found: ${JSON.stringify(baseline.smells)}`);
  });

  /** The same predicate the baseline-entry check enforces, isolated so a synthetic fixture can actually drive it (the real baseline has no entries to iterate today). */
  function isPositiveIntegerIssue(entry) {
    return Number.isInteger(entry.issue) && entry.issue > 0;
  }

  // E3b: drives isPositiveIntegerIssue over a SYNTHETIC fixture, since the
  // real baseline's `smells` array is empty and a loop over it never
  // executes its body — a bare `for (const entry of baseline.smells)` test
  // against the live file is vacuous by construction. This is what actually
  // proves the invariant can fail.
  test('E3b: a baseline entry with a non-positive or non-integer issue fails the check (synthetic fixture)', () => {
    assert.strictEqual(isPositiveIntegerIssue({ key: 'k', issue: 3913 }), true);
    for (const bad of [
      { key: 'zero', issue: 0 },
      { key: 'negative', issue: -1 },
      { key: 'float', issue: 3.5 },
      { key: 'string', issue: '3913' },
      { key: 'missing', issue: undefined },
    ]) {
      assert.strictEqual(isPositiveIntegerIssue(bad), false, `entry ${JSON.stringify(bad)} must fail the positive-integer-issue check`);
    }
  });

  // Forward guard, not a regression test: if a future PR re-adds baseline
  // entries, EVERY one of them must still satisfy isPositiveIntegerIssue.
  // Currently vacuous (smells is []) — it exists to catch a future
  // regression, not today's state (see E3a/E3b for the tests that can
  // actually fail right now).
  test('forward guard: every surviving baseline entry (if any are ever re-added) must cite a positive-integer issue', () => {
    const baseline = readBaseline();
    for (const entry of baseline.smells) {
      assert.strictEqual(
        isPositiveIntegerIssue(entry),
        true,
        `entry ${JSON.stringify(entry.key)} has a non-positive-integer issue: ${JSON.stringify(entry.issue)}`,
      );
    }
  });

  // Forward guard, not a regression test: `version` and `smells` are set
  // once by hand in this committed fixture and nothing in this suite
  // mutates them, so this cannot fail today — it exists to catch a FUTURE
  // change that corrupts the file's shape (e.g. a hand-edit that drops
  // `version` or turns `smells` into an object).
  test('forward guard: smell-baseline.json keeps its version:1 / smells-array shape', () => {
    const baseline = readBaseline();
    assert.strictEqual(baseline.version, 1);
    assert.ok(Array.isArray(baseline.smells));
  });
});
