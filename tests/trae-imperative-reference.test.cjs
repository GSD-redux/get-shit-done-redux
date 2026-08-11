// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'trae'` string-equality branch remains in bin/install.js, src/install-engine.cts, and src/runtime-artifact-conversion.cts — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2094)
'use strict';

/**
 * trae imperative reference host — ADR-1239 Phase D / #2094 (EoS/trae).
 *
 * Proves Trae IDE is driven through the PUBLIC Host-Integration Interface
 * (the imperative adapter), that its negotiated axes classify + negotiate
 * correctly, that negotiation fails CLOSED on a corrupted descriptor, and
 * that the migration retired the hardcoded `runtime === 'trae'` string-
 * equality branches across the install engine and artifact conversion
 * modules (folded into descriptor-driven `runtime.hostBehaviors`).
 *
 * Trae has NO hook surface at all (`hooksSurface: "none"`,
 * `extendedHookEvents: []`, `installSurface: "profile-marker-only"`) — its
 * `hookBus` axis is `'engine'` (VSCode-fork extension-host lifecycle, not a
 * GSD-managed hook dialect), so unlike qwen/kilo this file does not assert an
 * extendedHookEvents surface. Four of Trae's six dispatch sub-axes
 * (`nested`, `maxDepth`, `subagentToolkit`, `backgroundDispatch`) are
 * `'undocumented'` — no authoritative Trae doc states them — which is what
 * drives the fail-closed `shouldFlattenDispatch` assertion below. The real
 * upgrade (SOLO stage/trigger metadata on emitted skills) is covered in
 * tests/trae-upgrades.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

process.env['GSD_TEST_MODE'] = '1';

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  shouldFlattenDispatch,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');
const { getProjectInstructionFile } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const { convertClaudeToTraeMarkdown } = require('../bin/install.js');
const runtimeArtifactConversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const { runMinimalInstall, walk } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');

const TRAE_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'trae', 'capability.json'), 'utf8'),
);
const TRAE_AXES = TRAE_CAP.runtime.hostIntegration;

// -- AC2: driven through the public interface (imperative adapter) -----------

test('createImperativeAdapter classifies trae as imperative + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'trae' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'trae');
  assert.ok(adapter.registry && typeof adapter.registry === 'object');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('trae axes classify as the programmatic-cli reference profile', () => {
  // Confirmed via `node -e` against the real descriptor before asserting:
  // profileOf(TRAE_AXES) === 'programmatic-cli' (embeddingMode: 'imperative').
  assert.equal(profileOf(TRAE_AXES), 'programmatic-cli');
});

// -- AC3: all axes populated + validated -------------------------------------

test('trae descriptor declares all 8 axes + 6 dispatch sub-axes with exact values', () => {
  assert.equal(TRAE_AXES.embeddingMode, 'imperative');
  assert.equal(TRAE_AXES.commandSurface, 'slash-file');
  assert.equal(TRAE_AXES.modelMode, 'passive');
  assert.equal(TRAE_AXES.hookBus, 'engine');
  assert.equal(TRAE_AXES.stateIO, 'filesystem');
  assert.equal(TRAE_AXES.transport, 'mcp');
  assert.equal(TRAE_AXES.runtime, 'node');
  const d = TRAE_AXES.dispatch;
  assert.equal(d.namedDispatch, true);
  assert.equal(d.nested, 'undocumented');
  assert.equal(d.maxDepth, 'undocumented');
  assert.equal(d.background, true);
  assert.equal(d.subagentToolkit, 'undocumented');
  assert.equal(d.backgroundDispatch, 'undocumented');
});

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for trae, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...TRAE_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...TRAE_AXES, embeddingMode: 'future-unknown' }));
});

test('AC-SPECIFIC: trae real dispatch axes fail CLOSED to inline (shouldFlattenDispatch === true)', () => {
  // Confirmed via `node -e` against the real descriptor before asserting:
  // shouldFlattenDispatch(TRAE_AXES.dispatch) === true.
  //
  // shouldFlattenDispatch only permits backgrounding when BOTH `background`
  // AND `backgroundDispatch` are explicitly `true` (src/host-integration.cts
  // shouldFlattenDispatch, `canBackground = background === true &&
  // backgroundDispatch === true`). Trae's `background` is `true` but
  // `backgroundDispatch` is `'undocumented'` (no authoritative Trae doc states
  // whether a spawned agent can itself be backgrounded) — so canBackground is
  // false and the orchestrator must run inline. Pinned here so a future
  // doc-sourcing pass that fills in `backgroundDispatch` can't silently flip
  // this fail-closed default without a deliberate test update.
  assert.equal(shouldFlattenDispatch(TRAE_AXES.dispatch), true);

  // #2939: flipping ONLY backgroundDispatch to true is NO LONGER sufficient to
  // background. trae's axes declare nested:'undocumented' (not true) and
  // subagentToolkit:'undocumented' (not 'full'), so even with backgroundDispatch
  // true the depth/nesting gate (canNest) fails closed to flatten. A future
  // doc-sourcing pass must also establish nested:true + subagentToolkit:'full' +
  // a sufficient maxDepth before trae may background.
  assert.equal(shouldFlattenDispatch({ ...TRAE_AXES.dispatch, backgroundDispatch: true }), true);
});

test('a partial/empty trae descriptor degrades to the safe floor, not the programmatic-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['programmatic-cli']);
  assert.ok(result.warnings.length > 0);
});

// -- AC2: the folded-in behaviors ---------------------------------------------

test('trae descriptor declares runtime.hostBehaviors (the folded-in behaviors)', () => {
  const hb = TRAE_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.skipSharedHooksInstall, true);
  assert.equal(hb.soloStageMetadata, 'workflow');
});

// -- AC2: the hardcoded branches are retired across all folded modules -------

test('no `runtime === "trae"` string-equality branch remains in the descriptor-migrated modules (AC2)', () => {
  // NOTE: this deliberately does NOT grep for `isTrae` — `isTrae` legitimately
  // remains in bin/install.js as a destructured `runtimeFlags(runtime)`
  // binding used ONLY by the agents-converter dispatch chain (`else if
  // (isTrae) { content = convertClaudeAgentToTraeAgent(content); }`). That
  // cross-runtime agents-converter dispatch is out of scope for #2094 (a
  // separate migration tracked elsewhere) — trae stays in RUNTIME_FLAG_IDS by
  // design until that follow-up lands. Only a `runtime === 'trae'` /
  // `runtime !== 'trae'` STRING-EQUALITY comparison is a regression here.
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const repoRoot = path.join(__dirname, '..');
  const files = [
    path.join(repoRoot, 'bin', 'install.js'),
    path.join(repoRoot, 'src', 'install-engine.cts'),
    path.join(repoRoot, 'src', 'runtime-artifact-conversion.cts'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const offenders = strip(src).match(/runtime\s*[!=]==\s*'trae'/g) || [];
    assert.deepEqual(offenders, [],
      `AC2: no hardcoded runtime==='trae' branch may remain in ${path.relative(repoRoot, file)}; found: ${offenders.join(', ')}`);
  }
});

// -- folded from tests/fix-2658-trae-runtime-detection-and-instruction-path.test.cjs (#3333) --

/**
 * Regression tests for #2658 — Trae runtime not detected in workflow
 * runtime-detection blocks (falls back to claude), and the install-time
 * `CLAUDE.md` path rewrite mutilates the claude fallback into a malformed
 * path instead of resolving to the Trae rules file.
 *
 * Defects collided (see
 * .gsd/bug/fix-2658-trae-runtime-not-detected-falls-back-to-/10-diagnosis.md):
 *
 *   1. `gsd-core/workflows/new-project.md` AND `gsd-core/workflows/ingest-docs.md`
 *      (found during this remediation — same pattern, same gap, not just
 *      new-project.md as originally reported) never recognized trae (path
 *      `/.trae/` or env `TRAE_CONFIG_DIR`) in their runtime-detection blocks —
 *      fell through to `RUNTIME=claude`.
 *   2. The `trae.js` entry in `bin/install.js`'s `RUNTIME_CONTENT_DISPATCH`
 *      replaced bare `CLAUDE.md` first, leaving a stale `.claude/` prefix:
 *      `.claude/CLAUDE.md` -> `.claude/.trae/rules/`.
 *   3. `convertClaudeToTraeMarkdown` (mirrored in `bin/install.js` and
 *      `src/runtime-artifact-conversion.cts`) had the same class of bug but a
 *      DIFFERENT wrong output (`.trae/.trae/rules/`), because its generic
 *      `.claude/` -> `.trae/` rewrite ran after the bare `CLAUDE.md` rewrite
 *      and re-mutated the leftover prefix.
 *   4. `capabilities/trae/capability.json` didn't declare
 *      `hostBehaviors.projectInstructionFile`, so even a correctly-detected
 *      trae runtime resolved to the generic `AGENTS.md` default via
 *      `getProjectInstructionFile`.
 *   5. Found by the end-to-end install test below, one level deeper than the
 *      static trace: `copyWithPathReplacement` (bin/install.js) runs a
 *      GENERIC `~/.claude/` / `$HOME/.claude/` / `./.claude/` -> runtime-dir
 *      rewrite on every .md file BEFORE calling `convertClaudeToTraeMarkdown`,
 *      substituting a `pathPrefix` the converter is never given (it differs
 *      per install: relative for a project-local install, an arbitrary
 *      absolute path for a local install rooted elsewhere, `~/.trae/` for a
 *      global one). The converter's `.claude/CLAUDE.md`-specific patterns
 *      (defect 3's fix) never fire on that already-rewritten text, and the
 *      bare fallback still doubles the prefix — a first attempt at fixing
 *      this handled only the `./.trae/CLAUDE.md` shape and missed the
 *      `~/.claude/` / `$HOME/.claude/` forms `gsd-core/workflows/profile-user.md`
 *      actually uses, caught by row 12 (the real spawned install) below on a
 *      second run. Fixed with a prefix-preserving pattern (capture whatever
 *      precedes a `.trae/` tail, keep it, fix only the filename suffix)
 *      instead of assuming one fixed shape.
 */
