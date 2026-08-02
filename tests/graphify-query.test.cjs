'use strict';

// Tests for graphify.cjs — query describe block.
// Split from the consolidated 2336-LOC file. Refs #3761.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTempProject, cleanup } = require('./helpers.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  graphifyQuery,
  graphifyStatus,
  graphifyDiff,
  safeReadJson,
  buildAdjacencyMap,
  seedAndExpand,
  applyBudget,
} = require('../gsd-core/bin/lib/graphify.cjs');

// The emitter itself, not a local re-implementation of it — the whole point of
// the #2738 budget-outcome pin below is that these two must never drift.
const { serializeForOutput } = require('../gsd-core/bin/lib/io.cjs');

/** Tokens of a response as `output()` actually emits it. */
const emittedTokens = (result) => Math.ceil(serializeForOutput(result).length / 4);

const {
  enableGraphify,
  writeGraphJson,
  writeSnapshotJson,
  SAMPLE_GRAPH,
} = require('./helpers/graphify.cjs');

// ─── Shared fixture: surfaced-config-dir ─────────────────────────────────────
//
// Positive-path tests (graphifyQuery, graphifyDiff, graceful-degradation) call
// enableGraphify() (config leg only) and assert non-disabled outcomes. With
// the tri-state gate (isCapabilityActive), those outcomes ALSO require graphify
// to be installed+surfaced in the runtime config dir. Without this fixture the
// tests are ambient-dependent: they pass only on machines where the ambient
// ~/.claude has graphify surfaced.
//
// Fix: before each positive-path test, point CLAUDE_CONFIG_DIR at a tmp dir
// with a full-profile .gsd-surface.json (graphify surfaced), and clear
// GSD_RUNTIME / GSD_WORKSTREAM / GSD_PROJECT for hermeticity.

/** Create a tmp config dir with graphify surfaced (full profile, no disabled clusters). */
function makeSurfacedConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-graphify-qry-cfg-'));
  fs.writeFileSync(
    path.join(dir, '.gsd-surface.json'),
    JSON.stringify({ baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] }, null, 2) + '\n',
    'utf8',
  );
  return dir;
}

/**
 * Save the env vars the surfaced-config fixture overrides.
 * Returns an object whose .restore() returns env to its original state.
 */
