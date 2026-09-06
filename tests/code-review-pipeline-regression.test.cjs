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
const { runHook } = require('./helpers/process-seam.cjs');
const { toLegacyResult, gitOrThrow } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS, GIT_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, createTempGitProject, cleanup, readFileNormalized } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md');
const PRE_PASS_STEP_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review', 'steps', 'structural-pre-pass.md');
const FIXER_PATH = path.join(ROOT, 'agents', 'gsd-code-fixer.md');
const REVIEWER_PATH = path.join(ROOT, 'agents', 'gsd-code-reviewer.md');

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

  // #2666 docs-parity: the Tier-3 fallback must intersect with the SUMMARY
  // scope and warn on dropped files (not only fire on zero Tier-2 hits).
  // #3926 changed the cross-check's SOURCE from `git diff --name-only
  // ${DIFF_BASE}..HEAD` to the PHASE_DIFF_FILES union derived from the phase
  // commits themselves — the cross-check itself (compare + warn + add) stays.
  test('#2666 docs-parity: Tier-3 intersects/warns against the phase change set', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    // Pin the cross-check's own lines INSIDE the Tier-3 fence — a whole-doc
    // grep passes even with the cross-check deleted (driven by the #3926
    // pre-file adversarial review): scope every assertion to the fence.
    const fenceStart = src.indexOf('# Compute diff base from phase commits');
    assert.ok(fenceStart !== -1, 'Tier-3 fence anchor must exist');
    const fenceEnd = src.indexOf('\n```', fenceStart);
    const fence = src.slice(fenceStart, fenceEnd);
    assert.ok(
      fence.includes('DIFF_FILES="$PHASE_DIFF_FILES"'),
      'the cross-check must compare against the phase change set (#2666, #3926)'
    );
    assert.ok(
      fence.includes('MISSING_FROM_SUMMARY+=("$file"); REVIEW_FILES+=("$file")'),
      'the cross-check must ADD files the SUMMARY missed to the review scope (#2666)'
    );
    assert.ok(
      fence.includes('Warning: SUMMARY scope was missing'),
      'the cross-check must WARN when the SUMMARY missed changed files (#2666)'
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
// #3926 — the Tier-3 change set must be bounded at the phase, not at HEAD.
//
// Both Tier-3 consumers (the D-02 full fallback and the #2666 SUMMARY
// cross-check) used `git diff ${DIFF_BASE}..HEAD`: the base was the phase's
// first commit (correct since #3503) but the tip was unconditionally HEAD, so
// every commit landed outside the phase — interleaved from other sessions, or
// after the phase closed — joined the review scope. The #2666 cross-check
// ADDS its findings to REVIEW_FILES, so the inflation became the scope, and
// the inflated count crossed code-review-depth.cjs's >50 threshold, silently
// downgrading --depth=deep to standard (measured: a 20-file phase scoped as
// 248 files). Fix: derive the change set from PHASE_COMMITS themselves —
// exact under interleaved history, where a DIFF_BASE..<newest-phase-commit>
// bound recovers almost nothing (2 of 228 excess files on the measured repo).
//
// Same behavioral style as Bug 5: the SHIPPED bash is extracted from the
// workflow .md and executed via a real bash subprocess against a git fixture.
// ---------------------------------------------------------------------------

describe('#3926 — Tier-3 scope is the phase change set, not everything since the phase began', () => {
  const SKIP_WIN32 = { skip: process.platform === 'win32' };

  // The WHOLE Tier-3 fence: derivation plus both consumer branches (the D-02
  // fallback and the #2666 cross-check).
  function extractTier3FullFence() {
    const src = readFileNormalized(WORKFLOW_PATH);
    return fenceContaining(src, '# Compute diff base from phase commits');
  }

  const PHASE_DIR = '.planning/phases/06-ctx';

  function commitFile(repo, file, message) {
    const abs = path.join(repo, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${message}\n`);
    gitOrThrow(['add', '--', file], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', message], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
    return gitOrThrow(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim();
  }

  // Write (and commit) a SUMMARY whose `## Task Commits` section names `hashes`
  // in the shipped template's shape — numbered task lines, hash in BACKTICKS,
  // section terminated by the next `## ` heading. That shape is pinned by
  // scripts/lint-summary-task-commits-drift.cjs.
  function commitSummary(repo, hashes, eol = '\n') {
    const body = [
      '---',
      'phase: 06',
      '---',
      '',
      '## Task Commits',
      '',
      ...hashes.map((h, i) => `${i + 1}. **Task ${i + 1}: work** - \`${h}\` (feat)`),
      '',
      '## Files Created/Modified',
      '',
      '## Next Phase Readiness',
      '',
    ].join(eol);
    const rel = `${PHASE_DIR}/06-1-SUMMARY.md`;
    fs.mkdirSync(path.join(repo, PHASE_DIR), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
    gitOrThrow(['add', '--', rel], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'docs: phase summary'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
  }

  // Phase-06's own commits touch phase-a/phase-b; unrelated commits land before
  // the phase, interleaved INSIDE the phase window, and after the phase closed.
  // HEAD sits on the post-phase commit, as in any re-review of a closed phase.
  //
  // Every commit SUBJECT here is deliberately unscoped — no `feat(06)`, no
  // `test(6-3)`. That is the point: membership comes from the SUMMARY's
  // `## Task Commits` record, so a fixture that still leaked phase-scoped
  // subjects could pass under a message grep and prove nothing about #3995's
  // ban on that class.
  function buildScopeFixture(prefix, eol = '\n') {
    const repo = createTempGitProject(prefix);
    commitFile(repo, 'pre.txt', 'chore: unrelated work before the phase');
    // Creating the phase directory is what anchors PHASE_START (#3995).
    commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
    const phaseA = commitFile(repo, 'phase-a.txt', 'chore: first phase commit, subject carries no phase scope');
    commitFile(repo, 'interleaved.txt', 'chore: unrelated work interleaved inside the phase window');
    const phaseB = commitFile(repo, 'phase-b.txt', 'chore: second phase commit, subject carries no phase scope');
    commitSummary(repo, [phaseA, phaseB], eol);
    commitFile(repo, 'post.txt', 'docs: unrelated work after the phase closed');
    return repo;
  }

  // Run the full Tier-3 fence with REVIEW_FILES seeded by `preamble`, then
  // sentinel-print the resulting scope.
  function runScope(repo, preamble) {
    const script = [
      'PADDED_PHASE=06',
      `PHASE_DIR=${PHASE_DIR}`,
      preamble,
      extractTier3FullFence(),
      'echo "===REVIEW_FILES==="',
      '[ ${#REVIEW_FILES[@]} -gt 0 ] && printf \'%s\\n\' "${REVIEW_FILES[@]}"',
      'echo "===END==="',
    ].join('\n');
    return toLegacyResult(
      runHook('-c', [script, 'bash'], {
        interpreter: 'bash',
        cwd: repo,
        timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      })
    );
  }

  test(
    'D-02 fallback scope is exactly the phase change set — pre-phase, interleaved, and post-phase files stay out',
    SKIP_WIN32,
    () => {
      const repo = buildScopeFixture('gsd-3926-fallback-');
      try {
        const result = runScope(repo, 'REVIEW_FILES=()');
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        const scope = parseSentinel(result.stdout, 'REVIEW_FILES');
        // Pre-fix: DIFF_BASE..HEAD also sweeps interleaved.txt and post.txt.
        assert.deepStrictEqual(
          scope.sort(),
          ['phase-a.txt', 'phase-b.txt'],
          `fallback scope must be the phase's own files; got: ${JSON.stringify(scope)}`
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'a CRLF SUMMARY is parsed the same as an LF one — the heading anchor tolerates the carriage return',
    SKIP_WIN32,
    () => {
      // Windows is a supported platform and git may check SUMMARYs out with
      // CRLF. The heading matcher was `/^## Task Commits[ \t]*$/`, which a
      // trailing \r does not satisfy — so the section never opened, the commit
      // set came back empty, and the phase silently scoped to nothing while the
      // drift lint (which normalises CRLF before matching) still reported clean.
      // Driven both ways: the old anchor extracted 0 hashes from CRLF and 1
      // from LF; the new one extracts 1 from each.
      const repo = buildScopeFixture('gsd-3926-crlf-', '\r\n');
      try {
        const result = runScope(repo, 'REVIEW_FILES=()');
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        const scope = parseSentinel(result.stdout, 'REVIEW_FILES');
        assert.deepStrictEqual(
          scope.sort(),
          ['phase-a.txt', 'phase-b.txt'],
          `a CRLF SUMMARY must scope identically to an LF one; got: ${JSON.stringify(scope)}`
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    '#2666 cross-check adds only phase files a partial SUMMARY missed — never out-of-phase commits',
    SKIP_WIN32,
    () => {
      const repo = buildScopeFixture('gsd-3926-crosscheck-');
      try {
        // SUMMARY surfaced only phase-a.txt; the cross-check must add
        // phase-b.txt and nothing else.
        const result = runScope(repo, 'REVIEW_FILES=(phase-a.txt)');
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        const scope = parseSentinel(result.stdout, 'REVIEW_FILES');
        // Pre-fix: the cross-check REVIEW_FILES+='s interleaved.txt and
        // post.txt too — the inflation that crossed the >50 depth-downgrade
        // threshold on the reporting repo.
        assert.deepStrictEqual(
          scope.sort(),
          ['phase-a.txt', 'phase-b.txt'],
          `cross-check must add only missed PHASE files; got: ${JSON.stringify(scope)}`
        );
        assert.match(
          result.stdout,
          /Warning: SUMMARY scope was missing 1 changed file/,
          'the cross-check must WARN about the file the SUMMARY missed (#2666)'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'a phase landing as one phase-scoped MERGE commit scopes to its first-parent diff, not the empty combined diff',
    SKIP_WIN32,
    () => {
      // Phase-06's work arrives as a clean --no-ff merge, and the SUMMARY's
      // `## Task Commits` names the MERGE commit itself — `git show` without
      // --first-parent prints an EMPTY combined diff for it, scoping the
      // phase to zero files (driven by the #3926 pre-file adversarial review).
      const repo = createTempGitProject('gsd-3926-merge-');
      try {
        commitFile(repo, 'base.txt', 'chore: base');
        commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
        gitOrThrow(['checkout', '-b', 'phase-branch'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        commitFile(repo, 'branch-work.txt', 'chore: branch work');
        gitOrThrow(['checkout', '-'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        gitOrThrow(['merge', '--no-ff', 'phase-branch', '-m', 'chore: land phase work'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        const mergeSha = gitOrThrow(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim();
        commitSummary(repo, [mergeSha]);
        const result = runScope(repo, 'REVIEW_FILES=()');
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        const scope = parseSentinel(result.stdout, 'REVIEW_FILES');
        assert.deepStrictEqual(
          scope,
          ['branch-work.txt'],
          `merge-landed phase must scope to its first-parent diff; got: ${JSON.stringify(scope)}`
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'a prior review narrows the set to task commits after it — #3661 wave scoping survives',
    SKIP_WIN32,
    () => {
      // DIFF_BASE prefers LAST_REVIEW_COMMIT over PHASE_START (#3661), so the
      // task-commit set must be filtered to commits reachable AFTER it. An
      // unfiltered set would re-widen a wave-scoped review back to the whole
      // phase — silently undoing #3661 while every other assertion here still
      // passed, which is why this branch gets its own fixture rather than
      // riding on the PHASE_START one.
      const repo = createTempGitProject('gsd-3926-waves-');
      try {
        commitFile(repo, 'pre.txt', 'chore: before the phase');
        commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
        const phaseA = commitFile(repo, 'phase-a.txt', 'chore: wave 1, already reviewed');
        const reviewCommit = commitFile(repo, `${PHASE_DIR}/06-REVIEW.md`, 'docs: wave 1 review');
        const phaseB = commitFile(repo, 'phase-b.txt', 'chore: wave 2, not yet reviewed');
        commitSummary(repo, [phaseA, phaseB]);

        const result = runScope(repo, `LAST_REVIEW_COMMIT=${reviewCommit}\nREVIEW_FILES=()`);
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.deepStrictEqual(
          (parseSentinel(result.stdout, 'REVIEW_FILES') || []).sort(),
          ['phase-b.txt'],
          'a wave-scoped review must see only task commits after the last review (#3661)'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'a hash quoted OUTSIDE `## Task Commits`, or unbackticked inside it, is not a phase commit',
    SKIP_WIN32,
    () => {
      // The parse is section-scoped AND backtick-anchored, and this exercises
      // both anchors behaviourally rather than by docs-parity alone.
      // `verifySummaryCore` (src/phase.cts) resolves hashes out of a whole
      // SUMMARY with a bare \b[0-9a-f]{7,40}\b, and its own comment records
      // that this is too noisy to put in front of a user — inheriting it would
      // let a short SHA quoted in "Decisions & Deviations" become a phase
      // commit. Here `outside.txt`'s hash is quoted in prose, in backticks, in
      // a later section; `sneaky.txt`'s is inside the right section but
      // unbackticked. Neither may enter the scope.
      const repo = createTempGitProject('gsd-3926-anchors-');
      try {
        commitFile(repo, 'pre.txt', 'chore: before the phase');
        commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
        const phaseA = commitFile(repo, 'phase-a.txt', 'chore: the one real phase commit');
        const sneaky = commitFile(repo, 'sneaky.txt', 'chore: named unbackticked inside the section');
        const outside = commitFile(repo, 'outside.txt', 'chore: named in prose in a later section');

        const rel = `${PHASE_DIR}/06-1-SUMMARY.md`;
        fs.writeFileSync(
          path.join(repo, rel),
          [
            '## Task Commits',
            '',
            `1. **Task 1: work** - \`${phaseA}\` (feat)`,
            `2. **Task 2: work** - ${sneaky} (feat)`,
            '',
            '## Decisions & Deviations',
            '',
            `Reverted the approach from \`${outside}\` after review.`,
            '',
            '## Next Phase Readiness',
            '',
          ].join('\n')
        );
        gitOrThrow(['add', '--', rel], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        gitOrThrow(['commit', '-m', 'docs: phase summary'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });

        const result = runScope(repo, 'REVIEW_FILES=()');
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.deepStrictEqual(
          (parseSentinel(result.stdout, 'REVIEW_FILES') || []).sort(),
          ['phase-a.txt'],
          'only the backticked hash inside `## Task Commits` is a phase commit'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'no SUMMARY at all fails closed with a loud warning and an empty scope — never a message grep',
    SKIP_WIN32,
    () => {
      // Sub-case 3 of the D-02 predicate: the `## Task Commits` membership
      // record does not exist, so the phase commit set is underivable. The
      // ruled behaviour is a loud fail-closed warning, not a fallback.
      const repo = createTempGitProject('gsd-3926-nosummary-');
      try {
        commitFile(repo, 'pre.txt', 'chore: unrelated work before the phase');
        commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
        commitFile(repo, 'phase-a.txt', 'chore: phase work with no SUMMARY recorded');
        const result = runScope(repo, 'REVIEW_FILES=()');
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        // An EMPTY scope prints `===REVIEW_FILES===` immediately followed by
        // `===END===`, which parseSentinel reports as null (its regex requires
        // a newline inside the block) — so null and [] are the same answer
        // here, and both mean the scope stayed empty.
        assert.deepStrictEqual(
          parseSentinel(result.stdout, 'REVIEW_FILES') || [],
          [],
          'an underivable phase scope must stay EMPTY, never fall back to a wider one'
        );
        assert.match(
          result.stdout,
          /Warning: No SUMMARY artifacts readable for '06'/,
          'the no-SUMMARY sub-case must say so loudly (#3926)'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'SUMMARYs whose task commits none resolve report the middle empty-scope state, not the no-SUMMARY one',
    SKIP_WIN32,
    () => {
      // The THIRD empty-scope branch, and the one the other two do not reach:
      // SUMMARY artifacts exist and their `## Task Commits` section parses, but
      // no named commit survives resolution, reachability and the DIFF_BASE
      // filter. Its message must name THAT state — a reader told "no SUMMARY
      // artifacts readable" would go looking for a missing file that is right
      // there. Raised by the #3926 pre-push body audit, which found the branch
      // reported by the code and asserted by nothing.
      const repo = createTempGitProject('gsd-3926-unresolvable-');
      try {
        commitFile(repo, 'pre.txt', 'chore: before the phase');
        commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
        commitFile(repo, 'phase-a.txt', 'chore: phase work, subject carries no phase scope');
        // A well-formed hash that names no commit in this repository.
        commitSummary(repo, ['0123456789abcdef0123456789abcdef01234567']);

        const result = runScope(repo, 'REVIEW_FILES=()');
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.deepStrictEqual(
          parseSentinel(result.stdout, 'REVIEW_FILES') || [],
          [],
          'an unresolvable commit set yields an empty scope'
        );
        assert.match(
          result.stdout,
          /named no commit that resolves, is reachable from HEAD, and postdates the diff base/,
          `must report the unresolvable-commit state; got: ${result.stdout}`
        );
        assert.doesNotMatch(
          result.stdout,
          /No SUMMARY artifacts readable/,
          'must NOT claim the SUMMARYs are missing — they are present and parsed'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'task commits with an empty diff report the condition, not an unearned cause',
    SKIP_WIN32,
    () => {
      // PHASE_COMMIT_SET non-empty with PHASE_DIFF_FILES empty is reachable by
      // an EMPTY COMMIT, which involves no excluded path at all — so a message
      // asserting "every changed path falls under the D-03 exclusions" would be
      // stating a cause the code cannot know. Raised by the #3926 pre-push
      // adversarial review, which drove exactly this fixture.
      const repo = createTempGitProject('gsd-3926-empty-commit-');
      try {
        commitFile(repo, 'pre.txt', 'chore: before the phase');
        commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
        gitOrThrow(['commit', '--allow-empty', '-m', 'chore: an empty phase commit'], {
          cwd: repo,
          timeoutMs: GIT_TIMEOUT_MS,
        });
        const empty = gitOrThrow(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim();
        commitSummary(repo, [empty]);

        const result = runScope(repo, 'REVIEW_FILES=()');
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.deepStrictEqual(
          parseSentinel(result.stdout, 'REVIEW_FILES') || [],
          [],
          'an empty-diff commit set yields an empty scope'
        );
        assert.match(
          result.stdout,
          /yielded no reviewable paths/,
          'the message must describe the condition reached'
        );
        assert.doesNotMatch(
          result.stdout,
          /every changed path falls under the D-03 exclusions\./,
          'and must not assert an exclusion cause it cannot know — this commit changed nothing'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'the skipped-cross-check note says "no paths", never "no commits"',
    SKIP_WIN32,
    () => {
      // The note's predicate is an empty FILE set, not an empty COMMIT set:
      // a recorded EMPTY COMMIT leaves PHASE_COMMIT_SET non-empty while
      // PHASE_DIFF_FILES is empty, so a message claiming "no phase task
      // commits" would be false on exactly the state that selects it. Raised
      // by the #3926 pre-push adversarial review, which named this fixture.
      const repo = createTempGitProject('gsd-3926-xcheck-note-');
      try {
        commitFile(repo, 'pre.txt', 'chore: before the phase');
        commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
        commitFile(repo, 'phase-a.txt', 'chore: real phase work');
        gitOrThrow(['commit', '--allow-empty', '-m', 'chore: an empty phase commit'], {
          cwd: repo,
          timeoutMs: GIT_TIMEOUT_MS,
        });
        const empty = gitOrThrow(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim();
        // Record ONLY the empty commit, so the set is non-empty and its diff is not.
        commitSummary(repo, [empty]);

        // A live SUMMARY key_files scope, so the cross-check branch is reached.
        const result = runScope(repo, 'REVIEW_FILES=(phase-a.txt)');
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.match(
          result.stdout,
          /no phase task-commit paths available for comparison/,
          'the note must describe the empty PATH set that actually selects it'
        );
        assert.doesNotMatch(
          result.stdout,
          /no phase task commits in scope/,
          'and must not claim there are no commits — this fixture records one'
        );
        assert.deepStrictEqual(
          (parseSentinel(result.stdout, 'REVIEW_FILES') || []).sort(),
          ['phase-a.txt'],
          'the SUMMARY scope stands unchanged when the cross-check is skipped'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'the final tier label names the source that actually produced the scope',
    SKIP_WIN32,
    () => {
      // The task-commit record lives IN a SUMMARY, so `SUMMARIES` is non-empty
      // on BOTH Tier-3 branches. A label keyed on that alone reports
      // "SUMMARY.md" for a scope that came from task commits after key_files
      // yielded nothing, and the intended branch is unreachable. Raised by the
      // #3926 pre-push adversarial review, which found the first version of
      // this label had a branch no input could select.
      const repo = buildScopeFixture('gsd-3926-tier-label-');
      try {
        const script = [
          'PADDED_PHASE=06',
          `PHASE_DIR=${PHASE_DIR}`,
          'REVIEW_FILES=()',
          `SUMMARIES=$(ls ${PHASE_DIR}/*-SUMMARY.md 2>/dev/null)`,
          'FILES_OVERRIDE=""',
          extractTier3FullFence(),
          fenceContaining(readFileNormalized(WORKFLOW_PATH), 'TIER="--files override"'),
          'echo "===TIER==="',
          'echo "${TIER}"',
          'echo "===END==="',
        ].join('\n');
        const result = toLegacyResult(
          runHook('-c', [script, 'bash'], {
            interpreter: 'bash',
            cwd: repo,
            timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
          })
        );
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.deepStrictEqual(
          parseSentinel(result.stdout, 'TIER') || [],
          ['phase task commits'],
          'a scope produced by the task-commit derivation must not be labelled SUMMARY.md'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'a mixed #2666 cross-check scope is labelled as mixed, not as SUMMARY.md alone',
    SKIP_WIN32,
    () => {
      // The cross-check starts from SUMMARY key_files and ADDS files only the
      // task commits surfaced, so the final scope is mixed and "SUMMARY.md"
      // understates it. Raised by the #3926 pre-push adversarial review.
      const repo = buildScopeFixture('gsd-3926-mixed-label-');
      try {
        const script = [
          'PADDED_PHASE=06',
          `PHASE_DIR=${PHASE_DIR}`,
          'REVIEW_FILES=(phase-a.txt)',
          `SUMMARIES=$(ls ${PHASE_DIR}/*-SUMMARY.md 2>/dev/null)`,
          'FILES_OVERRIDE=""',
          extractTier3FullFence(),
          fenceContaining(readFileNormalized(WORKFLOW_PATH), 'TIER="--files override"'),
          'echo "===TIER==="',
          'echo "${TIER}"',
          'echo "===END==="',
        ].join('\n');
        const result = toLegacyResult(
          runHook('-c', [script, 'bash'], {
            interpreter: 'bash',
            cwd: repo,
            timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
          })
        );
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.deepStrictEqual(
          parseSentinel(result.stdout, 'TIER') || [],
          ['SUMMARY.md + phase task commits'],
          'the cross-check adds task-commit files, so the label must say so'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'SCOPE_SOURCE is initialized — an inherited value cannot mislabel a plain SUMMARY scope',
    SKIP_WIN32,
    () => {
      // The label reads SCOPE_SOURCE; without an explicit initialization a value
      // inherited from the caller's environment selects the wrong branch.
      //
      // The scenario has to be one where NO branch assigns SCOPE_SOURCE, or the
      // assignment masks the missing initialization and the control is vacuous
      // — which is exactly what the first version of this test did. So: seed
      // REVIEW_FILES with the COMPLETE phase scope, so the #2666 cross-check
      // finds nothing missing and never sets the variable. The label must then
      // fall through to SUMMARY.md rather than report the inherited value.
      const repo = buildScopeFixture('gsd-3926-scope-init-');
      try {
        const script = [
          'SCOPE_SOURCE="inherited garbage"',
          'PADDED_PHASE=06',
          `PHASE_DIR=${PHASE_DIR}`,
          'REVIEW_FILES=(phase-a.txt phase-b.txt)',
          `SUMMARIES=$(ls ${PHASE_DIR}/*-SUMMARY.md 2>/dev/null)`,
          'FILES_OVERRIDE=""',
          extractTier3FullFence(),
          fenceContaining(readFileNormalized(WORKFLOW_PATH), 'TIER="--files override"'),
          'echo "===TIER==="',
          'echo "${TIER}"',
          'echo "===END==="',
        ].join('\n');
        const result = toLegacyResult(
          runHook('-c', [script, 'bash'], {
            interpreter: 'bash',
            cwd: repo,
            timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
          })
        );
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.deepStrictEqual(
          parseSentinel(result.stdout, 'TIER') || [],
          ['SUMMARY.md'],
          'the fence must reset SCOPE_SOURCE rather than trust an inherited value'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  // The spawn_reviewer fence, extracted separately — it derives its own
  // DIFF_BASE/DIFF_TIP and is what the reviewer agent's last-resort fallback
  // consumes. Both #3926 rework findings live here, not in the Tier-3 fence.
  function extractSpawnFence() {
    const src = readFileNormalized(WORKFLOW_PATH);
    return fenceContaining(src, '#3926: also hand the agent an upper bound');
  }

  function runSpawnFence(repo) {
    const script = [
      'PADDED_PHASE=06',
      `PHASE_DIR=${PHASE_DIR}`,
      extractSpawnFence(),
      'echo "===DIFF_BASE==="',
      'echo "${DIFF_BASE}"',
      'echo "===DIFF_TIP==="',
      'echo "${DIFF_TIP}"',
      'echo "===END==="',
    ].join('\n');
    return toLegacyResult(
      runHook('-c', [script, 'bash'], {
        interpreter: 'bash',
        cwd: repo,
        timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      })
    );
  }

  test(
    'no SUMMARY task commits leaves diff_tip empty and diff_base intact — the residual is announced',
    SKIP_WIN32,
    () => {
      // The reviewer agent's fallback bounds at HEAD when diff_tip is absent,
      // so Tier 3's fail-closed scope is NOT carried into the agent tier. That
      // is pre-existing on this path — spawn_reviewer derives DIFF_BASE from
      // the phase directory unconditionally (#3191/#3503/#3995 pin it), and the
      // agent defaults an absent diff_tip to HEAD for backward compatibility
      // with direct invocations — and closing it means changing one of those
      // two contracts, which is a separate concern. What this test pins is that
      // the gap is ANNOUNCED rather than silent, and that neither contract is
      // broken in passing. Raised by the #3926 pre-push adversarial review.
      const repo = createTempGitProject('gsd-3926-spawn-nosummary-');
      try {
        commitFile(repo, 'pre.txt', 'chore: before the phase');
        commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
        commitFile(repo, 'phase-a.txt', 'chore: phase work with no SUMMARY recorded');
        const result = runSpawnFence(repo);
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.deepStrictEqual(
          parseSentinel(result.stdout, 'DIFF_TIP') || [],
          [],
          'no task-commit record means no derivable bound'
        );
        assert.notDeepStrictEqual(
          parseSentinel(result.stdout, 'DIFF_BASE') || [],
          [],
          'DIFF_BASE stays the phase-directory anchor (#3191/#3503/#3995)'
        );
        assert.match(
          result.stdout,
          /no SUMMARY task commits for '06'; the reviewer agent's fallback will bound at HEAD/,
          'the unbounded fallback must be announced, not silent'
        );
      } finally {
        cleanup(repo);
      }
    }
  );

  test(
    'divergent task commits leave diff_tip empty rather than dropping a branch',
    SKIP_WIN32,
    () => {
      // A single A..B range cannot express commits on divergent branches, so
      // picking either tip DROPS the other branch. On a last-resort net,
      // over-scoping is tolerable and under-scoping is not — so the tip is left
      // empty (agent bounds at HEAD) and diff_base is retained. Pre-fix this
      // selected whichever candidate the record happened to list first.
      const repo = createTempGitProject('gsd-3926-spawn-diverge-');
      try {
        commitFile(repo, 'base.txt', 'chore: base');
        commitFile(repo, `${PHASE_DIR}/06-1-PLAN.md`, 'docs: create the phase directory');
        const root = gitOrThrow(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim();
        gitOrThrow(['checkout', '-q', '-b', 'left'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        const left = commitFile(repo, 'left.txt', 'chore: left branch work');
        gitOrThrow(['checkout', '-q', '-b', 'right', root], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        const right = commitFile(repo, 'right.txt', 'chore: right branch work');
        // Merge both so each is reachable from HEAD while neither is an
        // ancestor of the other.
        gitOrThrow(['merge', '--no-ff', '-m', 'chore: join', left], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
        commitSummary(repo, [left, right]);

        const result = runSpawnFence(repo);
        assert.equal(result.status, 0, `fence exited ${result.status}; stderr=${result.stderr}`);
        assert.deepStrictEqual(
          parseSentinel(result.stdout, 'DIFF_TIP') || [],
          [],
          'no single tip covers divergent task commits — the bound must be left to HEAD, never guessed'
        );
        assert.notDeepStrictEqual(
          parseSentinel(result.stdout, 'DIFF_BASE') || [],
          [],
          'DIFF_BASE is retained here — commits exist, only the single-tip bound does not'
        );
        assert.match(result.stdout, /divergent branches/, 'the widened bound must be announced, not silent');
      } finally {
        cleanup(repo);
      }
    }
  );

  // Docs-parity anti-revert: neither Tier-3 consumer may diff to HEAD, both
  // must consume the PHASE_DIFF_FILES union, and spawn_reviewer must hand the
  // agent the diff_tip bound its own fallback consumes.
  test('docs-parity: no ..HEAD tip in Tier-3; spawn_reviewer passes diff_tip; agent fallback is bounded', () => {
    const workflow = readFileNormalized(WORKFLOW_PATH);
    const tier3 = extractTier3FullFence();
    assert.ok(
      !/git diff [^\n]*\.\.HEAD/.test(tier3),
      'Tier-3 fence must not diff to HEAD — the scope is the phase change set (#3926)'
    );
    assert.ok(
      tier3.includes('PHASE_DIFF_FILES=$(for c in $(printf'),
      'Tier-3 fence must derive the change set from the phase commits themselves'
    );
    // The membership record is the SUMMARY `## Task Commits` section, read
    // section-scoped and backtick-anchored. Both anchors are asserted because
    // dropping either silently widens the parse: without the section slice a
    // hash quoted anywhere in the SUMMARY enters the set, and without the
    // backticks a bare hex-shaped token in prose does (the `verifySummaryCore`
    // failure mode, src/phase.cts).
    // The `\r` in the heading class is load-bearing, not incidental: git may
    // check a SUMMARY out with CRLF on Windows, and without it the section
    // never opens, the commit set comes back empty, and the phase silently
    // scopes to nothing (driven: 0 hashes from CRLF, 1 from LF).
    assert.ok(
      /awk '\/\^## Task Commits\[ \\t\\r\]\*\$\/ \{ inside=1; next \} \/\^## \/ \{ inside=0 \} inside'/.test(tier3),
      'the phase commit set must be sliced from the SUMMARY `## Task Commits` section, CRLF-tolerantly (#3926)'
    );
    assert.ok(
      tier3.includes("grep -oE '`[0-9a-f]{7,40}`'"),
      'the hash match must be backtick-anchored, never a bare hex token in prose (#3926)'
    );
    assert.ok(
      !/--grep=/.test(tier3),
      'no phase-scope message-grep derivation may enter Tier-3 — subjects carry no milestone bound (#3995, T6)'
    );
    // #3661: DIFF_BASE prefers LAST_REVIEW_COMMIT, so the set must be filtered
    // to commits after it or a wave-scoped review re-widens to the whole phase.
    assert.ok(
      tier3.includes('git merge-base --is-ancestor "$FULL_SHA" "$DIFF_BASE"'),
      'the phase commit set must be filtered to commits after DIFF_BASE (#3661 narrowing)'
    );
    // Sub-case 3 (no SUMMARY at all) fails closed and loudly — never to a grep.
    assert.ok(
      tier3.includes('Warning: No SUMMARY artifacts readable for'),
      'a phase with no SUMMARY must fail closed with a loud warning, never fall back to a grep (#3926)'
    );
    assert.ok(
      tier3.includes('--first-parent "$c"'),
      'the per-commit show must use --first-parent — a clean phase-scoped merge otherwise contributes an EMPTY combined diff (#3926)'
    );
    assert.ok(
      workflow.includes('${DIFF_TIP:+diff_tip: ${DIFF_TIP}}'),
      'spawn_reviewer must pass diff_tip to the reviewer agent (#3926)'
    );
    const reviewer = readFileNormalized(REVIEWER_PATH);
    assert.ok(
      reviewer.includes('${DIFF_BASE}..${DIFF_TIP:-HEAD}'),
      'reviewer-agent fallback diff must be bounded by diff_tip when provided (#3926)'
    );
    assert.ok(
      !/git diff [^\n]*\$\{DIFF_BASE\}\.\.HEAD/.test(reviewer),
      'reviewer-agent fallback must not hardcode ..HEAD (#3926)'
    );
  });
});
