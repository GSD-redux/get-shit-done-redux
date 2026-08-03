'use strict';

/**
 * Equivalence proof for ADR-857 phase 5d: descriptor-driven resolveRuntimeArtifactLayout.
 *
 * For every runtime in the 15-entry capability registry × {global, local} scopes,
 * this test asserts that:
 *   1. kind.kind, kind.destSubpath, kind.prefix are byte-identical to the STEP-0
 *      golden captured from the old switch() before any edits.
 *   2. typeof kind.stage === 'function' for every kind.
 *   3. layout.runtime === runtime, layout.configDir === configDir, layout.scope === scope.
 *
 * SCOPE-FALL-THROUGH NOTE:
 *   The old switch() had no scope branches for 12 runtimes (cursor, codex,
 *   copilot, antigravity, windsurf, augment, trae, qwen, hermes, codebuddy, opencode,
 *   kilo), meaning scope='local' returned the same kinds as scope='global'. The 5a
 *   descriptors incorrectly set local:[] for those runtimes, causing 31 local-install
 *   test regressions. The 5b backfill sets local == global for these 12, restoring
 *   the old switch's scope-agnostic behaviour.
 *
 *   For runtimes that had explicit scope branches in the old switch
 *   (claude: distinct local=commands+agents; cline: local=[]; kimi: local=[]),
 *   the STEP-0 golden matches the descriptor exactly and is left unchanged.
 *
 * Unknown runtime case:
 *   Missing runtime descriptors throw the same TypeError as the old table:
 *     TypeError: Unknown runtime: 'grok' — add to runtime-artifact-layout.cjs table
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  resolveRuntimeArtifactLayout,
  resolveRuntimeArtifactLayoutFromRegistry,
} = require(
  path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-layout.cjs'),
);

const FAKE_DIR = '/tmp/fake-config-dir-dd';

// ── STEP-0 golden (captured from switch BEFORE edits) ────────────────────────
// Format: { kind, destSubpath, prefix } for each entry in kinds[].
// 'function' means we assert typeof kind.stage === 'function'.
// ADR-1235 step 1 (#1763): cursor, windsurf, augment, trae, codebuddy each gained
// an `agents` kind (appended last). Goldens consciously updated post-cutover.

const GOLDEN = {
  // ── claude ──────────────────────────────────────────────────────────────────
  'claude/global': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
  ],
  'claude/local': [
    { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' }, // #1367: flat gsd-<cmd>.md
    { kind: 'agents',   destSubpath: 'agents',   prefix: 'gsd-' },
  ],

  // ── cursor ───────────────────────────────────────────────────────────────────
  // Old switch: BOTH scopes returned [skills, commands] (no scope branch).
  // 5b backfill: local == global.
  // ADR-1235 step 1 (#1763): agents kind added.
  // #2644: commands are deliberately retired so Cursor exposes a single skills surface.
  'cursor/global': [
    { kind: 'skills',   destSubpath: 'skills',   prefix: 'gsd-' },
    { kind: 'agents',   destSubpath: 'agents',   prefix: 'gsd-' },
  ],
  'cursor/local': [
    { kind: 'skills',   destSubpath: 'skills',   prefix: 'gsd-' },
    { kind: 'agents',   destSubpath: 'agents',   prefix: 'gsd-' },
  ],

  // ── codex ────────────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  'codex/global': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
  ],
  'codex/local': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
  ],

  // ── copilot ──────────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  // #1575: agents kind added (copilot cutover — .agent.md rename handled by _copyStaged).
  'copilot/global': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],
  'copilot/local': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],

  // ── antigravity ──────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  // #1575: agents kind added (antigravity cutover — scope-aware converter).
  'antigravity/global': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],
  'antigravity/local': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],

  // ── windsurf ─────────────────────────────────────────────────────────────────
  // ADR-1235 step 1 (#1763): agents kind added to both scopes.
  'windsurf/global': [
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],
  'windsurf/local': [
    { kind: 'commands', destSubpath: 'workflows', prefix: 'gsd-' },
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],

  // ── augment ──────────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  // ADR-1235 step 1 (#1763): agents kind added.
  'augment/global': [
    { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' },
    { kind: 'skills',   destSubpath: 'skills',   prefix: 'gsd-' },
    { kind: 'agents',   destSubpath: 'agents',   prefix: 'gsd-' },
  ],
  'augment/local': [
    { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' },
    { kind: 'skills',   destSubpath: 'skills',   prefix: 'gsd-' },
    { kind: 'agents',   destSubpath: 'agents',   prefix: 'gsd-' },
  ],

  // ── trae ─────────────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  // ADR-1235 step 1 (#1763): agents kind added.
  'trae/global': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],
  'trae/local': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],

  // ── qwen ─────────────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  // ADR-1239 / #2092 Phase B Upgrade 1: agents kind added (native
  // .qwen/agents/*.md subagent projection).
  'qwen/global': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],
  'qwen/local': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
    { kind: 'agents', destSubpath: 'agents', prefix: 'gsd-' },
  ],

  // ── hermes ───────────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  'hermes/global': [
    { kind: 'skills', destSubpath: 'skills/gsd', prefix: 'gsd-' },
  ],
  'hermes/local': [
    { kind: 'skills', destSubpath: 'skills/gsd', prefix: 'gsd-' },
  ],

  // ── codebuddy ────────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  // ADR-1235 step 1 (#1763): agents kind added.
  'codebuddy/global': [
    { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' },
    { kind: 'skills',   destSubpath: 'skills',   prefix: 'gsd-' },
    { kind: 'agents',   destSubpath: 'agents',   prefix: 'gsd-' },
  ],
  'codebuddy/local': [
    { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' },
    { kind: 'skills',   destSubpath: 'skills',   prefix: 'gsd-' },
    { kind: 'agents',   destSubpath: 'agents',   prefix: 'gsd-' },
  ],

  // ── cline ────────────────────────────────────────────────────────────────────
  // Old switch: scope='global' → [skills]; scope='local' → []. Matches descriptor.
  'cline/global': [
    { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-' },
  ],
  'cline/local': [],

  // ── kimi ─────────────────────────────────────────────────────────────────────
  // Old switch: scope='global' → [skills, kimi-agents]; scope='local' → []. Matches descriptor.
  'kimi/global': [
    { kind: 'skills',      destSubpath: 'skills', prefix: 'gsd-' },
    { kind: 'kimi-agents', destSubpath: 'agents', prefix: 'gsd'  },
  ],
  'kimi/local': [],

  // ── opencode ─────────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  // #2329: destSubpath corrected from singular 'command' to plural 'commands' —
  // OpenCode discovers slash commands from commands/ (plural); the singular
  // command/ dir GSD previously wrote to is not scanned by OpenCode 1.17.13,
  // so none of the ~71 /gsd-* commands ever appeared in the OpenCode TUI.
  'opencode/global': [
    { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' },
    { kind: 'skills',   destSubpath: 'skills',   prefix: 'gsd-' },
  ],
  'opencode/local': [
    { kind: 'commands', destSubpath: 'commands', prefix: 'gsd-' },
    { kind: 'skills',   destSubpath: 'skills',   prefix: 'gsd-' },
  ],

  // ── kilo ─────────────────────────────────────────────────────────────────────
  // Old switch: no scope branch → local == global. 5b backfill restores this.
  'kilo/global': [
    { kind: 'commands', destSubpath: 'command', prefix: 'gsd-' },
    { kind: 'skills',   destSubpath: 'skills',  prefix: 'gsd-' },
  ],
  'kilo/local': [
    { kind: 'commands', destSubpath: 'command', prefix: 'gsd-' },
    { kind: 'skills',   destSubpath: 'skills',  prefix: 'gsd-' },
  ],
};

// ── Parametrized tests ────────────────────────────────────────────────────────

const RUNTIMES = [
  'claude', 'cursor', 'codex', 'copilot',
  'antigravity', 'windsurf', 'augment', 'trae', 'qwen',
  'hermes', 'codebuddy', 'cline', 'kimi', 'opencode', 'kilo',
];

for (const runtime of RUNTIMES) {
  for (const scope of ['global', 'local']) {
    const key = `${runtime}/${scope}`;
    const expected = GOLDEN[key];
    assert.ok(
      expected !== undefined,
      `GOLDEN missing entry for ${key} — update the golden table`,
    );

    describe(`resolveRuntimeArtifactLayout — ${runtime} ${scope} (descriptor-driven)`, () => {
      test(`kinds array matches STEP-0 golden for ${runtime}/${scope}`, () => {
        const layout = resolveRuntimeArtifactLayout(runtime, FAKE_DIR, /** @type {'local'|'global'} */ (scope));

        // Structural fields
        assert.strictEqual(layout.runtime,   runtime,   'layout.runtime');
        assert.strictEqual(layout.configDir, FAKE_DIR,  'layout.configDir');
        assert.strictEqual(layout.scope,     scope,     'layout.scope');

        // kinds length matches golden
        assert.strictEqual(
          layout.kinds.length,
          expected.length,
          `kinds.length for ${key}: expected ${expected.length}, got ${layout.kinds.length}`,
        );

        // Per-kind field checks
        for (let i = 0; i < expected.length; i++) {
          const actual = layout.kinds[i];
          const exp    = expected[i];

          assert.strictEqual(
            actual.kind,
            exp.kind,
            `kinds[${i}].kind for ${key}`,
          );
          assert.strictEqual(
            actual.destSubpath,
            exp.destSubpath,
            `kinds[${i}].destSubpath for ${key}`,
          );
          assert.strictEqual(
            actual.prefix,
            exp.prefix,
            `kinds[${i}].prefix for ${key}`,
          );
          assert.strictEqual(
            typeof actual.stage,
            'function',
            `kinds[${i}].stage must be a function for ${key}`,
          );
        }
      });
    });
  }
}

