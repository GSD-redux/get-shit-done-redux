// Tests for the extracted computeDependencyLevels pure function in phase.cjs.
// Covers correctness (behavior) and edge cases. The O(V+E) complexity contract
// is documented inline in computeDependencyLevels (phase.cjs) above the head-index
// queue loop; timing-based guards were removed (#307) because the O(V+E)
// Map-build constant dilutes the O(V^2) signal until N is ~1e6, making
// empirical ratio tests inherently flaky on contended CI runners.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeDependencyLevels } = require('../gsd-core/bin/lib/phase.cjs');

// Helper: build rawPlans + planMap + canonicalToId from a simple spec.
// spec is an array of { id, dependsOn } objects.
function buildInputs(spec) {
  const rawPlans = spec.map(s => ({ id: s.id, dependsOn: s.dependsOn ?? [] }));
  const planMap = new Map(rawPlans.map(p => [p.id.toLowerCase(), p]));
  const canonicalToId = new Map(rawPlans.map(p => [p.id.toLowerCase(), p.id]));
  return { rawPlans, planMap, canonicalToId };
}

describe('computeDependencyLevels — behavior tests', () => {

  // (a) Linear chain: 0 ← 1 ← 2  (1 depends on 0, 2 depends on 1)
  test('(a) linear chain assigns levels 0,1,2 and visits all nodes', () => {
    const { rawPlans, planMap, canonicalToId } = buildInputs([
      { id: 'p0', dependsOn: [] },
      { id: 'p1', dependsOn: ['p0'] },
      { id: 'p2', dependsOn: ['p1'] },
    ]);
    const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);
    assert.equal(visited, 3);
    assert.equal(level.get('p0'), 0);
    assert.equal(level.get('p1'), 1);
    assert.equal(level.get('p2'), 2);
  });

  // (b) Diamond: A; B,C depend on A; D depends on B and C → longest-path levels
  // A=0, B=1, C=1, D=2
  test('(b) diamond uses longest-path (D=2, not 1)', () => {
    const { rawPlans, planMap, canonicalToId } = buildInputs([
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
      { id: 'D', dependsOn: ['B', 'C'] },
    ]);
    const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);
    assert.equal(visited, 4);
    assert.equal(level.get('A'), 0);
    assert.equal(level.get('B'), 1);
    assert.equal(level.get('C'), 1);
    assert.equal(level.get('D'), 2);
  });

  // (c) Independent set: no deps → all level 0
  test('(c) independent set: all nodes at level 0, all visited', () => {
    const N = 10;
    const spec = Array.from({ length: N }, (_, i) => ({ id: `node-${i}`, dependsOn: [] }));
    const { rawPlans, planMap, canonicalToId } = buildInputs(spec);
    const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);
    assert.equal(visited, N);
    for (let i = 0; i < N; i++) {
      assert.equal(level.get(`node-${i}`), 0, `node-${i} should be level 0`);
    }
  });

  // (d) Cycle: A depends on B and B depends on A → visited < N
  test('(d) cycle: visited < N signals cycle (not all nodes reachable)', () => {
    const { rawPlans, planMap, canonicalToId } = buildInputs([
      { id: 'A', dependsOn: ['B'] },
      { id: 'B', dependsOn: ['A'] },
    ]);
    const { visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);
    assert.ok(visited < rawPlans.length, `expected visited < 2, got ${visited}`);
  });

  // (e) Prefix resolution via canonicalToId: dep given as canonical prefix resolves
  // to the full plan ID. Mirrors the #3785 behavior.
  test('(e) canonical prefix resolution (depends_on short form resolves via canonicalToId)', () => {
    // Plan with full stem ID; dep references canonical prefix only
    const rawPlans = [
      { id: '03-01-auth-hardening', dependsOn: [] },
      { id: '03-02-token-rotation', dependsOn: ['03-01'] }, // short prefix dep
    ];
    // planMap uses full-stem lowercase keys (planMap.get('03-01') would miss)
    const planMap = new Map(rawPlans.map(p => [p.id.toLowerCase(), p]));
    // canonicalToId maps prefix → full ID
    const canonicalToId = new Map([
      ['03-01', '03-01-auth-hardening'],
      ['03-02', '03-02-token-rotation'],
    ]);
    const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);
    assert.equal(visited, 2, 'both plans should be visited (no cycle)');
    assert.equal(level.get('03-01-auth-hardening'), 0);
    assert.equal(level.get('03-02-token-rotation'), 1, 'prefix dep resolved → level 1');
  });

  // (f) EMPTY: no plans → level.size === 0 and visited === 0, no throw.
  test('(f) empty rawPlans: returns empty level map and visited === 0', () => {
    const { level, visited } = computeDependencyLevels([], new Map(), new Map());
    assert.equal(level.size, 0, 'level map should be empty');
    assert.equal(visited, 0, 'visited should be 0 with no plans');
  });

  // (g) SELF-LOOP: a plan whose dependsOn includes its own id → in-degree is never
  // decremented to 0 → the plan is never enqueued → visited === 0 (cycle signalled).
  // Self-dep: inDeg starts at 0, then gets +1 for the self-edge → inDeg = 1 forever.
  test('(g) self-loop: plan is never enqueued, visited === 0 (cycle signalled)', () => {
    const { rawPlans, planMap, canonicalToId } = buildInputs([
      { id: 'solo', dependsOn: ['solo'] },
    ]);
    const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);
    assert.equal(visited, 0, 'self-loop plan should never be visited');
    assert.ok(visited < rawPlans.length, 'visited < rawPlans.length signals cycle');
    assert.ok(!level.has('solo'), 'self-loop plan should not appear in level map');
  });

  // (h) DUPLICATE EDGE: plan B lists the same dep A twice.
  // Effect: inDeg(B) = 2 (double-counted), adj(A) = ['B', 'B'] (double-pushed).
  // When A is processed (curLevel=0):
  //   First 'B': inDeg(B) → 1, level(B) set to 1 (not pushed yet).
  //   Second 'B': inDeg(B) → 0, level(B) stays 1 (already set), B pushed.
  // Result: visited === 2, level(A) === 0, level(B) === 1.
  // This documents the existing behavior: duplicate deps double-count in-degree and
  // double-push the adjacency list, but the final level/visited result is still correct
  // because each decrement pairs with a push.
  test('(h) duplicate edge: B lists dep A twice → visited === 2, levels A=0 B=1', () => {
    const { rawPlans, planMap, canonicalToId } = buildInputs([
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A', 'A'] }, // duplicate dep
    ]);
    const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);
    assert.equal(visited, 2, 'both A and B should be visited');
    assert.equal(level.get('A'), 0, 'A has no deps → level 0');
    assert.equal(level.get('B'), 1, 'B depends on A → level 1');
  });

  // (i) EXTERNAL/UNRESOLVED DEP: plan B lists a dep that is neither in planMap nor in
  // canonicalToId → the dep is ignored (continue), B retains in-degree 0 → B is level 0.
  // Both A and B have in-degree 0 and are visited → visited === 2.
  test('(i) unresolved/external dep is ignored: B still enqueued at level 0', () => {
    const { rawPlans, planMap, canonicalToId } = buildInputs([
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['nonexistent-external-plan'] },
    ]);
    const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);
    assert.equal(visited, 2, 'both plans should be visited (external dep ignored)');
    assert.equal(level.get('A'), 0, 'A has no deps → level 0');
    assert.equal(level.get('B'), 0, 'B external dep ignored → in-degree 0 → level 0');
  });

});
