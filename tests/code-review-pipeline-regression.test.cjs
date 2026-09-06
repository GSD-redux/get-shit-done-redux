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
// #4259: the T6 docs-parity site scan, hoisted out of the assertion so it can
// be driven directly by the negative controls below.
//
// The scan is `$`-anchored with `[^\n]*` on both sides of `--grep=`, so it only
// ever matched when `git log` and `--grep=` sat on the SAME physical line. A
// shell line-continuation made a semantically identical derivation invisible:
// zero hits, and T6 passed. Both generations of the assertion were defeated by
// it — the current anti-revert ban let a wrapped site through outright, and at
// v1.12.0 a wrapped site was silently exempted from the pattern-conformance
// checks written to catch the macOS `\b`-no-op class, so it could have carried
// exactly the malformed pattern T6 exists to reject. That is not a hypothetical
// shape: wrapping is the natural way to write a `git log` carrying a long ERE,
// and a real candidate implementation for #3926 did it, passed T6, and was
// caught only by later manual review.
//
// Folding continuations BEFORE matching is the repair, rather than widening the
// regex in place: the assertion's message and its `PHASE_SCOPE_NUM` filter both
// assume one site is one string, and a `[\s\S]*?` would happily run the scan
// across unrelated statements. The fold corrects the input, so everything built
// on the scan is fixed at once.
//
// `[ \t]*` rather than `\s*` after the newline: this is exactly the shell's
// own rule (backslash-newline is removed, the continued line's indentation
// collapses into the separator), and it cannot swallow a blank line and glue
// two unrelated statements together.
const foldShellContinuations = (src) => src.replace(/\\\n[ \t]*/g, ' ');

// Built per call rather than shared at module scope: a `/g` regex carries
// lastIndex, and one shared across call sites is a state bug waiting for the
// second caller.
const grepSiteRe = () => /^\s*[A-Z_]+=\$\(git log[^\n]*--grep=[^\n]*$/gm;

const findGrepSites = (src) => Array.from(
  foldShellContinuations(src).matchAll(grepSiteRe()),
  (m) => m[0],
);

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
  // #4259: the T6 scan drives itself off the live workflow files, which are
  // clean — so its matching branch is exercised only by whatever those files
  // happen to contain, and the hole it had was invisible for exactly that
  // reason. These fixtures drive findGrepSites directly, in both directions.
  test('#4259 T6 site scan sees a backslash-continued derivation, and still ignores what it should', () => {
    const sameLine = [
      '```bash',
      'PHASE_START=$(git log --extended-regexp --grep="^(feat|fix)\\(phase-${PHASE_SCOPE_NUM}" --format="%H")',
      '```',
    ].join('\n');

    // Semantically identical to the row above. The only difference is two
    // backslashes and two newlines, and that used to be enough to vanish.
    const continued = [
      '```bash',
      'PHASE_START=$(git log \\',
      '  --extended-regexp \\',
      '  --grep="^(feat|fix)\\(phase-${PHASE_SCOPE_NUM}" --format="%H")',
      '```',
    ].join('\n');

    assert.equal(findGrepSites(sameLine).length, 1, 'the same-line form must stay caught');
    assert.equal(findGrepSites(continued).length, 1, 'the continued form must now be caught (#4259)');

    // The filter T6 actually asserts on has to see the marker too. Before the
    // fold this failed twice over: the scan returned nothing, AND
    // PHASE_SCOPE_NUM sat on a different physical line from the one the scan
    // would have captured, so even a matching scan would have filtered it out.
    for (const src of [sameLine, continued]) {
      assert.equal(
        findGrepSites(src).filter((l) => l.includes('PHASE_SCOPE_NUM')).length,
        1,
        'the captured site must carry the marker T6 filters on',
      );
    }

    // Negative controls — the fold must not manufacture hits.
    const benign = 'RELEASE_NOTES=$(git log --grep="^chore" --format="%s")';
    assert.equal(
      findGrepSites(benign).filter((l) => l.includes('PHASE_SCOPE_NUM') || /phase-\)?\(/.test(l)).length,
      0,
      'a non-phase-scope --grep must stay clean',
    );

    // A wrapped assignment that merely sits near a --grep string must not be
    // glued into one logical line with it. This is what a naive [\s\S]*?
    // widening of the regex would have got wrong.
    const unrelated = [
      'SOME_VAR=$(printf %s \\',
      '  "not a git log")',
      '',
      'echo "--grep=$SOME_VAR"',
    ].join('\n');
    assert.deepStrictEqual(findGrepSites(unrelated), [], 'a wrapped unrelated assignment must not glue into a hit');

    // A continuation must not reach across a blank line — the reason this
    // folds [ \t]* rather than \s* after the newline.
    const acrossBlank = [
      'SOME_VAR=$(git log \\',
      '',
      'FOO=--grep=x',
    ].join('\n');
    assert.deepStrictEqual(findGrepSites(acrossBlank), [], 'the fold must stop at a blank line');
  });

  test('#4259 T6 site scan reports nothing on the live workflow files', () => {
    // The adoption check: the fold must introduce no false positive on the
    // current tree, or landing it would mean editing a workflow file to
    // appease a test. Distinct from T6 itself, which asserts the narrower
    // "no PHASE_SCOPE_NUM site" — this asserts the scan is quiet outright.
    for (const src of [
      readFileNormalized(WORKFLOW_PATH),
      readFileNormalized(PRE_PASS_STEP_PATH).replace(/\\"/g, '"'),
    ]) {
      assert.deepStrictEqual(findGrepSites(src), []);
    }
  });

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
      // #4259: findGrepSites folds backslash continuations first, so a wrapped
      // assignment presents as one logical line and cannot slip the scan.
      grepSites.push(...findGrepSites(src));
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
