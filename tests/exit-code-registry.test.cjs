'use strict';

/**
 * tests/exit-code-registry.test.cjs
 *
 * ADR-3889 ("One exit-code registry — 0 and 1 are free, everything else is
 * allocated") Phase 1 (#3905): behavioral tests for the allocator —
 * gsd-core/bin/shared/exit-codes.json (declaration), scripts/gen-exit-code-registry.cjs
 * (generator + validator), and the generated gsd-core/bin/lib/exit-code-registry.cjs
 * artifact (`EXIT_CODES`, `exitCodeFor`, `nameForExitCode`).
 *
 * Every test that needs a mutated declaration or artifact operates on a
 * temp-dir copy driven via --declaration/--out — the real repo files under
 * gsd-core/bin/shared and gsd-core/bin/lib are never mutated, since test
 * files in this repo run in parallel.
 *
 * fast-check is confirmed present in package.json devDependencies (^4.8.0);
 * property tests below pin { seed: 2704, numRuns: 200 } per-call so a
 * failure replays deterministically regardless of this suite's global fc
 * default.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { ensureScriptsOut } = require('./helpers/exit-code-artifact-flags.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GEN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'gen-exit-code-registry.cjs');
const REAL_DECLARATION_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'exit-codes.json');
const REAL_ARTIFACT_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'exit-code-registry.cjs');
const REAL_SCRIPTS_ARTIFACT_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'exit-code-registry.cjs');
const REAL_HOOKS_ARTIFACT_PATH = path.join(REPO_ROOT, 'hooks', 'lib', 'exit-code-registry.js');
const REAL_DTS_ARTIFACT_PATH = path.join(REPO_ROOT, 'src', 'exit-code-registry.d.cts');
const REAL_SH_ARTIFACT_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'exit-codes.sh');

const generator = require(GEN_SCRIPT);
const registry = require(REAL_ARTIFACT_PATH);

const REGISTERED_NAMES = new Set(registry.EXIT_CODES.map((e) => e.name));

/** A minimal, otherwise-valid entry template, overridable per field. */
function makeEntry(overrides) {
  return {
    code: 64,
    name: 'T_ENTRY',
    meaning: 'a test meaning',
    owner: 'generic',
    authorizedBy: 'ADR-3889',
    ...overrides,
  };
}

/**
 * #3906 (ADR-3889 Phase 2): the generator now emits FIVE artifacts — a
 * primary (gsd-core/bin/lib), a secondary (scripts/lib), and the ambient
 * `.d.cts` type declaration (src/exit-code-registry.d.cts). #3908 (Phase 4)
 * added a FOURTH: the shell-sourceable fragment (gsd-core/bin/shared/
 * exit-codes.sh). #3911 (Phase 7) added a FIFTH: the hooks/lib/ copy
 * (hooks/lib/exit-code-registry.js). Every existing call site below only
 * overrides the PRIMARY path via `--out`; without matching
 * `--scripts-out`/`--hooks-out`/`--dts-out`/`--sh-out` overrides, a
 * `--write` here would clobber the real committed
 * `scripts/lib/exit-code-registry.cjs`, `hooks/lib/exit-code-registry.js`,
 * `src/exit-code-registry.d.cts`, and `gsd-core/bin/shared/exit-codes.sh` —
 * dangerous since test files in this repo run in parallel. Rather than
 * touch every call site, this single seam derives co-located,
 * per-call-unique secondary/hooks/dts/sh paths from whatever `--out` value
 * the test already supplies, whenever the caller has not already supplied
 * its own `--scripts-out`/`--hooks-out`/`--dts-out`/`--sh-out`. Calls with
 * no explicit `--out` (the "real committed set" checks) are left untouched.
 *
 * `ensureScriptsOut` itself now lives in
 * ./helpers/exit-code-artifact-flags.cjs so tests/cli-exit.test.cjs can
 * reuse the exact same derivation rather than hand-rolling a second copy.
 */
function runGen(args, opts = {}) {
  return runNode([GEN_SCRIPT, ...ensureScriptsOut(args)], { timeoutMs: PROBE_TIMEOUT_MS, ...opts });
}

/**
 * Run the generator CLI with `--json` and parse its single stdout JSON
 * report. Per CONTRIBUTING.md's "Prohibited: Raw Text Matching on Test
 * Outputs", CLI-subprocess assertions in this suite key off this structured
 * `{ok, reason, context, detail?}` report — never a regex against human-readable
 * stdout/stderr prose.
 * @returns {{result: object, report: {ok:boolean, reason:string, detail?:string}}}
 */
