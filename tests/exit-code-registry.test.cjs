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

const REPO_ROOT = path.resolve(__dirname, '..');
const GEN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'gen-exit-code-registry.cjs');
const REAL_DECLARATION_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'exit-codes.json');
const REAL_ARTIFACT_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'exit-code-registry.cjs');

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

function runGen(args, opts = {}) {
  return runNode([GEN_SCRIPT, ...args], { timeoutMs: PROBE_TIMEOUT_MS, ...opts });
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

describe('gen-exit-code-registry: cross-entry invariants', () => {
  test('duplicate code -> DUPLICATE_CODE, message names the code and both names', () => {
    const entries = [
      makeEntry({ code: 64, name: 'FIRST_NAME' }),
      makeEntry({ code: 64, name: 'SECOND_NAME' }),
    ];
    const result = generator.validateEntries(entries);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.DUPLICATE_CODE);
    assert.match(result.message, /64/);
    assert.match(result.message, /FIRST_NAME/);
    assert.match(result.message, /SECOND_NAME/);
  });

  test('duplicate name -> DUPLICATE_NAME', () => {
    const entries = [
      makeEntry({ code: 64, name: 'SAME_NAME' }),
      makeEntry({ code: 70, name: 'SAME_NAME' }),
    ];
    const result = generator.validateEntries(entries);
    assert.equal(result.ok, false);
    assert.equal(result.reason, generator.REASON.DUPLICATE_NAME);
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

  test('--check is in sync against the real committed pair', () => {
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
    const result = runGen(['--check', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(generator.REASON.DRIFTED));
  });

  test('--check with a stale artifact (declaration changed after write) -> DRIFTED', () => {
    const decl = validDeclarationPath(tmpDir, 'd-decl.json');
    const out = path.join(tmpDir, 'd-out.cjs');
    assert.equal(runGen(['--write', '--declaration', decl, '--out', out]).exitCode, 0);
    const entries = JSON.parse(fs.readFileSync(decl, 'utf8'));
    entries.push({ code: 80, name: 'DOMAIN_X', meaning: 'm', owner: 'domain-x', authorizedBy: 'ADR-3889' });
    fs.writeFileSync(decl, JSON.stringify(entries, null, 2), 'utf8');
    const result = runGen(['--check', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(generator.REASON.DRIFTED));
  });

  test('--check with the artifact absent -> MISSING_ARTIFACT', () => {
    const decl = validDeclarationPath(tmpDir, 'e-decl.json');
    const out = path.join(tmpDir, 'e-out-absent.cjs');
    const result = runGen(['--check', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(generator.REASON.MISSING_ARTIFACT));
    assert.equal(fs.existsSync(out), false);
  });

  test('unknown flag -> USAGE, exit 1, artifact unchanged on disk', () => {
    const decl = validDeclarationPath(tmpDir, 'f-decl.json');
    const out = path.join(tmpDir, 'f-out.cjs');
    assert.equal(runGen(['--write', '--declaration', decl, '--out', out]).exitCode, 0);
    const before = fs.readFileSync(out, 'utf8');
    const result = runGen(['--bogus-flag', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(generator.REASON.USAGE));
    const after = fs.readFileSync(out, 'utf8');
    assert.equal(after, before);
  });

  test('second positional argument -> USAGE', () => {
    const decl = validDeclarationPath(tmpDir, 'g-decl.json');
    const out = path.join(tmpDir, 'g-out.cjs');
    const result = runGen(['--check', 'extra-positional', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(generator.REASON.USAGE));
  });

  test('missing declaration -> MISSING_DECLARATION, exit 1', () => {
    const decl = path.join(tmpDir, 'does-not-exist-h.json');
    const out = path.join(tmpDir, 'h-out.cjs');
    const result = runGen(['--write', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(generator.REASON.MISSING_DECLARATION));
  });

  test('malformed JSON declaration -> MALFORMED_DECLARATION, exit 1', () => {
    const decl = path.join(tmpDir, 'i-decl.json');
    fs.writeFileSync(decl, '{ not json', 'utf8');
    const out = path.join(tmpDir, 'i-out.cjs');
    const result = runGen(['--write', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(generator.REASON.MALFORMED_DECLARATION));
  });

  test('valid JSON, not an array -> NOT_AN_ARRAY, exit 1', () => {
    const decl = path.join(tmpDir, 'j-decl.json');
    fs.writeFileSync(decl, '{}', 'utf8');
    const out = path.join(tmpDir, 'j-out.cjs');
    const result = runGen(['--write', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(generator.REASON.NOT_AN_ARRAY));
  });

  test('empty array declaration -> EMPTY_DECLARATION, exit 1', () => {
    const decl = path.join(tmpDir, 'k-decl.json');
    fs.writeFileSync(decl, '[]', 'utf8');
    const out = path.join(tmpDir, 'k-out.cjs');
    const result = runGen(['--write', '--declaration', decl, '--out', out]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(generator.REASON.EMPTY_DECLARATION));
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
  ];

  for (const [label, buildEntries, expectedReasonKey] of rows) {
    test(`${label} -> ${expectedReasonKey}, exit 1`, () => {
      const decl = writeFixture(label.replace(/[^a-z0-9]+/gi, '-'), buildEntries());
      const out = path.join(tmpDir, `${label.replace(/[^a-z0-9]+/gi, '-')}-out.cjs`);
      const result = runGen(['--write', '--declaration', decl, '--out', out]);
      assert.equal(result.exitCode, 1, `expected exit 1 for ${label}, got stderr: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(generator.REASON[expectedReasonKey]));
    });
  }
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
});
