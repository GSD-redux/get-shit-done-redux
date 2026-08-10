'use strict';
/**
 * Failing-first suite for `resolveTriggerSurface` (#2871 Phase 2).
 *
 * `resolveTriggerSurface` does NOT exist yet in src/runtime-artifact-layout.cts
 * (nor in its built gsd-core/bin/lib/runtime-artifact-layout.cjs counterpart).
 * Every test below is expected to FAIL until it lands — see
 * .gsd/phase/feat-2871-trigger-resolution/50-test-matrix.md (rows 1-23) and
 * .gsd/phase/feat-2871-trigger-resolution/40-design.md for the contract this
 * suite locks.
 *
 * Idiom: per-runtime `describe` + explicit field assertions, matching the
 * other four runtime-artifact-layout*.test.cjs files. No table-driven format.
 *
 * ── Stem-injection shape (design call made by this suite) ──────────────────
 * `resolveTriggerSurface` is pure — no filesystem, no `configDir`. Stems are
 * injected via `opts`:
 *
 *   opts = {
 *     stems: string[],                          // source command/skill stems
 *                                                // present for this call, shared
 *                                                // across every trigger-bearing
 *                                                // kind entry (mirrors ResolvedProfile's
 *                                                // flat stem membership at staging
 *                                                // time — see install-profiles.cts).
 *     routerStems?: string[],                    // subset of `stems` that are
 *                                                // namespace routers (nested-router
 *                                                // runtimes only — #69).
 *     childToRouters?: Record<string, string[]>, // concrete stem -> owning
 *                                                // router stem(s); mirrors
 *                                                // buildNamespaceBundleMap's
 *                                                // childToRouters shape.
 *     registry?: { runtimes: {...} },            // full registry override —
 *                                                // the SAME seam
 *                                                // resolveRuntimeArtifactLayoutFromRegistry
 *                                                // already exposes in this file. Lets a
 *                                                // synthetic descriptor (row 12's
 *                                                // namespacedByDir fixture, row 22's
 *                                                // reordered triggerPrecedence) be
 *                                                // exercised without touching the real
 *                                                // capability-registry.
 *   }
 *
 * destPath (also a design call, since no in-tree fixture exercises row 12
 * today): `${destSubpath}/${prefix}${stem}` for skills (the skill directory);
 * `${destSubpath}/${prefix}${stem}.md` for a flat commands entry; and, when
 * `_copyStaged`'s namespacedByDir branch applies (destSubpath's basename ===
 * prefix minus its trailing '-'), `${destSubpath}/${stem}.md` — bare, no
 * prefix on the filename, matching _copyStaged's actual write (row 12). The
 * `trigger` string itself is ALWAYS `${prefix}${stem}` regardless of branch —
 * it is what the user types, not a filesystem detail.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const runtimeArtifactLayout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { resolveTriggerSurface } = runtimeArtifactLayout;
const capabilityRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
const capValidator = require('../gsd-core/bin/lib/capability-validator.cjs');

const REPO_ROOT = path.join(__dirname, '..');

/** A real shipped capability.json, parsed fresh (fixture-provenance rule #2371 —
 *  see tests/effort-surface-axis.test.cjs's shippedDescriptorWithout for the
 *  precedent this mirrors: a hand-built descriptor only ever encodes the
 *  author's mental model, which is how required-axis defects reach the runner). */
function shippedCap(runtimeId) {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'capabilities', runtimeId, 'capability.json'), 'utf8'),
  );
}

const VALID_KINDS = new Set(['commands', 'skills']);
const VALID_SCOPES = new Set(['global', 'local']);
const VALID_REGISTRATIONS = new Set(['direct', 'via-router']);

