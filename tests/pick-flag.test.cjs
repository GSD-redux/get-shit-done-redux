/**
 * GSD Tools Tests - --pick flag
 *
 * Regression tests for the --pick CLI flag that extracts a single field
 * from JSON output, replacing the need for jq as an external dependency.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { seedPhase } = require('./fixtures/index.cjs');
const { runCli } = require('./helpers/cli-negative.cjs');

// ─── --pick flag ─────────────────────────────────────────────────────────────

describe('--pick flag', () => {
  test('extracts a top-level field from JSON output', () => {
    const result = runGsdTools('generate-slug "hello world" --pick slug');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'hello-world');
  });

  test('extracts a top-level field using array args', () => {
    const result = runGsdTools(['generate-slug', 'hello world', '--pick', 'slug']);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'hello-world');
  });

  // #3365 / ADR-3473 §8.4 P6: an ABSENT field is a failure ("I could not
  // answer"), never a demotion to the empty answer at exit 0. This inverts
  // the old pinned assertion below (kept as a comment for the historical
  // record — measured on this tree, 2026-08-26, exit 0 + empty stdout):
  //   const result = runGsdTools('generate-slug "test" --pick nonexistent');
  //   assert.strictEqual(result.success, true);
  //   assert.strictEqual(result.output, '');
  test('absentFieldExitsNonZero_3365', () => {
    const result = runGsdTools('generate-slug "test" --pick nonexistent');
    assert.strictEqual(result.success, false, 'an absent --pick field must exit non-zero');
    assert.strictEqual(result.output, '');
    assert.match(result.error, /nonexistent/, 'stderr must name the requested field');
  });

  // P2 (test matrix): a count of zero is a real value, not absence — this
  // must keep PASSING before and after the fix (the non-change half of #3365).
  test('zeroCountPrintsZeroAtExitZero', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('query phases.list --type summaries --pick count', tmpDir);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.output, '0');
    } finally {
      cleanup(tmpDir);
    }
  });

  // P4 (test matrix, negative space N1): a field present with an explicit
  // `null` value is an answer, not a failure — must keep PASSING before and
  // after the fix. Measured: `phases.list --type plans --pick phase_dir` on
  // the enumeration path (no --phase given) returns `phase_dir: null`.
  test('presentButNullIsEmptyAtExitZero', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('query phases.list --type plans --pick phase_dir', tmpDir);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.output, '');
    } finally {
      cleanup(tmpDir);
    }
  });

  // P10 (test matrix): required boundary triple over an array field of
  // known length N=3 (three seeded phase directories).
  test('arrayIndexBoundaryAtLenMinus1_Len_LenPlus1', () => {
    const tmpDir = createTempProject();
    try {
      seedPhase(tmpDir, '01-alpha');
      seedPhase(tmpDir, '02-beta');
      seedPhase(tmpDir, '03-gamma');

      const atLenMinus1 = runGsdTools('query phases.list --pick directories[2]', tmpDir);
      assert.strictEqual(atLenMinus1.success, true);
      assert.strictEqual(atLenMinus1.output, '03-gamma');

      const atLen = runGsdTools('query phases.list --pick directories[3]', tmpDir);
      assert.strictEqual(atLen.success, false, 'index == length is out of range and must exit non-zero');

      const atLenPlus1 = runGsdTools('query phases.list --pick directories[4]', tmpDir);
      assert.strictEqual(atLenPlus1.success, false, 'index == length + 1 is out of range and must exit non-zero');
    } finally {
      cleanup(tmpDir);
    }
  });

  // P12 (test matrix): the measured B11 defect — a non-JSON command's
  // `--pick` must never dump the whole document as a coincidental "success".
  // TODAY (measured on this tree, 2026-08-26), against an empty temp project:
  //   $ gsd-tools audit-open --pick nonexistent_field
  //   ### Milestone Close: Open Artifact Audit
  //
  //   All artifact types clear. Safe to proceed.
  //
  //   ---
  //   exit 0
  test('nonJsonOutputDoesNotDumpWholeDocument', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('audit-open --pick nonexistent_field', tmpDir);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.output, '');
    } finally {
      cleanup(tmpDir);
    }
  });

  // P13 (test matrix): `--raw --pick <known field>` withdraws its
  // coincidental "success" — measured today: exit 0, stdout `hello-world`,
  // via the same non-JSON dump `--raw` produces.
  test('rawPlusPickIsRejectedNotCoincidentallyRight', () => {
    const result = runGsdTools(['generate-slug', 'Hello World', '--raw', '--pick', 'slug']);
    assert.strictEqual(result.success, false);
  });

  // P14 (test matrix): the confidently-wrong case — measured today: exit 0,
  // stdout `hello-world` (the SLUG field's value, not the bogus field asked
  // for), via the same non-JSON dump.
  test('rawPlusPickBogusDoesNotEmitAnotherFieldsValue', () => {
    const result = runGsdTools(['generate-slug', 'Hello World', '--raw', '--pick', 'bogus']);
    assert.strictEqual(result.success, false);
    assert.ok(
      !result.output.includes('hello-world'),
      `must not leak another field's value; got: ${JSON.stringify(result.output)}`,
    );
  });

  test('errors when --pick has no value', () => {
    const result = runGsdTools('generate-slug "test" --pick');
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Missing value for --pick/);
  });

  test('errors when --pick value starts with --', () => {
    const result = runGsdTools(['generate-slug', 'test', '--pick', '--raw']);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Missing value for --pick/);
  });

  test('does not collide with frontmatter --field flag', () => {
    // frontmatter subcommand uses --field internally; --pick should not interfere
    const result = runGsdTools('generate-slug "test-value" --pick slug');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'test-value');
  });

  test('works with current-timestamp command', () => {
    const result = runGsdTools('current-timestamp --pick timestamp');
    assert.strictEqual(result.success, true);
    assert.ok(result.output.length > 0, 'timestamp should not be empty');
    assert.match(result.output, /^\d{4}-\d{2}-\d{2}T/);
  });

  // B7 (design 40-design.md; test matrix P7): a dotted path that resolves
  // partway then dies. `count` is a number on `phases.list --type summaries`
  // (a real, always-present field); walking `.missing` off it is not a
  // plain object, so the path dies partway through — the same failure class
  // as B6 (field absent outright), not a crash.
  test('absentDottedPathExitsNonZero', () => {
    const tmpDir = createTempProject();
    try {
      const result = runCli(
        ['query', 'phases.list', '--type', 'summaries', '--pick', 'count.missing'],
        { cwd: tmpDir },
      );
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(result.reason, 'pick_field_absent');
    } finally {
      cleanup(tmpDir);
    }
  });

  // B9 (test matrix P11): bracket syntax applied to a non-array field.
  test('bracketOnNonArrayExitsNonZero', () => {
    const tmpDir = createTempProject();
    try {
      const result = runCli(
        ['query', 'phases.list', '--type', 'summaries', '--pick', 'count[0]'],
        { cwd: tmpDir },
      );
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(result.reason, 'pick_field_absent');
    } finally {
      cleanup(tmpDir);
    }
  });

  // B10 (test matrix): the existing boundary test above only exercises
  // non-negative indices — negative-index normalization
  // (`arr.length + index`) is a separate branch in extractField and was
  // otherwise untested. N=3 seeded phase directories.
  test('negativeArrayIndexInRangeResolves', () => {
    const tmpDir = createTempProject();
    try {
      seedPhase(tmpDir, '01-alpha');
      seedPhase(tmpDir, '02-beta');
      seedPhase(tmpDir, '03-gamma');

      const last = runGsdTools('query phases.list --pick directories[-1]', tmpDir);
      assert.strictEqual(last.success, true);
      assert.strictEqual(last.output, '03-gamma');

      const first = runGsdTools('query phases.list --pick directories[-3]', tmpDir);
      assert.strictEqual(first.success, true);
      assert.strictEqual(first.output, '01-alpha');

      const outOfRange = runGsdTools('query phases.list --pick directories[-4]', tmpDir);
      assert.strictEqual(outOfRange.success, false, 'index == -(N+1) is out of range and must exit non-zero');
    } finally {
      cleanup(tmpDir);
    }
  });

  // B14 (test matrix P15): the JSON root itself is not an object. VERIFIED
  // on this tree: config-get with --default on a missing key emits the bare
  // JSON string "fallback" (not an object), so --pick must fail rather than
  // walk a string as if it had named fields.
  test('nonObjectJsonRootExitsNonZero', () => {
    const tmpDir = createTempProject();
    try {
      const plain = runGsdTools('config-get nonexistent.key --default fallback', tmpDir);
      assert.strictEqual(plain.success, true);
      assert.strictEqual(plain.output, '"fallback"');

      const result = runCli(
        ['config-get', 'nonexistent.key', '--default', 'fallback', '--pick', 'value'],
        { cwd: tmpDir },
      );
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(result.reason, 'pick_field_absent');
      assert.match(result.message, /JSON string, not an object/);
    } finally {
      cleanup(tmpDir);
    }
  });

  // B17 (test matrix P19/P20, negative space N8): io.cjs's output() writes
  // `@file:<path>` instead of inline JSON once the serialized payload
  // exceeds 50000 characters, and `--pick` MUST resolve that redirection
  // BEFORE parsing — otherwise every large result becomes a false
  // pick_output_not_json. The fixture below seeds exactly PHASE_COUNT real
  // phase directories (skipping phase number 999, which phase.cjs's sentinel
  // predicate — SENTINEL_RANGES [0,999] — excludes from the list regardless
  // of padding width, confirmed empirically; skipping it keeps `count`
  // exactly PHASE_COUNT so the assertions below are deterministic) with
  // padded names long enough that the serialized JSON provably exceeds the
  // threshold. The spill is MEASURED, not assumed: the plain (non --pick)
  // path transparently resolves @file: back to inline JSON (#1891), so its
  // stdout length IS the real serialized payload size.
  test('largeAtFilePayloadStillResolves + largeAtFilePayloadAbsentFieldIsAbsentNotNonJson', () => {
    const tmpDir = createTempProject();
    try {
      const PHASE_COUNT = 1200;
      let made = 0;
      for (let i = 1; made < PHASE_COUNT; i++) {
        if (i === 999) continue; // sentinel phase id — excluded from the list, would skew `count`
        seedPhase(tmpDir, `${String(i).padStart(5, '0')}-phase-name-padding-to-make-this-longer`);
        made++;
      }

      const plain = runGsdTools('query phases.list', tmpDir);
      assert.strictEqual(plain.success, true);
      assert.ok(
        plain.output.length > 50000,
        `fixture must exceed the 50000-char @file: spill threshold; measured ${plain.output.length}`,
      );

      // Present field ("largeAtFilePayloadStillResolves"): resolves at exit
      // 0 through the @file: payload.
      const present = runGsdTools('query phases.list --pick count', tmpDir);
      assert.strictEqual(present.success, true);
      assert.strictEqual(present.output, String(PHASE_COUNT));

      // Absent field ("largeAtFilePayloadAbsentFieldIsAbsentNotNonJson"):
      // must be pick_field_absent, NOT pick_output_not_json — proving the
      // @file: resolution ran before the JSON.parse/absence check.
      const absent = runCli(
        ['query', 'phases.list', '--pick', 'nonexistent_field'],
        { cwd: tmpDir },
      );
      assert.notStrictEqual(absent.status, 0);
      assert.strictEqual(absent.reason, 'pick_field_absent');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// formatDiagnosticToken (io.cjs) — untrusted --pick token escaping.
//
// Adversarial review finding (isolated review, verified live): `--pick`'s
// field value reaches the "field not found" / "output was not JSON"
// diagnostics verbatim. Repro on this tree BEFORE the fix:
//   $ node gsd-tools.cjs generate-slug x --pick $'a\nError: forged'
//   Error: --pick a
//   Error: forged: field not found; available top-level keys: slug
// Spawns the real CLI (the vulnerability is about the literal bytes on
// stderr) and asserts on the RAW stderr string — a trimmed assertion would
// hide a leading/trailing forged blank line.
// ---------------------------------------------------------------------------

describe('formatDiagnosticToken escapes untrusted --pick field values', () => {
  const HOSTILE_TOKENS = [
    ['embedded newline forging a second Error: line', 'a\nError: forged'],
    ['embedded double quote', 'a"bogus'],
    ['embedded C0 control character', 'a\x07bogus'],
  ];

  for (const [label, token] of HOSTILE_TOKENS) {
    test(`--pick field-not-found diagnostic stays single-line for a token with ${label}`, () => {
      const tmpDir = createTempProject();
      try {
        const result = runCli(['generate-slug', 'x', '--pick', token], { cwd: tmpDir, jsonErrors: false });
        assert.notStrictEqual(result.status, 0);
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
});

// ---------------------------------------------------------------------------
// formatKeyForDiagnosticList (gsd-tools.cjs) — untrusted frontmatter KEY
// escaping, as distinct from the untrusted --pick TOKEN escaping above.
//
// `frontmatter get <file>` (no --field) reads an arbitrary user-authored
// markdown file and, on a subsequent --pick miss, echoes that document's own
// top-level frontmatter keys straight into the "field not found; available
// top-level keys: ..." diagnostic. A key is therefore untrusted input from a
// user document in exactly the way a --pick argv token is untrusted input
// from the shell — formatKeyForDiagnosticList (gsd-tools.cjs) exists to
// neutralize it the same way formatDiagnosticToken neutralizes the token.
//
// Reachable + verified live on this tree, e.g. for a frontmatter key
// containing a real embedded newline:
//   $ printf '---\n"weird\\nkey": v\nplain: y\n---\n\nbody\n' > f.md
//   $ gsd-tools frontmatter get f.md --pick absent_field
//   Error: --pick "absent_field": field not found; available top-level keys: weird\nkey, plain
// The `\n` in that stderr is the two-character ESCAPED sequence backslash-n,
// not a real newline — the raw/untrimmed stderr assertions below pin that.
// ---------------------------------------------------------------------------

describe('formatKeyForDiagnosticList escapes untrusted frontmatter keys', () => {
  test('hostileFrontmatterKeyCannotForgeASecondErrorLine', () => {
    const HOSTILE_KEY_FIXTURES = [
      ['embedded newline', '---\n"weird\\nkey": v\nplain: y\n---\n\nbody\n', 'weird\\nkey'],
      ['embedded double quote', '---\n"weird\\"quotekey": v\nplain: y\n---\n\nbody\n', 'weird\\"quotekey'],
      ['embedded C0 control character', '---\n"weird\\u0007ctrlkey": v\nplain: y\n---\n\nbody\n', 'weird\\u0007ctrlkey'],
    ];

    for (const [label, frontmatterSource, expectedEscapedKey] of HOSTILE_KEY_FIXTURES) {
      const tmpDir = createTempProject();
      try {
        const f = path.join(tmpDir, 'weird.md');
        fs.writeFileSync(f, frontmatterSource);

        const result = runCli(
          ['frontmatter', 'get', f, '--pick', 'absent_field'],
          { cwd: tmpDir, jsonErrors: false },
        );
        assert.notStrictEqual(result.status, 0, `[${label}] must exit non-zero`);

        const rawStderr = result.stderr;
        // Split on the raw, UNTRIMMED stderr and drop exactly one trailing
        // empty element (the newline error() always terminates its message
        // with) — a hostile key that forged a second line would leave MORE
        // than one element after that single drop.
        const lines = rawStderr.split('\n');
        assert.strictEqual(
          lines[lines.length - 1], '',
          `[${label}] expected a single trailing empty element from the terminating newline, got raw stderr: ${JSON.stringify(rawStderr)}`,
        );
        const linesWithoutTrailingEmpty = lines.slice(0, -1);
        assert.strictEqual(
          linesWithoutTrailingEmpty.length, 1,
          `[${label}] expected exactly one line after dropping the trailing empty element, got raw stderr: ${JSON.stringify(rawStderr)}`,
        );
        const errorPrefixedLineCount = linesWithoutTrailingEmpty.filter((l) => l.startsWith('Error:')).length;
        assert.strictEqual(errorPrefixedLineCount, 1, `[${label}] the hostile key must not forge a second "Error:" line`);

        // The diagnostic must stay USEFUL, not merely safe: a "fix" that
        // dropped the offending key entirely would also pass the one-line
        // assertions above, so pin that the escaped key is still present.
        assert.ok(
          linesWithoutTrailingEmpty[0].includes(`available top-level keys: ${expectedEscapedKey}, plain`),
          `[${label}] expected the escaped key to still name the offending key, got: ${JSON.stringify(linesWithoutTrailingEmpty[0])}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    }
  });

  // Negative-space control: an ORDINARY frontmatter document (no hostile
  // bytes in any key) must still produce a plain, readable, unquoted key
  // list — proving the escape does not turn every normal diagnostic into
  // JSON-quoted noise.
  test('ordinaryFrontmatterKeysStayPlainAndUnquotedInDiagnostic', () => {
    const tmpDir = createTempProject();
    try {
      const f = path.join(tmpDir, 'plain.md');
      fs.writeFileSync(f, '---\nalpha: v\nbeta: y\n---\n\nbody\n');

      const result = runCli(
        ['frontmatter', 'get', f, '--pick', 'absent_field'],
        { cwd: tmpDir, jsonErrors: false },
      );
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /available top-level keys: alpha, beta\n$/);
      // Only the KEY LIST must stay unquoted — `--pick "absent_field"` earlier
      // in the same message is legitimately JSON-quoted by formatDiagnosticToken
      // (a separate escape, for the untrusted argv token, not the frontmatter
      // key), so scope the "no JSON-quoting noise" assertion to the key-list
      // segment rather than the whole stderr string.
      const keyListSegment = result.stderr.slice(result.stderr.indexOf('available top-level keys:'));
      assert.ok(!keyListSegment.includes('"'), `ordinary keys must not be JSON-quoted, got: ${JSON.stringify(keyListSegment)}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});
