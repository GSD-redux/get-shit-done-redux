const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  withIsolatedProcessState,
  TEST_ENV_BASE,
  CONFIG_LOCATION_ENV_KEYS,
  scrubConfigLocationEnv,
} = require('./helpers.cjs');

describe('#2665: the built-lib require is deferred', () => {
  // The scrub set derives from gsd-core/bin/lib, which is BUILT. Requiring it at
  // module scope made an unbuilt tree throw inside `require('./helpers.cjs')` —
  // before any test() registered — so one missing `npm run build:lib` became a
  // whole-suite crash in the file ~370 test files import. A cold child is the only
  // honest probe: this process has already loaded everything.
  const probe = (touch) => {
    const src = [
      "const path = require('node:path');",
      `require(${JSON.stringify(path.join(__dirname, 'helpers.cjs'))});`,
      touch,
      "const needle = path.join('gsd-core', 'bin', 'lib', 'capability-registry.cjs');",
      'process.stdout.write(String(Object.keys(require.cache).some((m) => m.endsWith(needle))));',
    ].join('\n');
    // Bounded per local/no-unbounded-spawn (#3143): a cold require is sub-second,
    // so 30s is ~30x headroom and still fails loudly instead of hanging a lane.
    const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 30_000 });
    assert.strictEqual(r.status, 0, `probe failed: ${r.stderr}`);
    return r.stdout === 'true';
  };

  test('requiring helpers.cjs alone does NOT load the built runtime lib', () => {
    assert.strictEqual(probe(''), false, 'the built lib was loaded at import time');
  });

  test('reading TEST_ENV_BASE is what loads it', () => {
    const touch = `require(${JSON.stringify(path.join(__dirname, 'helpers.cjs'))}).TEST_ENV_BASE;`;
    assert.strictEqual(probe(touch), true, 'reading the scrub set must resolve the built lib');
  });
});

describe('withIsolatedProcessState', () => {
  test('restores env, cwd, and exitCode after callback', () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalMarker = process.env.GSD_TEST_ISOLATION_MARKER;

    const tempCwd = path.dirname(originalCwd);

    withIsolatedProcessState(() => {
      process.env.GSD_TEST_ISOLATION_MARKER = 'changed';
      process.exitCode = 73;
      process.chdir(tempCwd);
    });

    assert.strictEqual(process.cwd(), originalCwd);
    assert.strictEqual(process.exitCode, originalExitCode);
    assert.strictEqual(process.env.GSD_TEST_ISOLATION_MARKER, originalMarker);
  });

  test('restores state even when callback throws', () => {
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;

    assert.throws(() => {
      withIsolatedProcessState(() => {
        process.env.PATH = '';
        process.chdir(path.dirname(originalCwd));
        throw new Error('boom');
      });
    }, /boom/);

    assert.strictEqual(process.cwd(), originalCwd);
    assert.strictEqual(process.env.PATH, originalPath);
  });
});