/** Structural + referential shape-check for a resolveTriggerSurface() result. */
function assertValidSurfaceArray(surfaces, label) {
  assert.ok(Array.isArray(surfaces), `${label}: must return an array`);
  for (const s of surfaces) {
    assert.strictEqual(typeof s.trigger, 'string', `${label}: trigger must be a string`);
    assert.ok(s.trigger.length > 0, `${label}: trigger must be non-empty`);
    assert.ok(VALID_KINDS.has(s.kind), `${label}: kind must be commands|skills, got ${s.kind}`);
    assert.ok(VALID_SCOPES.has(s.scope), `${label}: scope must be global|local, got ${s.scope}`);
    assert.strictEqual(typeof s.destPath, 'string', `${label}: destPath must be a string`);
    assert.ok(s.destPath.length > 0, `${label}: destPath must be non-empty`);
    assert.ok(VALID_REGISTRATIONS.has(s.registration), `${label}: registration must be direct|via-router, got ${s.registration}`);
    if (s.registration === 'via-router') {
      assert.strictEqual(typeof s.routerTrigger, 'string', `${label}: via-router entries must name routerTrigger`);
    } else {
      assert.strictEqual(s.routerTrigger, null, `${label}: direct entries must have routerTrigger === null`);
    }
    if (s.shadowedBy !== null) {
      assert.ok(VALID_KINDS.has(s.shadowedBy.kind), `${label}: shadowedBy.kind invalid`);
      assert.ok(VALID_SCOPES.has(s.shadowedBy.scope), `${label}: shadowedBy.scope invalid`);
      const sibling = surfaces.find(
        (o) => o !== s && o.trigger === s.trigger && o.kind === s.shadowedBy.kind && o.scope === s.shadowedBy.scope,
      );
      assert.ok(sibling, `${label}: shadowedBy must name a real sibling entry for trigger ${s.trigger}`);
      assert.strictEqual(sibling.shadowedBy, null, `${label}: the named shadowedBy sibling must itself be a winner`);
    }
  }
}

// ─── Behavior table (matrix rows 1-15) ──────────────────────────────────────

describe('resolveTriggerSurface — claude', () => {
  test('claude reports every local command trigger as shadowed by the global skill', () => {
    const stems = ['plan-phase', 'help'];
    const result = resolveTriggerSurface('claude', ['global', 'local'], { stems });
    assert.strictEqual(result.length, stems.length * 2);
    for (const stem of stems) {
      const trigger = `gsd-${stem}`;
      const winner = result.find((s) => s.trigger === trigger && s.kind === 'skills' && s.scope === 'global');
      const loser = result.find((s) => s.trigger === trigger && s.kind === 'commands' && s.scope === 'local');
      assert.ok(winner, `missing global skills entry for ${trigger}`);
      assert.ok(loser, `missing local commands entry for ${trigger}`);
      assert.strictEqual(winner.shadowedBy, null, `${trigger}: global skills entry must be unshadowed`);
      assert.deepStrictEqual(loser.shadowedBy, { kind: 'skills', scope: 'global' }, `${trigger}: local commands entry must name the global skill as its shadower`);
      assert.strictEqual(winner.destPath, `skills/${trigger}`);
      assert.strictEqual(loser.destPath, `commands/${trigger}.md`);
      assert.strictEqual(winner.registration, 'direct');
      assert.strictEqual(loser.registration, 'direct');
      assert.strictEqual(winner.routerTrigger, null);
      assert.strictEqual(loser.routerTrigger, null);
    }
  });

  test('claude global alone shadows nothing', () => {
    const stems = ['plan-phase', 'help'];
    const result = resolveTriggerSurface('claude', ['global'], { stems });
    assert.strictEqual(result.length, stems.length);
    for (const s of result) {
      assert.strictEqual(s.kind, 'skills');
      assert.strictEqual(s.scope, 'global');
      assert.strictEqual(s.shadowedBy, null);
    }
  });

  test('claude local alone shadows nothing', () => {
    // #2218's healthy state: local reachable when nothing shadows it.
    const stems = ['plan-phase', 'help'];
    const result = resolveTriggerSurface('claude', ['local'], { stems });
    assert.strictEqual(result.length, stems.length);
    for (const s of result) {
      assert.strictEqual(s.kind, 'commands');
      assert.strictEqual(s.scope, 'local');
      assert.strictEqual(s.shadowedBy, null);
    }
  });

  test('no scopes yields no triggers', () => {
    assert.deepStrictEqual(resolveTriggerSurface('claude', [], { stems: ['plan-phase'] }), []);
  });
});

describe('resolveTriggerSurface — both-scope runtimes', () => {
  test('both-scope runtimes report same-kind shadowing', () => {
    // The 12 both-scope trigger-bearing runtimes excluding claude (claude has
    // its own dedicated rows above). windsurf is excluded too — its global
    // scope emits agents only, so it is NOT a both-scope trigger-bearing
    // runtime (see the dedicated windsurf test below).
    const BOTH_SCOPE_RUNTIMES = [
      'antigravity', 'augment', 'codebuddy', 'codex', 'copilot',
      'cursor', 'hermes', 'kilo', 'opencode', 'qwen', 'trae', 'zcode',
    ];
    for (const runtime of BOTH_SCOPE_RUNTIMES) {
      const result = resolveTriggerSurface(runtime, ['global', 'local'], { stems: ['plan-phase'] });
      const group = result.filter((s) => s.trigger === 'gsd-plan-phase');
      assert.ok(group.length >= 2, `${runtime}: expected at least 2 candidate entries, got ${group.length}`);
      const winners = group.filter((s) => s.shadowedBy === null);
      assert.strictEqual(winners.length, 1, `${runtime}: expected exactly one unshadowed winner, got ${winners.length}`);
      assert.strictEqual(winners[0].scope, 'global', `${runtime}: the winner must be the global entry`);
      for (const s of group) {
        if (s === winners[0]) continue;
        assert.deepStrictEqual(
          s.shadowedBy, { kind: winners[0].kind, scope: 'global' },
          `${runtime}: every non-winner must name the global winner's kind`,
        );
      }
    }
  });
});

