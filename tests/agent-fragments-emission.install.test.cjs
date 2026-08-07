'use strict';

// allow-test-rule: source-text-is-the-product see #2995 — this suite asserts on the literal bytes of
// EMITTED install artifacts, which ARE the deployed contract: a leaked `gsd:section` marker
// byte ships to every user and is loaded verbatim into a subagent's context on every dispatch.
// Same exemption basis as tests/workflow-fragments-emission.install.test.cjs (#2930).

/**
 * agent-fragments-emission.install.test.cjs — 50-test-matrix.md rows 5, 21, 22
 * (issue #2995, epic #1671 Phase 6.4).
 *
 * Extends `composeWorkflow`'s emission guarantee from `gsd-core/workflows/` to
 * `agents/`. An engine-direct assertion is false-green for install behavior
 * (ADR-1671 "Architecture and contracts"), so every row here spawns a REAL
 * installer and reads what actually reached disk.
 *
 * ── Why this suite is ONE table-driven sweep ────────────────────────────────
 *
 * Agent content is read for emission at FOUR independent points, established by
 * graph analysis in .gsd/phase/chore-2995-agents-fragment-emission/40-design.md:
 *
 *   1. bin/install.js's inline agent loop   — non-descriptor runtimes
 *   2. stageAgentsForRuntimeWithConverter   — the 9 descriptor runtimes
 *   3. kimiAgentsKind's own readFileSync    — kimi
 *   4. agentsKind (converter: null)         — claude(local), zcode
 *
 * Point 4 never reads content into JS at all: `stageAgentsForProfile` returns a
 * raw byte copy — or, under the DEFAULT `full` profile, the real unstaged
 * `agents/` directory itself — and `_copyStaged` copies bytes.
 *
 * Four parallel surfaces sharing one parser is the `DEFECT.GENERATIVE-FIX`
 * class. A structural test per read point needs updating whenever a fifth
 * appears, which is the update everyone forgets. So the guard is BEHAVIORAL and
 * exhaustive: install every runtime at every scope that could carry agents and
 * assert no marker survives. A fifth read point added without composition fails
 * this test without anyone remembering to extend it.
 *
 * The runtime set is derived from RUNTIME_META and the capability registry at
 * run time, never a hardcoded count, so a newly supported runtime cannot be
 * silently under-covered.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

const { cleanup } = require('./helpers.cjs');
const { RUNTIME_META, installerEnv, walk } = require('./helpers/install-shared.cjs');
const { buildOverlayRepo } = require('./helpers/overlay-repo.cjs');

const REPO_ROOT = path.join(__dirname, '..');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

/** The agent used as the marker probe. Any agent works — this suite proves the
 *  EMISSION PATH, not this file's own content. gsd-codebase-mapper is the
 *  smallest LARGE-tier agent, so the overlay stays cheap. */
const PROBE_AGENT_REL = 'agents/gsd-codebase-mapper.md';

/** Sentinel INSIDE the marked section. Its presence proves the body survived: a
 *  `when="always"` section must be kept, not dropped. Without this, an emission
 *  path that dropped the whole section would pass a marker-absence check
 *  vacuously. */
const BODY_SENTINEL = 'GSD2995 probe body retained sentinel';
const MARKER_TOKEN = 'gsd:section';

/** Path fragment identifying artifacts derived from the probe agent. Emitted
 *  artifacts are named after the source agent on every runtime that emits them
 *  (`.md`, Codex's `.toml`, Kimi's `subagents/<name>.{yaml,md}`), so this is the
 *  precise derived-artifact filter.
 *
 *  Scoping matters: several SHIPPED library files under `gsd-core/bin/lib/`
 *  (workflow-fragments.cjs, section-manifest.cjs, install-profiles.cjs,
 *  runtime-artifact-layout.cjs) legitimately contain the literal token in their
 *  own source — they implement the grammar. An unscoped tree sweep flags those
 *  and can never pass. */
const PROBE_STEM = 'gsd-codebase-mapper';

/** Real file + one `when="always"` section wrapping an injected sentinel.
 *  `always` is deliberate: it is the one atom whose predicate is
 *  unconditionally true, so a dropped body is unambiguously a defect rather
 *  than correct gating. */
function markedProbeAgent() {
  const original = fs.readFileSync(path.join(REPO_ROOT, PROBE_AGENT_REL), 'utf8');
  return original + [
    '',
    '<!-- gsd:section id="gsd2995-emission-probe" when="always" -->',
    '',
    BODY_SENTINEL,
    '',
    '<!-- /gsd:section -->',
    '',
  ].join('\n');
}

