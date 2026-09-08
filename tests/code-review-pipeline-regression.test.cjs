// docs-guard-exempt: 'docs/DEVELOPMENT.md' is a synthetic files-list fixture entry, not read as content.
// allow-test-rule: source-text-is-the-product
// The workflow and agent .md files ARE the product: their text is loaded and
// executed/interpreted at runtime by the agent host. Testing that specific
// strings exist within these files tests the deployed contract, not an
// implementation detail. No runtime API exists to enumerate the label accept-
// list or filter-set definitions — the text IS the specification.
//
// Bug 1 (compute_file_scope) — The inline Node.js script embedded in the
// workflow .md is the parser. The test implements the identical parse logic as
// a pure JS function (mirroring lines 172-184 of code-review.md exactly) and
// asserts on its structured output. A separate docs-parity assertion checks
// that the workflow .md contains the hyphen-aware boundary regex and the
// em-dash/parenthetical stripping — both of which are the deployed contract.
//
// Bug 2 (present_results) — Tested both behaviourally (pure JS helper that
// mimics the grep|cut pipeline) and via docs-parity on the workflow .md text.
//
// Bugs 3 and reviewer contract — docs-parity only on agents/*.md: the filter-
// set definition and label-equivalence contract exist only as text in those
// files; there is no runtime enumeration API.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runHook, runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { toLegacyResult, gitOrThrow } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS, GIT_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, createTempGitProject, cleanup, readFileNormalized } = require('./helpers.cjs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
// HOISTED. `const` is in the temporal dead zone until its declaration executes, and a
// `{ skip: !HAS_BASH }` option object is evaluated EAGERLY when its describe body runs --
// so a bash-gated test added ABOVE the old mid-file declaration threw a ReferenceError
// that aborted the whole describe and CANCELLED its siblings. It caught three separate
// additions in this round alone, and the cancellation reads as a passing run in the
// summary line. Declared with the other file-level constants so placement stops mattering.
// AND NOT A PROBE — but the honest reason is narrower than the first draft of this comment claimed,
// and the correction is worth keeping. Round 5 flagged that every test exercising the shipped bash
// fences is `{ skip: !HAS_BASH }`, so block 1's severity-reporting path has no Windows-lane coverage.
// The gap is real and the count is 37 — 22 was the number of `{ skip: !HAS_BASH }` CALL SITES, and a
// skip on a `describe` cancels its subtests.
//
// This comment first justified the skip by citing `local/no-unguarded-nonportable-exec` as REQUIRING
// this exact guard. That was checked and is wrong on both halves: the rule only fires on a file that
// also chmods an exec bit with an octal literal (this file has none, so it never fires here), and
// `eslint-rules/lib/platform-guard.cjs` accepts four guard shapes plus `os.platform()`, not one. A
// constraint that exists is not a constraint that applies.
//
// What holds — and this is now MEASURED, not assumed. The measurement the previous version of this
// comment deferred has been made, on native Windows (not WSL) with Git Bash 5.2.37 / MINGW64 first on
// PATH, node v25.2.1 — the same shell family the repo's `windows-latest` lane runs:
//
//     HAS_BASH left alone:  179 tests, 127 pass,   0 fail, 52 skipped
//     HAS_BASH forced true: 179 tests, 140 pass,  24 fail, 15 skipped
//
// So 37 of the skips are this guard's (52 - 15; the other 15 skip for unrelated reasons), and
// unskipping them does NOT reveal a clean win: 13 pass and 24 fail. The failures cluster on exactly
// the divergence the eslint rule's subject line names — `bash -c` quoting (one surfaces as
// `unexpected EOF while looking for matching '"'`), empty captured output, and two outright
// `spawn_failed`. Flipping this constant to a runtime probe today would red the Windows lane with 24
// failures, so the guard STAYS; what changes is that it now documents a measured gap instead of an
// assumed one. Closing it means porting the fences themselves, which is a change of its own, not a
// line in a review round.
//
// NOTE for anyone re-running this: on a WSL host `bash` on the Windows PATH resolves to
// C:\Windows\system32\bash.exe, the WSL bridge — measuring through that runs real Linux bash and
// reports a false clean. Put `C:\Program Files\Git\bin` first.
const HAS_BASH = process.platform !== 'win32';
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md');
const PRE_PASS_STEP_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review', 'steps', 'structural-pre-pass.md');
const FIXER_PATH = path.join(ROOT, 'agents', 'gsd-code-fixer.md');
const REVIEWER_PATH = path.join(ROOT, 'agents', 'gsd-code-reviewer.md');
const EXECUTE_PHASE_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const DISPOSITION_STEP_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'code-review-disposition.md');

// ---------------------------------------------------------------------------
// Pure-function implementation of the compute_file_scope Node script body.
// This mirrors the logic in code-review.md lines 172-184 exactly.
// If those lines change, this function must be updated in tandem (and the
// docs-parity assertions below will catch a mismatch at the regex level).
//
// #2666: the acceptance predicate accepts root-level paths (no `/`) and known
// extensionless build files (Dockerfile/Makefile/etc.), not only nested paths
// with a trailing extension. Prose bullets are rejected by the known-filename /
// has-extension distinction (plus the post-processing existence check backstop
// in the shipped workflow).
const KNOWN_EXTENSIONLESS_BUILD_FILES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'justfile', 'procfile',
]);
function isAcceptablePath(raw) {
  // A trailing `.`+alphanumerics extension qualifies (root-level OR nested):
  // package.json, renovate.json, .gitlab-ci.yml, AGENTS.md, app/foo.tsx
  if (/\.[A-Za-z0-9]+$/.test(raw)) return true;
  // Known extensionless build filename (basename, case-insensitive): Dockerfile, Makefile, …
  const base = raw.split('/').pop();
  if (KNOWN_EXTENSIONLESS_BUILD_FILES.has(base.toLowerCase())) return true;
  return false;
}
function parseKeyFiles(yaml) {
  const files = [];
  let inSection = null;
  for (const line of yaml.split('\n')) {
    if (/^\s+created:/.test(line)) { inSection = 'created'; continue; }
    if (/^\s+modified:/.test(line)) { inSection = 'modified'; continue; }
    // Hyphen-aware boundary: reset inSection for ANY key: line (including key-decisions:, etc.)
    if (/^\s*[\w-]+:/.test(line) && !/^\s*-/.test(line)) { inSection = null; continue; }
    if (inSection && /^\s+-\s+(.+)/.test(line)) {
      let raw = line.match(/^\s+-\s+(.+)/)[1].trim();
      raw = raw.replace(/^['"]|['"]$/g, '');
      // Order matters: parens BEFORE em-dash because em-dashes can appear inside parens
      raw = raw.replace(/\s+\([^)]*\)\s*$/, '');
      raw = raw.split(/\s+—\s/)[0].trim();
      if (isAcceptablePath(raw)) {
        files.push(raw);
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Pure-function implementation of the present_results severity-label parser.
// Mirrors the grep -E "^\s*(critical|blocker):" | head -1 | cut -d: -f2 | xargs
// pipeline from code-review.md.
// ---------------------------------------------------------------------------
function parseFrontmatterCritical(frontmatter) {
  const lines = frontmatter.split('\n');
  const match = lines.find((l) => /^\s*(critical|blocker):/.test(l));
  if (!match) return { critical: 0 };
  const value = match.split(':').slice(1).join(':').trim();
  return { critical: parseInt(value, 10) || 0 };
}

// ---------------------------------------------------------------------------
// BUG 1 — SUMMARY parser: compute_file_scope must not bleed prose from
// hyphenated sections (key-decisions:, patterns-established:, etc.) into the
// file list, and must strip em-dash descriptions and parentheticals.
// ---------------------------------------------------------------------------
describe('Bug 1 — compute_file_scope SUMMARY parser', () => {
  test('extracts only key-files.created and key-files.modified entries', () => {
    const yaml = [
      'key-files:',
      '  created:',
      '    - app/foo.tsx',
      '  modified:',
      '    - lib/bar.ts',
      'key-decisions:',
      '  - We chose RSC for performance reasons',
      'patterns-established:',
      '  - Always validate at the boundary',
      'requirements-completed:',
      '  - REQ-01 done',
    ].join('\n');

    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(files.sort(), ['app/foo.tsx', 'lib/bar.ts'].sort());
  });

  test('strips em-dash narrative from bullet: "app/foo.tsx — RSC catalogue with filters"', () => {
    const yaml = [
      'key-files:',
      '  created:',
      '    - app/foo.tsx — RSC catalogue with topic/mode/date filters',
    ].join('\n');

    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(files, ['app/foo.tsx']);
  });

  test('strips parenthetical from bullet: "tests/bar.test.ts (122 lines — 17 assertions)"', () => {
    const yaml = [
      'key-files:',
      '  created:',
      '    - tests/bar.test.ts (122 lines — 17 assertions)',
    ].join('\n');

    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(files, ['tests/bar.test.ts']);
  });

  test('hyphenated sections in any order produce identical results', () => {
    const yamlA = [
      'key-decisions:',
      '  - Some decision',
      'key-files:',
      '  created:',
      '    - src/index.ts',
      'patterns-established:',
      '  - Some pattern',
    ].join('\n');

    const yamlB = [
      'patterns-established:',
      '  - Some pattern',
      'key-files:',
      '  created:',
      '    - src/index.ts',
      'key-decisions:',
      '  - Some decision',
    ].join('\n');

    assert.deepStrictEqual(parseKeyFiles(yamlA), parseKeyFiles(yamlB));
    assert.deepStrictEqual(parseKeyFiles(yamlA), ['src/index.ts']);
  });

  test('prose-only bullets from key-decisions are never included in file list', () => {
    const yaml = [
      'key-decisions:',
      '  - We chose RSC for performance reasons',
      '  - Deferred auth to Phase 3',
      'key-files:',
      '  created:',
      '    - app/page.tsx',
    ].join('\n');

    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(files, ['app/page.tsx']);
  });

  // #2666 — the Tier-2 extractor must NOT drop repository-root files (no `/`)
  // or known extensionless build files. Pre-fix the buggy predicate
  // `/\//.test(raw) && /\.[A-Za-z0-9]+$/.test(raw)` dropped every root-level
  // path and every extensionless build file anywhere in the tree.
  test('#2666 RED: root-level files with extensions are accepted (package.json, renovate.json, .gitlab-ci.yml, AGENTS.md)', () => {
    const yaml = [
      'key-files:',
      '  modified:',
      '    - package.json',
      '    - renovate.json',
      '    - .gitlab-ci.yml',
      '    - AGENTS.md',
      '    - CLAUDE.md',
    ].join('\n');
    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(
      files.sort(),
      ['.gitlab-ci.yml', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'renovate.json'],
      'root-level files with extensions must not be dropped for lacking a directory separator',
    );
  });

  test('#2666: nested extensionless build files are accepted (docker/Dockerfile, web/Makefile)', () => {
    const yaml = [
      'key-files:',
      '  modified:',
      '    - docker/Dockerfile',
      '    - web/Makefile',
    ].join('\n');
    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(files.sort(), ['docker/Dockerfile', 'web/Makefile']);
  });

  test('#2666: root-level extensionless build files are accepted (Dockerfile, Makefile, Justfile, Containerfile, Procfile)', () => {
    const yaml = [
      'key-files:',
      '  created:',
      '    - Dockerfile',
      '    - Makefile',
      '    - Justfile',
      '    - Containerfile',
      '    - Procfile',
    ].join('\n');
    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(
      files.sort(),
      ['Containerfile', 'Dockerfile', 'Justfile', 'Makefile', 'Procfile'],
    );
  });

  test('#2666 acceptance #1: the reporter 10-file Docker+CI phase yields all 10 paths', () => {
    const yaml = [
      'key-files:',
      '  created:',
      '    - Dockerfile',
      '    - .gitlab-ci.yml',
      '    - renovate.json',
      '    - AGENTS.md',
      '    - CLAUDE.md',
      '    - docs/DEVELOPMENT.md',
      '    - scripts/version-consistency-gate.mjs',
      '    - web/package.json',
      '    - web/version_management.md',
      '    - web/update-version.cjs',
    ].join('\n');
    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(
      files.sort(),
      [
        '.gitlab-ci.yml', 'AGENTS.md', 'CLAUDE.md', 'Dockerfile',
        'docs/DEVELOPMENT.md', 'renovate.json', 'scripts/version-consistency-gate.mjs',
        'web/package.json', 'web/update-version.cjs', 'web/version_management.md',
      ],
      'the full reporter phase must scope all 10 files, including Dockerfile + root files',
    );
  });

  test('#2666 negative-space: a path-like prose bullet with no extension and unknown basename is rejected', () => {
    // `topic/mode/date filters` has a `/` but no extension and an unknown basename —
    // the pre-fix predicate dropped it (good), the relaxed predicate must STILL drop it.
    const yaml = [
      'key-decisions:',
      '  - topic/mode/date filters',
      'key-files:',
      '  created:',
      '    - app/page.tsx',
    ].join('\n');
    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(files, ['app/page.tsx']);
  });

  test('#2666 negative-space: em-dash/parenthetical stripping still works on an accepted root file', () => {
    const yaml = [
      'key-files:',
      '  modified:',
      '    - Dockerfile — multi-stage build',
    ].join('\n');
    const files = parseKeyFiles(yaml);
    assert.deepStrictEqual(files, ['Dockerfile']);
  });

  // Docs-parity: the workflow .md must contain the hyphen-aware boundary regex
  // so what we tested above is actually what is deployed.
  test('code-review.md contains hyphen-aware boundary regex [\\w-]+', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    // Locate the Node script block in the compute_file_scope step
    const scriptStart = src.indexOf('const files = [];');
    assert.ok(scriptStart !== -1, 'compute_file_scope script must contain "const files = [];"');
    const scriptEnd = src.indexOf('if (files.length)', scriptStart);
    const scriptSection = src.slice(scriptStart, scriptEnd);
    // Must use [\\w-]+ (hyphen-aware) not \\w+ only
    const hasHyphenAwareRegex = scriptSection.includes('[\\\\w-]') || scriptSection.includes('[\\w-]');
    assert.ok(
      hasHyphenAwareRegex,
      'compute_file_scope boundary regex must be hyphen-aware ([\\w-]+), found section:\n' + scriptSection
    );
  });

  // Docs-parity: the workflow .md must contain the em-dash and parenthetical stripping.
  test('code-review.md contains em-dash split and parenthetical strip in script body', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const scriptStart = src.indexOf('const files = [];');
    const scriptEnd = src.indexOf('if (files.length)', scriptStart);
    const scriptSection = src.slice(scriptStart, scriptEnd);
    assert.ok(
      scriptSection.includes('replace(/\\s+\\([^)]*\\)\\s*$/, \'\')'),
      'Script must strip parentheticals with replace(/\\s+\\([^)]*\\)\\s*$/, \'\')'
    );
    assert.ok(
      scriptSection.includes('split(/\\s+—\\s'),
      'Script must split on em-dash to strip narrative'
    );
  });

  // #2666 docs-parity: the shipped workflow must NOT still carry the buggy
  // AND-joined predicate that required BOTH a `/` and a trailing extension —
  // that predicate dropped every root-level file and every extensionless build
  // file. Catches a revert of the #2666 fix.
  test('#2666 docs-parity: compute_file_scope does not contain the buggy slash-and-extension predicate', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const scriptStart = src.indexOf('const files = [];');
    const scriptEnd = src.indexOf('if (files.length)', scriptStart);
    const scriptSection = src.slice(scriptStart, scriptEnd);
    assert.ok(
      !scriptSection.includes('/\\//.test(raw) && /\\.[A-Za-z0-9]+$/.test(raw)'),
      'compute_file_scope must not use the buggy AND-joined /\\//.test(raw) && /\\.[A-Za-z0-9]+$/.test(raw) ' +
        'predicate (#2666) — it drops every root-level and extensionless build file. Found section:\n' +
        scriptSection
    );
  });

  // #2666 docs-parity: the shipped workflow must reference the known
  // extensionless build filenames so Dockerfile/Makefile/etc. are accepted.
  test('#2666 docs-parity: compute_file_scope accepts known extensionless build files (Dockerfile)', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const scriptStart = src.indexOf('const files = [];');
    const scriptEnd = src.indexOf('if (files.length)', scriptStart);
    const scriptSection = src.slice(scriptStart, scriptEnd);
    assert.ok(
      /dockerfile/i.test(scriptSection),
      'compute_file_scope must reference known extensionless build filenames (e.g. Dockerfile) ' +
        'so they are not dropped (#2666). Found section:\n' + scriptSection
    );
  });

  // #2666 docs-parity: the Tier-3 git-diff fallback must intersect with the
  // SUMMARY scope and warn on dropped files (not only fire on zero Tier-2 hits).
  test('#2666 docs-parity: Tier-3 intersects/warns against git diff --name-only', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    // The shipped workflow must compute git diff --name-only AND emit a warning
    // when the diff contains files the SUMMARY extractor did not surface.
    assert.ok(
      src.includes('git diff --name-only'),
      'code-review.md must run `git diff --name-only` to cross-check the SUMMARY scope (#2666)'
    );
    assert.ok(
      /warn|missing|not surfaced|did not|not in/i.test(src),
      'code-review.md must warn when git diff contains files the SUMMARY extractor dropped (#2666)'
    );
  });

  // #2666 docs-parity: the membership test must be EXACT whole-line matching
  // (grep -Fxq), not an unanchored `case` substring match — otherwise a short
  // basename in the diff (root `Dockerfile`) substring-matches a longer scoped
  // path (`docker/Dockerfile`) and is silently skipped, reintroducing the bug.
  test('#2666 docs-parity: Tier-3 cross-check uses exact whole-line matching (grep -Fxq), not substring case', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(
      src.includes('grep -Fxq'),
      'code-review.md Tier-3 cross-check must use grep -Fxq (exact whole-line match) for membership ' +
        'testing, not an unanchored `case` substring match that would skip a root `Dockerfile` ' +
        'whose name appears as a suffix of an already-scoped `docker/Dockerfile` (#2666)'
    );
    // The unanchored substring `case "$IN_SCOPE" in` membership test must NOT be
    // present — it would false-match a basename suffix. Plain substring check (no
    // regex, so no CRLF-fragility): the grep -Fxq positive guard above proves the
    // correct mechanism; this negative guard catches a revert to the `case` form.
    assert.ok(
      !src.includes('case "$IN_SCOPE"'),
      'code-review.md Tier-3 must not use the unanchored `case "$IN_SCOPE"` substring membership ' +
        'test (#2666) — use grep -Fxq for exact whole-line matching'
    );
  });
});

// ---------------------------------------------------------------------------
// BUG 2 — severity-label parser: present_results must accept both `critical:`
// and `blocker:` as Critical-tier frontmatter keys.
// ---------------------------------------------------------------------------
describe('Bug 2 — present_results severity-label parser', () => {
  test('frontmatter with blocker: 8 is parsed as critical: 8', () => {
    const frontmatter = [
      'phase: 03-courses',
      'reviewed: 2025-01-01T00:00:00Z',
      'findings:',
      '  blocker: 8',
      '  warning: 2',
      '  info: 0',
      '  total: 10',
      'status: issues_found',
    ].join('\n');

    const result = parseFrontmatterCritical(frontmatter);
    assert.strictEqual(result.critical, 8);
  });

  test('frontmatter with critical: 5 is parsed as critical: 5', () => {
    const frontmatter = [
      'phase: 03-courses',
      'reviewed: 2025-01-01T00:00:00Z',
      'findings:',
      '  critical: 5',
      '  warning: 1',
      '  info: 0',
      '  total: 6',
      'status: issues_found',
    ].join('\n');

    const result = parseFrontmatterCritical(frontmatter);
    assert.strictEqual(result.critical, 5);
  });

  test('frontmatter with neither critical nor blocker returns 0', () => {
    const frontmatter = [
      'phase: 03-courses',
      'findings:',
      '  warning: 3',
      '  info: 1',
      '  total: 4',
      'status: issues_found',
    ].join('\n');

    const result = parseFrontmatterCritical(frontmatter);
    assert.strictEqual(result.critical, 0);
  });

  // Docs-parity: the workflow .md must contain the updated grep pattern.
  test('code-review.md present_results grep accepts both critical and blocker labels', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(
      src.includes('grep -E "^[[:space:]]*(critical|blocker):"'),
      'code-review.md present_results must grep for both critical: and blocker: labels'
    );
  });

  // Docs-parity: the workflow .md must contain the updated grep for BL- headings.
  test('code-review.md present_results grep includes BL- headings alongside CR- and WR-', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.ok(
      src.includes('### BL-') && src.includes('### CR-') && src.includes('### WR-'),
      'code-review.md present_results must grep for BL- alongside CR- and WR- headings'
    );
  });
});

// ---------------------------------------------------------------------------
// BUG 3 — fixer agent ID alphabet and filter sets must include BL-* alongside CR-*.
// ---------------------------------------------------------------------------
describe('Bug 3 — gsd-code-fixer BL-* inclusion in filter sets', () => {
  test('finding_parser documents BL-\\d+ as Critical-tier-equivalent', () => {
    const src = fs.readFileSync(FIXER_PATH, 'utf8');
    const parserStart = src.indexOf('<finding_parser>');
    const parserEnd = src.indexOf('</finding_parser>');
    assert.ok(parserStart !== -1, 'gsd-code-fixer.md must have a <finding_parser> block');
    const parserSection = src.slice(parserStart, parserEnd);
    assert.ok(
      parserSection.includes('BL-'),
      'finding_parser block must document BL-* as a Critical-tier-equivalent ID prefix'
    );
  });

  test('parse_findings step documents severity as "Critical (CR-* or BL-*)"', () => {
    const src = fs.readFileSync(FIXER_PATH, 'utf8');
    const stepStart = src.indexOf('<step name="parse_findings">');
    const stepEnd = src.indexOf('</step>', stepStart);
    assert.ok(stepStart !== -1, 'gsd-code-fixer.md must have a parse_findings step');
    const stepSection = src.slice(stepStart, stepEnd);
    assert.ok(
      stepSection.includes('CR-* or BL-*') || stepSection.includes('CR-* and BL-*'),
      'parse_findings step must describe Critical severity as "CR-* or BL-*"'
    );
  });

  test('critical_warning filter set includes BL-* alongside CR-* and WR-*', () => {
    const src = fs.readFileSync(FIXER_PATH, 'utf8');
    const stepStart = src.indexOf('<step name="parse_findings">');
    const stepEnd = src.indexOf('</step>', stepStart);
    const stepSection = src.slice(stepStart, stepEnd);

    const critWarningIdx = stepSection.indexOf('critical_warning');
    assert.ok(critWarningIdx !== -1, 'parse_findings must define critical_warning filter');
    const lineStart = stepSection.lastIndexOf('\n', critWarningIdx);
    const lineEnd = stepSection.indexOf('\n', critWarningIdx);
    const filterLine = stepSection.slice(lineStart, lineEnd);
    assert.ok(
      filterLine.includes('BL-'),
      'critical_warning filter line must include BL-*: ' + filterLine.trim()
    );
  });

  test('sort order description mentions both CR-* and BL-* for Critical tier', () => {
    const src = fs.readFileSync(FIXER_PATH, 'utf8');
    const stepStart = src.indexOf('<step name="parse_findings">');
    const stepEnd = src.indexOf('</step>', stepStart);
    const stepSection = src.slice(stepStart, stepEnd);
    assert.ok(
      stepSection.includes('BL-'),
      'parse_findings sort-order description must mention BL-* as Critical-tier alongside CR-*'
    );
  });
});

