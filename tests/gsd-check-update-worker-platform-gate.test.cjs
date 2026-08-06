/**
 * Tests for the Windows npm resolution platform gate.
 *
 * Background (issue #3103, PR #3102):
 *   On Windows, `npm` ships as `npm.cmd`. Node's spawn does not apply PATHEXT
 *   resolution and fails with ENOENT. The fix is to spawn through a shell on
 *   Windows (cmd.exe resolves npm.cmd via PATHEXT). On POSIX, `npm` resolves
 *   without a shell, so spawning `/bin/sh -c` is pure overhead and changes
 *   signal / exit-code semantics — undesirable.
 *
 * Relocation (#498): the SessionStart worker no longer spawns npm itself. It
 * delegates the latest-version lookup to check-latest-version's
 * `checkLatestVersion()`, which routes through `execNpm` in the shell-command
 * projection seam. The PR #3102 contract therefore now lives on `execNpm`.
 * This test locks it there, and additionally locks that the worker does NOT
 * re-introduce a direct npm spawn (which would re-open the gate question in a
 * second place).
 *
 * Source-grep policy: these structural assertions read source via readFileSync.
 * The behavior (Windows-only shell resolution) is platform-gated at runtime and
 * cannot be reached on POSIX CI without a Windows lane; a structural assertion
 * is the minimum-cost contract.
 */

// allow-test-rule: structural assertion on spawn-options shape; the behavior
// (Windows-only shell resolution) is platform-gated at runtime and cannot be
// reached on POSIX CI without a Windows lane.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update-worker.js');
const PROJECTION_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs',
);

function codeOnly(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
}

describe('execNpm: Windows npm spawn platform gate (PR #3102, relocated #498)', () => {
  test('projection seam exists', () => {
    assert.ok(fs.existsSync(PROJECTION_PATH), `not found at ${PROJECTION_PATH}`);
  });

  test('execNpm gates shell to process.platform === "win32"', () => {
    assert.match(
      codeOnly(PROJECTION_PATH),
      /shell:\s*process\.platform\s*===\s*['"]win32['"]/,
      [
        'execNpm must gate shell to `process.platform === "win32"`.',
        'A regression to `shell: true` would spawn /bin/sh -c on POSIX',
        '(adds shell overhead, changes signal/exit semantics). See PR #3102.',
      ].join(' '),
    );
  });

  test('no unconditional shell: true on the npm spawn', () => {
    assert.doesNotMatch(
      codeOnly(PROJECTION_PATH),
      /shell\s*:\s*true\s*[,\s}]/,
      'shell: true is forbidden — use the `process.platform === "win32"` gate.',
    );
  });
});