function saveSurfacedEnv() {
  const saved = {
    GSD_RUNTIME: process.env.GSD_RUNTIME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    GSD_WORKSTREAM: process.env.GSD_WORKSTREAM,
    GSD_PROJECT: process.env.GSD_PROJECT,
  };
  return {
    restore() {
      if (saved.GSD_RUNTIME === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = saved.GSD_RUNTIME;
      if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
      if (saved.GSD_WORKSTREAM === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = saved.GSD_WORKSTREAM;
      if (saved.GSD_PROJECT === undefined) delete process.env.GSD_PROJECT;
      else process.env.GSD_PROJECT = saved.GSD_PROJECT;
    },
  };
}

// ─── query describe ───────────────────────────────────────────────────────────

describe('query', () => {
  describe('safeReadJson', () => {
    let tmpDir;
    let planningDir;

    beforeEach(() => {
      tmpDir = createTempProject();
      planningDir = path.join(tmpDir, '.planning');
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('returns parsed object for valid JSON file', () => {
      const filePath = path.join(planningDir, 'test.json');
      const data = { foo: 'bar', num: 42 };
      fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
      const result = safeReadJson(filePath);
      assert.deepStrictEqual(result, data);
    });

    test('returns null for malformed JSON', () => {
      const filePath = path.join(planningDir, 'bad.json');
      fs.writeFileSync(filePath, 'not json', 'utf8');
      const result = safeReadJson(filePath);
      assert.strictEqual(result, null);
    });

    test('returns null for non-existent file', () => {
      const result = safeReadJson(path.join(planningDir, 'does-not-exist.json'));
      assert.strictEqual(result, null);
    });
  });

  describe('buildAdjacencyMap', () => {
    test('creates bidirectional adjacency entries', () => {
      const adj = buildAdjacencyMap(SAMPLE_GRAPH);
      // n1 -> n2 edge exists, so adj['n1'] should have target n2 AND adj['n2'] should have target n1
      assert.ok(adj['n1'].some(e => e.target === 'n2'));
      assert.ok(adj['n2'].some(e => e.target === 'n1'));
    });

    test('initializes empty arrays for nodes without edges', () => {
      const graph = {
        nodes: [
          ...SAMPLE_GRAPH.nodes,
          { id: 'n99', label: 'Orphan', description: 'No edges', type: 'orphan' },
        ],
        edges: SAMPLE_GRAPH.edges,
      };
      const adj = buildAdjacencyMap(graph);
      assert.ok(Array.isArray(adj['n99']));
      assert.strictEqual(adj['n99'].length, 0);
    });

    test('stores full edge object in adjacency entries', () => {
      const adj = buildAdjacencyMap(SAMPLE_GRAPH);
      const entry = adj['n1'].find(e => e.target === 'n2');
      assert.ok(entry);
      assert.strictEqual(entry.edge.label, 'reads_from');
      assert.strictEqual(entry.edge.confidence, 'EXTRACTED');
    });

    // LINKS-01: graphify emits 'links' key; reader must fall back to it
    test('falls back to graph.links when graph.edges is absent (LINKS-01)', () => {
      const graphWithLinks = {
        nodes: SAMPLE_GRAPH.nodes,
        links: SAMPLE_GRAPH.edges,
      };
      const adj = buildAdjacencyMap(graphWithLinks);
      assert.ok(adj['n1'].some(e => e.target === 'n2'), 'adjacency must traverse links');
      assert.ok(adj['n2'].some(e => e.target === 'n1'), 'reverse adjacency must work');
    });
  });

  describe('seedAndExpand', () => {
    test('finds seed nodes by label match (case-insensitive)', () => {
      const result = seedAndExpand(SAMPLE_GRAPH, 'auth');
      assert.ok(result.seeds.has('n1'), 'AuthService should be a seed');
      assert.ok(result.nodes.some(n => n.id === 'n1'));
    });

    test('finds seed nodes by description match', () => {
      const result = seedAndExpand(SAMPLE_GRAPH, 'credentials');
      assert.ok(result.seeds.has('n2'), 'UserModel description contains credentials');
      assert.ok(result.nodes.some(n => n.id === 'n2'));
    });

    test('BFS expands 1-2 hops from seeds', () => {
      // 'auth' matches n1 (label: AuthService) and n2 (description: authentication)
      // n1 seeds: 1-hop -> n2, n3; 2-hop -> n4 (via n3->n4)
      // n5 is 3 hops from n1 (n1->n3->n4->n5) so should NOT appear
      const result = seedAndExpand(SAMPLE_GRAPH, 'auth');
      const nodeIds = result.nodes.map(n => n.id);
      assert.ok(nodeIds.includes('n1'), 'seed n1');
      assert.ok(nodeIds.includes('n2'), '1-hop from n1');
      assert.ok(nodeIds.includes('n3'), '1-hop from n1');
      assert.ok(nodeIds.includes('n4'), '2-hop from n3');
      // n5 is reachable only at 3 hops from n1 seeds, but n2 is also a seed
      // (description contains "authentication"), and n2->n3->n4->n5 is also 3 hops
      // So n5 should NOT be in results with maxHops=2
      assert.ok(!nodeIds.includes('n5'), 'n5 should be beyond 2 hops');
    });

    test('returns empty results for no matches', () => {
      const result = seedAndExpand(SAMPLE_GRAPH, 'nonexistent');
      assert.strictEqual(result.nodes.length, 0);
      assert.strictEqual(result.edges.length, 0);
      assert.strictEqual(result.seeds.size, 0);
    });

    test('respects maxHops parameter', () => {
      const result = seedAndExpand(SAMPLE_GRAPH, 'auth', 1);
      const nodeIds = result.nodes.map(n => n.id);
      assert.ok(nodeIds.includes('n1'), 'seed');
      assert.ok(nodeIds.includes('n2'), '1-hop');
      assert.ok(nodeIds.includes('n3'), '1-hop');
      assert.ok(!nodeIds.includes('n4'), 'n4 is 2 hops away');
    });
  });

  describe('applyBudget', () => {
    test('returns result unchanged when no budget', () => {
      const input = { nodes: SAMPLE_GRAPH.nodes, edges: SAMPLE_GRAPH.edges, seeds: new Set(['n1']) };
      const result = applyBudget(input, null);
      assert.strictEqual(result.nodes, input.nodes);
      assert.strictEqual(result.edges, input.edges);
    });

    test('drops AMBIGUOUS edges first when over budget', () => {
      const input = { nodes: SAMPLE_GRAPH.nodes, edges: SAMPLE_GRAPH.edges, seeds: new Set(['n1']) };
      // Set a budget small enough to trigger trimming but large enough to keep some edges
      // The full graph serialized is ~600+ chars = ~150+ tokens. Use a small budget.
      const result = applyBudget(input, 50);
      const confidences = result.edges.map(e => e.confidence);
      assert.ok(!confidences.includes('AMBIGUOUS'), 'AMBIGUOUS edges should be dropped first');
    });

    test('drops INFERRED edges after AMBIGUOUS', () => {
      const input = { nodes: SAMPLE_GRAPH.nodes, edges: SAMPLE_GRAPH.edges, seeds: new Set(['n1']) };
      // Very tight budget to force dropping both AMBIGUOUS and INFERRED
      const result = applyBudget(input, 10);
      const confidences = result.edges.map(e => e.confidence);
      assert.ok(!confidences.includes('AMBIGUOUS'), 'AMBIGUOUS removed');
      assert.ok(!confidences.includes('INFERRED'), 'INFERRED removed');
      // Only EXTRACTED should remain (if any)
      for (const c of confidences) {
        assert.strictEqual(c, 'EXTRACTED');
      }
    });

    test('appends trimmed footer with counts', () => {
      const input = { nodes: SAMPLE_GRAPH.nodes, edges: SAMPLE_GRAPH.edges, seeds: new Set(['n1']) };
      const result = applyBudget(input, 10);
      assert.ok(result.trimmed !== null, 'trimmed should not be null');
      assert.ok(/\d+ edges omitted/.test(result.trimmed), 'trimmed contains edge count');
      assert.ok(/\d+ nodes unreachable/.test(result.trimmed), 'trimmed contains node count');
    });

    // #2738: seeds are an unconditional floor, so an unmeetable budget must be
    // reported as a miss instead of silently returning the seed-set payload.
    test('reports budget_met=false and budget_estimate when the seed floor blocks the budget (#2738)', () => {
      const input = { nodes: SAMPLE_GRAPH.nodes, edges: SAMPLE_GRAPH.edges, seeds: new Set(['n1']) };
      const result = applyBudget(input, 1);
      assert.strictEqual(result.budget_met, false, 'budget cannot be met below the seed floor');
      assert.strictEqual(typeof result.budget_estimate, 'number');
      assert.ok(result.budget_estimate > 1, 'estimate reflects the actual returned payload');
    });

    test('reports budget_met=true when the result fits the budget (#2738)', () => {
      const input = { nodes: SAMPLE_GRAPH.nodes, edges: SAMPLE_GRAPH.edges, seeds: new Set(['n1']) };
      const result = applyBudget(input, 100000);
      assert.strictEqual(result.budget_met, true);
      assert.ok(result.budget_estimate <= 100000);
    });

    // #2738 secondary defect: the tier loop estimated against the full pre-filter
    // node set, so a tier removal that already satisfied the budget (once its
    // orphaned nodes are excluded) still triggered the next, higher-confidence
    // tier drop. The INFERRED edge here must survive: dropping AMBIGUOUS orphans
    // the heavy nodes and the pruned result fits.
    test('stops dropping tiers once the post-pruning result fits (#2738)', () => {
      const heavy = 'x'.repeat(400);
      const nodes = [
        { id: 's', label: 'Seed', description: 'seed node', type: 'service' },
        { id: 'k', label: 'Kept', description: 'small neighbor', type: 'service' },
        ...Array.from({ length: 10 }, (_, i) => (
          { id: `h${i}`, label: `Heavy${i}`, description: heavy, type: 'service' }
        )),
      ];
      const edges = [
        { source: 's', target: 'k', label: 'links', confidence: 'INFERRED' },
        ...Array.from({ length: 10 }, (_, i) => (
          { source: 's', target: `h${i}`, label: 'links', confidence: 'AMBIGUOUS' }
        )),
      ];
      const result = applyBudget({ nodes, edges, seeds: new Set(['s']) }, 200);
      assert.ok(
        result.edges.some(e => e.confidence === 'INFERRED'),
        'INFERRED edge survives: dropping AMBIGUOUS already satisfied the budget',
      );
      assert.strictEqual(result.budget_met, true);
    });

    // #2738: --budget 0 is a valid parsed budget the CLI forwards; truthiness
    // treated it as "no budget" and silently returned the unbounded result.
    test('honors a budget of 0 instead of treating it as no budget (#2738)', () => {
      const input = { nodes: SAMPLE_GRAPH.nodes, edges: SAMPLE_GRAPH.edges, seeds: new Set(['n1']) };
      const result = applyBudget(input, 0);
      assert.ok('budget_met' in result, 'budget 0 goes through the budget path');
      assert.strictEqual(result.budget_met, false, 'a zero budget is unmeetable and reported as such');
    });
  });

  describe('graphifyQuery', () => {
    let tmpDir;
    let planningDir;
    // Surfaced-config-dir fixture: makes positive-path tests deterministic.
    // See module-level comment for rationale.
    let surfacedConfigDir;
    let savedEnv;

    beforeEach(() => {
      tmpDir = createTempProject();
      planningDir = path.join(tmpDir, '.planning');
      surfacedConfigDir = makeSurfacedConfigDir();
      savedEnv = saveSurfacedEnv();
      delete process.env.GSD_RUNTIME;
      process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
      delete process.env.GSD_WORKSTREAM;
      delete process.env.GSD_PROJECT;
    });

    afterEach(() => {
      savedEnv.restore();
      cleanup(surfacedConfigDir);
      cleanup(tmpDir);
    });

    // QUERY-01: returns disabled response when graphify not enabled
    test('returns disabled response when graphify not enabled', () => {
      const result = graphifyQuery(tmpDir, 'auth');
      assert.strictEqual(result.disabled, true);
    });

    // QUERY-01: returns error when graph.json does not exist
    test('returns error when graph.json does not exist', () => {
      enableGraphify(planningDir);
      const result = graphifyQuery(tmpDir, 'auth');
      assert.ok(result.error);
      assert.ok(result.error.includes('No graph'));
    });

    // QUERY-01: returns matching nodes and edges for valid query
    test('returns matching nodes and edges for valid query', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyQuery(tmpDir, 'auth');
      assert.ok(result.nodes.length > 0, 'should have matching nodes');
      assert.ok(result.edges.length > 0, 'should have matching edges');
      assert.strictEqual(result.term, 'auth');
    });

    // QUERY-03: includes confidence on edges
    test('includes confidence on edges (QUERY-03)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyQuery(tmpDir, 'auth');
      const validTiers = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'];
      for (const edge of result.edges) {
        assert.ok(validTiers.includes(edge.confidence), `edge confidence ${edge.confidence} is valid tier`);
      }
    });

    // QUERY-02: respects --budget option
    test('respects --budget option (QUERY-02)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyQuery(tmpDir, 'auth', { budget: 50 });
      // With a very small budget, trimming should occur
      assert.ok(result.trimmed !== null, 'trimmed should indicate budget was applied');
    });

    // #2738: budget outcome surfaces through the query response
    test('surfaces budget_met and budget_estimate when a budget was requested (#2738)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyQuery(tmpDir, 'auth', { budget: 50 });
      assert.strictEqual(typeof result.budget_met, 'boolean');
      assert.strictEqual(typeof result.budget_estimate, 'number');
    });

    // NOTE: this one passes on `next` too — before the fix graphifyQuery never
    // set these keys, so both assertions already held. It is a forward guard
    // against the spread leaking budget fields into a no-budget response, NOT
    // the failing-first regression proof for #2738; do not count it toward
    // RULESET.TESTS.regression-must-fail-first. The failing-first tests are the
    // tier-loop and budget-outcome ones above.
    test('omits budget fields when no budget was requested (#2738)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyQuery(tmpDir, 'auth');
      assert.ok(!('budget_met' in result), 'budget_met absent without --budget');
      assert.ok(!('budget_estimate' in result), 'budget_estimate absent without --budget');
    });

    // #2738 Blocker: budget_estimate must measure the payload the caller is
    // actually handed — output() pretty-prints with 2-space indent and emits the
    // wrapper keys too. Estimating a compact {nodes, edges} understated a 12-node
    // response by ~1.5x, so `--budget N` could report budget_met: true while
    // returning well over N tokens. This pins estimator to emitter so the two
    // cannot silently re-diverge if output() ever changes its indentation.
    test('budget_estimate equals the tokens actually emitted (#2738)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyQuery(tmpDir, 'auth', { budget: 100000 });
      assert.strictEqual(
        result.budget_estimate,
        emittedTokens(result),
        'reported estimate must equal the serialized-for-output token count',
      );
    });

    test('a met budget is honest about the emitted size (#2738)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const probe = graphifyQuery(tmpDir, 'auth', { budget: 100000 });
      // Budget exactly at the untrimmed size: met, and genuinely within it.
      const result = graphifyQuery(tmpDir, 'auth', { budget: probe.budget_estimate });
      assert.strictEqual(result.budget_met, true);
      assert.ok(
        emittedTokens(result) <= probe.budget_estimate,
        `emitted ${emittedTokens(result)} must not exceed the granted ${probe.budget_estimate}`,
      );
    });

    // RULESET.TESTS.boundary-coverage: the decision point is `estimate <= budget`,
    // so the inputs that matter are estimate-1 / estimate / estimate+1 — an
    // off-by-one in that comparison flips budget_met and nothing else catches it.
    test('boundary coverage around budget === estimate (#2738)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const e = graphifyQuery(tmpDir, 'auth', { budget: 100000 }).budget_estimate;

      const atLimit = graphifyQuery(tmpDir, 'auth', { budget: e });
      assert.strictEqual(atLimit.budget_met, true, 'budget === estimate is met (<=, not <)');
      assert.strictEqual(atLimit.budget_estimate, e, 'no trimming needed at the limit');

      const overLimit = graphifyQuery(tmpDir, 'auth', { budget: e + 1 });
      assert.strictEqual(overLimit.budget_met, true, 'limit+1 is met');
      assert.strictEqual(overLimit.budget_estimate, e, 'no trimming needed above the limit');

      const underLimit = graphifyQuery(tmpDir, 'auth', { budget: e - 1 });
      // limit-1 forces the loop to act; whatever it returns, the report must be
      // consistent with what it returns.
      assert.strictEqual(
        underLimit.budget_met,
        underLimit.budget_estimate <= e - 1,
        'budget_met must agree with the reported estimate at limit-1',
      );
      assert.strictEqual(underLimit.budget_estimate, emittedTokens(underLimit));
    });

    // Nit #2738: NaN must not reach the budget comparisons — every `estimate <= NaN`
    // is false, so the loop would strip all three tiers and return a seeds-only
    // payload indistinguishable from a legitimate aggressive trim. Unreachable via
    // the CLI (the router rejects non-numeric --budget), reachable module-level.
    test('a non-finite budget is treated as no budget (#2738)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      for (const budget of [NaN, Infinity, -Infinity]) {
        const result = graphifyQuery(tmpDir, 'auth', { budget });
        assert.ok(!('budget_met' in result), `budget ${budget} takes the no-budget path`);
        assert.ok(!('budget_estimate' in result), `budget ${budget} reports no estimate`);
      }
    });

    // QUERY-01: returns total_nodes and total_edges counts
    test('returns total_nodes and total_edges counts', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyQuery(tmpDir, 'auth');
      assert.strictEqual(typeof result.total_nodes, 'number');
      assert.strictEqual(typeof result.total_edges, 'number');
    });
  });

  // RULESET.TESTS.property-based-testing — applyBudget is a budget-limit
  // contract, and #2738 turns it into a *reporting* contract, which is what
  // properties express well. These hold for any graph and any budget >= 0.
  describe('graphifyQuery budget properties (#2738)', () => {
    let tmpDir;
    let planningDir;
    // Surfaced-config-dir fixture: makes positive-path tests deterministic.
    // See module-level comment for rationale.
    let surfacedConfigDir;
    let savedEnv;

    beforeEach(() => {
      tmpDir = createTempProject();
      planningDir = path.join(tmpDir, '.planning');
      surfacedConfigDir = makeSurfacedConfigDir();
      savedEnv = saveSurfacedEnv();
      delete process.env.GSD_RUNTIME;
      process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
      delete process.env.GSD_WORKSTREAM;
      delete process.env.GSD_PROJECT;
      enableGraphify(planningDir);
    });

    afterEach(() => {
      savedEnv.restore();
      cleanup(surfacedConfigDir);
      cleanup(tmpDir);
    });

    /**
     * A small arbitrary graph that always seeds on 'auth'.
     *
     * seedAndExpand matches on `label` and `description` (case-insensitive
     * substring) — NOT on `id` or `name` — so the seed node has to carry the
     * term in its label or the whole graph expands to nothing.
     */
    const arbGraph = fc
      .array(
        fc.record({
          label: fc.string({ minLength: 1, maxLength: 6 }),
          type: fc.constantFrom('module', 'service', 'doc'),
        }),
        { minLength: 0, maxLength: 8 },
      )
      .map((extra) => {
        const nodes = [
          { id: 'n0', label: 'AuthService', description: 'handles authentication', type: 'service' },
          ...extra.map((n, i) => ({
            id: `n${i + 1}`,
            label: n.label,
            description: '',
            type: n.type,
          })),
        ];
        const edges = nodes.slice(1).map((n, i) => ({
          source: nodes[i].id,
          target: n.id,
          label: `e${i}`,
          confidence: ['AMBIGUOUS', 'INFERRED', 'EXTRACTED'][i % 3],
        }));
        return { nodes, edges };
      });

    test('budget_met agrees with budget_estimate against the requested budget', () => {
      fc.assert(
        fc.property(arbGraph, fc.nat({ max: 5000 }), (graph, budget) => {
          writeGraphJson(planningDir, graph);
          const r = graphifyQuery(tmpDir, 'auth', { budget });
          assert.strictEqual(r.budget_met, r.budget_estimate <= budget);
        }),
      );
    });

    test('budget_estimate always measures the emitted payload', () => {
      fc.assert(
        fc.property(arbGraph, fc.nat({ max: 5000 }), (graph, budget) => {
          writeGraphJson(planningDir, graph);
          const r = graphifyQuery(tmpDir, 'auth', { budget });
          assert.strictEqual(r.budget_estimate, emittedTokens(r));
        }),
      );
    });

    test('the seed set is a floor the reduction never goes below', () => {
      fc.assert(
        fc.property(arbGraph, fc.nat({ max: 5000 }), (graph, budget) => {
          writeGraphJson(planningDir, graph);
          const r = graphifyQuery(tmpDir, 'auth', { budget });
          assert.ok(r.nodes.some((n) => n.id === 'n0'), 'seed survives any budget');
        }),
      );
    });

    test('total_nodes and total_edges always match the returned arrays', () => {
      fc.assert(
        fc.property(arbGraph, fc.nat({ max: 5000 }), (graph, budget) => {
          writeGraphJson(planningDir, graph);
          const r = graphifyQuery(tmpDir, 'auth', { budget });
          assert.strictEqual(r.total_nodes, r.nodes.length);
          assert.strictEqual(r.total_edges, r.edges.length);
        }),
      );
    });

    // Monotonicity is asserted over the PAYLOAD, not over budget_estimate.
    // budget_estimate measures the emitted bytes exactly, and `budget_met`
    // renders as "false" (5 chars) or "true" (4), so the identical payload can
    // measure one token larger when the budget is missed. That is the estimate
    // being honest, not a monotonicity break — so the invariant is stated over
    // the thing a caller actually cares about: how much graph came back.
    test('a larger budget never yields a smaller payload', () => {
      fc.assert(
        fc.property(arbGraph, fc.nat({ max: 2000 }), fc.nat({ max: 2000 }), (graph, a, b) => {
          writeGraphJson(planningDir, graph);
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const rLo = graphifyQuery(tmpDir, 'auth', { budget: lo });
          const rHi = graphifyQuery(tmpDir, 'auth', { budget: hi });
          assert.ok(
            rLo.total_edges <= rHi.total_edges,
            `edges must be monotone in the budget (${lo}:${rLo.total_edges} > ${hi}:${rHi.total_edges})`,
          );
          assert.ok(
            rLo.total_nodes <= rHi.total_nodes,
            `nodes must be monotone in the budget (${lo}:${rLo.total_nodes} > ${hi}:${rHi.total_nodes})`,
          );
        }),
      );
    });
  });

  describe('graphifyDiff', () => {
    let tmpDir;
    let planningDir;
    // Surfaced-config-dir fixture: makes positive-path tests deterministic.
    // See module-level comment for rationale.
    let surfacedConfigDir;
    let savedEnv;

    beforeEach(() => {
      tmpDir = createTempProject();
      planningDir = path.join(tmpDir, '.planning');
      surfacedConfigDir = makeSurfacedConfigDir();
      savedEnv = saveSurfacedEnv();
      delete process.env.GSD_RUNTIME;
      process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
      delete process.env.GSD_WORKSTREAM;
      delete process.env.GSD_PROJECT;
    });

    afterEach(() => {
      savedEnv.restore();
      cleanup(surfacedConfigDir);
      cleanup(tmpDir);
    });

    // DIFF-01: returns disabled response when not enabled
    test('returns disabled response when not enabled', () => {
      const result = graphifyDiff(tmpDir);
      assert.strictEqual(result.disabled, true);
    });

    // D-09: returns no_baseline when no snapshot exists
    test('returns no_baseline when no snapshot exists (D-09)', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyDiff(tmpDir);
      assert.strictEqual(result.no_baseline, true);
      assert.ok(result.message.includes('No previous snapshot'));
    });

    // DIFF-01: returns error when no current graph but snapshot exists
    test('returns error when no current graph but snapshot exists', () => {
      enableGraphify(planningDir);
      writeSnapshotJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyDiff(tmpDir);
      assert.ok(result.error);
      assert.ok(result.error.includes('No current graph'));
    });

    // DIFF-02: detects added and removed nodes
    test('detects added and removed nodes (DIFF-02)', () => {
      enableGraphify(planningDir);
      const snapshot = {
        nodes: [
          { id: 'n1', label: 'AuthService', description: 'Auth', type: 'service' },
          { id: 'n2', label: 'UserModel', description: 'User', type: 'model' },
        ],
        edges: [],
      };
      const current = {
        nodes: [
          { id: 'n1', label: 'AuthService', description: 'Auth', type: 'service' },
          { id: 'n3', label: 'SessionManager', description: 'Sessions', type: 'service' },
        ],
        edges: [],
      };
      writeSnapshotJson(planningDir, snapshot);
      writeGraphJson(planningDir, current);
      const result = graphifyDiff(tmpDir);
      assert.strictEqual(result.nodes.added, 1, 'n3 added');
      assert.strictEqual(result.nodes.removed, 1, 'n2 removed');
    });

    // DIFF-02: detects changed nodes and edges
    test('detects changed nodes and edges (DIFF-02)', () => {
      enableGraphify(planningDir);
      const snapshot = {
        nodes: [
          { id: 'n1', label: 'OldName', description: 'Auth', type: 'service' },
          { id: 'n2', label: 'UserModel', description: 'User', type: 'model' },
        ],
        edges: [
          { source: 'n1', target: 'n2', label: 'reads_from', confidence: 'INFERRED' },
        ],
      };
      const current = {
        nodes: [
          { id: 'n1', label: 'NewName', description: 'Auth', type: 'service' },
          { id: 'n2', label: 'UserModel', description: 'User', type: 'model' },
        ],
        edges: [
          { source: 'n1', target: 'n2', label: 'reads_from', confidence: 'EXTRACTED' },
        ],
      };
      writeSnapshotJson(planningDir, snapshot);
      writeGraphJson(planningDir, current);
      const result = graphifyDiff(tmpDir);
      assert.strictEqual(result.nodes.changed, 1, 'n1 label changed');
      assert.strictEqual(result.edges.changed, 1, 'edge confidence changed');
    });

    // LINKS-03: diff must handle links key in both current and snapshot (LINKS-03)
    test('detects edge changes when graphs use links key (LINKS-03)', () => {
      enableGraphify(planningDir);
      const snapshot = {
        nodes: [
          { id: 'n1', label: 'AuthService', description: 'Auth', type: 'service' },
          { id: 'n2', label: 'UserModel', description: 'User', type: 'model' },
        ],
        links: [
          { source: 'n1', target: 'n2', label: 'reads_from', confidence: 'INFERRED' },
        ],
      };
      const current = {
        nodes: [
          { id: 'n1', label: 'AuthService', description: 'Auth', type: 'service' },
          { id: 'n2', label: 'UserModel', description: 'User', type: 'model' },
        ],
        links: [
          { source: 'n1', target: 'n2', label: 'reads_from', confidence: 'EXTRACTED' },
        ],
      };
      writeSnapshotJson(planningDir, snapshot);
      writeGraphJson(planningDir, current);
      const result = graphifyDiff(tmpDir);
      assert.strictEqual(result.edges.changed, 1, 'edge confidence change must be detected via links key');
      assert.strictEqual(result.edges.added, 0);
      assert.strictEqual(result.edges.removed, 0);
    });
  });

  // AGENT-03: Graceful degradation (graph absent)
  describe('graceful degradation (AGENT-03)', () => {
    let tmpDir;
    let planningDir;
    // Surfaced-config-dir fixture: makes positive-path tests deterministic.
    // See module-level comment for rationale.
    let surfacedConfigDir;
    let savedEnv;

    beforeEach(() => {
      tmpDir = createTempProject();
      planningDir = path.join(tmpDir, '.planning');
      surfacedConfigDir = makeSurfacedConfigDir();
      savedEnv = saveSurfacedEnv();
      delete process.env.GSD_RUNTIME;
      process.env.CLAUDE_CONFIG_DIR = surfacedConfigDir;
      delete process.env.GSD_WORKSTREAM;
      delete process.env.GSD_PROJECT;
    });

    afterEach(() => {
      savedEnv.restore();
      cleanup(surfacedConfigDir);
      cleanup(tmpDir);
    });

    // AGENT-03: graphifyQuery returns error object when graph.json absent (not exception)
    test('graphifyQuery returns clean error object when graph.json does not exist', () => {
      enableGraphify(planningDir);
      const result = graphifyQuery(tmpDir, 'anything');
      assert.ok(result.error, 'should have error property');
      assert.ok(result.error.includes('No graph'), 'error should mention no graph');
      assert.strictEqual(typeof result.error, 'string', 'error should be a string, not thrown');
    });

    // AGENT-03: graphifyStatus returns exists:false when graph.json absent (not exception)
    test('graphifyStatus returns exists:false when graph.json does not exist', () => {
      enableGraphify(planningDir);
      const result = graphifyStatus(tmpDir);
      assert.strictEqual(result.exists, false, 'should report exists as false');
      assert.ok(result.message, 'should have a message');
      assert.ok(result.message.includes('No graph'), 'message should mention no graph');
    });

    // AGENT-03: graphifyQuery with various terms all return clean errors when no graph
    test('graphifyQuery gracefully handles any query term when graph absent', () => {
      enableGraphify(planningDir);
      const terms = ['auth', 'payment', 'nonexistent', ''];
      for (const term of terms) {
        const result = graphifyQuery(tmpDir, term);
        assert.ok(result.error || result.nodes !== undefined,
          `term "${term}" should return error or valid result, not throw`);
      }
    });

    // D-12: Integration test - query returns expected structure with known graph.json
    test('graphifyQuery returns non-empty results with expected structure for known graph', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyQuery(tmpDir, 'auth');
      assert.ok(!result.error, 'should not have error when graph exists');
      assert.ok(Array.isArray(result.nodes), 'nodes should be an array');
      assert.ok(Array.isArray(result.edges), 'edges should be an array');
      assert.ok(result.nodes.length > 0, 'should have matching nodes for auth term');
      assert.strictEqual(typeof result.total_nodes, 'number', 'total_nodes should be a number');
      assert.strictEqual(typeof result.total_edges, 'number', 'total_edges should be a number');
      assert.strictEqual(result.term, 'auth', 'term should be echoed back');
    });

    // D-12: graphifyStatus returns valid structure with known graph.json
    test('graphifyStatus returns valid structure when graph.json exists', () => {
      enableGraphify(planningDir);
      writeGraphJson(planningDir, SAMPLE_GRAPH);
      const result = graphifyStatus(tmpDir);
      assert.strictEqual(result.exists, true, 'should report exists as true');
      assert.strictEqual(typeof result.node_count, 'number', 'node_count should be number');
      assert.strictEqual(typeof result.edge_count, 'number', 'edge_count should be number');
      assert.strictEqual(typeof result.stale, 'boolean', 'stale should be boolean');
      assert.strictEqual(typeof result.age_hours, 'number', 'age_hours should be number');
    });
  });
});
