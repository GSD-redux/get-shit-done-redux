'use strict';

/**
 * agent-descriptor-parity.test.cjs — #2875 Part 2 (the agents-bypass
 * closure), 50-test-matrix.md sections H, I, J (rows H1-H8, I1-I3, J1-J10).
 *
 * THE GATE (section H): every failure mode in Part 2 is a SILENT byte drop —
 * wrong output, nothing thrown. This suite feeds identical agent sources
 * through bin/install.js's inline agent-staging loop and the descriptor-driven
 * pipeline (stageAgentsForRuntimeWithConverter via a SYNTHETIC registry
 * override — resolveRuntimeArtifactLayoutFromRegistry's own supported seam,
 * so no capability.json needs to be touched to prove this) and asserts the
 * written bytes AND filenames are byte-identical for all six runtimes that
 * still used the inline loop before this change (claude, cline, codex,
 * hermes, kilo, opencode).
 *
 * H8 is mandatory, not optional: a parity harness never demonstrated failing
 * is decoration. The last test in section H feeds a deliberately-divergent
 * converter into the SAME comparison and asserts it goes red.
 *
 * The "inline loop replica" below calls bin/install.js's OWN exported
 * converter functions (convertClaudeAgentToClineAgent,
 * convertClaudeAgentToCodexAgent, convertClaudeToOpencodeFrontmatter,
 * convertClaudeToKiloFrontmatter) — NOT the runtime-artifact-conversion.cjs
 * copies the descriptor path uses — so a real divergence between the two
 * historically-duplicated copies (CLAUDE.md "Generative Fix Divergence") is
 * caught, not hidden behind a shared helper. The three NEW contract pieces
 * (frontmatter extensions, model-override resolution, hermes branding) have
 * NO duplicate at all after this change — bin/install.js's inline loop and
 * the descriptor pipeline both call the SAME exported functions — so parity
 * for those three is structural, and this suite still exercises the call
 * shape end-to-end.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib');

const runtimeArtifactLayout = require(path.join(LIB_DIR, 'runtime-artifact-layout.cjs'));
const runtimeArtifactConversion = require(path.join(LIB_DIR, 'runtime-artifact-conversion.cjs'));
const installModelOverrideResolver = require(path.join(LIB_DIR, 'install-model-override-resolver.cjs'));
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
// Inline-loop replica (bin/install.js's own exported functions)
// ---------------------------------------------------------------------------

function inlinePathRewrite(content, pathPrefix) {
  const normalizedPathPrefix = pathPrefix.replace(/\/$/, '');
  let out = content;
  out = out.replace(/~\/\.claude\//g, pathPrefix);
  out = out.replace(/\$HOME\/\.claude\//g, pathPrefix);
  out = out.replace(/~\/\.claude\b/g, normalizedPathPrefix);
  out = out.replace(/\$HOME\/\.claude\b/g, normalizedPathPrefix);
  return out;
}

/** Per-file order mirrors bin/install.js's inline agent loop exactly:
 *  composeWorkflow -> path-rewrite -> processAttribution -> dialect branch
 *  -> applyAgentFrontmatterExtensions -> normalizeAgentBodyForRuntime. */