describe('worker delegates the npm spawn (does not re-open the gate, #498)', () => {
  test('worker does NOT spawn npm directly', () => {
    const code = codeOnly(WORKER_PATH);
    assert.doesNotMatch(
      code,
      /(execFileSync|spawnSync|execSync|exec)\s*\(\s*['"]npm['"]/,
      'Worker must delegate to checkLatestVersion(), not spawn npm itself.',
    );
  });

  test('worker requires check-latest-version for the lookup', () => {
    assert.match(codeOnly(WORKER_PATH), /check-latest-version/);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2992-check-latest-version.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2992-check-latest-version (consolidation epic #1969 B5 #1974)", () => {
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { checkLatestVersion, CHECK_REASON, PACKAGE_NAME } = require(
  path.join(ROOT, 'gsd-core', 'bin', 'check-latest-version.cjs'),
);

// checkLatestVersion is a pure-ish function: it spawns one fixed npm
// command, validates the output, and returns { ok, version | reason }.
// The package name is HARDCODED — not a free choice for the caller.
// Tests use a pluggable spawn so no real npm process is invoked.

describe('Bug #2992: deterministic latest-version check', () => {
  test('PACKAGE_NAME is the constant @opengsd/gsd-core (no callers can override)', () => {
    assert.equal(PACKAGE_NAME, '@opengsd/gsd-core');
  });

  test('CHECK_REASON enum exposes the documented codes', () => {
    assert.deepEqual(
      Object.keys(CHECK_REASON).sort(),
      ['FAIL_INVALID_OUTPUT', 'FAIL_NPM_FAILED', 'OK'].sort(),
    );
  });

  test('returns { ok: true, version } when npm prints a valid semver', () => {
    const fakeSpawn = () => ({ status: 0, stdout: '1.39.1\n', stderr: '' });
    const r = checkLatestVersion({ spawn: fakeSpawn });
    assert.deepEqual(r, { ok: true, version: '1.39.1', reason: CHECK_REASON.OK });
  });
});

describe('Bug #2992: error paths', () => {
  const { checkLatestVersion, CHECK_REASON } = require(require('node:path').join(__dirname, '..', 'gsd-core', 'bin', 'check-latest-version.cjs'));

  test('FAIL_NPM_FAILED when npm exits non-zero (e.g. offline, 404)', () => {
    const r = checkLatestVersion({
      spawn: () => ({ status: 1, stdout: '', stderr: 'npm ERR! 404\n' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, CHECK_REASON.FAIL_NPM_FAILED);
    assert.equal(r.detail, 'npm ERR! 404',
      'detail should be the trimmed stderr when npm reports a real error');
  });

  // #2993 CR: distinguish timeout from genuine npm failure in `detail`.
  // spawnSync sets status=null and signal='SIGTERM' on timeout; stderr is
  // typically empty. Without the signal-first branch, both shape as
  // 'npm exited non-zero' and the operator cannot tell timeout from failure.
  test('FAIL_NPM_FAILED detail names the signal when spawn times out', () => {
    const r = checkLatestVersion({
      spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, CHECK_REASON.FAIL_NPM_FAILED);
    assert.equal(r.detail, 'npm timed out (signal: SIGTERM)',
      'detail should explicitly name the signal when status is null and signal is set');
  });

  test('FAIL_NPM_FAILED detail falls back to generic when neither stderr nor signal is present', () => {
    const r = checkLatestVersion({
      spawn: () => ({ status: 1, stdout: '', stderr: '' }),
    });
    assert.equal(r.detail, 'npm exited non-zero');
  });

  test('FAIL_INVALID_OUTPUT when npm prints something that is not a semver', () => {
    // E.g. if a future npm version changes the output format, or if the
    // network returns an HTML error page captured as stdout.
    const r = checkLatestVersion({
      spawn: () => ({ status: 0, stdout: '<html>not a version</html>\n', stderr: '' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, CHECK_REASON.FAIL_INVALID_OUTPUT);
  });

  test('FAIL_INVALID_OUTPUT when stdout is empty', () => {
    const r = checkLatestVersion({
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, CHECK_REASON.FAIL_INVALID_OUTPUT);
  });

  test('accepts pre-release semver (e.g. 1.40.0-rc.1)', () => {
    const r = checkLatestVersion({
      spawn: () => ({ status: 0, stdout: '1.40.0-rc.1\n', stderr: '' }),
    });
    assert.deepEqual(r, { ok: true, version: '1.40.0-rc.1', reason: CHECK_REASON.OK });
  });
});

describe('Issue #815: --next dist-tag support', () => {
  const { buildViewArgs, resolveTag, ALLOWED_TAGS } = require(
    path.join(ROOT, 'gsd-core', 'bin', 'check-latest-version.cjs'),
  );

  test('ALLOWED_TAGS is the sanctioned channel allowlist (latest, next)', () => {
    assert.deepEqual([...ALLOWED_TAGS].sort(), ['latest', 'next']);
  });

  test('buildViewArgs() defaults to the bare latest spec (byte-for-byte unchanged)', () => {
    assert.deepEqual(buildViewArgs(), ['view', '@opengsd/gsd-core', 'version']);
    assert.deepEqual(buildViewArgs('latest'), ['view', '@opengsd/gsd-core', 'version']);
  });

  test('buildViewArgs("next") targets the @next dist-tag', () => {
    assert.deepEqual(buildViewArgs('next'), ['view', '@opengsd/gsd-core@next', 'version']);
  });

  test('resolveTag defaults to latest when no --tag flag', () => {
    assert.equal(resolveTag(['--json']), 'latest');
  });

  test('resolveTag reads --tag next', () => {
    assert.equal(resolveTag(['--json', '--tag', 'next']), 'next');
  });

  test('resolveTag rejects an unknown tag (typo guard)', () => {
    assert.throws(() => resolveTag(['--tag', 'nightly']), /invalid --tag 'nightly'/);
  });

  test('resolveTag rejects --tag with no value', () => {
    assert.throws(() => resolveTag(['--tag']), /invalid --tag ''/);
  });

  test('checkLatestVersion accepts an RC under the next tag', () => {
    const r = checkLatestVersion({ tag: 'next', spawn: () => ({ status: 0, stdout: '1.4.0-rc.1\n', stderr: '' }) });
    assert.deepEqual(r, { ok: true, version: '1.4.0-rc.1', reason: CHECK_REASON.OK });
  });

  test('buildViewArgs rejects a tag outside the allowlist (exported-API guard)', () => {
    assert.throws(() => buildViewArgs('nightly'), /invalid dist-tag 'nightly'/);
  });

  test('checkLatestVersion rejects an out-of-allowlist tag even with an injected spawn', () => {
    assert.throws(
      () => checkLatestVersion({ tag: 'nightly', spawn: () => ({ status: 0, stdout: '9.9.9\n', stderr: '' }) }),
      /invalid dist-tag 'nightly'/,
    );
  });

  test('resolveTag handles the --tag=next equals form', () => {
    assert.equal(resolveTag(['--json', '--tag=next']), 'next');
  });

  test('resolveTag rejects an unknown --tag=value equals form (no silent fallback)', () => {
    assert.throws(() => resolveTag(['--tag=nightly']), /invalid --tag 'nightly'/);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-378-update-check-scoped-name.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-378-update-check-scoped-name (consolidation epic #1969 B5 #1974)", () => {
/**
 * Regression test for #378 / #498: the SessionStart update worker must end up
 * querying the SCOPED package name (@opengsd/gsd-core) when it asks
 * npm for the latest version.
 *
 * Background (#378): the worker once hardcoded the unscoped 'gsd-core',
 * which 404s from the registry, leaving update_available permanently false.
 *
 * Original #378 fix derived the name from `require('../package.json').name`.
 * That is broken at runtime (#498): no package.json in the installed tree
 * carries a `.name`. It used to resolve to the synthetic `{"type":"commonjs"}`
 * marker GSD wrote at the config root, so post-install the worker queried
 * `npm view undefined version` → latest stayed null → update_available
 * permanently false; since #2544 GSD writes no marker there at all, so the
 * require would now fail to resolve outright. The old structural test passed
 * only because it grepped the DEV tree, where package.json still has a name.
 *
 * New contract (#498): the worker no longer resolves the package name itself.
 * It delegates the latest-version lookup to check-latest-version.cjs's
 * `checkLatestVersion()`, whose `PACKAGE_NAME` is sourced from the baked Package
 * Identity seam (`gsd-core/bin/lib/package-identity.cjs`). The seam's value
 * is a build-time constant, correct in every install layout, so the
 * undefined-at-runtime failure cannot recur. This test locks that contract:
 *
 *   1. Structural: worker must NOT contain the bare unscoped literal.
 *   2. Structural: worker must NOT use `require(...package.json...).name`
 *      (the runtime-broken path).
 *   3. Structural: worker delegates to check-latest-version's
 *      `checkLatestVersion` rather than calling `npm view` itself.
 *   4. Single-source: check-latest-version's PACKAGE_NAME === the seam's
 *      packageName === the scoped '@opengsd/gsd-core'.
 *
 * Source-grep policy: this test reads hook source via readFileSync. The repo's
 * lint-no-source-grep rule targets bin/lib/gsd-core — hooks/ is out of
 * scope. The behavior (correct name → no E404) only manifests at runtime
 * against the live registry; structural assertions are the minimum-cost
 * contract for the worker, the same rationale #378 carried.
 */

// allow-test-rule: structural assertion on hook delegation; the behavior being (see #378)
// tested (correct package name → no E404) only manifests at runtime against the
// live npm registry, which CI does not call.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update-worker.js');
const PKG_PATH = path.join(__dirname, '..', 'package.json');
const SEAM = require('../gsd-core/bin/lib/package-identity.cjs');
const { PACKAGE_NAME } = require('../gsd-core/bin/check-latest-version.cjs');

function workerCodeOnly() {
  const src = fs.readFileSync(WORKER_PATH, 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
}

describe('bug #378 / #498: update worker queries the scoped name via the seam', () => {
  test('worker file exists', () => {
    assert.ok(fs.existsSync(WORKER_PATH), `worker not found at ${WORKER_PATH}`);
  });

  test('package.json name is the scoped @opengsd/gsd-core', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    assert.equal(pkg.name, '@opengsd/gsd-core');
  });

  test('worker does NOT hardcode the unscoped gsd-core as a string literal', () => {
    assert.doesNotMatch(
      workerCodeOnly(),
      /['"]gsd-core['"]/,
      "Worker must not pass the unscoped 'gsd-core' to npm — it 404s.",
    );
  });

  test('worker does NOT resolve the name via require(package.json).name (broken at runtime)', () => {
    assert.doesNotMatch(
      workerCodeOnly(),
      /require\s*\(\s*['"][^'"]*package\.json['"]\s*\)\s*\.name/,
      [
        'require(package.json).name never yields a name in the installed tree —',
        'GSD stages only {"type":"commonjs"} markers, and since #2544 none at the',
        'config root. The worker must delegate to checkLatestVersion(), which',
        'sources the name from the baked seam.',
      ].join(' '),
    );
  });

  test('worker delegates the latest-version lookup to checkLatestVersion', () => {
    const code = workerCodeOnly();
    assert.match(
      code,
      /check-latest-version/,
      'Worker must require check-latest-version.cjs and call checkLatestVersion().',
    );
    assert.match(code, /checkLatestVersion\s*\(/);
  });

  test('check-latest-version PACKAGE_NAME is single-sourced from the seam', () => {
    assert.equal(PACKAGE_NAME, SEAM.packageName);
    assert.equal(SEAM.packageName, '@opengsd/gsd-core');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2784-update-cache-clear-path.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2784-update-cache-clear-path (consolidation epic #1969 B5 #1974)", () => {
// allow-test-rule: structural-regression-guard (see #2784)
// Reads hook .js or bin/install.js source to assert structural invariants
// (search array order, function wiring, path constants) that cannot be
// verified by observing runtime outputs alone. Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for bug #2784
 *
 * /gsd-update cache-clear step only cleared per-runtime cache paths
 * (e.g. ~/.claude/cache/gsd-update-check.json) but the SessionStart hook
 * (hooks/gsd-check-update.js) writes to the shared tool-agnostic path
 * ~/.cache/gsd/gsd-update-check.json. After a successful update, the statusline
 * kept showing the stale "⬆ /gsd-update" indicator because the actual cache
 * file was never deleted.
 *
 * Fix: add `rm -f "$HOME/.cache/gsd/gsd-update-check.json"` to the
 * run_update step's cache-clear block in gsd-core/workflows/update.md.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const UPDATE_WORKFLOW = path.join(
  REPO_ROOT,
  'gsd-core',
  'workflows',
  'update.md'
);
const CHECK_UPDATE_HOOK = path.join(REPO_ROOT, 'hooks', 'gsd-check-update.js');

describe('bug-2784: update.md cache-clear covers shared cache path', () => {
  test('gsd-check-update.js hook constructs cache dir from .cache and gsd path segments', () => {
    const hookContent = fs.readFileSync(CHECK_UPDATE_HOOK, 'utf-8');
    // Parse the path.join() call structurally rather than text-grepping.
    const m = hookContent.match(/const cacheDir\s*=\s*path\.join\(([^)]+)\)/);
    assert.ok(
      m !== null,
      'hook must assign cacheDir via path.join() with explicit path segments'
    );
    const segments = m[1].split(',').map((a) => a.trim().replace(/^['"]|['"]$/g, ''));
    assert.ok(
      segments.includes('.cache'),
      `hook cacheDir path.join() must include '.cache' segment; got: ${JSON.stringify(segments)}`
    );
    assert.ok(
      segments.includes('gsd'),
      `hook cacheDir path.join() must include 'gsd' segment; got: ${JSON.stringify(segments)}`
    );
  });

  test('update.md run_update bash commands include rm for shared gsd cache file', () => {
    const workflowContent = fs.readFileSync(UPDATE_WORKFLOW, 'utf-8');
    // Parse the step block structurally, then extract only bash fenced code lines.
    const stepMatch = workflowContent.match(/<step name="run_update">[\s\S]*?<\/step>/);
    assert.ok(stepMatch, 'update.md must have a <step name="run_update"> block');
    const stepContent = stepMatch[0];

    const bashLines = [];
    const fenceRe = /```(?:bash|sh)\r?\n([\s\S]*?)```/g;
    let m;
    while ((m = fenceRe.exec(stepContent)) !== null) {
      for (const line of m[1].split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) bashLines.push(trimmed);
      }
    }

    const sharedCacheClearCmds = bashLines.filter(
      (line) => /^rm\b/.test(line) && line.includes('.cache/gsd/gsd-update-check') && line.includes('*.json')
    );
    assert.ok(
      sharedCacheClearCmds.length > 0,
      [
        'run_update step bash blocks must include an `rm` command targeting .cache/gsd/gsd-update-check*.json (glob form clearing legacy + per-package variants).',
        `Bash lines found: ${JSON.stringify(bashLines)}`,
      ].join('\n')
    );
    const hasHomeExpansion = sharedCacheClearCmds.some(
      (line) => line.includes('$HOME') || line.includes('~/')
    );
    assert.ok(
      hasHomeExpansion,
      `shared cache rm command must use $HOME or ~/ expansion; found: ${JSON.stringify(sharedCacheClearCmds)}`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-2795-update-banner.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-2795-update-banner (consolidation epic #1969 B5 #1974)", () => {
/**
 * Tests for gsd-update-banner.js (#2795).
 *
 * The banner hook is an opt-in SessionStart consumer of the update cache that
 * gsd-check-update-worker.js writes. When a user declines GSD's statusline,
 * install.js may register this hook so update availability still surfaces in
 * runtimes that use a non-GSD statusline.
 *
 * Tests follow the typed-IR convention (CONTRIBUTING.md "Prohibited: Raw Text
 * Matching on Test Outputs"): assert on parsed JSON envelopes, not on raw
 * stdout substrings.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHook: seamRunHook } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-update-banner.js');
const {
  buildBannerOutput,
  shouldSuppressFailureWarning,
  RATE_LIMIT_SECONDS,
} = require('../hooks/gsd-update-banner.js');
const { updateCacheFileName } = require('../gsd-core/bin/lib/package-identity.cjs');

// ─── Pure function: buildBannerOutput ───────────────────────────────────────

describe('buildBannerOutput', () => {
  test('returns null when cache is missing', () => {
    const out = buildBannerOutput({
      cache: null,
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.equal(out, null);
  });

  test('returns null when update_available is false', () => {
    const out = buildBannerOutput({
      cache: { update_available: false, installed: '1.40.0', latest: '1.40.0' },
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.equal(out, null);
  });

  test('returns banner envelope when update_available is true', () => {
    const out = buildBannerOutput({
      cache: { update_available: true, installed: '1.39.0', latest: '1.40.0', package_name: '@opengsd/gsd-core' },
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.ok(out, 'expected banner envelope');
    assert.equal(typeof out.systemMessage, 'string');
    assert.ok(
      out.systemMessage.includes('1.39.0'),
      'banner should name installed version'
    );
    assert.ok(
      out.systemMessage.includes('1.40.0'),
      'banner should name latest version'
    );
    assert.ok(
      out.systemMessage.includes('/gsd:update'),
      'banner should reference /gsd:update command'
    );
  });

  test('returns failure diagnostic on parseError when not suppressed', () => {
    const out = buildBannerOutput({
      cache: null,
      parseError: true,
      suppressFailureWarning: false,
    });
    assert.ok(out, 'expected diagnostic envelope');
    assert.equal(typeof out.systemMessage, 'string');
    assert.ok(
      /check failed/i.test(out.systemMessage),
      'diagnostic should describe a failed check'
    );
  });

  test('returns null on parseError when suppressed by rate limit', () => {
    const out = buildBannerOutput({
      cache: null,
      parseError: true,
      suppressFailureWarning: true,
    });
    assert.equal(out, null);
  });

  test('falls back to "unknown" when installed/latest missing', () => {
    const out = buildBannerOutput({
      cache: { update_available: true, package_name: '@opengsd/gsd-core' },
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.ok(out);
    assert.ok(
      out.systemMessage.includes('unknown'),
      'banner should degrade gracefully when versions are absent'
    );
  });
});

// ─── Pure function: shouldSuppressFailureWarning ────────────────────────────

describe('shouldSuppressFailureWarning', () => {
  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-banner-supp-'));
  }

  test('returns false when sentinel file is missing', () => {
    const dir = tmpDir();
    try {
      const result = shouldSuppressFailureWarning(
        path.join(dir, 'no-such-file'),
        100
      );
      assert.equal(result, false);
    } finally {
      cleanup(dir);
    }
  });

  test('returns true within rate-limit window', () => {
    const dir = tmpDir();
    try {
      const f = path.join(dir, 'sentinel');
      fs.writeFileSync(f, '1000');
      const result = shouldSuppressFailureWarning(f, 1000 + RATE_LIMIT_SECONDS - 1);
      assert.equal(result, true);
    } finally {
      cleanup(dir);
    }
  });

  test('returns false outside rate-limit window', () => {
    const dir = tmpDir();
    try {
      const f = path.join(dir, 'sentinel');
      fs.writeFileSync(f, '1000');
      const result = shouldSuppressFailureWarning(f, 1000 + RATE_LIMIT_SECONDS + 1);
      assert.equal(result, false);
    } finally {
      cleanup(dir);
    }
  });

  test('returns false when sentinel content is non-numeric', () => {
    const dir = tmpDir();
    try {
      const f = path.join(dir, 'sentinel');
      fs.writeFileSync(f, 'garbage-not-a-number');
      const result = shouldSuppressFailureWarning(f, 100);
      assert.equal(result, false);
    } finally {
      cleanup(dir);
    }
  });
});

// ─── End-to-end: spawn the hook against fixture cache states ────────────────

describe('gsd-update-banner.js end-to-end', () => {
  function setupHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-banner-home-'));
    fs.mkdirSync(path.join(home, '.cache', 'gsd'), { recursive: true });
    return home;
  }

  function runHook(home) {
    // 10000ms: previously UNBOUNDED (no `timeout` option passed to
    // spawnSync). gsd-update-banner.js only reads a small cache file from
    // disk and prints JSON — no subprocess/network work — so 10s is
    // generous headroom over its sub-second worst case even on a
    // contended CI runner.
    const r = seamRunHook(HOOK_PATH, [], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeoutMs: 10_000,
    });
    return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }

  function writeCache(home, contents) {
    fs.writeFileSync(
      path.join(home, '.cache', 'gsd', updateCacheFileName),
      typeof contents === 'string' ? contents : JSON.stringify(contents)
    );
  }

  test('exits 0 with empty stdout when cache file missing', () => {
    const home = setupHome();
    try {
      const r = runHook(home);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status} stderr=${r.stderr}`);
      assert.equal(r.stdout.trim(), '');
    } finally {
      cleanup(home);
    }
  });

  test('emits valid SessionStart JSON when update_available=true', () => {
    const home = setupHome();
    try {
      writeCache(home, {
        update_available: true,
        installed: '1.39.0',
        latest: '1.40.0',
        package_name: '@opengsd/gsd-core',
      });
      const r = runHook(home);
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(typeof parsed.systemMessage, 'string');
      assert.ok(parsed.systemMessage.includes('1.40.0'));
      assert.ok(parsed.systemMessage.includes('/gsd:update'));
    } finally {
      cleanup(home);
    }
  });

  test('exits silent when update_available=false', () => {
    const home = setupHome();
    try {
      writeCache(home, {
        update_available: false,
        installed: '1.40.0',
        latest: '1.40.0',
      });
      const r = runHook(home);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '');
    } finally {
      cleanup(home);
    }
  });

  test('emits failure diagnostic when cache JSON is malformed', () => {
    const home = setupHome();
    try {
      writeCache(home, 'not json {{{{');
      const r = runHook(home);
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(typeof parsed.systemMessage, 'string');
      assert.ok(/check failed/i.test(parsed.systemMessage));
    } finally {
      cleanup(home);
    }
  });

  test('suppresses repeat failure diagnostic within 24h via sentinel', () => {
    const home = setupHome();
    try {
      writeCache(home, 'not json');
      const r1 = runHook(home);
      assert.equal(
        r1.status,
        0,
        `expected exit 0, got ${r1.status} stderr=${r1.stderr}`
      );
      const parsed1 = JSON.parse(r1.stdout);
      assert.ok(/check failed/i.test(parsed1.systemMessage));

      // Sentinel should now exist so the next run is silent
      const sentinel = path.join(home, '.cache', 'gsd', 'banner-failure-warned-at');
      assert.ok(fs.existsSync(sentinel), 'first run must record the warning sentinel');

      const r2 = runHook(home);
      assert.equal(r2.status, 0);
      assert.equal(
        r2.stdout.trim(),
        '',
        'subsequent run within rate-limit window must stay silent'
      );
    } finally {
      cleanup(home);
    }
  });

  test('handles cache present but update_available field absent (older cache schema)', () => {
    const home = setupHome();
    try {
      writeCache(home, { installed: '1.40.0', latest: '1.40.0' });
      const r = runHook(home);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '');
    } finally {
      cleanup(home);
    }
  });
});

// ─── Install.js wiring: prompt + SessionStart entry registration ────────────
//
// These tests load bin/install.js as a module via GSD_TEST_MODE and assert on
// pure exported helpers. The shape mirrors how runtime-prompt-builder /
// statusline tests interact with install.js.

describe('install.js update-banner wiring', () => {
  process.env.GSD_TEST_MODE = '1';
  // Re-require fresh so test-mode exports are populated.
  const installPath = path.join(__dirname, '..', 'bin', 'install.js');
  delete require.cache[installPath];
  const installExports = require(installPath);

  test('exports buildUpdateBannerPromptText for structural prompt assertions', () => {
    assert.equal(
      typeof installExports.buildUpdateBannerPromptText,
      'function',
      'install.js must export buildUpdateBannerPromptText so tests can assert without grepping source'
    );
    const text = installExports.buildUpdateBannerPromptText();
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0);
    // Strip ANSI color escapes before structural assertions — the choice
    // digits are wrapped in color codes so word-boundary regex against the
    // raw text would miss them.
    // eslint-disable-next-line no-control-regex -- \x1b (ESC) is the required leading byte of ANSI SGR color sequences; matching it is the purpose of stripping ANSI codes from captured CLI/console output
    const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
    // Prompt must offer at least two choices (default + opt-in).
    assert.match(stripped, /\b1\b/);
    assert.match(stripped, /\b2\b/);
  });

  test('parseUpdateBannerInput defaults to false on empty / "1"', () => {
    assert.equal(typeof installExports.parseUpdateBannerInput, 'function');
    assert.equal(installExports.parseUpdateBannerInput(''), false);
    assert.equal(installExports.parseUpdateBannerInput('  '), false);
    assert.equal(installExports.parseUpdateBannerInput('1'), false);
  });

  test('parseUpdateBannerInput returns true on "2"', () => {
    assert.equal(installExports.parseUpdateBannerInput('2'), true);
    assert.equal(installExports.parseUpdateBannerInput('2 '), true);
  });

  test('parseUpdateBannerInput accepts "y" / "yes" affirmative shortcuts', () => {
    assert.equal(installExports.parseUpdateBannerInput('y'), true);
    assert.equal(installExports.parseUpdateBannerInput('Y'), true);
    assert.equal(installExports.parseUpdateBannerInput('yes'), true);
    assert.equal(installExports.parseUpdateBannerInput('YES'), true);
  });

  test('buildUpdateBannerHookEntry produces a SessionStart hook entry', () => {
    assert.equal(typeof installExports.buildUpdateBannerHookEntry, 'function');
    const entry = installExports.buildUpdateBannerHookEntry(
      '"/usr/local/bin/node" "/home/u/.claude/hooks/gsd-update-banner.js"'
    );
    assert.ok(entry, 'expected hook entry object');
    assert.ok(Array.isArray(entry.hooks), 'entry.hooks must be an array');
    assert.equal(entry.hooks.length, 1);
    assert.equal(entry.hooks[0].type, 'command');
    assert.ok(
      entry.hooks[0].command.includes('gsd-update-banner.js'),
      'command must reference the banner hook'
    );
  });

  test('buildUpdateBannerHookEntry returns null on null command', () => {
    assert.equal(installExports.buildUpdateBannerHookEntry(null), null);
    assert.equal(installExports.buildUpdateBannerHookEntry(''), null);
  });
});
  });
}
