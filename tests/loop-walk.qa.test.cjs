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

const { createTempDir, cleanup } = require('./helpers.cjs');
const { getLiveCommandTokens } = require('./helpers/live-command-registry.cjs');

const { KIND, classify } = require('./qa/result.cjs');
const { ORACLES, runOracles, SEVERITY } = require('./qa/oracles.cjs');
const { LoopWalk } = require('./qa/loop-walk.cjs');
const { MUTATIONS, apply, NOOP } = require('./qa/mutations.cjs');
const { loadScenario, runScenario, assertWiringIsLive } = require('./qa/scenario.cjs');
const { resolveRef } = require('./qa/fixtures/index.cjs');
const { resolveWithin } = require('./qa/paths.cjs');
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');

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
  test('ORACLES has exactly 10 entries (7 violation-severity + 3 smell-severity)', () => {
    assert.strictEqual(ORACLES.length, 10);
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
    const outcome = getOracle('monotonic-progress').check({
      history: [{ json: { total_plans: 5 } }],
      result: { json: { total_plans: 2 } },
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
  });

  test('routing-validity passes on a clean context', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { recommended: '/gsd-plan-phase' } },
      liveCommands: ['/gsd-plan-phase'],
    });
    assert.strictEqual(outcome.ok, true);
  });

  test('routing-validity fails on a broken context (token not in liveCommands)', () => {
    const outcome = getOracle('routing-validity').check({
      result: { json: { recommended: '/gsd-plan-phase' } },
      liveCommands: ['/gsd-something-else'],
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
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

  test('soft-error-exit-zero passes on a clean context', () => {
    const outcome = getOracle('soft-error-exit-zero').check({ result: { kind: KIND.JSON, argv: ['progress'] } });
    assert.strictEqual(outcome.ok, true);
  });

  test('soft-error-exit-zero SMELLs (not a violation) on a SOFT_ERROR result', () => {
    const ctx = { result: { kind: KIND.SOFT_ERROR, argv: ['progress'], json: { error: 'no phases found' } } };
    const outcome = getOracle('soft-error-exit-zero').check(ctx);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.SMELL);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
    assert.ok(outcome.detail.includes('progress'), 'detail must name the offending command');
    const { violations, smells } = runOracles(ctx);
    assert.strictEqual(violations.some((v) => v.id === 'soft-error-exit-zero'), false);
    assert.strictEqual(smells.some((s) => s.id === 'soft-error-exit-zero'), true);
  });

  test('untyped-success passes on a clean context', () => {
    const outcome = getOracle('untyped-success').check({ result: { kind: KIND.JSON, argv: ['progress'] } });
    assert.strictEqual(outcome.ok, true);
  });

  test('untyped-success SMELLs (not a violation) on a PROSE result', () => {
    const ctx = { result: { kind: KIND.PROSE, argv: ['init'] } };
    const outcome = getOracle('untyped-success').check(ctx);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.severity, SEVERITY.SMELL);
    assert.strictEqual(typeof outcome.detail, 'string');
    assert.ok(outcome.detail.length > 0);
    assert.ok(outcome.detail.includes('init'), 'detail must name the offending command');
    const { violations, smells } = runOracles(ctx);
    assert.strictEqual(violations.some((v) => v.id === 'untyped-success'), false);
    assert.strictEqual(smells.some((s) => s.id === 'untyped-success'), true);
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
    assert.ok(outcome.detail.includes('bad-usage'), 'detail must name the offending command');
    const { violations, smells } = runOracles(ctx);
    assert.strictEqual(violations.some((v) => v.id === 'contract-conflict'), false);
    assert.strictEqual(smells.some((s) => s.id === 'contract-conflict'), true);
  });
});

