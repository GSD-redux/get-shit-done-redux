// allow-test-rule: structural-regression-guard — the descriptor-migration contract (no `runtime === 'augment'` / `isAugment`-as-conversion-branch dispatch logic left in the folded modules) is a property of the source text itself, so a source-grep is the only faithful check (#2097, mirrors tests/declarative-reference-antigravity.test.cjs #2096 AC2 guard).
'use strict';

/**
 * Declarative reference host coverage — Augment Code (ADR-1239 / #2097
 * EoS/augment migration).
 *
 * Augment is already a declarative-CLI host (nested-skill artifact layout,
 * settings-json hook surface, Claude hook event dialect). #2097 folds its two
 * remaining runtime-literal branches in src/runtime-artifact-conversion.cts
 * onto descriptor-driven dispatch (runtime.hostBehaviors.commandBodyConverter)
 * and deletes 2 dead-code sites in bin/install.js — mirroring the Antigravity
 * migration (#2096) structure without duplicating its Antigravity-specific
 * (GEMINI.md / reviewerCli / noPathRewrite) assertions.
 *
 * UPGRADE 3 (MCP companion, settings.json-hosted) live-install coverage is in
 * tests/augment-upgrades.test.cjs — not duplicated here.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const {
  profileOf,
  negotiateHostCapabilities,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');
const { createDeclarativeAdapter } = require('../gsd-core/bin/lib/adapter-declarative.cjs');
const { cleanup } = require('./helpers.cjs');
const { walk, runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

const DESC = path.join(__dirname, '..', 'capabilities', 'augment', 'capability.json');
const AUGMENT_CAP = JSON.parse(fs.readFileSync(DESC, 'utf8'));
const AUGMENT_AXES = AUGMENT_CAP.runtime.hostIntegration;

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { BUILD_TIMEOUT_MS: BUILD_HOOKS_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// hooks/dist is gitignored and built (mirrors golden-install-parity harness).
before(() => {
  const r = runNode([BUILD_SCRIPT], { timeoutMs: BUILD_HOOKS_TIMEOUT_MS });
  throwIfFailed(r, `node ${BUILD_SCRIPT}`);
});

test('Augment classifies as the declarative-cli profile (profileOf)', () => {
  const desc = JSON.parse(fs.readFileSync(DESC, 'utf8'));
  const axes = desc.runtime.hostIntegration;
  assert.ok(axes && axes.embeddingMode, 'augment descriptor declares hostIntegration axes');
  assert.equal(profileOf(axes), 'declarative-cli', 'Augment is a declarative-CLI host');
});

test('the public declarative adapter classifies Augment as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'augment' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'augment');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('a real Augment install emits a gsd command/skill surface (invocable)', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'augment', scope: 'global' });
  try {
    const files = walk(configDir);
    assert.ok(files.length > 0, 'install must emit artifacts');
    const gsdSurface = files.filter((f) => /gsd/i.test(path.relative(configDir, f)));
    assert.ok(gsdSurface.length > 0,
      'install must emit a gsd command/skill surface (declarative reference)');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// #2097 EoS/augment — fail-closed negotiation + folded dispatch sub-axes
// (mirrors the antigravity/kimi reference tests).
// ---------------------------------------------------------------------------

test('negotiateHostCapabilities never throws for augment, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...AUGMENT_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...AUGMENT_AXES, embeddingMode: 'future-unknown' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...AUGMENT_AXES, dispatch: 'corrupted-not-an-object' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...AUGMENT_AXES, dispatch: { ...AUGMENT_AXES.dispatch, maxDepth: 'not-a-number' } }));
});

// AC-style proof: the 3 still-`undocumented` dispatch sub-axes (nested/
// maxDepth/backgroundDispatch) must degrade to the most-restrictive KNOWN
// value, never their optimistic value — mirrors antigravity's equivalent
// test, but Augment documents namedDispatch/background (unlike antigravity),
// so only 3 sub-axes are undocumented here, not 4. Real values confirmed via:
//   node -e "const {negotiateHostCapabilities}=require('./gsd-core/bin/lib/host-integration.cjs');
//            const cap=require('./capabilities/augment/capability.json');
//            console.log(negotiateHostCapabilities(cap.runtime.hostIntegration).effective.dispatch)"
// -> { namedDispatch:true, nested:false, maxDepth:0, background:true, subagentToolkit:'full', backgroundDispatch:false }
test("augment's 3 still-undocumented dispatch sub-axes (nested/maxDepth/backgroundDispatch) degrade to the most-restrictive known value, not their optimistic value", () => {
  // Sanity: the descriptor itself still declares these 3 as the undocumented
  // sentinel, while namedDispatch/background/subagentToolkit are documented.
  assert.equal(AUGMENT_AXES.dispatch.nested, 'undocumented');
  assert.equal(AUGMENT_AXES.dispatch.maxDepth, 'undocumented');
  assert.equal(AUGMENT_AXES.dispatch.backgroundDispatch, 'undocumented');
  assert.equal(AUGMENT_AXES.dispatch.namedDispatch, true, 'sanity: namedDispatch is documented, not part of the undocumented set');
  assert.equal(AUGMENT_AXES.dispatch.background, true, 'sanity: background is documented, not part of the undocumented set');
  assert.equal(AUGMENT_AXES.dispatch.subagentToolkit, 'full', 'sanity: subagentToolkit is documented, not part of the undocumented set');

  const { effective, warnings } = negotiateHostCapabilities(AUGMENT_AXES);

  assert.equal(effective.dispatch.nested, false, 'undocumented nested must degrade to false, never true');
  assert.equal(effective.dispatch.maxDepth, 0, 'undocumented maxDepth must degrade to 0, never -1/unbounded');
  assert.equal(effective.dispatch.backgroundDispatch, false, 'undocumented backgroundDispatch must degrade to false, never true');

  // namedDispatch/background/subagentToolkit are documented — they are
  // trusted and survive negotiation unchanged, in contrast to the 3
  // undocumented sub-axes above. Augment's negotiation must NOT flatten
  // dispatch the way a fully-undocumented descriptor (e.g. antigravity's
  // namedDispatch) would.
  assert.equal(effective.dispatch.namedDispatch, true, "documented 'true' namedDispatch is trusted, unlike the undocumented sub-axes");
  assert.equal(effective.dispatch.background, true, "documented 'true' background is trusted — not capped to false, since namedDispatch did not degrade closed");
  assert.equal(effective.dispatch.subagentToolkit, 'full', "documented 'full' subagentToolkit is trusted, unlike the undocumented sub-axes");

  for (const axis of ['nested', 'backgroundDispatch']) {
    assert.ok(
      warnings.some((w) => w.includes(`dispatch.${axis}`) && w.includes('undocumented')),
      `a warning must be raised for the undocumented dispatch.${axis} axis`,
    );
  }
  assert.ok(
    warnings.some((w) => w.includes('dispatch.maxDepth')),
    'a warning must be raised for the undocumented dispatch.maxDepth axis (reported as missing/non-number)',
  );
});

// ---------------------------------------------------------------------------
// #2097 AC2-equivalent — the hardcoded conversion-dispatch branches folded by
// this migration are retired from the folded modules.
//
// Unlike antigravity (#2096), where `isAntigravity` was eliminated from
// bin/install.js entirely, Augment's `isAugment` flag legitimately remains
// (destructured from runtimeFlags() and used for non-conversion verification
// logic — e.g. counting installed commands/ files). So this guard does NOT
// assert zero `isAugment` occurrences (that would be a false failure); it
// asserts no `isAugment` occurrence gates a call to an Augment *converter*
// function (the exact shape of the dead branch this migration deleted:
// `else if (isAugment) { content = convertClaudeAgentToAugmentAgent(content); }`).
// The switch `case 'augment':` label in _applyRuntimeRewrites is intentionally
// NOT flagged — it does plain dirName-derived path-prefix rewriting (same as
// the still-`case`-labeled trae/codebuddy/cursor/windsurf branches), not
// conversion-function dispatch, and antigravity's own guard tolerates its
// `case 'antigravity':` label for the identical reason (its regex only
// matches `runtime === 'x'`, never a `case` label).
// ---------------------------------------------------------------------------

test('no `runtime === "augment"` string-equality branch remains in the descriptor-migrated modules', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const repoRoot = path.join(__dirname, '..');
  const files = [
    path.join(repoRoot, 'bin', 'install.js'),
    path.join(repoRoot, 'src', 'runtime-artifact-conversion.cts'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const stripped = strip(src);
    const eqOffenders = stripped.match(/runtime\s*[!=]==\s*'augment'/g) || [];
    assert.deepEqual(eqOffenders, [],
      `no hardcoded runtime==='augment' branch may remain in ${path.relative(repoRoot, file)}; found: ${eqOffenders.join(', ')}`);
  }
});

test('no `isAugment` occurrence gates a call to an Augment converter function (the deleted dead-code shape)', () => {
  const converterNames = [
    'convertClaudeAgentToAugmentAgent',
    'convertClaudeToAugmentMarkdown',
    'convertClaudeCommandToAugmentSkill',
    'convertSlashCommandsToAugmentSkillMentions',
  ];
  const converterCallPattern = new RegExp(`(${converterNames.join('|')})\\s*\\(`);

  const file = path.join(__dirname, '..', 'bin', 'install.js');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only condition-position occurrences count (`if (isAugment)` / `else if
    // (isAugment)`), not the runtimeFlags() destructure or unrelated reads.
    if (!/(?:if|else if)\s*\(\s*isAugment\s*\)/.test(line)) continue;
    const window = lines.slice(i, i + 4).join('\n');
    if (converterCallPattern.test(window)) {
      offenders.push(`line ${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    `no isAugment-gated call to an Augment converter may remain in bin/install.js; found: ${offenders.join(' | ')}`);
});

test('legitimate isAugment destructure/enumeration sites survive (not eliminated, unlike isAntigravity)', () => {
  const file = path.join(__dirname, '..', 'bin', 'install.js');
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(/isAugment/.test(src), 'isAugment must still be destructured from runtimeFlags() for non-conversion uses');
  assert.ok(/_DESCRIPTOR_AGENTS_RUNTIMES\s*=\s*new Set\(\[[^\]]*'augment'/.test(src),
    'augment must remain in _DESCRIPTOR_AGENTS_RUNTIMES (descriptor-driven agent layout)');
});