function simulateInlineAgentLoop(runtime, agentsDir, ctx) {
  const { pathPrefix, attribution, targetDir } = ctx;
  const out = new Map();
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const agentSourcePath = path.join(agentsDir, entry.name);
    let content = fs.readFileSync(agentSourcePath, 'utf8');
    content = composeWorkflow(content, { sourcePath: agentSourcePath });
    content = inlinePathRewrite(content, pathPrefix);
    content = runtimeArtifactConversion.processAttribution(content, attribution);
    const agentName = entry.name.replace(/\.md$/, '');
    if (runtime === 'opencode') {
      const modelOverride = installModelOverrideResolver.resolveAgentModelOverride(
        agentName,
        installModelOverrideResolver.readGsdEffectiveModelOverrides(targetDir),
        installModelOverrideResolver.readGsdRuntimeProfileResolver(targetDir),
      );
      content = installBin.convertClaudeToOpencodeFrontmatter(content, { isAgent: true, modelOverride });
    } else if (runtime === 'kilo') {
      const modelOverride = installModelOverrideResolver.resolveAgentModelOverride(
        agentName,
        installModelOverrideResolver.readGsdEffectiveModelOverrides(targetDir),
        installModelOverrideResolver.readGsdRuntimeProfileResolver(targetDir),
      );
      content = installBin.convertClaudeToKiloFrontmatter(content, { isAgent: true, modelOverride });
    } else if (runtime === 'codex') {
      content = installBin.convertClaudeAgentToCodexAgent(content);
    } else if (runtime === 'cline') {
      content = installBin.convertClaudeAgentToClineAgent(content);
    } else if (runtime === 'hermes') {
      content = runtimeArtifactConversion.applyAgentBrandingRewrites(content, runtime);
    }
    // claude: converter:null (identity) — content unchanged by this step.
    content = runtimeArtifactConversion.applyAgentFrontmatterExtensions(content, { runtime, agentName, targetDir });
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
// Descriptor path (synthetic registry override — no capability.json touched)
// ---------------------------------------------------------------------------

/** converter:null (claude, identity copy) vs a named converter (the other five). */
const CONVERTER_NAME_BY_RUNTIME = {
  claude: null,
  cline: 'convertClaudeAgentToClineAgent',
  codex: 'convertClaudeAgentToCodexAgent',
  hermes: 'convertClaudeAgentToHermesAgent',
  kilo: 'convertClaudeToKiloFrontmatter',
  opencode: 'convertClaudeToOpencodeFrontmatter',
};

function syntheticRegistryFor(runtime, converterName) {
  return {
    runtimes: {
      [runtime]: {
        runtime: {
          artifactLayout: {
            global: [
              { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-', nesting: 'flat', recursive: false, converter: converterName },
            ],
            local: [],
          },
        },
      },
    },
  };
}

function runDescriptorPath(runtime, targetDir, ctx, registryOverride) {
  const converterName = CONVERTER_NAME_BY_RUNTIME[runtime];
  const registry = registryOverride ?? syntheticRegistryFor(runtime, converterName);
  const layout = runtimeArtifactLayout.resolveRuntimeArtifactLayoutFromRegistry(registry, runtime, targetDir, 'global');
  const agentsKind = layout.kinds.find((k) => k.kind === 'agents');
  assert.ok(agentsKind, `synthetic registry did not resolve an agents kind for ${runtime}`);
  const agentCtx = { runtime, pathPrefix: ctx.pathPrefix, attribution: ctx.attribution, targetDir };
  const stagedDir = agentsKind.stage({ name: 'full', skills: '*', agents: new Set() }, agentCtx);
  const out = new Map();
  for (const entry of fs.readdirSync(stagedDir, { withFileTypes: true })) {
    if (entry.isFile()) out.set(entry.name, fs.readFileSync(path.join(stagedDir, entry.name), 'utf8'));
  }
  cleanup(stagedDir);
  return out;
}

// ---------------------------------------------------------------------------
// Comparison helper
// ---------------------------------------------------------------------------

const RUNTIMES = ['claude', 'cline', 'codex', 'hermes', 'kilo', 'opencode'];

function comparePipelines(runtime, registryOverride) {
  const { commandsGsd, agentsDir, root } = buildSourceTree(SAMPLE_AGENTS);
  const targetDir = buildTargetDir(commandsGsd);
  try {
    const ctx = { pathPrefix: `${targetDir}/`, attribution: undefined, targetDir };
    const inline = simulateInlineAgentLoop(runtime, agentsDir, ctx);
    const descriptor = runDescriptorPath(runtime, targetDir, ctx, registryOverride);
    return { inline, descriptor };
  } finally {
    cleanup(root);
    cleanup(targetDir);
  }
}

/** Asserts H1-H6 + H7 in one shot: same filenames (Set equality, order-free)
 *  AND byte-identical content per filename. */
function assertMapsIdentical(t, inline, descriptor) {
  assert.deepEqual(
    [...inline.keys()].sort(),
    [...descriptor.keys()].sort(),
    'filenames diverged between the inline loop and the descriptor path (row H7)',
  );
  for (const [name, inlineContent] of inline) {
    assert.equal(
      descriptor.get(name),
      inlineContent,
      `content diverged for ${name} between the inline loop and the descriptor path`,
    );
  }
}

// ---------------------------------------------------------------------------
// H1-H6 — the parity gate, one row per runtime
// ---------------------------------------------------------------------------

for (const runtime of RUNTIMES) {
  test(`agent-descriptor-parity: H row — ${runtime} inline loop and descriptor path are byte-identical`, (t) => {
    const { inline, descriptor } = comparePipelines(runtime);
    assert.ok(inline.size > 0, 'fixture produced no inline output — test is vacuous');
    assertMapsIdentical(t, inline, descriptor);
  });
}

// ---------------------------------------------------------------------------
// H7 — the harness compares filenames, not only content (meta)
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: H7 — a filename-only divergence fails the harness', () => {
  const { commandsGsd, agentsDir, root } = buildSourceTree(SAMPLE_AGENTS);
  const targetDir = buildTargetDir(commandsGsd);
  try {
    const ctx = { pathPrefix: `${targetDir}/`, attribution: undefined, targetDir };
    const inline = simulateInlineAgentLoop('claude', agentsDir, ctx);
    const descriptor = runDescriptorPath('claude', targetDir, ctx);
    // Deliberately rename one descriptor-side entry — same bytes, different name.
    const [firstName, firstContent] = [...descriptor.entries()][0];
    descriptor.delete(firstName);
    descriptor.set(`RENAMED-${firstName}`, firstContent);
    assert.throws(
      () => assertMapsIdentical({}, inline, descriptor),
      /filenames diverged/,
      'a renamed output file must fail the harness',
    );
  } finally {
    cleanup(root);
    cleanup(targetDir);
  }
});

