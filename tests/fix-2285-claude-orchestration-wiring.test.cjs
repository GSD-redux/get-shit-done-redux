'use strict';

// allow-test-rule: source-text-is-the-product, see #2285 — reads gsd-core/workflows/execute-phase.md
// prose to verify the render-hooks call site + ordering. The workflow markdown IS the runtime
// contract executed by the orchestrator; there is no behavioral seam to drive this assertion
// through other than the rendered prose itself.

/**
 * fix-2285-claude-orchestration-wiring.test.cjs
 *
 * #2285 — the `claude-orchestration` capability (Workflow backend, #1143) was
 * registered `active` but fully INERT: `detectWorkflowBackend`/`emitWorkflowScript`
 * had zero callers outside their own CLI router, and execute-phase.md declared
 * `execute:wave:pre` as a hook point in its frontmatter but never rendered it —
 * the wave loop only ever dispatched `execute:pre`, `execute:wave:post`, and
 * `execute:post`. `claude_orchestration.enabled:true` therefore had no effect on
 * a real execute-phase run.
 *
 * Fix (Approach B):
 *   1. execute-phase.md now renders `execute:wave:pre` immediately before each
 *      wave's agents are dispatched (step 2.75, before step 3's Agent() loop).
 *   2. The claude-orchestration contribution moved from `execute:wave:post`
 *      (fires too late — after the wave already dispatched inline) to
 *      `execute:wave:pre` (fires before dispatch, where a backend selector
 *      actually has to run to matter).
 *   3. `resolveWaveDispatch` in src/claude-orchestration.cts composes
 *      `detectWorkflowBackend` + `emitWorkflowScript` into ONE decision seam,
 *      giving both functions a real caller outside their CLI router and outside
 *      tests. It is also exposed via `gsd-tools claude-orchestration
 *      resolve-wave-dispatch`.
 *
 * This file drives the real seam (no source-grep on implementation files) and
 * asserts the fail-closed contract: disabled or any gate miss => inline,
 * byte-identical to today's dispatch shape.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('fast-check');

const {
  detectWorkflowBackend,
  emitWorkflowScript,
  resolveWaveDispatch,
  WORKFLOW_TOOL_FLOOR_VERSION,
} = require('../gsd-core/bin/lib/claude-orchestration.cjs');

const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const CAP_PATH = path.join(ROOT, 'capabilities', 'claude-orchestration', 'capability.json');

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A host-integration descriptor whose dispatch axis signals Workflow-tool capability. */
const CAPABLE_HOST = { dispatch: { nested: true, background: true } };
/** A descriptor that fails the nested/background dispatch gate. */
const INCAPABLE_HOST = { dispatch: { nested: false, background: true } };

const ABOVE_FLOOR_SDK = '0.3.150';
const AT_FLOOR_SDK = WORKFLOW_TOOL_FLOOR_VERSION; // '0.3.149'
const BELOW_FLOOR_SDK = '0.3.148';

function enabledConfig(overrides = {}) {
  return {
    'claude_orchestration.enabled': true,
    'claude_orchestration.execution_backend': 'auto',
    ...overrides,
  };
}

function singleWave() {
  return {
    phaseDir: '.planning/phases/01-foo',
    runId: 'run-2285-1',
    waves: [
      {
        id: 'w1',
        plans: [
          { id: 'p1', brief: 'Implement the foo module', files_modified: ['src/foo.cts'] },
        ],
      },
    ],
  };
}

function baseInput(overrides = {}) {
  return {
    runtimeId: 'claude',
    hostIntegration: CAPABLE_HOST,
    agentSdkVersion: ABOVE_FLOOR_SDK,
    config: enabledConfig(),
    ...singleWave(),
    ...overrides,
  };
}

// ─── Section A: happy path — every gate satisfied → workflow backend ────────

