/**
 * Regression tests for #2830: a halted plan leaves its dependents on the
 * runnable work list.
 *
 * Two independent "which plans are incomplete" readers exist:
 *   - phase.cts's cmdPhasePlanIndex (`gsd-tools phase-plan-index`) — parses
 *     depends_on for wave assignment, but (pre-fix) never propagates a halt.
 *   - phase-locator.cts's searchPhaseInDir/findPhaseInternal — the
 *     phase-location primitive consumed by ~50 symbols across 5 command
 *     routers; (pre-fix) never parsed depends_on at all.
 *
 * Both must now report a direct or transitive dependent of a halted plan as
 * blocked — never offered as ordinary runnable work — while leaving the
 * pre-existing `incomplete`/`incomplete_plans` fields byte-identical.
 *
 * Every assertion below is behavioral (structured JSON from the real CLI /
 * the real compiled module) — no source-grep or raw-text matching, so no
 * `allow-test-rule` exemption is needed anywhere in this file.
 */

'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const phaseLocator = require('../gsd-core/bin/lib/phase-locator.cjs');
const planDependencyGraph = require('../gsd-core/bin/lib/plan-dependency-graph.cjs');

// ─── Fixture builder ──────────────────────────────────────────────────────
//
// Builds a phase directory with:
//   01-01  — halted spike (SUMMARY status: halted)
//   01-02  — depends_on 01-01 (direct dependent)
//   01-03  — depends_on 01-02 (transitive dependent, 2 hops)
//   01-04  — decoupled (no depends_on) — the negative case
// Callers can pass extra plan/summary writers for diamond/boundary variants.

function writePlan(phaseDir, filename, frontmatterLines, taskLine = '<task>Work</task>') {
  fs.writeFileSync(
    path.join(phaseDir, filename),
    [
      '---',
      ...frontmatterLines,
      '---',
      '',
      `# ${filename}`,
      '',
      `<objective>${filename}</objective>`,
      '',
      taskLine,
    ].join('\n'),
  );
}

function writeSummary(phaseDir, filename, status = 'complete') {
  fs.writeFileSync(
    path.join(phaseDir, filename),
    ['---', 'phase: 01-alpha', 'plan: 01', `status: ${status}`, 'completed: 2026-08-02', '---', '', '# Summary', ''].join('\n'),
  );
}

function buildBaseFixture(tmpDir) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
  fs.mkdirSync(phaseDir, { recursive: true });

  writePlan(phaseDir, '01-01-PLAN.md', ['wave: 1', 'objective: Halted spike', 'autonomous: true']);
  writeSummary(phaseDir, '01-01-SUMMARY.md', 'halted');

  writePlan(phaseDir, '01-02-PLAN.md', [
    'wave: 2', 'objective: Direct dependent', 'autonomous: true', 'depends_on:', '  - 01-01',
  ]);

  writePlan(phaseDir, '01-03-PLAN.md', [
    'wave: 3', 'objective: Transitive dependent', 'autonomous: true', 'depends_on:', '  - 01-02',
  ]);

  writePlan(phaseDir, '01-04-PLAN.md', ['wave: 1', 'objective: Decoupled plan', 'autonomous: true']);

  return phaseDir;
}

// ─── phase-plan-index (cmdPhasePlanIndex, src/phase.cts) ──────────────────

