'use strict';

// allow-test-rule: source-text-is-the-product #2875 — the J-row assertions
// pattern-match rendered agent-.md frontmatter (`effort:`, `model:`,
// disallowedTools, branding text). That frontmatter IS the deployed artifact
// each runtime loads at dispatch time (no typed IR exists between
// applyAgentFrontmatterExtensions/injectEffortFrontmatter and the file a
// runtime reads) — matching CONTRIBUTING.md's `source-text-is-the-product`
// exemption, not a workaroundable "hide the grep in a parser" case.

/**
 * agent-descriptor-parity.install.test.cjs — #2875 Part 2 (the agents-bypass
 * closure), 50-test-matrix.md sections H, I, J (rows H1-H8, I1-I3, J1-J10).
 *
 * HONEST BASELINE (rewritten — a prior revision of this file was found to
 * test the wrong thing on every axis; see the fixed defects below):
 *
 * bin/install.js's inline agent-staging loop is GONE (deleted in the same
 * commit that made every runtime descriptor-driven for agents). There is no
 * second, independently-maintained agent-staging pipeline left in this
 * codebase to diff against — an "old pipeline vs new pipeline" comparison is
 * therefore IMPOSSIBLE post-deletion, and a prior revision of this file's
 * header claiming to compare against "bin/install.js's inline agent-staging
 * loop" was false the moment that loop was deleted.
 *
 * What THIS revision actually proves instead, and how:
 *
 *   1. The REAL production entry point (`installAgentsKindStandalone`,
 *      `install-engine.cjs`) is driven directly, against the REAL, BUILT
 *      `capability-registry.cjs` — no synthetic registry override. Every H
 *      row therefore byte-compares actual output written by a real
 *      `capabilities/<runtime>/capability.json` edit, not a hand-rolled
 *      stand-in for one. A wrong-but-syntactically-valid `converter` name
 *      landing in a real descriptor changes the ACTUAL side's output and is
 *      caught (see H8's red-proof, which demonstrates this directly).
 *
 *   2. `computeExpectedOutput` (the "oracle") independently assembles the
 *      EXPECTED bytes by calling the individual conversion PRIMITIVES
 *      directly: `composeWorkflow`, `applyAgentPathRewrites`,
 *      `processAttribution`, the runtime's converter function (dispatched
 *      off `EXPECTED_CONVERTER_NAME_BY_RUNTIME` — a hand-verified,
 *      independent map, NOT read from the descriptor under test),
 *      `applyAgentFrontmatterExtensions`, `normalizeAgentBodyForRuntime`.
 *      These primitives are — by construction, not accident —
 *      single-sourced: there is no live duplicate of `composeWorkflow` or
 *      `applyAgentPathRewrites` to diff against either, because #2875 Part 2
 *      collapsed the duplication into these shared functions. Reusing them
 *      here does not defeat the test: the property under test in every H row
 *      is "does capability.json's declared `converter` name resolve to the
 *      CORRECT converter and get invoked in the correct position of the
 *      pipeline" — which the independent `EXPECTED_CONVERTER_NAME_BY_RUNTIME`
 *      map exists specifically to keep decoupled from the descriptor.
 *
 *   3. Both scopes are exercised for every runtime that declares a
 *      per-scope `agents` kind (claude, cline, codex, hermes, kilo, opencode,
 *      kimi-code × global+local). The prior revision was global-only, which
 *      is exactly the class of gap that let two separate agents-drop
 *      regressions reach `next` undetected: cline-local (fixed alongside
 *      this rewrite — capabilities/cline/capability.json's `local`
 *      artifactLayout now declares an `agents` kind) and kimi-code-local
 *      (fixed the same way — its `local` artifactLayout previously declared
 *      no `agents` kind at all, so the deleted inline loop's implicit
 *      scope-gate was silently replaced with NO gate, dropping every
 *      kimi-code local install's agents/gsd-*.md entirely).
 *
 * H8 is mandatory, not optional: a parity harness never demonstrated failing
 * is decoration. It feeds the oracle a DELIBERATELY WRONG (but real,
 * allowlisted) converter name and asserts the comparison goes red against
 * the REAL (correctly-configured) production output — proving that if
 * capability.json's declared converter ever regressed, this exact harness
 * would catch it.
 *
 * WHAT THIS FILE DOES NOT PROVE: H8's red-proof demonstrates exactly one
 * failure class — the oracle and the real descriptor path resolving to a
 * DIFFERENT converter for the same runtime. It says nothing about a bug
 * INSIDE a shared primitive (`composeWorkflow`, `applyAgentPathRewrites`,
 * `processAttribution`, `applyAgentFrontmatterExtensions`,
 * `normalizeAgentBodyForRuntime`, or a named converter itself): both the
 * oracle (point 2 above) and the real descriptor path call the identical
 * function, so a regression inside one of those functions changes BOTH
 * sides identically and every H row stays green. That is a deliberate,
 * unavoidable consequence of point 2's single-sourcing (there is no second,
 * independently-implemented copy of those primitives left to diff against
 * post-#2875-Part-2) — this file is a converter-WIRING parity gate, not a
 * substitute for direct unit coverage of the primitives themselves (which
 * live in their own owning test files, e.g. `runtime-artifact-conversion`'s
 * suite).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup, createTempDir, sandboxHome } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib');

const runtimeArtifactConversion = require(path.join(LIB_DIR, 'runtime-artifact-conversion.cjs'));
const installModelOverrideResolver = require(path.join(LIB_DIR, 'install-model-override-resolver.cjs'));
const installEngine = require(path.join(LIB_DIR, 'install-engine.cjs'));
const capabilityRegistry = require(path.join(LIB_DIR, 'capability-registry.cjs'));
const { composeWorkflow } = require(path.join(LIB_DIR, 'workflow-fragments.cjs'));
const installBin = require(path.join(REPO_ROOT, 'bin', 'install.js'));

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Deterministic sample agent sources — NOT the real agents/ tree (the real
 *  tree's exact roster can change independently of this suite). Covers:
 *  ~/.claude/ + $HOME/.claude/ (anchored + bare) path forms, a Co-Authored-By
 *  trailer, and one row-J4 "disallowedTools hit" agent name plus one "miss". */
