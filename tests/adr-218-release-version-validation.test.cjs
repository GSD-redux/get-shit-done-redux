'use strict';

/**
 * ADR-218 regression guard: release-workflow version validation.
 *
 * (A) Behavioral regex coverage — extracts the actual leading-zero-rejection
 *     regex strings from .github/workflows/release.yml at test time, compiles
 *     them as RegExp, and asserts boundary behavior. If someone weakens the
 *     regex (e.g. back to [0-9]+), these assertions go RED.
 *
 * (B) Structural wiring assertions — confirms the validate-version job exists,
 *     the npm duplicate-version pre-check step is present, and that all
 *     downstream publish/create jobs declare `needs: validate-version`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = process.env.ADR218_WORKFLOW_PATH
  || path.join(__dirname, '..', '.github', 'workflows', 'release.yml');

function loadWorkflow() {
  assert.ok(
    fs.existsSync(WORKFLOW_PATH),
    `release.yml not found at ${WORKFLOW_PATH} — file moved or deleted?`
  );
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

/**
 * Extract all grep -qE '...' or grep -qE "..." patterns from a bash block.
 * Returns an array of raw regex strings (the content inside the quotes).
 */
function extractGrepPatterns(text) {
  // Match: grep -qE '...' or grep -qE "..."
  const re = /grep\s+-qE\s+(?:'([^']+)'|"([^"]+)")/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return found;
}

/**
 * Parse the `needs:` list of a GitHub Actions job.
 *
 * @param {string} src    - Full YAML source text.
 * @param {number} jobIdx - Index of the '\n  <job-name>:\n' match in src.
 * @returns {string[] | null} Array of job-name strings listed under `needs:`,
 *                            or null if no `needs:` key was found for the job.
 *
 * Strategy: slice from jobIdx to the next top-level (two-space-indented) job
 * header, then scan that segment for the `needs:` key.  The key accepts two
 * YAML forms:
 *   needs: validate-version                    (scalar)
 *   needs: [validate-version, install-smoke]   (flow sequence)
 *   needs:                                     (block sequence)
 *     - validate-version
 *     - install-smoke
 *
 * This deliberately only inspects the `needs:` line and its immediate list
 * items — it will NOT match "validate-version" appearing later in a step
 * expression such as `${{ needs.validate-version.outputs.branch }}`.
 */
function parseJobNeeds(src, jobIdx) {
  // Isolate the job's YAML block: from the job header to the next top-level
  // job (same two-space indentation) or end of file.
  const rest = src.slice(jobIdx + 1); // skip the leading newline of the match
  // Next top-level job starts with "\n  <word>:\n" at column 2
  const nextJobMatch = rest.match(/\n {2}[a-z][a-z0-9_-]*:\n/);
  const segment = nextJobMatch
    ? rest.slice(0, rest.indexOf(nextJobMatch[0]) + 1)
    : rest;

  // Match the `needs:` line within the segment
  const needsLineMatch = segment.match(/^ {4}needs:\s*(.*)$/m);
  if (!needsLineMatch) return null;

  const inline = needsLineMatch[1].trim();

  if (inline === '') {
    // Block sequence form: lines following `needs:` at deeper indent
    //   needs:
    //     - job-one
    //     - job-two
    const blockItems = [];
    const blockRe = /^ {6}- ([a-z][a-z0-9_-]*)$/gm;
    // Only scan text after the `needs:` line
    const afterNeeds = segment.slice(needsLineMatch.index + needsLineMatch[0].length);
    let bm;
    while ((bm = blockRe.exec(afterNeeds)) !== null) {
      blockItems.push(bm[1]);
    }
    return blockItems.length > 0 ? blockItems : null;
  }

  if (inline.startsWith('[')) {
    // Flow sequence form: needs: [job-one, job-two]
    const inner = inline.replace(/^\[|\]$/g, '');
    return inner.split(',').map(s => s.trim()).filter(Boolean);
  }

  // Scalar form: needs: single-job
  return [inline];
}

