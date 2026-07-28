// allow-test-rule: source-text-is-the-product
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
const { lfByteCount } = require('../scripts/workflow-size.cjs');
const { cleanup } = require('./helpers.cjs');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const isGsdAgent = (f) => f.startsWith('gsd-');

// Tier HARD CAPS (#1074, bytes) — absolute red lines, not high-water-hugging
// ceilings. Day-to-day creep is caught per-agent by the baseline guard below;
// these sit above each tier's current high-water with real headroom:
//   XL      56 KiB — high-water gsd-debugger 51,043 → ~6.3 KB headroom
//   LARGE   48 KiB — high-water gsd-executor 42,342 → ~6.8 KB headroom
//   DEFAULT 24 KiB — high-water gsd-ui-researcher 19,095 → ~5.5 KB headroom
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