describe('A. resolveWaveDispatch — enabled + all gates satisfied → workflow backend with emitted script', () => {
  test('[happy] enabled, claude runtime, capable host, SDK above floor, auto backend → backend:"workflow"', () => {
    const result = resolveWaveDispatch(baseInput());
    assert.strictEqual(result.backend, 'workflow');
    assert.strictEqual(result.reason, 'workflow_backend_active');
    assert.ok(typeof result.script === 'string' && result.script.length > 0, 'script must be a non-empty string');
    // #2590: resumeFromRunId is a Workflow TOOL INPUT, not a script function —
    // calling it threw "resumeFromRunId is not defined". The run id must still
    // reach the caller (which passes it as that input), but never as a call.
    assert.ok(!/^\s*resumeFromRunId\s*\(/m.test(result.script), 'must not CALL resumeFromRunId');
    assert.strictEqual(result.summary.resumeRunId, 'run-2285-1');
    assert.match(result.script, /agentType: "gsd-executor", isolation: "worktree"/);
    assert.ok(result.summary && result.summary.plans === 1, 'summary.plans must reflect the manifest');
  });

  test('[happy] execution_backend explicitly "workflow" (not just "auto") also activates', () => {
    const result = resolveWaveDispatch(baseInput({
      config: enabledConfig({ 'claude_orchestration.execution_backend': 'workflow' }),
    }));
    assert.strictEqual(result.backend, 'workflow');
  });

  test('[bva] SDK version boundary: floor-1 → inline, floor exact → workflow, floor+1 → workflow', () => {
    const below = resolveWaveDispatch(baseInput({ agentSdkVersion: BELOW_FLOOR_SDK }));
    assert.strictEqual(below.backend, 'inline', 'below floor must be inline');
    assert.strictEqual(below.reason, 'agent_sdk_version_below_floor');

    const at = resolveWaveDispatch(baseInput({ agentSdkVersion: AT_FLOOR_SDK }));
    assert.strictEqual(at.backend, 'workflow', 'exactly at floor must activate workflow');

    const above = resolveWaveDispatch(baseInput({ agentSdkVersion: ABOVE_FLOOR_SDK }));
    assert.strictEqual(above.backend, 'workflow', 'above floor must activate workflow');
  });
});

// ─── Section B: fail-closed contract — disabled / each gate individually failing → inline ──

describe('B. resolveWaveDispatch — fail-closed contract: disabled or any gate miss → inline, matches detectWorkflowBackend 1:1', () => {
  const GATE_MISS_CASES = [
    {
      label: 'capability disabled',
      overrides: { config: {} },
      expectedReason: 'capability_disabled',
    },
    {
      label: 'capability explicitly disabled',
      overrides: { config: enabledConfig({ 'claude_orchestration.enabled': false }) },
      expectedReason: 'capability_disabled',
    },
    {
      label: 'runtime is not claude',
      overrides: { runtimeId: 'codex' },
      expectedReason: 'runtime_not_claude',
    },
    {
      label: 'execution_backend explicitly "inline"',
      overrides: { config: enabledConfig({ 'claude_orchestration.execution_backend': 'inline' }) },
      expectedReason: 'backend_inline',
    },
    {
      label: 'host descriptor incapable (nested:false)',
      overrides: { hostIntegration: INCAPABLE_HOST },
      expectedReason: 'workflow_tool_unavailable',
    },
    {
      label: 'host descriptor missing entirely',
      overrides: { hostIntegration: null },
      expectedReason: 'workflow_tool_unavailable',
    },
    {
      label: 'agent SDK version missing',
      overrides: { agentSdkVersion: undefined },
      expectedReason: 'agent_sdk_version_unknown',
    },
    {
      label: 'agent SDK version malformed (not semver)',
      overrides: { agentSdkVersion: 'not-a-version' },
      expectedReason: 'agent_sdk_version_unknown',
    },
    {
      label: 'agent SDK version below floor',
      overrides: { agentSdkVersion: BELOW_FLOOR_SDK },
      expectedReason: 'agent_sdk_version_below_floor',
    },
  ];

  for (const { label, overrides, expectedReason } of GATE_MISS_CASES) {
    test(`[negative] ${label} → backend:"inline", reason:"${expectedReason}"`, () => {
      const input = baseInput(overrides);
      const result = resolveWaveDispatch(input);

      assert.strictEqual(result.backend, 'inline', `${label}: must resolve to inline`);
      assert.strictEqual(result.reason, expectedReason, `${label}: reason mismatch`);

      // Fail-closed CONTRACT: today's (byte-identical) inline dispatch carries no
      // script/summary. Verify the shape never leaks emitter fields on a gate miss.
      assert.deepStrictEqual(
        Object.keys(result).sort(),
        ['backend', 'reason'],
        `${label}: inline result must be exactly {backend, reason}, got keys: ${Object.keys(result).join(',')}`,
      );

      // Parity: resolveWaveDispatch must not reimplement the gate ladder — its
      // reason for a detect-side miss must be IDENTICAL to calling
      // detectWorkflowBackend directly with the same gate-relevant fields.
      const direct = detectWorkflowBackend({
        runtimeId: input.runtimeId,
        hostIntegration: input.hostIntegration,
        config: input.config,
        agentSdkVersion: input.agentSdkVersion,
      });
      assert.strictEqual(direct.backend, 'inline', `${label}: detectWorkflowBackend parity check must also be inline`);
      assert.strictEqual(result.reason, direct.reason, `${label}: resolveWaveDispatch must surface detectWorkflowBackend's own reason verbatim`);
    });
  }

  test('[negative] null/undefined/non-object input → inline, reason:"invalid_input" (never throws)', () => {
    assert.deepStrictEqual(resolveWaveDispatch(null), { backend: 'inline', reason: 'invalid_input' });
    assert.deepStrictEqual(resolveWaveDispatch(undefined), { backend: 'inline', reason: 'invalid_input' });
    assert.deepStrictEqual(resolveWaveDispatch('not-an-object'), { backend: 'inline', reason: 'invalid_input' });
  });

  test('[happy] a valid, dispatch-ready waves manifest never flips a gate-missed decision to workflow', () => {
    // Prove the gate ladder short-circuits BEFORE emitWorkflowScript ever runs:
    // even with a perfectly valid wave manifest, a disabled capability stays inline.
    const result = resolveWaveDispatch(baseInput({ config: {}, ...singleWave() }));
    assert.strictEqual(result.backend, 'inline');
    assert.strictEqual(result.reason, 'capability_disabled');
  });
});

// ─── Section C: composition correctness — detect + emit have a real, non-CLI, non-test caller ──

describe('C. resolveWaveDispatch composes detectWorkflowBackend + emitWorkflowScript (the seam itself)', () => {
  test('[happy] resolveWaveDispatch is exported as a function from the core module', () => {
    assert.strictEqual(typeof resolveWaveDispatch, 'function');
  });

  test('[happy] on a workflow-hit, the emitted script/summary are IDENTICAL to calling emitWorkflowScript directly with the same wave data', () => {
    const input = baseInput();
    const composed = resolveWaveDispatch(input);
    assert.strictEqual(composed.backend, 'workflow');

    const directEmit = emitWorkflowScript({
      phaseDir: input.phaseDir,
      waves: input.waves,
      runId: input.runId,
    });
    assert.strictEqual(directEmit.ok, true);
    assert.strictEqual(composed.script, directEmit.script, 'resolveWaveDispatch must not re-implement emission — script must match emitWorkflowScript byte-for-byte');
    assert.deepStrictEqual(composed.summary, directEmit.summary);
  });

  test('[negative] detect-hit but a malformed wave manifest (emit failure) → inline, carrying emitWorkflowScript\'s own failure reason', () => {
    const input = baseInput({ waves: [] }); // emitWorkflowScript rejects empty waves
    const result = resolveWaveDispatch(input);
    assert.strictEqual(result.backend, 'inline');

    const directEmit = emitWorkflowScript({ phaseDir: input.phaseDir, waves: input.waves, runId: input.runId });
    assert.strictEqual(directEmit.ok, false);
    assert.strictEqual(result.reason, 'emit_failed: ' + directEmit.reason, 'the emit failure reason must be surfaced verbatim, prefixed');

    // Still byte-identical inline shape — no partial/broken script ever leaks.
    assert.deepStrictEqual(Object.keys(result).sort(), ['backend', 'reason']);
  });

  test('[happy] the CLI subcommand `claude-orchestration resolve-wave-dispatch` is ALSO a caller and matches the pure function output', () => {
    const tmp = createTempDir('fix-2285-');
    try {
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.planning', 'config.json'),
        JSON.stringify({ claude_orchestration: { enabled: true, execution_backend: 'auto' } }),
      );
      const wavesPath = path.join(tmp, 'waves.json');
      fs.writeFileSync(wavesPath, JSON.stringify({ waves: singleWave().waves }));

      const res = runGsdTools([
        'claude-orchestration', 'resolve-wave-dispatch',
        '--waves', wavesPath,
        '--run-id', 'run-2285-1',
        '--phase-dir', '.planning/phases/01-foo',
        '--runtime', 'claude',
        '--agent-sdk-version', ABOVE_FLOOR_SDK,
        // #2686: the router now DEFAULTS the executor model from project config,
        // so pin it on both sides — otherwise this compares a config-resolved CLI
        // run against a pure call that was given no model, and the equality this
        // test exists to prove would be testing the default instead of the seam.
        '--executor-model', 'sonnet',
        '--raw',
      ], tmp);
      assert.strictEqual(res.success, true, 'CLI command must succeed; stderr: ' + (res.error || ''));
      const parsed = JSON.parse(res.output);

      const direct = resolveWaveDispatch(baseInput({ executorModel: 'sonnet' }));
      assert.strictEqual(parsed.backend, direct.backend);
      assert.strictEqual(parsed.script, direct.script);
      assert.deepStrictEqual(parsed.summary, direct.summary);
    } finally {
      cleanup(tmp);
    }
  });

  test('[negative] CLI subcommand fails closed to inline exactly like the pure function when disabled', () => {
    const tmp = createTempDir('fix-2285-off-');
    try {
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), '{}');
      const wavesPath = path.join(tmp, 'waves.json');
      fs.writeFileSync(wavesPath, JSON.stringify({ waves: singleWave().waves }));

      const res = runGsdTools([
        'claude-orchestration', 'resolve-wave-dispatch',
        '--waves', wavesPath, '--run-id', 'run-x', '--raw',
      ], tmp);
      assert.strictEqual(res.success, true, 'CLI command must succeed (fail-closed, not error); stderr: ' + (res.error || ''));
      const parsed = JSON.parse(res.output);
      assert.strictEqual(parsed.backend, 'inline');
      assert.strictEqual(parsed.reason, 'capability_disabled');
      assert.deepStrictEqual(Object.keys(parsed).sort(), ['backend', 'reason']);
    } finally {
      cleanup(tmp);
    }
  });

  test('property: for ANY input, resolveWaveDispatch never throws, backend is always "inline"|"workflow", and "inline" results carry exactly {backend, reason}', () => {
    fc.assert(fc.property(
      fc.record({
        runtimeId: fc.oneof(fc.constant('claude'), fc.constant('codex'), fc.constant(undefined), fc.string()),
        agentSdkVersion: fc.oneof(fc.constant(ABOVE_FLOOR_SDK), fc.constant(BELOW_FLOOR_SDK), fc.constant(undefined), fc.string()),
        enabled: fc.boolean(),
        capableHost: fc.boolean(),
        backendPref: fc.constantFrom('auto', 'workflow', 'inline'),
      }),
      ({ runtimeId, agentSdkVersion, enabled, capableHost, backendPref }) => {
        const input = {
          runtimeId,
          hostIntegration: capableHost ? CAPABLE_HOST : INCAPABLE_HOST,
          agentSdkVersion,
          config: {
            'claude_orchestration.enabled': enabled,
            'claude_orchestration.execution_backend': backendPref,
          },
          ...singleWave(),
        };
        const result = resolveWaveDispatch(input);
        assert.ok(result.backend === 'inline' || result.backend === 'workflow');
        if (result.backend === 'inline') {
          assert.deepStrictEqual(Object.keys(result).sort(), ['backend', 'reason']);
        } else {
          assert.ok(typeof result.script === 'string' && result.script.length > 0);
        }
      },
    ));
  });
});