describe('#2658: trae runtime detection and instruction path (folded from fix-2658-trae-runtime-detection-and-instruction-path.test.cjs)', () => {
  const REPO_ROOT = path.join(__dirname, '..');
  const MALFORMED_SINGLE = '.claude/.trae/rules';
  const MALFORMED_DOUBLE = '.trae/.trae/rules';
  const EXPECTED_PATH = '.trae/rules/rules.md';

  describe('#2658 acceptance criterion 2: getProjectInstructionFile resolves trae to a concrete file', () => {
    test('trae maps to .trae/rules/rules.md (not the generic AGENTS.md default)', () => {
      assert.strictEqual(getProjectInstructionFile('trae'), EXPECTED_PATH);
    });

    test('capability descriptor declares the same path getProjectInstructionFile returns', () => {
      const cap = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'trae', 'capability.json'), 'utf8'),
      );
      assert.strictEqual(cap.runtime.hostBehaviors.projectInstructionFile, EXPECTED_PATH);
      assert.strictEqual(getProjectInstructionFile('trae'), cap.runtime.hostBehaviors.projectInstructionFile);
    });

    test('the declared path is a concrete file, not a bare directory (acceptance criterion 2)', () => {
      assert.ok(!EXPECTED_PATH.endsWith('/'), 'must not be directory-terminated');
      assert.ok(/\.md$/.test(EXPECTED_PATH), 'must name a concrete markdown file');
    });
  });

  describe('#2658: convertClaudeToTraeMarkdown never mutilates the CLAUDE.md path (bin/install.js)', () => {
    const cases = [
      ['bare CLAUDE.md', 'See CLAUDE.md for details.'],
      ['./CLAUDE.md', 'Read ./CLAUDE.md before starting.'],
      ['backtick-wrapped `CLAUDE.md`', 'The file `CLAUDE.md` is authoritative.'],
      ['the exact reported-bug input: .claude/CLAUDE.md', 'Fallback path is .claude/CLAUDE.md by default.'],
      ['backtick-wrapped .claude/CLAUDE.md', 'Fallback: `.claude/CLAUDE.md`.'],
      ['./.claude/CLAUDE.md', 'From root: ./.claude/CLAUDE.md'],
    ];
    for (const [label, input] of cases) {
      test(`${label} -> ${EXPECTED_PATH}, no malformed output`, () => {
        const out = convertClaudeToTraeMarkdown(input);
        assert.ok(!out.includes(MALFORMED_SINGLE), `output must not contain "${MALFORMED_SINGLE}": ${out}`);
        assert.ok(!out.includes(MALFORMED_DOUBLE), `output must not contain "${MALFORMED_DOUBLE}": ${out}`);
        assert.ok(out.includes(EXPECTED_PATH), `output must contain "${EXPECTED_PATH}": ${out}`);
      });
    }

    test('fast-check property: any surrounding text around .claude/CLAUDE.md never yields a malformed path', () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 40 }),
          fc.string({ maxLength: 40 }),
          (prefix, suffix) => {
            const content = `${prefix}.claude/CLAUDE.md${suffix}`;
            const out = convertClaudeToTraeMarkdown(content);
            assert.ok(!out.includes(MALFORMED_SINGLE));
            assert.ok(!out.includes(MALFORMED_DOUBLE));
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('#2658 defect 5: post-generic-rewrite ".trae/"-prefixed forms preserve their prefix instead of doubling it', () => {
    // These simulate the text `copyWithPathReplacement`'s generic `~/.claude/` /
    // `$HOME/.claude/` / `./.claude/` -> runtime-dir pass hands to
    // convertClaudeToTraeMarkdown — the converter never sees the original
    // `.claude/`-prefixed source in this pipeline, only these already-rewritten
    // shapes. A fixed-shape patch that only handled the local relative form
    // left the local-install-absolute-path and global tilde forms broken.
    const cases = [
      ['local relative (post "./.claude/" -> "./.trae/" rewrite)', './.trae/CLAUDE.md', './.trae/rules/rules.md'],
      [
        'local install absolute path (post "./.claude/" -> "<tmp-root>/.trae/" rewrite)',
        '/private/var/folders/xx/gsd-trae-local-abc123/.trae/CLAUDE.md',
        '/private/var/folders/xx/gsd-trae-local-abc123/.trae/rules/rules.md',
      ],
      ['global tilde (post "~/.claude/" -> "~/.trae/" rewrite)', '~/.trae/CLAUDE.md', '~/.trae/rules/rules.md'],
      ['backtick-wrapped local relative', '`./.trae/CLAUDE.md`', '`./.trae/rules/rules.md`'],
    ];
    for (const [label, input, expected] of cases) {
      test(`${label} -> prefix preserved, no malformed path`, () => {
        const out = convertClaudeToTraeMarkdown(input);
        assert.ok(!out.includes(MALFORMED_SINGLE), `output must not contain "${MALFORMED_SINGLE}": ${out}`);
        assert.ok(!out.includes(MALFORMED_DOUBLE), `output must not contain "${MALFORMED_DOUBLE}": ${out}`);
        assert.strictEqual(out, expected);
      });
    }

    test('fast-check property: any arbitrary path ending in .trae/ never yields a doubled prefix', () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 30 }).filter((s) => !s.includes('`') && !/\s/.test(s)),
          (prefix) => {
            const content = `${prefix}.trae/CLAUDE.md`;
            const out = convertClaudeToTraeMarkdown(content);
            assert.ok(!out.includes(MALFORMED_SINGLE));
            assert.ok(!out.includes(MALFORMED_DOUBLE));
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('#2658 output parity: bin/install.js vs runtime-artifact-conversion.cjs convertClaudeToTraeMarkdown (#2094 mirror)', () => {
    // Parity must hold for the pre-existing reported-bug input AND for every
    // arbitrary-prefix ".trae/"-tail shape the prefix-preserving regex
    // (bin/install.js:2747-2748, mirrored byte-for-byte at
    // src/runtime-artifact-conversion.cts:1357-1358) was added to handle. A
    // change to only one copy of that regex would otherwise pass every other
    // test in this file — none of the defect-5 cases above call the mirror —
    // while silently diverging from the other copy.
    const parityCases = [
      ['the reported-bug input (bare .claude/ prefix)', 'Fallback path is .claude/CLAUDE.md by default.'],
      ['local relative prefix (post "./.claude/" -> "./.trae/" rewrite)', './.trae/CLAUDE.md'],
      [
        'nested project-path absolute prefix (post "./.claude/" -> "<tmp-root>/.trae/" rewrite)',
        '/private/var/folders/xx/gsd-trae-local-abc123/.trae/CLAUDE.md',
      ],
      ['global tilde prefix (post "~/.claude/" -> "~/.trae/" rewrite)', '~/.trae/CLAUDE.md'],
      ['$HOME-variable prefix (post "$HOME/.claude/" -> "$HOME/.trae/" rewrite)', '$HOME/.trae/CLAUDE.md'],
      ['backtick-wrapped local relative prefix', '`./.trae/CLAUDE.md`'],
    ];

    for (const [label, input] of parityCases) {
      test(`identical output for ${label}`, () => {
        assert.strictEqual(
          convertClaudeToTraeMarkdown(input),
          runtimeArtifactConversion.convertClaudeToTraeMarkdown(input),
        );
      });
    }

    test('fast-check property: any arbitrary ".trae/"-tail path produces identical output in both implementations', () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 30 }).filter((s) => !s.includes('`') && !/\s/.test(s)),
          (prefix) => {
            const content = `${prefix}.trae/CLAUDE.md`;
            assert.strictEqual(
              convertClaudeToTraeMarkdown(content),
              runtimeArtifactConversion.convertClaudeToTraeMarkdown(content),
            );
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('#2658: end-to-end --trae install never emits the malformed path (acceptance criterion 1)', () => {
    test('local install: no emitted .md/.js/.cjs file contains the malformed strings; the rules file is concrete', () => {
      const { configDir, root } = runMinimalInstall({ runtime: 'trae', scope: 'local' });
      try {
        const files = walk(configDir)
          .filter((f) => /\.(md|js|cjs)$/.test(f))
          // gsd-core/CHANGELOG.md is excluded by exact relative path (not a blanket
          // .md skip — the emitted agent/command/workflow markdown this gate exists
          // to guard stays fully scanned). CHANGELOG.md legitimately QUOTES the
          // malformed `.claude/.trae/rules` / `.trae/.trae/rules` strings while
          // documenting the #2658 fix itself (#3006) — that historical-value
          // citation is not a regression of the installer's actual output. Verified
          // empirically: excluding only this one file drops the hit count to zero
          // across all 620 other emitted files.
          .filter((f) => f.split(path.sep).join('/').indexOf('gsd-core/CHANGELOG.md') === -1);
        assert.ok(files.length > 0, 'expected at least one emitted .md/.js/.cjs file');
        for (const file of files) {
          const content = fs.readFileSync(file, 'utf8');
          assert.ok(!content.includes(MALFORMED_SINGLE), `${file} must not contain "${MALFORMED_SINGLE}"`);
          assert.ok(!content.includes(MALFORMED_DOUBLE), `${file} must not contain "${MALFORMED_DOUBLE}"`);
        }
      } finally {
        cleanup(root);
      }
    });
  });

  describe('#2658 acceptance criterion 3: new-project.md / ingest-docs.md detect trae before falling back to claude', () => {
    const workflowsDir = path.join(REPO_ROOT, 'gsd-core', 'workflows');

    test('new-project.md recognizes /.trae/ path and TRAE_CONFIG_DIR before the claude fallback', () => {
      const content = fs.readFileSync(path.join(workflowsDir, 'new-project.md'), 'utf8');
      const pathBlock = content.match(/Derive `RUNTIME`[\s\S]*?Otherwise → `RUNTIME=claude`/);
      assert.ok(pathBlock, 'runtime-detection path block must exist');
      assert.ok(
        /Path contains `\/\.trae\/` → `RUNTIME=trae`/.test(pathBlock[0]),
        'path-based detection must recognize /.trae/ before the claude fallback',
      );
      const envBlock = content.match(/if \[ -n "\$CODEX_HOME" \][\s\S]*?else RUNTIME="claude"; fi/);
      assert.ok(envBlock, 'env-var fallback block must exist');
      assert.ok(
        /TRAE_CONFIG_DIR/.test(envBlock[0]),
        'env-var fallback must recognize TRAE_CONFIG_DIR before the claude fallback',
      );
    });

    test('ingest-docs.md carries the same trae detection (found during this remediation, not just new-project.md)', () => {
      const content = fs.readFileSync(path.join(workflowsDir, 'ingest-docs.md'), 'utf8');
      const block = content.match(/\*\*Detect runtime\*\*[\s\S]*?else → `RUNTIME=claude`/);
      assert.ok(block, 'runtime-detection block must exist');
      assert.ok(
        /`\/\.trae\/` → `RUNTIME=trae`/.test(block[0]),
        'ingest-docs.md must also recognize /.trae/ before the claude fallback',
      );
      assert.ok(/TRAE_CONFIG_DIR/.test(content), 'env-var fallback mention must include TRAE_CONFIG_DIR');
    });
  });
});