const SAMPLE_AGENTS = {
  'gsd-planner.md': [
    '---',
    'name: gsd-planner',
    'description: Plans phases for GSD workflows.',
    'tools: Read, Write, Edit, Bash',
    '---',
    '',
    'Reads @~/.claude/gsd-core/commands/gsd/plan-phase.md and $HOME/.claude/CLAUDE.md.',
    'Bare forms too: ~/.claude and $HOME/.claude.',
    'References Claude Code and CLAUDE.md and .claude/settings.json.',
    '',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    '',
  ].join('\n'),
  'gsd-plan-checker.md': [
    '---',
    'name: gsd-plan-checker',
    'description: Checks plans for GSD workflows.',
    'tools: Read, Grep, Glob',
    '---',
    '',
    'A read-only checker agent (row J4 "hit" — declared in READONLY_AGENT_DISALLOWED_TOOLS).',
    '',
  ].join('\n'),
};

function buildSourceTree(agentFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-parity-src-'));
  const commandsGsd = path.join(root, 'commands', 'gsd');
  fs.mkdirSync(commandsGsd, { recursive: true });
  // Runtime Surface source providers are atomic across every source class a
  // layout needs. Keep this marker fixture complete for commands + agents so
  // the installer resolver does not correctly fall back to the package tree.
  fs.writeFileSync(path.join(commandsGsd, 'fixture-command.md'), '# Fixture command\n');
  const agentsDir = path.join(root, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const [name, content] of Object.entries(agentFiles)) {
    fs.writeFileSync(path.join(agentsDir, name), content);
  }
  return { root, commandsGsd, agentsDir };
}

/** A fresh "install destination" dir with a `.gsd-source` marker pointing at
 *  `commandsGsd` — the same marker findInstallSourceRoot/findAgentsSourceRoot
 *  read (runtime-artifact-layout.cts). */
function buildTargetDir(commandsGsd) {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-parity-dest-'));
  fs.writeFileSync(path.join(targetDir, '.gsd-source'), commandsGsd);
  return targetDir;
}

// ---------------------------------------------------------------------------
// Oracle — independently-assembled EXPECTED output (see header doc)
// ---------------------------------------------------------------------------

/** Hand-verified, independent of any capability.json — this is the thing
 *  every H row's ACTUAL side (a real capability.json) is checked against.
 *  `null` means converter:null (identity — claude, kimi-code). */
const EXPECTED_CONVERTER_NAME_BY_RUNTIME = {
  claude: null,
  'kimi-code': null,
  cline: 'convertClaudeAgentToClineAgent',
  codex: 'convertClaudeAgentToCodexAgent',
  hermes: 'convertClaudeAgentToHermesAgent',
  kilo: 'convertClaudeToKiloFrontmatter',
  opencode: 'convertClaudeToOpencodeFrontmatter',
};