function runGenJson(args, opts = {}) {
  const result = runGen(['--json', ...args], opts);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`runGenJson: stdout did not parse as JSON: ${err.message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return { result, report };
}

// ── exitCodeFor / nameForExitCode ─────────────────────────────────────────────
describe('exit-code-registry: exitCodeFor', () => {
  test('resolves each of the 5 registered names to its code', () => {
    assert.equal(registry.exitCodeFor('HOOK_DENY'), 2);
    assert.equal(registry.exitCodeFor('USAGE'), 64);
    assert.equal(registry.exitCodeFor('NO_INPUT'), 66);
    assert.equal(registry.exitCodeFor('UNAVAILABLE'), 69);
    assert.equal(registry.exitCodeFor('INTERNAL'), 70);
  });

  const badNames = [
    ['unknown name', 'NOT_A_REAL_NAME'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['number 0', 0],
    ['plain object', {}],
    ['array', []],
    ['wrong case', 'usage'],
    ['untrimmed', ' USAGE '],
    ['__proto__', '__proto__'],
    ['constructor', 'constructor'],
    ['toString', 'toString'],
  ];
  for (const [label, value] of badNames) {
    test(`throws for ${label}`, () => {
      assert.throws(() => registry.exitCodeFor(value));
    });
  }
});

describe('exit-code-registry: nameForExitCode', () => {
  test('resolves each of the 5 registered codes to its name', () => {
    assert.equal(registry.nameForExitCode(2), 'HOOK_DENY');
    assert.equal(registry.nameForExitCode(64), 'USAGE');
    assert.equal(registry.nameForExitCode(66), 'NO_INPUT');
    assert.equal(registry.nameForExitCode(69), 'UNAVAILABLE');
    assert.equal(registry.nameForExitCode(70), 'INTERNAL');
  });

  const badCodes = [
    ['unregistered code', 999],
    ['0 (free, unregistered)', 0],
    ['1 (free, unregistered)', 1],
    ['negative', -1],
    ['string', '64'],
    ['null', null],
    ['undefined', undefined],
  ];
  for (const [label, value] of badCodes) {
    test(`throws for ${label}`, () => {
      assert.throws(() => registry.nameForExitCode(value));
    });
  }
});

describe('exit-code-registry: shipped table invariants', () => {
  test('EXIT_CODES is frozen and every entry is frozen', () => {
    assert.ok(Object.isFrozen(registry.EXIT_CODES));
    for (const entry of registry.EXIT_CODES) {
      assert.ok(Object.isFrozen(entry), `entry ${JSON.stringify(entry)} must be frozen`);
    }
  });

  test('every shipped code is non-zero and inside an allocatable band', () => {
    assert.ok(registry.EXIT_CODES.length > 0);
    for (const entry of registry.EXIT_CODES) {
      assert.ok(Number.isInteger(entry.code));
      assert.notEqual(entry.code, 0);
      assert.ok(
        generator.isAllocatableCode(entry.code),
        `code ${entry.code} (${entry.name}) must be inside an allocatable band`,
      );
    }
  });

  test('code 2 is owned only by hook-adapter in the shipped table', () => {
    const hookDeny = registry.EXIT_CODES.find((e) => e.code === 2);
    assert.ok(hookDeny);
    assert.equal(hookDeny.owner, 'hook-adapter');
  });

  test('generic owns four distinct codes in the shipped table (ACCEPTED negative-space case)', () => {
    const genericCodes = registry.EXIT_CODES.filter((e) => e.owner === 'generic').map((e) => e.code);
    assert.equal(genericCodes.length, 4);
    assert.equal(new Set(genericCodes).size, 4);
  });
});

// ── Generator: REASON ─────────────────────────────────────────────────────────
describe('gen-exit-code-registry: REASON', () => {
  const expectedKeys = [
    'OK', 'DRIFTED', 'USAGE', 'MISSING_DECLARATION', 'MALFORMED_DECLARATION',
    'NOT_AN_ARRAY', 'EMPTY_DECLARATION', 'INVALID_ENTRY', 'DUPLICATE_CODE',
    'DUPLICATE_NAME', 'RESERVED_CODE', 'FORBIDDEN_OWNER', 'MISSING_ARTIFACT',
    'INVALID_CHARACTERS',
  ];

  test('is frozen', () => {
    assert.ok(Object.isFrozen(generator.REASON));
  });

  test('key set matches exactly', () => {
    assert.deepEqual(Object.keys(generator.REASON).sort(), [...expectedKeys].sort());
  });
});

// ── Generator: per-entry band validation (limit-1/limit/limit+1 for every edge) ──
describe('gen-exit-code-registry: band validation', () => {
  const cases = [
    [0, 'RESERVED_CODE'],
    [1, 'RESERVED_CODE'],
    [2, 'OK'],
    [3, 'RESERVED_CODE'],
    [13, 'RESERVED_CODE'],
    [14, 'RESERVED_CODE'],
    [63, 'RESERVED_CODE'],
    [64, 'OK'],
    [78, 'OK'],
    [79, 'RESERVED_CODE'],
    [80, 'OK'],
    [125, 'OK'],
    [126, 'RESERVED_CODE'],
    [127, 'RESERVED_CODE'],
    [128, 'RESERVED_CODE'],
    [-1, 'INVALID_ENTRY'],
    [1.5, 'INVALID_ENTRY'],
    ['64', 'INVALID_ENTRY'],
    [NaN, 'INVALID_ENTRY'],
    [Infinity, 'INVALID_ENTRY'],
  ];

  for (const [code, expected] of cases) {
    test(`code ${String(code)} -> ${expected}`, () => {
      const entry = makeEntry({
        code,
        name: `T_${String(code).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`,
        // code 2 is only accepted with owner hook-adapter; every other
        // fixture code here uses 'generic' and is unaffected by that rule.
        owner: code === 2 ? 'hook-adapter' : 'generic',
      });
      const result = generator.validateEntry(entry, 0);
      if (expected === 'OK') {
        assert.deepEqual(result, { ok: true });
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.reason, generator.REASON[expected]);
      }
    });
  }
});

describe('gen-exit-code-registry: forbidden owner for code 2', () => {
  test('code 2 with owner "hook-adapter" is accepted', () => {
    const result = generator.validateEntry(makeEntry({ code: 2, name: 'HOOK_DENY_2', owner: 'hook-adapter' }), 0);
    assert.deepEqual(result, { ok: true });
  });

  test('code 2 with any other owner is FORBIDDEN_OWNER', () => {
    const result = generator.validateEntry(makeEntry({ code: 2, name: 'HOOK_DENY_2', owner: 'generic' }), 0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.FORBIDDEN_OWNER);
  });
});

describe('gen-exit-code-registry: required string fields', () => {
  const fields = ['meaning', 'owner', 'authorizedBy'];
  const badValues = [undefined, '', '   '];

  for (const field of fields) {
    for (const bad of badValues) {
      test(`missing/empty/whitespace "${field}" (${JSON.stringify(bad)}) -> INVALID_ENTRY`, () => {
        const entry = makeEntry({ [field]: bad });
        const result = generator.validateEntry(entry, 0);
        assert.equal(result.ok, false);
        assert.equal(result.reason, generator.REASON.INVALID_ENTRY);
      });
    }
  }

  test('non-SCREAMING_SNAKE_CASE name -> INVALID_ENTRY', () => {
    const result = generator.validateEntry(makeEntry({ name: 'not_screaming' }), 0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.INVALID_ENTRY);
  });

  test('empty name -> INVALID_ENTRY', () => {
    const result = generator.validateEntry(makeEntry({ name: '' }), 0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.INVALID_ENTRY);
  });
});

// #3913 P9 SEC-3: a declaration string field carrying a `|`, CR, LF, or other
// control character breaks the Markdown table gen-exit-code-docs.cjs
// interpolates it into (a `|` splits the row; a `\n` can forge an entire
// extra row, including a fake Markdown heading). Rejected at the shared
// validator (validateEntry), not the renderer, so both generators inherit
// the fix.
describe('gen-exit-code-registry: forbidden characters in declaration string fields (#3913 P9 SEC-3)', () => {
  const fields = ['meaning', 'owner', 'authorizedBy'];
  const badValues = [
    ['a literal pipe', 'contains | a pipe'],
    ['a CR', 'contains\ra CR'],
    ['a LF', 'contains\na LF'],
    ['a CRLF', 'contains\r\na CRLF'],
    ['a NUL byte', 'contains\x00a NUL'],
    ['a DEL byte', 'contains\x7fa DEL'],
  ];

  for (const field of fields) {
    for (const [label, bad] of badValues) {
      test(`"${field}" containing ${label} -> INVALID_CHARACTERS`, () => {
        // F3a: failing-first against the pre-fix validator, this entry would
        // have passed validateEntry entirely (no character check existed).
        const entry = makeEntry({ [field]: bad });
        const result = generator.validateEntry(entry, 0);
        assert.equal(result.ok, false);
        assert.equal(result.reason, generator.REASON.INVALID_CHARACTERS);
      });
    }
  }

  test('a clean value with none of the forbidden characters is accepted', () => {
    const result = generator.validateEntry(makeEntry({ meaning: 'a perfectly normal meaning, with commas' }), 0);
    assert.deepEqual(result, { ok: true });
  });

  test('hasForbiddenDeclarationChar is the exact predicate validateEntry uses (no drift)', () => {
    assert.equal(generator.hasForbiddenDeclarationChar('clean'), false);
    assert.equal(generator.hasForbiddenDeclarationChar('a | pipe'), true);
    assert.equal(generator.hasForbiddenDeclarationChar('a\nnewline'), true);
    assert.equal(generator.hasForbiddenDeclarationChar('a\rreturn'), true);
  });
});

describe('gen-exit-code-registry: cross-entry invariants', () => {
  test('duplicate code -> DUPLICATE_CODE, context carries the code and both names', () => {
    const entries = [
      makeEntry({ code: 64, name: 'FIRST_NAME' }),
      makeEntry({ code: 64, name: 'SECOND_NAME' }),
    ];
    const result = generator.validateEntries(entries);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.DUPLICATE_CODE);
    assert.deepEqual(result.context, { code: 64, names: ['FIRST_NAME', 'SECOND_NAME'] });
  });

  test('duplicate name -> DUPLICATE_NAME, context carries the name and both codes', () => {
    const entries = [
      makeEntry({ code: 64, name: 'SAME_NAME' }),
      makeEntry({ code: 70, name: 'SAME_NAME' }),
    ];
    const result = generator.validateEntries(entries);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.DUPLICATE_NAME);
    assert.deepEqual(result.context, { name: 'SAME_NAME', codes: [64, 70] });
  });

  test('same owner, different codes -> ACCEPTED', () => {
    const entries = [
      makeEntry({ code: 64, name: 'OWNER_A', owner: 'generic' }),
      makeEntry({ code: 70, name: 'OWNER_B', owner: 'generic' }),
    ];
    const result = generator.validateEntries(entries);
    assert.deepEqual(result, { ok: true });
  });
});

// ── Generator: declaration-file handling (pure loadDeclaration, temp files) ──
describe('gen-exit-code-registry: declaration file handling', () => {
  let tmpDir;
  before(() => {
    tmpDir = createTempDir('gsd-exit-code-decl-');
  });
  after(() => {
    cleanup(tmpDir);
  });

  test('absent declaration -> MISSING_DECLARATION', () => {
    const missing = path.join(tmpDir, 'does-not-exist.json');
    const result = generator.loadDeclaration(missing);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.MISSING_DECLARATION);
  });

  test('unparseable JSON -> MALFORMED_DECLARATION', () => {
    const bad = path.join(tmpDir, 'malformed.json');
    fs.writeFileSync(bad, '{ this is not json', 'utf8');
    const result = generator.loadDeclaration(bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.MALFORMED_DECLARATION);
  });

  const notArrayCases = [
    ['object', '{}'],
    ['string', '"s"'],
    ['number', '0'],
    ['null', 'null'],
  ];
  for (const [label, json] of notArrayCases) {
    test(`valid JSON but not an array (${label}) -> NOT_AN_ARRAY`, () => {
      const p = path.join(tmpDir, `not-array-${label}.json`);
      fs.writeFileSync(p, json, 'utf8');
      const result = generator.loadDeclaration(p);
      assert.equal(result.ok, false);
      assert.equal(result.reason, generator.REASON.NOT_AN_ARRAY);
    });
  }

  test('empty array -> EMPTY_DECLARATION', () => {
    const p = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(p, '[]', 'utf8');
    const result = generator.loadDeclaration(p);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.EMPTY_DECLARATION);
  });
});

// ── Generator CLI ──────────────────────────────────────────────────────────────
describe('gen-exit-code-registry: CLI', () => {
  let tmpDir;
  before(() => {
    tmpDir = createTempDir('gsd-exit-code-cli-');
  });
  after(() => {
    cleanup(tmpDir);
  });

  function validDeclarationPath(dir, filename = 'exit-codes.json') {
    const p = path.join(dir, filename);
    fs.copyFileSync(REAL_DECLARATION_PATH, p);
    return p;
  }

  test('--check is in sync against the real committed set (both .cjs artifacts and the .d.cts)', () => {
    const result = runGen(['--check']);
    assert.equal(result.exitCode, 0, result.stderr);
  });

  test('--write then --check on temp paths both exit 0', () => {
    const decl = validDeclarationPath(tmpDir, 'a-decl.json');
    const out = path.join(tmpDir, 'a-out.cjs');
    const write = runGen(['--write', '--declaration', decl, '--out', out]);
    assert.equal(write.exitCode, 0, write.stderr);
    const check = runGen(['--check', '--declaration', decl, '--out', out]);
    assert.equal(check.exitCode, 0, check.stderr);
  });

  test('--write is idempotent (byte-identical on a second run)', () => {
    const decl = validDeclarationPath(tmpDir, 'b-decl.json');
    const out = path.join(tmpDir, 'b-out.cjs');
    const first = runGen(['--write', '--declaration', decl, '--out', out]);
    assert.equal(first.exitCode, 0, first.stderr);
    const firstBytes = fs.readFileSync(out, 'utf8');
    const second = runGen(['--write', '--declaration', decl, '--out', out]);
    assert.equal(second.exitCode, 0, second.stderr);
    const secondBytes = fs.readFileSync(out, 'utf8');
    assert.equal(secondBytes, firstBytes);
  });

  test('--check on a hand-edited artifact -> DRIFTED', () => {
    const decl = validDeclarationPath(tmpDir, 'c-decl.json');
    const out = path.join(tmpDir, 'c-out.cjs');
    assert.equal(runGen(['--write', '--declaration', decl, '--out', out]).exitCode, 0);
    fs.appendFileSync(out, '\n// hand-edited, drifts from generated content\n');
    const { result, report } = runGenJson(['--check', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.DRIFTED);
  });

  // Review finding (#3906 follow-up): the ambient .d.cts was hand-maintained
  // with no gate verifying it against serializeRegistry()'s actual shape.
  // These pin the SAME write/check/drift contract already proven for the two
  // .cjs artifacts above, but for the .d.cts specifically.
  test('--write emits a matching .d.cts artifact', () => {
    const decl = validDeclarationPath(tmpDir, 'dts-decl.json');
    const out = path.join(tmpDir, 'dts-out.cjs');
    const dtsOut = path.join(tmpDir, 'dts-out.d.cts');
    const write = runGen(['--write', '--declaration', decl, '--out', out, '--dts-out', dtsOut]);
    assert.equal(write.exitCode, 0, write.stderr);
    assert.ok(fs.existsSync(dtsOut), 'expected the .d.cts artifact to be written');
    const dtsContent = fs.readFileSync(dtsOut, 'utf8');
    assert.ok(dtsContent.includes('export interface ExitCodeEntry'));
    assert.ok(dtsContent.includes('export = exitCodeRegistry;'));

    const check = runGen(['--check', '--declaration', decl, '--out', out, '--dts-out', dtsOut]);
    assert.equal(check.exitCode, 0, check.stderr);
  });

  test('--check on a hand-edited .d.cts artifact -> DRIFTED', () => {
    const decl = validDeclarationPath(tmpDir, 'dts-drift-decl.json');
    const out = path.join(tmpDir, 'dts-drift-out.cjs');
    const dtsOut = path.join(tmpDir, 'dts-drift-out.d.cts');
    assert.equal(runGen(['--write', '--declaration', decl, '--out', out, '--dts-out', dtsOut]).exitCode, 0);
    fs.appendFileSync(dtsOut, '\n// hand-edited, drifts from generated content\n');
    const { result, report } = runGenJson(['--check', '--declaration', decl, '--out', out, '--dts-out', dtsOut]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.DRIFTED);
    assert.equal(report.context.artifact, 'dts');
  });

  test('--check with the .d.cts artifact absent -> MISSING_ARTIFACT', () => {
    const decl = validDeclarationPath(tmpDir, 'dts-missing-decl.json');
    const out = path.join(tmpDir, 'dts-missing-out.cjs');
    const dtsOut = path.join(tmpDir, 'dts-missing-out.d.cts');
    const { result, report } = runGenJson(['--check', '--declaration', decl, '--out', out, '--dts-out', dtsOut]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.MISSING_ARTIFACT);
    assert.equal(fs.existsSync(dtsOut), false);
  });

  test('--check with a stale artifact (declaration changed after write) -> DRIFTED', () => {
    const decl = validDeclarationPath(tmpDir, 'd-decl.json');
    const out = path.join(tmpDir, 'd-out.cjs');
    assert.equal(runGen(['--write', '--declaration', decl, '--out', out]).exitCode, 0);
    const entries = JSON.parse(fs.readFileSync(decl, 'utf8'));
    // 81, not 80: the real declaration already allocates 80 to DEGRADED, and
    // this fixture copies the REAL declaration (validDeclarationPath) — an
    // appended entry must pick a code neither of the two committed entries
    // already own, or the generator correctly reports fail_duplicate_code
    // instead of the DRIFTED this test means to exercise.
    entries.push({ code: 81, name: 'DOMAIN_X', meaning: 'm', owner: 'domain-x', authorizedBy: 'ADR-3889' });
    fs.writeFileSync(decl, JSON.stringify(entries, null, 2), 'utf8');
    const { result, report } = runGenJson(['--check', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.DRIFTED);
  });

  test('--check with the artifact absent -> MISSING_ARTIFACT', () => {
    const decl = validDeclarationPath(tmpDir, 'e-decl.json');
    const out = path.join(tmpDir, 'e-out-absent.cjs');
    const { result, report } = runGenJson(['--check', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.MISSING_ARTIFACT);
    assert.equal(fs.existsSync(out), false);
  });

  test('unknown flag -> USAGE, exit 1, artifact unchanged on disk', () => {
    const decl = validDeclarationPath(tmpDir, 'f-decl.json');
    const out = path.join(tmpDir, 'f-out.cjs');
    assert.equal(runGen(['--write', '--declaration', decl, '--out', out]).exitCode, 0);
    const before = fs.readFileSync(out, 'utf8');
    const { result, report } = runGenJson(['--bogus-flag', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.USAGE);
    const after = fs.readFileSync(out, 'utf8');
    assert.equal(after, before);
  });

  test('second positional argument -> USAGE', () => {
    const decl = validDeclarationPath(tmpDir, 'g-decl.json');
    const out = path.join(tmpDir, 'g-out.cjs');
    const { result, report } = runGenJson(['--check', 'extra-positional', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.USAGE);
  });

  test('missing declaration -> MISSING_DECLARATION, exit 1', () => {
    const decl = path.join(tmpDir, 'does-not-exist-h.json');
    const out = path.join(tmpDir, 'h-out.cjs');
    const { result, report } = runGenJson(['--write', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.MISSING_DECLARATION);
  });

  test('malformed JSON declaration -> MALFORMED_DECLARATION, exit 1', () => {
    const decl = path.join(tmpDir, 'i-decl.json');
    fs.writeFileSync(decl, '{ not json', 'utf8');
    const out = path.join(tmpDir, 'i-out.cjs');
    const { result, report } = runGenJson(['--write', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.MALFORMED_DECLARATION);
  });

  test('valid JSON, not an array -> NOT_AN_ARRAY, exit 1', () => {
    const decl = path.join(tmpDir, 'j-decl.json');
    fs.writeFileSync(decl, '{}', 'utf8');
    const out = path.join(tmpDir, 'j-out.cjs');
    const { result, report } = runGenJson(['--write', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.NOT_AN_ARRAY);
  });

  test('empty array declaration -> EMPTY_DECLARATION, exit 1', () => {
    const decl = path.join(tmpDir, 'k-decl.json');
    fs.writeFileSync(decl, '[]', 'utf8');
    const out = path.join(tmpDir, 'k-out.cjs');
    const { result, report } = runGenJson(['--write', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.EMPTY_DECLARATION);
  });

  // Regression (#3911 follow-up): ensureScriptsOut derived --scripts-out/
  // --dts-out/--sh-out from --out but did not derive --hooks-out, so any
  // --write test here silently clobbered the real committed
  // hooks/lib/exit-code-registry.js. Assert over ALL FIVE committed
  // artifacts so the next added target is covered by construction.
  test('a --write run redirected to a tmpdir leaves every committed artifact untouched', () => {
    const before = {
      out: fs.readFileSync(REAL_ARTIFACT_PATH, 'utf8'),
      scripts: fs.readFileSync(REAL_SCRIPTS_ARTIFACT_PATH, 'utf8'),
      hooks: fs.readFileSync(REAL_HOOKS_ARTIFACT_PATH, 'utf8'),
      dts: fs.readFileSync(REAL_DTS_ARTIFACT_PATH, 'utf8'),
      sh: fs.readFileSync(REAL_SH_ARTIFACT_PATH, 'utf8'),
    };

    const decl = validDeclarationPath(tmpDir, 'l-decl.json');
    const out = path.join(tmpDir, 'l-out.cjs');
    const write = runGen(['--write', '--declaration', decl, '--out', out]);
    assert.equal(write.exitCode, 0, write.stderr);

    assert.equal(fs.readFileSync(REAL_ARTIFACT_PATH, 'utf8'), before.out, 'primary artifact must be untouched');
    assert.equal(fs.readFileSync(REAL_SCRIPTS_ARTIFACT_PATH, 'utf8'), before.scripts, 'scripts artifact must be untouched');
    assert.equal(fs.readFileSync(REAL_HOOKS_ARTIFACT_PATH, 'utf8'), before.hooks, 'hooks artifact must be untouched');
    assert.equal(fs.readFileSync(REAL_DTS_ARTIFACT_PATH, 'utf8'), before.dts, '.d.cts artifact must be untouched');
    assert.equal(fs.readFileSync(REAL_SH_ARTIFACT_PATH, 'utf8'), before.sh, '.sh artifact must be untouched');

    assert.ok(fs.existsSync(`${out}.hooks.js`), 'expected the redirected hooks copy to land in the tmpdir');
    assert.ok(fs.existsSync(`${out}.secondary.cjs`), 'expected the redirected scripts copy to land in the tmpdir');
    assert.ok(fs.existsSync(`${out}.d.cts`), 'expected the redirected .d.cts copy to land in the tmpdir');
    assert.ok(fs.existsSync(`${out}.sh`), 'expected the redirected .sh copy to land in the tmpdir');
  });
});

// ── Generator CLI: positive controls (each guard actually FAILS the build) ────
describe('gen-exit-code-registry: CLI positive controls for the ten guard rows', () => {
  let tmpDir;
  before(() => {
    tmpDir = createTempDir('gsd-exit-code-positive-');
  });
  after(() => {
    cleanup(tmpDir);
  });

  function writeFixture(name, entries) {
    const decl = path.join(tmpDir, `${name}.json`);
    fs.writeFileSync(decl, JSON.stringify(entries, null, 2), 'utf8');
    return decl;
  }

  const validBase = () => ({ meaning: 'm', owner: 'generic', authorizedBy: 'ADR-3889' });

  const rows = [
    ['duplicate code', () => [
      { ...validBase(), code: 64, name: 'DUP_A' },
      { ...validBase(), code: 64, name: 'DUP_B' },
    ], 'DUPLICATE_CODE'],
    ['duplicate name', () => [
      { ...validBase(), code: 64, name: 'SAME' },
      { ...validBase(), code: 70, name: 'SAME' },
    ], 'DUPLICATE_NAME'],
    ['code 2 wrong owner', () => [
      { ...validBase(), code: 2, name: 'HOOK_DENY', owner: 'not-hook-adapter' },
    ], 'FORBIDDEN_OWNER'],
    ['code 0', () => [{ ...validBase(), code: 0, name: 'ZERO' }], 'RESERVED_CODE'],
    ['code 13', () => [{ ...validBase(), code: 13, name: 'THIRTEEN' }], 'RESERVED_CODE'],
    ['code 79', () => [{ ...validBase(), code: 79, name: 'SEVENTYNINE' }], 'RESERVED_CODE'],
    ['code 126', () => [{ ...validBase(), code: 126, name: 'ONETWENTYSIX' }], 'RESERVED_CODE'],
    ['code "64" (string)', () => [{ ...validBase(), code: '64', name: 'STRCODE' }], 'INVALID_ENTRY'],
    ['missing meaning', () => [{ code: 64, name: 'NO_MEANING', owner: 'generic', authorizedBy: 'ADR-3889' }], 'INVALID_ENTRY'],
    ['[] empty declaration', () => [], 'EMPTY_DECLARATION'],
    // F3a: a `meaning` carrying a `|` or a newline must be REJECTED with a non-zero exit —
    // failing-first against the pre-fix validator (#3913 P9 SEC-3).
    ['meaning with a pipe', () => [{ ...validBase(), code: 64, name: 'PIPE_MEANING', meaning: 'a | pipe breaks the table' }], 'INVALID_CHARACTERS'],
    ['meaning with a newline', () => [{ ...validBase(), code: 64, name: 'NEWLINE_MEANING', meaning: 'a\nforged heading' }], 'INVALID_CHARACTERS'],
  ];

  for (const [label, buildEntries, expectedReasonKey] of rows) {
    test(`${label} -> ${expectedReasonKey}, exit 1`, () => {
      const decl = writeFixture(label.replace(/[^a-z0-9]+/gi, '-'), buildEntries());
      const out = path.join(tmpDir, `${label.replace(/[^a-z0-9]+/gi, '-')}-out.cjs`);
      const { result, report } = runGenJson(['--write', '--declaration', decl, '--out', out]);
      assert.equal(result.exitCode, 1, `expected exit 1 for ${label}, got stderr: ${result.stderr}`);
      assert.equal(report.ok, false);
      assert.equal(report.reason, generator.REASON[expectedReasonKey]);
    });
  }

  test('duplicate-code fixture: --json payload carries a structured context, not just the reason', () => {
    const decl = writeFixture('json-duplicate-code', [
      { ...validBase(), code: 64, name: 'DUP_A' },
      { ...validBase(), code: 64, name: 'DUP_B' },
    ]);
    const out = path.join(tmpDir, 'json-duplicate-code-out.cjs');
    const { result, report } = runGenJson(['--write', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(report.ok, false);
    assert.equal(report.reason, generator.REASON.DUPLICATE_CODE);
    // A --json consumer must be able to learn WHICH code collided and WHICH
    // names collided without parsing the `detail` prose string.
    assert.deepEqual(report.context, { code: 64, names: ['DUP_A', 'DUP_B'] });
  });
});

// ── gen-exit-code-docs.cjs: docs/reference/exit-codes.md (P9, #3913, matrix F) ──
describe('gen-exit-code-docs: generated exit-code reference page (matrix F1-F4)', () => {
  const DOCS_GEN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'gen-exit-code-docs.cjs');
  const REAL_DOC_PATH = path.join(REPO_ROOT, 'docs', 'reference', 'exit-codes.md');
  const README_PATH = path.join(REPO_ROOT, 'docs', 'README.md');
  const docsGenerator = require(DOCS_GEN_SCRIPT);

  function runDocsGen(args, opts = {}) {
    return runNode([DOCS_GEN_SCRIPT, ...args], { timeoutMs: PROBE_TIMEOUT_MS, ...opts });
  }

  // F1: every code in the registry appears in the generated page with its
  // name — asserted over the ENUMERATED registry, so a newly allocated code
  // fails until documented.
  test('F1: every registered code appears in the generated page with its name', () => {
    const md = fs.readFileSync(REAL_DOC_PATH, 'utf8');
    assert.ok(registry.EXIT_CODES.length > 0, 'precondition: the registry is non-empty');
    for (const entry of registry.EXIT_CODES) {
      const row = md.split(/\r?\n/).find((l) => l.startsWith(`| ${entry.code} |`));
      assert.ok(row, `code ${entry.code} (${entry.name}) must appear as a row in the generated page`);
      assert.ok(row.includes(`\`${entry.name}\``), `code ${entry.code}'s row must carry its name ${entry.name}`);
    }
  });

  // F2: `--check` exits non-zero when the committed page diverges from a
  // fresh render. Proven by mutating a COPY (via --declaration/--out
  // redirection to a tmpdir, never the real committed file — test files in
  // this repo run in parallel) and observing the non-zero exit — not by
  // reading the code.
  describe('F2: --check catches drift (mutate-then-observe, not read-the-code)', () => {
    let tmpDir;
    before(() => {
      tmpDir = createTempDir('gsd-exit-code-docs-f2-');
    });
    after(() => {
      cleanup(tmpDir);
    });

    test('a freshly generated copy of the real committed page passes --check', () => {
      const decl = path.join(tmpDir, 'decl.json');
      fs.copyFileSync(REAL_DECLARATION_PATH, decl);
      const out = path.join(tmpDir, 'exit-codes.md');
      const write = runDocsGen(['--write', '--declaration', decl, '--out', out]);
      assert.equal(write.exitCode, 0, write.stderr);
      const check = runDocsGen(['--check', '--declaration', decl, '--out', out]);
      assert.equal(check.exitCode, 0, check.stderr);
    });

    test('mutating the generated page then running --check exits non-zero', () => {
      const decl = path.join(tmpDir, 'decl-mutate.json');
      fs.copyFileSync(REAL_DECLARATION_PATH, decl);
      const out = path.join(tmpDir, 'exit-codes-mutate.md');
      assert.equal(runDocsGen(['--write', '--declaration', decl, '--out', out]).exitCode, 0);

      // Mutate the generated copy — e.g. a hand-edit drifting from the
      // generator's own output — then observe the ACTUAL exit code.
      fs.appendFileSync(out, '\n<!-- hand-edited, drifts from generated content -->\n');
      const check = runDocsGen(['--check', '--declaration', decl, '--out', out]);
      assert.notEqual(check.exitCode, 0, 'a drifted page must fail --check, not pass it');
    });
  });

  // F3: `--check` exits 0 on the committed tree (the generator is idempotent).
  test('F3: --check exits 0 against the real committed page', () => {
    const result = runDocsGen(['--check']);
    assert.equal(result.exitCode, 0, result.stderr);
  });

  // F4: the page is reachable from docs/README.md.
  test('F4: docs/README.md links to the generated exit-code reference page', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    assert.ok(readme.includes('reference/exit-codes.md'), 'docs/README.md must index docs/reference/exit-codes.md');
  });

  // Real parity assertion (replaces a near-tautological pair of `.includes()`
  // checks — `md.includes('3')` matches "ADR-3889", not the Node-reserved
  // band). Enumerates the FULL scanned code space and asserts the rendered
  // "Reserved bands" table's ranges and row grouping are exactly what
  // computeBandRanges/classifyBand — themselves composed only from
  // isAllocatableCode/bandFor — return today. This fails the moment the
  // generator's band table is re-hardcoded as a literal that stops tracking
  // gen-exit-code-registry.cjs's own band logic.
  test('parity: every rendered band range and status is DERIVED from isAllocatableCode/bandFor, not retyped', () => {
    const md = fs.readFileSync(REAL_DOC_PATH, 'utf8');
    const ranges = generator.computeBandRanges(500);
    for (const { category, ranges: subRanges } of ranges) {
      for (const range of subRanges) {
        // Every individual code in every derived range must actually
        // classify into that category right now — i.e. the derivation is
        // self-consistent over the enumerated space, not just internally
        // coherent by construction.
        for (let code = range.start; code <= range.end; code += 1) {
          assert.equal(generator.classifyBand(code), category, `code ${code} must classify as ${category}`);
        }
        // And the rendered page must actually contain a band-table token
        // for this range's boundary (its start or its formatted label),
        // so a hand-edited/stale table (the #1 defect: a literal that
        // never changed when the band logic did) is caught here too.
        const label = range.openEnded ? `${range.start}+` : (range.start === range.end ? `${range.start}` : `${range.start}\`–\`${range.end}`);
        assert.ok(md.includes(`\`${label}\``), `rendered page must contain the derived band label for ${category}: \`${label}\``);
      }
    }
  });

  // Regression for #1: proves the band table is genuinely DERIVED from
  // isAllocatableCode/bandFor rather than a second hand-typed literal. Widens
  // the band logic in a SCRATCH COPY of both generator scripts (never the
  // real committed files) so that 14-63 becomes allocatable, then runs
  // `--check` against the REAL committed page with that widened logic. If
  // the band table were still hand-typed (the pre-fix defect), --check would
  // stay green because the template string never changed; with the fix, the
  // freshly-rendered table for the widened logic diverges from the committed
  // page's band table and --check must exit non-zero.
  test('band table is DERIVED: widening isAllocatableCode without regenerating fails --check (regression, #1)', () => {
    const tmp = createTempDir('gsd-exit-code-docs-band-parity-');
    try {
      const registrySrc = fs.readFileSync(GEN_SCRIPT, 'utf8');
      // Widen the SAME BANDS table isAllocatableCode/bandFor/classifyBand are
      // all derived from — this is the realistic "someone widens a band"
      // edit the reviewer demonstrated, not a change to a derived function.
      const NEEDLE = "{ category: 'generic', allocatable: true, test: (code) => code >= 64 && code <= 78 }";
      assert.ok(registrySrc.includes(NEEDLE), 'precondition: gen-exit-code-registry.cjs must still contain the BANDS entry this test widens');
      const widened = registrySrc.replace(
        NEEDLE,
        "{ category: 'generic', allocatable: true, test: (code) => (code >= 64 && code <= 78) || (code >= 14 && code <= 63) }",
      );
      assert.notEqual(widened, registrySrc, 'precondition: the widen replacement must actually change the source');
      fs.writeFileSync(path.join(tmp, 'gen-exit-code-registry.cjs'), widened, 'utf8');

      const docsSrc = fs.readFileSync(DOCS_GEN_SCRIPT, 'utf8');
      fs.writeFileSync(path.join(tmp, 'gen-exit-code-docs.cjs'), docsSrc, 'utf8');
      fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'cli-exit.cjs'), path.join(tmp, 'lib', 'cli-exit.cjs'));

      const check = runNode([path.join(tmp, 'gen-exit-code-docs.cjs'), '--check'], { timeoutMs: PROBE_TIMEOUT_MS });
      assert.notEqual(check.exitCode, 0, 'a widened band (14-63 admitted) must invalidate the committed page — if this passes, the band table is a hand-typed literal again, not derived from isAllocatableCode/bandFor');
    } finally {
      cleanup(tmp);
    }
  });

  // T1 (#3913 P9 review follow-up): a BANDS category present in neither
  // CATEGORY_ROW_ORDER nor CATEGORY_MERGE_INTO must make generation THROW —
  // not silently omit the new band from the rendered table while --check
  // stays green (the exact defect assertBandCategoriesConsistent in
  // gen-exit-code-docs.cjs closes). Driven via a scratch copy of both
  // generator scripts, mirroring the widen-a-band regression test above —
  // never the real committed files.
  // Every T1-T3 scratch copy needs the same three sibling files
  // gen-exit-code-docs.cjs's own `require`s resolve relative to itself:
  // gen-exit-code-registry.cjs (source of BANDS), lib/cli-exit.cjs, and
  // lib/exit-code-registry.cjs (cli-exit.cjs's own dependency). Loading the
  // scratch module directly (never via `--check`/`--write`) and calling
  // `loadEntries`/`buildDoc` against the REAL committed declaration isolates
  // the assertion under test from the doc-page-drift machinery entirely.
  function scaffoldScratchDocsModule(tmp, docsSrc) {
    fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'cli-exit.cjs'), path.join(tmp, 'lib', 'cli-exit.cjs'));
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'exit-code-registry.cjs'), path.join(tmp, 'lib', 'exit-code-registry.cjs'));
    const entryPath = path.join(tmp, 'docsgen-entry.cjs');
    fs.writeFileSync(entryPath, docsSrc, 'utf8');
    return entryPath;
  }

  test('T1: a BANDS category with no CATEGORY_ROW_ORDER/CATEGORY_MERGE_INTO entry throws generation, not a silent omission', () => {
    const tmp = createTempDir('gsd-exit-code-docs-p9cat-');
    try {
      const registrySrc = fs.readFileSync(GEN_SCRIPT, 'utf8');
      const NEEDLE = "  { category: 'shell-signal', allocatable: false, test: (code) => code >= 126 },\n]);";
      assert.ok(registrySrc.includes(NEEDLE), 'precondition: BANDS closing entry must still match');
      const mutated = registrySrc.replace(
        NEEDLE,
        "  { category: 'shell-signal', allocatable: false, test: (code) => code >= 126 },\n"
        + "  { category: 'brand-new-band', allocatable: true, test: (code) => code === 40 },\n]);",
      );
      assert.notEqual(mutated, registrySrc, 'precondition: the BANDS injection must actually change the source');
      fs.writeFileSync(path.join(tmp, 'gen-exit-code-registry.cjs'), mutated, 'utf8');

      const entryPath = scaffoldScratchDocsModule(tmp, fs.readFileSync(DOCS_GEN_SCRIPT, 'utf8'));
      const scratchDocs = require(entryPath);
      const entries = scratchDocs.loadEntries(REAL_DECLARATION_PATH);

      // Pre-fix (RED): buildDoc succeeds and silently omits the new band —
      // it never appears anywhere in the rendered table. Post-fix (GREEN):
      // buildDoc throws naming the unaccounted category.
      assert.throws(
        () => scratchDocs.buildDoc(entries),
        /fail_band_category_unaccounted:.*brand-new-band/,
        'an unaccounted BANDS category must fail generation loudly, not render a table that silently omits it',
      );
    } finally {
      cleanup(tmp);
    }
  });

  // T2: a CATEGORY_ROW_ORDER entry with no BAND_PROSE entry must throw rather
  // than rendering the literal string "undefined" into the table.
  test('T2: a CATEGORY_ROW_ORDER entry with no BAND_PROSE entry throws rather than rendering undefined', () => {
    const tmp = createTempDir('gsd-exit-code-docs-p9cat-');
    try {
      fs.copyFileSync(GEN_SCRIPT, path.join(tmp, 'gen-exit-code-registry.cjs'));

      const docsSrc = fs.readFileSync(DOCS_GEN_SCRIPT, 'utf8');
      const NEEDLE = "  domain: '**Domain band.**";
      assert.ok(docsSrc.includes(NEEDLE), 'precondition: BAND_PROSE.domain entry must still match');
      // Delete the `domain` prose entry entirely while leaving `domain` in
      // CATEGORY_ROW_ORDER — the exact stale-in-one-list-not-the-other shape.
      // Line-filtered via splitLines (not a bare-`\n` regex) so this stays
      // correct under Windows git-autocrlf CRLF line endings too.
      const mutated = splitLines(docsSrc).filter((line) => !line.startsWith(NEEDLE)).join('\n');
      assert.notEqual(mutated, docsSrc, 'precondition: the BAND_PROSE deletion must actually change the source');
      assert.ok(!mutated.includes("domain: '**Domain band.**"), 'precondition: BAND_PROSE.domain must actually be gone');

      const entryPath = scaffoldScratchDocsModule(tmp, mutated);
      const scratchDocs = require(entryPath);
      const entries = scratchDocs.loadEntries(REAL_DECLARATION_PATH);

      assert.throws(
        () => scratchDocs.buildDoc(entries),
        /fail_band_prose_missing:.*domain/,
        'a CATEGORY_ROW_ORDER entry missing from BAND_PROSE must fail generation loudly, not render "undefined"',
      );
    } finally {
      cleanup(tmp);
    }
  });

  // T3: a stale BAND_PROSE category that no BANDS entry (directly, or via
  // CATEGORY_MERGE_INTO) produces must throw — dead prose for a band that no
  // longer exists is the same drift in the other direction.
  test('T3: a stale BAND_PROSE category no BANDS entry produces throws', () => {
    const tmp = createTempDir('gsd-exit-code-docs-p9cat-');
    try {
      fs.copyFileSync(GEN_SCRIPT, path.join(tmp, 'gen-exit-code-registry.cjs'));

      const docsSrc = fs.readFileSync(DOCS_GEN_SCRIPT, 'utf8');
      const NEEDLE = "const BAND_PROSE = Object.freeze({\n";
      assert.ok(docsSrc.includes(NEEDLE), 'precondition: BAND_PROSE opening must still match');
      const mutated = docsSrc.replace(
        NEEDLE,
        `${NEEDLE}  'long-retired-band': 'This band was retired and no BANDS entry produces it any more.',\n`,
      );
      assert.notEqual(mutated, docsSrc, 'precondition: the stale BAND_PROSE injection must actually change the source');

      const entryPath = scaffoldScratchDocsModule(tmp, mutated);
      const scratchDocs = require(entryPath);
      const entries = scratchDocs.loadEntries(REAL_DECLARATION_PATH);

      assert.throws(
        () => scratchDocs.buildDoc(entries),
        /fail_band_category_stale:.*long-retired-band/,
        'a stale BAND_PROSE category with no producing BANDS entry must fail generation loudly',
      );
    } finally {
      cleanup(tmp);
    }
  });

  // T4 (positive control): the REAL, unmodified configuration renders all six
  // rows with no literal "undefined" anywhere in the page. Without this, a
  // fix that throws unconditionally (rather than only on genuine drift) would
  // still pass T1-T3 by accident.
  test('T4: the real unmodified configuration renders all six band rows with no "undefined" in the page', () => {
    const result = runDocsGen(['--check']);
    assert.equal(result.exitCode, 0, result.stderr);
    const md = fs.readFileSync(REAL_DOC_PATH, 'utf8');
    assert.ok(!md.includes('undefined'), 'the generated page must never contain the literal string "undefined"');
    const bandTableSection = md.slice(md.indexOf('| Band | Meaning |'), md.indexOf('## The v1/v2 exit contract'));
    // `|---|---|` starts with `|-`, not `| `, so it is already excluded by
    // this pattern — only the header line (`| Band | Meaning |`) needs
    // subtracting to leave just the data rows.
    const rowCount = (bandTableSection.match(/^\| /gm) || []).length - 1;
    assert.equal(rowCount, 6, 'the Reserved bands table must render exactly six rows (free, hook-only, node-reserved, outside-every-band, generic, domain)');
  });

  // Forward guard, not a regression test: buildDoc has no source of
  // non-determinism (no Date.now/Math.random/env read), so this cannot
  // currently fail — it exists to catch a FUTURE change that introduces one.
  test('forward guard: buildDoc stays pure if a future change adds a non-deterministic input', () => {
    const once = docsGenerator.buildDoc(registry.EXIT_CODES);
    const twice = docsGenerator.buildDoc(registry.EXIT_CODES);
    assert.equal(once, twice);
  });
});

