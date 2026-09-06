// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Agent size budget (measured in BYTES — see #717).
 *
 * Agent definitions in `agents/gsd-*.md` are loaded verbatim into the agent's
 * context on every subagent dispatch. Unbounded growth is paid on every call
 * across every workflow.
 *
 * ## Enforcement model (issue #1074)
 *
 * Mirrors tests/workflow-size-budget.test.cjs — two complementary guards, no
 * tier-max ceiling:
 *
 *   1. Per-agent baseline (the anti-creep): every agent is pinned to its exact
 *      byte size in `tests/agent-size-baseline.json`. Any growth fails with the
 *      file and delta; `npm run size:baseline` records a deliberate change as a
 *      reviewable one-line diff. This replaced the tier-max tighten-only ratchet
 *      (which only bound the single largest agent per tier).
 *
 *   2. Tier hard caps (the outer bound): XL/LARGE/DEFAULT absolute red lines
 *      with real headroom, never raised in normal work. Crossing one means
 *      extracting shared boilerplate to `gsd-core/references/`, not a +N bump.
 *      A net-new agent is DEFAULT-tier, so the DEFAULT cap already bounds it —
 *      no separate new-file cap is needed (DEFAULT is already small).
 *
 * Tiers:
 *   - XL       : top-level orchestrators that own end-to-end rubrics
 *   - LARGE    : multi-phase operators with branching workflows
 *   - DEFAULT  : focused single-purpose agents
 *
 * See:
 *   - https://github.com/open-gsd/gsd-core/issues/1074 (per-file baseline + hard caps)
 *   - https://github.com/open-gsd/gsd-core/issues/717  (bytes, not lines)
 *   - https://github.com/open-gsd/gsd-core/issues/683  (LF-normalized byte count)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const {
  lfByteCount,
  measureMdFiles,
  MARGIN_RATIO,
  marginFor,
  buildHeadroomRows,
  formatHeadroomTable,
  buildHeadroomSummaryMarkdown,
  appendHeadroomStepSummary,
} = require('../scripts/workflow-size.cjs');
const { cleanup } = require('./helpers.cjs');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const isGsdAgent = (f) => f.startsWith('gsd-');

// Tier HARD CAPS (#1074, bytes) — absolute red lines, not high-water-hugging
// ceilings. Day-to-day creep is caught per-agent by the baseline guard below;
// these sit above each tier's current high-water with real headroom:
//   XL      56 KiB
//   LARGE   48 KiB
//   DEFAULT 24 KiB
//
// #4261: the per-tier high-water marks that used to be written out here went
// stale — the LARGE line claimed "gsd-executor 42,342 → ~6.8 KB headroom"
// while the real high-water had reached 99.6% of the cap, so the comment
// documenting the margin was itself the reason nobody noticed the margin was
// gone. Hand-maintained measurements of a moving tree do not survive; the
// headroom census below emits the live numbers on every run instead.
const XL_CAP = 57344;       // 56 KiB
const LARGE_CAP = 49152;    // 48 KiB
const DEFAULT_CAP = 24576;  // 24 KiB

const XL_AGENTS = new Set([
  'gsd-debugger',
  'gsd-planner',
]);

const LARGE_AGENTS = new Set([
  'gsd-phase-researcher',
  'gsd-verifier',
  'gsd-doc-writer',
  'gsd-plan-checker',
  'gsd-executor',
  'gsd-code-fixer',
  'gsd-codebase-mapper',
  'gsd-project-researcher',
  'gsd-roadmapper',
]);

const ALL_AGENTS = fs.readdirSync(AGENTS_DIR)
  .filter(f => isGsdAgent(f) && f.endsWith('.md'))
  .map(f => f.replace('.md', ''));

function capFor(agent) {
  if (XL_AGENTS.has(agent)) return { tier: 'XL', cap: XL_CAP };
  if (LARGE_AGENTS.has(agent)) return { tier: 'LARGE', cap: LARGE_CAP };
  return { tier: 'DEFAULT', cap: DEFAULT_CAP };
}

describe('SIZE: agent tier hard caps (issue #1074)', () => {
  // Absolute outer bound per tier. A cap is NOT raised when an agent approaches
  // it — crossing it means extract shared boilerplate to gsd-core/references/.
  for (const agent of ALL_AGENTS) {
    const { tier, cap } = capFor(agent);
    test(`${agent} (${tier}) stays within the ${tier} hard cap (${cap} bytes)`, () => {
      const bytes = lfByteCount(path.join(AGENTS_DIR, agent + '.md'));
      assert.ok(
        bytes <= cap,
        `${agent}.md is ${bytes} bytes — exceeds the ${tier} hard cap of ${cap}. ` +
        `This cap is a red line, NOT a budget to raise: extract shared boilerplate ` +
        `to gsd-core/references/ and load it lazily.`
      );
    });
  }
});

