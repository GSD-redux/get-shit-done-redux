'use strict';

/**
 * Tests for `gsd-tools migrate-config` subcommand (#3536).
 *
 * Covers the three acceptance-criteria cases:
 *   1. No-op when config is already canonical (migrated: false)
 *   2. Migrates when top-level branching_strategy is present (migrated: true)
 *   3. Idempotent: running twice produces no-op the second time
 *
 * Also covers the --raw human-readable output path.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, TOOLS_PATH, TEST_ENV_BASE } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

function runMigrateConfig(cwd, extraArgs = [], env = {}) {
  const result = runNode([TOOLS_PATH, 'migrate-config', ...extraArgs], {
    cwd,
    env: { ...process.env, ...TEST_ENV_BASE, ...env },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.exitCode,
  };
}

// ─── Test 1: No-op when config is already canonical ──────────────────────────

describe('migrate-config — no-op on already-canonical config', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  test('returns migrated: false when no legacy keys present', () => {
    tmpDir = createTempProject('gsd-migrate-noop-');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        git: { branching_strategy: 'phase', base_branch: 'main' },
        workflow: { research: true },
      }, null, 2),
      'utf-8'
    );

    const result = runMigrateConfig(tmpDir);

    assert.equal(
      result.status,
      0,
      `migrate-config must exit 0 on no-op — status ${result.status}, stderr: ${result.stderr}`
    );
    assert.equal(result.stderr.trim(), '', `No stderr expected — got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.migrated, false, 'migrated must be false for canonical config');
    assert.deepEqual(parsed.normalizations, [], 'normalizations must be empty for canonical config');
    assert.equal(parsed.wrote, null, 'wrote must be null for no-op');
  });
});

// ─── Test 2: Migrates when top-level branching_strategy is present ────────────

describe('migrate-config — migrates legacy branching_strategy', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  test('returns migrated: true and normalizations for top-level branching_strategy', () => {
    tmpDir = createTempProject('gsd-migrate-bs-');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        branching_strategy: 'milestone',
        git: { base_branch: 'main' },
      }, null, 2),
      'utf-8'
    );

    const result = runMigrateConfig(tmpDir);

    assert.equal(
      result.status,
      0,
      `migrate-config must exit 0 — status ${result.status}, stderr: ${result.stderr}`
    );
    assert.equal(result.stderr.trim(), '', `No stderr expected — got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.migrated, true, 'migrated must be true when legacy key present');
    assert.ok(
      parsed.normalizations.some(n => n.from === 'branching_strategy' && n.to === 'git.branching_strategy'),
      `normalizations must include branching_strategy→git.branching_strategy entry. Got: ${JSON.stringify(parsed.normalizations)}`
    );
    assert.ok(typeof parsed.wrote === 'string', 'wrote must be a file path string');

    // Verify on-disk result
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(
      onDisk.git?.branching_strategy,
      'milestone',
      'On-disk config must have git.branching_strategy = "milestone" after migration'
    );
    assert.equal(
      onDisk.branching_strategy,
      undefined,
      'On-disk config must not have top-level branching_strategy after migration'
    );
  });
});

// ─── Test 3: Idempotent ───────────────────────────────────────────────────────

describe('migrate-config — idempotent (running twice produces no-op)', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  test('second run is a no-op after first run migrated the config', () => {
    tmpDir = createTempProject('gsd-migrate-idem-');
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        branching_strategy: 'phase',
        git: { base_branch: 'main' },
      }, null, 2),
      'utf-8'
    );

    // First run — must migrate
    const first = runMigrateConfig(tmpDir);
    assert.equal(first.status, 0, `First run must exit 0 — status ${first.status}`);
    const firstParsed = JSON.parse(first.stdout);
    assert.equal(firstParsed.migrated, true, 'First run must migrate');

    // Second run — must be no-op
    const second = runMigrateConfig(tmpDir);
    assert.equal(second.status, 0, `Second run must exit 0 — status ${second.status}`);
    const secondParsed = JSON.parse(second.stdout);
    assert.equal(secondParsed.migrated, false, 'Second run must be a no-op (idempotent)');
    assert.deepEqual(secondParsed.normalizations, [], 'Second run normalizations must be empty');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-321-config-defaults-clone-strategy.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-321-config-defaults-clone-strategy (consolidation epic #1969 B3 #1972)", () => {
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const configuration = require('../gsd-core/bin/lib/configuration.cjs');

test('mergeDefaults clones defaults without JSON serialization fragility (#321)', () => {
  const sentinelKey = '__bug321_bigint_sentinel__';
  const sentinelValue = BigInt('9007199254740993001');

  configuration.CONFIG_DEFAULTS[sentinelKey] = sentinelValue;
  try {
    const merged = configuration.mergeDefaults({});
    assert.equal(
      merged[sentinelKey],
      sentinelValue,
      'mergeDefaults must preserve non-JSON scalar defaults when cloning'
    );
  }
  finally {
    delete configuration.CONFIG_DEFAULTS[sentinelKey];
  }
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Regressions — #3760: a non-object legacy-key SECTION must never be spread
// into character keys, never be silently dropped, and never be persisted.
//
// `normalizeLegacyKeys` hoisted a legacy top-level key into its canonical
// nested section by spreading whatever `result[section] ?? {}` produced. `??`
// guards only null/undefined, so a section holding a STRING was enumerated by
// index — `{...'main'}` is `{0:'m',1:'a',2:'i',3:'n'}` — and a number or
// boolean spread to `{}`, dropping the value outright. Because a fired block
// always pushes a Normalization, and every caller treats a non-empty
// `normalizations` array as "config is dirty", the mangled object was WRITTEN
// BACK to .planning/config.json and the original value became unrecoverable.
//
// The contract these cases lock (issue #3760, "Expected"): preserve the value,
// report it, never expand, never drop, never persist.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __d3760, test: __t3760, beforeEach: __be3760 } = require('node:test');
  const __assert3760 = require('node:assert/strict');
  const __fs3760 = require('node:fs');
  const __os3760 = require('node:os');
  const __path3760 = require('node:path');
  const __fc3760 = require('./helpers/fast-check-setup.cjs');
  const { cleanup: __cleanup3760 } = require('./helpers.cjs');
  const __configuration3760 = require('../gsd-core/bin/lib/configuration.cjs');
  const {
    UNUSABLE_REASON: __REASON3760,
    _resetUnusableInputWarningsForTests: __resetWarn3760,
    _unusableInputEmissionCountForTests: __emissions3760,
  } = require('../gsd-core/bin/lib/unusable-input.cjs');

  const { normalizeLegacyKeys: __normalize3760, migrateOnDisk: __migrate3760 } = __configuration3760;

  /**
   * Run `fn` with stderr swallowed and report how many NEW diagnostics it wrote.
   * The count comes from the typed seam, never from parsing stderr prose
   * (CONTRIBUTING.md — Prohibited: Raw Text Matching on Test Outputs). Restored
   * in a `finally` inside this standalone helper, which is the one place
   * CONTRIBUTING.md permits try/finally.
   */
  function __emissionsDuring3760(fn) {
    const before = __emissions3760();
    const original = process.stderr.write;
    process.stderr.write = () => true;
    try {
      fn();
    } finally {
      process.stderr.write = original;
    }
    return __emissions3760() - before;
  }

  /** A temp project carrying `.planning/config.json` with exactly `text`. */
  function __project3760(text) {
    const dir = __fs3760.mkdtempSync(__path3760.join(__os3760.tmpdir(), 'gsd-3760-'));
    __fs3760.mkdirSync(__path3760.join(dir, '.planning'), { recursive: true });
    __fs3760.writeFileSync(__path3760.join(dir, '.planning', 'config.json'), text, 'utf-8');
    return dir;
  }

  function __readConfig3760(dir) {
    return __fs3760.readFileSync(__path3760.join(dir, '.planning', 'config.json'), 'utf-8');
  }

  // ── normalizeLegacyKeys — the two blocks named in #3760 ──────────────────

  __d3760('regressions — #3760 normalizeLegacyKeys non-object section', () => {
    __t3760('block 1 — a string git section is preserved, never expanded into character keys', () => {
      const { parsed, normalizations, skipped } = __normalize3760({ git: 'main', branching_strategy: 'none' });

      __assert3760.strictEqual(
        parsed.git, 'main',
        'the string section must survive verbatim, not become {0:"m",1:"a",...}',
      );
      __assert3760.strictEqual(
        parsed.branching_strategy, 'none',
        'the legacy top-level key must be preserved, not deleted into a section that could not accept it',
      );
      __assert3760.deepStrictEqual(
        normalizations, [],
        'a block that could not run must not report a normalization — a reported normalization is what marks the config dirty and gets it written',
      );
      __assert3760.strictEqual(skipped.length, 1, 'the refusal must be reported, not silent');
      __assert3760.deepStrictEqual(skipped[0], {
        from: 'branching_strategy',
        to: 'git.branching_strategy',
        section: 'git',
        reason: 'non_object_section',
        value: 'none',
        sectionType: 'string',
      });
      // The offending section VALUE is deliberately absent from the report: it is
      // still in the file untouched, and this report is printed verbatim by
      // `migrate-config --json`.
      __assert3760.ok(
        !Object.prototype.hasOwnProperty.call(skipped[0], 'sectionValue'),
        'the report must name the section TYPE, never echo its value',
      );
    });

    __t3760('block 2 — a string planning section is preserved, never expanded into character keys', () => {
      const { parsed, normalizations, skipped } = __normalize3760({ planning: 'docs', sub_repos: ['a'] });

      __assert3760.strictEqual(parsed.planning, 'docs');
      __assert3760.deepStrictEqual(parsed.sub_repos, ['a']);
      __assert3760.deepStrictEqual(normalizations, []);
      __assert3760.strictEqual(skipped.length, 1);
      __assert3760.strictEqual(skipped[0].section, 'planning');
      __assert3760.strictEqual(skipped[0].to, 'planning.sub_repos');
    });

    __t3760('a number section is preserved, not silently dropped', () => {
      // `{...7}` is `{}` — the pre-fix code dropped the 7 without a trace, which
      // is the SAME data loss as the character-key expansion, only quieter.
      const { parsed, normalizations, skipped } = __normalize3760({ git: 7, branching_strategy: 'none' });
      __assert3760.strictEqual(parsed.git, 7);
      __assert3760.strictEqual(parsed.branching_strategy, 'none');
      __assert3760.deepStrictEqual(normalizations, []);
      __assert3760.strictEqual(skipped.length, 1);
    });

    __t3760('an array section is preserved verbatim', () => {
      // typeof [] === 'object', so a plain typeof guard would let an array
      // through and `{...['a','b']}` is `{0:'a',1:'b'}` — the same expansion.
      const { parsed, normalizations, skipped } = __normalize3760({ git: ['a', 'b'], branching_strategy: 'none' });
      __assert3760.deepStrictEqual(parsed.git, ['a', 'b']);
      __assert3760.strictEqual(parsed.branching_strategy, 'none');
      __assert3760.deepStrictEqual(normalizations, []);
      __assert3760.strictEqual(skipped.length, 1);
    });

    __t3760('a boolean section is preserved', () => {
      const { parsed, normalizations, skipped } = __normalize3760({ git: true, branching_strategy: 'none' });
      __assert3760.strictEqual(parsed.git, true);
      __assert3760.deepStrictEqual(normalizations, []);
      __assert3760.strictEqual(skipped.length, 1);
    });

    __t3760('an empty-string section is preserved (falsy but still a non-object)', () => {
      // Boundary: '' is falsy, so a truthiness-based guard would treat it as
      // absent and overwrite it. It is a value the user wrote; it survives.
      const { parsed, normalizations, skipped } = __normalize3760({ git: '', branching_strategy: 'none' });
      __assert3760.strictEqual(parsed.git, '');
      __assert3760.strictEqual(parsed.branching_strategy, 'none');
      __assert3760.deepStrictEqual(normalizations, []);
      __assert3760.strictEqual(skipped.length, 1);
    });

    // ── negative space: these must keep working exactly as before ──────────

    __t3760('an empty-object section still hoists (limit: {} IS a valid section)', () => {
      const { parsed, normalizations, skipped } = __normalize3760({ git: {}, branching_strategy: 'none' });
      __assert3760.deepStrictEqual(parsed.git, { branching_strategy: 'none' });
      __assert3760.strictEqual(parsed.branching_strategy, undefined);
      __assert3760.strictEqual(normalizations.length, 1);
      __assert3760.deepStrictEqual(skipped, []);
    });

    __t3760('a null section is treated as absent and still hoists (limit-1)', () => {
      const { parsed, normalizations, skipped } = __normalize3760({ git: null, branching_strategy: 'none' });
      __assert3760.deepStrictEqual(parsed.git, { branching_strategy: 'none' });
      __assert3760.strictEqual(normalizations.length, 1);
      __assert3760.deepStrictEqual(skipped, []);
    });

    __t3760('an absent section is created and the legacy key hoisted', () => {
      const { parsed, normalizations, skipped } = __normalize3760({ branching_strategy: 'none' });
      __assert3760.deepStrictEqual(parsed.git, { branching_strategy: 'none' });
      __assert3760.strictEqual(normalizations.length, 1);
      __assert3760.deepStrictEqual(skipped, []);
    });

    __t3760('a canonical nested value still wins over the stale top-level', () => {
      const { parsed, normalizations, skipped } = __normalize3760({
        git: { branching_strategy: 'x' },
        branching_strategy: 'y',
      });
      __assert3760.deepStrictEqual(parsed.git, { branching_strategy: 'x' });
      __assert3760.strictEqual(parsed.branching_strategy, undefined);
      __assert3760.strictEqual(normalizations.length, 1);
      __assert3760.deepStrictEqual(skipped, []);
    });
  });

  // ── property: no JSON value ever becomes character keys ──────────────────

  __d3760('regressions — #3760 properties', () => {
    __t3760('property — a section is never expanded into character keys, for any JSON value', () => {
      const sectionArb = __fc3760.oneof(
        __fc3760.string(),
        __fc3760.integer(),
        __fc3760.boolean(),
        __fc3760.constant(null),
        __fc3760.array(__fc3760.string()),
        __fc3760.dictionary(__fc3760.string(), __fc3760.string()),
      );
      __fc3760.assert(
        __fc3760.property(sectionArb, __fc3760.string(), (section, legacy) => {
          const { parsed } = __normalize3760({ git: section, branching_strategy: legacy });
          const out = parsed.git;
          if (section === null || (typeof section === 'object' && !Array.isArray(section))) {
            // Absent-or-object: the hoist is legitimate and must still happen.
            __assert3760.ok(out !== null && typeof out === 'object' && !Array.isArray(out));
            return true;
          }
          // Every non-object (string, number, boolean, array) survives verbatim.
          // For a string this is the exact defect: no index keys derived from
          // the string's characters may appear anywhere in the output.
          __assert3760.deepStrictEqual(out, section);
          return true;
        }),
        { numRuns: 200 },
      );
    });

    __t3760('property — normalization stays idempotent across the skip path', () => {
      // CONTEXT.md:104 states normalizeLegacyKeys is idempotent. The skip path
      // must not break that: re-running over its own output must be a no-op.
      const sectionArb = __fc3760.oneof(
        __fc3760.string(),
        __fc3760.integer(),
        __fc3760.constant(null),
        __fc3760.array(__fc3760.string()),
        __fc3760.dictionary(__fc3760.string(), __fc3760.string()),
      );
      __fc3760.assert(
        __fc3760.property(sectionArb, (section) => {
          const once = __normalize3760({ planning: section, sub_repos: ['a'] }).parsed;
          const twice = __normalize3760({ ...once }).parsed;
          __assert3760.deepStrictEqual(twice, once);
          return true;
        }),
        { numRuns: 200 },
      );
    });
  });

  // ── migrateOnDisk — the corruption must never reach the file ─────────────

  __d3760('regressions — #3760 migrateOnDisk never persists a corrupted section', () => {
    let dirs;
    __be3760(() => { dirs = []; __resetWarn3760(); });

    function track(dir) { dirs.push(dir); return dir; }

    __t3760('a non-object git section leaves the file byte-identical', () => {
      const text = JSON.stringify({ git: 'main', branching_strategy: 'none' }, null, 2);
      const dir = track(__project3760(text));
      try {
        let result;
        __emissionsDuring3760(() => { result = __migrate3760(dir); });
        __assert3760.strictEqual(result.migrated, false, 'nothing was migrated, so nothing may be written');
        __assert3760.strictEqual(result.wrote, null);
        __assert3760.strictEqual(
          __readConfig3760(dir), text,
          'the config file must be byte-identical — this is the data loss #3760 is about',
        );
        __assert3760.strictEqual(result.skipped.length, 1);
      } finally {
        for (const d of dirs) __cleanup3760(d);
      }
    });

    __t3760('a CRLF-formatted config with a non-object section is equally untouched', () => {
      const text = JSON.stringify({ git: 'main', branching_strategy: 'none' }, null, 2).replace(/\n/g, '\r\n');
      const dir = track(__project3760(text));
      try {
        let result;
        __emissionsDuring3760(() => { result = __migrate3760(dir); });
        __assert3760.strictEqual(result.migrated, false);
        __assert3760.strictEqual(__readConfig3760(dir), text);
      } finally {
        for (const d of dirs) __cleanup3760(d);
      }
    });

    __t3760('the multiRepo marker is KEPT, not consumed, when planning cannot receive it', () => {
      // multiRepo's entire meaning is "detect sub-repos and write them into
      // planning.sub_repos". If planning cannot receive them, consuming the marker
      // destroys the user's intent and leaves nothing to show for it. The refusal
      // is decided in normalizeLegacyKeys block 3, where it is still knowable —
      // not in the caller, by which point the marker is already gone.
      const text = JSON.stringify({ planning: 'docs', multiRepo: true }, null, 2);
      const dir = track(__project3760(text));
      // A real sub-repo, so detectSubRepos() returns a non-empty list.
      __fs3760.mkdirSync(__path3760.join(dir, 'sub', '.git'), { recursive: true });
      try {
        let result;
        __emissionsDuring3760(() => { result = __migrate3760(dir); });
        __assert3760.strictEqual(result.migrated, false, 'nothing migrated, so nothing written');
        __assert3760.strictEqual(
          __readConfig3760(dir), text,
          'the file must be byte-identical: planning intact AND multiRepo still present',
        );
        __assert3760.strictEqual(result.skipped.length, 1, 'the refusal must be reported');
        __assert3760.strictEqual(result.skipped[0].from, 'multiRepo');
        __assert3760.strictEqual(result.skipped[0].sectionType, 'string');
      } finally {
        for (const d of dirs) __cleanup3760(d);
      }
    });

    __t3760('multiRepo still migrates normally when planning is a usable section', () => {
      // Negative space: the block-3 guard must not break the ordinary path.
      const dir = track(__project3760(JSON.stringify({ planning: { commit_docs: true }, multiRepo: true }, null, 2)));
      __fs3760.mkdirSync(__path3760.join(dir, 'sub', '.git'), { recursive: true });
      try {
        let result;
        __emissionsDuring3760(() => { result = __migrate3760(dir); });
        const after = JSON.parse(__readConfig3760(dir));
        __assert3760.strictEqual(result.migrated, true);
        __assert3760.deepStrictEqual(after.planning.sub_repos, ['sub']);
        __assert3760.strictEqual(after.multiRepo, undefined, 'the marker is consumed once it has been honored');
        __assert3760.deepStrictEqual(result.skipped, []);
      } finally {
        for (const d of dirs) __cleanup3760(d);
      }
    });

    __t3760('multiRepo still migrates normally when planning is absent', () => {
      const dir = track(__project3760(JSON.stringify({ multiRepo: true }, null, 2)));
      __fs3760.mkdirSync(__path3760.join(dir, 'sub', '.git'), { recursive: true });
      try {
        let result;
        __emissionsDuring3760(() => { result = __migrate3760(dir); });
        const after = JSON.parse(__readConfig3760(dir));
        __assert3760.strictEqual(result.migrated, true);
        __assert3760.deepStrictEqual(after.planning.sub_repos, ['sub']);
        __assert3760.deepStrictEqual(result.skipped, []);
      } finally {
        for (const d of dirs) __cleanup3760(d);
      }
    });

    __t3760('migrateOnDisk itself emits nothing — configuration.cjs must stay dependency-free', () => {
      // #3571 pins that `configuration.cjs` loads from an install layout holding
      // only itself plus its manifests, so it cannot require the diagnostic seam.
      // The refusal is reported in-band here; the CALLERS do the emitting. If this
      // ever starts emitting, configuration.cjs has grown a sibling require and the
      // install layout will fail at load time with MODULE_NOT_FOUND.
      const dir = track(__project3760(JSON.stringify({ git: 'main', branching_strategy: 'none' }, null, 2)));
      try {
        let result;
        const emitted = __emissionsDuring3760(() => { result = __migrate3760(dir); });
        __assert3760.strictEqual(emitted, 0, 'the pure module must not reach the diagnostic seam');
        __assert3760.strictEqual(result.skipped.length, 1, 'but it must still report the refusal in-band');
      } finally {
        for (const d of dirs) __cleanup3760(d);
      }
    });

    __t3760('the reason is the typed enum entry, not ad-hoc prose', () => {
      __assert3760.strictEqual(__REASON3760.CONFIG_SECTION_NOT_OBJECT, 'config_section_not_object');
    });
  });

  // ── the CLI must not call a refused migration "already canonical" ────────

  __d3760('regressions — #3760 migrate-config reports a refusal', () => {
    let dirs;
    __be3760(() => { dirs = []; });

    __t3760('--json carries the skipped entry and no section value', () => {
      const dir = __project3760(JSON.stringify({ git: 'main', branching_strategy: 'none' }, null, 2));
      dirs.push(dir);
      try {
        const res = runMigrateConfig(dir);
        __assert3760.strictEqual(res.status, 0, 'a refusal is a reported result, not a fault');
        const parsed = JSON.parse(res.stdout);
        __assert3760.strictEqual(parsed.migrated, false);
        __assert3760.strictEqual(parsed.skipped.length, 1);
        __assert3760.strictEqual(parsed.skipped[0].sectionType, 'string');
        __assert3760.ok(
          !Object.prototype.hasOwnProperty.call(parsed.skipped[0], 'sectionValue'),
          'the JSON surface must not echo the section value',
        );
      } finally {
        for (const d of dirs) __cleanup3760(d);
      }
    });

    __t3760('--raw does NOT claim the config is already canonical', () => {
      // The refusal is the one thing only the user can fix. Telling them there
      // is nothing to fix is worse than saying nothing.
      const dir = __project3760(JSON.stringify({ git: 'main', branching_strategy: 'none' }, null, 2));
      dirs.push(dir);
      try {
        const res = runMigrateConfig(dir, ['--raw']);
        __assert3760.strictEqual(res.status, 0);
        __assert3760.ok(
          !res.stdout.includes('already canonical'),
          `a declined migration must not be reported as already-canonical; got: ${res.stdout}`,
        );
        __assert3760.ok(
          res.stdout.includes('branching_strategy'),
          'the declined key must be named so the user knows what to fix',
        );
      } finally {
        for (const d of dirs) __cleanup3760(d);
      }
    });

    __t3760('--raw still reports an already-canonical config as canonical', () => {
      // Negative space: the new branch must not swallow the ordinary no-op message.
      const dir = __project3760(JSON.stringify({ git: { branching_strategy: 'none' } }, null, 2));
      dirs.push(dir);
      try {
        const res = runMigrateConfig(dir, ['--raw']);
        __assert3760.strictEqual(res.status, 0);
        __assert3760.ok(res.stdout.includes('already canonical'), `got: ${res.stdout}`);
      } finally {
        for (const d of dirs) __cleanup3760(d);
      }
    });
  });
}
