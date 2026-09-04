'use strict';

/**
 * ADR-1239 Phase A: Descriptor tests — validate that all 16 role:runtime
 * capability descriptors have correct hostIntegration axes, pass the validator,
 * and negotiate correctly via the host-integration module.
 *
 * Expectations are derived from the generated capability registry and
 * .host-cli-final.json (source of truth). Values are verbatim; 'undocumented'
 * sentinels fail-closed in negotiation (safe documented default, never propagate).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  negotiateHostCapabilities,
  profileOf,
  shouldFlattenDispatch,
} = require(path.join(__dirname, '../gsd-core/bin/lib/host-integration.cjs'));

const registry = require(path.join(__dirname, '../gsd-core/bin/lib/capability-registry.cjs'));

const {
  validateCapability,
} = require(path.join(__dirname, '../gsd-core/bin/lib/capability-validator.cjs'));

// Folded from tests/fix-2598-opencode-background-dispatch.test.cjs and
// tests/fix-2603-kimi-code-host-matrix.test.cjs (#3333, test-hygiene backlog).
const ROOT = path.join(__dirname, '..');
const OPENCODE_DESCRIPTOR = path.join(ROOT, 'capabilities', 'opencode', 'capability.json');
const KIMI_CODE_DESCRIPTOR = path.join(ROOT, 'capabilities', 'kimi-code', 'capability.json');
const HOST_INTEGRATION_MATRIX = path.join(ROOT, 'docs', 'reference', 'host-integration-capability-matrix.md');

function opencodeDispatch() {
  const parsed = JSON.parse(fs.readFileSync(OPENCODE_DESCRIPTOR, 'utf8'));
  return parsed.runtime.hostIntegration.dispatch;
}

function kimiCodeAxes() {
  return JSON.parse(fs.readFileSync(KIMI_CODE_DESCRIPTOR, 'utf8')).runtime.hostIntegration;
}

/** Extract the `## <host>` section body, stopping at the next top-level host heading. */
function matrixSection(host) {
  const matrix = fs.readFileSync(HOST_INTEGRATION_MATRIX, 'utf8');
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

// All 8 scalar hostIntegration axis keys
const SCALAR_AXES = ['embeddingMode', 'commandSurface', 'modelMode', 'hookBus', 'stateIO', 'transport', 'runtime'];
// All 6 dispatch sub-keys (includes backgroundDispatch added in feat/1679-dispatch-flatten)
const DISPATCH_KEYS = ['namedDispatch', 'nested', 'maxDepth', 'background', 'subagentToolkit', 'backgroundDispatch'];

// Runtime ids are derived from the registry (the single source of truth) so the
// suite stays fluid when a runtime descriptor is added or removed. The profile
// and flatten maps below remain CURATED pins — they catch an accidental axis
// flip (e.g. a descriptor changing embeddingMode silently moves its profile).
const RUNTIME_IDS = Object.keys(registry.runtimes);

// Contract-pinned profile split (derived from .host-cli-final.json):
// programmatic-cli: claude, cline, cursor, hermes, kilo, kimi, opencode, pi, qwen, trae (10)
// declarative-cli:  antigravity, augment, codebuddy, codex, copilot, kimi-code, windsurf, zcode (8)
// kimi-code moved programmatic-cli → declarative-cli in #2603: its plugin surface is a
// `kimi.plugin.json` manifest plus markdown Skills with no in-process programmatic API
// (docs/en/customization/plugins.md), the same shape as codex. The value had been inherited
// from the Python `kimi` descriptor rather than sourced for Kimi Code CLI.
// ide: vscode (1) — #2103, the first installed ide-profile host.
const EXPECTED_PROFILES = {
  claude:      'programmatic-cli',
  cline:       'programmatic-cli',
  cursor:      'programmatic-cli',
  hermes:      'programmatic-cli',
  kilo:        'programmatic-cli',
  kimi:        'programmatic-cli',
  opencode:    'programmatic-cli',
  pi:          'programmatic-cli',
  qwen:        'programmatic-cli',
  trae:        'programmatic-cli',
  antigravity: 'declarative-cli',
  augment:     'declarative-cli',
  codebuddy:   'declarative-cli',
  codex:       'declarative-cli',
  copilot:     'declarative-cli',
  'kimi-code': 'declarative-cli',
  windsurf:    'declarative-cli',
  zcode:       'declarative-cli',
  vscode:      'ide',
};

describe('ADR-1239 Phase A: hostIntegration descriptors', () => {
  // ─── Registry shape ──────────────────────────────────────────────────────────

  test('registry.runtimes exactly equals the curated RUNTIME_IDS set (count-agnostic)', () => {
    // RUNTIME_IDS is derived from the registry above, so this asserts internal
    // consistency: the curated profile/flatten maps cover every registry runtime
    // exactly once, no matter how many exist.
    for (const id of RUNTIME_IDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(registry.runtimes, id),
        'registry.runtimes must contain "' + id + '"',
      );
    }
    assert.deepStrictEqual(
      Object.keys(registry.runtimes).sort(),
      [...RUNTIME_IDS].sort(),
      'registry.runtimes key set must match RUNTIME_IDS',
    );
  });

  // ─── Per-runtime assertions ───────────────────────────────────────────────────

  for (const id of RUNTIME_IDS) {
    describe('runtime: ' + id, () => {
      const cap = registry.runtimes[id];
      const hi = cap && cap.runtime && cap.runtime.hostIntegration;

      // (i) Validator passes with zero errors
      test('(i) validateCapability returns zero errors', () => {
        const errors = validateCapability(cap, id);
        assert.deepEqual(
          errors,
          [],
          id + ': validateCapability must return no errors, got: ' + JSON.stringify(errors),
        );
      });

      // (ii) hostIntegration object is present with all required keys
      test('(ii) cap.runtime.hostIntegration is present with all 8 axis keys and 6 dispatch sub-keys', () => {
        assert.ok(
          hi !== undefined && hi !== null && typeof hi === 'object',
          id + ': cap.runtime.hostIntegration must be a non-null object',
        );
        // All 8 scalar axes present
        for (const axis of SCALAR_AXES) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(hi, axis),
            id + ': hostIntegration must have axis "' + axis + '"',
          );
        }
        // dispatch is an object
        assert.ok(
          hi.dispatch !== null && typeof hi.dispatch === 'object',
          id + ': hostIntegration.dispatch must be a non-null object',
        );
        // All 5 dispatch sub-keys present
        for (const key of DISPATCH_KEYS) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(hi.dispatch, key),
            id + ': hostIntegration.dispatch must have key "' + key + '"',
          );
        }
      });

      // (iii) negotiateHostCapabilities does not throw and behaves correctly
      test('(iii) negotiateHostCapabilities: documented scalars pass through; undocumented scalars degrade with warning', () => {
        assert.ok(hi, id + ': hostIntegration must exist to negotiate');
        let result;
        assert.doesNotThrow(() => {
          result = negotiateHostCapabilities(hi);
        }, id + ': negotiateHostCapabilities must not throw');

        const eff = result.effective;

        // For each scalar axis: if declared !== 'undocumented', effective === declared
        // If declared === 'undocumented', effective !== 'undocumented' (safe default) and
        // warnings must mention that axis.
        for (const axis of SCALAR_AXES) {
          const declared = hi[axis];
          if (declared !== 'undocumented') {
            assert.strictEqual(
              eff[axis],
              declared,
              id + ': effective.' + axis + ' must equal declared (' + JSON.stringify(declared) + '), got: ' + JSON.stringify(eff[axis]),
            );
          } else {
            // fail-closed: effective must be a documented safe default, not 'undocumented'
            assert.notStrictEqual(
              eff[axis],
              'undocumented',
              id + ': effective.' + axis + ' must NOT be "undocumented" (fail-closed)',
            );
            // warnings must mention this axis
            const mentionsAxis = result.warnings.some((w) => w.includes(axis));
            assert.ok(
              mentionsAxis,
              id + ': result.warnings must mention axis "' + axis + '" when declared is undocumented, got: ' + JSON.stringify(result.warnings),
            );
          }
        }
      });

      // (iii-b) dispatch negotiation for namedDispatch
      test('(iii-b) dispatch.namedDispatch negotiation', () => {
        assert.ok(hi, id + ': hostIntegration must exist to negotiate');
        const result = negotiateHostCapabilities(hi);

        const declaredND = hi.dispatch && hi.dispatch.namedDispatch;

        if (declaredND === true) {
          // documented as true → effective must be true
          assert.strictEqual(
            result.effective.dispatch.namedDispatch,
            true,
            id + ': effective.dispatch.namedDispatch must be true when declared is true',
          );
        } else if (declaredND === 'undocumented') {
          // undocumented → fail-closed: effective namedDispatch must be false
          assert.strictEqual(
            result.effective.dispatch.namedDispatch,
            false,
            id + ': effective.dispatch.namedDispatch must be false when declared is "undocumented" (fail-closed)',
          );
          // dispatch.effectiveLevel must be 'absent' (no named dispatch)
          assert.strictEqual(
            result.points.dispatch.effectiveLevel,
            'absent',
            id + ': points.dispatch.effectiveLevel must be "absent" when namedDispatch is undocumented',
          );
        }
      });

      // (iv) profileOf returns expected profile
      test('(iv) profileOf returns expected profile', () => {
        assert.ok(hi, id + ': hostIntegration must exist to profile');
        const profile = profileOf(hi);
        assert.ok(
          profile !== null,
          id + ': profileOf must return a non-null profile',
        );
        assert.strictEqual(
          profile,
          EXPECTED_PROFILES[id],
          id + ': profileOf must return "' + EXPECTED_PROFILES[id] + '" (got: "' + profile + '")',
        );
      });
    });
  }

  // ─── Contract-pin profile split ───────────────────────────────────────────────

  test('contract-pin: profile split is internally consistent with EXPECTED_PROFILES (count-agnostic)', () => {
    // The counts are DERIVED from the curated EXPECTED_PROFILES map rather than
    // hand-pinned, so adding a runtime + its profile entry updates the counts
    // automatically. #2103: vscode is now the first installed ide-profile host,
    // so 'ide' is no longer pinned at a hardcoded 0 — it is derived below like
    // the other two profiles.
    const counts = { 'programmatic-cli': 0, 'declarative-cli': 0, 'ide': 0 };
    for (const id of RUNTIME_IDS) {
      const cap = registry.runtimes[id];
      const hi = cap && cap.runtime && cap.runtime.hostIntegration;
      assert.ok(hi, id + ': hostIntegration must exist for profile count');
      const profile = profileOf(hi);
      assert.ok(profile !== null, id + ': profileOf must be non-null');
      assert.strictEqual(profile, EXPECTED_PROFILES[id],
        id + ': profileOf must match EXPECTED_PROFILES (an axis may have flipped)');
      if (counts[profile] !== undefined) {
        counts[profile]++;
      }
    }
    // Derived expected counts from the curated map itself.
    const expectedCounts = { 'programmatic-cli': 0, 'declarative-cli': 0, 'ide': 0 };
    for (const p of Object.values(EXPECTED_PROFILES)) {
      if (expectedCounts[p] !== undefined) expectedCounts[p]++;
    }
    assert.strictEqual(counts['programmatic-cli'], expectedCounts['programmatic-cli']);
    assert.strictEqual(counts['declarative-cli'], expectedCounts['declarative-cli']);
    assert.strictEqual(counts['ide'], expectedCounts['ide'],
      'ide-profile count must match EXPECTED_PROFILES (#2103: vscode is the first ide-profile host)');
  });

  // ─── backgroundDispatch presence ─────────────────────────────────────────────

  test('every runtime descriptor has dispatch.backgroundDispatch (boolean or "undocumented")', () => {
    for (const id of RUNTIME_IDS) {
      const cap = registry.runtimes[id];
      const dispatch = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch;
      assert.ok(
        dispatch !== null && typeof dispatch === 'object',
        id + ': hostIntegration.dispatch must be an object',
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(dispatch, 'backgroundDispatch'),
        id + ': dispatch must have a backgroundDispatch key',
      );
      const v = dispatch.backgroundDispatch;
      assert.ok(
        v === true || v === false || v === 'undocumented',
        id + ': dispatch.backgroundDispatch must be true, false, or "undocumented", got: ' + JSON.stringify(v),
      );
    }
  });

  // ─── shouldFlattenDispatch per-host (#853 discriminator) ─────────────────────

  // Expected: false (may background) ONLY for cursor — the one shipped host whose
  // dispatch declares nested:true + subagentToolkit:"full" + a depth budget > 1.
  // true (must inline) for the other 17.
  //
  // #2939: the depth-aware rule reclassifies codex/kimi/kimi-code, which the old
  // two-field (background+backgroundDispatch) rule admitted as background-eligible
  // despite each lacking what a backgrounded nesting orchestrator actually needs:
  //   - codex: nested:true + full toolkit, BUT maxDepth:1 (no room for a depth-2 leaf)
  //   - kimi:  nested:false (cannot host a nesting orchestrator at all)
  //   - kimi-code: subagentToolkit:'built-in-only' (cannot delegate to full subagents)
  // cursor (maxDepth:2) remains the only background-capable host with a sufficient budget.
  const EXPECTED_FLATTEN = {
    antigravity: true,
    augment:     true,
    claude:      true,
    cline:       true,
    codebuddy:   true,
    codex:       true,
    copilot:     true,
    cursor:      false,
    hermes:      true,
    kilo:        true,
    // #2095/#2939: Kimi CAN background a single agent (backgroundDispatch:true), BUT
    // nested:false means a backgrounded kimi agent cannot nest the plan-checker/executor/
    // verifier pipeline the workflows require → flatten. backgroundDispatch stays true on
    // the descriptor (UPGRADE 2 holds); only the flatten consequence changes.
    kimi:        true,
    // #2454/#2939: Kimi Code declares background/backgroundDispatch both true, BUT
    // subagentToolkit:'built-in-only' cannot delegate to full subagents → flatten.
    'kimi-code': true,
    // #2598: OpenCode's background subagents sit behind the opt-in
    // OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS flag (default false), and the
    // session loop still handles one subtask at a time (upstream #29638, OPEN).
    // #2087 read v1.15/v1.17 as default-on; that does not hold against current
    // `dev`, so dispatch.background/backgroundDispatch are false → force-flattened.
    opencode:    true,
    // #2102: pi's dispatch.background/backgroundDispatch are both false
    // (undocumented background-subagent primitive) → force-flattened.
    pi:          true,
    qwen:        true,
    trae:        true,
    windsurf:    true,
    zcode:       true,
    // #2103: vscode's dispatch.backgroundDispatch is 'undocumented' (no
    // documented background-subagent primitive) → fails closed to false →
    // force-flattened, mirroring the pi (#2102) precedent above.
    vscode:      true,
  };

  for (const id of RUNTIME_IDS) {
    test('shouldFlattenDispatch(' + id + ') === ' + EXPECTED_FLATTEN[id], () => {
      const cap = registry.runtimes[id];
      const dispatch = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch;
      assert.ok(dispatch, id + ': dispatch must exist');
      const result = shouldFlattenDispatch(dispatch);
      assert.strictEqual(
        result,
        EXPECTED_FLATTEN[id],
        id + ': shouldFlattenDispatch must return ' + EXPECTED_FLATTEN[id] + ' (got: ' + result + ')',
      );
    });
  }

  test('contract-pin: background-eligible set matches EXPECTED_FLATTEN (count-agnostic)', () => {
    // The eligible set is DERIVED from the curated EXPECTED_FLATTEN map rather
    // than hand-pinned to a fixed pair, so a runtime whose dispatch axes change
    // updates the expectation automatically.
    const expectedEligible = RUNTIME_IDS
      .filter((id) => EXPECTED_FLATTEN[id] === false)
      .sort();
    const eligible = RUNTIME_IDS.filter((id) => {
      const cap = registry.runtimes[id];
      const dispatch = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch;
      return dispatch && shouldFlattenDispatch(dispatch) === false;
    }).sort();
    assert.deepEqual(eligible, expectedEligible,
      'background-eligible set must match EXPECTED_FLATTEN (a dispatch axis may have flipped)');
  });

  test('contract-pin: spot-check claude→programmatic-cli, codex→declarative-cli, opencode→programmatic-cli, windsurf→declarative-cli', () => {
    const checks = [
      ['claude', 'programmatic-cli'],
      ['codex', 'declarative-cli'],
      ['opencode', 'programmatic-cli'],
      ['windsurf', 'declarative-cli'],
    ];
    for (const [id, expectedProfile] of checks) {
      const cap = registry.runtimes[id];
      const hi = cap && cap.runtime && cap.runtime.hostIntegration;
      assert.ok(hi, id + ': hostIntegration must exist');
      const profile = profileOf(hi);
      assert.strictEqual(
        profile,
        expectedProfile,
        id + ': profileOf must return "' + expectedProfile + '" (got: "' + profile + '")',
      );
    }
  });

  // ─── NEGATIVE cases ───────────────────────────────────────────────────────────

  describe('NEGATIVE: invalid hostIntegration.embeddingMode triggers validator error', () => {
    test('embeddingMode "bogus" produces a validator error naming embeddingMode', () => {
      const cap = {
        id: 'test-neg',
        role: 'runtime',
        version: '1.0.0',
        title: 'Test Negative',
        description: 'Negative case for hostIntegration validation.',
        tier: 'core',
        requires: [],
        runtime: {
          configHome: { kind: 'dot-home', name: '.test-neg', env: [] },
          configFormat: 'settings-json',
          artifactLayout: { global: [], local: [] },
          commandStyle: 'slash-hyphen',
          hooksSurface: 'settings-json',
          hookEvents: 'claude',
          sandboxTier: 'none',
          supportTier: 1,
          installSurface: 'settings-json',
          writesSharedSettings: true,
          permissionWriter: null,
          extendedHookEvents: [],
          hostIntegration: {
            embeddingMode: 'bogus',
            commandSurface: 'slash-file',
            dispatch: { namedDispatch: true, nested: false, maxDepth: 1, background: false, subagentToolkit: 'full', backgroundDispatch: false },
            modelMode: 'passive',
            hookBus: 'host',
            stateIO: 'filesystem',
            transport: 'mcp',
            runtime: 'node',
          },
        },
      };
      const errors = validateCapability(cap, 'test-neg');
      assert.ok(errors.length > 0, 'Expected validation errors for bogus embeddingMode');
      assert.ok(
        errors.some((e) => e.includes('embeddingMode')),
        'At least one error must mention embeddingMode, got: ' + JSON.stringify(errors),
      );
    });
  });

  describe('NEGATIVE: missing hostIntegration produces required-object error', () => {
    test('runtime body without hostIntegration produces the required-object error', () => {
      const cap = {
        id: 'test-missing-hi',
        role: 'runtime',
        version: '1.0.0',
        title: 'Test Missing HI',
        description: 'Negative case for missing hostIntegration.',
        tier: 'core',
        requires: [],
        runtime: {
          configHome: { kind: 'dot-home', name: '.test-missing-hi', env: [] },
          configFormat: 'settings-json',
          artifactLayout: { global: [], local: [] },
          commandStyle: 'slash-hyphen',
          hooksSurface: 'settings-json',
          hookEvents: 'claude',
          sandboxTier: 'none',
          supportTier: 1,
          installSurface: 'settings-json',
          writesSharedSettings: true,
          permissionWriter: null,
          extendedHookEvents: [],
          // hostIntegration intentionally absent
        },
      };
      const errors = validateCapability(cap, 'test-missing-hi');
      assert.ok(errors.length > 0, 'Expected validation errors for missing hostIntegration');
      assert.ok(
        errors.some((e) => e.includes('hostIntegration') && e.includes('required')),
        'At least one error must mention hostIntegration and required, got: ' + JSON.stringify(errors),
      );
    });
  });
});