// ---------------------------------------------------------------------------
// REVIEWER CONTRACT — gsd-code-reviewer.md must acknowledge BL-/blocker: as
// an accepted alternative to CR-/critical: (tier-equivalent).
// ---------------------------------------------------------------------------
describe('Reviewer contract — gsd-code-reviewer.md label-equivalence', () => {
  test('write_review step documents blocker: as accepted alternative to critical:', () => {
    const src = fs.readFileSync(REVIEWER_PATH, 'utf8');
    const stepStart = src.indexOf('<step name="write_review">');
    const stepEnd = src.indexOf('</step>', stepStart);
    assert.ok(stepStart !== -1, 'gsd-code-reviewer.md must have a write_review step');
    const stepSection = src.slice(stepStart, stepEnd);
    assert.ok(
      stepSection.includes('blocker'),
      'write_review step must acknowledge blocker: as a tier-equivalent alternative to critical:'
    );
  });

  test('write_review step acknowledges BL- finding ID prefix as Critical-tier-equivalent', () => {
    const src = fs.readFileSync(REVIEWER_PATH, 'utf8');
    const stepStart = src.indexOf('<step name="write_review">');
    const stepEnd = src.indexOf('</step>', stepStart);
    const stepSection = src.slice(stepStart, stepEnd);
    assert.ok(
      stepSection.includes('BL-'),
      'write_review step must acknowledge BL- as a Critical-tier-equivalent finding ID prefix'
    );
  });
});

// ---------------------------------------------------------------------------
// BUG 4 (#2352) — compute_file_scope must tilde-expand `~/...`-prefixed
// SUMMARY.md key-files entries BEFORE the "Filter deleted files" existence
// check. Bash only tilde-expands a literal `~` written in source text, never
// one arriving as the value of an already-expanded variable — so a real file
// recorded as `~/.claude/gsd-core/workflows/verify-phase.md` was silently
// misclassified as deleted and dropped from REVIEW_FILES, and a phase whose
// every recorded file used a `~/...` path hit the empty-scope skip
// ("No source files changed ... Skipping review.") as a false negative.
//
// Tested both ways: a docs-parity assertion (cross-platform, pure fs read)
// that the normalization block exists in the deployed workflow text, and a
// behavioral test that extracts the actual "Expand tilde paths" +
// "Filter deleted files" bash blocks from code-review.md and executes them
// via a real bash subprocess against planted files under a fresh HOME.
// ---------------------------------------------------------------------------
describe('Bug 4 (#2352) — compute_file_scope tilde-path expansion', () => {
  // Docs-parity: the workflow .md must contain the tilde-normalization block
  // as step 1 of "Post-processing (all tiers)", ahead of the deleted-file
  // filter, so what we behaviorally test below is what is actually deployed.
  test('code-review.md contains a tilde-expansion block ahead of the deleted-file filter', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const postProcessingIdx = src.indexOf('**Post-processing (all tiers):**');
    assert.ok(postProcessingIdx !== -1, 'code-review.md must have a "Post-processing (all tiers)" section');

    const expandIdx = src.indexOf('EXPANDED_FILES=()', postProcessingIdx);
    assert.ok(expandIdx !== -1, 'Post-processing must contain an EXPANDED_FILES=() tilde-expansion loop');

    const caseIdx = src.indexOf('case "$file" in', postProcessingIdx);
    assert.ok(caseIdx !== -1 && caseIdx < expandIdx + 400, 'tilde-expansion loop must use a case "$file" in match');
    assert.ok(
      src.slice(caseIdx, caseIdx + 200).includes('"~/"*)') &&
        src.slice(caseIdx, caseIdx + 200).includes('${HOME}${file#\\~}'),
      'tilde-expansion loop must rewrite a leading ~/ to ${HOME}/... via ${file#\\~}'
    );

    const deletedFilterIdx = src.indexOf('DELETED_COUNT=0', postProcessingIdx);
    assert.ok(deletedFilterIdx !== -1, 'Post-processing must still contain the deleted-file filter');
    assert.ok(
      expandIdx < deletedFilterIdx,
      'tilde-expansion loop must run BEFORE the deleted-file filter, not after'
    );
  });

  // Extract the tilde-expansion fence and the (non-adjacent — the exclusions
  // filter sits between them) deleted-file-filter fence from the
  // "Post-processing (all tiers)" section of code-review.md — the exact
  // snippets the runtime executes, located by content anchor rather than
  // position so an intervening step doesn't silently swap in the wrong
  // block — and glue them behind a synthetic REVIEW_FILES=("$@") seed for
  // direct execution. The exclusions filter itself is intentionally skipped
  // here: it only matches relative planning-artifact paths and is orthogonal
  // to tilde expansion (see code-review.md step 2, "Apply exclusions").
  function extractPostProcessingScript() {
    // readFileNormalized() strips \r\n -> \n before either fence below is
    // sliced out and later spawned via spawnSync('bash', ...) in
    // runPostProcessing() — an un-normalized read on a Windows checkout would
    // break bash mid-script (DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE, #2650).
    const src = readFileNormalized(WORKFLOW_PATH);
    const postProcessingIdx = src.indexOf('**Post-processing (all tiers):**');
    assert.ok(postProcessingIdx !== -1, 'code-review.md must have a "Post-processing (all tiers)" section');

    function fenceContaining(marker) {
      const markerIdx = src.indexOf(marker, postProcessingIdx);
      assert.ok(markerIdx !== -1, `expected to find "${marker}" in the Post-processing section`);
      const fenceStart = src.lastIndexOf('```bash', markerIdx);
      assert.ok(fenceStart !== -1 && fenceStart > postProcessingIdx, `no \`\`\`bash fence before "${marker}"`);
      const bodyStart = src.indexOf('\n', fenceStart) + 1;
      const fenceEnd = src.indexOf('\n```', bodyStart);
      assert.ok(fenceEnd !== -1, `unterminated \`\`\`bash fence containing "${marker}"`);
      return src.slice(bodyStart, fenceEnd);
    }

    const tildeBlock = fenceContaining('EXPANDED_FILES=()');
    const deletedBlock = fenceContaining('DELETED_COUNT=0');

    return [
      'REVIEW_FILES=("$@")',
      tildeBlock,
      deletedBlock,
      'printf "%s\\n" "${REVIEW_FILES[@]}"',
      'echo "REVIEW_FILES_COUNT=${#REVIEW_FILES[@]}"',
      'echo "DELETED_COUNT=$DELETED_COUNT"',
    ].join('\n');
  }

  function runPostProcessing(homeDir, files) {
    const script = extractPostProcessingScript();
    // "bash" as $0 so the real REVIEW_FILES entries land in "$@" from $1.
    return toLegacyResult(
      runHook('-c', [script, 'bash', ...files], {
        interpreter: 'bash',
        env: { ...process.env, HOME: homeDir },
        timeoutMs: PROBE_TIMEOUT_MS,
      })
    );
  }

  let tmpHome;

  test('setup: plant a fresh HOME with a real file', { skip: process.platform === 'win32' }, () => {
    tmpHome = createTempDir('gsd-2352-home-');
    fs.mkdirSync(path.join(tmpHome, '.claude', 'gsd-core', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.claude', 'gsd-core', 'workflows', 'verify-phase.md'),
      '# real file\n',
      'utf8'
    );
  });

  test(
    'AC1: a ~/-prefixed path to a real file survives and is not counted deleted',
    { skip: process.platform === 'win32' },
    () => {
      const result = runPostProcessing(tmpHome, ['~/.claude/gsd-core/workflows/verify-phase.md']);
      assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
      assert.match(
        result.stdout,
        new RegExp(path.join(tmpHome, '.claude', 'gsd-core', 'workflows', 'verify-phase.md').replace(/[/\\.]/g, '\\$&')),
        `expected expanded absolute path in surviving REVIEW_FILES; got: ${JSON.stringify(result.stdout)}`
      );
      assert.match(result.stdout, /DELETED_COUNT=0/, `expected DELETED_COUNT=0; got: ${JSON.stringify(result.stdout)}`);
      assert.match(
        result.stdout,
        /REVIEW_FILES_COUNT=1/,
        `expected the tilde path to survive into REVIEW_FILES; got: ${JSON.stringify(result.stdout)}`
      );
    }
  );

  test(
    'AC2: a ~/-prefixed path to a non-existent file is still correctly excluded as deleted',
    { skip: process.platform === 'win32' },
    () => {
      const result = runPostProcessing(tmpHome, ['~/.claude/gsd-core/workflows/does-not-exist.md']);
      assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
      assert.match(result.stdout, /DELETED_COUNT=1/, `expected DELETED_COUNT=1; got: ${JSON.stringify(result.stdout)}`);
      assert.match(
        result.stdout,
        /REVIEW_FILES_COUNT=0/,
        `expected the missing tilde path to be dropped; got: ${JSON.stringify(result.stdout)}`
      );
    }
  );

  test(
    'AC3: a phase where every recorded file is a real ~/-prefixed path does not empty the scope',
    { skip: process.platform === 'win32' },
    () => {
      const result = runPostProcessing(tmpHome, ['~/.claude/gsd-core/workflows/verify-phase.md']);
      assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
      const countMatch = result.stdout.match(/REVIEW_FILES_COUNT=(\d+)/);
      assert.ok(countMatch, `expected a REVIEW_FILES_COUNT line; got: ${JSON.stringify(result.stdout)}`);
      assert.ok(
        Number(countMatch[1]) > 0,
        'an all-tilde real-file scope must not reduce to zero (would trigger the empty-scope skip)'
      );
    }
  );

  test(
    'AC4: mixed tilde + missing ordinary relative path resolve independently',
    { skip: process.platform === 'win32' },
    () => {
      const result = runPostProcessing(tmpHome, [
        '~/.claude/gsd-core/workflows/verify-phase.md',
        'this/relative/path/does-not-exist.md',
      ]);
      assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
      assert.match(result.stdout, /DELETED_COUNT=1/, `expected exactly 1 deleted; got: ${JSON.stringify(result.stdout)}`);
      assert.match(
        result.stdout,
        /REVIEW_FILES_COUNT=1/,
        `expected only the tilde path to survive; got: ${JSON.stringify(result.stdout)}`
      );
      assert.doesNotMatch(
        result.stdout,
        /this\/relative\/path\/does-not-exist\.md/,
        'the missing ordinary relative path must not survive into REVIEW_FILES'
      );
    }
  );

  test('teardown: remove the temp HOME', { skip: process.platform === 'win32' }, () => {
    cleanup(tmpHome);
  });
});

// ---------------------------------------------------------------------------
// Shared diff-base extraction/execution helpers (Bug 5 #3191, Bug 6 #3503).
//
// The workflow computes "the phase's base commit" in three independent bash
// invocations (each <step> is its own shell): the Tier-3 file-scope fallback
// (compute_file_scope), the agent-context DIFF_BASE (spawn_reviewer), and the
// fallow pre-pass's --changed-since base (structural-pre-pass.md).
//
// Behavioral style follows Bug 4: extract the SHIPPED bash from the workflow
// .md files by content anchor and execute it via a real bash subprocess
// against a git fixture — so the assertion binds the deployed text, not a
// JS reimplementation. Running the real `git log` (not a regex shim) is what
// makes platform-level regex holes (the #3191 macOS `\b` no-op) visible.
// ---------------------------------------------------------------------------

// The ```bash fence containing `marker`, located after `fromIdx`.
function fenceContaining(src, marker, fromIdx = 0) {
  const markerIdx = src.indexOf(marker, fromIdx);
  assert.ok(markerIdx !== -1, `expected to find "${marker}" in workflow source`);
  const fenceStart = src.lastIndexOf('```bash', markerIdx);
  assert.ok(fenceStart !== -1, `no \`\`\`bash fence before "${marker}"`);
  const bodyStart = src.indexOf('\n', fenceStart) + 1;
  const fenceEnd = src.indexOf('\n```', bodyStart);
  assert.ok(fenceEnd !== -1, `unterminated \`\`\`bash fence containing "${marker}"`);
  return src.slice(bodyStart, fenceEnd);
}

// The Tier-3 derivation prefix: fence start up to the REVIEW_FILES branch.
function extractTier3Derivation() {
  const src = readFileNormalized(WORKFLOW_PATH);
  const fence = fenceContaining(src, '# Compute diff base from phase commits');
  const cut = fence.indexOf('if [ ${#REVIEW_FILES[@]} -eq 0 ]');
  assert.ok(cut !== -1, 'Tier-3 fence must contain the REVIEW_FILES empty-scope branch');
  return fence.slice(0, cut);
}

// spawn_reviewer's whole DIFF_BASE fence.
function extractSpawnReviewerDerivation() {
  const src = readFileNormalized(WORKFLOW_PATH);
  const spawnIdx = src.indexOf('<step name="spawn_reviewer">');
  assert.ok(spawnIdx !== -1, 'code-review.md must have a spawn_reviewer step');
  return fenceContaining(src, 'PHASE_START=$(git log', spawnIdx);
}