/** Converter functions callable by name — bin/install.js still owns
 *  cline/codex/kilo/opencode's (never migrated to runtime-artifact-conversion.cjs);
 *  hermes's is descriptor-native (#2875 Part 2 / J9-J10). */
const NAMED_CONVERTERS = {
  convertClaudeAgentToClineAgent: installBin.convertClaudeAgentToClineAgent,
  convertClaudeAgentToCodexAgent: installBin.convertClaudeAgentToCodexAgent,
  convertClaudeAgentToHermesAgent: runtimeArtifactConversion.convertClaudeAgentToHermesAgent,
  convertClaudeToKiloFrontmatter: installBin.convertClaudeToKiloFrontmatter,
  convertClaudeToOpencodeFrontmatter: installBin.convertClaudeToOpencodeFrontmatter,
};

/** kilo/opencode take an options bag (`{isAgent, modelOverride}`), resolved
 *  ONCE per call via the single shared precedence resolver (J5-J8) — every
 *  other converter here takes only `content`. */
const MODEL_OVERRIDE_CONVERTER_NAMES = new Set(['convertClaudeToKiloFrontmatter', 'convertClaudeToOpencodeFrontmatter']);

/**
 * Assemble the EXPECTED per-file output for `runtime` from `agentsDir`,
 * calling the shared conversion primitives directly (see header doc for why
 * this is not circular). `converterNameOverride`, when passed, replaces
 * `EXPECTED_CONVERTER_NAME_BY_RUNTIME[runtime]` — used ONLY by H8's
 * red-proof to inject a deliberately wrong converter.
 */