// ─── Section D: capability declaration now targets execute:wave:pre ─────────

describe('D. capability.json declares the contribution at execute:wave:pre (#2285)', () => {
  test('[happy] contribution point is execute:wave:pre, not execute:wave:post', () => {
    const cap = JSON.parse(fs.readFileSync(CAP_PATH, 'utf8'));
    const wavePreContrib = cap.contributions.find((c) => c.point === 'execute:wave:pre');
    assert.ok(wavePreContrib, 'capability.json must declare a contribution at execute:wave:pre');
    assert.strictEqual(wavePreContrib.into, 'executor');
    assert.strictEqual(wavePreContrib.when, 'claude_orchestration.enabled');
    assert.strictEqual(wavePreContrib.onError, 'skip');
    assert.strictEqual(wavePreContrib.fragment.path, 'fragments/execute-wave-pre.md');

    const wavePostContrib = cap.contributions.find((c) => c.point === 'execute:wave:post');
    assert.strictEqual(wavePostContrib, undefined, 'the capability must no longer contribute at execute:wave:post');
  });

  test('[happy] the declared fragment file exists on disk', () => {
    const fragPath = path.join(ROOT, 'capabilities', 'claude-orchestration', 'fragments', 'execute-wave-pre.md');
    assert.ok(fs.existsSync(fragPath), 'fragments/execute-wave-pre.md must exist');
    const content = fs.readFileSync(fragPath, 'utf8');
    assert.match(content, /execute:wave:pre/);
    assert.match(content, /resolve-wave-dispatch/);
  });
});