// The fallow phase-scope derivation, from the step fragment. The fragment
// carries markdown-escaped quotes (\") in this fence — an authoring
// artifact that survived #2994 fragmentization verbatim; the runtime agent
// normalizes them when transcribing, so the test does the same before
// executing. Sliced from FALLOW_SCOPE_ARGS=() (skipping the gsd-tools
// runtime resolver line above it, which exits 1 on machines without an
// installed gsd-tools and is orthogonal to the base-derivation under test)
// to just before the gsd_run invocation (which needs the real binary).
function extractFallowDerivation() {
  const src = readFileNormalized(PRE_PASS_STEP_PATH);
  const fence = fenceContaining(src, 'FALLOW_PHASE_START=$(git log');
  const scopeStart = fence.indexOf('FALLOW_SCOPE_ARGS=()');
  assert.ok(scopeStart !== -1, 'fallow fence must define FALLOW_SCOPE_ARGS=()');
  const cut = fence.indexOf('gsd_run run-with-timeout');
  assert.ok(cut !== -1, 'fallow fence must contain the gsd_run run-with-timeout call');
  assert.ok(scopeStart < cut, 'FALLOW_SCOPE_ARGS must precede the gsd_run invocation');
  return fence.slice(scopeStart, cut).replace(/\\"/g, '"');
}

// Execute a derivation snippet with PADDED_PHASE (and the fallow scope gate)
// set, echoing the values it computes between sentinels so multi-line
// PHASE_COMMITS parse cleanly.
function runDerivation(repo, snippet, phase) {
  const script = [
    `PADDED_PHASE=${phase}`,
    // #3995: the derivations anchor on the phase's own directory, not a
    // commit-subject grep — the fixture commits each phase's directory at
    // its first scope commit.
    `PHASE_DIR=${repo}/.planning/phases/${phase}-ctx`,
    'FALLOW_SCOPE=phase',
    snippet,
    'echo "===PHASE_START==="',
    'printf \'%s\\n\' "$PHASE_START"',
    'echo "===DIFF_BASE==="',
    'printf \'%s\\n\' "$DIFF_BASE"',
    'echo "===FALLOW_BASE==="',
    'printf \'%s\\n\' "$FALLOW_BASE"',
    'echo "===END==="',
  ].join('\n');
  // Bash FAN-OUT: the extracted snippet runs `git log` plus an `echo | tail`
  // pipe — the wrong class for `PROBE_TIMEOUT_MS` (a single short CLI
  // probe). Same class as the observed CI failures in
  // tests/quick-branching.test.cjs (PR #3787 run 32668773524) and
  // tests/worktree-safety.test.cjs (`next` run 32608945654). See
  // HOOK_FANOUT_TIMEOUT_MS in ./helpers/timeouts.cjs for the class
  // rationale.
  return toLegacyResult(
    runHook('-c', [script, 'bash'], {
      interpreter: 'bash',
      cwd: repo,
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
    })
  );
}

function parseSentinel(stdout, name) {
  const m = stdout.match(new RegExp(`===${name}===\\n([\\s\\S]*?)\\n===`));
  if (!m) return null;
  return m[1].split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Bug 5 (#3191) — EVERY diff-base derivation must use the same anchored,
// portable derivation.
//
// The workflow computes "the phase's base commit" in three independent bash
// invocations (each <step> is its own shell): the Tier-3 file-scope fallback
// (compute_file_scope), the agent-context DIFF_BASE (spawn_reviewer), and the
// fallow pre-pass's --changed-since base (structural-pre-pass.md). #2989
// anchored only the Tier-3 copy — and did so with `\b`, which is not a POSIX
// ERE token, so on macOS (regex(3)) that grep matches NOTHING and Tier 3
// always fails closed. The other two sites kept the original unanchored
// `--grep="${PADDED_PHASE}"`, whose oldest substring match is routinely a
// version-string/date commit from months before the phase existed.
// (#3503 later replaced the anchor itself — a subject-line conventional-
// commit scope match instead of the "[Pp]hase N" prose phrase, which GSD's
// own commits never contain; see Bug 6. The lockstep + portability +
// fail-closed contract THIS block verifies is unchanged.)
//
// Behavioral style follows Bug 4: extract the SHIPPED bash from the workflow
// .md files by content anchor and execute it via a real bash subprocess
// against a git fixture — so the assertion binds the deployed text, not a
// JS reimplementation. Running the real `git log` (not a regex shim) is what
// keeps platform-level regex holes (the #3191 macOS `\b` no-op) visible.
// ---------------------------------------------------------------------------
// Shared: the fixture phase directory every derivation anchors on (#3995).
const PHASE06_PLAN_REL = path.join('.planning', 'phases', '06-ctx', '06-PLAN.md');

// Shared history builder (was local to the #3503 describe; the #3995 rows
// reuse it). Each entry is [relPath, subject, body?]; parent dirs are created.
function buildHistory(prefix, commits) {
  const repo = createTempGitProject(prefix);
  const hashes = {};
  for (const [file, message, body] of commits) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), `${message}\n`);
    gitOrThrow(['add', file], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', message, ...(body ? ['-m', body] : [])], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
    hashes[file] = gitOrThrow(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim();
  }
  return { repo, hashes };
}

describe('Bug 5 (#3191) — same anchored, portable phase-scope grep at all three diff-base sites', () => {
  const SKIP_WIN32 = { skip: process.platform === 'win32' };

  // Fixture: five commits whose messages exercise every false-match class
  // from the issue — version string + date, another phase's plan whose scope
  // number is a digit-superset, a prose "Phase N" mention in another phase's
  // subject — plus the phase's real first scope commit and an unrelated HEAD.
  function buildFixture(prefix, phaseCommitMessage, opts = {}) {
    // opts.skipPhaseDir: the fail-closed row (T5) commits NO phase directory,
    // so the directory anchor must resolve nothing.
    const commitPhaseDir = opts.skipPhaseDir !== true;
    const repo = createTempGitProject(prefix);
    const phaseDir = path.join(repo, '.planning', 'phases', '06-ctx');
    fs.mkdirSync(phaseDir, { recursive: true });
    const commits = [
      ['c1.txt', 'chore: bump to v2.06.0 on 2026-01-05'],
      ['c2.txt', 'docs(60-01): unrelated phase-plan work'],
      [commitPhaseDir ? PHASE06_PLAN_REL : 'c3.txt', phaseCommitMessage],
      ['c4.txt', 'chore: Phase 60 cleanup'],
      ['c5.txt', 'docs: touch README'],
    ];
    const hashes = {};
    for (const [file, message] of commits) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), `${message}\n`);
      gitOrThrow(['add', file], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
      gitOrThrow(['commit', '-m', message], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
      hashes[file] = gitOrThrow(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim();
    }
    return { repo, hashes };
  }

  test(
    'T1 + T4: Tier-3 derivation matches ONLY the phase\'s real scope commit — never a digit-substring or superset hit',
    SKIP_WIN32,
    () => {
      const { repo, hashes } = buildFixture('gsd-3191-tier3-', 'docs(06): capture phase context');
      try {
        const result = runDerivation(repo, extractTier3Derivation(), '06');
        assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
        const phaseStart = parseSentinel(result.stdout, 'PHASE_START');
        const diffBase = parseSentinel(result.stdout, 'DIFF_BASE');
        // AC: the phase's real commits are a small minority of digit-containing
        // commits; the derivation must resolve to an ancestor near the phase's
        // actual first commit (c3^) — never the older v2.06.0/docs(06-01) hits.
        assert.deepStrictEqual(
          phaseStart,
          [hashes[PHASE06_PLAN_REL]],
          `Tier-3 anchor must resolve to the phase dir's first commit; got: ${JSON.stringify(phaseStart)}`
        );
        assert.deepStrictEqual(
          diffBase,
          [`${hashes[PHASE06_PLAN_REL]}^`],
          'Tier-3 DIFF_BASE must be the phase first-commit parent'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'T2: spawn_reviewer DIFF_BASE derivation uses the same anchored grep (not the bare digit)',
    SKIP_WIN32,
    () => {
      const { repo, hashes } = buildFixture('gsd-3191-spawn-', 'docs(06): capture phase context');
      try {
        const result = runDerivation(repo, extractSpawnReviewerDerivation(), '06');
        assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
        const phaseStart = parseSentinel(result.stdout, 'PHASE_START');
        const diffBase = parseSentinel(result.stdout, 'DIFF_BASE');
        // Pre-fix this matches c1 and c2 as well and tail -1 picks c1 — the
        // oldest unrelated match — feeding a bogus diff_base to the reviewer
        // agent exactly when files: is empty (the fail-closed scenario).
        assert.deepStrictEqual(
          phaseStart,
          [hashes[PHASE06_PLAN_REL]],
          `spawn_reviewer anchor must resolve to the phase dir's first commit; got: ${JSON.stringify(phaseStart)}`
        );
        assert.deepStrictEqual(
          diffBase,
          [`${hashes[PHASE06_PLAN_REL]}^`],
          'spawn_reviewer DIFF_BASE must be the phase first-commit parent'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'T3: fallow phase scope derives --changed-since from the anchored grep, never an old substring match',
    SKIP_WIN32,
    () => {
      const { repo, hashes } = buildFixture('gsd-3191-fallow-', 'docs(06): capture phase context');
      try {
        const result = runDerivation(repo, extractFallowDerivation(), '06');
        assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
        const fallowBase = parseSentinel(result.stdout, 'FALLOW_BASE');
        // Pre-fix the unanchored grep's oldest match is the v2.06.0 commit, so
        // FALLOW_SCOPE_ARGS resolves to --changed-since <old-unrelated-commit>
        // and widens the structural pre-pass far beyond the phase.
        assert.deepStrictEqual(
          fallowBase,
          [`${hashes[PHASE06_PLAN_REL]}^`],
          `FALLOW_BASE must be the phase first-commit parent, got: ${JSON.stringify(fallowBase)}`
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'root commit: fallow phase scope uses a resolvable root SHA',
    SKIP_WIN32,
    () => {
      const repo = createTempDir('gsd-4183-fallow-root-');
      try {
        gitOrThrow(['init', '-b', 'main'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        gitOrThrow(['config', 'user.name', 'Test'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });

        const phaseFile = path.join(repo, '.planning', 'phases', '06-ctx', 'PLAN.md');
        fs.mkdirSync(path.dirname(phaseFile), { recursive: true });
        fs.writeFileSync(phaseFile, '# phase context\n');
        gitOrThrow(['add', '.planning'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        gitOrThrow(['commit', '-m', 'docs(06): initial phase context'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        const rootSha = gitOrThrow(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim();

        fs.writeFileSync(path.join(repo, 'index.js'), 'module.exports = 1;\n');
        gitOrThrow(['add', 'index.js'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        gitOrThrow(['commit', '-m', 'feat: add source'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });

        const result = runDerivation(repo, extractFallowDerivation(), '06');
        assert.equal(result.status, 0, `snippet exited ${result.status}; stderr=${result.stderr}`);
        const fallowBase = parseSentinel(result.stdout, 'FALLOW_BASE');
        assert.deepStrictEqual(
          fallowBase,
          [rootSha],
          `root-parent FALLOW_BASE regression: expected ${rootSha}, got ${JSON.stringify(fallowBase)}`,
        );
        assert.equal(
          gitOrThrow(['rev-parse', '--verify', `${fallowBase[0]}^{commit}`], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim(),
          rootSha,
          'FALLOW_BASE must resolve to the root commit',
        );

        if (process.env.CI) {
          const { requireFallowBinary } = require('../gsd-core/bin/lib/fallow-runner.cjs');
          const { execTool } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
          const audit = execTool(
            requireFallowBinary({ cwd: ROOT, envPath: '' }),
            ['audit', '--changed-since', fallowBase[0], '--format', 'json'],
            { cwd: repo, timeout: 120000 },
          );
          assert.ok([0, 1].includes(audit.exitCode), `fallow root audit exit=${audit.exitCode}; stderr=${audit.stderr}`);
          console.log(`fallow-root-audit normal-exit=${audit.exitCode}`);
        }
      } finally {
        cleanup(repo);
      }
    },
  );

  test(
    'T5: with no genuine phase scope commit, every derivation yields NO base (fail-closed preserved)',
    SKIP_WIN32,
    () => {
      const { repo } = buildFixture('gsd-3191-closed-', 'feat: scanner core', { skipPhaseDir: true }); // no committed phase dir anywhere
      try {
        for (const [label, snippet] of [
          ['tier3', extractTier3Derivation()],
          ['spawn_reviewer', extractSpawnReviewerDerivation()],
          ['fallow', extractFallowDerivation()],
        ]) {
          const result = runDerivation(repo, snippet, '06');
          assert.equal(result.status, 0, `${label} exited ${result.status}; stderr=${result.stderr}`);
          const phaseStart = parseSentinel(result.stdout, 'PHASE_START');
          const diffBase = parseSentinel(result.stdout, 'DIFF_BASE');
          const fallowBase = parseSentinel(result.stdout, 'FALLOW_BASE');
          assert.deepStrictEqual(phaseStart, [], `${label}: no phase dir committed — anchor must stay empty`);
          assert.deepStrictEqual(diffBase, [], `${label}: DIFF_BASE must stay empty (no bogus base)`);
          assert.deepStrictEqual(fallowBase, [], `${label}: FALLOW_BASE must stay unset`);
        }
      } finally {
        cleanup(repo);
      }
    }
  );

  // T6 docs-parity anti-revert (#3191/#3995): every diff-base derivation in
  // both files must use the SAME phase-directory anchor — and no message-grep
  // derivation may return (a subject carries no milestone bound; that class
  // failed five times: #2989/#3191/#3503/#3995).
  test('T6 docs-parity: all diff-base derivations use the identical phase-directory anchor; no --grep site remains', () => {
    const sources = [
      readFileNormalized(WORKFLOW_PATH),
      readFileNormalized(PRE_PASS_STEP_PATH).replace(/\\"/g, '"'),
    ];
    for (const src of sources) {
      assert.ok(
        src.includes('PHASE_START=$(git log --format="%H" --diff-filter=A -- "${PHASE_DIR}"'),
        'each file must derive the base from the phase directory\'s first commit (#3995)'
      );
    }
    const grepSites = [];
    for (const src of sources) {
      for (const m of src.matchAll(/^\s*[A-Z_]+=\$\(git log[^\n]*--grep=[^\n]*$/gm)) {
        grepSites.push(m[0]);
      }
    }
    assert.deepStrictEqual(
      grepSites.filter((l) => l.includes('PHASE_SCOPE_NUM') || /phase-\)?\(/.test(l)),
      [],
      'no phase-scope message-grep derivation may remain — subjects carry no milestone bound (#3995)'
    );
  });
});

describe('Bug 6 (#3503/#3995) — diff base keys on the phase directory, not commit subjects', () => {
  const SKIP_WIN32 = { skip: process.platform === 'win32' };

  const REPRO_HISTORY = [
    ['c1.txt', 'chore: bump to v2.06.0 on 2026-01-05'],
    ['c2.txt', 'feat(60-01): probe wiring', 'The EF path still uses it, fenced to Phase 06 per D-09.'],
    ['c3.txt', 'docs: commit message format', 'Phase headers use the form:\n\n### Phase 06 (Cluster B): Title\n\nin ROADMAP detail sections.'],
    [PHASE06_PLAN_REL, 'docs(06): capture phase context'],
    ['c5.txt', 'feat(06-01): implement scanner core'],
    ['c6.txt', 'docs(phase-6): update tracking after wave 1'],
    ['c7.txt', 'docs: touch README'],
  ];

  test(
    'T1: prose forward-references and doc-format examples never capture the base — it resolves to the phase dir first commit at all three sites',
    SKIP_WIN32,
    () => {
      const { repo, hashes } = buildHistory('gsd-3503-scope-', REPRO_HISTORY);
      try {
        const sites = [
          ['tier3', extractTier3Derivation()],
          ['spawn_reviewer', extractSpawnReviewerDerivation()],
          ['fallow', extractFallowDerivation()],
        ];
        for (const [label, snippet] of sites) {
          const result = runDerivation(repo, snippet, '06');
          assert.equal(result.status, 0, `${label} exited ${result.status}; stderr=${result.stderr}`);
          const phaseStart = parseSentinel(result.stdout, 'PHASE_START');
          const diffBase = parseSentinel(result.stdout, 'DIFF_BASE');
          const fallowBase = parseSentinel(result.stdout, 'FALLOW_BASE');
          const dirFirst = hashes[PHASE06_PLAN_REL];
          if (label !== 'fallow') {
            assert.deepStrictEqual(
              phaseStart,
              [dirFirst],
              `${label}: anchor must resolve to the phase dir's first commit; got: ${JSON.stringify(phaseStart)}`
            );
          }
          const expected = [`${dirFirst}^`];
          if (label === 'fallow') {
            assert.deepStrictEqual(fallowBase, expected, `${label}: base must be the phase dir first commit's parent`);
          } else {
            assert.deepStrictEqual(diffBase, expected, `${label}: base must be the phase dir first commit's parent`);
          }
        }
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'T2: subject spellings are irrelevant to the directory anchor — unpadded and padded histories resolve identically',
    SKIP_WIN32,
    () => {
      const { repo, hashes } = buildHistory('gsd-3503-unpadded-', [
        ['c1.txt', 'feat(60-01): probe wiring', 'Deferred to Phase 06 per D-09.'],
        [PHASE06_PLAN_REL, 'docs(phase-6): capture phase context'],
        ['c3.txt', 'feat(6-01): implement scanner core'],
        ['c4.txt', 'test(6): persist human verification items as UAT'],
        ['c5.txt', 'docs: touch README'],
      ]);
      try {
        for (const [label, snippet] of [
          ['tier3', extractTier3Derivation()],
          ['spawn_reviewer', extractSpawnReviewerDerivation()],
          ['fallow', extractFallowDerivation()],
        ]) {
          const result = runDerivation(repo, snippet, '06');
          assert.equal(result.status, 0, `${label} exited ${result.status}; stderr=${result.stderr}`);
          const diffBase = parseSentinel(result.stdout, 'DIFF_BASE');
          const fallowBase = parseSentinel(result.stdout, 'FALLOW_BASE');
          const expected = [`${hashes[PHASE06_PLAN_REL]}^`];
          if (label === 'fallow') {
            assert.deepStrictEqual(fallowBase, expected, `${label}: base must be the phase dir first commit's parent`);
          } else {
            assert.deepStrictEqual(diffBase, expected, `${label}: base must be the phase dir first commit's parent`);
          }
        }
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'T3: no committed phase dir fails closed (no silent arbitrary base)',
    SKIP_WIN32,
    () => {
      const { repo } = buildHistory('gsd-3503-closed-', [
        ['c1.txt', 'chore: bump to v2.06.0'],
        ['c2.txt', 'feat(60-01): probe wiring', 'Deferred to Phase 06 per D-09.'],
        ['c3.txt', 'docs(06): capture phase context'],
        ['c4.txt', 'docs: touch README'],
      ]);
      try {
        for (const [label, snippet] of [
          ['tier3', extractTier3Derivation()],
          ['spawn_reviewer', extractSpawnReviewerDerivation()],
          ['fallow', extractFallowDerivation()],
        ]) {
          const result = runDerivation(repo, snippet, '06');
          assert.equal(result.status, 0, `${label} exited ${result.status}; stderr=${result.stderr}`);
          const diffBase = parseSentinel(result.stdout, 'DIFF_BASE');
          const fallowBase = parseSentinel(result.stdout, 'FALLOW_BASE');
          assert.deepStrictEqual(diffBase, [], `${label}: DIFF_BASE must stay empty without a committed phase dir`);
          assert.deepStrictEqual(fallowBase, [], `${label}: FALLOW_BASE must stay unset`);
        }
      } finally {
        cleanup(repo);
      }
    }
  );

  // #3995: the milestone-blind repro. A PREVIOUS milestone's phase-02 commit
  // exists in history with a perfectly anchored subject; the current
  // milestone's phase 02 has its own directory. The old derivation's
  // unbounded grep + tail -1 selected the archived milestone's commit and
  // took a 7-file phase to a 3388-file scope; the directory anchor cannot.
  test(
    "T4 (#3995): a previous milestone's same-numbered phase commit never captures the base",
    SKIP_WIN32,
    () => {
      const oldMilestonePhase = path.join('.planning', 'milestones', 'v1.1-phases', '02-old', '02-PLAN.md');
      const currentPhase = path.join('.planning', 'phases', '02-ctx', '02-PLAN.md');
      const { repo, hashes } = buildHistory('gsd-3995-milestone-', [
        [oldMilestonePhase, 'feat(02-01): research-project command, workflow, and template'],
        ['mid.txt', 'chore: close milestone v1.1'],
        [currentPhase, 'feat(02-01): current milestone phase 02 plan 01'],
        ['c4.txt', 'docs: touch README'],
      ]);
      try {
        for (const [label, snippet] of [
          ['tier3', extractTier3Derivation()],
          ['spawn_reviewer', extractSpawnReviewerDerivation()],
          ['fallow', extractFallowDerivation()],
        ]) {
          const result = runDerivation(repo, snippet, '02');
          assert.equal(result.status, 0, `${label} exited ${result.status}; stderr=${result.stderr}`);
          const diffBase = parseSentinel(result.stdout, 'DIFF_BASE');
          const fallowBase = parseSentinel(result.stdout, 'FALLOW_BASE');
          const expected = [`${hashes[currentPhase]}^`];
          if (label === 'fallow') {
            assert.deepStrictEqual(fallowBase, expected,
              `${label}: base must be the CURRENT phase dir's first commit, never the archived milestone's (#3995)`);
          } else {
            assert.deepStrictEqual(diffBase, expected,
              `${label}: base must be the CURRENT phase dir's first commit, never the archived milestone's (#3995)`);
          }
        }
      } finally {
        cleanup(repo);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// #3829 — execute-phase `code_review_gate`: surface the severity counts it
// already parses, and record a per-finding disposition.
//
// Before this change the gate extracted `status:` from REVIEW.md's frontmatter,
// discarded the `critical`/`warning`/`info`/`total` values sitting in the same
// `sed` range, and printed a message that was byte-identical for a review with
// one `info` finding and a review with a Critical. Nothing recorded what
// happened to any finding, so a phase reached `phase.complete` with Criticals
// standing and no trace they had been seen.
//
// Tested the way this file tests every other embedded parser: a pure-JS mirror
// of the shipped `node -e` script (validated against the shipped block during
// implementation), plus docs-parity assertions on the workflow .md text, which
// is itself the deployed contract.
// ---------------------------------------------------------------------------

// Mirror of the gate's frontmatter scalar reads. The shipped block strips CR, then takes ONLY
// the first `---` ... `---` block — it does NOT use a sed range, because a sed range re-opens on
// a body `---` and runs to EOF, which leaks body lines into an OPTIONAL key's read. This mirror
// must model that extraction, not a whole-document scan: a mirror that scans the document passes
// on a fixture the shipped code fails, which is the drift this comment exists to prevent.
function parseGateCounts(reviewText) {
  const lines = String(reviewText).replace(/\r/g, '').split('\n');
  // Only a CLOSED frontmatter block counts: an unterminated one must yield nothing rather than
  // hand the whole review body to the reads below.
  let fm = [];
  if (lines[0] === '---') {
    const buf = [];
    let closed = false;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') { closed = true; break; }
      buf.push(lines[i]);
    }
    if (closed) fm = buf;
  }
  // The shipped reads are `grep -m1 <key> | cut -d: -f2 | tr -d ' '`, and BOTH stages matter.
  // `.trim()` was wrong twice over: `tr -d ' '` removes INTERNAL spaces (`1 0` -> `10`), and
  // `cut -d: -f2` takes only the second colon-field, so a value containing a colon is truncated
  // where a `(.*)$` capture keeps the tail. Modelling the pipeline is the only way the parity
  // assertion below can mean anything.
  const first = (re) => {
    for (const line of fm) {
      const m = line.match(re);
      if (m) return line.split(':')[1].replace(/ /g, '');
    }
    return '';
  };
  // The four counts belong to the `findings:` MAPPING, so the mirror scopes to it exactly as the
  // shipped awk does: select the findings: block, stop at the next column-0 key. Without this a
  // top-level key later named `total:` / `info:` / `critical:` is picked up ahead of the nested
  // one. `status:` stays anchored at column 0 because it IS top-level.
  const findingsBlock = [];
  {
    let inBlock = false;
    for (const line of fm) {
      if (/^findings:\s*$/.test(line)) { inBlock = true; continue; }
      if (inBlock && /^\S/.test(line)) break;
      if (inBlock) findingsBlock.push(line);
    }
  }
  const firstIn = (lines, re) => {
    for (const line of lines) {
      const m = line.match(re);
      if (m) return line.split(':')[1].replace(/ /g, '');
    }
    return '';
  };
  return {
    status: first(/^status:(.*)$/),
    critical: firstIn(findingsBlock, /^\s*(?:critical|blocker):(.*)$/),
    warning: firstIn(findingsBlock, /^\s*warning:(.*)$/),
    info: firstIn(findingsBlock, /^\s*info:(.*)$/),
    total: firstIn(findingsBlock, /^\s*total:(.*)$/),
  };
}

// ── The SHIPPED disposition builder, executed — not modelled ──────────────────
//
// Rounds 1 and 2 of the pre-filing review both refuted "the mirrors are faithful": a
// hand-written model of a shell-embedded script drifts, and when it drifts the behavioural
// tests pass while the shipped block is broken. Mutation-testing confirmed it — deleting the
// carried-row logic from the shipped file turned nothing red.
//
// So the disposition tests below run the ACTUAL script. It is pure Node (every input arrives
// through process.env), so extracting it and executing it needs no shell and works on Windows.
// The only transformation is undoing the two shell escapes the surrounding double-quoted
// `node -e "…"` string requires: \` -> ` and \$ -> $.
function shippedDispositionScript() {
  const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8').replace(/\r\n/g, '\n');
  const open = src.indexOf('node -e "');
  assert.ok(open !== -1, 'the disposition step must still embed a node -e script');
  const body = src.slice(open + 'node -e "'.length);
  const end = body.indexOf('\n" || echo ');
  assert.ok(end !== -1, 'the node -e script must still be closed by its || echo fallback');
  // Undo exactly what the surrounding double-quoted shell string does, in ONE left-to-right
  // pass: inside "..." a backslash is special only before $ ` " or \\, and everything else is
  // literal. Doing these as separate passes (or missing \\\\ -> \\) silently hands the test a
  // DIFFERENT regex from the one that ships — which is how an escaped-pipe case passed here
  // while failing in the shell.
  return body.slice(0, end).replace(/\\([\\$`"])/g, '$1');
}

// Run the shipped script against a temp phase dir and return the ledger it wrote (or null).
function runShippedDisposition({ reviewText, priorText, fixText, iterFixText, padded = '01', reviewTotal }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3829-'));
  try {
    const reviewPath = path.join(dir, padded + '-REVIEW.md');
    const dispPath = path.join(dir, padded + '-REVIEW-DISPOSITION.md');
    const fixPath = path.join(dir, padded + '-REVIEW-FIX.md');
    fs.writeFileSync(reviewPath, reviewText);
    if (priorText !== undefined) fs.writeFileSync(dispPath, priorText);
    if (fixText !== undefined) fs.writeFileSync(fixPath, fixText);
    // The --auto loop's per-iteration backups (<NN>-REVIEW-FIX.iterN.md). Keyed by iteration
    // number so a test can drive the ordering the script relies on (newest wins).
    for (const [n, text] of Object.entries(iterFixText || {})) {
      fs.writeFileSync(path.join(dir, padded + '-REVIEW-FIX.iter' + n + '.md'), text);
    }
    // Bounded by construction via the process seam — an unbounded spawn is an indefinite hang.
    const res = runNode(['-e', shippedDispositionScript()], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        REVIEW_FILE: reviewPath,
        DISPOSITION_FILE: dispPath,
        FIX_REPORT_FILE: fixPath,
        PADDED: padded,
        // The frontmatter total block 2 derives and hands to the script, so the two parsers can
        // be reconciled. Passed through here so a test can drive the shortfall path.
        REVIEW_TOTAL: reviewTotal === undefined ? '' : String(reviewTotal),
      },
    });
    assert.strictEqual(res.outcome, OUTCOME.EXITED, 'the shipped script must run to completion');
    assert.strictEqual(res.exitCode, 0, 'the shipped script must exit 0: ' + res.stderr);
    const ledger = fs.existsSync(dispPath) ? fs.readFileSync(dispPath, 'utf8') : null;
    return { ledger, stdout: res.stdout, wroteNothing: /disposition unchanged/.test(res.stdout) };
  } finally {
    cleanup(dir);
  }
}

// Parse the rows out of a rendered ledger, so assertions read against real output.
function ledgerRows(ledger) {
  if (ledger === null) return null;
  const rows = [];
  for (const line of ledger.split('\n')) {
    const m = line.match(/^\|\s*((?:CR|BL|WR|IN)-\d+)\s*\|\s*([a-z]+)\s*\|\s*([a-z]+)\s*\|\s*(.*?)\s*\|$/);
    if (m) rows.push({ id: m[1], severity: m[2], disposition: m[3], source: m[4] });
  }
  return rows;
}

// buildDisposition is NOT a mirror any more — it drives the SHIPPED script.
//
// Three pre-filing review rounds each refuted "the mirror is faithful", and mutation testing
// confirmed the cost: a hand-written model of a shell-embedded script drifts, and when it drifts
// the tests pass while the shipped block is broken. The model is gone; this adapter runs the real
// thing and returns the same shape the assertions below already expect.
function buildDisposition({ reviewText, priorText, fixText, padded = '01', reviewTotal }) {
  const rows = ledgerRows(runShippedDisposition({ reviewText, priorText, fixText, padded, reviewTotal }).ledger);
  if (rows === null) return null;
  return {
    rows: rows.map((r) => ({
      ...r,
      carried: / \(not in the current review\)$/.test(r.source) || undefined,
      source: r.source.replace(/ \(not in the current review\)$/, ''),
    })),
    open: rows.filter((r) => r.disposition === 'open').length,
    total: rows.length,
  };
}

const REVIEW_WITH_FINDINGS = [
  '---',
  'phase: 01',
  'findings:',
  '  critical: 1',
  '  warning: 2',
  '  info: 1',
  '  total: 4',
  'status: issues_found',
  '---',
  '',
  '## Critical Issues',
  '',
  '### CR-01: SQL injection in auth',
  '',
  '## Warnings',
  '',
  '### WR-01: missing null check',
  '',
  '### WR-02: unused import',
  '',
  '## Info',
  '',
  '### IN-01: stale TODO',
].join('\n');

describe('#3829 — code_review_gate severity surfacing', () => {
  test('the gate reads the counts that sit beside the status it already parsed', () => {
    const parsed = parseGateCounts(REVIEW_WITH_FINDINGS);
    assert.deepStrictEqual(parsed, {
      status: 'issues_found', critical: '1', warning: '2', info: '1', total: '4',
    });
  });

  test('blocker: is accepted as the Critical tier-equivalent of critical:', () => {
    const parsed = parseGateCounts(REVIEW_WITH_FINDINGS.replace('  critical: 1', '  blocker: 1'));
    assert.strictEqual(parsed.critical, '1');
  });

  test('a status:/total: line in the review BODY never displaces the frontmatter value', () => {
    // The `sed -n '/^---$/,/^---$/p'` range re-opens on a body `---` and runs to
    // EOF, so first-match (`grep -m1`) is what makes this correct — not the range.
    const poisoned = REVIEW_WITH_FINDINGS + '\n\n---\n\nstatus: clean\ntotal: 999\n';
    const parsed = parseGateCounts(poisoned);
    assert.strictEqual(parsed.status, 'issues_found');
    assert.strictEqual(parsed.total, '4');
  });

  test('a REVIEW.md with no findings: block yields no counts, so the gate can fall back', () => {
    const legacy = ['---', 'phase: 02', 'status: issues_found', '---', '', '# Phase 02'].join('\n');
    const parsed = parseGateCounts(legacy);
    assert.strictEqual(parsed.status, 'issues_found');
    assert.strictEqual(parsed.total, '');
    assert.strictEqual(parsed.critical, '');
  });


  test('docs-parity: the gate states the counts rather than the countless message alone', () => {
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    assert.ok(
      src.includes('Code review: ${REVIEW_TOTAL} findings — ${REVIEW_CRITICAL} critical, ${REVIEW_WARNING} warning, ${REVIEW_INFO} info.'),
      'code_review_gate must display the per-severity breakdown it parsed'
    );
  });

  test('docs-parity: every frontmatter scalar read carries a first-match guard', () => {
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    assert.ok(
      src.includes('grep -m1 "^status:"'),
      'the status: read must keep its single-match guard (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP)'
    );
  });
});

describe('#3829 — code_review_gate per-finding disposition record', () => {
  test('every finding is recorded, defaulting to open', () => {
    const d = buildDisposition({ reviewText: REVIEW_WITH_FINDINGS, padded: '01' });
    assert.strictEqual(d.total, 4);
    assert.strictEqual(d.open, 4);
    assert.deepStrictEqual(d.rows.map((r) => r.id), ['CR-01', 'WR-01', 'WR-02', 'IN-01']);
    assert.deepStrictEqual(d.rows.map((r) => r.severity), ['critical', 'warning', 'warning', 'info']);
  });

  test('BL- findings are recorded at the Critical tier alongside CR-', () => {
    const d = buildDisposition({
      reviewText: REVIEW_WITH_FINDINGS.replace('### CR-01:', '### BL-01:'),
      padded: '01',
    });
    assert.strictEqual(d.rows[0].id, 'BL-01');
    assert.strictEqual(d.rows[0].severity, 'critical');
  });

  test('--fix outcomes are reconciled from REVIEW-FIX.md with provenance', () => {
    const fixText = [
      '# Phase 01: Code Review Fix Report',
      '',
      '## Fixed Issues',
      '',
      '### WR-01: missing null check',
      '',
      '## Skipped Issues',
      '',
      '### WR-02: unused import',
    ].join('\n');
    const d = buildDisposition({ reviewText: REVIEW_WITH_FINDINGS, fixText, padded: '01' });
    const byId = Object.fromEntries(d.rows.map((r) => [r.id, r]));
    assert.strictEqual(byId['WR-01'].disposition, 'fixed');
    assert.strictEqual(byId['WR-01'].source, '01-REVIEW-FIX.md');
    assert.strictEqual(byId['WR-02'].disposition, 'skipped');
    assert.strictEqual(byId['CR-01'].disposition, 'open');
    assert.strictEqual(d.open, 2);
  });

  test('a finding heading outside the Fixed/Skipped sections is not a disposition', () => {
    const fixText = [
      '## Fixed Issues',
      '',
      '### WR-01: missing null check',
      '',
      '## Verification',
      '',
      '### IN-01: mentioned while describing how the fix was verified',
    ].join('\n');
    const d = buildDisposition({ reviewText: REVIEW_WITH_FINDINGS, fixText, padded: '01' });
    const byId = Object.fromEntries(d.rows.map((r) => [r.id, r]));
    assert.strictEqual(byId['WR-01'].disposition, 'fixed');
    assert.strictEqual(byId['IN-01'].disposition, 'open');
  });

  test('a recorded decision survives a re-run — open never overwrites deferred', () => {
    const priorText = [
      '| Finding | Severity | Disposition | Source |',
      '|---------|----------|-------------|--------|',
      '| CR-01 | critical | deferred | ships next phase |',
      '| WR-01 | warning | open | - |',
    ].join('\n');
    const d = buildDisposition({ reviewText: REVIEW_WITH_FINDINGS, priorText, padded: '01' });
    const byId = Object.fromEntries(d.rows.map((r) => [r.id, r]));
    assert.strictEqual(byId['CR-01'].disposition, 'deferred');
    // The source cell carries the human's stated reason and is preserved, not replaced.
    assert.strictEqual(byId['CR-01'].source, 'ships next phase');
    assert.strictEqual(d.open, 3);
  });

  test('an applied --fix outcome wins over an earlier deferral', () => {
    const priorText = '| CR-01 | critical | deferred | later |';
    const fixText = ['## Fixed Issues', '', '### CR-01: SQL injection in auth'].join('\n');
    const d = buildDisposition({ reviewText: REVIEW_WITH_FINDINGS, priorText, fixText, padded: '01' });
    assert.strictEqual(d.rows[0].disposition, 'fixed');
  });

  test('a review with no finding headings produces no record at all', () => {
    const legacy = ['---', 'phase: 02', 'status: issues_found', '---', '', 'prose only'].join('\n');
    assert.strictEqual(buildDisposition({ reviewText: legacy, padded: '02' }), null);
  });

  test('docs-parity: the gate writes a REVIEW-DISPOSITION sibling, not into REVIEW.md', () => {
    // Eighth src.includes() converted. It pinned the literal `${PHASE_DIR}` interpolation, so it
    // went red when path construction moved to a VALIDATED local -- while the property it names,
    // "a REVIEW-DISPOSITION sibling", was untouched. Assert the property: the ledger lands beside
    // the review, under the derived name, and REVIEW.md itself is not written.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3861-sib-'));
    try {
      const reviewPath = path.join(dir, '02-REVIEW.md');
      const reviewText = ['---', 'status: issues_found', '---', '', '### CR-01: a finding'].join('\n');
      fs.writeFileSync(reviewPath, reviewText);
      const res = runNode(['-e', shippedDispositionScript()], {
        timeoutMs: PROBE_TIMEOUT_MS,
        env: {
          ...process.env,
          REVIEW_FILE: reviewPath,
          DISPOSITION_FILE: path.join(dir, '02-REVIEW-DISPOSITION.md'),
          FIX_REPORT_FILE: path.join(dir, '02-REVIEW-FIX.md'),
          PADDED: '02',
        },
      });
      assert.strictEqual(res.exitCode, 0, res.stderr);
      assert.ok(fs.existsSync(path.join(dir, '02-REVIEW-DISPOSITION.md')),
        'code_review_gate must write the disposition record to a REVIEW-DISPOSITION sibling');
      assert.strictEqual(fs.readFileSync(reviewPath, 'utf8'), reviewText,
        'and must not write into REVIEW.md — gsd-code-reviewer is its single writer');
    } finally {
      cleanup(dir);
    }
    // Sixth src.includes() converted. It pinned the exact SOURCE LINE of the enumeration loop, so
    // it went red when M3 reformatted that loop to track the enclosing section -- while the
    // property it names, "enumerate every finding ID", was strictly widened rather than broken.
    // A pin on a code shape reports every refactor as a regression and no regression as one.
    const review = ['---', 'phase: 01', 'status: issues_found', '---', '',
      '### CR-01: a', '### WR-01: b', '### IN-01: c',
      '### CR-01: a duplicate id, which must not produce a second row'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: review }).ledger);
    assert.deepStrictEqual(
      rows.map((r) => r.id), ['CR-01', 'WR-01', 'IN-01'],
      'code_review_gate must enumerate every finding ID from REVIEW.md, in order, once each'
    );
  });

  test('docs-parity: code_review_gate actually reaches the extracted step', () => {
    // The step is only reachable because the parent says to read and execute it. Without this,
    // every other docs-parity assertion here could pass against a file nothing loads.
    const parent = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf8');
    assert.ok(
      /Read and execute\s+`gsd-core\/workflows\/execute-phase\/steps\/code-review-disposition\.md`/.test(parent),
      'code_review_gate must read and execute the disposition step'
    );
    assert.ok(
      parent.indexOf('code-review-disposition.md') < parent.indexOf('**TDD review escalation'),
      'and must do so before the TDD escalation can stop the phase'
    );
  });

  test('docs-parity: the disposition write is non-blocking', () => {
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    assert.ok(
      src.includes('Code review disposition record skipped (non-blocking).'),
      'the disposition write must never block execution flow'
    );
  });
});

// ---------------------------------------------------------------------------
// #3829 review round — the seven defects a cross-AI adversarial pass on the fix
// diff refuted before filing. Each is pinned here so the round's work survives.
// ---------------------------------------------------------------------------
describe('#3829 review round — frontmatter scoping, section anchoring, ledger durability', () => {
  test('an OPTIONAL count absent from frontmatter is not supplied by a leaked body value', () => {
    // A sed range re-opens on a body `---` and runs to EOF. First-match protects a key the
    // frontmatter DOES carry; it cannot protect one it does not. Extraction must stop at the
    // closing delimiter, or a body `total:` becomes the reported finding count.
    const leaky = [
      '---', 'phase: 01', 'status: issues_found', '---',
      '', '# Report', '', '---', '', 'total: 7', 'critical: 9',
    ].join('\n');
    const parsed = parseGateCounts(leaky);
    assert.strictEqual(parsed.status, 'issues_found');
    assert.strictEqual(parsed.total, '', 'a body total: must not become the finding count');
    assert.strictEqual(parsed.critical, '', 'a body critical: must not become the critical count');
  });

  test('a CRLF-authored review parses to bare values, with no carriage return riding along', () => {
    const crlf = [
      '---', 'phase: 01', 'findings:', '  critical: 1', '  warning: 0', '  info: 2',
      '  total: 3', 'status: issues_found', '---', '', '### CR-01: a',
    ].join('\r\n');
    const parsed = parseGateCounts(crlf);
    assert.deepStrictEqual(parsed, {
      status: 'issues_found', critical: '1', warning: '0', info: '2', total: '3',
    });
    for (const v of Object.values(parsed)) assert.ok(!/\r/.test(v), 'no value may carry a CR');
  });

  test('docs-parity: the gate stops at the closing delimiter and strips CR before parsing', () => {
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    assert.ok(
      src.includes(`awk 'NR==1{if($0!="---") exit; next} /^---$/{closed=1; exit}`),
      'the gate must extract only the FIRST frontmatter block, not a re-opening sed range'
    );
    assert.ok(
      src.includes(`tr -d '\\r' < "$REVIEW_FILE"`),
      'the gate must strip CR so a CRLF review cannot inject one into the message'
    );
  });

  test('a section heading that merely STARTS with "Fixed Issues" does not classify findings', () => {
    const fixText = [
      '# Fix report', '', '## Fixed Issues Verification', '', '### IN-01: named while verifying',
    ].join('\n');
    const d = buildDisposition({ reviewText: REVIEW_WITH_FINDINGS, fixText, padded: '01' });
    const byId = Object.fromEntries(d.rows.map((r) => [r.id, r]));
    assert.strictEqual(byId['IN-01'].disposition, 'open');
  });

  test('a deferral reason written into the Source cell survives a re-run verbatim', () => {
    const priorText = '| CR-01 | critical | deferred | ships next phase, see ADR-99 |';
    const d = buildDisposition({ reviewText: REVIEW_WITH_FINDINGS, priorText, padded: '01' });
    const cr = d.rows.find((r) => r.id === 'CR-01');
    assert.strictEqual(cr.disposition, 'deferred');
    assert.strictEqual(cr.source, 'ships next phase, see ADR-99');
  });

  test('a decided finding the current review no longer reports is carried, not dropped', () => {
    // --auto re-reviews and rewrites REVIEW.md; a fixed or deferred finding can vanish from it.
    // Dropping the row would erase the record that it was seen — the exact failure #3829 is about.
    const priorText = [
      '| CR-01 | critical | deferred | ships next phase |',
      '| IN-01 | info | open | - |',
    ].join('\n');
    const shrunk = ['---', 'status: issues_found', '---', '', '### WR-01: still here'].join('\n');
    const d = buildDisposition({ reviewText: shrunk, priorText, padded: '01' });
    const byId = Object.fromEntries(d.rows.map((r) => [r.id, r]));
    assert.ok(byId['CR-01'], 'a deferred finding absent from the review must still be recorded');
    assert.strictEqual(byId['CR-01'].disposition, 'deferred');
    assert.strictEqual(byId['CR-01'].carried, true);
    assert.strictEqual(byId['CR-01'].source, 'ships next phase');
    // M1: the untriaged row is carried TOO, and marked. Dropping it erased the record that the
    // finding was ever seen -- which is #3829's complaint verbatim, reproduced by the artifact
    // built to prevent it. 'Nothing was decided about it' is precisely the state that must leave
    // a trace. The marker keeps it honest: the row does not claim the finding is live.
    assert.ok(byId['IN-01'], 'an untriaged row for a vanished finding is carried, not deleted');
    assert.strictEqual(byId['IN-01'].disposition, 'open');
    assert.strictEqual(byId['IN-01'].carried, true);
  });

  test('the carried marker is rendered, never stored — it cannot accumulate across runs', () => {
    // The marker lives in the Source cell, which is re-parsed on the next run. Storing it would
    // re-append it every time: the cell grows without bound AND the file changes on every run,
    // which silently defeats the unchanged-run check and restores the empty-docs-commit churn.
    const shrunk = ['---', 'status: issues_found', '---', '', '### WR-01: b'].join('\n');
    let priorText = '| CR-01 | critical | deferred | ships next phase |';
    let cr;
    for (let i = 0; i < 3; i++) {
      const d = buildDisposition({ reviewText: shrunk, priorText, padded: '01' });
      cr = d.rows.find((r) => r.id === 'CR-01');
      // Re-render the row the way the shipped builder does, and feed it back in.
      priorText = '| ' + cr.id + ' | ' + cr.severity + ' | ' + cr.disposition + ' | ' +
        cr.source + (cr.carried ? ' (not in the current review)' : '') + ' |';
    }
    assert.strictEqual(cr.source, 'ships next phase', 'the stored source must stay canonical');
    assert.strictEqual(
      (priorText.match(/\(not in the current review\)/g) || []).length, 1,
      'the marker must appear exactly once no matter how many times the gate re-runs'
    );
  });

  test('docs-parity: the ledger is rewritten only on a real change, timestamp excluded', () => {
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    assert.ok(
      src.includes("const stripTs = (t) => t.replace(/^recorded:.*\\$/m, 'recorded:');"),
      'the gate must compare ignoring the timestamp so an unchanged run writes nothing'
    );
    assert.ok(
      src.includes('Code review disposition unchanged: '),
      'an unchanged run must say so rather than producing an empty docs commit'
    );
  });

  test('docs-parity: section headings are anchored whole and the prior source cell is captured', () => {
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    assert.ok(
      src.includes('/^##\\s+Fixed Issues\\s*\\$/') && src.includes('/^##\\s+Skipped Issues\\s*\\$/'),
      'fix-report section headings must be matched whole, never by prefix'
    );
    // Eighth src.includes() converted -- it pinned the exact source-cell CAPTURE, and that
    // capture was the round-3 defect (a bare | failed the whole match). The property it named
    // is asserted behaviourally below: 'an escaped pipe in a deferral reason survives whole'
    // and 'a bare pipe in a deferral reason is kept as prose'.
    // Seventh src.includes() converted -- it pinned the exact comparison EXPRESSION, so it went
    // red when the comparison gained whitespace normalization while the property it names was
    // unchanged. Assert the property instead: a fix report naming a different finding under a
    // reused id does not decide the row.
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: a new finding'].join('\n');
    const stale = ['## Fixed Issues', '', '### CR-01: what this id used to mean'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: review, fixText: stale }).ledger);
    assert.strictEqual(rows[0].disposition, 'open',
      'a fix report must name the SAME finding before its outcome is applied');
  });
});

describe('#3861 round 2 — the disposition ledger is reachable in a shipped path (B1c/B1d)', () => {
  const FIX_WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'code-review-fix.md');

  test('code-review-fix.md reads and executes the disposition step after committing the fix report', () => {
    // Without this the reconciliation logic -- the bulk of the step and nearly all of its test
    // surface -- is reachable only on a RE-EXECUTION of the phase, and REQ-REVIEW-10 is unmet in
    // every shipped path. execute-phase.md's gate invokes review with neither --fix nor --auto,
    // so REVIEW-FIX.md cannot exist there and every row it writes is `open` by construction.
    const src = fs.readFileSync(FIX_WORKFLOW, 'utf8');
    assert.match(src, /<step name="record_disposition">/,
      'the fix workflow must carry a step that records the disposition');
    assert.match(src, /gsd-core\/workflows\/execute-phase\/steps\/code-review-disposition\.md/,
      'and it must invoke the SAME step, not a second copy of the logic');
    // Ordering is load-bearing: the fix report must be on disk before the ledger claims anything
    // about it. Assert the step positions rather than merely their presence.
    const commitAt = src.indexOf('<step name="commit_fix_report">');
    const recordAt = src.indexOf('<step name="record_disposition">');
    const presentAt = src.indexOf('<step name="present_results">');
    assert.ok(commitAt > -1 && recordAt > -1 && presentAt > -1, 'all three steps must exist');
    assert.ok(commitAt < recordAt, 'the ledger is reconciled AFTER the fix report is written');
    assert.ok(recordAt < presentAt, 'and before results are presented');
  });

  test('the iteration backups are removed AFTER the ledger has read them, not inside the loop', () => {
    // #3861 round 5. The .iterN.md backups are the only surviving record of what an earlier --auto
    // iteration fixed -- this workflow keeps ONE final version of each artifact, and the re-review
    // drops a finding once it is fixed, so neither final artifact carries it. Deleting them at the
    // end of the loop meant record_disposition reached a CONVERGED run with every early fix already
    // erased and recorded those findings as open.
    const src = fs.readFileSync(FIX_WORKFLOW, 'utf8');
    const recordAt = src.indexOf('<step name="record_disposition">');
    const cleanupAt = src.indexOf('<step name="cleanup_iteration_backups">');
    assert.ok(cleanupAt > -1, 'the backups must be removed by a named step, not inline in the loop');
    assert.ok(recordAt < cleanupAt, 'the ledger reads the backups BEFORE they are removed');
    // And the removal must not have been left behind in the loop as well.
    const loopAt = src.indexOf('<step name="auto_iteration_loop">');
    const loopBody = src.slice(loopAt, src.indexOf('<step name="commit_fix_report">'));
    assert.ok(!/rm -f "\$\{REVIEW_PATH%\.md\}\.iter"/.test(loopBody),
      'the loop must no longer delete the backups it just wrote');
  });

  test('the reconciliation is reachable: gate writes all-open, the fix path resolves it', () => {
    // The two call sites driven in sequence, which is the shipped order. This is the review's own
    // input -> wrong output case, inverted: a phase whose findings are all fixed by a subsequent
    // --fix run used to end at `open: N / total: N`, asserting that every triaged finding was
    // forgotten -- worse than recording nothing, because it looks authoritative and is inverted.
    const review = ['---', 'phase: 01', 'status: issues_found', 'findings:',
      '  critical: 1', '  warning: 1', '  info: 0', '  total: 2', '---', '',
      '## Critical Issues', '', '### CR-01: the critical one', '',
      '## Warnings', '', '### WR-01: the warning one'].join('\n');
    const fixReport = ['---', 'status: complete', '---', '',
      '## Fixed Issues', '', '### CR-01: the critical one', '',
      '## Skipped Issues', '', '### WR-01: the warning one'].join('\n');

    // Call site 1 -- execute-phase.md's code_review_gate. No fix report exists yet.
    const gate = runShippedDisposition({ reviewText: review, reviewTotal: 2 });
    const gateRows = ledgerRows(gate.ledger);
    assert.deepStrictEqual(gateRows.map((r) => r.disposition), ['open', 'open'],
      'at the gate there is no fix report, so every row is open -- correctly');

    // Call site 2 -- code-review-fix.md's record_disposition, with the report on disk and the
    // gate's ledger carried in as prior state.
    const after = runShippedDisposition({
      reviewText: review, priorText: gate.ledger, fixText: fixReport, reviewTotal: 2,
    });
    const rows = ledgerRows(after.ledger);
    assert.deepStrictEqual(
      rows.map((r) => [r.id, r.disposition]),
      [['CR-01', 'fixed'], ['WR-01', 'skipped']],
      'the fix outcomes reach the ledger'
    );
    assert.match(after.ledger, /^open: 0$/m, 'and the headline agrees');
    assert.match(after.ledger, /^total: 2$/m);
  });
});

describe('#3861 round 2 — severity comes from the section, not just the id prefix (M3)', () => {
  const sevOf = (reviewText, id) => {
    const rows = ledgerRows(runShippedDisposition({ reviewText }).ledger);
    const row = rows.find((r) => r.id === id);
    assert.ok(row, id + ' must have a row');
    return row.severity;
  };

  test("a Critical mis-numbered as WR- is recorded critical when it sits under '## Critical Issues'", () => {
    // The section heading is the reviewer's OWN statement of severity, and the walker already
    // visits it. Deriving from the prefix alone puts the ledger's Severity column -- the whole
    // basis for triaging it -- in disagreement with the review it summarizes and with the
    // frontmatter count line block 1 prints.
    const review = ['---', 'phase: 01', 'status: issues_found', '---', '',
      '## Critical Issues', '', '### CR-01: properly numbered', '',
      '### WR-04: a critical the reviewer mis-numbered', '',
      '## Info', '', '### IN-01: an info item'].join('\n');
    assert.strictEqual(sevOf(review, 'WR-04'), 'critical', 'the section outranks the prefix');
    assert.strictEqual(sevOf(review, 'CR-01'), 'critical');
    assert.strictEqual(sevOf(review, 'IN-01'), 'info');
  });

  test('an IN- finding under ## Warnings is recorded warning', () => {
    // The other direction, so the rule is not one-way: the section governs whichever way the
    // prefix disagrees with it.
    const review = ['---', 'phase: 01', 'status: issues_found', '---', '',
      '## Warnings', '', '### IN-02: mis-numbered the other way'].join('\n');
    assert.strictEqual(sevOf(review, 'IN-02'), 'warning');
  });

  test('the id prefix still governs when no recognized section encloses the finding', () => {
    // Fallback control. A review that does not use the documented headings -- and every carried
    // row from an earlier review -- must keep the prefix mapping, BL- included.
    const review = ['---', 'phase: 01', 'status: issues_found', '---', '',
      '### CR-01: a', '### BL-02: b', '### WR-03: c', '### IN-04: d'].join('\n');
    assert.strictEqual(sevOf(review, 'CR-01'), 'critical');
    assert.strictEqual(sevOf(review, 'BL-02'), 'critical', 'BL- stays Critical-tier-equivalent');
    assert.strictEqual(sevOf(review, 'WR-03'), 'warning');
    assert.strictEqual(sevOf(review, 'IN-04'), 'info');
  });

  test('a lookalike section heading does not re-tier the findings under it', () => {
    // Matched WHOLE, exactly as the fix-report sections are. A prefix match would let
    // '## Critical Issues Verification' promote everything beneath it.
    const review = ['---', 'phase: 01', 'status: issues_found', '---', '',
      '## Critical Issues Verification', '', '### IN-05: not actually critical'].join('\n');
    assert.strictEqual(sevOf(review, 'IN-05'), 'info', 'an unrecognized section falls back to the prefix');
  });

  test('a section heading inside a fenced example does not govern', () => {
    // The fence walker already skips fenced content; this pins that the new section tracking
    // honours it rather than reading an illustration as document structure.
    const review = ['---', 'phase: 01', 'status: issues_found', '---', '',
      '```markdown', '## Critical Issues', '```', '', '### IN-06: outside the fence'].join('\n');
    assert.strictEqual(sevOf(review, 'IN-06'), 'info');
  });
});

describe('#3861 round 2 — a finding the heading parser cannot match is SURFACED, not dropped (B4)', () => {
  // Two independent parsers produce two numbers one paragraph apart: the counts come from
  // REVIEW.md's frontmatter, the rows from `### <ID>:` heading matches against a CLOSED
  // CR|BL|WR|IN alternation. Nothing reconciled them, so a finding the alternation cannot reach
  // contributed no row, no note and no diagnostic -- and the ledger asserted `open: N of N` over
  // a set strictly smaller than the console line had just reported.
  const REVIEW_5 = ['---', 'phase: 01', 'status: issues_found', 'findings:',
    '  critical: 1', '  warning: 2', '  info: 2', '  total: 5', '---', '',
    '### CR-01: a conforming finding',
    '### WR-01: another conforming one',
    '### WR-02: a third',
    '### SEC-01: a prefix the alternation does not carry',
    '#### IN-09: a heading one level too deep'].join('\n');

  test('the shortfall is stated in the ledger frontmatter and on the console', () => {
    const out = runShippedDisposition({ reviewText: REVIEW_5, reviewTotal: 5 });
    assert.match(out.ledger, /^unparsed: 2$/m,
      'the ledger must record that two findings reached no row');
    assert.match(out.ledger, /^total: 3$/m, 'and must still report the rows it does have');
    assert.match(out.stdout, /2 finding\(s\) recorded NOWHERE/,
      'the console line must say so too -- the ledger is not the only surface a human reads');
    assert.match(out.stdout, /the review reports 5, but only 3 matched/,
      'and must name both numbers, so the shortfall is checkable rather than asserted');
  });

  test('a review whose findings all parse gains no unparsed key at all', () => {
    // Negative control for the key itself. An ordinary ledger must not grow a noise key, or the
    // unchanged-run check starts rewriting the file on every phase.
    const clean = ['---', 'phase: 01', 'status: issues_found', 'findings:',
      '  critical: 1', '  warning: 0', '  info: 0', '  total: 1', '---', '',
      '### CR-01: the only finding'].join('\n');
    const out = runShippedDisposition({ reviewText: clean, reviewTotal: 1 });
    assert.doesNotMatch(out.ledger, /^unparsed:/m, 'nothing was dropped, so nothing is reported');
    assert.doesNotMatch(out.stdout, /recorded NOWHERE/);
  });

  test('an absent or non-numeric total reconciles nothing rather than inventing a shortfall', () => {
    // The reconciliation needs a number on BOTH sides. A legacy review with no findings: block
    // has no total to compare against, and reporting `unparsed: 3` there would be a fabrication.
    const legacy = ['---', 'phase: 01', 'status: issues_found', '---', '',
      '### CR-01: a', '### WR-01: b'].join('\n');
    const out = runShippedDisposition({ reviewText: legacy, reviewTotal: '' });
    assert.doesNotMatch(out.ledger, /^unparsed:/m);
    assert.match(out.ledger, /^total: 2$/m);
  });

  test('a total SMALLER than the rows is not reported as a negative shortfall', () => {
    // Boundary in the other direction: the subtraction is clamped, so a review under-reporting
    // its own total cannot produce `unparsed: -1`.
    const out = runShippedDisposition({
      reviewText: ['---', 'phase: 01', 'status: issues_found', 'findings:', '  total: 1', '---', '',
        '### CR-01: a', '### WR-01: b'].join('\n'),
      reviewTotal: 1,
    });
    assert.doesNotMatch(out.ledger, /^unparsed:/m, 'no shortfall when more parsed than declared');
    assert.doesNotMatch(out.ledger, /unparsed: -/);
  });
});

describe('#3829 review round 2 — a review that reports nothing still reconciles the ledger', () => {
  const EMPTY_REVIEW = ['---', 'phase: 01', 'status: issues_found', '---', '', 'no findings'].join('\n');

  test('a decided row is carried when the review reports no findings at all', () => {
    // Exiting early on an empty review would freeze a stale ledger showing findings as open that
    // the review no longer reports — the opposite of what this record exists to do.
    const priorText = [
      '| CR-01 | critical | deferred | ships next phase |',
      '| WR-01 | warning | open | - |',
    ].join('\n');
    const d = buildDisposition({ reviewText: EMPTY_REVIEW, priorText, padded: '01' });
    // M1: BOTH rows survive. The decided one because it was triaged, the untriaged one because
    // it was not -- and an untriaged finding vanishing without trace is the defect #3829 names.
    assert.strictEqual(d.total, 2, 'both rows survive; neither is silently deleted');
    assert.deepStrictEqual(d.rows.map((r) => r.id), ['CR-01', 'WR-01']);
    assert.strictEqual(d.rows[0].disposition, 'deferred');
    assert.strictEqual(d.rows[0].carried, true);
    assert.strictEqual(d.rows[1].disposition, 'open');
    assert.strictEqual(d.rows[1].carried, true);
    assert.strictEqual(d.open, 1, 'the untriaged carried row is still open, and the count says so');
  });

  test('a review with no findings and no prior ledger produces nothing at all', () => {
    assert.strictEqual(buildDisposition({ reviewText: EMPTY_REVIEW, padded: '01' }), null);
  });

  // Ninth src.includes() retired (round 3): it pinned the guard's exact line, including the
  // process.exit(0) the script no longer calls, so it went red on a change that left the property
  // untouched. The property -- an empty review still reconciles an EXISTING ledger -- is asserted
  // behaviourally by the round-2 describe '#3829 review round 2 — a review that reports nothing
  // still reconciles the ledger' below, which drives the shipped script against a prior ledger.

});

// ---------------------------------------------------------------------------
// #3829 — the SHIPPED disposition script, driven. These tests execute the real
// embedded script (see shippedDispositionScript), so a regression in the
// workflow file turns them red. The mirror-based tests above are kept for the
// pure parsing shapes; these are the ones that hold the contract.
// ---------------------------------------------------------------------------
describe('#3829 — shipped disposition script (executed, not mirrored)', () => {
  const REVIEW = ['---', 'phase: 01', 'status: issues_found', '---', '',
    '### CR-01: a', '', '### WR-01: b', '', '### IN-01: c'].join('\n');

  test('every finding is recorded, defaulting to open, at the right severity', () => {
    const rows = ledgerRows(runShippedDisposition({ reviewText: REVIEW }).ledger);
    assert.deepStrictEqual(rows.map((r) => [r.id, r.severity, r.disposition]), [
      ['CR-01', 'critical', 'open'], ['WR-01', 'warning', 'open'], ['IN-01', 'info', 'open'],
    ]);
  });

  test('--fix outcomes are reconciled, and a lookalike section heading is not one', () => {
    const fixText = ['## Fixed Issues', '', '### WR-01: b', '',
      '## Fixed Issues Verification', '', '### IN-01: c'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: REVIEW, fixText }).ledger);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.strictEqual(by['WR-01'].disposition, 'fixed');
    assert.strictEqual(by['WR-01'].source, '01-REVIEW-FIX.md');
    assert.strictEqual(by['IN-01'].disposition, 'open', 'a lookalike heading must classify nothing');
  });

  test("a human's deferral reason survives, and the carried marker never accumulates", () => {
    // Render -> re-parse -> render, four times, exactly as consecutive phase runs would.
    const shrunk = ['---', 'status: issues_found', '---', '', '### WR-01: b'].join('\n');
    let prior = ['| Finding | Severity | Disposition | Source |',
      '|---------|----------|-------------|--------|',
      '| CR-01 | critical | deferred | ships next phase, see ADR-99 |'].join('\n');
    let ledger;
    for (let i = 0; i < 4; i++) {
      ledger = runShippedDisposition({ reviewText: shrunk, priorText: prior }).ledger;
      prior = ledger;
    }
    const cr = ledgerRows(ledger).find((r) => r.id === 'CR-01');
    assert.strictEqual(cr.disposition, 'deferred');
    assert.strictEqual(cr.source, 'ships next phase, see ADR-99 (not in the current review)');
    assert.strictEqual(
      (ledger.match(/\(not in the current review\)/g) || []).length, 1,
      'the carried marker must appear exactly once however many times the gate runs'
    );
  });

  test('the ledger is a fixed point: a run that changes nothing rewrites nothing', () => {
    const first = runShippedDisposition({ reviewText: REVIEW }).ledger;
    const again = runShippedDisposition({ reviewText: REVIEW, priorText: first });
    assert.strictEqual(again.wroteNothing, true, 'an unchanged run must report unchanged');
    assert.strictEqual(again.ledger, first, 'and must leave the bytes alone');
  });

  test('a finding the review no longer reports is carried whether or not it was triaged', () => {
    const prior = ['| CR-01 | critical | deferred | later |', '| IN-01 | info | open | - |'].join('\n');
    const shrunk = ['---', 'status: issues_found', '---', '', '### WR-01: b'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: shrunk, priorText: prior }).ledger);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes('CR-01'), 'a deferred finding must survive leaving the review');
    assert.ok(ids.includes('IN-01'), 'and so must an untriaged one -- that is the whole record');
  });

  test('a renumbered finding leaves its old row behind, marked, rather than vanishing', () => {
    // The concrete case M1 names: run 1 records CR-01 open, the re-review renumbers it to CR-02,
    // and run 2's ledger used to contain neither. The old row is now carried and marked, so the
    // double-count is legible rather than a silent delete -- the stated cost of the fix.
    const prior = '| CR-01 | critical | open | - |';
    const renumbered = ['---', 'status: issues_found', '---', '', '### CR-02: the same finding, renumbered'].join('\n');
    const ledger = runShippedDisposition({ reviewText: renumbered, priorText: prior }).ledger;
    const rows = ledgerRows(ledger);
    assert.deepStrictEqual(rows.map((r) => r.id), ['CR-02', 'CR-01']);
    assert.match(ledger, /\| CR-01 \|.*\(not in the current review\) \|/,
      'the carried row is MARKED, so it does not claim the finding is live');
  });

  test('a review reporting nothing still reconciles an existing ledger', () => {
    const empty = ['---', 'status: issues_found', '---', '', 'no findings'].join('\n');
    const prior = ['| CR-01 | critical | deferred | later |', '| WR-01 | warning | open | - |'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: empty, priorText: prior }).ledger);
    assert.deepStrictEqual(rows.map((r) => r.id), ['CR-01', 'WR-01'], 'reconciled, not truncated');
  });

  test('a review reporting nothing with no prior ledger writes no ledger at all', () => {
    const empty = ['---', 'status: issues_found', '---', '', 'no findings'].join('\n');
    assert.strictEqual(runShippedDisposition({ reviewText: empty }).ledger, null);
  });

  test('an applied outcome outranks an earlier deferral', () => {
    const prior = '| CR-01 | critical | deferred | later |';
    const fixText = ['## Fixed Issues', '', '### CR-01: a'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: REVIEW, priorText: prior, fixText }).ledger);
    assert.strictEqual(rows.find((r) => r.id === 'CR-01').disposition, 'fixed');
  });

  test('a deferral on a finding STILL in the review is not reset to open', () => {
    // Distinct from the carried case: this finding is present in the current review, so it takes
    // the ordinary path. 'open' must never overwrite a recorded decision on that path either.
    const prior = '| CR-01 | critical | deferred | ships next phase |';
    const rows = ledgerRows(runShippedDisposition({ reviewText: REVIEW, priorText: prior }).ledger);
    const cr = rows.find((r) => r.id === 'CR-01');
    assert.strictEqual(cr.disposition, 'deferred');
    assert.strictEqual(cr.source, 'ships next phase');
    assert.ok(!/not in the current review/.test(cr.source), 'it is present, so it is not carried');
  });

  test('BL- is recorded at the Critical tier, as the documented CR- equivalent', () => {
    const withBlocker = ['---', 'status: issues_found', '---', '',
      '### BL-01: a', '', '### WR-01: b'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: withBlocker }).ledger);
    assert.deepStrictEqual(rows.map((r) => [r.id, r.severity]), [
      ['BL-01', 'critical'], ['WR-01', 'warning'],
    ]);
  });

  test('a finding id whose prefix is a JS object property name produces no row', () => {
    const hostile = ['---', 'status: issues_found', '---', '',
      '### constructor-01: x', '', '### __proto__-02: y', '', '### CR-01: real'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: hostile }).ledger);
    assert.deepStrictEqual(rows.map((r) => r.id), ['CR-01']);
  });
});

describe('#3829 review round 3 — hostile frontmatter and hand-edited ledgers', () => {
  test('an UNTERMINATED frontmatter block yields no values, not the whole review body', () => {
    // Stopping at "the next ---" is not enough: with no closing delimiter the scan would run to
    // EOF and hand body text to every read, undoing the scoping fix entirely.
    const unterminated = [
      '---', 'phase: 01', 'status: issues_found', '',
      '# body', '', 'total: 777', 'critical: 66',
    ].join('\n');
    const parsed = parseGateCounts(unterminated);
    assert.deepStrictEqual(parsed, { status: '', critical: '', warning: '', info: '', total: '' });
  });

  test('docs-parity: the frontmatter scan emits only when the closing delimiter was seen', () => {
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    assert.ok(
      src.includes('END{if (closed) printf "%s", buf}'),
      'an unterminated frontmatter block must yield nothing'
    );
  });


  test('a hand-edited row missing its trailing pipe still preserves the decision', () => {
    // A mangled table is already broken; silently dropping the row would lose a deferral, which
    // is the exact class of loss this record exists to prevent.
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: a'].join('\n');
    const prior = '| CR-01 | critical | deferred | see issue 42';
    const rows = ledgerRows(runShippedDisposition({ reviewText: review, priorText: prior }).ledger);
    const cr = rows.find((r) => r.id === 'CR-01');
    assert.strictEqual(cr.disposition, 'deferred');
    assert.strictEqual(cr.source, 'see issue 42');
  });
});

describe('#3829 review round 3 — stale fix reports, fenced examples, hostile REVIEW.md', () => {
  test('a STALE fix report does not mark a new finding of the same id as fixed', () => {
    // Finding ids are reused across re-reviews. Matching on the id alone would let a fix report
    // from an earlier review declare a brand-new CR-01 already fixed — the worst possible lie
    // for a record whose whole job is saying what happened to a finding.
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: NEW authentication bypass'].join('\n');
    const fixText = ['## Fixed Issues', '', '### CR-01: OLD null dereference'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: review, fixText }).ledger);
    assert.strictEqual(rows[0].disposition, 'open');
  });

  test('a fix report naming the same finding still applies', () => {
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: same title'].join('\n');
    const fixText = ['## Fixed Issues', '', '### CR-01: same title'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: review, fixText }).ledger);
    assert.strictEqual(rows[0].disposition, 'fixed');
  });

  test('a finding heading inside a fenced block is an example, not a finding', () => {
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: real',
      '', '```', '### CR-77: an illustration', '```'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: review }).ledger);
    assert.deepStrictEqual(rows.map((r) => r.id), ['CR-01']);
  });

  test('an id listed under BOTH Fixed and Skipped is not decided by row order', () => {
    const review = ['---', 'status: issues_found', '---', '', '### WR-01: dup'].join('\n');
    const fixText = ['## Fixed Issues', '', '### WR-01: dup', '',
      '## Skipped Issues', '', '### WR-01: dup'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: review, fixText }).ledger);
    assert.strictEqual(rows[0].disposition, 'fixed', 'first occurrence wins, deterministically');
  });

  test('an escaped pipe in a deferral reason survives whole', () => {
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: a'].join('\n');
    const prior = '| CR-01 | critical | deferred | wait \\| see ADR-9 |';
    const rows = ledgerRows(runShippedDisposition({ reviewText: review, priorText: prior }).ledger);
    assert.strictEqual(rows[0].source, 'wait \\| see ADR-9');
  });

  // #3861 round 3. The Source cell is the one field this ledger asks a human to hand-edit, and
  // "waiting on team A | team B to align" is an ordinary thing to type there. Under the previous
  // capture a bare | failed the WHOLE prior-row match: prior.get() was undefined, the row fell
  // through to open with an empty Source, and the console line read "1 of 1 finding(s) open" --
  // a Critical a human explicitly deferred, with a documented reason, rendered indistinguishable
  // from one never triaged, and the reason gone. Exactly the "was this ever seen" ambiguity
  // #3829 exists to remove, reachable by one missing backslash. The cell is the LAST column, so
  // it is now captured to the end of the line and a bare pipe is prose; the render escapes it
  // so the table stays a table, and the second run converges.
  test('a bare pipe in a deferral reason is kept as prose: the decision and the reason survive', () => {
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: a'].join('\n');
    const prior = '| CR-01 | critical | deferred | waiting on team A | team B to align |';
    const first = runShippedDisposition({ reviewText: review, priorText: prior });
    const rows = ledgerRows(first.ledger);
    assert.strictEqual(rows[0].disposition, 'deferred', 'a bare pipe must not revert the decision');
    assert.strictEqual(rows[0].source, 'waiting on team A \\| team B to align', 'the reason survives, escaped');
    assert.match(first.ledger, /^open: 0$/m, 'and the headline count agrees with the row');
    // Fixed point: the escaped form re-parses to itself, so the second run rewrites nothing.
    const second = runShippedDisposition({ reviewText: review, priorText: first.ledger });
    assert.strictEqual(ledgerRows(second.ledger)[0].source, 'waiting on team A \\| team B to align');
    assert.match(second.stdout, /disposition unchanged/, 'the second run must converge');
  });

  // Round-3 adversarial pass on the fix above. The first escape used /(^|[^\\])\|/g, which CONSUMES
  // the character before the pipe: adjacent bare pipes were escaped one per run (A||B -> A\||B ->
  // A\|\|B, a third run to converge, breaking the advertised second-run fixed point), and an escaped
  // backslash before a pipe (A\\|B) hid the pipe behind the wrong parity and left it bare in the
  // rendered table. The generator then emitted at most one bare pipe, so no property reached either; it does now.
  // Round-3 adversarial pass. The script printed its verdict and then called process.exit(0) on the
  // 'unchanged' branch only. Node documents process.stdout writes to pipes as ASYNCHRONOUS on
  // POSIX, and an explicit exit can pre-empt a pending write, so on those lanes the caller can see
  // exit 0 with no verdict line -- a hardening, not a reproduced defect: the reviewer's empty-stdout
  // observation turned out to be its own sandbox (a bare console.log child printed nothing there
  // either), which is stated so nobody re-reads this as evidence the drop was seen. The script now
  // runs inside main() and leaves by return, so the loop drains stdout before exit.
  // Shape-pinned deliberately: the property IS the absence of the call, and a behavioural test would
  // have to race a pipe to fail. Comments are stripped first so a mention is not a match, and the
  // match covers the dotted, bracketed and whitespace-split spellings; a call built by any other
  // indirection is outside this pin and is what code review is for.
  test('the shipped script never calls process.exit -- it returns, so its verdict line is never lost', () => {
    const code = shippedDispositionScript().replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /process\s*(?:\.\s*exit\b|\[\s*['"]exit['"]\s*\])/,
      'leave main() by return; an explicit exit can drop the verdict line on a piped stdout');
  });

  test('adjacent bare pipes and a backslash-then-pipe are escaped in ONE write, then converge', () => {
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: a'].join('\n');
    const prior = '| CR-01 | critical | deferred | A||B and C\\\\|D |';
    const first = runShippedDisposition({ reviewText: review, priorText: prior });
    assert.strictEqual(ledgerRows(first.ledger)[0].source, 'A\\|\\|B and C\\\\\\|D',
      'every bare pipe is escaped on the first write, whatever precedes it');
    const second = runShippedDisposition({ reviewText: review, priorText: first.ledger });
    assert.strictEqual(second.ledger, first.ledger, 'and the escaped form is a fixed point');
    assert.match(second.stdout, /disposition unchanged/);
  });

});

// ---------------------------------------------------------------------------
// #3861 round 1 — the two blockers, and the structural properties that catch them
//
// Both were invisible to every behavioural test above, for the same reason: those
// tests execute the node script through the process seam with the environment
// handed to it, so they never see the SHELL that is supposed to build that
// environment, nor the prose that tells the agent what to read.
// ---------------------------------------------------------------------------

// Every ```bash fence in a step file, in order.
function bashFences(src) {
  const out = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^```bash\s*$/.test(lines[i])) { start = i + 1; continue; }
    if (start !== -1 && /^```\s*$/.test(lines[i])) { out.push(lines.slice(start, i).join('\n')); start = -1; }
  }
  return out;
}

describe('#3861 round 1 — step-file structural contract', () => {
  test('the step file never instructs the agent to read and execute ITSELF', () => {
    // A step file that names its own path as something to "read and execute" is
    // unbounded self-recursion at runtime, and nothing downstream bounds it.
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    const self = 'execute-phase/steps/' + path.basename(DISPOSITION_STEP_PATH);
    assert.ok(
      !src.includes(self),
      'code-review-disposition.md must not reference its own path — execute-phase.md is what points here'
    );
  });

  test('the disposition instruction appears exactly once', () => {
    // The self-reference above arrived as a duplicated paragraph; the duplicate is
    // the tell, and no linter scores markdown prose.
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    const n = src.split(/\r?\n/).filter((l) => l.startsWith('**Record a per-finding disposition.**')).length;
    assert.strictEqual(n, 1, 'exactly one disposition instruction, not a pointer plus a body');
  });

  test('every shell block derives the variables it reads — blocks do not share a shell', () => {
    // Each fenced block is dispatched as its own Bash call, so a variable derived in
    // block 1 is EMPTY in block 2 — and empty is silent: the write lands on a bare
    // `-REVIEW-DISPOSITION.md` and the step still reports success. The step's own
    // inputs (PHASE_DIR, PHASE_NUMBER) are the only values a block may inherit.
    const INPUTS = new Set(['PHASE_DIR', 'PHASE_NUMBER']);
    const DERIVED = ['PADDED', 'REVIEW_FILE', 'DISPOSITION_FILE'];
    const fences = bashFences(fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8'));
    assert.ok(fences.length >= 2, 'the step must still carry more than one shell block');
    for (const [i, fence] of fences.entries()) {
      for (const v of DERIVED) {
        if (INPUTS.has(v)) continue;
        // The derivation may be INDENTED or sit inside a `case` arm -- PADDED is derived by a
        // case split so a dotted phase number does not reach `printf %02d`. Anchoring the
        // detector at column 0 made a real derivation invisible and the guard fired on it. The
        // property being checked is unchanged: the block must ASSIGN what it reads.
        // A SELF-REFERENTIAL assignment is a PASS-THROUGH, not a derivation. Block 2 prefixes its
        // `node -e` with `REVIEW_FILE="${REVIEW_FILE}" DISPOSITION_FILE="${DISPOSITION_FILE}" ...`
        // to put them in the child's environment, and the detector counted that as deriving them.
        // So deleting block 2's REAL derivation left this guard GREEN -- on the exact defect it
        // was written for. Found by negative-controlling the guard rather than by reading it.
        // (Pre-existing: the original column-0 anchor matched that same line, which is at column 0.)
        const fenceNoPassthrough = fence.replace(
          new RegExp('(?:^|[\\s;])' + v + '="\\$\\{' + v + '\\}"', 'gm'), ' ');
        // Non-empty RHS required. `REVIEW_FILE=` is an assignment TOKEN and not a derivation, and
        // the reviewer evaded the earlier predicate with exactly that. This is a cheap fast-fail,
        // NOT the guard's authority -- see the executed guard below, which is.
        const assigned = new RegExp('(?:^|[\\s;])' + v + '=(?![\\s;#]|$)', 'm');
        const reads = new RegExp('\\$\\{?' + v + '\\b').test(fence.replace(new RegExp('(?:^|[\\s;])' + v + '=', 'gm'), ''));
        if (!reads) continue;
        assert.ok(
          assigned.test(fenceNoPassthrough),
          'block ' + (i + 1) + ' reads ' + v + ' without deriving it — it is empty in a fresh shell'
        );
      }
    }
  });
});

describe('#3861 round 2 — the shell-sharing guard, EXECUTED', () => {
  // The textual guard above is a fast-fail, not the authority. An adversarial pass evaded it
  // three ways -- an empty `REVIEW_FILE=`, a self-referential `REVIEW_FILE=$REVIEW_FILE`, and a
  // commented assignment -- because a structural predicate recognises assignment TOKENS, never
  // assignments that derive a usable value. No amount of regex fixes that class.
  //
  // So the authority moves to execution, which is the lesson this PR has now learned three times:
  // run the real second fence in a FRESH shell with nothing but the step's two declared inputs,
  // and require it to write the ledger at the correct derived path. Every derivation in that
  // fence is load-bearing for that outcome, so no textual dodge survives it.
  // RANDOM PHASES, and the randomness is the mechanism rather than decoration. Fixed fixtures
  // cannot establish derivation: an adversarial pass defeated the one-phase version with
  // `case ... in 7) PADDED=07 ;; *) PADDED=07 ;; esac`, and then defeated the two-phase version
  // by simply adding `3.1) PADDED=03.1` to the same case. Any finite sample loses that race --
  // the enumeration just grows to cover whatever the test happens to name.
  //
  // A phase picked at RUN TIME raises the cost of a hardcode from two arms to the whole drawn
  // domain, so an accidental loss of derivation fails on some run rather than never.
  //
  // STATED HONESTLY, because the first version of this comment overclaimed and was refuted: the
  // domain is FINITE -- 88 integer values and 792 dotted ones -- so a mutation enumerating all
  // 880 passes forever, and one covering 90 or 12345678.1 or 1.10 would still break real phases
  // the draw cannot reach. This raises the bar; it does not prove derivation, and nothing short
  // of reading the fence can. `Math.random()` is also unseeded, so a failure is reproducible only
  // in the sense that the drawn values are printed in every assertion message below -- re-running
  // draws different ones. That is the honest description of what this buys.
  //
  // One integer and one dotted phase per run: the dotted one additionally pins the integer-part
  // split a naive `%02d` cannot express.
  const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const intPhase = String(rnd(2, 89));
  const dotPhase = rnd(2, 89) + '.' + rnd(1, 9);
  const pad = (v) => {
    const [i, sub] = String(v).split('.');
    return String(Number(i)).padStart(2, '0') + (sub === undefined ? '' : '.' + sub);
  };
  for (const [phaseNumber, padded] of [[intPhase, pad(intPhase)], [dotPhase, pad(dotPhase)]]) {
    test('block 2 derives its own paths and writes the ledger for phase ' + phaseNumber,
      { skip: !HAS_BASH }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3861-blk2-'));
      const drawn = ' (drawn phase ' + phaseNumber + ' -> ' + padded + ')';
      try {
        fs.writeFileSync(path.join(dir, padded + '-REVIEW.md'),
          ['---', 'phase: ' + padded, 'status: issues_found', '---', '',
            '### CR-01: a finding'].join('\n'));
        const fence = bashFences(fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8'))[1];
        assert.ok(fence && fence.includes('DISPOSITION_FILE'), 'the disposition block must be fence 2');
        // Scrub the DERIVED names from the inherited environment, so the claim "given only the
        // declared inputs" is true rather than merely intended. `...process.env` is still needed
        // for PATH/HOME, and an adversarial pass was right to call out the earlier wording.
        const env = { ...process.env, PHASE_DIR: dir, PHASE_NUMBER: phaseNumber, RUNTIME_DIR: ROOT };
        for (const k of ['PADDED', 'REVIEW_FILE', 'DISPOSITION_FILE', 'FIX_REPORT_FILE']) delete env[k];
        const res = runHook('-c', ['set -euo pipefail\n' + fence + '\n'], {
          interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS, env,
        });
        assert.strictEqual(res.outcome, OUTCOME.EXITED, 'the block must run to completion');
        assert.strictEqual(res.exitCode, 0, 'advisory: it must not abort' + drawn + ': ' + res.stderr);
        assert.ok(fs.existsSync(path.join(dir, padded + '-REVIEW-DISPOSITION.md')),
          'the ledger must land at the DERIVED path — a lost derivation writes elsewhere or nowhere' + drawn);
        const rows = ledgerRows(fs.readFileSync(path.join(dir, padded + '-REVIEW-DISPOSITION.md'), 'utf8'));
        assert.deepStrictEqual(rows.map((r) => r.id), ['CR-01'], 'and it must have read the review' + drawn);
        assert.ok(!fs.existsSync(path.join(dir, '-REVIEW-DISPOSITION.md')),
          'an empty PADDED must never produce a bare-named ledger' + drawn);
      } finally {
        cleanup(dir);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// #3861 round 1, Major 4 + Minor 9 — the frontmatter reads, EXECUTED
//
// The disposition builder stopped being a mirror three rounds ago, for a reason
// this file already states: a hand model of a shell-embedded script drifts, and
// when it drifts the tests pass while the shipped block is broken. The counts
// parser kept its mirror anyway, and the argument against mirrors does not stop
// applying at the boundary between the two blocks.
//
// So the mirror loses its authority: it is now asserted AGAINST the shipped awk
// and greps, run under `set -euo pipefail` in a real shell, over every fixture
// the mirror is tested on. Divergence in either direction fails.
//
// Running the block also makes its advisory guards behavioural rather than
// textual, which retires the two `src.includes()` docs-parity assertions that
// stood in for them — Minor 9's anti-pattern, reduced by executing the thing
// the assertions were describing.
// ---------------------------------------------------------------------------


// Run the step's FIRST shell block — the frontmatter reads — and report WHAT IT PRINTS.
//
// This harness used to append its own `printf` of the six internal variables to the fence before
// running it, and every assertion below then read those six lines. That is a test manufacturing the
// observable it asserts on: the shipped fence emitted nothing, the tested fence emitted six lines
// because the test added them, and the whole group was green against a script that did not exist
// outside this process. It is why the "the gate reports the counts" defect shipped past a suite that
// looks like it covers exactly that surface — the green was structurally incapable of turning red
// for it. The emitter now lives in the fence (see the step file), so the harness reads the fence's
// own stdout and nothing is synthesized here.
function runShippedGateCounts({ reviewText, padded = '01', writeReview = true, mode, phaseNumber }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3861-'));
  try {
    const reviewPath = path.join(dir, padded + '-REVIEW.md');
    if (writeReview) fs.writeFileSync(reviewPath, reviewText);
    if (mode !== undefined) fs.chmodSync(reviewPath, mode);
    const fence = bashFences(fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8'))[0];
    assert.ok(fence && fence.includes('REVIEW_COUNTS_OK'), 'the counts block must still be the first fence');
    // `set -euo pipefail` is the point, not decoration: the step is advisory, so a
    // non-matching grep or an unreadable review must not take the block down.
    const script = 'set -euo pipefail\n' + fence + '\n';
    const res = runHook('-c', [script], {
      interpreter: 'bash',
      timeoutMs: PROBE_TIMEOUT_MS,
      // `Number(padded)` is deliberate for the integer case (strips the leading zero the way a
      // caller's parsed phase_number does) but must not mangle a DOTTED phase: Number('03.1') is
      // 3.1, which is what we want, while a non-numeric padded value would become NaN.
      // `phaseNumber` overrides the derivation so a test can drive a value `padded` cannot
      // express -- an unusable one. Otherwise PHASE_NUMBER is derived from `padded` as a caller's
      // parsed phase_number would be.
      env: {
        ...process.env,
        PHASE_DIR: dir,
        PHASE_NUMBER: phaseNumber === undefined ? String(Number(padded)) : phaseNumber,
      },
    });
    assert.strictEqual(res.outcome, OUTCOME.EXITED, 'the counts block must run to completion');
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  } finally {
    cleanup(dir);
  }
}

// Read the shipped message back into the facts it asserts. This parses the OBSERVABLE the operator
// sees — it does not reach into the fence — so a value the gate declines to report is `reported:
// false` here rather than a number this helper invented.
function readGateMessage(stdout) {
  const full = /^Code review: (\d+) findings — (\d+) critical, (\d+) warning, (\d+) info\.$/m.exec(stdout);
  if (full) {
    return { reported: true, countsOk: '1', total: full[1], critical: full[2], warning: full[3], info: full[4] };
  }
  if (/^Code review found issues\.$/m.test(stdout)) return { reported: true, countsOk: '0' };
  return { reported: false };
}

// The mirror's other half: render the two arms exactly as the shipped fence does, from the mirror's
// own parsed counts. Parity is asserted over this WHOLE STRING rather than over five intermediate
// values, which is what makes the assertion bind to something a user can see. The countsOk gate is
// modelled here because the shipped fence gates on it — digit-only, at most 8 digits, and the three
// severities must sum to the total.
function renderGateMessage(counts, phaseNumber) {
  const numeric = (v) => v !== '' && /^[0-9]+$/.test(v) && v.length <= 8;
  const all = [counts.total, counts.critical, counts.warning, counts.info];
  let ok = all.every(numeric);
  if (ok) {
    const n = (v) => parseInt(v, 10);
    if (n(counts.critical) + n(counts.warning) + n(counts.info) !== n(counts.total)) ok = false;
  }
  if (counts.status === '' || counts.status === 'clean' || counts.status === 'skipped') return '';
  const head = ok
    ? `Code review: ${counts.total} findings — ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info.`
    : 'Code review found issues.';
  return head + '\n' + `Consider running: /gsd:code-review ${phaseNumber} --fix` + '\n';
}

describe('#3861 round 2 — the ledger write refuses a non-regular file', () => {
  // The write-safety behaviour shipped with NO regression control at all -- I hand-drove it and
  // did not pin it, which the round review caught by grepping for the words. Three shapes, each
  // a distinct failure mode, all driven before this test existed:
  //   symlink   -> writeFileSync FOLLOWS it and replaced the target's contents, outside the
  //                phase directory, leaving the link intact so nothing looked wrong;
  //   FIFO      -> readFileSync BLOCKED FOREVER, in a gate documented as never blocking;
  //   directory -> the write throws.
  const mkPhase = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3861-nrf-'));
    fs.writeFileSync(path.join(dir, '03-REVIEW.md'),
      ['---', 'status: issues_found', '---', '', '### CR-01: a finding'].join('\n'));
    return dir;
  };
  const runAt = (dir) => runNode(['-e', shippedDispositionScript()], {
    timeoutMs: PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      REVIEW_FILE: path.join(dir, '03-REVIEW.md'),
      DISPOSITION_FILE: path.join(dir, '03-REVIEW-DISPOSITION.md'),
      FIX_REPORT_FILE: path.join(dir, '03-REVIEW-FIX.md'),
      PADDED: '03',
    },
  });

  // Skipped on win32 per the repo's existing convention for symlink-planting tests:
  // tests/settings-jsonc.test.cjs:389 skips the same class, and
  // tests/unreachable-guard-drift.test.cjs:726 records why -- symlink creation requires elevated
  // privileges on Windows CI. It happened to be available on the lane this round; the convention
  // exists because it is not guaranteed.
  test('a symlink at the ledger path is refused, and its target is untouched',
    { skip: process.platform === 'win32' }, () => {
    const dir = mkPhase();
    try {
      const outside = path.join(dir, 'outside.txt');
      fs.writeFileSync(outside, 'ORIGINAL');
      fs.symlinkSync(outside, path.join(dir, '03-REVIEW-DISPOSITION.md'));
      const res = runAt(dir);
      assert.strictEqual(res.exitCode, 0, 'advisory: it refuses, it does not fail');
      assert.match(res.stdout, /not a regular file/, 'and says why');
      assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'ORIGINAL',
        'the symlink target must not be overwritten');
      assert.ok(fs.lstatSync(path.join(dir, '03-REVIEW-DISPOSITION.md')).isSymbolicLink(),
        'and the link itself is left alone');
    } finally { cleanup(dir); }
  });

  test('a symlink whose target ALREADY matches is refused too — the fast path does not bypass it',
    { skip: process.platform === 'win32' }, () => {
    // The unchanged-run fast path read the ledger before the check, so a link whose target
    // happened to match slipped through reporting `unchanged`. The check is first now.
    const dir = mkPhase();
    try {
      const outside = path.join(dir, 'outside.txt');
      fs.writeFileSync(outside, 'ORIGINAL');
      fs.symlinkSync(outside, path.join(dir, '03-REVIEW-DISPOSITION.md'));
      runAt(dir);
      const res = runAt(dir);
      assert.match(res.stdout, /not a regular file/);
      assert.doesNotMatch(res.stdout, /unchanged/, 'the fast path must not run ahead of the check');
      assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'ORIGINAL');
    } finally { cleanup(dir); }
  });

  test('a FIFO at the ledger path is refused rather than blocking the phase forever', () => {
    const dir = mkPhase();
    try {
      // Through the process seam, like every other spawn in this file.
      const fifoPath = path.join(dir, '03-REVIEW-DISPOSITION.md');
      runHook('-c', ['mkfifo "$1"', '_', fifoPath], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
      // GATE ON WHAT WAS CREATED, never on mkfifo's exit code. On the Windows lane mkfifo EXISTS
      // and exits 0 while producing something that is not a FIFO, so an exit-code guard let this
      // test run against an ordinary path: the ledger wrote normally and the assertion below
      // failed for a reason that had nothing to do with the behaviour under test. Caught by CI,
      // not by the local suite or five review passes -- every one of which ran on Linux.
      let isFifo = false;
      try { isFifo = fs.lstatSync(fifoPath).isFIFO(); } catch { isFifo = false; }
      if (!isFifo) return;   // no real FIFO on this platform; nothing to assert
      const res = runAt(dir);
      assert.strictEqual(res.outcome, OUTCOME.EXITED,
        'a FIFO must not hang the step — readFileSync blocks on one forever');
      assert.strictEqual(res.exitCode, 0);
      assert.match(res.stdout, /not a regular file/);
    } finally { cleanup(dir); }
  });

  test('a directory at the ledger path is refused', () => {
    const dir = mkPhase();
    try {
      fs.mkdirSync(path.join(dir, '03-REVIEW-DISPOSITION.md'));
      const res = runAt(dir);
      assert.strictEqual(res.exitCode, 0);
      assert.match(res.stdout, /not a regular file/);
    } finally { cleanup(dir); }
  });

  test('an ordinary ledger is still written — the refusal is not a blanket refusal', () => {
    const dir = mkPhase();
    try {
      const res = runAt(dir);
      assert.strictEqual(res.exitCode, 0);
      assert.doesNotMatch(res.stdout, /not a regular file/);
      assert.ok(fs.existsSync(path.join(dir, '03-REVIEW-DISPOSITION.md')));
    } finally { cleanup(dir); }
  });
});

describe('#3861 round 2 — a DOTTED phase number does not break the step', () => {
  // Found by the round's own adversarial review, in its MISSED section -- no finding asked about
  // it. Both callers explicitly accept `03.1` (code-review.md:60, code-review-fix.md:36 validate
  // ^[0-9]+(\.[0-9]+)?$), and the step reconstructed the path with `printf "%02d"`, which cannot
  // format one: bash prints `invalid number` and exits 1. Under `set -euo pipefail` that aborts
  // the step on its FIRST line -- the loudest possible failure from a gate that promises never to
  // block, and it takes the phase's whole review report with it.
  // #3861 round 5, minor 1. The PADDED derivation -- the traversal fence between an
  // attacker-influenceable phase number and a file path, plus the per-component length bound -- is
  // duplicated verbatim across both fences, because each fenced block runs in a fresh shell and must
  // derive what it reads. Each copy is independently tested, but nothing asserted they stay in step,
  // and a future edit to one could silently desync the other with the suite still green. That is the
  // shared-parallel-surface shape CLAUDE.md requires a parity test for, and it is security-relevant
  // validation logic rather than incidental repetition.
  //
  // Compared LINE BY LINE rather than through a normalizing rewrite: a normalizer would have to be
  // told what may differ, and anything it was told to tolerate would stop being asserted. Exactly one
  // line may differ, and the test names both of its forms.
  test('the two fences derive PADDED identically, and only the refusal message may differ', () => {
    const fences = bashFences(fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8'));
    assert.strictEqual(fences.length, 2, 'the step must still carry exactly two bash fences');
    const derivationOf = (fence, which) => {
      const start = fence.indexOf('_pd="${PHASE_DIR:-}"');
      const end = fence.indexOf('DISPOSITION_FILE="${_pd}/${PADDED}-REVIEW-DISPOSITION.md"');
      assert.ok(start > -1, 'block ' + which + ' must still open the derivation with _pd');
      assert.ok(end > start, 'block ' + which + ' must still close it by building the ledger path');
      return fence.slice(start, end).split('\n');
    };
    const a = derivationOf(fences[0], 1);
    const b = derivationOf(fences[1], 2);
    // A parity test over an empty or trivial slice passes vacuously and pins nothing.
    assert.ok(a.length > 20, 'the derivation must still be the substantial block this pins');
    assert.strictEqual(a.length, b.length, 'the two derivations must have the same shape');
    const differing = a.map((line, i) => [i, line, b[i]]).filter((e) => e[1] !== e[2]);
    assert.strictEqual(differing.length, 1,
      'exactly one line may differ between the two derivations; got ' + differing.length + ': ' +
      JSON.stringify(differing.map((e) => [e[1], e[2]])));
    assert.match(differing[0][1], /Code review reporting skipped/, 'block 1 refuses by its own name');
    assert.match(differing[0][2], /Code review disposition skipped/, 'block 2 refuses by its own name');
  });

  test('block 1 reports a dotted phase instead of aborting', { skip: !HAS_BASH }, () => {
    const review = ['---', 'phase: 03.1', 'status: issues_found', 'findings:',
      '  critical: 1', '  warning: 0', '  info: 0', '  total: 1', '---', '',
      '### CR-01: a real finding'].join('\n');
    const out = runShippedGateCounts({ reviewText: review, padded: '03.1' });
    assert.strictEqual(out.exitCode, 0, 'advisory: a dotted phase must not abort the step');
    assert.doesNotMatch(out.stderr, /invalid number/,
      'the phase number must never reach printf %02d unsplit');
    assert.match(out.stdout, /^Code review: 1 findings — 1 critical, 0 warning, 0 info\.$/m,
      'and the review is actually found and reported');
  });

  test('a phase number outside the documented shape builds NO path — traversal fence', { skip: !HAS_BASH }, () => {
    // PHASE_NUMBER is interpolated into a file path. The first draft of the dotted-phase fix
    // carried an unusable value VERBATIM, which made `${PHASE_DIR}/../../etc/passwd-REVIEW.md`
    // reachable where the old `printf "%02d"` had at least mangled it to `00` -- a regression
    // introduced by the fix, found by adversarially reviewing it. Both callers already validate
    // ^[0-9]+(\.[0-9]+)?$; this step has two call sites and validates for itself.
    for (const bad of ['../../etc/passwd', 'abc', '', '1.2.3', '-1', '3.', '.1', '+1', '3 1']) {
      const out = runShippedGateCounts({ reviewText: '', writeReview: false, phaseNumber: bad });
      assert.strictEqual(out.exitCode, 0, 'advisory: `' + bad + '` must not abort the step');
      assert.match(out.stdout, /skipped \(unusable phase number/,
        '`' + bad + '` must be refused by name, not silently coerced');
      assert.doesNotMatch(out.stdout, /Code review: /,
        '`' + bad + '` must not report counts read from a path built out of it');
    }
  });

  test('an integer phase is still zero-padded exactly as before', { skip: !HAS_BASH }, () => {
    // Negative control for the split: the ordinary path must be untouched.
    const review = ['---', 'phase: 01', 'status: issues_found', 'findings:',
      '  critical: 1', '  warning: 0', '  info: 0', '  total: 1', '---', '',
      '### CR-01: a finding'].join('\n');
    const out = runShippedGateCounts({ reviewText: review, padded: '01' });
    assert.strictEqual(out.exitCode, 0);
    assert.match(out.stdout, /^Code review: 1 findings/m);
  });
});

describe('#3861 round 1 — the counts mirror is asserted against the shipped shell', () => {
  // Every fixture the mirror is exercised on above, plus the count edges.
  const FIXTURES = {
    'the documented review': REVIEW_WITH_FINDINGS,
    'blocker: as the critical tier-equivalent': REVIEW_WITH_FINDINGS.replace('  critical: 1', '  blocker: 1'),
    'a body ---, status: and total: after the frontmatter':
      REVIEW_WITH_FINDINGS + '\n\n---\n\nstatus: clean\ntotal: 999\n',
    'a legacy review with no findings: block':
      ['---', 'phase: 02', 'status: issues_found', '---', '', '# Phase 02'].join('\n'),
    'CRLF line endings': REVIEW_WITH_FINDINGS.replace(/\n/g, '\r\n'),
    'unterminated frontmatter': ['---', 'status: issues_found', 'total: 4', '', '## Body'].join('\n'),
    'no frontmatter at all': '# Phase 01\n\nnothing here\n',
    'a zero-finding review': ['---', 'phase: 01', 'findings:', '  critical: 0', '  warning: 0',
      '  info: 0', '  total: 0', 'status: issues_found', '---'].join('\n'),
    // Both from the round-1 adversarial pass: the shipped pipeline collapses `1 0` to `10` where
    // a trim keeps `1 0`, and truncates at a second colon where a tail capture keeps it. Neither
    // is reachable from the well-formed fixtures above, which is exactly why they are here.
    'a count with an internal space': REVIEW_WITH_FINDINGS.replace('  critical: 1', '  critical: 1 0'),
    'a value containing a second colon': REVIEW_WITH_FINDINGS.replace('status: issues_found', 'status: issues:found'),
    // POSIX [[:space:]] covers form feed and vertical tab; a [ \t] mirror does not, so the
    // shipped grep matches a line the mirror rejects outright. Third counterexample, same class.
    'a key indented with a form feed': REVIEW_WITH_FINDINGS.replace('  critical: 1', '\fcritical: 1'),
    // Minor 1: a TOP-LEVEL key sharing a name with a nested count. The reads were scoped to the
    // frontmatter but not to the `findings:` mapping the values belong to, so `^[[:space:]]*total:`
    // matched this one first and the gate reported a number from outside the breakdown.
    'a top-level total: ahead of the nested one':
      ['---', 'phase: 02', 'total: 999', 'status: issues_found', 'findings:',
        '  critical: 1', '  warning: 0', '  info: 0', '  total: 1', '---'].join('\n'),
    'a top-level info: and critical: ahead of the nested ones':
      ['---', 'critical: 42', 'info: 7', 'status: issues_found', 'findings:',
        '  critical: 1', '  warning: 0', '  info: 0', '  total: 1', '---'].join('\n'),
  };

  for (const [name, reviewText] of Object.entries(FIXTURES)) {
    test('shipped shell and mirror agree on ' + name, { skip: !HAS_BASH }, () => {
      const shipped = runShippedGateCounts({ reviewText });
      // Parity over the WHOLE emitted message, not over five intermediate variables the test
      // used to print for itself. A drift in any parsed value changes this string or the arm
      // it selects, so the assertion binds to what an operator actually sees.
      assert.strictEqual(
        shipped.stdout,
        renderGateMessage(parseGateCounts(reviewText), 1),
        'the mirror has drifted from the shipped awk/grep block'
      );
    });
  }

  test('a zero-finding review reports a real breakdown, not the countless fallback', { skip: !HAS_BASH }, () => {
    // Minor 6. `0` is a number, so the gate must state `0 findings — 0 critical, …`
    // rather than fall back. The `case` guard rejects the empty string and non-digits;
    // a guard written against truthiness would reject this and say nothing at all.
    const shipped = runShippedGateCounts({ reviewText: FIXTURES['a zero-finding review'] });
    assert.strictEqual(shipped.stdout,
      'Code review: 0 findings \u2014 0 critical, 0 warning, 0 info.\n'
      + 'Consider running: /gsd:code-review 1 --fix\n',
      'all four counts are numeric, so the breakdown is reported rather than withheld');
  });

  test('a partial findings: block makes the whole breakdown unavailable', { skip: !HAS_BASH }, () => {
    const shipped = runShippedGateCounts({
      reviewText: ['---', 'findings:', '  total: 4', 'status: issues_found', '---'].join('\n'),
    });
    assert.strictEqual(readGateMessage(shipped.stdout).countsOk, '0',
      'a total without the three severities is not a breakdown');
    assert.match(shipped.stdout, /^Code review found issues\.$/m,
      'the countless form is what reaches the operator');
  });

  test('a missing REVIEW.md leaves the counts empty and does not abort', { skip: !HAS_BASH }, () => {
    // Behavioural replacement for the `src.includes('if [ -f "$REVIEW_FILE" ] …')`
    // assertion: under `set -e` an aborting block is what actually breaks the phase.
    const shipped = runShippedGateCounts({ reviewText: '', writeReview: false });
    assert.strictEqual(shipped.exitCode, 0, 'advisory: a missing review must not abort the step');
    // An absent review yields an empty status, which is a NON-REPORTING arm: the gate says
    // nothing at all rather than claiming a countless review. Asserting on the observable is
    // what makes that distinction visible; the old six-line probe could not express it.
    assert.strictEqual(shipped.stdout, '', 'no review, no message');
    assert.strictEqual(readGateMessage(shipped.stdout).reported, false);
  });

  test('the countless fallback requires all four counts, not just the total', { skip: !HAS_BASH }, () => {
    // Fifth `src.includes()` assertion converted to a behavioural one (round 1 retired four).
    // It pinned the PROSE that stated the condition, so it went red the moment the emitter moved
    // into the fence and the prose was rewritten — while the behaviour it named was untouched.
    // That is the pin arguing for its own conversion: the arm is now executed and observable, so
    // assert the arm. Contrast is the point — a bare total takes the countless arm, the full set
    // takes the breakdown arm — which a one-sided assertion could not express.
    const fm = (rows) => ['---', 'findings:', ...rows, 'status: issues_found', '---'].join('\n');
    const totalOnly = runShippedGateCounts({ reviewText: fm(['  total: 4']) });
    assert.match(totalOnly.stdout, /^Code review found issues\.$/m,
      'a numeric total with missing severities must not emit a half-filled breakdown');
    assert.doesNotMatch(totalOnly.stdout, /findings —/,
      'and must not emit the breakdown form at all');
    const allFour = runShippedGateCounts({
      reviewText: fm(['  critical: 1', '  warning: 2', '  info: 1', '  total: 4']),
    });
    assert.match(allFour.stdout, /^Code review: 4 findings — 1 critical, 2 warning, 1 info\.$/m,
      'all four present and consistent is what the breakdown arm requires');
  });

  test('an unreadable REVIEW.md leaves the counts empty and does not abort', { skip: !HAS_BASH }, () => {
    const shipped = runShippedGateCounts({ reviewText: REVIEW_WITH_FINDINGS, mode: 0o000 });
    assert.strictEqual(shipped.exitCode, 0, 'advisory: an unreadable review must not abort the step');
    assert.strictEqual(shipped.stdout, '', 'an unreadable review reports nothing, and does not guess');
  });
});

// ---------------------------------------------------------------------------
// #3861 round 1 — Minor 5, and the finding-id census the review did not ask for
// ---------------------------------------------------------------------------

const REVIEWER_AGENT_PATH = path.join(ROOT, 'agents', 'gsd-code-reviewer.md');

// The alternations the shipped script uses to recognise a finding id. There are three —
// the heading matcher, the ledger row re-parser, and the frontmatter `- id:` matcher —
// and adding a prefix to only some of them is silent. The severity map below is a fourth
// copy of the same set; it is not an alternation, so it is extracted separately.
// This scan is by PATTERN, never a fixed list of sites, which is why round 5's new
// matcher was absorbed with no edit here. Do not convert it to an enumeration.
function idAlternations() {
  const script = shippedDispositionScript();
  return [...script.matchAll(/\(\?:((?:[A-Z]{2}\|)+[A-Z]{2})\)-/g)].map((m) => m[1].split('|').sort().join('|'));
}

// The FOURTH copy: the severity map's keys. It is not an alternation, so the extractor above cannot
// see it — and a set that agrees in the three regexes while mis-tiering in the map is the drift the
// guard would otherwise miss entirely.
// (Said THIRD until round 6. The extractor finds three alternations — round 5's frontmatter `- id:`
// matcher is the third — so the map has been the fourth copy since then. The count is prose only;
// nothing below reads it.)
function severityMapKeys() {
  const script = shippedDispositionScript();
  const m = script.match(/\{([^}]*?)\}\[id\.split/);
  assert.ok(m, 'the severity map must still be an inline object literal indexed by the id prefix');
  return [...m[1].matchAll(/([A-Z]{2}):/g)].map((x) => x[1]);
}

describe('#3861 round 1 — stale fix reports are stated, not silently ignored', () => {
  test('a fix report naming a different finding under a reused id says so', () => {
    // Exact-title coupling is deliberate — ids are reused across re-reviews, so a
    // stale REVIEW-FIX.md must not mark a brand-new CR-01 fixed. But failing it
    // silently leaves 'open' indistinguishable from 'the report never named it',
    // which is the one thing the ledger exists to tell apart.
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: a genuinely new finding'].join('\n');
    const fixText = ['## Fixed Issues', '', '### CR-01: the finding this id used to mean'].join('\n');
    const out = runShippedDisposition({ reviewText: review, fixText });
    const rows = ledgerRows(out.ledger);
    assert.strictEqual(rows[0].disposition, 'open', 'a stale report must not decide the row');
    assert.match(out.stdout, /titles its finding differently from the review/,
      'and the mismatch must be reported, not swallowed');
    assert.match(out.stdout, /a stale report, or a re-titled one/,
      'stated as the observation it is -- the step cannot tell the two causes apart');
    assert.match(out.stdout, /CR-01/, 'naming the finding it could not reconcile');
  });

  test('a title differing only in INTRA-LINE whitespace still reconciles (m2)', () => {
    // gsd-code-fixer.md writes '### {finding_id}: {title}' under no contract that the title is
    // copied byte-for-byte, so a fixer that re-spaces a title used to produce a spurious note and
    // leave a genuinely-fixed row 'open'. Runs of spaces carry no information; they are collapsed.
    // NAMED PRECISELY. An earlier version of this test called itself the "reflowed" case while
    // substituting triple spaces, which is not a reflow -- see the bound pinned below.
    const title = 'a long finding title a fixer might re-space';
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: ' + title].join('\n');
    const respaced = ['## Fixed Issues', '', '### CR-01: ' + title.replace(/ /g, '   ')].join('\n');
    const out = runShippedDisposition({ reviewText: review, fixText: respaced });
    assert.strictEqual(ledgerRows(out.ledger)[0].disposition, 'fixed',
      'a re-spaced title is the same title, and the fix outcome must reach the ledger');
    assert.doesNotMatch(out.stdout, /titles its finding differently/,
      'and no spurious mismatch is reported');
  });

  test('a title WRAPPED across lines is not reconciled — the bound, pinned deliberately', () => {
    // The limit of the m2 fix, stated rather than left to be discovered. A `###` heading is ONE
    // line by definition: if a fixer wraps a long title, the continuation is a separate paragraph
    // and the heading parser -- correctly -- captures only the first line. Whitespace collapsing
    // cannot reach across that boundary.
    //
    // NOT widened, and the reason is that widening is the worse defect: to reconcile a wrapped
    // title the parser would have to absorb whatever follows a heading into the title, which
    // silently swallows arbitrary prose and would make the stale-report check meaningless. The
    // failure mode kept here is the SAFE one -- a visible mismatch note and a row left open,
    // never a wrong 'fixed'.
    const review = ['---', 'status: issues_found', '---', '',
      '### CR-01: a long finding title that wraps'].join('\n');
    const wrapped = ['## Fixed Issues', '', '### CR-01: a long', 'finding title that wraps'].join('\n');
    const out = runShippedDisposition({ reviewText: review, fixText: wrapped });
    assert.strictEqual(ledgerRows(out.ledger)[0].disposition, 'open',
      'a wrapped heading does not reconcile -- and fails in the safe direction');
    assert.match(out.stdout, /titles its finding differently/,
      'the mismatch is reported rather than swallowed');
  });

  test('a RE-CASED or truncated title still reports a mismatch — the strict half is kept', () => {
    // The deliberate residual. Case changes and truncation are the shapes a genuinely different
    // finding takes, so widening to them would trade a visible false positive for a silent false
    // negative -- a stale report marking a brand-new CR-01 fixed, which is the worse direction.
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: The Finding'].join('\n');
    const recased = ['## Fixed Issues', '', '### CR-01: the finding'].join('\n');
    const out = runShippedDisposition({ reviewText: review, fixText: recased });
    assert.strictEqual(ledgerRows(out.ledger)[0].disposition, 'open');
    assert.match(out.stdout, /titles its finding differently/);
  });

  test('a matching fix report reports no mismatch', () => {
    // Negative control for the note itself: it must not fire on the ordinary path.
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: same title'].join('\n');
    const fixText = ['## Fixed Issues', '', '### CR-01: same title'].join('\n');
    const out = runShippedDisposition({ reviewText: review, fixText });
    assert.strictEqual(ledgerRows(out.ledger)[0].disposition, 'fixed');
    assert.doesNotMatch(out.stdout, /reused id/);
  });
});

describe('#3861 round 1 — finding-id prefix census', () => {
  test('every copy of the prefix set agrees with every other', () => {
    // The set is written out FOUR times in one script — the heading matcher, the ledger
    // row re-parser, the frontmatter `- id:` matcher the title tracking added, and (by its
    // keys) the severity map. Adding a prefix to some of them does not error; it drops
    // carried rows on the next run.
    // The count is stated for the reader; nothing below depends on it. idAlternations()
    // scans the script by PATTERN rather than walking a fixed site list, which is why the
    // fourth site was absorbed without a change here — this comment is the only thing that
    // fell behind, and a guard whose population is hand-listed is the defect it would have
    // been. Do not convert this to an enumeration.
    const alts = idAlternations();
    assert.ok(alts.length >= 2, 'the script must still enumerate finding-id prefixes');
    assert.strictEqual(new Set(alts).size, 1, 'the prefix enumerations have drifted apart: ' + alts.join(' vs '));
    // And the fourth copy, which is not an alternation: every prefix the regexes admit must either
    // carry an explicit tier in the severity map or fall to `info` by the documented default.
    // Without this, the three regexes can gain a prefix while the map silently mis-tiers it.
    const mapped = new Set(severityMapKeys());
    const admitted = alts[0].split('|');
    const unmapped = admitted.filter((p) => !mapped.has(p));
    assert.deepStrictEqual(
      unmapped, ['IN'],
      'only IN may rely on the info default; every other admitted prefix needs an explicit tier'
    );
    // And the other direction, which a one-way check leaves open: a tier for a prefix the
    // regexes never admit is dead code that reads as coverage.
    const unadmitted = [...mapped].filter((p) => admitted.indexOf(p) === -1);
    assert.deepStrictEqual(
      unadmitted, [],
      'the severity map tiers prefixes the id regexes do not admit: ' + unadmitted.join(',')
    );
  });

  test('the prefix set covers every id shape the reviewer agent emits', () => {
    // The DOMAIN is owned elsewhere — gsd-code-reviewer.md's body template and its
    // Label-equivalence paragraph — so it can acquire a member without this script
    // changing. An unlisted prefix is not mis-tiered, it is INVISIBLE: the finding
    // never enters the order list and gets no row at all.
    const agent = fs.readFileSync(REVIEWER_AGENT_PATH, 'utf8');
    // BOTH surfaces. The body template writes `### CR-01:` headings; the Label-equivalence
    // paragraph defines BL in PROSE and appears in no heading at all (`### BL-` occurs zero
    // times). A heading-only scan therefore passes today purely because BL happens to be
    // hard-coded, and would miss the next prose-defined prefix exactly as it would miss BL.
    const emitted = new Set([
      ...[...agent.matchAll(/^###\s+([A-Z]+)-\d+:/gm)].map((m) => m[1]),
      ...[...agent.matchAll(/\b([A-Z]+)-\s*(?:IDs?|prefix)/g)].map((m) => m[1]),
      ...[...agent.matchAll(/IDs? beginning with\s+`?([A-Z]+)-/g)].map((m) => m[1]),
    ]);
    assert.ok(emitted.size > 0, 'the reviewer agent must still declare its finding-id shapes');
    const known = new Set(idAlternations()[0].split('|'));
    for (const prefix of emitted) {
      assert.ok(known.has(prefix), prefix + '- findings would get no disposition row at all');
    }
  });
});

// ---------------------------------------------------------------------------
// #3861 round 1, second pass — defects found by adversarially reviewing the
// round's OWN fixes before pushing them. Every one of these was invisible to
// the maintainer's review and to the first pass above.
// ---------------------------------------------------------------------------

describe('#3861 round 1 — fence tracking, status gating, count consistency', () => {
  test('a foreign fence marker inside a fenced example does not swap example for finding', () => {
    // The worst shape this file has carried: a bare fenced/not-fenced toggle treats ``` and ~~~
    // as interchangeable, so a ~~~ line inside a ``` example CLOSES the fence and the example's
    // real close REOPENS one. The ledger then records the ILLUSTRATION and drops the finding —
    // a confidently-written artifact that is wrong in both directions at once.
    const review = ['---', 'status: issues_found', '---', '', '```', '~~~',
      '### CR-77: an example inside a fence', '```', '', '### CR-01: a real finding'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: review }).ledger);
    assert.deepStrictEqual(rows.map((r) => r.id), ['CR-01'], 'the real finding, and only it');
  });

  test('a longer close does not require an exact-length match, per CommonMark', () => {
    const review = ['---', 'status: issues_found', '---', '', '```',
      '### CR-77: fenced', '````', '', '### CR-01: real'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: review }).ledger);
    assert.deepStrictEqual(rows.map((r) => r.id), ['CR-01']);
  });

  test('the disposition block gates on review status in shell, not in prose', { skip: !HAS_BASH }, () => {
    // Block 1 computes REVIEW_STATUS and emits nothing, and its shell is discarded — so a
    // condition stated only in the prose between the blocks is not available to anything. A
    // clean re-review would otherwise rewrite a ledger it was never meant to touch.
    const fences = bashFences(fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8'));
    assert.ok(fences.length >= 2, 'the step must still carry more than one shell block');
    assert.match(fences[1], /REVIEW_STATUS/, 'block 2 must re-derive the status it is gated on');
    assert.match(fences[1], /clean\|skipped/, 'and gate on the documented clean/skipped/empty set');
  });

  test('an internally inconsistent breakdown is withheld, not half-rendered', { skip: !HAS_BASH }, () => {
    // `total: 0` beside `critical: 1` is four valid numbers producing a self-contradicting
    // line. Numeric is necessary, not sufficient.
    const shipped = runShippedGateCounts({
      reviewText: ['---', 'findings:', '  critical: 1', '  warning: 0', '  info: 0',
        '  total: 0', 'status: issues_found', '---'].join('\n'),
    });
    assert.strictEqual(readGateMessage(shipped.stdout).countsOk, '0',
      'the counts do not sum to the total, so no breakdown');
  });

  test('a consistent breakdown is still reported', { skip: !HAS_BASH }, () => {
    // Negative control for the sum check — it must not withhold a correct breakdown.
    const shipped = runShippedGateCounts({ reviewText: REVIEW_WITH_FINDINGS });
    assert.strictEqual(readGateMessage(shipped.stdout).countsOk, '1');
  });

  test('a carried finding that REAPPEARS loses the carried marker', () => {
    // The defect that storing the cell verbatim introduced, and the reason the strip is back.
    // Run 1 carries CR-01 and marks it; run 2 reports CR-01 again. If the marker were permanent
    // the ledger would state 'not in the current review' about a finding plainly in it —
    // an artifact confidently wrong about its own contents.
    const absent = ['---', 'status: issues_found', '---', '', '### WR-01: other'].join('\n');
    const back = ['---', 'status: issues_found', '---', '', '### CR-01: it came back'].join('\n');
    const prior = '| CR-01 | critical | deferred | waiting on ADR-9 |';
    const run1 = runShippedDisposition({ reviewText: absent, priorText: prior });
    assert.strictEqual(
      ledgerRows(run1.ledger).find((r) => r.id === 'CR-01').source,
      'waiting on ADR-9 (not in the current review)', 'carried, and marked as such'
    );
    const run2 = runShippedDisposition({ reviewText: back, priorText: run1.ledger });
    const row = ledgerRows(run2.ledger).find((r) => r.id === 'CR-01');
    assert.strictEqual(row.source, 'waiting on ADR-9', 'the marker goes when the finding returns');
    assert.strictEqual(row.disposition, 'deferred', 'and the decision itself is still preserved');
  });

  test('a carried row still does not grow its marker across runs', () => {
    // The property the strip exists for, re-pinned now that it is bounded.
    const review = ['---', 'status: issues_found', '---', '', '### WR-01: unrelated'].join('\n');
    const prior = '| CR-01 | critical | deferred | waiting on ADR-9 (not in the current review) |';
    const first = runShippedDisposition({ reviewText: review, priorText: prior });
    const carried = ledgerRows(first.ledger).find((r) => r.id === 'CR-01');
    assert.strictEqual(carried.source, 'waiting on ADR-9 (not in the current review)');
    const second = runShippedDisposition({ reviewText: review, priorText: first.ledger });
    assert.strictEqual(
      ledgerRows(second.ledger).find((r) => r.id === 'CR-01').source,
      'waiting on ADR-9 (not in the current review)',
      'exactly one marker, however many times the gate runs'
    );
  });
});

// ---------------------------------------------------------------------------
// #3861 round 1, third pass — the fidelity gap that let the second pass ship a
// regression the whole suite was green over.
//
// Every test above extracts the embedded script as TEXT and runs it. Bash does
// not: it expands the double-quoted `node -e "..."` argument first, so an
// unescaped backtick is COMMAND SUBSTITUTION and the script Node receives is
// not the script the tests read. That is not a hypothetical — the previous
// commit shipped exactly that, in a code comment, and 122 green tests said
// nothing because none of them ever asked bash what it would actually pass.
// ---------------------------------------------------------------------------

describe('#3861 round 1 — the tests must run what BASH would run', () => {
  test('bash expansion of the node -e argument matches what the tests extract', { skip: !HAS_BASH }, () => {
    // Ask bash for the literal argument it would hand node, and compare. This is the general
    // guard: it catches an unescaped backtick, an unescaped $, and any other expansion the
    // extractor's two-escape undo cannot model — none of which the behavioural tests can see.
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8').replace(/\r\n/g, '\n');
    const open = src.indexOf('node -e "');
    const body = src.slice(open + 'node -e "'.length);
    const end = body.indexOf('\n" || echo ');
    assert.ok(end !== -1, 'the node -e script must still be closed by its || echo fallback');
    const quoted = body.slice(0, end);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3861-fid-'));
    try {
      const out = path.join(dir, 'arg.txt');
      // `printf %s` with the SAME double-quoted string the step uses: whatever bash does to it
      // on the way to node, it does here too.
      const probe = 'printf %s "' + quoted + '" > ' + JSON.stringify(out) + '\n';
      const res = runHook('-c', [probe], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
      assert.strictEqual(res.outcome, OUTCOME.EXITED, 'the probe must run to completion');
      assert.strictEqual(
        res.stderr.trim(), '',
        'bash emitted diagnostics expanding the node -e argument — an unescaped backtick or $: ' + res.stderr
      );
      assert.strictEqual(
        fs.readFileSync(out, 'utf8'), shippedDispositionScript(),
        'bash hands node a DIFFERENT script than the tests exercise'
      );
    } finally {
      cleanup(dir);
    }
  });

  // Run ONLY the status guard at the head of the disposition block — everything up to the shim
  // preamble. runShippedDisposition drives the node script directly and never sees this shell at
  // all, so a test written against it says nothing about the guard: it passed unchanged with the
  // guard made unconditional, which is exactly the vacuity this helper exists to remove.
  function runDispositionGuard({ reviewText, withLedger, withFix, withIterFix }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3861-grd-'));
    try {
      fs.writeFileSync(path.join(dir, '01-REVIEW.md'), reviewText);
      if (withLedger) fs.writeFileSync(path.join(dir, '01-REVIEW-DISPOSITION.md'), '| CR-01 | critical | deferred | x |\n');
      if (withFix) fs.writeFileSync(path.join(dir, '01-REVIEW-FIX.md'), '## Fixed Issues\n\n### CR-01: a thing\n');
      if (withIterFix) fs.writeFileSync(path.join(dir, '01-REVIEW-FIX.iter2.md'), '## Fixed Issues\n\n### CR-01: a thing\n');
      const fence = bashFences(fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8'))[1];
      const cut = fence.indexOf('_GSD_SHIM_NAME=');
      assert.ok(cut > 0, 'the disposition block must still open with its guard, then the shim');
      const script = 'set -euo pipefail\n' + fence.slice(0, cut) + '\nprintf "PROCEEDED\\n"\n';
      const res = runHook('-c', [script], {
        interpreter: 'bash',
        timeoutMs: PROBE_TIMEOUT_MS,
        env: { ...process.env, PHASE_DIR: dir, PHASE_NUMBER: '1' },
      });
      assert.strictEqual(res.outcome, OUTCOME.EXITED, 'the guard must run to completion');
      return { proceeded: /PROCEEDED/.test(res.stdout), stdout: res.stdout, exitCode: res.exitCode };
    } finally {
      cleanup(dir);
    }
  }

  test('a clean review with no ledger is skipped', { skip: !HAS_BASH }, () => {
    const out = runDispositionGuard({ reviewText: ['---', 'status: clean', '---'].join('\n') });
    assert.strictEqual(out.proceeded, false, 'nothing to record and nothing to reconcile');
    assert.match(out.stdout, /skipped \(status: clean\)/);
  });

  test('a clean review with an EXISTING ledger still proceeds, to reconcile it', { skip: !HAS_BASH }, () => {
    // Freezing the ledger here would leave findings showing as open that the review no longer
    // reports — the case the embedded script's own reconciliation path is written for. A guard
    // that skipped unconditionally would make that path unreachable on exactly the run needing it.
    const out = runDispositionGuard({ reviewText: ['---', 'status: clean', '---'].join('\n'), withLedger: true });
    assert.strictEqual(out.proceeded, true, 'an existing ledger must still be reconciled');
    assert.match(out.stdout, /reconciling the fix report and any existing disposition ledger/);
  });

  test('a review reporting issues always proceeds', { skip: !HAS_BASH }, () => {
    const out = runDispositionGuard({ reviewText: ['---', 'status: issues_found', '---'].join('\n') });
    assert.strictEqual(out.proceeded, true);
  });

  // #3861 round 5 — a converged `--auto` run reaches the guard with a CLEAN review and, on a direct
  // /gsd-code-review invocation, no gate-written ledger. Keying the skip on the ledger alone meant a
  // fully successful multi-iteration run — every finding fixed and committed — recorded nothing at all.
  test('a clean review with NO ledger but a fix report still proceeds', { skip: !HAS_BASH }, () => {
    const out = runDispositionGuard({ reviewText: ['---', 'status: clean', '---'].join('\n'), withFix: true });
    assert.strictEqual(out.proceeded, true, 'a fix report is a decision to record, ledger or not');
    assert.match(out.stdout, /reconciling the fix report/);
  });

  test('a clean review with NO ledger but only an ITERATION fix report still proceeds', { skip: !HAS_BASH }, () => {
    // The converged loop's earlier iterations survive only as <NN>-REVIEW-FIX.iterN.md, so the
    // backups have to count toward the guard exactly as the final report does.
    const out = runDispositionGuard({ reviewText: ['---', 'status: clean', '---'].join('\n'), withIterFix: true });
    assert.strictEqual(out.proceeded, true, 'an iteration backup is a decision to record too');
  });

  test('a clean review with neither a ledger nor any fix report is still skipped', { skip: !HAS_BASH }, () => {
    // The widening must not become "always proceed" — the original skip is still correct when
    // there is genuinely nothing to record.
    const out = runDispositionGuard({ reviewText: ['---', 'status: clean', '---'].join('\n') });
    assert.strictEqual(out.proceeded, false);
    assert.match(out.stdout, /skipped \(status: clean\)/);
  });

  // ── #3861 round 5 — the --auto multi-iteration reconciliation gap ──────────────────────────
  //
  // code-review-fix.md overwrites REVIEW-FIX.md on every iteration and DELETES the .iterN.md
  // backups on convergence, so a finding fixed in iteration 1 was absent from the final fix report
  // AND from the final review (it was fixed, so the re-review stopped reporting it). The step then
  // fell back to the gate's `open` row and rendered `open ... (not in the current review)` — the
  // same bytes a finding that vanished for an unrelated reason produces.

  test('a fix report naming a finding the review no longer reports records it FIXED, not open', () => {
    // The precise site: sameTitle(undefined, h.title) is false and title.has(id) is false too, so
    // the entry entered NEITHER applied NOR staleFix and was dropped in silence.
    const review = ['---', 'status: issues_found', '---', '', '### WR-09: something else'].join('\n');
    const fix = ['## Fixed Issues', '', '### CR-01: the one fixed earlier'].join('\n');
    const out = runShippedDisposition({ reviewText: review, fixText: fix });
    const rows = ledgerRows(out.ledger);
    const cr = rows.find((r) => r.id === 'CR-01');
    assert.ok(cr, 'the fixed finding must have a row at all');
    assert.strictEqual(cr.disposition, 'fixed', 'a committed fix must not render as open');
    assert.match(cr.source, /not in the current review/, 'and it must be marked as no longer reported');
  });

  test('an ITERATION fix report is reconciled even when the final report has moved on', () => {
    // The reviewer's scenario end to end: iteration 1 fixed CR-01, iteration 3 fixed WR-09, and the
    // final REVIEW-FIX.md carries only the last iteration's scope.
    const review = ['---', 'status: issues_found', '---', '', '### IN-07: still open'].join('\n');
    const fix = ['## Fixed Issues', '', '### WR-09: fixed last'].join('\n');
    const iter = { 2: ['## Fixed Issues', '', '### CR-01: fixed in iteration one'].join('\n') };
    const out = runShippedDisposition({ reviewText: review, fixText: fix, iterFixText: iter });
    const rows = ledgerRows(out.ledger);
    assert.strictEqual(rows.find((r) => r.id === 'CR-01').disposition, 'fixed');
    assert.strictEqual(rows.find((r) => r.id === 'WR-09').disposition, 'fixed');
    assert.strictEqual(rows.find((r) => r.id === 'IN-07').disposition, 'open');
  });

  test('the NEWEST fix report wins when two iterations decide the same id differently', () => {
    // Reports are read newest-first, so first-occurrence-wins gives the most recent statement —
    // the same precedence a duplicate id already gets WITHIN one report.
    const review = ['---', 'status: issues_found', '---', '', '### IN-07: unrelated'].join('\n');
    const fix = ['## Skipped Issues', '', '### CR-01: contested'].join('\n');
    const iter = { 2: ['## Fixed Issues', '', '### CR-01: contested'].join('\n') };
    const out = runShippedDisposition({ reviewText: review, fixText: fix, iterFixText: iter });
    assert.strictEqual(ledgerRows(out.ledger).find((r) => r.id === 'CR-01').disposition, 'skipped');
  });

  test('a REUSED id whose title differs is NOT inherited as fixed — the stale-report arm still rules', () => {
    // The negative control for the arm added above. Re-review renumbers, so an earlier iteration's
    // CR-01 and the current review's CR-01 can be different findings; carrying the decision across
    // that boundary would render a false `fixed`, which is worse than the `open` it replaced.
    const review = ['---', 'status: issues_found', '---', '', '### CR-01: a brand new finding'].join('\n');
    const iter = { 2: ['## Fixed Issues', '', '### CR-01: an older, different finding'].join('\n') };
    const out = runShippedDisposition({ reviewText: review, iterFixText: iter });
    const cr = ledgerRows(out.ledger).find((r) => r.id === 'CR-01');
    assert.strictEqual(cr.disposition, 'open', 'a different finding under a reused id must stay open');
    assert.match(out.stdout, /title their finding differently|titles its finding differently/,
      'and the mismatch must be stated, not swallowed');
  });

  // ── #3861 round 5 rework — a REUSED finding id must not inherit the old finding's decision ──
  //
  // Found by the round's own adversarial review, which drove it: ids are reused across re-reviews
  // (the --auto loop renumbers), and row() inherited a prior decision on an id match alone. A prior
  // 'CR-01 fixed' against a review reporting a brand-new CR-01 rendered the NEW finding `fixed` — a
  // false decision in the artifact whose entire purpose is telling triaged from forgotten.

  test('the ledger does not promise a preservation it no longer makes', () => {
    // The rendered text said "preserves every row and every disposition" while the step had gained
    // an intentional drop for a reused id — shipped, user-facing text asserting something false.
    // And the console must not point at git: committing is gated on commit_docs and a failed commit
    // is swallowed, so under commit_docs=false the overwritten decision may exist nowhere.
    // Round 5 found this test VACUOUS: it ran with no prior ledger, so no reuse ever occurred and
    // the `is in git` assertion could not have failed however the console was worded. Driven through
    // a real drop now, so the negative assertion is made against a console line that actually exists.
    const seed = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: the original finding'].join('\n'),
      priorText: '| CR-01 | critical | deferred | waiting on the vendor |\n',
    });
    const out = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: a brand new finding'].join('\n'),
      priorText: seed.ledger,
    });
    assert.match(out.stdout, /decision\(s\) DROPPED/, 'precondition: this run must actually drop a decision');
    assert.doesNotMatch(out.ledger, /preserves every row and every disposition/,
      'the unqualified preservation promise must not return');
    assert.match(out.ledger, /id is REUSED/, 'and the one exception must be stated where a reader meets it');
    assert.doesNotMatch(out.stdout, /is in git/, 'the console must not assert a recovery path that may not exist');
  });

  test('an `open` prior is replaced SILENTLY, and the shipped text says so', () => {
    // Round 5: the legend and both feature docs claimed the drop is named on the console
    // unconditionally. It is not — `row()` reports only a RECORDED decision (`was.d !== 'open'`).
    // The behaviour is deliberate (an `open` row records no decision to lose); the text was wrong.
    const seed = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: the original finding'].join('\n'),
    });
    assert.strictEqual(ledgerRows(seed.ledger).find((r) => r.id === 'CR-01').disposition, 'open');
    const out = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: a brand new finding'].join('\n'),
      priorText: seed.ledger,
    });
    assert.doesNotMatch(out.stdout, /DROPPED/, 'an untriaged prior row is replaced without a report');
    assert.match(out.ledger, /a row still at `open` is replaced silently/,
      'and the legend must state that exception rather than promising an unconditional report');
  });

  test('a dropped decision is REPORTED on the console, not lost quietly', () => {
    // The `superseded:` block that preserved these was tried and withdrawn — it produced a fresh
    // defect on each of three review passes. What survives is the guard (no false `fixed`) plus an
    // explicit report; the prior ledger row remains in git.
    const seed = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: the original finding'].join('\n'),
      priorText: '| CR-01 | critical | deferred | waiting on the vendor |\n',
    });
    const out = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: a brand new finding'].join('\n'),
      priorText: seed.ledger,
    });
    assert.strictEqual(ledgerRows(out.ledger).find((r) => r.id === 'CR-01').disposition, 'open');
    assert.match(out.stdout, /decision\(s\) DROPPED/, 'the drop must be stated');
    assert.match(out.stdout, /CR-01=deferred/, 'naming the id and what was decided');
    assert.doesNotMatch(out.ledger, /^superseded:/m, 'and no preservation block is written');
  });

  test('a prior decision is NOT inherited when the id now names a different finding', () => {
    const first = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: the original finding'].join('\n'),
      fixText: ['## Fixed Issues', '', '### CR-01: the original finding'].join('\n'),
    });
    assert.strictEqual(ledgerRows(first.ledger).find((r) => r.id === 'CR-01').disposition, 'fixed');
    assert.match(first.ledger, /title: "the original finding"/, 'the title must be recorded to make reuse detectable');

    const second = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: a brand new finding'].join('\n'),
      priorText: first.ledger,
    });
    const cr = ledgerRows(second.ledger).find((r) => r.id === 'CR-01');
    assert.strictEqual(cr.disposition, 'open', 'a different finding under a reused id must be untriaged');
  });



  test('an EMPTY title is recorded, so it cannot read back as a pre-format ledger', () => {
    // The leak that came back three passes running: while an empty title emitted no `title:` key,
    // an empty-titled finding read back as legacy and inherited a decision across a reused id.
    const first = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### IN-07: unrelated'].join('\n'),
      iterFixText: { 2: ['## Fixed Issues', '', '### CR-01:'].join('\n') },
    });
    assert.match(first.ledger, /title: ""/, 'an empty title is still recorded, explicitly');
    const second = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: a brand new finding'].join('\n'),
      priorText: first.ledger,
    });
    assert.strictEqual(ledgerRows(second.ledger).find((r) => r.id === 'CR-01').disposition, 'open',
      'an empty recorded title is a title, not an absent one');
  });

  test('a pre-format ledger whose title merely LOOKS like JSON keeps its quotes', () => {
    // Without the `titles: json` marker, JSON.parse ran on every value — so a legacy bare title
    // written as "quoted whole title" lost its quotes, stopped matching, and flipped to open.
    const out = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: "quoted whole title"'].join('\n'),
      priorText: [
        '---', 'phase: 01', 'review: 01-REVIEW.md', 'findings:',
        '  - id: CR-01', '    severity: critical', '    disposition: deferred',
        '    title: "quoted whole title"', 'open: 0', 'total: 1', 'recorded: x', '---', '',
        '| CR-01 | critical | deferred | a reason |',
      ].join('\n'),
    });
    const cr = ledgerRows(out.ledger).find((r) => r.id === 'CR-01');
    assert.strictEqual(cr.disposition, 'deferred', 'the legacy title must still identify the finding');
    assert.doesNotMatch(out.stdout, /DROPPED/, 'and no drop may be reported');
  });

  test('a prior ledger with NO recorded title still inherits its decision (back-compat)', () => {
    // A ledger written before titles were recorded carries none. Refusing to inherit there would
    // reset every decision in it — the loss this guard exists to prevent, caused by the guard.
    const out = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: whatever it is called now'].join('\n'),
      priorText: '| CR-01 | critical | deferred | a reason from an older ledger |\n',
    });
    const cr = ledgerRows(out.ledger).find((r) => r.id === 'CR-01');
    assert.strictEqual(cr.disposition, 'deferred', 'an absent prior title must inherit, not reset');
    assert.strictEqual(cr.source, 'a reason from an older ledger');
  });

  test('an iteration-derived decision cites the report it actually came from', () => {
    // The Source cell hard-coded the unsuffixed <NN>-REVIEW-FIX.md, so a decision read out of an
    // iteration backup cited a file that may not exist. A citation the reader cannot follow is
    // worse than none.
    const out = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### IN-07: unrelated'].join('\n'),
      iterFixText: { 2: ['## Fixed Issues', '', '### CR-01: fixed in iteration one'].join('\n') },
    });
    const cr = ledgerRows(out.ledger).find((r) => r.id === 'CR-01');
    assert.strictEqual(cr.disposition, 'fixed');
    assert.match(cr.source, /01-REVIEW-FIX\.iter2\.md/, 'the cited report must be the one that decided it');
  });

  // ── #3861 round 5, second rework pass — four defects the review drove out of the FIRST fix ──

  test('an iteration-only decision records the title it was decided under', () => {
    // Without this the row was written with NO title -- the current review does not report the
    // finding, so nothing else knows one -- and the next review reusing that id then hit the
    // title-ABSENT back-compat exception and inherited the old `fixed`. The very defect the title
    // machinery exists to close, surviving through the hole opened for legacy ledgers.
    const first = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### IN-07: unrelated'].join('\n'),
      iterFixText: { 2: ['## Fixed Issues', '', '### CR-01: the original finding'].join('\n') },
    });
    assert.match(first.ledger, /title: "the original finding"/, 'the deciding title must be recorded');

    const second = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: a brand new finding'].join('\n'),
      priorText: first.ledger,
    });
    assert.strictEqual(ledgerRows(second.ledger).find((r) => r.id === 'CR-01').disposition, 'open',
      'a reused id must not inherit a decision recorded for a different finding');
  });



  test('the ledger frontmatter is valid YAML even when a title contains a colon', () => {
    // `title: Parser: loses data` is not YAML — a real reader returns 'bad indentation of a mapping
    // entry'. The values are emitted as JSON scalars, which YAML 1.2 reads as double-quoted strings.
    const yaml = require('js-yaml');
    const out = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: Parser: loses data'].join('\n'),
    });
    const fm = yaml.load(out.ledger.split('---')[1]);
    assert.strictEqual(fm.findings[0].title, 'Parser: loses data', 'the colon must survive the round trip');
    // And the title still round-trips through the parser as an identity, so a re-run is unchanged.
    const again = runShippedDisposition({
      reviewText: ['---', 'status: issues_found', '---', '', '### CR-01: Parser: loses data'].join('\n'),
      priorText: out.ledger,
    });
    assert.strictEqual(again.wroteNothing, true, 'a second run must still report unchanged');
  });

  test('a carried human reason ending in the marker is preserved, and not doubled', () => {
    // Neither stripped (the previous fix's residue) nor appended twice.
    const review = ['---', 'status: issues_found', '---', '', '### WR-01: unrelated'].join('\n');
    const prior = '| CR-01 | critical | deferred | defer because (not in the current review) |';
    const first = runShippedDisposition({ reviewText: review, priorText: prior });
    const carried = ledgerRows(first.ledger).find((r) => r.id === 'CR-01');
    assert.strictEqual(carried.source, 'defer because (not in the current review)');
    const second = runShippedDisposition({ reviewText: review, priorText: first.ledger });
    assert.strictEqual(
      ledgerRows(second.ledger).find((r) => r.id === 'CR-01').source,
      'defer because (not in the current review)',
      'stable across runs — the render appends nothing it can already see'
    );
  });

  test('a leading-zero count is evaluated, not silently skipped', { skip: !HAS_BASH }, () => {
    // Bash infers the base from a leading zero, so `critical: 08` made $(( )) fail. It does NOT
    // abort — the expansion sits in an `if` condition, where set -e does not fire — which is
    // worse: the sum check silently does not run, an inconsistent breakdown passes, and the
    // only trace is a stray diagnostic on stderr. Asserting exit 0 alone is vacuous here; it
    // was true before the fix too. Assert the check's OUTCOME and the absent diagnostic.
    const padded = (total) => ['---', 'findings:', '  critical: 08', '  warning: 0',
      '  info: 0', '  total: ' + total, 'status: issues_found', '---'].join('\n');
    const inconsistent = runShippedGateCounts({ reviewText: padded('9') });
    assert.strictEqual(readGateMessage(inconsistent.stdout).countsOk, '0',
      '08 + 0 + 0 is 8, not 9 \u2014 the check must FIRE');
    assert.doesNotMatch(inconsistent.stderr, /value too great for base/,
      'the padded count must be read as decimal, not left to base inference');
    const consistent = runShippedGateCounts({ reviewText: padded('8') });
    assert.strictEqual(consistent.exitCode, 0, 'an advisory gate must not abort on a padded count');
    assert.strictEqual(readGateMessage(consistent.stdout).countsOk, '1',
      '08 + 0 + 0 is 8, so the breakdown is consistent');
  });

  test('a fence indented past three spaces is not a fence', { skip: !HAS_BASH }, () => {
    // CommonMark: at most three leading spaces open a fence; four is an indented code block.
    const src = fs.readFileSync(DISPOSITION_STEP_PATH, 'utf8');
    assert.match(src, /\^ \{0,3\}\(/, 'the fence matcher must bound its leading whitespace');
  });
});