function computeExpectedOutput(runtime, agentsDir, ctx, converterNameOverride) {
  const converterName = converterNameOverride !== undefined ? converterNameOverride : EXPECTED_CONVERTER_NAME_BY_RUNTIME[runtime];
  const { pathPrefix, attribution, targetDir } = ctx;
  const out = new Map();
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const agentSourcePath = path.join(agentsDir, entry.name);
    let content = fs.readFileSync(agentSourcePath, 'utf8');
    // Step 0 (#2995): strip gsd:section markers — same order the real
    // pipeline uses (stageAgentsForRuntimeWithConverter, install-profiles.cts).
    content = composeWorkflow(content, { sourcePath: agentSourcePath });
    const agentName = runtimeArtifactConversion.deriveAgentName(entry.name);
    // Step 1: path rewrites
    content = runtimeArtifactConversion.applyAgentPathRewrites(content, runtime, pathPrefix);
    // Step 2: attribution
    content = runtimeArtifactConversion.processAttribution(content, attribution);
    // Step 3: converter — dispatched off the INDEPENDENT expected-name map,
    // never off the descriptor under test.
    if (converterName) {
      const fn = NAMED_CONVERTERS[converterName];
      assert.ok(typeof fn === 'function', `oracle: no converter function registered for "${converterName}"`);
      if (MODEL_OVERRIDE_CONVERTER_NAMES.has(converterName)) {
        const modelOverride = installModelOverrideResolver.resolveAgentModelOverride(
          agentName,
          installModelOverrideResolver.readGsdEffectiveModelOverrides(targetDir),
          installModelOverrideResolver.readGsdRuntimeProfileResolver(targetDir),
        );
        content = fn(content, { isAgent: true, modelOverride });
      } else {
        content = fn(content);
      }
    }
    // converter:null (claude, kimi-code) — content unchanged by this step.
    // Step 4: frontmatter extensions (effort/disallowedTools)
    content = runtimeArtifactConversion.applyAgentFrontmatterExtensions(content, { runtime, agentName, targetDir });
    // Step 5: normalize colon->hyphen refs
    content = runtimeArtifactConversion.normalizeAgentBodyForRuntime(
      content,
      runtime,
      runtimeArtifactConversion.readGsdCommandNames(),
    );
    out.set(entry.name, content);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Real descriptor path — the REAL production entry point, REAL registry
// ---------------------------------------------------------------------------

/**
 * Drive the ACTUAL production entry point (`installAgentsKindStandalone`)
 * against the REAL, built `capability-registry.cjs` — no override. This is
 * exactly what `bin/install.js`'s `install()` calls for every runtime whose
 * layout is not otherwise reached by the generic `installRuntimeArtifacts`
 * loop (and, for the runtimes reached by that loop, produces identical
 * output to it — both route through the SAME `convertedAgentsKind` /
 * `_resolveNamedConverter` dispatch in runtime-artifact-layout.cts).
 */
function runRealDescriptorPath(runtime, scope, targetDir, ctx) {
  const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };
  const result = installEngine.installAgentsKindStandalone(
    runtime,
    targetDir,
    scope,
    resolvedProfile,
    ctx.pathPrefix,
    () => ctx.attribution,
  );
  const out = new Map();
  if (!result) return out;
  for (const entry of fs.readdirSync(result.destDir, { withFileTypes: true })) {
    if (entry.isFile()) out.set(entry.name, fs.readFileSync(path.join(result.destDir, entry.name), 'utf8'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison helper
// ---------------------------------------------------------------------------

/** Every (runtime, scope) pair the REAL capabilities/<runtime>/capability.json
 *  today declares an `agents` kind for (measured 2026-08-17). K1 below is the
 *  machine-checked guarantee that this list cannot silently go stale — it
 *  sweeps the real registry and fails if a declarant is missing here. */
const RUNTIME_SCOPE_PAIRS = [
  ['claude', 'global'], ['claude', 'local'],
  ['cline', 'global'], ['cline', 'local'],
  ['codex', 'global'], ['codex', 'local'],
  ['hermes', 'global'], ['hermes', 'local'],
  ['kilo', 'global'], ['kilo', 'local'],
  ['opencode', 'global'], ['opencode', 'local'],
  ['kimi-code', 'global'], ['kimi-code', 'local'],
];

/** Model override literal shared by J8's two `_stageWithModelOverride` calls. */
const J8_OVERRIDE_MODEL = 'shared/explicit-model';

/**
 * Standalone helper (module scope, no test-context access — the
 * CONTRIBUTING.md "Never use try/finally inside test bodies" exemption) for
 * J8: stage a single-agent source tree with a real `.planning/config.json`
 * model_overrides block for `runtime` through the real descriptor path.
 */
function _stageWithModelOverride(runtime, overrideModel) {
  const agentFiles = { 'gsd-planner.md': SAMPLE_AGENTS['gsd-planner.md'] };
  const { commandsGsd, root } = buildSourceTree(agentFiles);
  const targetDir = buildTargetDir(commandsGsd);
  fs.mkdirSync(path.join(targetDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, '.planning', 'config.json'),
    JSON.stringify({ model_overrides: { 'gsd-planner': overrideModel } }),
  );
  try {
    const ctx = { pathPrefix: `${targetDir}/`, attribution: undefined, targetDir };
    return runRealDescriptorPath(runtime, 'global', targetDir, ctx);
  } finally {
    cleanup(root);
    cleanup(targetDir);
  }
}

function comparePipelines(runtime, scope, converterNameOverride) {
  const { commandsGsd, agentsDir, root } = buildSourceTree(SAMPLE_AGENTS);
  const targetDir = buildTargetDir(commandsGsd);
  try {
    const ctx = { pathPrefix: `${targetDir}/`, attribution: undefined, targetDir };
    const expected = computeExpectedOutput(runtime, agentsDir, ctx, converterNameOverride);
    const actual = runRealDescriptorPath(runtime, scope, targetDir, ctx);
    return { expected, actual };
  } finally {
    cleanup(root);
    cleanup(targetDir);
  }
}

/** Asserts H1-H6 + H7 in one shot: same filenames (Set equality, order-free)
 *  AND byte-identical content per filename. */
function assertMapsIdentical(expected, actual) {
  assert.deepEqual(
    [...expected.keys()].sort(),
    [...actual.keys()].sort(),
    'filenames diverged between the oracle and the real descriptor path (row H7)',
  );
  for (const [name, expectedContent] of expected) {
    assert.equal(
      actual.get(name),
      expectedContent,
      `content diverged for ${name} between the oracle and the real descriptor path`,
    );
  }
}

// ---------------------------------------------------------------------------
// H rows — the parity gate, one row per (runtime, scope)
// ---------------------------------------------------------------------------

for (const [runtime, scope] of RUNTIME_SCOPE_PAIRS) {
  test(`agent-descriptor-parity: H row — ${runtime} (${scope}) real descriptor output matches the independent oracle`, () => {
    const { expected, actual } = comparePipelines(runtime, scope);
    assert.ok(expected.size > 0, 'fixture produced no oracle output — test is vacuous');
    assertMapsIdentical(expected, actual);
  });
}

// ---------------------------------------------------------------------------
// H7 — the harness compares filenames, not only content (meta)
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: H7 — a filename-only divergence fails the harness', (t) => {
  const { commandsGsd, agentsDir, root } = buildSourceTree(SAMPLE_AGENTS);
  const targetDir = buildTargetDir(commandsGsd);
  t.after(() => {
    cleanup(root);
    cleanup(targetDir);
  });
  const ctx = { pathPrefix: `${targetDir}/`, attribution: undefined, targetDir };
  const expected = computeExpectedOutput('claude', agentsDir, ctx);
  const actual = runRealDescriptorPath('claude', 'global', targetDir, ctx);
  // Deliberately rename one actual-side entry — same bytes, different name.
  const [firstName, firstContent] = [...actual.entries()][0];
  actual.delete(firstName);
  actual.set(`RENAMED-${firstName}`, firstContent);
  assert.throws(
    () => assertMapsIdentical(expected, actual),
    /filenames diverged/,
    'a renamed output file must fail the harness',
  );
});

// ---------------------------------------------------------------------------
// H8 — the harness can actually FAIL (mandatory, not optional)
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: H8 — a deliberately-wrong (but real, allowlisted) expected converter turns the harness RED', (t) => {
  // Hermes's REAL capability.json declares convertClaudeAgentToHermesAgent.
  // Feed the ORACLE a different, real, allowlisted converter name
  // (convertClaudeAgentToCodexAgent) instead — simulating exactly the failure
  // mode row H exists to catch: capability.json's declared converter silently
  // diverging from the correct one. The REAL descriptor path is untouched and
  // still uses hermes's real (correct) converter, so this proves: IF
  // capability.json ever regressed to the wrong name, THIS harness's H row
  // for hermes would go red exactly like this.
  const { commandsGsd, agentsDir, root } = buildSourceTree(SAMPLE_AGENTS);
  const targetDir = buildTargetDir(commandsGsd);
  t.after(() => {
    cleanup(root);
    cleanup(targetDir);
  });
  const ctx = { pathPrefix: `${targetDir}/`, attribution: undefined, targetDir };
  const wrongExpected = computeExpectedOutput('hermes', agentsDir, ctx, 'convertClaudeAgentToCodexAgent');
  const realActual = runRealDescriptorPath('hermes', 'global', targetDir, ctx);
  let threw = false;
  let observedDiff = null;
  try {
    assertMapsIdentical(wrongExpected, realActual);
  } catch (err) {
    threw = true;
    observedDiff = err.message;
  }
  assert.equal(threw, true, 'H8 FAILED: the harness did not go red for a deliberately-wrong expected converter');
  assert.match(observedDiff, /content diverged for gsd-(planner|plan-checker)\.md/, 'expected the content-diverged assertion to name the mismatched file');
  // Verbatim red-proof output for the record (see CHANGES report):
  console.log(`H8 red-proof observed: ${observedDiff}`);
});

