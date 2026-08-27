'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNamedArgs,
  parseMultiwordArg,
} = require('../gsd-core/bin/lib/command-arg-projection.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { runCli } = require('./helpers/cli-negative.cjs');

// ---------------------------------------------------------------------------
// parseNamedArgs — behavior-lock tests (green before AND after the #312 fix)
// ---------------------------------------------------------------------------

test('value flag with valid value', () => {
  const result = parseNamedArgs(['--name', 'foo'], { valueFlags: ['name'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { name: 'foo' } });
});

// Corrected after the first full verification run: a value flag whose next
// token is another flag is NOT an error (see the "strict argv" describe
// block below, valueFlagFollowedByAnotherFlagResolvesToNullNotAnError) — it
// resolves to `null` and the cursor advances by 1 so the following token is
// validated on its own merits. `--other` is deliberately left undeclared
// here since this row tests extraction only; `positionals: 'rest'` skips
// the unrelated unknown-flag validation.
test('value flag followed by another flag resolves to null, not rejected', () => {
  const result = parseNamedArgs(['--name', '--other'], { valueFlags: ['name'], positionals: 'rest' });
  assert.deepStrictEqual(result, { ok: true, data: { name: null } });
});

// Corrected after the first full verification run: a value flag with no
// following token at all resolves to `null`, not an error — see the
// "strict argv" describe block below.
test('value flag at end of array (no following token)', () => {
  const result = parseNamedArgs(['--name'], { valueFlags: ['name'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { name: null } });
});

// The original 'value flag absent from args' row passed `['--x', 'y']` with
// only `name` declared. Under strict mode `--x` is itself an unknown flag —
// split into two rows so neither original intent (an undeclared flag is
// null when TRULY absent; `--x` is rejected) is silently dropped.
test('absent declared flag resolves to null (not an error)', () => {
  const result = parseNamedArgs([], { valueFlags: ['name'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { name: null } });
});

test('an undeclared flag token is rejected, not silently ignored', () => {
  const result = parseNamedArgs(['--x', 'y'], { valueFlags: ['name'], positionals: 0 });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.kind, 'InvalidArgs');
  assert.strictEqual(result.arg, '--x');
});

test('boolean flag present', () => {
  const result = parseNamedArgs(['--write'], { booleanFlags: ['write'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { write: true } });
});

test('boolean flag absent', () => {
  const result = parseNamedArgs([], { booleanFlags: ['write'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { write: false } });
});

// Negative space N4: a repeated flag is not an unknown token — first
// occurrence still wins, and each occurrence is itself a well-formed
// flag+value pair, so strict validation still passes.
test('first-occurrence-wins: duplicate value flag uses first index', () => {
  // Locks the indexOf-first semantics that the Map must preserve (#312)
  const result = parseNamedArgs(['--name', 'a', '--name', 'b'], { valueFlags: ['name'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { name: 'a' } });
});

test('mixed multiple flags (the O(flags*argv) case)', () => {
  const result = parseNamedArgs(
    ['--a', '1', '--flag', '--b', '2'],
    { valueFlags: ['a', 'b'], booleanFlags: ['flag'], positionals: 0 },
  );
  assert.deepStrictEqual(result, { ok: true, data: { a: '1', b: '2', flag: true } });
});

test('empty args with multiple declared flags', () => {
  const result = parseNamedArgs(
    [],
    { valueFlags: ['name', 'path'], booleanFlags: ['verbose', 'dry-run'], positionals: 0 },
  );
  assert.deepStrictEqual(result, {
    ok: true,
    data: { name: null, path: null, verbose: false, 'dry-run': false },
  });
});

// Corrected after the first full verification run: a value flag exhausted
// by the array boundary resolves to `null`, not InvalidArgs — including
// when it is preceded by another well-formed flag+value pair.
test('value flag at end of argv resolves to null even when preceded by another flag', () => {
  const result = parseNamedArgs(
    ['--other', 'x', '--count'],
    { valueFlags: ['other', 'count'], positionals: 0 },
  );
  assert.deepStrictEqual(result, { ok: true, data: { other: 'x', count: null } });
});

test('boolean flag does not clobber an already-set value-flag key when names differ', () => {
  const result = parseNamedArgs(
    ['--msg', 'hello', '--verbose'],
    { valueFlags: ['msg'], booleanFlags: ['verbose'], positionals: 0 },
  );
  assert.deepStrictEqual(result, { ok: true, data: { msg: 'hello', verbose: true } });
});

// ---------------------------------------------------------------------------
// parseMultiwordArg — spot coverage for module completeness
// ---------------------------------------------------------------------------

test('parseMultiwordArg: collects tokens until next flag', () => {
  assert.strictEqual(
    parseMultiwordArg(['--msg', 'hello', 'world', '--x'], 'msg'),
    'hello world'
  );
});

test('parseMultiwordArg: absent flag returns null', () => {
  assert.strictEqual(
    parseMultiwordArg(['--other', 'val'], 'msg'),
    null
  );
});

test('parseMultiwordArg: flag present but no tokens returns null', () => {
  assert.strictEqual(
    parseMultiwordArg(['--msg', '--next'], 'msg'),
    null
  );
});

test('parseMultiwordArg: flag at end of array with no tokens returns null', () => {
  assert.strictEqual(
    parseMultiwordArg(['--msg'], 'msg'),
    null
  );
});

// ---------------------------------------------------------------------------
// parseNamedArgs — strict argv (#3358, ADR-3473 §8.4)
//
// New shape: parseNamedArgs(args, spec) where
//   spec = { valueFlags?: string[], booleanFlags?: string[], positionals: number | 'rest' }
// returning { ok: true, data } | { ok: false, kind: 'InvalidArgs', arg, reason }.
//
// TODAY (measured on this tree): the function ignores this shape entirely —
// its real signature is still (args, valueFlags = [], booleanFlags = []), so
// passing a spec OBJECT as the second positional argument makes
// `for (const flag of valueFlags)` iterate a non-iterable plain object,
// throwing `TypeError: valueFlags is not iterable` before any of these rows
// can even reach their assertions. Every row below therefore fails against
// the current tree — either via that uncaught throw, or (for the two legacy
// rows) because `assert.throws` finds nothing thrown at all.
// ---------------------------------------------------------------------------

describe('parseNamedArgs — strict argv (#3358, ADR-3473 §8.4)', () => {
  test('valueFlagWithValueResolvesOk', () => {
    const result = parseNamedArgs(
      ['state', 'begin-phase', '--phase', '3'],
      { valueFlags: ['phase', 'name', 'plans'], positionals: 2 },
    );
    assert.deepStrictEqual(result, { ok: true, data: { phase: '3', name: null, plans: null } });
  });

  // Corrected after the first full verification run: ADR-3473 §8.4 mandates
  // rejecting *unrecognized* and *positional* tokens — it says nothing about
  // a value flag whose value is missing or flag-shaped. Treating that as an
  // error was an over-implementation (not the ADR's rule) and it broke the
  // long-standing, deliberately-recorded `null` contract exercised by
  // tests/init.test.cjs emptyPrdValueIsFalsyAndTreatedAsAbsent (row B5) and
  // tests/section-manifest-init-facts.test.cjs "flag-shaped value (--prd
  // --weird)". A value flag whose next token is absent or flag-shaped
  // resolves to `null` and is NOT an error; the cursor advances by 1 so the
  // following flag token is validated on its own merits on the next
  // iteration.
  test('valueFlagFollowedByAnotherFlagResolvesToNullNotAnError', () => {
    const result = parseNamedArgs(
      ['state', 'planned-phase', '--phase', '--name', 'x'],
      { valueFlags: ['phase', 'name'], positionals: 2 },
    );
    assert.deepStrictEqual(result, { ok: true, data: { phase: null, name: 'x' } });
  });

  test('unknownFlagIsRejectedAndListsAcceptedFlags', () => {
    const result = parseNamedArgs(
      ['state', 'begin-phase', '--bogus', 'x'],
      { valueFlags: ['phase', 'name'], positionals: 2 },
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'InvalidArgs');
    assert.strictEqual(result.arg, '--bogus');
    assert.match(result.reason, /phase/i, 'reason must name an accepted flag');
    assert.match(result.reason, /name/i, 'reason must name an accepted flag');
  });

  // #3358: the exact call site shape (`state planned-phase 3`, no --phase)
  // that let a stray positional silently drop and overwrite STATE.md's
  // previously-current phase block. See tests/state.test.cjs
  // positionalPlannedPhaseLeavesStateMdUntouched_3358 for the consumer-output
  // identity row this defect is actually observed through.
  test('unexpectedPositionalIsRejected_3358', () => {
    const result = parseNamedArgs(
      ['state', 'planned-phase', '3'],
      { valueFlags: ['phase', 'name', 'plans'], positionals: 2 },
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.arg, '3');
    assert.match(result.reason, /positional/i);
  });

  // Negative space N3: a positional the caller declares (and reads itself
  // via args[2]) must never be flagged as unexpected.
  test('declaredPositionalIsNotFlagged', () => {
    const result = parseNamedArgs(
      ['init', 'execute-phase', '01', '--tdd'],
      { booleanFlags: ['tdd'], positionals: 3 },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.tdd, true);
  });

  // Required boundary triple over a fixed argv: positionals one short of the
  // token's index rejects it; positionals at or past that index accepts it.
  test('positionalBoundaryAtNMinus1_N_NPlus1', () => {
    const argv = ['state', 'complete-phase', '3'];

    const nMinus1 = parseNamedArgs(argv, { valueFlags: ['phase'], positionals: 2 });
    assert.strictEqual(nMinus1.ok, false);
    assert.strictEqual(nMinus1.arg, '3');

    const atN = parseNamedArgs(argv, { valueFlags: ['phase'], positionals: 3 });
    assert.strictEqual(atN.ok, true);

    const nPlus1 = parseNamedArgs(argv, { valueFlags: ['phase'], positionals: 4 });
    assert.strictEqual(nPlus1.ok, true);
  });

  // Negative space N5: a value beginning with a single `-` (a negative
  // number) is not mistaken for a flag. The strict pass must reuse the same
  // `startsWith('--')` predicate the permissive parser already gets right.
  test('negativeNumberValueIsNotTreatedAsFlag', () => {
    const result = parseNamedArgs(
      ['state', 'record-metric', '--plans', '-1'],
      { valueFlags: ['plans'], positionals: 2 },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.plans, '-1');
  });

  // Negative space N6: `init quick <description>` consumes everything after
  // the family/subcommand as free text — undeclared-flag rejection must be
  // disabled for this documented shape, not accidentally re-enabled.
  test('restPositionalsAcceptFreeTextIncludingUnknownFlags', () => {
    const result = parseNamedArgs(
      ['init', 'quick', 'add', 'a', '--dry-run', 'option'],
      { positionals: 'rest' },
    );
    assert.strictEqual(result.ok, true);
  });

  // ADR-3473 Decision 2: both ends of this seam are gsd-core's own source. A
  // stale call site using the legacy 3-positional-argument shape must throw
  // loudly rather than silently destructuring undefined off a Result.
  test('legacyArrayArgumentShapeThrows', () => {
    assert.throws(() => parseNamedArgs(['--a', '1'], ['a']));
  });

  test('missingSpecThrows', () => {
    assert.throws(() => parseNamedArgs(['--a', '1']));
  });

  test('bareDoubleDashIsRejectedNotCrashing', () => {
    const result = parseNamedArgs(
      ['state', 'planned-phase', '--'],
      { valueFlags: ['phase'], positionals: 2 },
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.arg, '--');
  });

  // A hostile positional must be rejected as opaque data — never executed,
  // interpolated, or otherwise treated as anything but a literal string that
  // fails validation and is echoed back verbatim in `arg`.
  test('hostileTokensAreRejectedAsOpaqueData', () => {
    const hostileTokens = [';', '$(id)', 'line1\nline2', 'a b'];
    for (const token of hostileTokens) {
      const result = parseNamedArgs(
        ['state', 'planned-phase', token],
        { valueFlags: ['phase'], positionals: 2 },
      );
      assert.strictEqual(result.ok, false, `hostile token should be rejected: ${JSON.stringify(token)}`);
      assert.strictEqual(result.arg, token);
    }
  });

  // Required fast-check property (parsers get one): for any argv built only
  // from declared flags and their well-formed (non-`--`-prefixed) values,
  // with positionals:0, the result is ok:true and every declared key
  // resolves to exactly the value it was given.
  test('fc: wellFormedArgvAlwaysParsesOk', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.constantFrom('phase', 'name', 'plans', 'summary', 'text'),
          { minLength: 1, maxLength: 5 },
        ).chain((flags) => fc.tuple(
          fc.constant(flags),
          fc.array(
            fc.stringMatching(/^[a-zA-Z0-9_]+$/).filter((s) => s.length > 0),
            { minLength: flags.length, maxLength: flags.length },
          ),
        )),
        ([flags, values]) => {
          const argv = [];
          for (let i = 0; i < flags.length; i++) {
            argv.push(`--${flags[i]}`, values[i]);
          }
          const result = parseNamedArgs(argv, { valueFlags: flags, positionals: 0 });
          assert.strictEqual(result.ok, true);
          for (let i = 0; i < flags.length; i++) {
            assert.strictEqual(result.data[flags[i]], values[i]);
          }
        },
      ),
    );
  });

  // Required fast-check property, negative side: for any argv containing at
  // least one token past the boundary that is neither a declared flag nor a
  // declared flag's value, the result is ok:false.
  test('fc: anyUndeclaredTokenAlwaysRejects', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('phase', 'name', 'plans'),
        fc.stringMatching(/^[a-zA-Z0-9_]+$/).filter((s) => s.length > 0),
        (declaredFlag, undeclaredToken) => {
          const argv = [`--${declaredFlag}`, 'val', undeclaredToken];
          const result = parseNamedArgs(argv, { valueFlags: [declaredFlag], positionals: 0 });
          assert.strictEqual(result.ok, false);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// formatDiagnosticToken (io.cjs) — untrusted-token diagnostic escaping.
//
// Adversarial review finding (isolated review, verified live): a token
// embedded verbatim in a plain-text "Error: <message>" diagnostic can forge
// a second stderr line beginning "Error:" by smuggling its own "\n". Repro
// on this tree BEFORE the fix:
//   $ node gsd-tools.cjs query state.planned-phase "foo\nError: forged second line"
//   Error: unexpected positional argument "foo
//   Error: forged second line"
// These tests spawn the real CLI (the vulnerability is about the literal
// bytes on stderr, not `parseNamedArgs`'s return value) through the exact
// call shape the finding used: `query state.planned-phase <hostile token>`
// hits the "unexpected positional argument" reason string, which embeds the
// token directly. Asserts on the RAW stderr string (not trimmed) — a
// trimmed assertion would hide a leading/trailing forged blank line.
// ---------------------------------------------------------------------------

describe('formatDiagnosticToken escapes untrusted tokens in plain-text diagnostics', () => {
  const HOSTILE_TOKENS = [
    ['embedded newline forging a second Error: line', 'foo\nError: forged second line'],
    ['embedded double quote', 'foo"bar'],
    ['embedded C0 control character', 'foo\x07bar'],
  ];

  for (const [label, token] of HOSTILE_TOKENS) {
    test(`unexpected-positional diagnostic stays single-line for a token with ${label}`, () => {
      const tmpDir = createTempProject();
      try {
        const result = runCli(['query', 'state.planned-phase', token], { cwd: tmpDir, jsonErrors: false });
        assert.notStrictEqual(result.status, 0, 'a rejected positional must exit non-zero');
        const rawStderr = result.stderr;
        const nonEmptyLines = rawStderr.split('\n').filter((l) => l.length > 0);
        assert.strictEqual(
          nonEmptyLines.length, 1,
          `expected exactly one non-empty stderr line, got raw stderr: ${JSON.stringify(rawStderr)}`,
        );
        assert.match(nonEmptyLines[0], /^Error: /);
        const errorPrefixedLineCount = rawStderr.split('\n').filter((l) => l.startsWith('Error:')).length;
        assert.strictEqual(errorPrefixedLineCount, 1, 'the hostile token must not forge a second "Error:" line');
      } finally {
        cleanup(tmpDir);
      }
    });
  }

  // Same repro shape, but through the "unknown flag" reason string (the
  // second of the three sites the finding named) — a hostile token that
  // itself starts with "--" so it is walked as a flag, not a positional.
  test('unknown-flag diagnostic stays single-line for a hostile flag-shaped token', () => {
    const tmpDir = createTempProject();
    try {
      const result = runCli(
        ['query', 'state.planned-phase', '--bogus\nError: forged', 'x'],
        { cwd: tmpDir, jsonErrors: false },
      );
      assert.notStrictEqual(result.status, 0);
      const rawStderr = result.stderr;
      const nonEmptyLines = rawStderr.split('\n').filter((l) => l.length > 0);
      assert.strictEqual(
        nonEmptyLines.length, 1,
        `expected exactly one non-empty stderr line, got raw stderr: ${JSON.stringify(rawStderr)}`,
      );
      assert.match(nonEmptyLines[0], /^Error: unknown flag/);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3431-debug-command-yaml.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3431-debug-command-yaml (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3431)
// Command markdown frontmatter is the deployed contract; this regression test
// verifies the real YAML surface that external parsers consume.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./helpers.cjs');

const DEBUG_COMMAND_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'debug.md');

function readFrontmatter(filePath) {
  return parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
}

test('#3431/#3128: debug command frontmatter preserves the public flag hint', () => {
  const frontmatter = readFrontmatter(DEBUG_COMMAND_PATH);

  assert.equal(frontmatter.name, 'gsd:debug');
  assert.equal(
    frontmatter['argument-hint'],
    '[list | status <slug> | continue <slug>] [--diagnose] [--runtime-probes | --no-runtime-probes] [issue description]',
    'argument-hint should remain user-visible text after YAML parsing'
  );
});
  });
}