// ─── Section E: source-contract guard — execute-phase.md renders execute:wave:pre BEFORE dispatch ──

describe('E. execute-phase.md actually renders execute:wave:pre (the dead hook is now live)', () => {
  test('[happy] execute-phase.md invokes `loop render-hooks execute:wave:pre`', () => {
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(
      /loop render-hooks execute:wave:pre/.test(doc),
      'execute-phase.md must dispatch execute:wave:pre hooks (was declared in frontmatter but never rendered — #2285)',
    );
  });

  test('[happy] the execute:wave:pre render-hooks call site appears BEFORE the wave\'s Agent() dispatch (pre-wave, not post)', () => {
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const preHooksIdx = doc.indexOf('loop render-hooks execute:wave:pre');
    // Anchor on the actual per-wave dispatch call (step 3), not the generic
    // `subagent_type="gsd-executor"` mention in <runtime_compatibility> near the
    // top of the file — that mention predates the wave loop entirely and would
    // give a false "before" reading.
    const agentDispatchIdx = doc.indexOf('description="Execute plan {plan_number}');
    assert.ok(preHooksIdx !== -1, 'execute:wave:pre render-hooks call site must exist');
    assert.ok(agentDispatchIdx !== -1, 'the gsd-executor Agent() dispatch call site (step 3) must exist');
    assert.ok(
      preHooksIdx < agentDispatchIdx,
      `execute:wave:pre render-hooks (idx ${preHooksIdx}) must appear BEFORE the wave's Agent() dispatch (idx ${agentDispatchIdx}) — it is a pre-wave hook`,
    );
  });

  test('[happy] the frontmatter still declares all four execute:* points (regression guard)', () => {
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const frontmatterMatch = doc.match(/points:\s*(.+)/);
    assert.ok(frontmatterMatch, 'frontmatter must declare a points: line');
    for (const point of ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post']) {
      assert.ok(frontmatterMatch[1].includes(point), `frontmatter points: line must include ${point}`);
    }
  });

  test('[happy] execute:wave:post is still rendered too (regression guard — did not accidentally remove the post-wave gate dispatch)', () => {
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(
      /loop render-hooks execute:wave:post/.test(doc),
      'execute-phase.md must still dispatch execute:wave:post hooks (drift/ui gates unaffected by #2285)',
    );
  });
});