// ---------------------------------------------------------------------------
// I1-I3 — per-agent resolution context
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: I3 — deriveAgentName matches the pipeline exactly, including a no-.md-suffix boundary', () => {
  assert.equal(runtimeArtifactConversion.deriveAgentName('gsd-planner.md'), 'gsd-planner');
  // Boundary: a filename with no trailing .md is returned unchanged (the
  // regex has nothing to match) — matches `entry.name.replace(/\.md$/, '')`.
  assert.equal(runtimeArtifactConversion.deriveAgentName('gsd-planner'), 'gsd-planner');
  assert.equal(runtimeArtifactConversion.deriveAgentName('gsd-planner.MD'), 'gsd-planner.MD');
});

test('agent-descriptor-parity: I2 — real descriptor path with no agentCtx is unaffected (converter-only)', (t) => {
  const { commandsGsd, agentsDir, root } = buildSourceTree(SAMPLE_AGENTS);
  const targetDir = buildTargetDir(commandsGsd);
  t.after(() => {
    cleanup(root);
    cleanup(targetDir);
  });
  const runtimeArtifactLayout = require(path.join(LIB_DIR, 'runtime-artifact-layout.cjs'));
  const realLayout = runtimeArtifactLayout.resolveRuntimeArtifactLayout('claude', targetDir, 'global');
  const agentsKindEntry = realLayout.kinds.find((k) => k.kind === 'agents');
  const stagedDir = agentsKindEntry.stage({ name: 'full', skills: '*', agents: new Set() }); // no agentCtx
  t.after(() => cleanup(stagedDir));
  const planner = fs.readFileSync(path.join(stagedDir, 'gsd-planner.md'), 'utf8');
  const original = fs.readFileSync(path.join(agentsDir, 'gsd-planner.md'), 'utf8');
  assert.equal(planner, original, 'no agentCtx must leave content byte-identical to source (converter:null == identity)');
});

