'use strict';

/**
 * emitted-caps-gate.test.cjs — the cap gate integration test (issue #2931,
 * epic #1671, Phase 4, section A of `.gsd/phase/chore-2931-emitted-byte-caps/
 * 50-test-matrix.md`).
 *
 * `evaluateEmittedCaps` (tests/helpers/emitted-caps.cjs) is a PURE decision
 * function — this file is the one place that feeds it REAL measured bytes
 * from a REAL install, proving the shipped `EMITTED_CAPS` table actually
 * guards something rather than passing vacuously.
 *
 * ── Scope note (A15) ────────────────────────────────────────────────────────
 * `.gsd/phase/chore-2931-emitted-byte-caps/40-design.md` "Scope resolution
 * (A15, made concrete during implementation)": `capabilities/windsurf/
 * capability.json` declares `commands -> destSubpath "workflows"` ONLY under
 * `artifactLayout.local`. The committed GLOBAL fixture
 * (tests/fixtures/install-tree/windsurf.json) holds 344 paths and has ZERO
 * `workflows/` entries — a global install cannot exercise the windsurf cap
 * rule at all. This file therefore builds a LOCAL windsurf install
 * (`runMinimalInstall({ runtime: 'windsurf', scope: 'local' })`), the only
 * scope where the capped artifact family exists.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const { cleanup } = require('./helpers.cjs');
const {
  BUILD_SCRIPT,
  runMinimalInstall,
  buildEmittedSizes,
} = require('./helpers/install-shared.cjs');
const { evaluateEmittedCaps, formatCapReport } = require('./helpers/emitted-caps.cjs');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { BUILD_TIMEOUT_MS: BUILD_HOOKS_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// hooks/dist is gitignored and built (DEFECT.HOOKS-DIST-SCOPED-CI). Build it
// idempotently before the shared real-install fixture, mirroring
// tests/emitted-sizes.test.cjs.
before(() => {
  const r = runNode([BUILD_SCRIPT], { timeoutMs: BUILD_HOOKS_TIMEOUT_MS });
  throwIfFailed(r, `node ${BUILD_SCRIPT}`);
});

// ─── Shared real LOCAL windsurf install, built once ───────────────────────────
let fixture = null;
let sizes = null;

before(() => {
  const { configDir, root } = runMinimalInstall({ runtime: 'windsurf', scope: 'local' });
  fixture = { configDir, root };
  sizes = buildEmittedSizes(fixture.configDir, fixture.root);
});

after(() => {
  if (fixture) cleanup(fixture.root);
});

function windsurfWorkflowRels() {
  return Object.keys(sizes).filter((rel) => /^workflows\/[^/]*\.md$/.test(rel));
}

// ─── The non-vacuous assertion ────────────────────────────────────────────────
// Without this, evaluateEmittedCaps could report `ok:true` purely because
// sizes.windsurf never contained a path matching "workflows/*.md" — a gate
// that is green because it is blind, exactly the failure mode the design
// doc's A14/dead-rule guard exists to catch structurally. This test proves
// the fixture really reaches the capped artifact family before trusting any
// later "ok:true" assertion in this file.
test('the local windsurf install actually emits workflows/*.md artifacts', () => {
  const rels = windsurfWorkflowRels();
  assert.ok(
    rels.length > 0,
    `expected at least one "workflows/*.md" artifact from a local windsurf install, `
    + `got top-level dirs: ${JSON.stringify([...new Set(Object.keys(sizes).map((k) => k.split('/')[0]))])}`,
  );
});

// ─── The real gate, run against real bytes ────────────────────────────────────

test('evaluateEmittedCaps reports ok:true with zero violations for the real windsurf install', () => {
  const result = evaluateEmittedCaps({ sizes: { windsurf: sizes } });
  assert.strictEqual(result.ok, true, formatCapReport(result) || 'expected ok:true');
  assert.deepStrictEqual(result.violations, []);
});

test('the shipped EMITTED_CAPS table is live — zero dead rules against a real install', () => {
  const result = evaluateEmittedCaps({ sizes: { windsurf: sizes } });
  assert.deepStrictEqual(result.deadRules, [], formatCapReport(result) || 'expected no dead rules');
});

// ─── Boundary trio (cap-1 / cap / cap+1) on the EMITTED path, real bytes ──────

test('boundary trio against the real measured max workflows/*.md byte count', () => {
  const rels = windsurfWorkflowRels();
  const maxBytes = Math.max(...rels.map((rel) => sizes[rel]));
  const maxRel = rels.find((rel) => sizes[rel] === maxBytes);

  const capTableAt = (cap) => ({
    windsurf: [{ pattern: 'workflows/*.md', maxBytes: cap, note: 'synthetic boundary cap for #2931 A3-A5' }],
  });

  const capMinusOne = evaluateEmittedCaps({ sizes: { windsurf: sizes }, capTable: capTableAt(maxBytes - 1) });
  const capExact = evaluateEmittedCaps({ sizes: { windsurf: sizes }, capTable: capTableAt(maxBytes) });
  const capPlusOne = evaluateEmittedCaps({ sizes: { windsurf: sizes }, capTable: capTableAt(maxBytes + 1) });

  assert.strictEqual(
    capMinusOne.violations.length, 1,
    `cap=maxBytes-1 (${maxBytes - 1}) must flag "${maxRel}" (${maxBytes} bytes) as a violation`,
  );
  assert.strictEqual(capMinusOne.violations[0].rel, maxRel);

  assert.strictEqual(
    capExact.violations.length, 0,
    `cap=maxBytes (${maxBytes}) must be inclusive (<=) — no violation`,
  );

  assert.strictEqual(
    capPlusOne.violations.length, 0,
    `cap=maxBytes+1 (${maxBytes + 1}) must have headroom — no violation`,
  );
});

// ─── A9/A10 not re-derived here: buildEmittedSizes already covers CRLF/UTF-8 ──
// byte counting in tests/emitted-sizes.test.cjs (B3/B4). This file only
// re-uses those already-normalized real bytes as input to the cap decision.

test('the real max emitted windsurf workflow is comfortably under the shipped 12,000-byte cap', () => {
  const rels = windsurfWorkflowRels();
  const maxBytes = Math.max(...rels.map((rel) => sizes[rel]));
  assert.ok(
    maxBytes < 12000,
    `measured max windsurf workflows/*.md = ${maxBytes} bytes — expected comfortably under the 12,000-byte cap`,
  );
});