// ---------------------------------------------------------------------------
// H8 — the harness can actually FAIL (mandatory, not optional)
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: H8 — a deliberately-divergent converter turns the harness RED', () => {
  // Feed hermes through a registry that dispatches to a converter which does
  // NOT match what the inline-loop replica calls (applyAgentBrandingRewrites)
  // — a bare identity pass-through, i.e. the branding rewrite silently
  // missing. This is exactly the failure mode section H exists to catch: the
  // wrong bytes reach disk and nothing throws on the descriptor side.
  const badRegistry = {
    runtimes: {
      hermes: {
        runtime: {
          artifactLayout: {
            global: [
              { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-', nesting: 'flat', recursive: false, converter: '__gsd_test_identity_converter__' },
            ],
            local: [],
          },
        },
      },
    },
  };
  // Install a deliberately-wrong converter under a throwaway export name —
  // never overwrites a real converter, so no other test can be poisoned by
  // this mutation even without a restore step.
  runtimeArtifactConversion.__gsd_test_identity_converter__ = (content) => content;
  try {
    const { commandsGsd, agentsDir, root } = buildSourceTree(SAMPLE_AGENTS);
    const targetDir = buildTargetDir(commandsGsd);
    try {
      const ctx = { pathPrefix: `${targetDir}/`, attribution: undefined, targetDir };
      const inline = simulateInlineAgentLoop('hermes', agentsDir, ctx);
      const descriptor = runDescriptorPath('hermes', targetDir, ctx, badRegistry);
      let threw = false;
      let observedDiff = null;
      try {
        assertMapsIdentical({}, inline, descriptor);
      } catch (err) {
        threw = true;
        observedDiff = err.message;
      }
      assert.equal(threw, true, 'H8 FAILED: the harness did not go red for a deliberately-divergent converter');
      assert.match(observedDiff, /content diverged for gsd-planner\.md/, 'expected the content-diverged assertion to name the mismatched file');
      // Verbatim red-proof output for the record (see CHANGES report):
      console.log(`H8 red-proof observed: ${observedDiff}`);
    } finally {
      cleanup(root);
      cleanup(targetDir);
    }
  } finally {
    delete runtimeArtifactConversion.__gsd_test_identity_converter__;
  }
});

// ---------------------------------------------------------------------------
// I1-I3 — per-agent resolution context
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: I3 — deriveAgentName matches the loop exactly, including a no-.md-suffix boundary', () => {
  assert.equal(runtimeArtifactConversion.deriveAgentName('gsd-planner.md'), 'gsd-planner');
  // Boundary: a filename with no trailing .md is returned unchanged (the
  // regex has nothing to match) — matches `entry.name.replace(/\.md$/, '')`.
  assert.equal(runtimeArtifactConversion.deriveAgentName('gsd-planner'), 'gsd-planner');
  assert.equal(runtimeArtifactConversion.deriveAgentName('gsd-planner.MD'), 'gsd-planner.MD');
});

test('agent-descriptor-parity: I2 — descriptor path with no agentCtx is unaffected (converter-only)', () => {
  const { commandsGsd, agentsDir, root } = buildSourceTree(SAMPLE_AGENTS);
  const targetDir = buildTargetDir(commandsGsd);
  try {
    const registry = syntheticRegistryFor('claude', null);
    const layout = runtimeArtifactLayout.resolveRuntimeArtifactLayoutFromRegistry(registry, 'claude', targetDir, 'global');
    const agentsKind = layout.kinds.find((k) => k.kind === 'agents');
    const stagedDir = agentsKind.stage({ name: 'full', skills: '*', agents: new Set() }); // no agentCtx
    const planner = fs.readFileSync(path.join(stagedDir, 'gsd-planner.md'), 'utf8');
    const original = fs.readFileSync(path.join(agentsDir, 'gsd-planner.md'), 'utf8');
    assert.equal(planner, original, 'no agentCtx must leave content byte-identical to source (converter:null == identity)');
    cleanup(stagedDir);
  } finally {
    cleanup(root);
    cleanup(targetDir);
  }
});

// ---------------------------------------------------------------------------
// J1-J4 — frontmatter extensions
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: J1 — claude effort is injected and byte-identical to the loop-equivalent call', () => {
  const content = '---\nname: gsd-planner\ndescription: x\n---\n\nBody.\n';
  const viaShared = runtimeArtifactConversion.applyAgentFrontmatterExtensions(content, { runtime: 'claude', agentName: 'gsd-planner', targetDir: null });
  assert.match(viaShared, /^effort: /m, 'expected an effort: key to be injected for claude');
});