// ---------------------------------------------------------------------------
// (A) Behavioral regex tests
// ---------------------------------------------------------------------------

describe('ADR-218 — leading-zero rejection regex (behavioral)', () => {

  test('release.yml contains at least two leading-zero-aware grep patterns', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);
    assert.ok(
      patterns.length >= 2,
      `Expected at least 2 grep -qE patterns in release.yml, found ${patterns.length}: ${JSON.stringify(patterns)}`
    );
  });

  test('minor/major pattern (X.Y.0) rejects leading zeros and accepts valid versions', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);

    // The minor/major pattern must match X.Y.0 (not hotfix) and must be the
    // one that guards the release branch decision. We identify it as the first
    // pattern that matches `1.0.0` AND `0.1.0` AND `10.20.0`.
    const minorMajorPatterns = patterns.filter(p => {
      const re = new RegExp(p);
      return re.test('1.0.0') && re.test('0.1.0') && re.test('10.20.0');
    });

    assert.ok(
      minorMajorPatterns.length >= 1,
      `Could not locate the minor/major (X.Y.0) grep pattern in release.yml.\n` +
      `Extracted patterns: ${JSON.stringify(patterns)}\n` +
      `If the pattern was relocated or renamed, update this test to match.`
    );

    // Pattern extracted verbatim from release.yml at test time — the shipped
    // grep pattern IS the product under test; escaping it would assert a
    // different string than what actually ships (#3951).
    const re = new RegExp(minorMajorPatterns[0]); // allow-adhoc-regex-escape: runtime-contract-is-the-product

    // Boundary table: REJECTED (leading zeros or malformed)
    const shouldReject = [
      '1.01.0',   // leading zero in minor
      '01.0.0',   // leading zero in major
      '1.1.01',   // leading zero in patch (also not X.Y.0 form)
      '00.0.0',   // double leading zero in major
      '1.00.0',   // double leading zero in minor
    ];
    for (const v of shouldReject) {
      assert.equal(
        re.test(v), false,
        `Version "${v}" should be REJECTED by the minor/major pattern but was accepted.\n` +
        `Pattern: ${minorMajorPatterns[0]}\n` +
        `This is the ADR-218 leading-zero regression. Restore (0|[1-9][0-9]*) grouping.`
      );
    }

    // Boundary table: ACCEPTED (valid semver, no leading zeros)
    const shouldAccept = [
      '1.0.0',
      '0.1.0',
      '10.20.0',
      '1.2.0',
      '0.0.0',
    ];
    for (const v of shouldAccept) {
      assert.equal(
        re.test(v), true,
        `Version "${v}" should be ACCEPTED by the minor/major pattern but was rejected.\n` +
        `Pattern: ${minorMajorPatterns[0]}`
      );
    }
  });

  test('major-only sub-check (X.0.0) correctly classifies major releases', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);

    // The major-only pattern matches X.0.0 exactly (not X.Y.0 with Y>0).
    // We identify it as the pattern that matches `1.0.0` but NOT `1.1.0`.
    const majorOnlyPatterns = patterns.filter(p => {
      const re = new RegExp(p);
      return re.test('1.0.0') && !re.test('1.1.0');
    });

    assert.ok(
      majorOnlyPatterns.length >= 1,
      `Could not locate the major-only (X.0.0) grep pattern in release.yml.\n` +
      `Extracted patterns: ${JSON.stringify(patterns)}\n` +
      `ADR-218 requires IS_MAJOR detection to also forbid leading zeros.`
    );

    // Pattern extracted verbatim from release.yml — the shipped grep pattern
    // IS the product under test (#3951).
    const re = new RegExp(majorOnlyPatterns[0]); // allow-adhoc-regex-escape: runtime-contract-is-the-product

    // REJECTED: leading zeros in the major segment
    const shouldReject = [
      '01.0.0',   // leading zero in major
      '00.0.0',   // double leading zero
    ];
    for (const v of shouldReject) {
      assert.equal(
        re.test(v), false,
        `Version "${v}" should be REJECTED by the major-only pattern but was accepted.\n` +
        `Pattern: ${majorOnlyPatterns[0]}\n` +
        `ADR-218: IS_MAJOR check must also use (0|[1-9][0-9]*) grouping.`
      );
    }

    // ACCEPTED: valid major versions
    const shouldAccept = [
      '1.0.0',
      '10.0.0',
      '0.0.0',
    ];
    for (const v of shouldAccept) {
      assert.equal(
        re.test(v), true,
        `Version "${v}" should be ACCEPTED by the major-only pattern but was rejected.\n` +
        `Pattern: ${majorOnlyPatterns[0]}`
      );
    }
  });

  test('hotfix pattern (X.Y.Z, Z>0) is present and uses digit anchors', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);

    // The hotfix pattern matches X.Y.Z where Z > 0, e.g. `1.2.3`.
    // Identify it as the pattern matching `1.2.3` but NOT `1.2.0`.
    const hotfixPatterns = patterns.filter(p => {
      const re = new RegExp(p);
      return re.test('1.2.3') && !re.test('1.2.0');
    });

    assert.ok(
      hotfixPatterns.length >= 1,
      `Could not locate the hotfix (X.Y.Z, Z>0) grep pattern in release.yml.\n` +
      `Extracted patterns: ${JSON.stringify(patterns)}\n` +
      `Expected a pattern matching 1.2.3 but not 1.2.0.`
    );

    // Pattern extracted verbatim from release.yml — the shipped grep pattern
    // IS the product under test (#3951).
    const re = new RegExp(hotfixPatterns[0]); // allow-adhoc-regex-escape: runtime-contract-is-the-product

    // Sanity: valid hotfix versions accepted
    assert.equal(re.test('1.2.3'), true,  'Hotfix pattern must accept 1.2.3');
    assert.equal(re.test('1.0.1'), true,  'Hotfix pattern must accept 1.0.1');
    assert.equal(re.test('10.20.30'), true, 'Hotfix pattern must accept 10.20.30');

    // Patch = 0 must be rejected (that is the minor/major form)
    assert.equal(re.test('1.2.0'), false, 'Hotfix pattern must not match X.Y.0 (Z must be >0)');

    // ADR-218 / #1186: hotfix pattern must also reject leading zeros on major
    // and minor segments.  The old `[0-9]+` form allowed e.g. `01.2.3` and
    // `1.02.3`.  The corrected pattern uses `(0|[1-9][0-9]*)` for both.
    const shouldRejectLeadingZero = [
      '01.2.3',   // leading zero in major
      '1.02.3',   // leading zero in minor
    ];
    for (const v of shouldRejectLeadingZero) {
      assert.equal(
        re.test(v), false,
        `Hotfix version "${v}" should be REJECTED (leading zero) but was accepted.\n` +
        `Pattern: ${hotfixPatterns[0]}\n` +
        `ADR-218 / #1186: restore (0|[1-9][0-9]*) on major and minor segments.`
      );
    }
  });

  test('extracted patterns use strict leading-zero guard, not the old [0-9]+ form', () => {
    const src = loadWorkflow();
    const patterns = extractGrepPatterns(src);

    // ADR-218 Decision #1: the X.Y.0 (minor/major) pattern and the X.0.0
    // (major-only) pattern MUST guard their major and minor segments with
    // (0|[1-9][0-9]*), not the old bare [0-9]+ form.
    //
    // The hotfix pattern contains "[1-9][0-9]*" for its PATCH segment, so
    // testing .some(p => p.includes('[1-9][0-9]*')) would still pass even if
    // the major/minor patterns were weakened back to [0-9]+.  We therefore
    // assert specifically against the patterns that guard major/minor segments.

    // Identify the minor/major pattern: matches X.Y.0 (both 1.0.0 and 1.1.0)
    const minorMajorPatterns = patterns.filter(p => {
      const re = new RegExp(p);
      return re.test('1.0.0') && re.test('1.1.0') && re.test('10.20.0');
    });

    assert.ok(
      minorMajorPatterns.length >= 1,
      `Could not locate the minor/major (X.Y.0) grep pattern in release.yml.\n` +
      `Extracted patterns: ${JSON.stringify(patterns)}`
    );

    // The minor/major pattern must contain (0|[1-9][0-9]*) to guard BOTH the
    // major AND minor segments.  A pattern that uses [0-9]+ on those segments
    // would allow "01.0.0" or "1.01.0" — the ADR-218 regression.
    assert.ok(
      minorMajorPatterns[0].includes('(0|[1-9][0-9]*)'),
      `The minor/major (X.Y.0) grep pattern does NOT contain the strict ` +
      `"(0|[1-9][0-9]*)" guard required by ADR-218 Decision #1.\n` +
      `Pattern found: ${minorMajorPatterns[0]}\n` +
      `This is the leading-zero regression. Restore (0|[1-9][0-9]*) grouping ` +
      `on every major/minor segment.`
    );

    // Identify the major-only pattern: matches X.0.0 but NOT X.Y.0 with Y>0
    const majorOnlyPatterns = patterns.filter(p => {
      const re = new RegExp(p);
      return re.test('1.0.0') && !re.test('1.1.0');
    });

    assert.ok(
      majorOnlyPatterns.length >= 1,
      `Could not locate the major-only (X.0.0) grep pattern in release.yml.\n` +
      `Extracted patterns: ${JSON.stringify(patterns)}`
    );

    // The major-only pattern must also contain (0|[1-9][0-9]*) to guard the
    // major segment.
    assert.ok(
      majorOnlyPatterns[0].includes('(0|[1-9][0-9]*)'),
      `The major-only (X.0.0) grep pattern does NOT contain the strict ` +
      `"(0|[1-9][0-9]*)" guard required by ADR-218 Decision #1.\n` +
      `Pattern found: ${majorOnlyPatterns[0]}\n` +
      `ADR-218: IS_MAJOR check must also use (0|[1-9][0-9]*) grouping.`
    );
  });
});

