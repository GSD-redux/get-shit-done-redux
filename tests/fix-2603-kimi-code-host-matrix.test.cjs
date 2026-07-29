/**
 * #2603 — `docs/reference/host-integration-capability-matrix.md` documented 18 of the
 * 19 installed runtimes but had no `## kimi-code` section, so kimi-code's
 * `runtime.hostIntegration` axes shipped with no cited source and no evidence quote.
 *
 * Sourcing each axis independently (the issue's explicit requirement — "Do not copy
 * `kimi`'s section", they are distinct products) showed three axis values had been
 * inherited from the Python `kimi` descriptor rather than sourced for Kimi Code CLI:
 *
 *   - `embeddingMode: imperative` → `declarative`. Kimi Code plugins are a
 *     `kimi.plugin.json` manifest plus markdown Skills; "Plugins are configuration and
 *     markdown only" with no in-process programmatic API (docs/en/customization/plugins.md).
 *     Same shape as codex, which is `declarative`.
 *   - `dispatch.nested: false` → `true`. The `coder` built-in "can dispatch its own
 *     nested sub-agents when a task decomposes naturally" (docs/en/customization/agents.md).
 *     The Python `kimi` CLI genuinely prohibits nesting; Kimi Code does not.
 *   - `dispatch.maxDepth: 1` → `'undocumented'`. Nesting is documented but no depth
 *     bound is published, so the fail-closed sentinel applies rather than a guessed 1.
 *
 * `dispatch.namedDispatch` deliberately stays `false`: GSD's kimi-code artifact layout
 * installs Agent Skills only (no `agents` kind), so no named GSD subagent is registered
 * with the host and `resolveDispatchType` maps every role onto coder/explore/plan.
 * Flipping it without also shipping agent files would reintroduce the dispatch failure
 * recorded in docs/migration/kimi-to-kimi-code.md.
 *
 * This is the same defect class as #2598 (a descriptor axis asserting something the
 * host docs contradict), and takes the same countermeasure: pin the corrected values
 * AND require the matrix to agree with the descriptor, because a descriptor/matrix
 * disagreement is how the gap survived.
 */

// allow-test-rule: runtime-contract-is-the-product #2603 — the descriptor JSON and the
// host-integration matrix ARE the negotiated contract; asserting their values is behavioral.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DESCRIPTOR = path.join(ROOT, 'capabilities', 'kimi-code', 'capability.json');
const MATRIX = path.join(ROOT, 'docs', 'reference', 'host-integration-capability-matrix.md');

const {
  profileOf,
  negotiateHostCapabilities,
} = require(path.join(ROOT, 'gsd-core/bin/lib/host-integration.cjs'));

function kimiCodeAxes() {
  return JSON.parse(fs.readFileSync(DESCRIPTOR, 'utf8')).runtime.hostIntegration;
}