// Placement here is now incidental. This block used to be pinned to the end of the file because
// HAS_BASH was declared mid-file and a `skip` option referencing it from an earlier block hit the
// temporal dead zone -- cancelling its neighbours rather than failing visibly. HAS_BASH is
// declared with the file's other top-level constants now, so that constraint is gone and this
// block may be moved beside its siblings whenever someone is tidying.
describe('#3861 round 1 — count validation, executed', () => {
  test('all four counts are validated before the breakdown is shown', { skip: !HAS_BASH }, () => {
    // Was a `src.includes()` assertion on the exact `case` line, which broke the moment that
    // line grew a length bound. The behaviour is what matters and is now executed directly.
    const counts = (c, w, i, t) => ['---', 'findings:', '  critical: ' + c, '  warning: ' + w,
      '  info: ' + i, '  total: ' + t, 'status: issues_found', '---'].join('\n');
    const ok = (t) => readGateMessage(runShippedGateCounts({ reviewText: t }).stdout).countsOk;
    assert.strictEqual(ok(counts('x', '0', '0', '0')), '0',
      'a non-numeric count withholds the whole breakdown');
    assert.strictEqual(ok(counts('1', '2', '1', '4')), '1');
    // Bash integers wrap at 2^64, so a 20-digit count reaches the sum as 0 and an inconsistent
    // breakdown passes. Length-bounded, because no review reports nine digits of findings.
    assert.strictEqual(ok(counts('18446744073709551616', '0', '0', '0')), '0',
      'a count long enough to wrap the sum is not a count');
  });

  test('the count-length threshold is covered at limit-1, limit and limit+1', { skip: !HAS_BASH }, () => {
    // M2. The guard is `?????????*` -- nine or more characters -- so the limit is 8 digits
    // ACCEPTED, 9 REJECTED. The only cases here were 'x', single digits and a 20-digit value,
    // none of which pins the boundary: dropping one `?` moves the limit to 7 digits and no test
    // would have noticed. All three points are asserted, and the sum is kept consistent at each
    // so the length rule is what decides the verdict rather than the sum check.
    const counts = (c, w, i, t) => ['---', 'findings:', '  critical: ' + c, '  warning: ' + w,
      '  info: ' + i, '  total: ' + t, 'status: issues_found', '---'].join('\n');
    const ok = (t) => readGateMessage(runShippedGateCounts({ reviewText: t }).stdout).countsOk;
    const d = (n) => '1'.padEnd(n, '0');       // n digits, leading 1 so the value is exact
    assert.strictEqual(d(7).length, 7);
    assert.strictEqual(d(8).length, 8);
    assert.strictEqual(d(9).length, 9);
    assert.strictEqual(ok(counts(d(7), '0', '0', d(7))), '1', 'limit-1: 7 digits is accepted');
    assert.strictEqual(ok(counts(d(8), '0', '0', d(8))), '1', 'limit: 8 digits is accepted');
    assert.strictEqual(ok(counts(d(9), '0', '0', d(9))), '0', 'limit+1: 9 digits is rejected');
  });
});