// ---------------------------------------------------------------------------
// (B) Structural / wiring assertions
// ---------------------------------------------------------------------------

describe('ADR-218 — structural wiring of release.yml', () => {

  test('validate-version job exists in release.yml', () => {
    const src = loadWorkflow();
    assert.ok(
      src.includes('validate-version:'),
      'release.yml must define a `validate-version:` job (ADR-218 requires it as the gate)'
    );
  });

  test('npm duplicate-version pre-check step is present', () => {
    const src = loadWorkflow();
    // Assert both the "Reject already-published versions" step name and
    // the npm view command exist in the file.
    assert.ok(
      src.includes('Reject already-published versions'),
      'release.yml must contain a step named "Reject already-published versions" (ADR-218 Decision #2)'
    );
    assert.ok(
      src.includes('npm view'),
      'release.yml must contain an `npm view` call for duplicate-version pre-check (ADR-218 Decision #2)'
    );
  });

  test('npm duplicate-check step appears AFTER format validation step within validate-version job', () => {
    const src = loadWorkflow();

    const formatIdx = src.indexOf('Validate version format');
    const dupCheckIdx = src.indexOf('Reject already-published versions');

    assert.ok(
      formatIdx !== -1,
      'Could not find "Validate version format" step in release.yml'
    );
    assert.ok(
      dupCheckIdx !== -1,
      'Could not find "Reject already-published versions" step in release.yml'
    );
    assert.ok(
      dupCheckIdx > formatIdx,
      `"Reject already-published versions" (offset ${dupCheckIdx}) must appear AFTER ` +
      `"Validate version format" (offset ${formatIdx}) in release.yml.\n` +
      `Format validation must gate before the npm pre-check.`
    );
  });

  test('create job declares needs: validate-version', () => {
    const src = loadWorkflow();
    // Check that between "create:" and the next top-level job, "needs: validate-version" appears.
    const createJobIdx = src.indexOf('\n  create:\n');
    assert.ok(createJobIdx !== -1, 'release.yml must have a `create:` job');

    // Find the segment from create: to the next job header
    const afterCreate = src.slice(createJobIdx);
    const nextJobMatch = afterCreate.match(/\n {2}[a-z][a-z-]+:\n/g);
    const createSegment = nextJobMatch && nextJobMatch.length > 1
      ? afterCreate.slice(0, afterCreate.indexOf(nextJobMatch[1]))
      : afterCreate;

    assert.ok(
      createSegment.includes('needs: validate-version') || createSegment.includes('needs: [validate-version'),
      'The `create` job must declare `needs: validate-version` to ensure validation runs first (ADR-218)'
    );
  });

  test('rc job declares needs including validate-version', () => {
    const src = loadWorkflow();
    const rcJobIdx = src.indexOf('\n  rc:\n');
    assert.ok(rcJobIdx !== -1, 'release.yml must have an `rc:` job');

    // Parse the `needs:` list from the rc job header region.  We look for the
    // `needs:` key in the lines immediately following the job header, stopping
    // at the first non-indented (top-level) keyword.  This avoids false passes
    // where "validate-version" only appears inside a step expression such as
    // `${{ needs.validate-version.outputs.branch }}` but is absent from the
    // actual `needs:` dependency declaration.
    const needsList = parseJobNeeds(src, rcJobIdx);
    assert.ok(
      needsList !== null,
      'Could not locate a `needs:` declaration in the `rc` job of release.yml'
    );
    assert.ok(
      needsList.includes('validate-version'),
      `The \`rc\` job must list validate-version as a member of its \`needs:\` ` +
      `(ADR-218 gate must run before rc).\n` +
      `Parsed needs list: ${JSON.stringify(needsList)}`
    );
  });

  test('finalize job declares needs including validate-version', () => {
    const src = loadWorkflow();
    const finalizeIdx = src.indexOf('\n  finalize:\n');
    assert.ok(finalizeIdx !== -1, 'release.yml must have a `finalize:` job');

    // Same targeted parse as the rc test above.
    const needsList = parseJobNeeds(src, finalizeIdx);
    assert.ok(
      needsList !== null,
      'Could not locate a `needs:` declaration in the `finalize` job of release.yml'
    );
    assert.ok(
      needsList.includes('validate-version'),
      `The \`finalize\` job must list validate-version as a member of its \`needs:\` ` +
      `(ADR-218 gate must run before finalize).\n` +
      `Parsed needs list: ${JSON.stringify(needsList)}`
    );
  });

  test('validate-version job appears before create/rc/finalize jobs in file', () => {
    const src = loadWorkflow();

    const validateIdx  = src.indexOf('\n  validate-version:\n');
    const createIdx    = src.indexOf('\n  create:\n');
    const rcIdx        = src.indexOf('\n  rc:\n');
    const finalizeIdx  = src.indexOf('\n  finalize:\n');

    assert.ok(validateIdx !== -1, 'validate-version job must be defined');

    if (createIdx !== -1) {
      assert.ok(
        validateIdx < createIdx,
        'validate-version must be declared before the create job in release.yml'
      );
    }
    if (rcIdx !== -1) {
      assert.ok(
        validateIdx < rcIdx,
        'validate-version must be declared before the rc job in release.yml'
      );
    }
    if (finalizeIdx !== -1) {
      assert.ok(
        validateIdx < finalizeIdx,
        'validate-version must be declared before the finalize job in release.yml'
      );
    }
  });
});