describe('severity model', () => {
  test('a smell must never appear in failed (the contract that keeps smells from breaking builds)', () => {
    const ctx = { result: { kind: KIND.PROSE, argv: ['init'] } };
    const { failed, smells } = runOracles(ctx);
    assert.ok(smells.some((s) => s.id === 'untyped-success'));
    assert.strictEqual(failed.some((f) => f.id === 'untyped-success'), false);
  });

  test('failed.length === violations.length for a context producing both a violation and a smell', () => {
    // value-hygiene fires a VIOLATION on the NaN leaf; untyped-success fires a
    // SMELL on the PROSE kind. Both fire from the same ctx.
    const ctx = { result: { kind: KIND.PROSE, argv: ['init'], json: { a: Number.NaN } } };
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
      assert.ok(err.message.includes('../../etc/hosts'));
      assert.ok(err.message.includes(dir));
      return true;
    });
  });

  test('resolveWithin rejects an absolute relPath', (t) => {
    const dir = createTempDir('gsd-pathguard-abs-');
    t.after(() => cleanup(dir));
    assert.throws(() => resolveWithin(dir, '/etc/hosts'), /absolute/);
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
    // routing-validity oracle checks result.json.recommended against this set.
    liveCommands = [...getLiveCommandTokens()];
  });

  test('runs every step of the greenfield-happy-path scenario clean', () => {
    const scenarioPath = path.join(__dirname, 'qa', 'scenarios', 'greenfield-happy-path.json');
    const scenario = loadScenario(scenarioPath);
    const report = runScenario(scenario, { LoopWalk, runOracles, liveCommands });

    assert.strictEqual(report.steps.length, scenario.steps.length);
    for (const step of report.steps) {
      assert.deepStrictEqual(step.expectFailures, []);
      assert.deepStrictEqual(step.oracleFailures, []);
    }
    assert.strictEqual(report.ok, true);

    // Anti-vacuity: a QA harness that reports NOTHING on a first real walk
    // against the actual CLI is far more likely to be mis-specified (oracles
    // that never fire, a wiring bug that drops ctx fields, a scenario that
    // never exercises the paths that produce smells) than the engine is
    // genuinely flawless. "Found nothing" is itself a failure signal for a
    // harness whose whole job is to keep known trade-offs visible, so the
    // walk must be able to speak at least once. Deliberately NOT asserting an
    // exact smell count or exact oracle ids here — that would pin today's
    // engine behavior into the test and defeat the point of a smell channel
    // that is allowed to evolve without becoming a build break.
    const totalSmells = report.steps.reduce((sum, step) => sum + step.smells.length, 0);
    assert.ok(totalSmells > 0, 'expected the greenfield walk to surface at least one smell');
    assert.ok(report.smellSummary.length > 0, 'expected a non-empty smellSummary');
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

  test('every discovered perturbation scenario applies its mutation and runs to completion without a harness crash', () => {
    const liveCommands = [...getLiveCommandTokens()];
    const perturbationFiles = discoverScenarioFiles().filter((p) => path.basename(p).startsWith('perturbation-'));
    assert.ok(perturbationFiles.length >= 3, 'expected at least the crlf, truncated-frontmatter, and delete-artifact scenarios');

    // Anti-vacuity for perturbations specifically: a mutation that changes
    // nothing observable in ANY scenario is indistinguishable from a
    // mutation that was never applied (see `scenario.cjs`'s
    // `mutationObserved` computation). At least one mutated step across the
    // whole perturbation set must show a genuinely different result from its
    // own clean baseline — if none ever does, that is a finding about which
    // engine surfaces are sensitive to corruption, not something to paper
    // over by weakening this assertion.
    let anyMutationObserved = false;

    for (const file of perturbationFiles) {
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
});

describe('wiring self-test (anti-vacuity)', () => {
  test('the self-test scenario proves the expect/oracle assertion machinery actually fires', () => {
    const liveCommands = [...getLiveCommandTokens()];
    const report = assertWiringIsLive({ LoopWalk, runOracles, liveCommands });
    assert.strictEqual(report.ok, false);
    assert.ok(report.steps.some((s) => s.expectFailures.length > 0));
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