// ── fast-check properties ─────────────────────────────────────────────────────
describe('exit-code-registry: fast-check properties', () => {
  test('nameForExitCode(exitCodeFor(name)) round-trips for every registered name', () => {
    fc.assert(
      fc.property(fc.constantFrom(...registry.EXIT_CODES.map((e) => e.name)), (name) => {
        assert.equal(registry.nameForExitCode(registry.exitCodeFor(name)), name);
      }),
      { seed: 2704, numRuns: 200 },
    );
  });

  test('exitCodeFor(nameForExitCode(code)) round-trips for every registered code', () => {
    fc.assert(
      fc.property(fc.constantFrom(...registry.EXIT_CODES.map((e) => e.code)), (code) => {
        assert.equal(registry.exitCodeFor(registry.nameForExitCode(code)), code);
      }),
      { seed: 2704, numRuns: 200 },
    );
  });

  test('exitCodeFor never resolves a code for an unregistered string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!REGISTERED_NAMES.has(s));
        assert.throws(() => registry.exitCodeFor(s));
      }),
      { seed: 2704, numRuns: 200 },
    );
  });

  // Unlike the two round-trip properties above (which replay only the 5
  // shipped constants), this one explores the full integer domain —
  // negatives, every band boundary, and values far outside every band —
  // rather than a closed set of examples.
  test('nameForExitCode(c) either throws or returns a name that round-trips to c, for any integer c', () => {
    fc.assert(
      fc.property(fc.integer(), (c) => {
        let name;
        try {
          name = registry.nameForExitCode(c);
        } catch {
          return; // throwing for an unregistered code is a legal outcome
        }
        assert.notEqual(name, undefined);
        assert.equal(registry.exitCodeFor(name), c);
      }),
      { seed: 2704, numRuns: 200 },
    );
  });
});