// ---------------------------------------------------------------------------
// J1-J4 — frontmatter extensions
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: J1 — claude effort is injected via applyAgentFrontmatterExtensions', () => {
  const content = '---\nname: gsd-planner\ndescription: x\n---\n\nBody.\n';
  const viaShared = runtimeArtifactConversion.applyAgentFrontmatterExtensions(content, { runtime: 'claude', agentName: 'gsd-planner', targetDir: null });
  assert.match(viaShared, /^effort: /m, 'expected an effort: key to be injected for claude');
});

test('agent-descriptor-parity: J2 — effort resolving to inherit writes NO effort: key at all, exercised via the REAL guard in applyAgentFrontmatterExtensions (#3533 trap row)', (t) => {
  // #2875 Part 2 defect fix: a prior revision of this row asserted the DUMB
  // half (injectEffortFrontmatter DOES emit the literal 'inherit' if called
  // with it) and never called applyAgentFrontmatterExtensions at all — so
  // deleting the `universalEffort !== 'inherit'` guard at
  // runtime-artifact-conversion.cts:3504 left this row green. This revision
  // writes a REAL .planning/config.json under targetDir (readGsdEffectiveEffortConfig
  // walks up from targetDir looking for it — install-effort-resolver.cts)
  // and calls the REAL applyAgentFrontmatterExtensions end to end, so removing
  // that guard makes THIS assertion fail (verified: red with the guard
  // removed, green with it restored — see CHANGES report).
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-agent-parity-j2-'));
  t.after(() => cleanup(targetDir));
  fs.mkdirSync(path.join(targetDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, '.planning', 'config.json'),
    JSON.stringify({ effort: { agent_overrides: { 'gsd-inherit-agent': 'inherit' } } }),
  );
  const content = '---\nname: gsd-inherit-agent\ndescription: x\n---\n\nBody.\n';
  const out = runtimeArtifactConversion.applyAgentFrontmatterExtensions(content, { runtime: 'claude', agentName: 'gsd-inherit-agent', targetDir });
  assert.doesNotMatch(out, /^effort:/m, 'an agent resolving to "inherit" must get no effort: key at all — not even effort: inherit');
  // Sanity: injectEffortFrontmatter itself is dumb and WOULD write the
  // literal if called with it — the guard is applyAgentFrontmatterExtensions
  // never calling it for 'inherit', which is exactly what the assertion above proves.
  assert.match(runtimeArtifactConversion.injectEffortFrontmatter(content, 'inherit'), /^effort: inherit$/m);
});

test('agent-descriptor-parity: J3 — a runtime NOT declaring agentFrontmatterExtensions gets nothing injected', () => {
  const content = '---\nname: gsd-plan-checker\ndescription: x\n---\n\nBody.\n';
  const out = runtimeArtifactConversion.applyAgentFrontmatterExtensions(content, { runtime: 'opencode', agentName: 'gsd-plan-checker', targetDir: null });
  assert.equal(out, content, 'opencode declares no agentFrontmatterExtensions — output must be byte-identical to input');
});

test('agent-descriptor-parity: J4 — disallowedTools injected only on a READONLY_AGENT_DISALLOWED_TOOLS hit', () => {
  const content = '---\nname: gsd-plan-checker\ndescription: x\n---\n\nBody.\n';
  const hit = runtimeArtifactConversion.applyAgentFrontmatterExtensions(content, { runtime: 'claude', agentName: 'gsd-plan-checker', targetDir: null });
  assert.match(hit, /^disallowedTools: /m, 'gsd-plan-checker is a declared read-only agent — expected a disallowedTools hit');

  const missContent = '---\nname: gsd-not-a-readonly-agent\ndescription: x\n---\n\nBody.\n';
  const miss = runtimeArtifactConversion.applyAgentFrontmatterExtensions(missContent, { runtime: 'claude', agentName: 'gsd-not-a-readonly-agent', targetDir: null });
  assert.doesNotMatch(miss, /^disallowedTools:/m, 'an agent absent from READONLY_AGENT_DISALLOWED_TOOLS must get no disallowedTools key');
});