// allow-test-rule: source-text-is-the-product #2598 — the descriptor JSON and the
// host-integration matrix ARE the negotiated contract; asserting their values is behavioral.
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
    const matrix = fs.readFileSync(HOST_INTEGRATION_MATRIX, 'utf8');
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

// allow-test-rule: source-text-is-the-product #2603 — the descriptor JSON and the
// host-integration matrix ARE the negotiated contract; asserting their values is behavioral.
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

describe('#3747: matrix must not cite the disproven configHome skills path for antigravity', () => {
  // The stateIO row sourced its evidence from an explainx.ai blog claiming the
  // CLI reads global skills from ~/.gemini/antigravity-cli/skills/. A live
  // `agy` 1.1.17 probe (#3747) disproved that: the CLI scans
  // ~/.gemini/config/skills (where #3738 installs them) and silently drops
  // everything under the configHome. The doc must not re-assert the dead path.
  test('antigravity section cites no configHome skills path; evidence names ~/.gemini/config/skills', () => {
    const section = matrixSection('antigravity');
    assert.ok(section, 'antigravity section must exist in the host-integration matrix');
    const offending = section.split('\n').filter((l) => /antigravity(-cli|-ide)?\/skills/i.test(l));
    assert.deepStrictEqual(
      offending,
      [],
      `matrix rows must not cite a configHome skills dir (~/.gemini/antigravity*/skills) as the CLI's skills location — disproven by the #3747 live agy probe:\n${offending.join('\n')}`,
    );
    const stateIORow = section.split('\n').find((l) => l.startsWith('| stateIO |'));
    assert.ok(stateIORow, 'stateIO row must exist');
    assert.ok(
      stateIORow.includes('~/.gemini/config/skills'),
      `stateIO evidence must name the live-probe-verified ~/.gemini/config/skills discovery dir, got: ${stateIORow}`,
    );
  });
});