// ─── Section F: orthogonal-review finding 1 — submodule plans never forced into worktree isolation ──
//
// #2772 / #2285 finding 1: emitWorkflowScript previously hardcoded
// `isolation: "worktree"` for EVERY plan. execute-phase.md step 2.5 computes
// USE_WORKTREES_FOR_PLAN per plan specifically to keep submodule-touching
// plans OUT of worktree isolation (the executor commit protocol cannot
// correctly handle submodule commits inside an isolated worktree). The
// Workflow backend must honor the SAME per-plan decision via `use_worktree`.

function waveWithSubmodulePlan() {
  return {
    phaseDir: '.planning/phases/01-foo',
    runId: 'run-2285-submodule',
    waves: [
      {
        id: 'w1',
        plans: [
          { id: 'p1', brief: 'normal plan', files_modified: ['src/a.ts'] },
          { id: 'p2', brief: 'submodule plan', files_modified: ['vendor/lib.c'], use_worktree: false },
        ],
      },
    ],
  };
}

describe('F. Workflow backend never forces worktree isolation on a submodule / use_worktree:false plan', () => {
  test('[happy] resolveWaveDispatch (pure seam): the submodule plan\'s agent() call carries NO isolation, the normal plan\'s does', () => {
    const result = resolveWaveDispatch(baseInput({ ...waveWithSubmodulePlan() }));
    assert.strictEqual(result.backend, 'workflow');
    assert.match(result.script, /agent\("normal plan", \{ agentType: "gsd-executor", isolation: "worktree" \}\)/);
    // #2686: the options object legitimately gained an optional `model` key, so assert
    // the invariant this test exists to protect — agentType present, isolation absent —
    // rather than a frozen literal that any future additive key would break.
    assert.match(result.script, /agent\("submodule plan", \{ agentType: "gsd-executor"[^}]*\}\)/);
    assert.ok(
      !/agent\("submodule plan"[^)]*isolation/.test(result.script),
      'the submodule-touching plan must NEVER be emitted with forced worktree isolation',
    );
  });

  test('[happy] CLI `resolve-wave-dispatch`: same per-plan guarantee end-to-end through the subprocess', () => {
    const tmp = createTempDir('fix-2285-submodule-');
    try {
      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.planning', 'config.json'),
        JSON.stringify({ claude_orchestration: { enabled: true, execution_backend: 'auto' } }),
      );
      const wavesPath = path.join(tmp, 'waves.json');
      fs.writeFileSync(wavesPath, JSON.stringify({ waves: waveWithSubmodulePlan().waves }));

      const res = runGsdTools([
        'claude-orchestration', 'resolve-wave-dispatch',
        '--waves', wavesPath,
        '--run-id', 'run-2285-submodule',
        '--phase-dir', '.planning/phases/01-foo',
        '--runtime', 'claude',
        '--agent-sdk-version', ABOVE_FLOOR_SDK,
        '--raw',
      ], tmp);
      assert.strictEqual(res.success, true, 'CLI command must succeed; stderr: ' + (res.error || ''));
      const parsed = JSON.parse(res.output);
      assert.strictEqual(parsed.backend, 'workflow');
      // #2686: additive `model` key — see the note on the pure-seam test above.
      assert.match(parsed.script, /agent\("submodule plan", \{ agentType: "gsd-executor"[^}]*\}\)/);
      assert.ok(!/agent\("submodule plan"[^)]*isolation/.test(parsed.script));
    } finally {
      cleanup(tmp);
    }
  });

  test('[negative] use_worktree defaults to true when omitted — a manifest with NO submodule info stays backward-compatible', () => {
    const result = resolveWaveDispatch(baseInput());
    assert.strictEqual(result.backend, 'workflow');
    assert.match(result.script, /isolation: "worktree"/, 'default (no use_worktree field) must still isolate — backward compatible');
  });
});