/** Extract the `## <host>` section body, stopping at the next top-level host heading. */
function matrixSection(host) {
  const matrix = fs.readFileSync(MATRIX, 'utf8');
  const start = matrix.indexOf(`\n## ${host}\n`);
  if (start === -1) return null;
  const rest = matrix.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** Read the `| <axis> | <value> | …` cell out of a matrix section. */
function matrixValue(section, axis) {
  const row = section.split('\n').find((l) => l.startsWith(`| ${axis} |`));
  return row ? row.split('|')[2].trim() : null;
}

describe('#2603: the host-integration matrix documents kimi-code', () => {
  test('a `## kimi-code` section exists', () => {
    assert.ok(
      matrixSection('kimi-code'),
      'the matrix is the deployment source-of-truth for every installed runtime; kimi-code must have a section',
    );
  });

  test('every hostIntegration axis kimi-code declares is documented in the matrix', () => {
    const section = matrixSection('kimi-code');
    const axes = kimiCodeAxes();

    const scalarAxes = Object.keys(axes).filter((k) => k !== 'dispatch');
    for (const axis of scalarAxes) {
      assert.ok(
        matrixValue(section, axis),
        `matrix must document the "${axis}" axis for kimi-code`,
      );
    }

    // `builtInSubagents` is a GSD-side list, not a negotiated axis — the matrix
    // documents it in prose, not as its own row.
    const dispatchAxes = Object.keys(axes.dispatch).filter((k) => k !== 'builtInSubagents');
    for (const axis of dispatchAxes) {
      assert.ok(
        matrixValue(section, `dispatch.${axis}`),
        `matrix must document the "dispatch.${axis}" sub-axis for kimi-code`,
      );
    }
  });

  test('the matrix values agree with the shipped descriptor', () => {
    const section = matrixSection('kimi-code');
    const axes = kimiCodeAxes();

    for (const axis of Object.keys(axes).filter((k) => k !== 'dispatch')) {
      assert.equal(
        matrixValue(section, axis),
        String(axes[axis]),
        `matrix "${axis}" must match the descriptor`,
      );
    }
    for (const axis of Object.keys(axes.dispatch).filter((k) => k !== 'builtInSubagents')) {
      assert.equal(
        matrixValue(section, `dispatch.${axis}`),
        String(axes.dispatch[axis]),
        `matrix "dispatch.${axis}" must match the descriptor`,
      );
    }
  });

  test('the kimi-code section is sourced independently of the kimi section', () => {
    // The two are distinct products (Python kimi-cli vs TypeScript Kimi Code CLI);
    // the issue's central requirement is that kimi's section was NOT copied. The
    // check is scoped to the axis ROWS — the section's prose intro deliberately
    // names kimi's Python API to draw the contrast, which is the opposite of a copy.
    const rows = matrixSection('kimi-code')
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Axis |') && !l.startsWith('|---'));

    assert.ok(rows.length >= 11, 'expected a row per hostIntegration axis');
    for (const row of rows) {
      assert.ok(
        !row.includes('kimi_cli'),
        `kimi-code axis row must not cite the Python kimi-cli: ${row.slice(0, 60)}`,
      );
      assert.ok(
        !row.includes('moonshotai.github.io/kimi-cli'),
        `kimi-code axis row must not cite kimi-cli docs: ${row.slice(0, 60)}`,
      );
    }
    assert.ok(
      rows.some((r) => r.includes('kimi-code/blob/main/docs')),
      'kimi-code axes must cite the Kimi Code CLI docs',
    );
  });
});

describe('#2603: axis values inherited from the Python kimi descriptor are corrected', () => {
  test('embeddingMode is declarative — plugins expose no in-process API', () => {
    assert.equal(kimiCodeAxes().embeddingMode, 'declarative');
  });

  test('kimi-code therefore classifies as the declarative-cli profile', () => {
    assert.equal(profileOf(kimiCodeAxes()), 'declarative-cli');
  });

  test('dispatch.nested is true — the coder built-in dispatches nested sub-agents', () => {
    assert.equal(kimiCodeAxes().dispatch.nested, true);
  });

  test('dispatch.maxDepth is the undocumented sentinel, not a guessed integer', () => {
    assert.equal(kimiCodeAxes().dispatch.maxDepth, 'undocumented');
  });

  test('namedDispatch stays false — GSD installs no agent files for this host', () => {
    // Guard against a well-meaning "the docs say custom agents exist" edit: flipping
    // this makes resolveDispatchType return `gsd-planner` unchanged, which kimi-code
    // cannot dispatch (docs/migration/kimi-to-kimi-code.md).
    assert.equal(kimiCodeAxes().dispatch.namedDispatch, false);
  });

  test('the undocumented maxDepth sentinel is reported as a sentinel, not as malformed', () => {
    // Surfaced by this change: maxDepth was the ONE dispatch sub-axis with no
    // sentinel-specific warning, so the documented fail-closed value was reported
    // as "missing or not a number" — indistinguishable from a genuinely broken
    // descriptor. kimi-code would have been the sixth runtime to hit that path.
    const { warnings } = negotiateHostCapabilities(kimiCodeAxes());

    assert.ok(
      warnings.some((w) => w.includes('dispatch.maxDepth is undocumented')),
      `expected a maxDepth sentinel warning, got: ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      !warnings.some((w) => w.includes('maxDepth is missing or not a number')),
      'the documented sentinel must not be reported as a malformed value',
    );
  });

  test('a genuinely malformed maxDepth is still reported as malformed', () => {
    // Boundary: the sentinel carve-out must not swallow the real error case.
    const axes = kimiCodeAxes();
    const malformed = { ...axes, dispatch: { ...axes.dispatch, maxDepth: 'not-a-number' } };
    const { warnings } = negotiateHostCapabilities(malformed);

    assert.ok(
      warnings.some((w) => w.includes('maxDepth is missing or not a number')),
      `expected the malformed-value warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test('both maxDepth paths still degrade the effective value closed to 0', () => {
    const axes = kimiCodeAxes();
    assert.equal(negotiateHostCapabilities(axes).effective.dispatch.maxDepth, 0);
    const malformed = { ...axes, dispatch: { ...axes.dispatch, maxDepth: 'not-a-number' } };
    assert.equal(negotiateHostCapabilities(malformed).effective.dispatch.maxDepth, 0);
  });

  test('the axes that were already correct are left intact', () => {
    const axes = kimiCodeAxes();
    assert.equal(axes.commandSurface, 'slash-file');
    assert.equal(axes.modelMode, 'passive');
    assert.equal(axes.hookBus, 'host');
    assert.equal(axes.stateIO, 'filesystem');
    assert.equal(axes.transport, 'mcp');
    assert.equal(axes.runtime, 'node');
    assert.equal(axes.dispatch.background, true);
    assert.equal(axes.dispatch.backgroundDispatch, true);
    assert.equal(axes.dispatch.subagentToolkit, 'built-in-only');
    assert.equal(axes.dispatch.isolation, 'orchestrator-worktree');
  });
});
