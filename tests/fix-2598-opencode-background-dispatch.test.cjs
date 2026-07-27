/**
 * #2598 — the OpenCode descriptor declared background/concurrent subagent
 * dispatch that OpenCode does not actually provide by default.
 *
 * `capabilities/opencode/capability.json` carried
 * `runtime.hostIntegration.dispatch.background: true` and
 * `dispatch.backgroundDispatch: true`. OpenCode's native subagent dispatch
 * (Task tool / `@`-mention / `subtask`) is synchronous: the `background`
 * parameter is hidden from the model behind the opt-in
 * `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` flag, which defaults to false
 * (`enabledByExperimental(...)` over a `bool()` that defaults false), and the
 * session loop still `tasks.pop()`s one subtask at a time (upstream #14195,
 * #29638 — the latter still open).
 *
 * `negotiateHostCapabilities` and every `degradationFor`/`shouldFlattenDispatch`
 * consumer TRUSTS these per-field values, so declaring a capability the host
 * lacks overstates it — the opposite of the fail-closed posture the negotiation
 * exists to enforce.
 *
 * History note: these fields were flipped to `true` by #2087 citing a reading of
 * OpenCode v1.17 as "background subagents enabled by default in all modes".
 * That reading does not hold against current upstream `dev`, where the flag is
 * opt-in. This test pins the corrected values so a future descriptor edit cannot
 * silently re-assert an unsupported capability.
 */

// allow-test-rule: runtime-contract-is-the-product #2598 — the descriptor JSON and the
// host-integration matrix ARE the negotiated contract; asserting their values is behavioral.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DESCRIPTOR = path.join(ROOT, 'capabilities', 'opencode', 'capability.json');
const MATRIX = path.join(ROOT, 'docs', 'reference', 'host-integration-capability-matrix.md');

function opencodeDispatch() {
  const parsed = JSON.parse(fs.readFileSync(DESCRIPTOR, 'utf8'));
  return parsed.runtime.hostIntegration.dispatch;
}

describe('#2598: OpenCode does not declare background/concurrent subagent dispatch', () => {
  test('descriptor declares background: false', () => {
    assert.equal(
      opencodeDispatch().background,
      false,
      'OpenCode subagent dispatch is synchronous unless an experimental opt-in flag is set',
    );
  });

  test('descriptor declares backgroundDispatch: false', () => {
    assert.equal(
      opencodeDispatch().backgroundDispatch,
      false,
      'concurrent dispatch requires an opt-in flag, so it must not be declared as available',
    );
  });

  test('the capabilities that ARE real are left intact', () => {
    // Narrow the blast radius: this fix must not quietly downgrade neighbouring
    // sub-fields that were never in question.
    const d = opencodeDispatch();
    assert.equal(d.namedDispatch, true, 'named subagent dispatch is genuinely supported');
    assert.equal(d.subagentToolkit, 'full', 'the general subagent has full tool access');
    assert.equal(d.isolation, 'orchestrator-worktree',
      'isolation is orchestrator-managed via `opencode run --dir`, unaffected by #2598');
  });

  test('the host-integration matrix agrees with the descriptor', () => {
    // ADR-1239 designates the matrix the deployment source-of-truth; a
    // descriptor/matrix disagreement is how this defect survived in the first
    // place (the matrix said true, the ADR binding table said false).
    const matrix = fs.readFileSync(MATRIX, 'utf8');
    const section = matrix.slice(matrix.indexOf('## opencode'));
    const end = section.indexOf('\n## ');
    const opencodeSection = end === -1 ? section : section.slice(0, end);

    for (const field of ['dispatch.background', 'dispatch.backgroundDispatch']) {
      const row = opencodeSection.split('\n').find((l) => l.startsWith(`| ${field} |`));
      assert.ok(row, `matrix must document ${field} for opencode`);
      const value = row.split('|')[2].trim();
      assert.equal(value, 'false', `matrix ${field} must match the descriptor`);
    }
  });
});