// ─── Section G: orthogonal-review finding 2 — missing top-level `waves` key must never silently exit 0 ──
//
// readWavesManifest previously collapsed "read/parse threw" and "parsed OK but
// no top-level `waves` key" into the same `undefined` sentinel. The call sites'
// `if (waves === undefined) return;` made the missing-key case exit 0 with ZERO
// output — fail-silent, breaking the "exit 0 => parseable JSON verdict" contract.
// A missing key must now flow through to emitWorkflowScript's own validation,
// exactly like an explicit `{"waves": null}` manifest already does.

describe('G. missing top-level `waves` key never silently exits 0 with no output', () => {
  function projectWithEnabledCapability(prefix) {
    const tmp = createTempDir(prefix);
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.planning', 'config.json'),
      JSON.stringify({ claude_orchestration: { enabled: true, execution_backend: 'auto' } }),
    );
    return tmp;
  }

  test('[negative] resolve-wave-dispatch with a {"notwaves":[]} manifest → non-empty JSON verdict (NOT silent exit 0)', () => {
    const tmp = projectWithEnabledCapability('fix-2285-missingkey-resolve-');
    try {
      const wavesPath = path.join(tmp, 'waves.json');
      fs.writeFileSync(wavesPath, JSON.stringify({ notwaves: [] }));

      const res = runGsdTools([
        'claude-orchestration', 'resolve-wave-dispatch',
        '--waves', wavesPath, '--run-id', 'run-x',
        '--runtime', 'claude', '--agent-sdk-version', ABOVE_FLOOR_SDK,
        '--raw',
      ], tmp);

      assert.strictEqual(res.success, true, 'command must exit 0 (fail-closed to inline, not error); stderr: ' + (res.error || ''));
      assert.ok(res.output.length > 0, 'FAIL-SILENT REGRESSION: missing waves key must NOT produce empty stdout on exit 0');
      const parsed = JSON.parse(res.output);
      assert.strictEqual(parsed.backend, 'inline');
      assert.match(parsed.reason, /waves must be a non-empty array/, 'reason must surface emitWorkflowScript\'s own validation message');
    } finally {
      cleanup(tmp);
    }
  });

  test('[negative] resolve-wave-dispatch: {"notwaves":[]} and {"waves": null} produce the IDENTICAL verdict (parity)', () => {
    const tmp = projectWithEnabledCapability('fix-2285-missingkey-parity-');
    try {
      const missingKeyPath = path.join(tmp, 'missing.json');
      fs.writeFileSync(missingKeyPath, JSON.stringify({ notwaves: [] }));
      const nullWavesPath = path.join(tmp, 'null.json');
      fs.writeFileSync(nullWavesPath, JSON.stringify({ waves: null }));

      const argsFor = (p) => [
        'claude-orchestration', 'resolve-wave-dispatch',
        '--waves', p, '--run-id', 'run-x',
        '--runtime', 'claude', '--agent-sdk-version', ABOVE_FLOOR_SDK,
        '--raw',
      ];
      const missingRes = runGsdTools(argsFor(missingKeyPath), tmp);
      const nullRes = runGsdTools(argsFor(nullWavesPath), tmp);
      assert.strictEqual(missingRes.success, true);
      assert.strictEqual(nullRes.success, true);
      assert.deepStrictEqual(JSON.parse(missingRes.output), JSON.parse(nullRes.output), 'a missing `waves` key must behave identically to an explicit `waves: null`');
    } finally {
      cleanup(tmp);
    }
  });

  test('[negative] emit-workflow with a {"notwaves":[]} manifest → loud non-zero exit (NOT silent exit 0)', () => {
    const tmp = createTempDir('fix-2285-missingkey-emit-');
    try {
      const wavesPath = path.join(tmp, 'waves.json');
      fs.writeFileSync(wavesPath, JSON.stringify({ notwaves: [] }));

      const res = runGsdTools([
        'claude-orchestration', 'emit-workflow',
        '--waves', wavesPath, '--run-id', 'run-x',
      ], tmp);

      assert.strictEqual(res.success, false, 'FAIL-SILENT REGRESSION: missing waves key must produce a loud, non-zero-exit error, not a silent success');
      assert.ok(res.exitCode !== 0, 'non-zero exit');
      assert.match(res.error || '', /waves must be a non-empty array/);
    } finally {
      cleanup(tmp);
    }
  });

  test('[happy] a genuinely malformed (unparseable) --waves file still fails loudly, unaffected by the fix', () => {
    const tmp = createTempDir('fix-2285-badjson-');
    try {
      const wavesPath = path.join(tmp, 'waves.json');
      fs.writeFileSync(wavesPath, 'not json at all');

      const res = runGsdTools([
        'claude-orchestration', 'resolve-wave-dispatch',
        '--waves', wavesPath, '--run-id', 'run-x', '--raw',
      ], tmp);
      assert.strictEqual(res.success, false, 'a real parse failure must still error');
      assert.match(res.error || '', /could not read\/parse --waves file/);
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── Section H: orthogonal-review finding 3 — manifest construction guidance is concrete ──

describe('H. the execute:wave:pre fragment documents concrete manifest construction (finding 3)', () => {
  test('[happy] the fragment explains how to build WAVE_MANIFEST_PATH, PHASE_RUN_ID, and per-plan use_worktree', () => {
    const fragPath = path.join(ROOT, 'capabilities', 'claude-orchestration', 'fragments', 'execute-wave-pre.md');
    const content = fs.readFileSync(fragPath, 'utf8');
    assert.match(content, /Manifest construction/, 'fragment must have concrete manifest-construction guidance, not just reference undefined vars');
    assert.match(content, /PHASE_RUN_ID/);
    assert.match(content, /WAVE_MANIFEST_PATH/);
    assert.match(content, /use_worktree/);
    assert.match(content, /USE_WORKTREES_FOR_PLAN/, 'must tie use_worktree back to step 2.5\'s per-plan decision');
  });

  test('[happy] execute-phase.md step 2.75 stays minimal — manifest/use_worktree detail lives ONLY in the fragment (#1168 byte-budget conformance)', () => {
    // Per the ADR-857 Phase 6 conformance gate (tests/phase6-capstone-conformance.test.cjs),
    // the host loop must stay small — optional-feature detail (manifest construction,
    // per-plan use_worktree carry-through) belongs in the capability fragment, not the
    // host workflow. Step 2.75 is intentionally just a render-hooks call + a one-line
    // "follow the contribution or fall through to step 3" instruction.
    const doc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const stepStart = doc.indexOf('2.75. **Execute:wave:pre capability dispatch:**');
    const stepEnd = doc.indexOf('\n3. **Spawn executor agents:**', stepStart);
    assert.ok(stepStart !== -1 && stepEnd !== -1, 'step 2.75 must exist and precede step 3');
    const stepBody = doc.slice(stepStart, stepEnd);
    assert.match(stepBody, /loop render-hooks execute:wave:pre/, 'step 2.75 must still render the hook point');
    assert.doesNotMatch(stepBody, /use_worktree/, 'manifest-construction detail (use_worktree) must live in the fragment, not the host step');
    assert.doesNotMatch(stepBody, /USE_WORKTREES_FOR_PLAN/, 'per-plan worktree gate detail must live in the fragment, not the host step');
  });

  test('[happy] execute-phase.md is below the ADR-857 Phase 6 pre-phase-6 byte ceiling (#1168), with margin', () => {
    const { lfByteCount } = require('../scripts/workflow-size.cjs');
    const bytes = lfByteCount(WORKFLOW_PATH);
    assert.ok(bytes < 93600, `execute-phase.md must stay below the frozen pre-phase-6 ceiling (93600); got ${bytes}`);
    assert.ok(bytes <= 93400, `execute-phase.md should carry a comfortable margin (<=93400) so minor future edits don't re-trip the gate; got ${bytes}`);
  });
});

// ─── Section I: orthogonal-review finding 4 — stale doc fixed ───────────────

describe('I. docs/explanation/claude-orchestration-capability.md reflects the execute:wave:pre move (finding 4)', () => {
  test('[happy] the doc no longer claims the capability registers at execute:wave:post', () => {
    const docPath = path.join(ROOT, 'docs', 'explanation', 'claude-orchestration-capability.md');
    const content = fs.readFileSync(docPath, 'utf8');
    assert.match(content, /execute:wave:pre/, 'doc must mention execute:wave:pre as the wired point');
    assert.ok(
      !/execute:wave:post.*\(into the executor\)/.test(content),
      'doc must not still claim the wired point is execute:wave:post',
    );
  });
});
