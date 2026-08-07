// allow-test-rule: structural-regression-guard — AC2 requires asserting no `runtime === 'antigravity'` string-equality branch (nor an `isAntigravity` helper, nor a `canonical === 'antigravity'` branch) remains in bin/install.js, src/runtime-artifact-conversion.cts, src/shell-command-projection.cts, and src/runtime-name-policy.cts — the descriptor-migration contract is a property of the source text, so a source-grep is the only faithful check (#2096)
'use strict';

/**
 * Declarative reference host — Antigravity (#1682 Slice 2 / ADR-1239 Phase D).
 *
 * Locks in Antigravity as the Declarative-CLI reference host driven through the
 * PUBLIC Host-Integration Interface (the declarative adapter), per #1682 AC:
 *   "invoke a gsd command in the Declarative-CLI reference host (Antigravity)
 *    driven by the embedded engine through the public interface, golden-parity
 *    vs Claude."
 *
 * Byte-identity of adapter output vs today's install is gated globally by
 * golden-install-parity (all 16 runtimes) + adapter-declarative-equivalence.
 * THIS test is the reference-host dogfood: it (1) classifies Antigravity's
 * profile via profileOf, (2) confirms the public adapter classifies it as
 * declarative, and (3) round-trips a real install proving a gsd command surface
 * is emitted through the same engine the adapter delegates to.
 *
 * #2096 (EoS/antigravity) additions: negotiation fails CLOSED on a corrupted
 * descriptor, the 4 still-`undocumented` dispatch sub-axes (namedDispatch/
 * nested/maxDepth/backgroundDispatch) degrade to the most-restrictive known
 * value (never their optimistic value), the validator accepts the negotiated
 * subagentToolkit:'full' + permissionWriter:'antigravity' upgrade, and the
 * hardcoded `runtime === 'antigravity'` / `isAntigravity` / `canonical ===
 * 'antigravity'` branches are retired from the folded modules (folded into
 * descriptor-driven `runtime.hostBehaviors` + `runtime.hostIntegration`).
 * UPGRADE 1 (permission-writer) + UPGRADE 2 (MCP companion) live-install
 * coverage is in tests/antigravity-upgrades.test.cjs — not duplicated here.
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
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');
const { validateCapability } = require('../gsd-core/bin/lib/capability-validator.cjs');
const { createDeclarativeAdapter } = require('../gsd-core/bin/lib/adapter-declarative.cjs');
const { cleanup } = require('./helpers.cjs');
const { walk, runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

const DESC = path.join(__dirname, '..', 'capabilities', 'antigravity', 'capability.json');
const ANTIGRAVITY_CAP = JSON.parse(fs.readFileSync(DESC, 'utf8'));
const ANTIGRAVITY_AXES = ANTIGRAVITY_CAP.runtime.hostIntegration;

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { BUILD_TIMEOUT_MS: BUILD_HOOKS_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// hooks/dist is gitignored and built (mirrors golden-install-parity harness).
before(() => {
  throwIfFailed(runNode([BUILD_SCRIPT], { timeoutMs: BUILD_HOOKS_TIMEOUT_MS }), `node ${BUILD_SCRIPT}`);
});

test('Antigravity classifies as the declarative-cli reference profile (profileOf)', () => {
  const desc = JSON.parse(fs.readFileSync(DESC, 'utf8'));
  const axes = desc.runtime.hostIntegration;
  assert.ok(axes && axes.embeddingMode, 'antigravity descriptor declares hostIntegration axes');
  assert.equal(profileOf(axes), 'declarative-cli',
    'Antigravity is the Declarative-CLI reference host');
});

test('the public declarative adapter classifies Antigravity as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'antigravity' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'antigravity');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('a real Antigravity install emits a gsd command/skill surface (invocable)', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'antigravity', scope: 'global' });
  try {
    const files = walk(configDir);
    assert.ok(files.length > 0, 'install must emit artifacts');
    // Antigravity uses the nested gsd-ns-* router skill layout as its command
    // surface (CONTEXT.md installer module). Assert a gsd skill/router is present.
    const gsdSurface = files.filter((f) => /gsd/i.test(path.relative(configDir, f)));
    assert.ok(gsdSurface.length > 0,
      'install must emit a gsd command/skill surface (declarative reference)');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// #2096 EoS/antigravity — AC3/AC5: fail-closed negotiation + validator
// acceptance + the folded descriptor (mirrors kimi/codex reference tests).
// ---------------------------------------------------------------------------

// -- AC5: negotiation fails CLOSED on a corrupted descriptor ------------------

test('negotiateHostCapabilities never throws for antigravity, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...ANTIGRAVITY_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...ANTIGRAVITY_AXES, embeddingMode: 'future-unknown' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...ANTIGRAVITY_AXES, dispatch: 'corrupted-not-an-object' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...ANTIGRAVITY_AXES, dispatch: { ...ANTIGRAVITY_AXES.dispatch, maxDepth: 'not-a-number' } }));
});

test('a partial/empty antigravity descriptor degrades to the safe floor, not the declarative-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative', 'omitted embeddingMode degrades closed');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['declarative-cli']);
  assert.ok(result.warnings.length > 0);
});

// AC-specific: the 4 still-undocumented dispatch sub-axes must degrade to the
// most-restrictive KNOWN value, not their optimistic value. Real values below
// were confirmed via:
//   node -e "const {negotiateHostCapabilities}=require('./gsd-core/bin/lib/host-integration.cjs');
//            const cap=require('./capabilities/antigravity/capability.json');
//            console.log(negotiateHostCapabilities(cap.runtime.hostIntegration).effective.dispatch)"
// -> { namedDispatch:false, nested:false, maxDepth:0, background:false, subagentToolkit:'full', backgroundDispatch:false }
test("antigravity's 4 still-undocumented dispatch sub-axes (namedDispatch/nested/maxDepth/backgroundDispatch) degrade to the most-restrictive known value, not their optimistic value", () => {
  // Sanity: the descriptor itself still declares these 4 as the undocumented
  // sentinel. subagentToolkit is the ONE dispatch axis Context7 confirmed as
  // 'full' (antigravity.google/docs/cli/features) — it is deliberately NOT
  // part of this still-undocumented set.
  assert.equal(ANTIGRAVITY_AXES.dispatch.namedDispatch, 'undocumented');
  assert.equal(ANTIGRAVITY_AXES.dispatch.nested, 'undocumented');
  assert.equal(ANTIGRAVITY_AXES.dispatch.maxDepth, 'undocumented');
  assert.equal(ANTIGRAVITY_AXES.dispatch.backgroundDispatch, 'undocumented');
  assert.equal(ANTIGRAVITY_AXES.dispatch.subagentToolkit, 'full', 'sanity: subagentToolkit is documented, not part of the undocumented set');

  const { effective, warnings } = negotiateHostCapabilities(ANTIGRAVITY_AXES);

  assert.equal(effective.dispatch.namedDispatch, false, 'undocumented namedDispatch must degrade to false, never true');
  assert.equal(effective.dispatch.nested, false, 'undocumented nested must degrade to false, never true');
  assert.equal(effective.dispatch.maxDepth, 0, 'undocumented maxDepth must degrade to 0, never -1/unbounded');
  assert.equal(effective.dispatch.backgroundDispatch, false, 'undocumented backgroundDispatch must degrade to false, never true');

  // subagentToolkit is documented 'full' (not undocumented) — it is trusted
  // and survives negotiation, in contrast to the 4 sub-axes above.
  assert.equal(effective.dispatch.subagentToolkit, 'full', "documented 'full' subagentToolkit is trusted, unlike the undocumented sub-axes");

  // background is declared `true` (documented, not undocumented) but the
  // struct-consistency cap in negotiateHostCapabilities still zeroes it
  // because its sibling namedDispatch degraded to false — a host-declared
  // `true` never overrides the fail-closed floor forced by a degraded axis.
  assert.equal(effective.dispatch.background, false, 'background is capped to false once namedDispatch degrades closed');

  for (const axis of ['namedDispatch', 'nested', 'backgroundDispatch']) {
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

// -- AC3: the validator accepts the negotiated/folded descriptor values ------

test('capabilities/antigravity/capability.json validates — subagentToolkit "full" + permissionWriter "antigravity" are accepted', () => {
  const errors = validateCapability(ANTIGRAVITY_CAP, 'antigravity');
  assert.deepEqual(errors, [], `validateCapability must return no errors, got: ${JSON.stringify(errors)}`);
  assert.equal(ANTIGRAVITY_AXES.dispatch.subagentToolkit, 'full');
  assert.equal(ANTIGRAVITY_CAP.runtime.permissionWriter, 'antigravity');
});

// -- AC2: the folded-in hostBehaviors + subagentToolkit upgrade --------------

test('antigravity descriptor declares runtime.hostBehaviors (the folded-in behaviors) + the subagentToolkit upgrade', () => {
  const hb = ANTIGRAVITY_CAP.runtime.hostBehaviors;
  assert.ok(hb && typeof hb === 'object');
  assert.equal(hb.reviewerCli, true);
  assert.equal(hb.projectInstructionFile, 'GEMINI.md');
  assert.equal(hb.noPathRewrite, true);
  assert.equal(hb.hookPathStyle, 'raw');
  assert.equal(ANTIGRAVITY_AXES.dispatch.subagentToolkit, 'full',
    'subagentToolkit flipped undocumented -> full (antigravity.google/docs/cli/features)');
});

// -- AC2: the hardcoded branches are retired across all folded modules -------

test('no `runtime === "antigravity"` string-equality branch (nor `isAntigravity` / `canonical === "antigravity"`) remains in the descriptor-migrated modules (AC2)', () => {
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/`[^`]*`/g, '');
  const repoRoot = path.join(__dirname, '..');
  const files = [
    path.join(repoRoot, 'bin', 'install.js'),
    path.join(repoRoot, 'src', 'runtime-artifact-conversion.cts'),
    path.join(repoRoot, 'src', 'shell-command-projection.cts'),
    path.join(repoRoot, 'src', 'runtime-name-policy.cts'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const stripped = strip(src);

    const eqOffenders = stripped.match(/runtime\s*[!=]==\s*'antigravity'/g) || [];
    assert.deepEqual(eqOffenders, [],
      `AC2: no hardcoded runtime==='antigravity' branch may remain in ${path.relative(repoRoot, file)}; found: ${eqOffenders.join(', ')}`);

    const isAntigravityHits = stripped.match(/\bisAntigravity\b/g) || [];
    assert.deepEqual(isAntigravityHits, [],
      `AC2: no isAntigravity helper may remain in ${path.relative(repoRoot, file)}; found ${isAntigravityHits.length} occurrence(s)`);

    const canonicalOffenders = stripped.match(/canonical\s*===\s*'antigravity'/g) || [];
    assert.deepEqual(canonicalOffenders, [],
      `AC2: no canonical==='antigravity' branch may remain in ${path.relative(repoRoot, file)}; found: ${canonicalOffenders.join(', ')}`);
  }
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3608-antigravity-update-runtime-classification.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3608-antigravity-update-runtime-classification (consolidation epic #1969 B3 #1972)", () => {
/**
 * Bug #3608: /gsd:update must model Antigravity as a first-class runtime.
 *
 * The installer (bin/install.js) and SDK already treat Antigravity as a distinct
 * runtime with its own config dirs, env var (ANTIGRAVITY_CONFIG_DIR), and CLI
 * flag (--antigravity). The update flow must agree.
 *
 * Relocation (#498): the update flow's runtime/scope detection moved out of
 * ~280 lines of inline bash in update.md into the tested projection
 * `gsd-core/bin/lib/update-context.cjs` (resolveUpdateContext). The
 * antigravity-first-class contract now lives there as data + behavior, so this
 * test asserts it on the projection. The only piece still authored in update.md
 * is the execution_context path classification (prose the agent applies).
 *
 * #1928: Gemini CLI was sunset by Google on 2026-06-18 and the `gemini` runtime
 * was removed from GSD entirely (Antigravity CLI is the successor). Antigravity
 * still resolves under the shared `.gemini/antigravity*` dirs (it runs on the
 * Gemini 3 backend), so those probe entries and the ANTIGRAVITY_CONFIG_DIR env
 * var remain — but there is no longer a competing bare-`gemini` runtime to
 * disambiguate against.
 */