describe('resolveTriggerSurface — global-only runtimes', () => {
  test('global-only runtimes report unshadowed triggers', () => {
    // cline/kimi/kimi-code declare local: [] — no special-casing, it falls
    // out of an empty local kind set even when 'local' is in `scopes`.
    for (const runtime of ['cline', 'kimi', 'kimi-code']) {
      const result = resolveTriggerSurface(runtime, ['global', 'local'], { stems: ['plan-phase'] });
      assert.ok(result.length > 0, `${runtime}: expected at least one trigger`);
      for (const s of result) {
        assert.strictEqual(s.scope, 'global', `${runtime}: unexpected non-global entry`);
        assert.strictEqual(s.shadowedBy, null, `${runtime}: global-only entry must be unshadowed`);
      }
    }
  });
});

describe('resolveTriggerSurface — no-artifact-surface runtimes', () => {
  test('runtimes with no artifact surface yield no triggers', () => {
    for (const runtime of ['pi', 'vscode']) {
      assert.deepStrictEqual(
        resolveTriggerSurface(runtime, ['global', 'local'], { stems: ['plan-phase'] }), [],
        `${runtime}: expected no triggers`,
      );
    }
  });
});

describe('resolveTriggerSurface — windsurf', () => {
  test('windsurf does not report a shadow it does not have', () => {
    // Global emits agents only (excluded) -> no global trigger. Local commands
    // (workflows) triggers must therefore be UNSHADOWED, not falsely reported
    // as shadowed by a global counterpart that doesn't exist.
    const result = resolveTriggerSurface('windsurf', ['global', 'local'], { stems: ['plan-phase'] });
    assert.strictEqual(result.length, 1, `expected exactly one trigger, got ${JSON.stringify(result)}`);
    const [entry] = result;
    assert.strictEqual(entry.trigger, 'gsd-plan-phase');
    assert.strictEqual(entry.kind, 'commands');
    assert.strictEqual(entry.scope, 'local');
    assert.strictEqual(entry.shadowedBy, null, 'windsurf must not report a shadow it does not have');
  });
});

describe('resolveTriggerSurface — agents exclusion', () => {
  test('agents are excluded from the trigger surface', () => {
    // claude local emits both commands and agents from the same source tree.
    const result = resolveTriggerSurface('claude', ['local'], { stems: ['plan-phase'] });
    assert.ok(!result.some((s) => s.kind === 'agents'), 'agents must never appear in the trigger surface');
    assert.ok(result.some((s) => s.kind === 'commands'), 'commands must still be present');
  });

  test('kimi-agents are excluded from the trigger surface', () => {
    const result = resolveTriggerSurface('kimi', ['global'], { stems: ['plan-phase'] });
    assert.ok(!result.some((s) => s.kind === 'kimi-agents'), 'kimi-agents must never appear in the trigger surface');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].kind, 'skills');
  });
});

describe('resolveTriggerSurface — nested-router runtimes (#69)', () => {
  test('nested runtimes distinguish direct from router-reachable registration', () => {
    const NESTED_ROUTER_RUNTIMES = ['cline', 'qwen', 'hermes', 'augment', 'trae'];
    const opts = {
      stems: ['ns-plan', 'plan-phase'],
      routerStems: ['ns-plan'],
      childToRouters: { 'plan-phase': ['ns-plan'] },
    };
    for (const runtime of NESTED_ROUTER_RUNTIMES) {
      const result = resolveTriggerSurface(runtime, ['global'], opts);
      const skillsEntries = result.filter((s) => s.kind === 'skills');
      const router = skillsEntries.find((s) => s.trigger === 'gsd-ns-plan');
      const child = skillsEntries.find((s) => s.trigger === 'gsd-plan-phase');
      assert.ok(router, `${runtime}: missing router skills entry`);
      assert.ok(child, `${runtime}: missing child skills entry`);
      assert.strictEqual(router.registration, 'direct', `${runtime}: the router itself registers direct`);
      assert.strictEqual(router.routerTrigger, null, `${runtime}: a router has no routerTrigger of its own`);
      assert.strictEqual(child.registration, 'via-router', `${runtime}: the child is only reachable via its router`);
      assert.strictEqual(child.routerTrigger, 'gsd-ns-plan', `${runtime}: the child must name its owning router`);
    }
  });
});