describe('SIZE: agent hard-cap boundary fixtures (#1074 — negative proof)', () => {
  // The per-tier loop above only iterates the real, fully-compliant agent
  // corpus, so its `bytes <= cap` failure branch never executes. Exercise that
  // exact comparison on synthetic files measured at cap-1 / cap / cap+1 (the
  // limit boundary — RULESET.TESTS.boundary-coverage.fixtures) through the SAME
  // lfByteCount path the guard uses, so a future threshold or operator edit
  // cannot silently neuter a cap (RULESET.TESTS.regression-must-fail-first).
  test('cap comparison fires at the limit boundary for every tier', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-size-'));
    try {
      // ASCII 'a' is 1 byte/char and has no CRLF, so lfByteCount == length.
      const measureAt = (n) => {
        const p = path.join(tmp, `fixture-${n}.md`);
        fs.writeFileSync(p, 'a'.repeat(n));
        return lfByteCount(p);
      };
      for (const cap of [DEFAULT_CAP, LARGE_CAP, XL_CAP]) {
        assert.equal(measureAt(cap - 1) <= cap, true, `${cap - 1} must be within cap ${cap}`);
        assert.equal(measureAt(cap) <= cap, true, `${cap} (exactly at cap) must be within cap ${cap}`);
        assert.equal(measureAt(cap + 1) <= cap, false, `${cap + 1} must exceed cap ${cap}`);
      }
    } finally {
      cleanup(tmp);
    }
  });
});

// A prior "SIZE: per-agent baseline (issue #1074)" describe block lived here,
// asserting every agent's exact byte count against the committed
// `tests/agent-size-baseline.json` snapshot. #2724 (ADR-2719 Phase 4) deletes that
// snapshot: it was a pure function of the source tree, and its purpose — "growth
// must be noticed and justified" — is now served by the same differential machine
// that replaced the golden-install-parity fixtures (tests/emitted-attribution.test.cjs's
// real-tree test, via `emitted-diff.cjs`'s size ratchet: growth is reported with its
// exact byte delta and requires an entry in tests/emitted-drift-ack.json, ADR-2719 §4 /
// must-have 6). The tier hard caps above are unaffected — they are independent of the
// deleted baseline and remain the outer bound.

// ─── #4261: headroom visibility + reserved margin ──────────────────────────
//
// The hard caps above are red lines and this changes none of them. What was
// missing is everything BELOW the red line: a passing run said nothing, so a
// contributor sitting at 99.6% of a cap and one at 60% got identical
// feedback — green — and the density that produces merge-time collisions was
// invisible to the people creating it.
//
// Two levels, matching the shape `execute-phase.md` already has by hand (a
// hard ceiling plus a lower margin "so minor future edits don't re-trip the
// gate"), which until now was the only capped file with one:
//
//   1. the census, printed every run, green or not
//   2. the reserved margin, which REPORTS rather than fails
//
// The margin deliberately does not fail. A cap breach is a red line; a file
// at 96% is not broken, it is a file whose next contributor should know to
// extract before adding. Failing there would turn a warning into a second
// red line and force exactly the +N bumps this policy forbids.
const AGENT_HEADROOM_ROWS = buildHeadroomRows(
  measureMdFiles(AGENTS_DIR, isGsdAgent),
  capFor,
);

describe('SIZE: agent headroom census (issue #4261)', () => {
  test('reports every agent\'s remaining bytes, and never fails for it', (t) => {
    for (const line of formatHeadroomTable(AGENT_HEADROOM_ROWS)) t.diagnostic(line);
    const pressured = AGENT_HEADROOM_ROWS.filter((r) => r.overMargin);
    t.diagnostic(
      `agents: ${AGENT_HEADROOM_ROWS.length} | over the ${Math.round(MARGIN_RATIO * 100)}% margin: ${pressured.length}`,
    );
    appendHeadroomStepSummary('Agent size headroom', AGENT_HEADROOM_ROWS);

    // The census is reporting, not a gate — the only thing asserted is that it
    // measured the corpus at all. A census that silently went empty (a moved
    // directory, a broken predicate) would otherwise read as good news.
    assert.equal(AGENT_HEADROOM_ROWS.length, ALL_AGENTS.length);
  });

  test('names the agents inside the reserved margin', (t) => {
    for (const r of AGENT_HEADROOM_ROWS.filter((row) => row.overMargin)) {
      t.diagnostic(
        `RESERVED MARGIN: ${r.name}.md is ${r.bytes} bytes — ${r.headroom} under the ${r.tier} cap ` +
        `(${r.usedPct.toFixed(1)}%), past the ${r.margin}-byte margin. The cap is not moving: ` +
        `extract shared boilerplate to gsd-core/references/ and load it lazily before adding more.`,
      );
    }
    // Intentionally no assertion on the COUNT. Pinning "3 agents are over the
    // margin" would make this a baseline that every extraction has to update,
    // which is the maintenance burden #2724 removed when it deleted the
    // per-file size snapshot. The hard caps stay the only failing gate.
  });
});