// ─── #2665: the config-location scrub is DERIVED, and stays that way ──────────
//
// The recurrence guard. #2665 documents two prior authors independently
// diagnosing this class and each fixing only the instance in front of them;
// this is the third pass. A hand-maintained scrub list cannot be defended by
// review alone, so the invariant is asserted instead of trusted.
//
// SCOPE BOUNDARY — read this before trusting a green run here.
//
// Every test below asserts that TEST_ENV_BASE covers some ENUMERATION (the
// capability registry, the non-registry descriptor set, GSD's own location
// keys). Each therefore proves only that the scrub set is not narrower than the
// enumeration it derives from. NONE of them can prove the enumeration is itself
// complete: a config-location var that no enumeration carries is invisible to
// all of them, and they stay green.
//
// That is not hypothetical — it is how round 2 found GSD_HOME and
// KIMI_SHARE_DIR while this block was fully green. GSD_HOME belonged to no
// enumeration at all (it is GSD's own store root, not a runtime configHome);
// KIMI_SHARE_DIR sat inside a function body where nothing could enumerate it.
// Round 3's fix was to make both enumerable rather than to add two assertions,
// precisely because an assertion added per reviewer-named var is the
// hand-maintained list wearing a test's clothes.
//
// The completeness question — "is every env-first first-party location var in
// SOME enumeration?" — is answered by a source census re-derived each round
// (see the PR discussion), and by scripts/live-config-guard.cjs at runtime,
// which observes actual writes rather than reasoning about names. Neither lives
// here, and this block should not be read as standing in for them.
describe('#2665: TEST_ENV_BASE config-location coverage', () => {
  test('every runtime configHome env var in the registry is scrubbed', () => {
    const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');

    const declared = [
      ...new Set(
        Object.values(runtimes).flatMap((r) => r?.runtime?.configHome?.env ?? []),
      ),
    ].sort();

    // Guards the guard: an empty/renamed registry shape would make the
    // assertion below vacuously true and silently retire this test.
    assert.ok(
      declared.length >= 15,
      `expected the registry to declare many configHome env vars, got ${declared.length} — ` +
        'if the registry shape changed, this derivation needs updating, not deleting',
    );

    const missing = declared.filter((k) => !(k in TEST_ENV_BASE));
    assert.deepStrictEqual(
      missing,
      [],
      `config-location env vars reachable by the resolver but not scrubbed: ${missing.join(', ')}. ` +
        'TEST_ENV_BASE derives this set from the capability registry — a gap here means the ' +
        'derivation broke, not that the list needs a manual entry.',
    );
  });

  test('every scrubbed config-location var is blanked, not merely present', () => {
    for (const key of CONFIG_LOCATION_ENV_KEYS) {
      assert.strictEqual(
        TEST_ENV_BASE[key],
        '',
        `${key} must be blanked ('') so the child sees a falsy value on the env-first branch`,
      );
    }
  });

  test('the non-registry config-location vars are covered too', () => {
    // These have no capability descriptor, so the registry derivation alone
    // cannot reach them: GROK_AGENTS_HOME is a hardcoded branch of
    // getGlobalConfigDir, GSD_RUNTIME selects which runtime home resolves, and
    // GSD_PROJECT / GSD_WORKSTREAM move a child's .planning root
    // (src/planning-workspace.cts). Named explicitly so deleting one from the
    // helper is a test failure rather than a silent narrowing.
    for (const key of ['GROK_AGENTS_HOME', 'GSD_RUNTIME', 'GSD_PROJECT', 'GSD_WORKSTREAM']) {
      assert.strictEqual(TEST_ENV_BASE[key], '', `${key} must be scrubbed`);
    }
  });

  test('descriptor-shaped config homes OUTSIDE the registry are derived, not listed', () => {
    const {
      NON_REGISTRY_CONFIG_HOME_DESCRIPTORS,
    } = require('../gsd-core/bin/lib/runtime-homes.cjs');

    // Round 3. kimi owns TWO config homes: KIMI_CONFIG_DIR (registry-visible) and
    // KIMI_SHARE_DIR (a hardcoded descriptor inside resolveKimiHooksTomlDir, which
    // decides where its native config.toml — carrying GSD's [[hooks]] block — is
    // written). The registry-only derivation reached the first and not the second,
    // so it looked structurally complete while missing a live write surface.
    const declared = [
      ...new Set(NON_REGISTRY_CONFIG_HOME_DESCRIPTORS.flatMap((d) => d?.env ?? [])),
    ];
    assert.ok(
      declared.length >= 1,
      'expected at least one non-registry descriptor — an empty array makes this vacuous',
    );
    assert.ok(
      declared.includes('KIMI_SHARE_DIR'),
      `KIMI_SHARE_DIR must come from the descriptor set, got ${declared.join(', ')}`,
    );

    const missing = declared.filter((k) => !(k in TEST_ENV_BASE));
    assert.deepStrictEqual(
      missing,
      [],
      `descriptor-declared config-location vars not scrubbed: ${missing.join(', ')}`,
    );
  });

  test('skillsHome env vars are walked on BOTH descriptor rungs', () => {
    // Round 4. A configHome descriptor can nest a second, independently-resolved
    // descriptor (skillsHome → resolveSkillsBaseFromDescriptor), which carries
    // its own env array. Walking configHome.env alone is the identical
    // walk-one-field gap-shape rounds 2-3 closed for the registry and the
    // non-registry set. Inert today — only kilo declares skillsHome, with
    // env: [] — so this asserts the DERIVATION reaches the field, not that any
    // var currently flows from it: every skillsHome-declared var (registry and
    // non-registry alike) must land in TEST_ENV_BASE the moment one exists.
    const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');
    const {
      NON_REGISTRY_CONFIG_HOME_DESCRIPTORS,
    } = require('../gsd-core/bin/lib/runtime-homes.cjs');

    const declared = [
      ...new Set([
        ...Object.values(runtimes).flatMap(
          (r) => r?.runtime?.configHome?.skillsHome?.env ?? [],
        ),
        ...NON_REGISTRY_CONFIG_HOME_DESCRIPTORS.flatMap(
          (d) => d?.skillsHome?.env ?? [],
        ),
      ]),
    ];

    // Anti-vacuity: at least one runtime must actually DECLARE skillsHome, or a
    // registry reshape could rename the field and retire this test silently.
    const declaringRuntimes = Object.values(runtimes).filter(
      (r) => r?.runtime?.configHome?.skillsHome !== undefined,
    );
    assert.ok(
      declaringRuntimes.length >= 1,
      'expected at least one registry runtime to declare configHome.skillsHome — ' +
        'if the field moved, this derivation needs updating, not deleting',
    );

    const missing = declared.filter((k) => !(k in TEST_ENV_BASE));
    assert.deepStrictEqual(
      missing,
      [],
      `skillsHome-declared config-location vars not scrubbed: ${missing.join(', ')}`,
    );
  });

  test("GSD's OWN location vars are scrubbed (a second family, not a registry gap)", () => {
    const { GSD_LOCATION_ENV_KEYS } = require('../gsd-core/bin/lib/runtime-homes.cjs');

    // GSD_HOME decides where GSD keeps user-owned state ($GSD_HOME/.gsd/ —
    // consent.json, defaults.json, capability overlays) and is read env-FIRST,
    // ahead of os.homedir(), across capability-loader / capability-consent /
    // capability-state / capability-writer / config-loader / install-profiles /
    // bin/install.js. GSD_AGENTS_DIR is priority 1 in getAgentsDir. Neither is a
    // runtime configHome, so no amount of registry derivation reaches them.
    assert.ok(GSD_LOCATION_ENV_KEYS.includes('GSD_HOME'));
    for (const key of GSD_LOCATION_ENV_KEYS) {
      assert.strictEqual(TEST_ENV_BASE[key], '', `${key} must be scrubbed`);
    }
  });

  test('write-escape PERMISSIONS are scrubbed (a fifth family — not a location var)', () => {
    // #2665 round 5. GSD_ALLOW_SYMLINKED_DEST names no path, so every rung of the
    // derivation above is structurally incapable of reaching it — it is not a
    // registry configHome, not descriptor-shaped, not one of GSD's own location
    // vars. It is still a #2665 leak vector: install-engine.cts reads it env-first
    // and threads it into the symlink-escape guard that stops a write leaving the
    // install root, so an ambient `=1` disarms that guard for the whole suite.
    //
    // Named literally rather than derived from the family constant on purpose: a
    // test that reads WRITE_ESCAPE_PERMISSION_ENV_KEYS and asserts over it shrinks
    // its own expectation when the family is emptied — the enumeration-relative
    // failure this suite already documents, and the one that let the kimi-code
    // descriptor go unwatched. Naming it is what makes removal fail loudly.
    assert.strictEqual(
      TEST_ENV_BASE.GSD_ALLOW_SYMLINKED_DEST,
      '',
      'GSD_ALLOW_SYMLINKED_DEST must be blanked: ambient =1 disarms the symlink-escape guard',
    );
    // Blanking must be fail-SAFE — '' is neither '1' nor 'true', so the guard gets
    // stricter, never looser. This is what licenses scrubbing it wholesale.
    assert.ok(!['1', 'true'].includes(TEST_ENV_BASE.GSD_ALLOW_SYMLINKED_DEST));
  });

  test('scrubConfigLocationEnv clears and restores the parent process env', () => {
    // The in-process half of the fix (Blocker 1): TEST_ENV_BASE only reaches
    // children, so a test calling install() in-process needs the PARENT's env
    // cleared. Round-trip both states — set and unset — because restoring an
    // originally-unset var as '' rather than deleting it is itself a leak.
    withIsolatedProcessState(() => {
      process.env.CLAUDE_CONFIG_DIR = '/tmp/ambient-claude';
      delete process.env.CODEX_HOME;

      const restore = scrubConfigLocationEnv();
      assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, undefined,
        'a set config-location var must be deleted, not blanked, on the parent');
      assert.strictEqual(process.env.CODEX_HOME, undefined);

      restore();
      assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, '/tmp/ambient-claude',
        'restore must put back the original value');
      assert.ok(!('CODEX_HOME' in process.env),
        'restore must leave an originally-unset var unset, not set it to empty string');
    });
  });
});