test('agent-descriptor-parity: J2 — effort resolving to inherit writes NO effort: key at all (#3533 trap row)', () => {
  const content = '---\nname: gsd-inherit-agent\ndescription: x\n---\n\nBody.\n';
  const inheritCfg = { agent_overrides: { 'gsd-inherit-agent': 'inherit' } };
  // Exercise the pure half directly (resolveInstallTimeEffort / injectEffortFrontmatter)
  // — the trap this row guards against is injectEffortFrontmatter EVER being
  // called with the literal string 'inherit'.
  const installEffortResolver = require(path.join(LIB_DIR, 'install-effort-resolver.cjs'));
  const resolved = installEffortResolver.resolveInstallTimeEffort(inheritCfg, 'gsd-inherit-agent');
  assert.equal(resolved, 'inherit');
  // applyAgentFrontmatterExtensions must therefore never call injectEffortFrontmatter
  // for this agent when its config resolves to 'inherit'. We cannot inject a
  // custom effortCfg through the public seam (it reads ~/.gsd/defaults.json /
  // .planning/config.json), so assert the CONTRACT directly instead:
  const injected = runtimeArtifactConversion.injectEffortFrontmatter(content, 'inherit');
  assert.match(injected, /^effort: inherit$/m, 'sanity: injectEffortFrontmatter itself is dumb and WOULD write the literal — the guard is in applyAgentFrontmatterExtensions never calling it for "inherit"');
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

test('agent-descriptor-parity: J8 — kilo and opencode resolve model overrides through the SAME shared function', () => {
  // A regression test that fails if the two ever diverge: assert both runtime
  // branches in the inline-loop replica (and, by construction, convertedAgentsKind
  // in runtime-artifact-layout.cts) call installModelOverrideResolver.resolveAgentModelOverride
  // — not two independently-maintained copies of the precedence chain.
  const modelOverrides = { 'gsd-planner': 'shared/explicit' };
  const forKilo = installModelOverrideResolver.resolveAgentModelOverride('gsd-planner', modelOverrides, null);
  const forOpencode = installModelOverrideResolver.resolveAgentModelOverride('gsd-planner', modelOverrides, null);
  assert.equal(forKilo, forOpencode);
  assert.equal(forKilo, 'shared/explicit');
});

// ---------------------------------------------------------------------------
// J9-J10 — hermes branding converter
// ---------------------------------------------------------------------------

test('agent-descriptor-parity: J9 — hermes branding converter is byte-identical to the loop\'s inline replaces, including \\bClaude Code\\b word-boundary semantics', () => {
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
 * write it for the six runtimes migrated in this change) and the assertion
 * below would fail.
 */
test('agent-descriptor-parity: K1 — every registry runtime declaring an agents kind is reachable from installRuntimeArtifacts (the inline loop is gone)', () => {
  const capabilityRegistry = require(path.join(LIB_DIR, 'capability-registry.cjs'));
  const installEngine = require(path.join(LIB_DIR, 'install-engine.cjs'));

  const runtimesWithAgentsKind = Object.entries(capabilityRegistry.runtimes || {})
    .filter(([, cap]) => {
      const layout = cap.runtime && cap.runtime.artifactLayout;
      if (!layout) return false;
      const entries = [...(layout.global || []), ...(layout.local || [])];
      return entries.some((e) => e.kind === 'agents');
    })
    .map(([id]) => id);

  assert.ok(runtimesWithAgentsKind.length >= 6, 'sanity: expected at least the six #2875 Part 2 runtimes to declare an agents kind');

  for (const runtime of runtimesWithAgentsKind) {
    const { commandsGsd, agentsDir, root } = buildSourceTree(SAMPLE_AGENTS);
    const targetDir = buildTargetDir(commandsGsd);
    try {
      const resolvedProfile = { name: 'full', skills: '*', agents: new Set() };
      const result = installEngine.installRuntimeArtifacts(runtime, targetDir, 'global', resolvedProfile, () => undefined, undefined);
      const agentsKindEntry = result.kinds.find((k) => k.kind === 'agents');
      assert.ok(agentsKindEntry, `${runtime}: installRuntimeArtifacts reported no agents kind in the executed plan — it did not go through the descriptor path`);
      const writtenFiles = fs.readdirSync(agentsKindEntry.destDir).filter((f) => f.endsWith('.md'));
      assert.ok(writtenFiles.length > 0, `${runtime}: agents kind reported but nothing was actually written to ${agentsKindEntry.destDir}`);
    } finally {
      cleanup(root);
      cleanup(targetDir);
      void agentsDir;
    }
  }
});