/** Scopes worth installing for one runtime: always `global` (the inline
 *  agent loop is not descriptor-declared), plus every scope whose descriptor
 *  declares an agent-bearing kind. Derived at run time from the registry —
 *  `claude` declares its raw `agents` kind ONLY at local scope, so a
 *  global-only sweep would miss the primary runtime's raw path. */
function scopesForRuntime(registry, runtime) {
  const scopes = new Set(['global']);
  const layout = registry?.runtimes?.[runtime]?.runtime?.artifactLayout;
  if (layout) {
    for (const scope of ['global', 'local']) {
      for (const entry of layout[scope] || []) {
        if (entry.kind === 'agents' || entry.kind === 'kimi-agents') scopes.add(scope);
      }
    }
  }
  return [...scopes];
}

/** Spawn a real install of one runtime at one scope against `repoRoot`. */
function spawnInstall(repoRoot, runtime, scope) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-2995-${runtime}-${scope}-`));
  const args = [
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    path.join(repoRoot, 'bin', 'install.js'),
    `--${runtime}`,
  ];
  const cwd = root;
  if (scope === 'global') args.push('--global', '--config-dir', root);
  else args.push('--local');
  const seamResult = runNode(args, {
    cwd,
    env: installerEnv({ HOME: root, USERPROFILE: root }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  const result = { status: seamResult.exitCode, stdout: seamResult.stdout, stderr: seamResult.stderr };
  return { result, root };
}

/** Emitted files under `root` that are derived from the probe agent AND contain
 *  `token`. The `derivedOnly` filter is what keeps shipped library sources —
 *  which legitimately carry the marker grammar — out of the leak set. */
function filesContaining(root, token, derivedOnly = true) {
  if (!fs.existsSync(root)) return [];
  const hits = [];
  for (const abs of walk(root)) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (derivedOnly && !rel.includes(PROBE_STEM)) continue;
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue; // unreadable entry (socket, dangling link) is not a leak
    }
    if (buf.includes(token)) hits.push(rel);
  }
  return hits;
}

/** Run the whole matrix against one repo root. */
function collectLeaks(repoRoot, t) {
  const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
  const leaks = [];
  const retained = [];
  const failures = [];
  for (const runtime of Object.keys(RUNTIME_META)) {
    for (const scope of scopesForRuntime(registry, runtime)) {
      const { result, root } = spawnInstall(repoRoot, runtime, scope);
      t.after(() => cleanup(root));
      if (result.status !== 0) {
        failures.push(`${runtime}/${scope} exit ${result.status}: ${String(result.stderr || '').slice(-300)}`);
        continue;
      }
      const markerHits = filesContaining(root, MARKER_TOKEN);
      if (markerHits.length > 0) leaks.push(`${runtime}/${scope} -> ${markerHits.join(', ')}`);
      if (filesContaining(root, BODY_SENTINEL).length > 0) retained.push(`${runtime}/${scope}`);
    }
  }
  return { leaks, retained, failures };
}

// ─── Row 5: no runtime emits a surviving agent section marker ─────────────────

test('row 5 — no runtime emits an agent gsd:section marker at any agent-bearing scope', (t) => {
  const overlay = buildOverlayRepo({ [PROBE_AGENT_REL]: markedProbeAgent() });
  t.after(() => cleanup(overlay));

  const { leaks, retained, failures } = collectLeaks(overlay, t);

  assert.deepStrictEqual(
    failures,
    [],
    `every install in the sweep must succeed, else the sweep proves nothing:\n${failures.join('\n')}`,
  );
  assert.deepStrictEqual(
    leaks,
    [],
    `every emission path must strip agent section markers before writing:\n${leaks.join('\n')}`,
  );

  // Anti-vacuity: marker absence alone is satisfiable by dropping the section
  // entirely. A `when="always"` body must be KEPT, so at least one runtime must
  // show the sentinel.
  assert.ok(
    retained.length > 0,
    'no runtime retained the always-section body — marker absence is being satisfied by ' +
      'dropping content, not by stripping markers',
  );
});

// ─── Rows 21/22: the negative control — identity composer MUST leak ───────────

test('rows 21/22 — an identity composer makes agent markers leak', (t) => {
  const overlay = buildOverlayRepo({
    [PROBE_AGENT_REL]: markedProbeAgent(),
    'gsd-core/bin/lib/workflow-fragments.cjs': 'module.exports = { composeWorkflow: (c) => c };\n',
  });
  t.after(() => cleanup(overlay));

  const { leaks, failures } = collectLeaks(overlay, t);

  assert.deepStrictEqual(
    failures,
    [],
    `identity-stub installs must still succeed:\n${failures.join('\n')}`,
  );
  assert.ok(
    leaks.length > 0,
    'with composeWorkflow stubbed to identity, agent markers MUST reach disk. They did not, ' +
      'so row 5 proves nothing — it passes for some reason other than the composer working.',
  );
});
