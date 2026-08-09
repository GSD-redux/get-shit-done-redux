// allow-test-rule: source-text-is-the-product — the plan-checker is a prompt; its .md text IS what the runtime loads (#1954)

/**
 * Dimension 3b — undeclared / temporal coupling between same-wave plans (#1954).
 *
 * `gsd-plan-checker` proves plan dependencies resolve and are acyclic (Dimension 3),
 * and `/gsd:execute-phase` separately proves same-wave plans do not overlap in
 * `files_modified`. Neither axis sees coupling that is real but undeclared — plan A
 * writes a config key / table / migration / global module that plan B reads, or B
 * only works if A ran first. In parallel execution that surfaces as an intermittent
 * failure the executor cannot attribute.
 *
 * ## What this suite locks
 *
 * The deployed contract AND the wiring between the three regions of the agent doc that
 * must agree: the sub-check body, its severity rule, and the `<success_criteria>`
 * checklist. A sub-check present in the body but absent from `success_criteria` is a
 * check the agent is never told to run; the reverse is a checklist item with no rubric.
 * Neither half is observable from the other, which is why both are asserted here.
 *
 * ## What it cannot prove
 *
 * That the model acts on the text. The subject is an LLM prompt — no test in this repo
 * can prove behavior for any of the agent's twelve existing dimensions either. Stated
 * so the coverage claim is honest rather than implied.
 *
 * Patterns are CRLF-tolerant (`\r?\n`): the runtime loads the file whole, including on
 * a checkout that produced CRLF, the same case `scripts/workflow-size.cjs` defends.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT_PATH = path.join(ROOT, 'agents', 'gsd-plan-checker.md');
const DOCS_AGENTS_PATH = path.join(ROOT, 'docs', 'AGENTS.md');

const agentDoc = fs.readFileSync(AGENT_PATH, 'utf-8');
const docsAgents = fs.readFileSync(DOCS_AGENTS_PATH, 'utf-8');

// ── Span helpers ───────────────────────────────────────────────────
// Offsets of the headings that bound each region. `indexOfHeading` returns -1 when
// absent so a missing heading fails as a named assertion rather than an off-by-one.
function indexOfHeading(content, pattern) {
  const m = content.match(pattern);
  return m && typeof m.index === 'number' ? m.index : -1;
}

const D3_HEADING = /^## Dimension 3: /m;
const D3B_HEADING = /^## Dimension 3b: /m;
const D4_HEADING = /^## Dimension 4: /m;

function sliceBetween(content, startPattern, endPattern) {
  const start = indexOfHeading(content, startPattern);
  const end = indexOfHeading(content, endPattern);
  assert.ok(start >= 0, `start heading not found: ${startPattern}`);
  assert.ok(end >= 0, `end heading not found: ${endPattern}`);
  assert.ok(end > start, `end heading precedes start heading: ${startPattern} .. ${endPattern}`);
  return content.slice(start, end);
}

/**
 * Count top-level ordered-list items in a span. This is the trigger gate's arity —
 * the "flag only when ALL N hold" conjunction. Widening it from 3 to 2 is what turns
 * a precise heuristic into a noise generator, so the count is asserted, not the prose.
 */
function countOrderedItems(span) {
  const matches = span.match(/^\d+\. /gm);
  return matches ? matches.length : 0;
}

