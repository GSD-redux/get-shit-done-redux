'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'changeset', 'cli.cjs');
const { parseChangelog } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));

let tmp;

function writeFragment(name, type, pr, body) {
  fs.mkdirSync(path.join(tmp, '.changeset'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.changeset', `${name}.md`),
    `---\ntype: ${type}\npr: ${pr}\n---\n${body}\n`,
  );
}

function runRender(args = []) {
  const r = runNode(
    [SCRIPT, 'render', '--repo', tmp, ...args, '--json'],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  return {
    status: r.exitCode,
    report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
    stderr: r.stderr || '',
  };
}

function runRenderRaw(args = []) {
  const r = runNode([SCRIPT, 'render', '--repo', tmp, ...args], { timeoutMs: PROBE_TIMEOUT_MS });
  return toLegacyResult(r);
}

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-changeset-')); });
after(() => { cleanup(tmp); });

// Fixtures for extract tests (#3496)
// Written as arrays to avoid template-literal indentation injecting
// leading spaces that would break the ^## regex anchor.
const EXTRACT_CHANGELOG = [
  '# Changelog',
  '',
  '## [1.5.15] - 2026-01-20',
  '',
  '### Added',
  '',
  '- Feature X. (#200)',
  '',
  '## [1.5.14] - 2026-01-18',
  '',
  '### Fixed',
  '',
  '- Single-line fix. (#101)',
  '- **Multi-line fix** — first line of a long',
  '  description that spans two lines. (#102)',
  '',
  '## [1.5.13] - 2026-01-15',
  '',
  '### Fixed',
  '',
  '- Old fix. (#100)',
  '',
  '## [1.5.10] - 2026-01-01',
  '',
  '### Fixed',
  '',
  '- Very old fix. (#50)',
].join('\n');

function runExtract(args = [], changelogText = null) {
  const changelogFile = path.join(tmp, 'CHANGELOG-extract-test.md');
  if (changelogText !== null) {
    fs.writeFileSync(changelogFile, changelogText);
  }
  const r = runNode(
    [SCRIPT, 'extract', '--changelog', changelogFile, ...args],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  // Composes toLegacyResult with the site-specific parsed-JSON `json` field
  // rather than folding it into the shared helper — see git-fixture.cjs's
  // toLegacyResult JSDoc.
  return {
    ...toLegacyResult(r),
    json: (() => {
      try { return JSON.parse(r.stdout); } catch { return null; }
    })(),
  };
}

describe('changeset cli extract: version-range changelog extraction (#3496)', () => {
  test('exits 2 with no output when no versions fall in range', (_t) => {
    const r = runExtract(['--from', '1.5.15', '--to', '1.5.15', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 2, `expected exit 2 for empty range, stderr=${r.stderr}`);
    // F11: assert JSON structure is present and releases is empty array
    assert.ok(r.json, 'stdout must be valid JSON even on exit 2');
    assert.strictEqual(r.json.releases.length, 0, 'releases must be empty array on exit 2');
  });

  test('extracts versions strictly after from and up to and including to', (_t) => {
    const r = runExtract(['--from', '1.5.13', '--to', '1.5.15', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON');
    const versions = r.json.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.5.15'), '1.5.15 must be in range (inclusive to)');
    assert.ok(versions.includes('1.5.14'), '1.5.14 must be in range (between from and to)');
    assert.ok(!versions.includes('1.5.13'), '1.5.13 must NOT be in range (exclusive from)');
    assert.ok(!versions.includes('1.5.10'), '1.5.10 must NOT be in range (below from)');
  });

  test('accepts v-prefixed version arguments', (_t) => {
    const r = runExtract(['--from', 'v1.5.13', '--to', 'v1.5.15', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON');
    const versions = r.json.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.5.15'));
    assert.ok(versions.includes('1.5.14'));
    assert.ok(!versions.includes('1.5.13'));
  });

  test('captures multi-line bullets in extracted range', (_t) => {
    const r = runExtract(['--from', '1.5.13', '--to', '1.5.14', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const release = r.json.releases.find((rel) => rel.version === '1.5.14');
    assert.ok(release, '1.5.14 must be in result');
    const prs = release.sections.flatMap((s) => s.bullets.map((b) => b.pr));
    assert.ok(prs.includes(101), 'single-line bullet pr=101 must be captured');
    assert.ok(prs.includes(102), 'multi-line bullet pr=102 must be captured');
  });

  test('emits markdown text (non-JSON) when --json is not passed', (_t) => {
    // Without --json the output is human-readable markdown, not JSON.
    // Assert on structural facts derivable from the text: exactly the two
    // matched releases appear as ## headers, using parseChangelog so we
    // assert on version strings via the production parser rather than
    // raw substring matches.
    const { parseChangelog: _pc } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));
    const r = runExtract(['--from', '1.5.13', '--to', '1.5.15'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.stdout.trim().length > 0, 'stdout must be non-empty');
    const parsed = _pc(r.stdout);
    const versions = parsed.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.5.15'), '1.5.15 in markdown output');
    assert.ok(versions.includes('1.5.14'), '1.5.14 in markdown output');
    assert.ok(!versions.includes('1.5.13'), '1.5.13 must not appear in output (excluded by --from)');
  });

  test('missing --from or --to emits usage and exits non-zero', (_t) => {
    const r = runExtract(['--from', '1.0.0'], EXTRACT_CHANGELOG);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.length > 0 || r.stdout.length > 0, 'must emit usage text');
  });

  test('rejects malformed --from semver (non-numeric component) with exit 1', (_t) => {
    const r = runExtract(['--from', '1.41.x', '--to', '1.5.15', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 1, `expected exit 1 for malformed --from, stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON on error');
    assert.ok(typeof r.json.error === 'string', 'error field must be present');
    assert.ok(r.json.error.includes('--from'), 'error must mention --from');
  });

  test('rejects malformed --to semver (alphabetic) with exit 1', (_t) => {
    const r = runExtract(['--from', '1.5.13', '--to', 'foo', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 1, `expected exit 1 for malformed --to, stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON on error');
    assert.ok(typeof r.json.error === 'string', 'error field must be present');
    assert.ok(r.json.error.includes('--to'), 'error must mention --to');
  });

  test('preserves bullets without PR trailer in extracted output', (_t) => {
    // Fixture with one no-PR bullet and one PR bullet.
    const CHANGELOG_NO_PR = [
      '# Changelog',
      '',
      '## [2.0.0] - 2026-01-01',
      '',
      '### Fixed',
      '',
      '- Documented fix without PR reference.',
      '- Fix with PR reference. (#999)',
    ].join('\n');
    const r = runExtract(['--from', '1.9.9', '--to', '2.0.0', '--json'], CHANGELOG_NO_PR);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON');
    const section = r.json.releases[0].sections[0];
    assert.equal(section.bullets.length, 2, 'both bullets (with and without PR) must be captured');
    const noPrBullet = section.bullets.find((b) => b.pr === null);
    assert.ok(noPrBullet, 'bullet without PR trailer must be present with pr: null');
    assert.ok(noPrBullet.body.includes('Documented fix'), 'body text preserved');
    const prBullet = section.bullets.find((b) => b.pr === 999);
    assert.ok(prBullet, 'bullet with PR trailer must still be captured');
  });

  // F2: pre-release entries must be excluded from range queries
  test('F2: pre-release entry 1.0.0-rc.1 is excluded from range --from 0.9.9 --to 1.0.0', (_t) => {
    const CHANGELOG_WITH_PRERELEASE = [
      '# Changelog',
      '',
      '## [1.0.0] - 2026-03-01',
      '',
      '### Added',
      '',
      '- Stable release. (#10)',
      '',
      '## [1.0.0-rc.1] - 2026-02-28',
      '',
      '### Added',
      '',
      '- Release candidate. (#9)',
      '',
      '## [0.9.9] - 2026-02-01',
      '',
      '### Fixed',
      '',
      '- Prior fix. (#8)',
    ].join('\n');
    const r = runExtract(['--from', '0.9.9', '--to', '1.0.0', '--json'], CHANGELOG_WITH_PRERELEASE);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON');
    const versions = r.json.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.0.0'), '1.0.0 must be in range');
    assert.ok(!versions.includes('1.0.0-rc.1'), '1.0.0-rc.1 (pre-release) must be excluded from range');
    assert.ok(!versions.includes('0.9.9'), '0.9.9 must not be in range (exclusive from)');
  });

  // F3: linked-header format ## [1.42.1](url) - date must parse date correctly
  test('F3: linked-header ## [1.42.1](url) - date parses date correctly', (_t) => {
    const CHANGELOG_LINKED = [
      '# Changelog',
      '',
      '## [1.42.1](https://github.com/example/repo/releases/tag/v1.42.1) - 2026-05-15',
      '',
      '### Fixed',
      '',
      '- Linked header fix. (#300)',
      '',
      '## [1.42.0](https://github.com/example/repo/releases/tag/v1.42.0) - 2026-05-10',
      '',
      '### Added',
      '',
      '- Linked header feature. (#299)',
    ].join('\n');
    const { parseChangelog: _pc } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));
    const parsed = _pc(CHANGELOG_LINKED);
    const r1421 = parsed.releases.find((r) => r.version === '1.42.1');
    assert.ok(r1421, '1.42.1 must parse from linked header');
    assert.equal(r1421.date, '2026-05-15', 'date must be extracted from linked header');
    const r1420 = parsed.releases.find((r) => r.version === '1.42.0');
    assert.ok(r1420, '1.42.0 must parse from linked header');
    assert.equal(r1420.date, '2026-05-10', 'date must be extracted from linked header');
  });

  // F4: nested bullets must remain as separate bullets, not fold into parent
  test('F4: nested bullets are not folded into parent bullet', (_t) => {
    const CHANGELOG_NESTED = [
      '# Changelog',
      '',
      '## [3.0.0] - 2026-06-01',
      '',
      '### Changed',
      '',
      '- Parent bullet. (#400)',
      '  - Nested child item.',
      '- Second top-level bullet. (#401)',
    ].join('\n');
    const { parseChangelog: _pc } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));
    const parsed = _pc(CHANGELOG_NESTED);
    const rel = parsed.releases.find((r) => r.version === '3.0.0');
    assert.ok(rel, '3.0.0 must parse');
    const section = rel.sections[0];
    // The nested bullet terminates the parent; second top-level bullet is separate.
    // We must have both PR 400 and PR 401 as distinct bullets.
    const prs = section.bullets.map((b) => b.pr);
    assert.ok(prs.includes(400), 'parent bullet pr=400 must be captured');
    assert.ok(prs.includes(401), 'second top-level bullet pr=401 must be captured');
    // The nested child must NOT have been folded into parent body
    const parentBullet = section.bullets.find((b) => b.pr === 400);
    assert.ok(!parentBullet.body.includes('Nested child'), 'nested child must not be folded into parent body');
  });

  // F5+F6: 4-part headers and v-prefix in-file headers
  test('F5+F6: 4-part version in CHANGELOG is skipped, v-prefixed version parses without v', (_t) => {
    const CHANGELOG_EDGE = [
      '# Changelog',
      '',
      '## [v1.0.0] - 2026-04-01',
      '',
      '### Fixed',
      '',
      '- v-prefixed header fix. (#500)',
      '',
      '## [1.0.0.1] - 2026-03-15',
      '',
      '### Fixed',
      '',
      '- 4-part version fix. (#501)',
      '',
      '## [0.9.9] - 2026-03-01',
      '',
      '### Fixed',
      '',
      '- Old fix. (#499)',
    ].join('\n');
    const { parseChangelog: _pc } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));
    const parsed = _pc(CHANGELOG_EDGE);

    // F6: v-prefixed version should be stored without the leading v
    const v100 = parsed.releases.find((r) => r.version === '1.0.0');
    assert.ok(v100, 'v-prefixed header must parse as version 1.0.0 (v stripped)');

    // Confirm extract skips 1.0.0.1 (4-part) — it appears in parsed but won't
    // satisfy SEMVER_RE inside the range filter
    const r = runExtract(['--from', '0.9.9', '--to', '1.0.0', '--json'], CHANGELOG_EDGE);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const versions = r.json.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.0.0'), '1.0.0 must be in range');
    assert.ok(!versions.includes('1.0.0.1'), '1.0.0.1 (4-part) must be excluded from range');
  });

  // F1: workflows/update.md must reference the extract subcommand invocation.
  // allow-test-rule: source-text-is-the-product
  // Reads a product workflow .md file (not CJS source) to verify
  // the user-facing instruction was wired; there is no behavioural runtime to invoke.
  test('F1: workflows/update.md contains concrete extract subcommand invocation', (_t) => {
    const workflowPath = path.join(ROOT, 'gsd-core', 'workflows', 'update.md');
    const workflowText = fs.readFileSync(workflowPath, 'utf8');
    // The invocation uses either a direct path or an intermediate variable:
    //   node "$GSD_DIR/scripts/changeset/cli.cjs" extract
    //   node "$GSD_CHANGESET_CLI" extract
    // Accept either form so future refactors don't immediately trip this anchor.
    assert.ok(
      workflowText.includes('cli.cjs" extract') || workflowText.includes('cli.cjs extract') ||
      (workflowText.includes('GSD_CHANGESET_CLI') && workflowText.includes('" extract')),
      'update.md must invoke cli.cjs extract (fix for #3496 BLOCKER 1)',
    );
    assert.ok(
      workflowText.includes('--from') && workflowText.includes('--to'),
      'update.md extract invocation must include --from and --to flags',
    );
    assert.ok(
      workflowText.includes('--json'),
      'update.md extract invocation must use --json for structured output',
    );
    assert.ok(
      workflowText.includes('EXTRACT_EXIT') || workflowText.includes('EXTRACT_JSON'),
      'update.md must capture exit code or JSON output from extract',
    );
  });

  // F2: update.md must use the INSTALLED path ($GSD_DIR/scripts/changeset/cli.cjs),
  // NOT the old broken path ($GSD_DIR/gsd-core/scripts/changeset/cli.cjs).
  // The installer copies scripts/changeset/ into <configDir>/scripts/changeset/,
  // so the runtime path is $GSD_DIR/scripts/changeset/cli.cjs (#935).
  // allow-test-rule: source-text-is-the-product
  // Reads a product workflow .md file (not CJS source) to verify
  // the runtime install path contract; there is no behavioural runtime to invoke.
  test('F2: update.md CLI path is $GSD_DIR/scripts/changeset/cli.cjs (not gsd-core/scripts/…) (#935)', (_t) => {
    const workflowPath = path.join(ROOT, 'gsd-core', 'workflows', 'update.md');
    const workflowText = fs.readFileSync(workflowPath, 'utf8');
    // The correct installed path must appear somewhere in the update workflow
    assert.ok(
      workflowText.includes('scripts/changeset/cli.cjs'),
      'update.md must reference scripts/changeset/cli.cjs',
    );
    // The old broken path ($GSD_DIR/gsd-core/scripts/changeset/cli.cjs) must not appear
    assert.ok(
      !workflowText.includes('gsd-core/scripts/changeset/cli.cjs'),
      'update.md must NOT reference the old gsd-core/scripts/changeset/cli.cjs path (fix for #935)',
    );
  });

  // F3: update.md must guard against the CLI being missing (not pure silent-swallow)
  // allow-test-rule: source-text-is-the-product
  // Reads a product workflow .md file (not CJS source) to verify
  // the guard is present; there is no behavioural runtime to invoke.
  test('F3: update.md has an explicit guard when changeset CLI is missing (#935)', (_t) => {
    const workflowPath = path.join(ROOT, 'gsd-core', 'workflows', 'update.md');
    const workflowText = fs.readFileSync(workflowPath, 'utf8');
    // The workflow must check for CLI existence before invoking it
    assert.ok(
      workflowText.includes('GSD_CHANGESET_CLI') && workflowText.includes('! -f'),
      'update.md must guard against a missing changeset CLI with [ ! -f "$GSD_CHANGESET_CLI" ] (#935)',
    );
  });
});

describe('changeset cli render: file-I/O wrapper (#2975)', () => {
  test('exits 0 with consumed=N when N fragments are folded into CHANGELOG.md and deleted', () => {
    cleanup(path.join(tmp, '.changeset'));
    fs.writeFileSync(
      path.join(tmp, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- prior fix (#1)\n',
    );
    writeFragment('aaa-bbb-ccc', 'Fixed', 100, 'fragment-driven fix.');
    writeFragment('ddd-eee-fff', 'Added', 101, 'fragment-driven feature.');

    const r = runRender(['--version', '1.1.0', '--date', '2026-05-01']);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.report.consumed, 2);
    assert.equal(r.report.failures.length, 0);

    // Round-trip: parsing the resulting CHANGELOG must reflect the new release
    // and preserve the prior one.
    const text = fs.readFileSync(path.join(tmp, 'CHANGELOG.md'), 'utf8');
    const parsed = parseChangelog(text);
    const v110 = parsed.releases.find((r) => r.version === '1.1.0');
    assert.ok(v110, 'new 1.1.0 release present');
    assert.deepEqual(
      v110.sections.map((s) => ({ type: s.type, prs: s.bullets.map((b) => b.pr) })),
      [{ type: 'Added', prs: [101] }, { type: 'Fixed', prs: [100] }],
    );
    const v100 = parsed.releases.find((r) => r.version === '1.0.0');
    assert.ok(v100, 'prior 1.0.0 release preserved');
    assert.equal(v100.sections[0].bullets[0].pr, 1);

    // Fragments deleted after consumption.
    const remaining = fs.readdirSync(path.join(tmp, '.changeset'));
    assert.deepEqual(remaining.filter((f) => f.endsWith('.md')), []);
  });
});

// ---------------------------------------------------------------------------
// GROUP A — #690 regression guard (real repo CHANGELOG.md)
// ---------------------------------------------------------------------------

describe('changeset cli #690 regression: CHANGELOG.md has 1.3.0 and 1.3.1 entries', () => {
  const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');

  test('CHANGELOG.md has dated 1.3.0 and 1.3.1 release headings (regression #690)', () => {
    const text = fs.readFileSync(CHANGELOG_PATH, 'utf8');
    const { releases } = parseChangelog(text);
    const stableReleases = releases.filter((r) => r.version !== 'Unreleased');

    const v130 = stableReleases.find((r) => r.version === '1.3.0');
    assert.ok(v130, 'CHANGELOG.md must contain a release entry for version 1.3.0');
    assert.ok(v130.date !== null && v130.date !== '', '1.3.0 entry must have a non-null, non-empty date');

    const v131 = stableReleases.find((r) => r.version === '1.3.1');
    assert.ok(v131, 'CHANGELOG.md must contain a release entry for version 1.3.1');
    assert.ok(v131.date !== null && v131.date !== '', '1.3.1 entry must have a non-null, non-empty date');
  });

  test('extract 1.2.0->1.3.1 against repo CHANGELOG returns both 1.3.x releases (regression #690)', () => {
    const r = runNode(
      [SCRIPT, 'extract', '--from', '1.2.0', '--to', '1.3.1', '--changelog', CHANGELOG_PATH, '--json'],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    const json = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
    assert.equal(r.exitCode, 0, `expected exit 0 but got ${r.exitCode}; stderr=${r.stderr}; stdout=${r.stdout}`);
    assert.ok(json, 'stdout must be valid JSON');
    const versions = (json.releases || []).map((rel) => rel.version);
    assert.ok(versions.includes('1.3.0'), `releases array must include 1.3.0; got: ${JSON.stringify(versions)}`);
    assert.ok(versions.includes('1.3.1'), `releases array must include 1.3.1; got: ${JSON.stringify(versions)}`);
  });
});

// ---------------------------------------------------------------------------
// GROUP B — unit tests for the (not-yet-implemented) `verify` subcommand
// ---------------------------------------------------------------------------

function runVerify(args, changelogText) {
  const changelogFile = path.join(tmp, 'CHANGELOG-verify-test.md');
  fs.writeFileSync(changelogFile, changelogText);
  const r = runNode(
    [SCRIPT, 'verify', '--changelog', changelogFile, ...args],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  return toLegacyResult(r);
}

describe('changeset cli verify subcommand (not yet implemented — TDD red step)', () => {
  // Fixture: inline-URL heading form  ## [1.3.1](url) - 2026-06-04
  const FIXTURE_URL_HEADING = [
    '# Changelog',
    '',
    '## [1.3.1](https://www.npmjs.com/package/@opengsd/gsd-core/v/1.3.1) - 2026-06-04',
    '',
    '### Fixed',
    '',
    '- Some fix. (#42)',
    '',
    '## [1.2.0] - 2026-05-31',
    '',
    '### Added',
    '',
    '- Some feature. (#10)',
  ].join('\n');

  // Fixture: plain dated heading  ## [1.3.1] - 2026-06-04
  const FIXTURE_PLAIN_HEADING = [
    '# Changelog',
    '',
    '## [1.3.1] - 2026-06-04',
    '',
    '### Fixed',
    '',
    '- Some fix. (#42)',
    '',
    '## [1.2.0] - 2026-05-31',
    '',
    '### Added',
    '',
    '- Some feature. (#10)',
  ].join('\n');

  // Fixture: version absent (only Unreleased + 1.2.0)
  const FIXTURE_NO_131 = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [1.2.0] - 2026-05-31',
    '',
    '### Added',
    '',
    '- Some feature. (#10)',
  ].join('\n');

  // Fixture: heading present but NO date
  const FIXTURE_NO_DATE = [
    '# Changelog',
    '',
    '## [1.3.1]',
    '',
    '### Fixed',
    '',
    '- Some fix. (#42)',
  ].join('\n');

  test('verify --version 1.3.1 exits 0 when inline-URL dated heading is present', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_URL_HEADING);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 exits 0 when plain dated heading is present', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_PLAIN_HEADING);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 exits 1 when version heading is absent', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_NO_131);
    assert.equal(r.status, 1, `expected exit 1; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 exits 1 when heading has no date', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_NO_DATE);
    assert.equal(r.status, 1, `expected exit 1; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 with no match emits non-empty stderr/message', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_NO_131);
    assert.ok(
      (r.stderr && r.stderr.trim().length > 0) || (r.stdout && r.stdout.trim().length > 0),
      'must emit a non-empty error message to stderr or stdout when version not found',
    );
  });

  test('verify --version 1.3.x exits 1 for invalid semver', () => {
    // Use any non-empty fixture; the version check should fail before reading the file.
    const r = runVerify(['--version', '1.3.x'], FIXTURE_PLAIN_HEADING);
    assert.equal(r.status, 1, `expected exit 1 for invalid semver 1.3.x; stderr=${r.stderr}`);
  });

  test('verify --version v1.3.1 (v-prefixed) exits 0 when dated heading present', () => {
    // The leading `v` must be stripped, matching extract's behavior.
    const FIXTURE_DATED = [
      '# Changelog',
      '',
      '## [1.3.1] - 2026-06-04',
      '',
      '### Fixed',
      '',
      '- Some fix. (#42)',
    ].join('\n');
    const r = runVerify(['--version', 'v1.3.1'], FIXTURE_DATED);
    assert.equal(r.status, 0, `expected exit 0 for v-prefixed version; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 --json exits 0 and emits ok/version/date JSON fields', () => {
    const FIXTURE_DATED = [
      '# Changelog',
      '',
      '## [1.3.1] - 2026-06-04',
      '',
      '### Fixed',
      '',
      '- Some fix. (#42)',
    ].join('\n');
    const changelogFile = path.join(tmp, 'CHANGELOG-verify-test.md');
    fs.writeFileSync(changelogFile, FIXTURE_DATED);
    const r = runNode(
      [SCRIPT, 'verify', '--version', '1.3.1', '--json', '--changelog', changelogFile],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.equal(r.exitCode, 0, `expected exit 0; stderr=${r.stderr}`);
    const json = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
    assert.ok(json, 'stdout must be valid JSON');
    assert.strictEqual(json.ok, true, 'json.ok must be true');
    assert.strictEqual(json.version, '1.3.1', 'json.version must equal "1.3.1"');
    assert.ok(json.date && json.date.length > 0, 'json.date must be non-empty');
  });

  test('verify --version 1.3.1-rc.1 (pre-release) exits 1', () => {
    // Non-stable-triplet semver is rejected by the verify subcommand.
    const r = runVerify(['--version', '1.3.1-rc.1'], FIXTURE_PLAIN_HEADING);
    assert.equal(r.status, 1, `expected exit 1 for pre-release version; stderr=${r.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// GROUP C — render --allow-empty
// ---------------------------------------------------------------------------

describe('changeset cli render --allow-empty', () => {
  // Helper: run render for a specific test-local tmp directory.
  function runRenderIn(dir, args = []) {
    const r = runNode(
      [SCRIPT, 'render', '--repo', dir, ...args, '--json'],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    return {
      status: r.exitCode,
      report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
      stderr: r.stderr || '',
    };
  }

  function runVerifyIn(dir, version) {
    const changelogPath = path.join(dir, 'CHANGELOG.md');
    const r = runNode(
      [SCRIPT, 'verify', '--version', version, '--changelog', changelogPath],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    return toLegacyResult(r);
  }

  // Test 1: --allow-empty with zero fragments writes a dated heading +
  // placeholder, and subsequent verify exits 0.
  test('--allow-empty with zero fragments writes dated heading + placeholder; verify exits 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ae-'));
    try {
      fs.mkdirSync(path.join(dir, '.changeset'), { recursive: true });
      // Only a README — no fragment files.
      fs.writeFileSync(
        path.join(dir, '.changeset', 'README.md'),
        '# Changesets\n\nThis folder holds changeset fragments.\n',
      );
      fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n',
      );

      const r = runRenderIn(dir, ['--version', '9.9.9', '--date', '2026-06-05', '--allow-empty']);
      assert.equal(r.status, 0, `render exited non-zero; stderr=${r.stderr}`);
      assert.equal(r.report.consumed, 0, 'consumed must be 0 for empty run');
      assert.equal(r.report.failures.length, 0, 'no failures expected');
      assert.strictEqual(r.report.written, true, 'report.written must be true');

      // The CHANGELOG must now contain a dated heading for 9.9.9.
      const text = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
      const parsed = parseChangelog(text);
      const rel = parsed.releases.find((r) => r.version === '9.9.9');
      assert.ok(rel, 'release 9.9.9 must appear in CHANGELOG after --allow-empty render');
      assert.equal(rel.date, '2026-06-05', 'release date must be 2026-06-05');

      // The placeholder line must be present in the raw text.
      assert.ok(
        text.includes('_No notable changes._'),
        'CHANGELOG must contain _No notable changes._ placeholder',
      );

      // verify must exit 0 for this version.
      const vr = runVerifyIn(dir, '9.9.9');
      assert.equal(vr.status, 0, `verify must exit 0 after --allow-empty render; stderr=${vr.stderr}`);
    } finally {
      cleanup(dir);
    }
  });

  // Test 2: render WITHOUT --allow-empty and zero fragments early-exits —
  // CHANGELOG is not created / not modified. Regression lock.
  test('render without --allow-empty and zero fragments does NOT write CHANGELOG', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ae-'));
    try {
      fs.mkdirSync(path.join(dir, '.changeset'), { recursive: true });
      // No fragment files, only README.
      fs.writeFileSync(
        path.join(dir, '.changeset', 'README.md'),
        '# Changesets\n',
      );
      // Write a known CHANGELOG so we can verify it is unchanged.
      const originalChangelog = '# Changelog\n\n## [Unreleased]\n';
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), originalChangelog);

      const r = runRenderIn(dir, ['--version', '9.9.8', '--date', '2026-06-05']);
      assert.equal(r.status, 0, `render without --allow-empty exited non-zero; stderr=${r.stderr}`);
      assert.equal(r.report.consumed, 0, 'consumed must be 0');
      assert.equal(r.report.failures.length, 0, 'no failures expected');
      // report.written must NOT be set (undefined or absent).
      assert.ok(
        r.report.written === undefined || r.report.written === null || r.report.written === false,
        'report.written must not be true in the no-op path',
      );

      // CHANGELOG must be byte-identical to the original.
      const text = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
      assert.equal(text, originalChangelog, 'CHANGELOG must be unchanged when no fragments and no --allow-empty');
    } finally {
      cleanup(dir);
    }
  });

  // Test 3: render WITH fragments + --allow-empty behaves exactly like normal
  // render (consumes/deletes fragments, NO placeholder injected).
  test('render --allow-empty with fragments behaves like normal render (no placeholder)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ae-'));
    try {
      fs.mkdirSync(path.join(dir, '.changeset'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.changeset', 'fix-one.md'),
        '---\ntype: Fixed\npr: 200\n---\nFragment-driven fix.\n',
      );
      fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n',
      );

      const r = runRenderIn(dir, ['--version', '9.9.7', '--date', '2026-06-05', '--allow-empty']);
      assert.equal(r.status, 0, `render with fragments exited non-zero; stderr=${r.stderr}`);
      assert.equal(r.report.consumed, 1, 'one fragment must be consumed');
      assert.equal(r.report.failures.length, 0, 'no failures expected');

      const text = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
      // Placeholder must NOT appear when there are real fragments.
      assert.ok(
        !text.includes('_No notable changes._'),
        'placeholder must NOT appear when fragments were consumed',
      );
      // The fragment bullet must be present.
      const parsed = parseChangelog(text);
      const rel = parsed.releases.find((r) => r.version === '9.9.7');
      assert.ok(rel, 'release 9.9.7 must appear in CHANGELOG');
      assert.equal(rel.date, '2026-06-05', 'release date must be 2026-06-05');
      const prs = rel.sections.flatMap((s) => s.bullets.map((b) => b.pr));
      assert.ok(prs.includes(200), 'pr=200 bullet must be present in the release');

      // Fragment file must be deleted.
      const remaining = fs.readdirSync(path.join(dir, '.changeset'))
        .filter((f) => f.endsWith('.md') && f !== 'README.md');
      assert.deepEqual(remaining, [], 'fragment must be deleted after consumption');

      // verify must exit 0.
      const vr = runVerifyIn(dir, '9.9.7');
      assert.equal(vr.status, 0, `verify must exit 0 after render with fragments; stderr=${vr.stderr}`);
    } finally {
      cleanup(dir);
    }
  });

  // Test 4 (idempotency): after a fragmentful render, a second render
  // --allow-empty for the SAME version is now a NO-OP (FIX 1 guard).  It must
  // NOT add a second heading, must exit 0, and must report alreadyPromoted:true.
  test('idempotency: second --allow-empty render for same version is a no-op (no duplicate heading)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ae-'));
    try {
      fs.mkdirSync(path.join(dir, '.changeset'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.changeset', 'fix-two.md'),
        '---\ntype: Fixed\npr: 300\n---\nIdempotency test fix.\n',
      );
      fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n',
      );

      // First render: with a fragment.
      const r1 = runRenderIn(dir, ['--version', '9.9.6', '--date', '2026-06-05']);
      assert.equal(r1.status, 0, `first render exited non-zero; stderr=${r1.stderr}`);
      assert.equal(r1.report.consumed, 1, 'first render must consume 1 fragment');

      // verify after first render must succeed.
      const vr1 = runVerifyIn(dir, '9.9.6');
      assert.equal(vr1.status, 0, `verify after first render must exit 0; stderr=${vr1.stderr}`);

      // Second render --allow-empty: zero fragments now, same version.
      // This is now a NO-OP due to the already-promoted guard (FIX 1).
      const r2 = runRenderIn(dir, ['--version', '9.9.6', '--date', '2026-06-05', '--allow-empty']);
      assert.equal(r2.status, 0, `second render exited non-zero; stderr=${r2.stderr}`);
      assert.equal(r2.report.consumed, 0, 'second render must consume 0 fragments');
      assert.strictEqual(r2.report.alreadyPromoted, true, 'second render must report alreadyPromoted:true');

      // Exactly ONE ## [9.9.6] heading must be present — no duplicate.
      const text = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
      const parsed = parseChangelog(text);
      const all996 = parsed.releases.filter((r) => r.version === '9.9.6');
      assert.equal(
        all996.length, 1,
        `exactly one 9.9.6 heading must be present after two renders; found ${all996.length}`,
      );

      // verify must still exit 0.
      const vr2 = runVerifyIn(dir, '9.9.6');
      assert.equal(vr2.status, 0, `verify after second render must still exit 0; stderr=${vr2.stderr}`);
    } finally {
      cleanup(dir);
    }
  });

  // Test 4b (stale fragments): alreadyPromoted + fragments present → render exits
  // NON-ZERO, CHANGELOG is NOT modified, and the fragment file is NOT deleted.
  // This guards the inconsistent-state scenario identified in the adversarial review:
  // a manual/partial promotion wrote the heading but left fragments unconsumed.
  test('alreadyPromoted + fragments present: exits non-zero, CHANGELOG unchanged, fragment survives', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ae-'));
    try {
      fs.mkdirSync(path.join(dir, '.changeset'), { recursive: true });

      // CHANGELOG already has a dated heading for 3.3.3 (out-of-band promotion).
      const originalChangelog = [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '## [3.3.3] - 2026-01-01',
        '',
        '### Fixed',
        '',
        '- x (#1)',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), originalChangelog);

      // A fragment file is still present — unconsumed.
      const fragmentPath = path.join(dir, '.changeset', 'leftover.md');
      fs.writeFileSync(fragmentPath, '---\ntype: Fixed\npr: 9\n---\nleftover fragment\n');

      // Run render for the same version.
      const r = runRenderIn(dir, ['--version', '3.3.3', '--date', '2026-06-05', '--allow-empty']);

      // Must exit non-zero.
      assert.notEqual(r.status, 0, `expected non-zero exit for alreadyPromoted+fragments; got ${r.status}`);

      // report.alreadyPromoted must be true and report.error must be present.
      assert.strictEqual(r.report.alreadyPromoted, true, 'report.alreadyPromoted must be true');
      assert.ok(typeof r.report.error === 'string' && r.report.error.length > 0, 'report.error must be a non-empty string');
      assert.ok(r.report.error.includes('3.3.3'), 'report.error must mention the version');

      // Fragment file must still exist — render must NOT have deleted it.
      assert.ok(fs.existsSync(fragmentPath), 'leftover fragment must still exist after non-zero exit');

      // CHANGELOG must be byte-identical to the original — render must NOT have modified it.
      const text = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
      assert.equal(text, originalChangelog, 'CHANGELOG must be unchanged');

      // Exactly one ## [3.3.3] heading must be present (no duplicate added).
      const parsed = parseChangelog(text);
      const all333 = parsed.releases.filter((rel) => rel.version === '3.3.3');
      assert.equal(all333.length, 1, `exactly one 3.3.3 heading must be present; found ${all333.length}`);
    } finally {
      cleanup(dir);
    }
  });

  // Test 5 (cold start): --allow-empty when CHANGELOG.md does NOT exist creates
  // the file with # Changelog, ## [Unreleased], and a dated release with placeholder.
  test('--allow-empty cold start (no CHANGELOG.md) creates file with expected structure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ae-'));
    try {
      fs.mkdirSync(path.join(dir, '.changeset'), { recursive: true });
      // No CHANGELOG.md, no fragments.

      const r = runRenderIn(dir, ['--version', '8.8.8', '--date', '2026-06-05', '--allow-empty']);
      assert.equal(r.status, 0, `render exited non-zero; stderr=${r.stderr}`);
      assert.equal(r.report.consumed, 0, 'consumed must be 0');
      assert.strictEqual(r.report.written, true, 'report.written must be true');

      const changelogPath = path.join(dir, 'CHANGELOG.md');
      assert.ok(fs.existsSync(changelogPath), 'CHANGELOG.md must be created');

      const text = fs.readFileSync(changelogPath, 'utf8');
      // Must contain a top-level heading.
      assert.ok(text.includes('# Changelog'), 'must contain # Changelog heading');
      // Must contain an ## [Unreleased] block.
      assert.ok(text.includes('## [Unreleased]'), 'must contain ## [Unreleased] block');
      // Must contain a dated release heading for 8.8.8.
      assert.ok(text.includes('## [8.8.8] - 2026-06-05'), 'must contain dated release heading for 8.8.8');
      // Must contain the placeholder.
      assert.ok(text.includes('_No notable changes._'), 'must contain _No notable changes._ placeholder');

      // parseChangelog must see the release with the correct date.
      const parsed = parseChangelog(text);
      const rel = parsed.releases.find((r) => r.version === '8.8.8');
      assert.ok(rel, 'release 8.8.8 must appear in parsed CHANGELOG');
      assert.equal(rel.date, '2026-06-05', 'release date must be 2026-06-05');

      // verify must exit 0.
      const vr = runVerifyIn(dir, '8.8.8');
      assert.equal(vr.status, 0, `verify must exit 0 after cold-start --allow-empty render; stderr=${vr.stderr}`);
    } finally {
      cleanup(dir);
    }
  });

  // Test 6: --allow-empty (zero fragments) on a CHANGELOG that already has a
  // prior dated release PRESERVES that prior release in the output.
  test('--allow-empty preserves prior dated release below new section', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ae-'));
    try {
      fs.mkdirSync(path.join(dir, '.changeset'), { recursive: true });
      // Pre-existing CHANGELOG with a prior dated release.
      const priorChangelog = [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '## [1.0.0] - 2026-01-01',
        '',
        '### Fixed',
        '',
        '- Old fix. (#1)',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), priorChangelog);

      const r = runRenderIn(dir, ['--version', '2.0.0', '--date', '2026-06-05', '--allow-empty']);
      assert.equal(r.status, 0, `render exited non-zero; stderr=${r.stderr}`);
      assert.equal(r.report.consumed, 0, 'consumed must be 0');
      assert.strictEqual(r.report.written, true, 'report.written must be true');

      const text = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');

      // New release must appear.
      assert.ok(text.includes('## [2.0.0]'), 'new 2.0.0 heading must be present');
      assert.ok(text.includes('_No notable changes._'), 'placeholder must be present');

      // Prior release must survive.
      assert.ok(text.includes('## [1.0.0] - 2026-01-01'), 'prior 1.0.0 heading must be preserved');
      assert.ok(text.includes('- Old fix. (#1)'), 'prior release bullet must be preserved');

      // Parse and assert both releases are present.
      const parsed = parseChangelog(text);
      const rel200 = parsed.releases.find((r) => r.version === '2.0.0');
      assert.ok(rel200, '2.0.0 must appear in parsed CHANGELOG');
      assert.equal(rel200.date, '2026-06-05', '2.0.0 date must be 2026-06-05');
      const rel100 = parsed.releases.find((r) => r.version === '1.0.0');
      assert.ok(rel100, '1.0.0 must still appear in parsed CHANGELOG');
      assert.equal(rel100.date, '2026-01-01', '1.0.0 date must be preserved');
      assert.equal(rel100.sections[0].bullets[0].pr, 1, 'pr=1 bullet in 1.0.0 must be preserved');

      // verify for the new version must exit 0.
      const vr = runVerifyIn(dir, '2.0.0');
      assert.equal(vr.status, 0, `verify must exit 0 after --allow-empty on existing CHANGELOG; stderr=${vr.stderr}`);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// GROUP D — render --preview (#759)
// ---------------------------------------------------------------------------

describe('changeset cli render --preview (#759)', () => {
  // Helper: reset the shared tmp dir to a clean state for preview tests.
  function resetTmp() {
    // Remove CHANGELOG.md if present.
    const changelogPath = path.join(tmp, 'CHANGELOG.md');
    if (fs.existsSync(changelogPath)) {
      fs.unlinkSync(changelogPath);
    }
    // Remove any leftover .changeset/*.md fragments.
    const changesetDir = path.join(tmp, '.changeset');
    if (fs.existsSync(changesetDir)) {
      for (const f of fs.readdirSync(changesetDir)) {
        if (f.endsWith('.md') && f !== 'README.md') {
          fs.unlinkSync(path.join(changesetDir, f));
        }
      }
    }
  }

  // Reset state before each preview test so a new test added to this group
  // can never inherit a CHANGELOG.md or fragments left by the previous one.
  beforeEach(resetTmp);

  test('render --preview prints the section to stdout and mutates nothing', () => {
    writeFragment('preview-frag-one', 'Added', 900, 'preview-added-feature');

    const fragmentPath = path.join(tmp, '.changeset', 'preview-frag-one.md');
    const r = runRenderRaw(['--version', '9.9.0', '--date', '2026-01-02', '--preview']);

    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(r.stdout.includes('## [9.9.0]'), `stdout must contain ## [9.9.0]; got: ${r.stdout}`);
    assert.ok(r.stdout.includes('### Added'), `stdout must contain ### Added; got: ${r.stdout}`);
    assert.ok(r.stdout.includes('preview-added-feature'), `stdout must contain fragment body; got: ${r.stdout}`);

    // CHANGELOG.md must NOT have been created.
    assert.ok(!fs.existsSync(path.join(tmp, 'CHANGELOG.md')), 'CHANGELOG.md must NOT be created by --preview');

    // Fragment file must still exist.
    assert.ok(fs.existsSync(fragmentPath), 'fragment file must still exist after --preview');
  });

  test('render --preview with zero fragments emits the placeholder and writes nothing', () => {
    // No fragments written — zero-fragment scenario.

    const r = runRenderRaw(['--version', '9.9.0', '--date', '2026-01-02', '--preview']);

    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(r.stdout.includes('## ['), `stdout must contain a release heading; got: ${r.stdout}`);
    assert.ok(r.stdout.includes('_No notable changes._'), `stdout must contain placeholder; got: ${r.stdout}`);

    // CHANGELOG.md must NOT have been created.
    assert.ok(!fs.existsSync(path.join(tmp, 'CHANGELOG.md')), 'CHANGELOG.md must NOT be created by zero-fragment --preview');
  });

  test('render --preview --json returns preview text in report with consumed 0', () => {
    writeFragment('preview-frag-two', 'Fixed', 901, 'preview-fixed-bug');

    const fragmentPath = path.join(tmp, '.changeset', 'preview-frag-two.md');
    // runRender appends --json automatically.
    const r = runRender(['--version', '9.9.0', '--date', '2026-01-02', '--preview']);

    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(r.report, 'report must be parseable JSON');
    assert.strictEqual(r.report.consumed, 0, 'consumed must be 0 for preview');
    assert.strictEqual(r.report.fragmentCount, 1, 'fragmentCount must be 1');
    assert.ok(typeof r.report.preview === 'string', 'report.preview must be a string');
    assert.ok(r.report.preview.includes('## [9.9.0]'), `report.preview must contain ## [9.9.0]; got: ${r.report.preview}`);

    // Fragment file must still exist.
    assert.ok(fs.existsSync(fragmentPath), 'fragment file must still exist after --preview --json');
  });

  test('render --preview with an existing CHANGELOG.md leaves it byte-identical and shows only the new section', () => {
    // Seed an existing CHANGELOG with a prior dated release.
    const changelogPath = path.join(tmp, 'CHANGELOG.md');
    const existing =
      '# Changelog\n\n## [1.0.0] - 2020-01-01\n\n### Added\n\n- old prior feature (#1)\n';
    fs.writeFileSync(changelogPath, existing);
    writeFragment('preview-frag-three', 'Added', 902, 'brand-new-thing');
    const before = fs.readFileSync(changelogPath, 'utf8');

    const r = runRenderRaw(['--version', '9.9.0', '--date', '2026-01-02', '--preview']);

    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    // Output shows the new section...
    assert.ok(r.stdout.includes('## [9.9.0]'), `stdout must contain new heading; got: ${r.stdout}`);
    assert.ok(r.stdout.includes('brand-new-thing'), `stdout must contain new fragment body; got: ${r.stdout}`);
    // ...and NOT the prior release history (preview is the new section only).
    assert.ok(!r.stdout.includes('## [1.0.0]'), `preview must NOT include prior releases; got: ${r.stdout}`);
    assert.ok(!r.stdout.includes('old prior feature'), `preview must NOT include prior bullets; got: ${r.stdout}`);

    // Existing CHANGELOG.md must be byte-identical — preview mutates nothing.
    assert.strictEqual(
      fs.readFileSync(changelogPath, 'utf8'),
      before,
      'CHANGELOG.md must be byte-identical after --preview',
    );
  });

  // Regression (#939 / rc-job crash): a fragment that fails to parse (e.g. an
  // un-backfilled `pr: 0` placeholder) makes cmdRender early-return WITHOUT a
  // `preview` key. Before the fix, main() wrote report.preview unguarded, so
  // `process.stdout.write(undefined)` threw ERR_INVALID_ARG_TYPE and the rc
  // "Preview CHANGELOG" step died with a cryptic TypeError that masked the real
  // cause. The preview failure path must now exit non-zero and NAME the bad
  // fragment, identical to a non-preview render.
  test('render --preview with an unparseable fragment fails cleanly (names the file, no TypeError crash)', () => {
    // pr: 0 is the never-backfilled placeholder → parseFragment returns invalid_pr.
    writeFragment('bad-fragment', 'Fixed', 0, '**Bad** — placeholder never backfilled. (#123)');

    // The crash lived on the NON-json path: process.stdout.write(report.preview)
    // with report.preview === undefined. Exercise it directly and assert it no
    // longer crashes — non-zero exit and NO TypeError stack in the output (QA
    // matrix: "No stack trace in non-debug failure output").
    const raw = runRenderRaw(['--version', '9.9.0', '--date', '2026-01-02', '--preview']);
    assert.notStrictEqual(raw.status, 0, `parse-failure preview must exit non-zero; stdout=${raw.stdout} stderr=${raw.stderr}`);
    const combined = `${raw.stdout}\n${raw.stderr}`;
    assert.ok(
      !combined.includes('ERR_INVALID_ARG_TYPE'),
      `preview must NOT crash with ERR_INVALID_ARG_TYPE; got: ${combined}`,
    );

    // Structured surface (--json) proves the failure NAMES the offending fragment
    // and reports the typed parse reason — asserted on the typed report shape,
    // not on rendered prose.
    const json = runRender(['--version', '9.9.0', '--date', '2026-01-02', '--preview']);
    assert.notStrictEqual(json.status, 0, 'json preview must also exit non-zero on parse failure');
    assert.ok(Array.isArray(json.report.failures), `report.failures must be an array; got: ${JSON.stringify(json.report)}`);
    const bad = json.report.failures.find((f) => f.file.endsWith('bad-fragment.md'));
    assert.ok(bad, `failures must name the offending fragment; got: ${JSON.stringify(json.report.failures)}`);
    assert.equal(bad.reason, 'invalid_pr', `failure reason must be the typed invalid_pr; got: ${bad && bad.reason}`);

    // Still non-destructive: no CHANGELOG.md written, fragment left in place.
    assert.ok(!fs.existsSync(path.join(tmp, 'CHANGELOG.md')), 'CHANGELOG.md must NOT be created by a failed preview');
    assert.ok(fs.existsSync(path.join(tmp, '.changeset', 'bad-fragment.md')), 'fragment must still exist after failed preview');
  });
});