describe('resolveTriggerSurface — namespacedByDir (hostile fixture, #row 12)', () => {
  test('trigger honors the namespaced-by-directory layout', () => {
    // No in-tree descriptor trips _copyStaged's namespacedByDir branch today
    // (destSubpath's basename === prefix minus its trailing '-'). Synthetic
    // fixture via the registry-override seam, injected the same way
    // resolveRuntimeArtifactLayoutFromRegistry already accepts a registry.
    const registry = {
      runtimes: {
        'fixture-namespaced': {
          runtime: {
            artifactLayout: {
              global: [
                { kind: 'commands', destSubpath: 'commands/gsd', prefix: 'gsd-', nesting: 'flat', recursive: false, converter: null },
              ],
              local: [],
            },
          },
        },
      },
    };
    const result = resolveTriggerSurface('fixture-namespaced', ['global'], { stems: ['plan-phase'], registry });
    assert.strictEqual(result.length, 1);
    const [entry] = result;
    // The trigger (what the user types) is unaffected by the destPath branch.
    assert.strictEqual(entry.trigger, 'gsd-plan-phase');
    // destPath must go through the namespacedByDir branch: bare filename, no
    // double-applied prefix — NOT the naive `${destSubpath}/${prefix}${stem}.md`.
    assert.strictEqual(entry.destPath, 'commands/gsd/plan-phase.md');
    assert.notStrictEqual(entry.destPath, 'commands/gsd/gsd-plan-phase.md');
  });
});

describe('resolveTriggerSurface — unknown runtime', () => {
  test('rejects an unknown runtime with the established error contract', () => {
    assert.throws(
      () => resolveTriggerSurface('zorptron', ['global'], { stems: ['plan-phase'] }),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.ok(err.message.includes('zorptron'), 'error message must contain the runtime name');
        return true;
      },
    );
  });
});

describe('resolveTriggerSurface — purity', () => {
  test('is pure and does not mutate its input', () => {
    const scopes = ['global', 'local'];
    const opts = { stems: ['plan-phase', 'help'] };
    const scopesSnapshot = JSON.stringify(scopes);
    const optsSnapshot = JSON.stringify(opts);

    const first = resolveTriggerSurface('claude', scopes, opts);
    assert.strictEqual(JSON.stringify(scopes), scopesSnapshot, 'scopes array must not be mutated');
    assert.strictEqual(JSON.stringify(opts), optsSnapshot, 'opts object must not be mutated');

    const pristine = JSON.parse(JSON.stringify(first));
    // A caller mutating the returned array/objects must not corrupt a later call.
    first[0].trigger = 'HACKED';
    first.push({ trigger: 'INJECTED' });

    const second = resolveTriggerSurface('claude', scopes, opts);
    assert.deepStrictEqual(second, pristine, 'a second call must be unaffected by mutation of the first result');
  });
});

describe('resolveTriggerSurface — exhaustive sweep', () => {
  test('resolves for every runtime at every scope combination', () => {
    const runtimes = Object.keys(capabilityRegistry.runtimes);
    const scopeSubsets = [[], ['global'], ['local'], ['global', 'local']];
    for (const runtime of runtimes) {
      for (const scopes of scopeSubsets) {
        let result;
        assert.doesNotThrow(() => {
          result = resolveTriggerSurface(runtime, scopes, { stems: ['plan-phase', 'help'] });
        }, `${runtime} @ [${scopes.join(',')}] must not throw`);
        assertValidSurfaceArray(result, `${runtime} @ [${scopes.join(',')}]`);
      }
    }
  });
});

// ─── Precedence axis rows (matrix rows 16-23) ───────────────────────────────