describe('#2665 round 4: the skillsHome walk is reversion-sensitive', () => {
  // The coverage tests above are enumeration-relative, and skillsHome.env is
  // empty everywhere today — so reverting the skillsHome rungs from the
  // derivation leaves every one of them green (measured by this round's
  // pre-push adversarial review). This test closes that: it cold-requires
  // helpers.cjs in a child process after injecting sentinel skillsHome env
  // vars into BOTH enumerations (registry and non-registry), so the walk
  // itself is what is under test, not today's empty declarations.
  test('sentinel skillsHome vars flow into TEST_ENV_BASE on both rungs', () => {
    const { execFileSync } = require('node:child_process');
    const regPath = require.resolve('../gsd-core/bin/lib/capability-registry.cjs');
    const rhPath = require.resolve('../gsd-core/bin/lib/runtime-homes.cjs');
    const helpersPath = require.resolve('./helpers.cjs');

    const script = `
      'use strict';
      const reg = require(${JSON.stringify(regPath)});
      const rh = require(${JSON.stringify(rhPath)});
      // Rung 1 (registry): give one runtime a skillsHome env var. kilo already
      // declares skillsHome (env: []); push a sentinel into whichever runtime
      // declares it, or graft one onto the first runtime if none does.
      const declaring = Object.values(reg.runtimes).find(
        (r) => r?.runtime?.configHome?.skillsHome,
      ) ?? Object.values(reg.runtimes)[0];
      if (!declaring.runtime.configHome.skillsHome) {
        declaring.runtime.configHome.skillsHome = { kind: 'dot-home', name: '.x', env: [] };
      }
      declaring.runtime.configHome.skillsHome.env = ['GSD_TEST_SENTINEL_REGISTRY_SKILLS'];
      // Rung 2 (non-registry): graft a skillsHome onto the first descriptor.
      rh.NON_REGISTRY_CONFIG_HOME_DESCRIPTORS[0].skillsHome = {
        kind: 'dot-home', name: '.x', env: ['GSD_TEST_SENTINEL_NONREG_SKILLS'],
      };
      const { TEST_ENV_BASE } = require(${JSON.stringify(helpersPath)});
      const missing = [
        'GSD_TEST_SENTINEL_REGISTRY_SKILLS',
        'GSD_TEST_SENTINEL_NONREG_SKILLS',
      ].filter((k) => TEST_ENV_BASE[k] !== '');
      if (missing.length > 0) {
        console.error('skillsHome walk missed: ' + missing.join(', '));
        process.exit(1);
      }
      process.exit(0);
    `;

    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: __dirname,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    void out; // exit 0 is the assertion; execFileSync throws on nonzero
  });
});