describe('gsd-plan-checker Dimension 3b — undeclared/temporal coupling (#1954)', () => {
  describe('the sub-check exists and is scoped to Dimension 3', () => {
    test('Dimension 3 carries an undeclared-coupling sub-check', () => {
      const heading = agentDoc.match(/^## Dimension 3b: (.+)$/m);
      assert.ok(heading, 'agents/gsd-plan-checker.md must define a "## Dimension 3b:" heading');
      assert.match(
        heading[1],
        /coupling/i,
        `Dimension 3b must name coupling as its subject, got: ${heading[1]}`
      );
    });

    test('the sub-check sits inside Dimension 3, not after it', () => {
      const d3 = indexOfHeading(agentDoc, D3_HEADING);
      const d3b = indexOfHeading(agentDoc, D3B_HEADING);
      const d4 = indexOfHeading(agentDoc, D4_HEADING);
      assert.ok(d3 >= 0 && d3b >= 0 && d4 >= 0, 'Dimensions 3, 3b and 4 must all be present');
      assert.ok(d3 < d3b, 'Dimension 3b must follow Dimension 3');
      assert.ok(d3b < d4, 'Dimension 3b must precede Dimension 4 — it extends Dimension 3');
    });

    test('the sub-check scopes comparison to plan pairs', () => {
      // Parallelism is per PLAN (execute-phase spawns one executor per plan per wave),
      // so two tasks inside one plan run sequentially and cannot race. Scoping the
      // comparison to task pairs would flag orderings that are guaranteed by construction.
      const span = sliceBetween(agentDoc, D3B_HEADING, D4_HEADING);
      assert.match(
        span,
        /Scope:\s*PLAN pairs, not tasks/,
        'Dimension 3b must state that the comparison is plan-pair scoped'
      );
    });
  });

  describe('the trigger gate is a three-way conjunction', () => {
    test('the trigger gate enumerates exactly three conditions', () => {
      const span = sliceBetween(agentDoc, D3B_HEADING, D4_HEADING);
      assert.strictEqual(
        countOrderedItems(span),
        3,
        'Dimension 3b must gate on exactly three AND-ed conditions ' +
        '(same wave, no declared edge, named shared mutable resource or produced-state ' +
        'prerequisite). Dropping one widens the heuristic into noise; adding one ' +
        'silently narrows what it can catch.'
      );
    });

    test('condition counter fires at 2 / 3 / 4', () => {
      // The assertion above can only ever observe the real doc's arity, so its
      // inequality branch never executes. Exercise the counter at limit-1 / limit /
      // limit+1 (RULESET.TESTS.boundary-coverage) through the SAME function the guard
      // uses, in both LF and CRLF form, so a future edit cannot neuter it.
      const item = (n) => `${n}. condition ${n}`;
      for (const eol of ['\n', '\r\n']) {
        const spanOf = (count) =>
          ['## Dimension 3b: heading', ...Array.from({ length: count }, (_, i) => item(i + 1))]
            .join(eol);
        assert.strictEqual(countOrderedItems(spanOf(2)), 2, `2 items must count as 2 (eol=${JSON.stringify(eol)})`);
        assert.strictEqual(countOrderedItems(spanOf(3)), 3, `3 items must count as 3 (eol=${JSON.stringify(eol)})`);
        assert.strictEqual(countOrderedItems(spanOf(4)), 4, `4 items must count as 4 (eol=${JSON.stringify(eol)})`);
      }
    });
  });

  describe('severity is advisory, and stays advisory', () => {
    test('the sub-check finding is a warning', () => {
      const span = sliceBetween(agentDoc, D3B_HEADING, D4_HEADING);
      assert.match(
        span,
        /severity:\s*warning/,
        'Dimension 3b\'s example issue must carry severity: warning'
      );
    });

    test('the sub-check forbids escalating to blocker', () => {
      // The agent's own <adversarial_stance> penalises "issuing warnings for what are
      // actually blockers", which biases the model to escalate. Issue #1954 rejected the
      // hard-block alternative outright, so the prohibition has to be explicit in the span.
      const span = sliceBetween(agentDoc, D3B_HEADING, D4_HEADING);
      assert.match(
        span,
        /never\s+(a\s+)?blocker/i,
        'Dimension 3b must state that the finding is never a blocker'
      );
      assert.doesNotMatch(
        span,
        /severity:\s*blocker/,
        'Dimension 3b must not contain a blocker-severity example — it is advisory only'
      );
    });

    test('existing Dimension 3 blocker severities are unchanged', () => {
      // Independence: 3b is additive. The circular-dependency finding above it must
      // still block, or this change quietly downgraded a real gate.
      const d3Body = sliceBetween(agentDoc, D3_HEADING, D3B_HEADING);
      assert.match(
        d3Body,
        /severity:\s*blocker/,
        'Dimension 3\'s own example issue must still be severity: blocker'
      );
      assert.match(
        d3Body,
        /Circular dependency/,
        'Dimension 3 must still carry its circular-dependency example'
      );
    });

    test('the finding reuses the dependency_correctness dimension key', () => {
      // Hyrum: anything consuming the checker's structured issues keys on `dimension`.
      // A new key would be a new observable contract; the issue asked for a finding
      // "under Dimension 3", not a new dimension.
      const span = sliceBetween(agentDoc, D3B_HEADING, D4_HEADING);
      assert.match(
        span,
        /dimension:\s*dependency_correctness/,
        'Dimension 3b\'s example issue must reuse the dependency_correctness dimension key'
      );
    });
  });

  describe('negative space is enumerated', () => {
    test('the sub-check enumerates its non-triggering cases', () => {
      const span = sliceBetween(agentDoc, D3B_HEADING, D4_HEADING);
      assert.match(span, /Do NOT flag/, 'Dimension 3b must carry an explicit non-triggering list');
      // Each token below is a distinct exclusion class from the design's negative space.
      // Their absence is what produced false positives in the alternatives considered.
      for (const [token, why] of [
        [/files_modified/, 'the file-overlap axis is already checked elsewhere — report it once'],
        [/depends_on/, 'a pair whose edge is already declared is not a finding'],
        [/different wave/i, 'the wave itself already orders the pair'],
        [/READ/, 'two readers of a shared resource are not coupled'],
      ]) {
        assert.match(span, token, `Dimension 3b non-triggering list must cover: ${why}`);
      }
    });

    test('the sub-check defers transform conflicts to Dimension 9', () => {
      // Dimension 9 (Cross-Plan Data Contracts) owns incompatible transformations of a
      // shared entity. Without this boundary the same plan pair is reported twice.
      const span = sliceBetween(agentDoc, D3B_HEADING, D4_HEADING);
      assert.match(
        span,
        /Dimension 9/,
        'Dimension 3b must defer incompatible-transform findings to Dimension 9'
      );
    });
  });

  describe('the sub-check is wired into the agent\'s completion checklist', () => {
    test('success_criteria includes the coupling check', () => {
      const span = sliceBetween(agentDoc, /<success_criteria>/, /<\/success_criteria>/);
      assert.match(
        span,
        /^- \[ \] .*coupling.*$/im,
        'the <success_criteria> checklist must carry a line for the coupling check — ' +
        'a rubric the agent is never told to run is not a check'
      );
    });
  });

  describe('docs parity', () => {
    // Parity against the agent's own headings is self-maintaining; a hand-typed count is
    // not. The section previously claimed "8 Verification Dimensions" while enumerating
    // names that matched no dimension in the agent at all — a stale count reads as
    // authoritative, which is worse than no count.
    function agentDimensionLabels() {
      return [...agentDoc.matchAll(/^## Dimension ([0-9]+[a-z]?): /gm)].map((m) => m[1]);
    }

    test('the agent defines a discoverable set of numbered dimensions', () => {
      const labels = agentDimensionLabels();
      assert.ok(
        labels.length >= 12,
        `expected the agent to define at least 12 numbered dimensions, found ${labels.length}`
      );
      assert.ok(labels.includes('3b'), 'Dimension 3b must be among the agent\'s numbered dimensions');
      assert.strictEqual(
        new Set(labels).size,
        labels.length,
        `duplicate dimension labels in the agent: ${labels.join(', ')}`
      );
    });

    test('docs/AGENTS.md enumerates every dimension the agent defines', () => {
      const section = sliceBetween(docsAgents, /^### gsd-plan-checker$/m, /^### gsd-integration-checker$/m);
      const documented = new Set(
        [...section.matchAll(/^\| ([0-9]+[a-z]?) \| /gm)].map((m) => m[1])
      );
      const missing = agentDimensionLabels().filter((label) => !documented.has(label));
      assert.deepStrictEqual(
        missing,
        [],
        `docs/AGENTS.md omits dimension(s): ${missing.join(', ')}`
      );
    });

    test('docs/AGENTS.md documents the coupling check', () => {
      const section = sliceBetween(docsAgents, /^### gsd-plan-checker$/m, /^### gsd-integration-checker$/m);
      assert.match(
        section,
        /coupling/i,
        'docs/AGENTS.md\'s gsd-plan-checker section must document the coupling check'
      );
    });
  });
});