// ---------------------------------------------------------------------------
// J5-J8 — model-override resolution (kilo/opencode), single-sourced
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: J5 — explicit model_overrides[agent] wins (highest precedence)', () => {
  const modelOverrides = { 'gsd-planner': 'anthropic/explicit-model' };
  const runtimeResolver = { resolve: () => ({ model: 'anthropic/tier-model' }) }; // would win if precedence were wrong
  const result = installModelOverrideResolver.resolveAgentModelOverride('gsd-planner', modelOverrides, runtimeResolver);
  assert.equal(result, 'anthropic/explicit-model');
});

test('agent-descriptor-parity: J6 — falls back to the runtime tier resolver when no explicit override exists', () => {
  const runtimeResolver = { resolve: (agentName) => (agentName === 'gsd-planner' ? { model: 'anthropic/tier-model' } : null) };
  const result = installModelOverrideResolver.resolveAgentModelOverride('gsd-planner', null, runtimeResolver);
  assert.equal(result, 'anthropic/tier-model');
});

test('agent-descriptor-parity: J7 — neither configured resolves to null (omit), never "" or the string "null"', () => {
  const result = installModelOverrideResolver.resolveAgentModelOverride('gsd-planner', null, null);
  assert.equal(result, null);
  assert.notEqual(result, '');
  const contentWithoutModelOverride = installBin.convertClaudeToOpencodeFrontmatter(
    '---\nname: gsd-planner\ndescription: x\ntools: Read\n---\n\nBody.\n',
    { isAgent: true, modelOverride: result },
  );
  assert.doesNotMatch(contentWithoutModelOverride, /^model:/m, 'an omitted override must not appear as a model: key at all');
});

test('agent-descriptor-parity: J8 — kilo and opencode both resolve model overrides through the REAL descriptor path (installAgentsKindStandalone), proving ONE shared resolution path, not a tautology', () => {
  // #2875 Part 2 defect fix: a prior revision of this row called
  // resolveAgentModelOverride TWICE with identical arguments and asserted
  // equality — true of ANY pure function regardless of whether kilo/opencode
  // are actually wired to it. This revision drives BOTH runtimes through the
  // REAL production entry point with a REAL .planning/config.json
  // model_overrides block and asserts BOTH staged outputs carry the SAME
  // resolved model — which only happens if both are genuinely wired to the
  // one shared installModelOverrideResolver.resolveAgentModelOverride.
  const kiloOut = _stageWithModelOverride('kilo', J8_OVERRIDE_MODEL);
  const opencodeOut = _stageWithModelOverride('opencode', J8_OVERRIDE_MODEL);
  // J8_OVERRIDE_MODEL is a fixed constant: assert the exact expected
  // frontmatter line, matched line-wise, rather than building a RegExp from
  // an interpolated value (CodeQL js/incomplete-sanitization — a
  // metachar-bearing value would silently widen the match).
  const expectedModelLine = `model: ${J8_OVERRIDE_MODEL}`;
  assert.ok(
    kiloOut.get('gsd-planner.md').split('\n').some((line) => line.trim() === expectedModelLine),
    'kilo must apply the shared model override via the real descriptor path',
  );
  assert.ok(
    opencodeOut.get('gsd-planner.md').split('\n').some((line) => line.trim() === expectedModelLine),
    'opencode must apply the SAME shared model override via the real descriptor path',
  );
});

// ---------------------------------------------------------------------------
// J9-J10 — hermes branding converter
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: J9 — hermes branding converter is byte-identical to the shared generic branding-rewrite function, including \\bClaude Code\\b word-boundary semantics', () => {
  const content = 'Claude Code and ClaudeCodeExtra and CLAUDE.md and .claude/foo and reClaude Code.\n';
  const viaSharedFn = runtimeArtifactConversion.applyAgentBrandingRewrites(content, 'hermes');
  const viaNamedConverter = runtimeArtifactConversion.convertClaudeAgentToHermesAgent(content);
  assert.equal(viaSharedFn, viaNamedConverter, 'the named converter must be a pure delegate to the generic branding-rewrite function');
  // \bClaude Code\b: neither "ClaudeCodeExtra" (no space/boundary between
  // "Claude" and "Code") nor "reClaude Code" (no boundary between the 'e' of
  // "re" and the 'C' of "Claude" — both word chars) satisfy the word-boundary
  // requirement, so BOTH are left untouched; only the standalone occurrence is
  // rewritten.
  assert.match(viaSharedFn, /Hermes Agent and ClaudeCodeExtra and HERMES\.md and \.hermes\/foo and reClaude Code\./);
});