describe('#3156: a raw installer spawn cannot write into the ambient HOME', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { installSpawnEnv, cleanup } = require('./helpers.cjs');
  const { installerEnv } = require('./helpers/install-shared.cjs');
  const INSTALL_PATH = path.join(__dirname, '..', 'bin', 'install.js');

  // Contract half — cheap, and it names the precedence the callers depend on.
  test('the sandbox HOME replaces the ambient one, but an explicit override still wins', () => {
    for (const build of [installSpawnEnv, installerEnv]) {
      const env = build();
      assert.notStrictEqual(env.HOME, process.env.HOME,
        'a raw installer spawn must not inherit the ambient HOME');
      assert.strictEqual(env.USERPROFILE, env.HOME,
        'USERPROFILE must track HOME — os.homedir() reads it on Windows');
      assert.strictEqual(build({ HOME: '/explicit', USERPROFILE: '/explicit' }).HOME, '/explicit',
        'an explicit HOME override must still win (overrides spread last)');
    }
  });

  // Behavioural half — the one that actually fails pre-fix.
  //
  // bin/install.js writeNonClaudeDefaults() (#2834) writes
  // <os.homedir()>/.gsd/defaults.json for every NON-Claude runtime, reading no
  // GSD variable at all. So this is deliberately driven through the real
  // installer against a real ambient HOME: no assertion about the scrub set can
  // stand in for it, because no scrub set can reach os.homedir().
  //
  // Negative control: revert installerEnv() to `{ ...process.env, ...overrides }`
  // and the canary gains .gsd/defaults.json.
  test('installing a non-Claude runtime leaves the ambient HOME untouched', () => {
    const canaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3156-canary-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3156-project-'));
    const realHome = process.env.HOME;
    const realUserProfile = process.env.USERPROFILE;
    try {
      // Make the AMBIENT home the canary — the vector is the parent process's
      // own HOME, exactly as on a developer machine or a CI runner.
      process.env.HOME = canaryHome;
      process.env.USERPROFILE = canaryHome;

      execFileSync(process.execPath, [INSTALL_PATH, '--cursor', '--local', '--no-sdk'], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: installerEnv(),
        timeout: 120_000,
      });

      assert.ok(!fs.existsSync(path.join(canaryHome, '.gsd')),
        `the installer wrote GSD's user store into the ambient HOME: ${
          fs.existsSync(path.join(canaryHome, '.gsd'))
            ? fs.readdirSync(path.join(canaryHome, '.gsd')).join(', ')
            : ''
        }`);
    } finally {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
      if (realUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = realUserProfile;
      cleanup(canaryHome);
      cleanup(projectDir);
    }
  });
});