describe('#3861 round 1 — an absent review still reconciles', () => {
  test('a missing REVIEW.md does not abandon an existing ledger', () => {
    // The status guard proceeds when a ledger exists, so the script must tolerate the review
    // being gone: reading it unconditionally threw, the trailing fallback swallowed it, and the
    // ledger was left frozen — the exact freeze the reconciliation path exists to prevent.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3861-abs-'));
    try {
      const dispPath = path.join(dir, '01-REVIEW-DISPOSITION.md');
      fs.writeFileSync(dispPath, ['| CR-01 | critical | deferred | waiting on ADR-9 |',
        '| WR-09 | warning | open | - |'].join('\n'));
      const res = runNode(['-e', shippedDispositionScript()], {
        timeoutMs: PROBE_TIMEOUT_MS,
        env: {
          ...process.env,
          REVIEW_FILE: path.join(dir, '01-REVIEW.md'),   // deliberately absent
          DISPOSITION_FILE: dispPath,
          FIX_REPORT_FILE: path.join(dir, '01-REVIEW-FIX.md'),
          PADDED: '01',
        },
      });
      assert.strictEqual(res.outcome, OUTCOME.EXITED);
      assert.strictEqual(res.exitCode, 0, 'an absent review is not an error: ' + res.stderr);
      const rows = ledgerRows(fs.readFileSync(dispPath, 'utf8'));
      assert.deepStrictEqual(rows.map((r) => r.id), ['CR-01', 'WR-09'],
        'an absent review reconciles the ledger; it does not delete rows from it');
      assert.match(rows[0].source, /not in the current review/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('#3861 round 1 — fence closers and one-letter prefixes', () => {
  test('a line with an info string is an opener shape, never a closer', () => {
    // CommonMark: a closing fence carries only whitespace after its marker. Treating an
    // info-string line as a close ends the fence early and admits the example headings under it.
    const review = ['---', 'status: issues_found', '---', '', '```',
      '```js', '### CR-77: still inside the fence', '```', '', '### CR-01: real'].join('\n');
    const rows = ledgerRows(runShippedDisposition({ reviewText: review }).ledger);
    assert.deepStrictEqual(rows.map((r) => r.id), ['CR-01']);
  });

  test('a one-letter finding prefix in the agent template is not invisible', () => {
    // The domain scan required [A-Z]{2,}, so a template heading like `### C-01:` — explicit and
    // parseable, not prose — contributed nothing and the guard passed over a finding shape the
    // ledger would drop entirely.
    const agent = fs.readFileSync(REVIEWER_AGENT_PATH, 'utf8');
    const emitted = [...agent.matchAll(/^###\s+([A-Z]+)-\d+:/gm)].map((m) => m[1]);
    assert.ok(emitted.length > 0, 'the reviewer agent must still declare its finding-id shapes');
    const oneLetter = [...'### C-01: x'.matchAll(/^###\s+([A-Z]+)-\d+:/gm)].map((m) => m[1]);
    assert.deepStrictEqual(oneLetter, ['C'], 'the scan must admit a single-letter prefix');
  });
});