// ── Unknown runtime ───────────────────────────────────────────────────────────
// Missing descriptors reproduce the old loud-fail behaviour.

describe('resolveRuntimeArtifactLayout — unknown runtime (descriptor-driven)', () => {
  test('throws TypeError for grok (no artifact layout descriptor)', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('grok', FAKE_DIR, 'global'),
      (err) => {
        assert.ok(err instanceof TypeError, 'must be TypeError');
        assert.ok(
          err.message.includes("Unknown runtime: 'grok'"),
          `message must include "Unknown runtime: 'grok'" — got: ${err.message}`,
        );
        return true;
      },
    );
  });

  test('throws TypeError for an arbitrary unknown string', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('notaruntime', FAKE_DIR, 'global'),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.ok(err.message.includes("Unknown runtime: 'notaruntime'"));
        return true;
      },
    );
  });
});

describe('resolveRuntimeArtifactLayout — descriptor-only future runtime', () => {
  test('accepts a synthetic descriptor-backed runtime without a parallel allowlist update', () => {
    const registry = {
      runtimes: {
        futurecli: {
          runtime: {
            artifactLayout: {
              global: [
                {
                  kind: 'commands',
                  destSubpath: 'commands',
                  prefix: 'gsd-',
                  nesting: 'flat',
                  recursive: false,
                  converter: null,
                },
              ],
              local: [],
            },
          },
        },
      },
    };

    const layout = resolveRuntimeArtifactLayoutFromRegistry(
      registry,
      'futurecli',
      FAKE_DIR,
      'global',
    );

    assert.strictEqual(layout.runtime, 'futurecli');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.scope, 'global');
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'commands');
    assert.strictEqual(layout.kinds[0].destSubpath, 'commands');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

// ── Scope default ─────────────────────────────────────────────────────────────
// resolveRuntimeArtifactLayout(runtime, configDir) with no scope arg → 'global'.

describe('resolveRuntimeArtifactLayout — scope defaults to global (descriptor-driven)', () => {
  test('omitting scope yields global layout for claude', () => {
    const withDefault  = resolveRuntimeArtifactLayout('claude', FAKE_DIR);
    const withExplicit = resolveRuntimeArtifactLayout('claude', FAKE_DIR, 'global');
    assert.strictEqual(withDefault.scope, 'global', 'default scope must be "global"');
    assert.strictEqual(withDefault.kinds.length, withExplicit.kinds.length);
    for (let i = 0; i < withDefault.kinds.length; i++) {
      assert.strictEqual(withDefault.kinds[i].kind,        withExplicit.kinds[i].kind);
      assert.strictEqual(withDefault.kinds[i].destSubpath, withExplicit.kinds[i].destSubpath);
      assert.strictEqual(withDefault.kinds[i].prefix,      withExplicit.kinds[i].prefix);
    }
  });

  test('omitting scope yields global layout for kimi (2 kinds)', () => {
    const layout = resolveRuntimeArtifactLayout('kimi', FAKE_DIR);
    assert.strictEqual(layout.scope, 'global');
    assert.strictEqual(layout.kinds.length, 2);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[1].kind, 'kimi-agents');
  });
});

// ── Non-vacuous check: verify at least one multi-kind runtime ─────────────────

describe('resolveRuntimeArtifactLayout — multi-kind runtimes non-vacuous (descriptor-driven)', () => {
  test('augment global returns 3 kinds (commands + skills + agents)', () => {
    const layout = resolveRuntimeArtifactLayout('augment', FAKE_DIR, 'global');
    assert.strictEqual(layout.kinds.length, 3);
    assert.strictEqual(layout.kinds[0].kind, 'commands');
    assert.strictEqual(layout.kinds[1].kind, 'skills');
    assert.strictEqual(layout.kinds[2].kind, 'agents');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
    assert.strictEqual(typeof layout.kinds[1].stage, 'function');
    assert.strictEqual(typeof layout.kinds[2].stage, 'function');
  });

  test('kimi global returns skills then kimi-agents', () => {
    const layout = resolveRuntimeArtifactLayout('kimi', FAKE_DIR, 'global');
    assert.strictEqual(layout.kinds.length, 2);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[1].kind, 'kimi-agents');
    assert.strictEqual(layout.kinds[1].destSubpath, 'agents');
    assert.strictEqual(layout.kinds[1].prefix, 'gsd');
  });

  test('codebuddy global returns commands then skills then agents', () => {
    const layout = resolveRuntimeArtifactLayout('codebuddy', FAKE_DIR, 'global');
    assert.strictEqual(layout.kinds.length, 3);
    assert.strictEqual(layout.kinds[0].kind, 'commands');
    assert.strictEqual(layout.kinds[1].kind, 'skills');
    assert.strictEqual(layout.kinds[2].kind, 'agents');
  });
});