describe('triggerPrecedence axis — validator', () => {
  test('a descriptor without the axis remains valid', () => {
    const cap = shippedCap('claude'); // real descriptor; declares no triggerPrecedence today
    assert.deepStrictEqual(capValidator.validateRuntimeBody(cap), []);
    assert.ok(Array.isArray(capValidator.DEFAULT_TRIGGER_PRECEDENCE), 'DEFAULT_TRIGGER_PRECEDENCE must be exported');
    assert.deepStrictEqual(capValidator.DEFAULT_TRIGGER_PRECEDENCE, ['skills', 'commands']);
  });

  test('every shipped descriptor validates with the new axis', () => {
    assert.ok(Array.isArray(capValidator.DEFAULT_TRIGGER_PRECEDENCE), 'DEFAULT_TRIGGER_PRECEDENCE must be exported');
    for (const runtime of Object.keys(capabilityRegistry.runtimes)) {
      const cap = shippedCap(runtime);
      const errors = capValidator.validateRuntimeBody(cap);
      assert.deepStrictEqual(errors, [], `${runtime}: expected clean validation, got ${JSON.stringify(errors)}`);
    }
  });

  test('rejects an empty precedence list', () => {
    const cap = shippedCap('claude');
    cap.runtime.triggerPrecedence = [];
    const errors = capValidator.validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => String(e).includes('triggerPrecedence')),
      `expected a triggerPrecedence error, got ${JSON.stringify(errors)}`,
    );
  });

  test('rejects an unknown kind in the precedence list', () => {
    const cap = shippedCap('claude');
    cap.runtime.triggerPrecedence = ['skills', 'bogus'];
    const errors = capValidator.validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => String(e).includes('triggerPrecedence') && String(e).includes('bogus')),
      `expected the offending kind named in the error, got ${JSON.stringify(errors)}`,
    );
  });

  test('rejects a duplicate kind in the precedence list', () => {
    const cap = shippedCap('claude');
    cap.runtime.triggerPrecedence = ['skills', 'skills'];
    const errors = capValidator.validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => String(e).includes('triggerPrecedence')),
      `expected a triggerPrecedence error, got ${JSON.stringify(errors)}`,
    );
  });

  test('rejects a non-array precedence value', () => {
    for (const bad of ['skills-then-commands', {}, null]) {
      const cap = shippedCap('claude');
      cap.runtime.triggerPrecedence = bad;
      const errors = capValidator.validateRuntimeBody(cap);
      assert.ok(
        errors.some((e) => String(e).includes('triggerPrecedence')),
        `bad value ${JSON.stringify(bad)}: expected a triggerPrecedence error, got ${JSON.stringify(errors)}`,
      );
    }
  });
});

describe('triggerPrecedence axis — resolution', () => {
  test('reordering the axis changes which artifact wins', () => {
    // codebuddy declares BOTH commands and skills at the SAME scope from the
    // same source stems — the one runtime shape where kind precedence (not
    // scope rank) decides the winner.
    const defaultResult = resolveTriggerSurface('codebuddy', ['global'], { stems: ['plan-phase'] });
    const defaultGroup = defaultResult.filter((s) => s.trigger === 'gsd-plan-phase');
    const defaultWinner = defaultGroup.find((s) => s.shadowedBy === null);
    assert.ok(defaultWinner, 'expected a winner under the default precedence');
    assert.strictEqual(defaultWinner.kind, 'skills', 'default precedence (skills > commands) must pick skills');

    const overriddenCap = JSON.parse(JSON.stringify(capabilityRegistry.runtimes.codebuddy));
    overriddenCap.runtime.triggerPrecedence = ['commands', 'skills'];
    const overriddenRegistry = { runtimes: { codebuddy: overriddenCap } };

    const overriddenResult = resolveTriggerSurface('codebuddy', ['global'], { stems: ['plan-phase'], registry: overriddenRegistry });
    const overriddenGroup = overriddenResult.filter((s) => s.trigger === 'gsd-plan-phase');
    const overriddenWinner = overriddenGroup.find((s) => s.shadowedBy === null);
    assert.ok(overriddenWinner, 'expected a winner under the overridden precedence');
    assert.strictEqual(overriddenWinner.kind, 'commands', 'reordered precedence (commands > skills) must flip the winner');
  });

  test('the default precedence matches what claude declares', () => {
    assert.ok(Array.isArray(capValidator.DEFAULT_TRIGGER_PRECEDENCE), 'DEFAULT_TRIGGER_PRECEDENCE must be exported');
    assert.deepStrictEqual(capValidator.DEFAULT_TRIGGER_PRECEDENCE, ['skills', 'commands']);
    const claudeCap = shippedCap('claude');
    assert.deepStrictEqual(
      claudeCap.runtime.triggerPrecedence, capValidator.DEFAULT_TRIGGER_PRECEDENCE,
      "claude's declared triggerPrecedence must equal the validator's default",
    );
  });
});
