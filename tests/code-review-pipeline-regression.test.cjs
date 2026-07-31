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
const { spawnSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md');
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
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
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
    return spawnSync('bash', ['-c', script, 'bash', ...files], {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
    });
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