'use strict';
process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  RUNTIME_DIRS,
  inferPreferredRuntime,
  envRuntimeDirs,
  resolveUpdateContext,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'update-context.cjs'));
const UPDATE_MD = path.join(ROOT, 'gsd-core', 'workflows', 'update.md');

function runtimeOrder() {
  return RUNTIME_DIRS.map(([rt]) => rt);
}
function firstIndex(arr, token) {
  return arr.indexOf(token);
}

describe('bug #3608 / #498: update-context models Antigravity as a first-class runtime', () => {
  test('RUNTIME_DIRS lists antigravity (no gemini runtime remains — #1928)', () => {
    const order = runtimeOrder();
    const antIdx = firstIndex(order, 'antigravity');
    assert.notStrictEqual(antIdx, -1, 'RUNTIME_DIRS missing antigravity');
    assert.strictEqual(firstIndex(order, 'gemini'), -1,
      'gemini runtime was removed (#1928) — RUNTIME_DIRS must not list it');
  });

  test('RUNTIME_DIRS includes antigravity 2.x (ide/cli) + legacy dirs', () => {
    const dirs = RUNTIME_DIRS.filter(([rt]) => rt === 'antigravity').map(([, d]) => d);
    assert.ok(dirs.includes('.gemini/antigravity-ide'), 'missing .gemini/antigravity-ide');
    assert.ok(dirs.includes('.gemini/antigravity-cli'), 'missing .gemini/antigravity-cli');
    assert.ok(dirs.includes('.gemini/antigravity'), 'missing legacy .gemini/antigravity fallback');
    // The bare .gemini probe (former gemini-runtime dir) no longer exists (#1928).
    const order = RUNTIME_DIRS.map(([, d]) => d);
    assert.strictEqual(order.indexOf('.gemini'), -1,
      'bare .gemini probe entry was removed with the gemini runtime (#1928)');
  });

  test('env inference recognizes ANTIGRAVITY_CONFIG_DIR', () => {
    const rt = inferPreferredRuntime({
      fs: { exists: () => false },
      env: { ANTIGRAVITY_CONFIG_DIR: '/x' },
      preferredConfigDir: '',
    });
    assert.equal(rt, 'antigravity');
  });

  test('envRuntimeDirs emits an antigravity entry when ANTIGRAVITY_CONFIG_DIR is set', () => {
    const entries = envRuntimeDirs({ env: { ANTIGRAVITY_CONFIG_DIR: '/x/ag' }, home: '/home/u' });
    const order = entries.map(([rt]) => rt);
    assert.ok(order.includes('antigravity'), 'expected an antigravity env candidate');
    assert.strictEqual(order.indexOf('gemini'), -1,
      'GEMINI_CONFIG_DIR is no longer recognized (#1928) — no gemini env candidate should ever appear');
  });

  test('behavioral: an Antigravity install resolves to runtime "antigravity", not "gemini"', () => {
    // Normalize paths so the fake fs matches the resolver's path.join/resolve
    // lookups on Windows (backslash + drive) as well as POSIX.
    const normKey = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    const HOME = '/home/u';
    const agDir = path.join(HOME, '.gemini', 'antigravity');
    const verFile = normKey(path.join(agDir, 'gsd-core', 'VERSION'));
    const markerFile = normKey(path.join(agDir, 'gsd-core', 'workflows', 'update.md'));
    const fakeFs = {
      exists: (p) => normKey(p) === verFile || normKey(p) === markerFile,
      readFile: (p) => (normKey(p) === verFile ? '1.40.0\n' : null),
    };
    const r = resolveUpdateContext({ home: HOME, cwd: path.resolve('/work'), env: {}, fs: fakeFs });
    assert.equal(r.runtime, 'antigravity');
    assert.equal(normKey(r.gsdDir), normKey(agDir));
  });

  test('update.md execution_context classification lists antigravity paths and no longer classifies bare /.gemini/ as gemini (#1928)', () => {
    const content = fs.readFileSync(UPDATE_MD, 'utf-8');
    const antIde = content.indexOf('/.gemini/antigravity-ide/');
    assert.notStrictEqual(antIde, -1, 'update.md must document the antigravity-ide execution_context path');
    assert.strictEqual(content.indexOf('`/.gemini/` -> `gemini`'), -1,
      'gemini runtime was removed (#1928) — update.md must not classify bare /.gemini/ as gemini');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-503-update-agent-antigravity-detection.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-503-update-agent-antigravity-detection (consolidation epic #1969 B3 #1972)", () => {
'use strict';
process.env.GSD_TEST_MODE = '1';

// allow-test-rule: source-text-is-the-product (see #503)
// update.md's embedded classifier + cache-clear loop are workflow text the
// runtime loads and executes, so asserting on that text tests deployed
// behavior. The runtime/scope detection cascade itself moved out of inline
// bash into the update-context projection (issue #498), so the core guarantee
// is exercised behaviorally against resolveUpdateContext rather than by
// matching a `RUNTIME_DIRS=(...)` literal that no longer lives in update.md.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #503: /gsd:update misclassifies local Antigravity (.agent) installs as claude
 *
 * The installer places a LOCAL Antigravity install in ./.agent/
 * (bin/install.js: getDirName('antigravity') === '.agent'). The /gsd:update
 * detection cascade must map .agent -> antigravity across three surfaces:
 *   1. the execution_context path classifier (update.md prose),
 *   2. the RUNTIME_DIRS candidate table (now in the update-context projection),
 *   3. the post-update cache-clear `for dir in` loop (update.md).
 *
 * Surface (2) is the original root cause and is now verified behaviorally: a
 * LOCAL .agent install must resolve to the antigravity runtime. Before the fix
 * (.agent absent from RUNTIME_DIRS) it fell through to UNKNOWN/claude.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UPDATE_MD = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'workflows', 'update.md'),
  'utf-8',
);
const { resolveUpdateContext } = require(
  path.join(ROOT, 'gsd-core', 'bin', 'lib', 'update-context.cjs'),
);

function normKey(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }
function fakeFs(files) {
  const set = new Map();
  for (const [k, v] of Object.entries(files)) set.set(normKey(k), v);
  return {
    exists: (p) => set.has(normKey(p)),
    readFile: (p) => { const k = normKey(p); return set.has(k) ? set.get(k) : null; },
  };
}

describe('/gsd:update detects local Antigravity (.agent / .agents) installs (#503 / #791)', () => {
  test('projection resolves a LOCAL ./.agents install to the antigravity runtime (#791 canonical)', () => {
    const HOME = '/home/u';
    const CWD = '/work/proj';
    const agentsDir = `${CWD}/.agents`;
    const ffs = fakeFs({
      [`${agentsDir}/gsd-core/VERSION`]: '1.50.0\n',
      [`${agentsDir}/gsd-core/workflows/update.md`]: 'x',
    });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: ffs });
    assert.equal(
      r.runtime,
      'antigravity',
      `a local .agents install must map to the antigravity runtime, got "${r.runtime}"`,
    );
    assert.equal(r.scope, 'LOCAL');
    assert.equal(r.installedVersion, '1.50.0');
  });

  test('projection resolves a LOCAL ./.agent install to the antigravity runtime (#503 backward-compat)', () => {
    const HOME = '/home/u';
    const CWD = '/work/proj';
    const agentDir = `${CWD}/.agent`;
    const ffs = fakeFs({
      [`${agentDir}/gsd-core/VERSION`]: '1.40.0\n',
      [`${agentDir}/gsd-core/workflows/update.md`]: 'x',
    });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: ffs });
    assert.equal(
      r.runtime,
      'antigravity',
      `a legacy .agent install must still map to the antigravity runtime, got "${r.runtime}"`,
    );
    assert.equal(r.scope, 'LOCAL');
    assert.equal(r.installedVersion, '1.40.0');
  });

  test('execution_context classifier maps /.agents/ and /.agent/ paths to antigravity (update.md)', () => {
    const hasAgentsClassifierRule =
      /\/\.agents\/[^\r\n]*->[^\r\n]*antigravity/.test(UPDATE_MD);
    assert.ok(
      hasAgentsClassifierRule,
      'update.md classifier must map a `/.agents/` path to the `antigravity` runtime',
    );
    const hasAgentClassifierRule =
      /\/\.agent\/[^\r\n]*->[^\r\n]*antigravity/.test(UPDATE_MD);
    assert.ok(
      hasAgentClassifierRule,
      'update.md classifier must still map a `/.agent/` path to the `antigravity` runtime (backward-compat)',
    );
  });

  test('every runtime-dir `for dir in` loop in update.md includes .agents and .agent', () => {
    // The LOCAL-scope discovery loop moved into the projection (#498); the
    // post-update cache-clear loop remains inline and still enumerates the
    // runtime config dirs as a literal `.claude ... .codex` list, so it must
    // include both .agents (canonical, #791) and .agent (legacy, #503) or
    // stale indicators could linger.
    const runtimeDirLoops = UPDATE_MD
      .split(/\r?\n/)
      .filter((l) => /for dir in .*\.claude.*\.codex/.test(l));
    assert.ok(
      runtimeDirLoops.length >= 1,
      `expected at least 1 runtime-dir loop in update.md, found ${runtimeDirLoops.length}`,
    );
    for (const loop of runtimeDirLoops) {
      assert.ok(
        /(^|\s)\.agents(\s|$)/.test(loop),
        `every runtime-dir loop must include .agents (canonical), got: ${loop.trim()}`,
      );
      assert.ok(
        /(^|\s)\.agent(\s|$)/.test(loop),
        `every runtime-dir loop must include .agent (legacy backward-compat), got: ${loop.trim()}`,
      );
    }
  });
});
  });
}