describe('SIZE: reserved-margin boundary fixtures (#4261 — negative proof)', () => {
  // The margin loop above reports whatever the real corpus happens to be, so
  // its comparison branch is not exercised by construction — the same gap the
  // hard-cap fixtures above exist to close. Pin marginFor and the > operator
  // at the boundary so a future ratio or operator edit cannot quietly widen
  // the margin to nothing (RULESET.TESTS.boundary-coverage.fixtures).
  test('marginFor sits strictly below its cap and fires at the boundary', () => {
    for (const cap of [DEFAULT_CAP, LARGE_CAP, XL_CAP]) {
      const margin = marginFor(cap);
      assert.ok(margin < cap, `margin ${margin} must sit below cap ${cap}`);
      assert.equal(margin > cap * MARGIN_RATIO - 1, true, `margin ${margin} must track the ratio`);
      assert.equal(margin > margin, false, 'a file exactly at the margin is NOT over it');
      assert.equal(margin + 1 > margin, true, 'one byte past the margin IS over it');
    }
  });

  test('marginFor floors, so a tiny cap can never produce a margin at the cap', () => {
    // Rounding here would put the margin ON the cap for small caps, making the
    // warning fire only when the hard gate already had.
    assert.equal(marginFor(1), 0);
    assert.equal(marginFor(20), 19);
    assert.ok(marginFor(20) < 20);
  });
});

describe('SIZE: headroom job summary (#4261)', () => {
  // The census is only useful if it reaches a human. The diagnostics above go
  // to the test log; this is the copy that lands on the PR's checks page,
  // which is where a reviewer actually looks.
  const row = (over) => ({
    name: 'gsd-example', tier: 'LARGE', bytes: over ? 49000 : 10000,
    cap: 49152, margin: 46694, headroom: over ? 152 : 39152,
    usedPct: over ? 99.7 : 20.3, overMargin: over,
  });

  test('a clean corpus still reports how many files it measured', () => {
    const md = buildHeadroomSummaryMarkdown('Agent size headroom', [row(false), row(false)]);
    // "no table" must be distinguishable from "nothing ran".
    assert.match(md, /All 2 files are under the 95% reserved margin\./);
    assert.doesNotMatch(md, /\| file \|/);
  });

  test('a pressured corpus renders one table row per file over the margin', () => {
    const md = buildHeadroomSummaryMarkdown('Agent size headroom', [row(true), row(false)]);
    assert.match(md, /\*\*1 of 2\*\* files are over the 95% reserved margin\./);
    assert.match(md, /\| `gsd-example` \| LARGE \| 49000 \| 49152 \| 152 \| 99\.7% \|/);
  });

  test('writes to GITHUB_STEP_SUMMARY when set, and is a no-op when it is not', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-size-summary-'));
    try {
      const file = path.join(tmp, 'summary.md');
      assert.equal(appendHeadroomStepSummary('T', [row(true)], { GITHUB_STEP_SUMMARY: file }), true);
      assert.match(fs.readFileSync(file, 'utf8'), /### T/);
      assert.equal(appendHeadroomStepSummary('T', [row(true)], {}), false);
    } finally {
      cleanup(tmp);
    }
  });

  test('an unwritable summary path reports but does not fail the run', () => {
    // Reporting must never be able to red a suite that is otherwise green —
    // the whole point of this block is that it is additive.
    const unwritable = path.join(os.tmpdir(), 'agent-size-nope', 'nested', 'summary.md');
    assert.equal(appendHeadroomStepSummary('T', [row(true)], { GITHUB_STEP_SUMMARY: unwritable }), false);
  });
});

describe('SIZE: every agent is classified', () => {
  test('every agent falls in exactly one tier', () => {
    for (const agent of ALL_AGENTS) {
      const inXL = XL_AGENTS.has(agent);
      const inLarge = LARGE_AGENTS.has(agent);
      assert.ok(
        !(inXL && inLarge),
        `${agent} is in both XL_AGENTS and LARGE_AGENTS — pick one`
      );
    }
  });

  test('every named XL agent exists', () => {
    for (const agent of XL_AGENTS) {
      const filePath = path.join(AGENTS_DIR, agent + '.md');
      assert.ok(
        fs.existsSync(filePath),
        `XL_AGENTS references ${agent}.md which does not exist — clean up the set`
      );
    }
  });

  test('every named LARGE agent exists', () => {
    for (const agent of LARGE_AGENTS) {
      const filePath = path.join(AGENTS_DIR, agent + '.md');
      assert.ok(
        fs.existsSync(filePath),
        `LARGE_AGENTS references ${agent}.md which does not exist — clean up the set`
      );
    }
  });
});