test('agent-descriptor-parity: J10 — the branding converter is descriptor-data-driven, not hardcoded to hermes strings', () => {
  const content = 'Claude Code uses CLAUDE.md under .claude/.\n';
  // A runtime with NO brandingRewrites declared gets nothing rewritten.
  assert.equal(runtimeArtifactConversion.applyAgentBrandingRewrites(content, 'claude'), content);
  // hermes (the only runtime with brandingRewrites AND no dedicated converter
  // pre-#2875) gets ITS OWN declared rewrite table applied — proving the
  // function reads the runtime's descriptor rather than a hermes-hardcoded literal.
  const hermesOut = runtimeArtifactConversion.applyAgentBrandingRewrites(content, 'hermes');
  assert.notEqual(hermesOut, content);
  assert.match(hermesOut, /Hermes Agent uses HERMES\.md under \.hermes\/\./);
});

// ---------------------------------------------------------------------------
// K1 — migration completeness: every registry runtime with an `agents` kind
// is reachable from the REAL production entry point, not the (now-deleted)
// inline loop.
// ---------------------------------------------------------------------------

/**
 * bin/install.js's inline agent-staging loop and its `_DESCRIPTOR_AGENTS_RUNTIMES`
 * gate were DELETED in #2875 Part 2 Task C — there is no longer a symbol to
 * assert absent (a source-text check would violate `local/no-source-grep` and
 * would prove nothing about runtime behavior anyway, per CLAUDE.md's
 * "Behavioral tests are required"). Row K1 is instead proven the only way
 * that is actually meaningful once the code is gone: for EVERY `role:
 * "runtime"` capability in the REAL capability-registry that declares an
 * `agents` kind (either scope), the REAL production entry point
 * (`installRuntimeArtifacts` — which internally routes combinedFamilyInstall
 * runtimes like kilo/opencode through `installOpencodeFamilyAgents`, #2875
 * Part 2 Task A) actually materializes agents/ on disk. If any runtime were
 * still silently depending on the deleted inline loop, this call would write
 * nothing to agents/ for it (the deleted code was the ONLY thing that used to
 * write it for the seven runtimes migrated in this change) and the assertion
 * below would fail.
 */
test('agent-descriptor-parity: K1 — every registry runtime declaring an agents kind is reachable from installRuntimeArtifacts (the inline loop is gone)', (t) => {
  const runtimesWithAgentsKind = Object.entries(capabilityRegistry.runtimes || {})
    .filter(([, cap]) => {
      const layout = cap.runtime && cap.runtime.artifactLayout;
      if (!layout) return false;
      const entries = [...(layout.global || []), ...(layout.local || [])];
      return entries.some((e) => e.kind === 'agents');
    })
    .map(([id]) => id);

  assert.ok(runtimesWithAgentsKind.length >= 7, 'sanity: expected at least the seven #2875 Part 2 runtimes to declare an agents kind');
  assert.ok(runtimesWithAgentsKind.includes('kimi-code'), 'kimi-code (found via golden fixture, not analysis) must be covered here');
  assert.ok(runtimesWithAgentsKind.includes('cline'), 'cline must be covered here');

  // #3712: this loop reaches `codex`, whose global skills kind declares a `home`
  // override (`.agents`) resolved from os.homedir() rather than from targetDir.
  // Sandboxing targetDir alone does NOT contain it — before this line the call
  // below pruned every gsd-* skill from the developer's REAL ~/.agents/skills
  // (71 -> 0) while the suite still exited 0. Sandbox HOME for the whole loop so
  // codex's skills land in <homeDir>/.agents/skills inside a temp dir we clean.
  const homeDir = createTempDir('gsd-adp-home-');
  t.after(() => cleanup(homeDir));
  sandboxHome(t, homeDir);

  for (const runtime of runtimesWithAgentsKind) {
    const { commandsGsd, root } = buildSourceTree(SAMPLE_AGENTS);
    const targetDir = buildTargetDir(commandsGsd);
    t.after(() => {
      cleanup(root);
      cleanup(targetDir);
    });
    const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };
    const result = installEngine.installRuntimeArtifacts(runtime, targetDir, 'global', resolvedProfile, () => undefined, undefined);
    const agentsKindEntry = result.kinds.find((k) => k.kind === 'agents');
    assert.ok(agentsKindEntry, `${runtime}: installRuntimeArtifacts reported no agents kind in the executed plan — it did not go through the descriptor path`);
    const writtenFiles = fs.readdirSync(agentsKindEntry.destDir).filter((f) => f.endsWith('.md'));
    assert.ok(writtenFiles.length > 0, `${runtime}: agents kind reported but nothing was actually written to ${agentsKindEntry.destDir}`);
  }
});