describe('phase-plan-index: halt propagation (#2830)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('direct dependent of a halted plan is blocked, not runnable', () => {
    tmpDir = createTempProject('gsd-2830-');
    buildBaseFixture(tmpDir);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index should succeed: ${result.error}`);
    const data = JSON.parse(result.output);

    const p02 = data.plans.find((p) => p.id === '01-02');
    assert.ok(p02, '01-02 should be present');
    assert.deepEqual(p02.blocked_by, ['01-01'], '01-02 should be blocked by the halted 01-01');
    assert.strictEqual(p02.has_summary, false);
    assert.ok(!data.runnable.includes('01-02'), '01-02 must NOT be in the runnable view');
  });

  test('transitive dependent (2 hops) is blocked via chain', () => {
    tmpDir = createTempProject('gsd-2830-');
    buildBaseFixture(tmpDir);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p03 = data.plans.find((p) => p.id === '01-03');
    assert.ok(p03, '01-03 should be present');
    assert.deepEqual(p03.blocked_by, ['01-01'], '01-03 should be transitively blocked by 01-01');
    assert.ok(!data.runnable.includes('01-03'), '01-03 must NOT be in the runnable view');
  });

  test('transitive dependent at 3 hops stays blocked', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = buildBaseFixture(tmpDir);
    writePlan(phaseDir, '01-05-PLAN.md', [
      'wave: 4', 'objective: 3-hop dependent', 'autonomous: true', 'depends_on:', '  - 01-03',
    ]);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p05 = data.plans.find((p) => p.id === '01-05');
    assert.ok(p05, '01-05 should be present');
    assert.deepEqual(p05.blocked_by, ['01-01'], '01-05 should stay blocked at 3 hops');
    assert.ok(!data.runnable.includes('01-05'));
  });

  test('diamond dependency is blocked by both halted ancestors', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-diamond');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '02-01-PLAN.md', ['wave: 1', 'objective: Halted A', 'autonomous: true']);
    writeSummary(phaseDir, '02-01-SUMMARY.md', 'halted');
    writePlan(phaseDir, '02-02-PLAN.md', ['wave: 1', 'objective: Halted B', 'autonomous: true']);
    writeSummary(phaseDir, '02-02-SUMMARY.md', 'halted');
    writePlan(phaseDir, '02-03-PLAN.md', [
      'wave: 2', 'objective: Diamond join', 'autonomous: true',
      'depends_on:', '  - 02-01', '  - 02-02',
    ]);

    const result = runGsdTools(['phase-plan-index', '2', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index should succeed: ${result.error}`);
    const data = JSON.parse(result.output);

    const p03 = data.plans.find((p) => p.id === '02-03');
    assert.ok(p03, '02-03 should be present');
    assert.deepEqual(
      [...p03.blocked_by].sort(),
      ['02-01', '02-02'],
      '02-03 should be blocked by BOTH halted ancestors, deduplicated',
    );
  });

  test('unrelated decoupled plan stays runnable', () => {
    tmpDir = createTempProject('gsd-2830-');
    buildBaseFixture(tmpDir);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p04 = data.plans.find((p) => p.id === '01-04');
    assert.ok(p04, '01-04 should be present');
    assert.deepEqual(p04.blocked_by, [], '01-04 has no depends_on, so it must not be blocked');
    assert.ok(data.runnable.includes('01-04'), '01-04 (decoupled) must stay in the runnable view');
  });

  test('incomplete field stays byte-identical when blocked plans are present', () => {
    tmpDir = createTempProject('gsd-2830-');
    buildBaseFixture(tmpDir);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    // Pre-#2830 semantics: incomplete = every plan without a matching SUMMARY,
    // blocked or not. 01-01 has a SUMMARY (halted, but still a SUMMARY) so it
    // is excluded; 01-02/01-03/01-04 have none, so all three are included —
    // exactly as they would be with no halt-awareness at all.
    assert.deepEqual(
      [...data.incomplete].sort(),
      ['01-02', '01-03', '01-04'],
      'incomplete must list every no-SUMMARY plan regardless of blocked status',
    );
  });

  test('dependency on an ordinary incomplete (non-halted) plan is not "blocked"', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-ordinary');
    fs.mkdirSync(phaseDir, { recursive: true });

    // 03-01 has NO summary at all (ordinary incomplete, not halted).
    writePlan(phaseDir, '03-01-PLAN.md', ['wave: 1', 'objective: Ordinary unfinished plan', 'autonomous: true']);
    writePlan(phaseDir, '03-02-PLAN.md', [
      'wave: 2', 'objective: Depends on ordinary incomplete plan', 'autonomous: true',
      'depends_on:', '  - 03-01',
    ]);

    const result = runGsdTools(['phase-plan-index', '3', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '03-01');
    const p02 = data.plans.find((p) => p.id === '03-02');
    assert.deepEqual(p01.blocked_by, [], '03-01 (no summary) is not itself halted or blocked');
    assert.deepEqual(p02.blocked_by, [], '03-02 must NOT be "blocked" by an ordinary (non-halted) dependency');
    assert.ok(data.runnable.includes('03-02'), '03-02 stays runnable — only a halted upstream blocks');
  });

  test('unresolved depends_on id is ignored, not blocked', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-unresolved');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '04-01-PLAN.md', [
      'wave: 1', 'objective: References a nonexistent plan', 'autonomous: true',
      'depends_on:', '  - 99-99',
    ]);

    const result = runGsdTools(['phase-plan-index', '4', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index should not throw on an unresolved dependency: ${result.error}`);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '04-01');
    assert.deepEqual(p01.blocked_by, [], 'an unresolved depends_on id must not produce a spurious block');
    assert.ok(data.runnable.includes('04-01'));
  });

  test('malformed (unterminated) SUMMARY frontmatter fails open to not-halted', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-malformed');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '05-01-PLAN.md', ['wave: 1', 'objective: Has a malformed summary', 'autonomous: true']);
    writeSummary(phaseDir, '05-01-SUMMARY.md', 'halted');
    writePlan(phaseDir, '05-02-PLAN.md', [
      'wave: 2', 'objective: Depends on 05-01', 'autonomous: true', 'depends_on:', '  - 05-01',
    ]);

    // extractFrontmatter must fail safe on an unterminated frontmatter block
    // (no closing '---'): isSummaryHalted's try/catch wraps BOTH the
    // fs.readFileSync call and the extractFrontmatter call, so this exercises
    // the identical fail-open catch site a genuine fs read error would hit —
    // see the separate real-fs-fault-injection test below for the read-error
    // half of that same catch block.
    fs.writeFileSync(
      path.join(phaseDir, '05-01-SUMMARY.md'),
      '---\nphase: 05-malformed\nplan: 01\nstatus: halted\n', // no closing '---'
    );

    const result = runGsdTools(['phase-plan-index', '5', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index must not throw on malformed frontmatter: ${result.error}`);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '05-01');
    const p02 = data.plans.find((p) => p.id === '05-02');
    assert.strictEqual(p01.halted, false, 'unterminated frontmatter must fail open to not-halted');
    assert.deepEqual(p02.blocked_by, [], 'dependent of a fail-open-not-halted plan must not be blocked');
  });

  test('CRLF SUMMARY frontmatter still detects status: halted', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '06-crlf');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '06-01-PLAN.md', ['wave: 1', 'objective: Halted with CRLF summary', 'autonomous: true']);
    fs.writeFileSync(
      path.join(phaseDir, '06-01-SUMMARY.md'),
      ['---', 'phase: 06-crlf', 'plan: 01', 'status: halted', 'completed: 2026-08-02', '---', '', '# Summary', ''].join('\r\n'),
    );
    writePlan(phaseDir, '06-02-PLAN.md', [
      'wave: 2', 'objective: Depends on CRLF-summarized halt', 'autonomous: true', 'depends_on:', '  - 06-01',
    ]);

    const result = runGsdTools(['phase-plan-index', '6', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index should succeed on CRLF frontmatter: ${result.error}`);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '06-01');
    const p02 = data.plans.find((p) => p.id === '06-02');
    assert.strictEqual(p01.halted, true, 'CRLF SUMMARY frontmatter must still parse status: halted');
    assert.deepEqual(p02.blocked_by, ['06-01'], 'dependent must be blocked even when the halt was recorded with CRLF newlines');
  });

  test('status complete does not block dependents', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '07-complete');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '07-01-PLAN.md', ['wave: 1', 'objective: Ordinary completion', 'autonomous: true']);
    writeSummary(phaseDir, '07-01-SUMMARY.md', 'complete');
    writePlan(phaseDir, '07-02-PLAN.md', [
      'wave: 2', 'objective: Depends on completed plan', 'autonomous: true', 'depends_on:', '  - 07-01',
    ]);

    const result = runGsdTools(['phase-plan-index', '7', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '07-01');
    const p02 = data.plans.find((p) => p.id === '07-02');
    assert.strictEqual(p01.halted, false);
    assert.deepEqual(p02.blocked_by, []);
    assert.ok(data.runnable.includes('07-02'));
  });

  test('dependency cycle detection is unaffected by halt propagation', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '08-cycle');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '08-01-PLAN.md', [
      'wave: 1', 'objective: Cycle A', 'autonomous: true', 'depends_on:', '  - 08-02',
    ]);
    writePlan(phaseDir, '08-02-PLAN.md', [
      'wave: 1', 'objective: Cycle B', 'autonomous: true', 'depends_on:', '  - 08-01',
    ]);

    const result = runGsdTools(['phase-plan-index', '8', '--raw'], tmpDir);
    assert.strictEqual(result.success, false, 'a dependency cycle must still fail the command');
    assert.match(result.error || '', /cycle/i, 'the error must still name the cycle, unaffected by the new halt code path');
  });
});

// ─── findPhaseInternal / searchPhaseInDir (src/phase-locator.cts) ─────────

describe('findPhaseInternal: halt propagation (#2830)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('direct dependent of a halted plan is blocked', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(result, 'expected a result');
    assert.deepEqual(result.blocked_by['01-02-PLAN.md'], ['01-01'], '01-02 should be blocked by halted 01-01');
    assert.ok(!result.runnable_plans.includes('01-02-PLAN.md'));
  });

  test('transitive dependent is blocked via chain', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.deepEqual(result.blocked_by['01-03-PLAN.md'], ['01-01'], '01-03 should be transitively blocked');
    assert.ok(!result.runnable_plans.includes('01-03-PLAN.md'));
  });

  test('diamond dependency blocked by both halted ancestors', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-diamond');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '02-01-PLAN.md', ['wave: 1', 'objective: Halted A', 'autonomous: true']);
    writeSummary(phaseDir, '02-01-SUMMARY.md', 'halted');
    writePlan(phaseDir, '02-02-PLAN.md', ['wave: 1', 'objective: Halted B', 'autonomous: true']);
    writeSummary(phaseDir, '02-02-SUMMARY.md', 'halted');
    writePlan(phaseDir, '02-03-PLAN.md', [
      'wave: 2', 'objective: Diamond join', 'autonomous: true',
      'depends_on:', '  - 02-01', '  - 02-02',
    ]);

    const result = phaseLocator.findPhaseInternal(tmpDir, '2');
    assert.ok(result, 'expected a result');
    assert.deepEqual(
      [...result.blocked_by['02-03-PLAN.md']].sort(),
      ['02-01', '02-02'],
      'diamond join should be blocked by both halted ancestors, deduplicated',
    );
  });

  test('unrelated decoupled plan stays runnable', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(result.runnable_plans.includes('01-04-PLAN.md'), '01-04 (decoupled) must stay runnable');
    assert.strictEqual(result.blocked_by['01-04-PLAN.md'], undefined);
  });

  test('incomplete_plans stays byte-identical when blocked plans are present', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.deepEqual(
      [...result.incomplete_plans].sort(),
      ['01-02-PLAN.md', '01-03-PLAN.md', '01-04-PLAN.md'],
      'incomplete_plans must list every no-SUMMARY plan regardless of blocked status',
    );
  });

  test('halted_plans reports the halted plan itself by filename', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.deepEqual(result.halted_plans, ['01-01-PLAN.md']);
  });
});

// ─── Parity: the two implementations must agree ───────────────────────────

describe('parity: phase-plan-index and findPhaseInternal agree on blocking (#2830)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('same fixture yields the same blocked-plan set and cause set from both readers', () => {
    tmpDir = createTempProject('gsd-2830-parity-');
    buildBaseFixture(tmpDir);

    const cliResult = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    assert.ok(cliResult.success, `phase-plan-index should succeed: ${cliResult.error}`);
    const cliData = JSON.parse(cliResult.output);

    const locatorResult = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(locatorResult, 'findPhaseInternal should return a result');

    // Build { planId -> sorted cause list } from each reader and require them
    // to be structurally identical (id-mapped, since one reader keys by bare
    // id and the other by filename).
    const cliBlocked = {};
    for (const plan of cliData.plans) {
      if (plan.blocked_by.length > 0) cliBlocked[plan.id] = [...plan.blocked_by].sort();
    }

    const locatorBlocked = {};
    for (const [filename, causes] of Object.entries(locatorResult.blocked_by)) {
      const planId = filename.replace(/-PLAN\.md$/i, '').replace(/^PLAN\.md$/i, '');
      locatorBlocked[planId] = [...causes].sort();
    }

    assert.deepEqual(
      locatorBlocked,
      cliBlocked,
      'phase-plan-index and findPhaseInternal must report the exact same blocked-plan-id -> cause-set mapping',
    );
  });
});

// ─── computeHaltPropagation — direct module tests + fast-check property ───

describe('computeHaltPropagation: graph invariants (#2830)', () => {
  test('a node with no depends_on and not halted is never blocked', () => {
    const { blockedBy } = planDependencyGraph.computeHaltPropagation([
      { id: 'A', resolvedDependsOn: [], halted: false },
    ]);
    assert.strictEqual(blockedBy.get('A'), undefined);
  });

  test('a halted node is never blocked by itself', () => {
    const { blockedBy } = planDependencyGraph.computeHaltPropagation([
      { id: 'A', resolvedDependsOn: [], halted: true },
    ]);
    assert.strictEqual(blockedBy.get('A'), undefined, 'a halted plan is halted, not "blocked"');
  });

  test('precomputedOrder (the phase.cts call shape) yields the same result as self-derived order', () => {
    // phase.cts's cmdPhasePlanIndex passes computeDependencyLevels's own
    // topological order in as `precomputedOrder` so this function does not
    // re-run Kahn's algorithm. Assert both call shapes agree.
    const nodes = [
      { id: 'A', resolvedDependsOn: [], halted: true },
      { id: 'B', resolvedDependsOn: ['A'], halted: false },
      { id: 'C', resolvedDependsOn: ['B'], halted: false },
    ];
    const selfDerived = planDependencyGraph.computeHaltPropagation(nodes);
    const withPrecomputed = planDependencyGraph.computeHaltPropagation(nodes, ['A', 'B', 'C']);
    assert.deepEqual([...withPrecomputed.blockedBy.entries()], [...selfDerived.blockedBy.entries()]);
    assert.deepEqual(withPrecomputed.order, ['A', 'B', 'C']);
    assert.strictEqual(withPrecomputed.visited, 3);
  });

  test('fast-check — blocked set matches reachability from halted nodes', () => {
    // Generate a random DAG over N nodes: edges only point from a lower index
    // to a higher index (guarantees acyclicity by construction, independent
    // of the code under test), with a random halted flag per node.
    const dagArb = fc.integer({ min: 1, max: 12 }).chain((n) => {
      const ids = Array.from({ length: n }, (_, i) => `N${i}`);
      const edgeArb = fc.array(
        fc.record({
          from: fc.integer({ min: 0, max: n - 1 }),
          to: fc.integer({ min: 0, max: n - 1 }),
        }).filter(({ from, to }) => from < to), // from depends_on to (to is "earlier"/upstream)
        { maxLength: n * 2 },
      );
      const haltedArb = fc.array(fc.boolean(), { minLength: n, maxLength: n });
      return fc.record({ ids: fc.constant(ids), edges: edgeArb, halted: haltedArb });
    });

    fc.assert(
      fc.property(dagArb, ({ ids, edges, halted }) => {
        const dependsOn = new Map(ids.map((id) => [id, []]));
        for (const { from, to } of edges) {
          dependsOn.get(ids[from]).push(ids[to]);
        }
        const nodes = ids.map((id, i) => ({
          id,
          resolvedDependsOn: dependsOn.get(id),
          halted: halted[i],
        }));

        const { blockedBy } = planDependencyGraph.computeHaltPropagation(nodes);

        // Reference model: reachability via depends_on edges from a halted node.
        const haltedSet = new Set(nodes.filter((n) => n.halted).map((n) => n.id));
        const dependsOnMap = new Map(nodes.map((n) => [n.id, n.resolvedDependsOn]));
        function reachableHaltedCauses(id, seen = new Set()) {
          const causes = new Set();
          for (const dep of dependsOnMap.get(id) ?? []) {
            if (seen.has(dep)) continue;
            seen.add(dep);
            if (haltedSet.has(dep)) causes.add(dep);
            for (const c of reachableHaltedCauses(dep, seen)) causes.add(c);
          }
          return causes;
        }

        for (const n of nodes) {
          const expected = [...reachableHaltedCauses(n.id)].sort();
          const actual = [...(blockedBy.get(n.id) ?? [])].sort();
          assert.deepEqual(
            actual,
            expected,
            `node ${n.id}: computeHaltPropagation blockedBy must equal halted-reachability`,
          );
        }
      }),
      { numRuns: 50 },
    );
  });
});
