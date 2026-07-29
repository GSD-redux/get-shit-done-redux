'use strict';

// allow-test-rule: structural-regression-guard (#2694)
// The code-review/code-review-fix workflows embed inline `node -e` frontmatter
// one-liners whose boundary regex must normalize CRLF before matching (#2694).
// A behavioral test cannot observe which regex the *shipped workflow text* ships
// (the runtime loads the .md verbatim), so we guard the source text directly:
// every `content.match(/^---\n…/)` site in those two files must be preceded by a
// `\r\n` -> `\n` normalize. This catches a revert of the #2694 fix.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Replicates the inline node -e parser from gsd-core/workflows/code-review.md
// step compute_file_scope, Tier 2 (lines ~172-181).
//
// Bug #2134: the section-reset regex uses \s+ (requires leading whitespace), so
// top-level YAML keys at column 0 (e.g. `decisions:`) never reset inSection.
// Items from subsequent top-level lists are therefore mis-classified as
// key_files.modified entries.

/**
 * Extracts files from SUMMARY.md YAML frontmatter using the CURRENT (buggy) logic
 * copied verbatim from code-review.md.
 */
function parseFilesWithBuggyLogic(frontmatterYaml) {
  const files = [];
  let inSection = null;
  for (const line of frontmatterYaml.split('\n')) {
    if (/^\s+created:/.test(line)) { inSection = 'created'; continue; }
    if (/^\s+modified:/.test(line)) { inSection = 'modified'; continue; }
    // BUG: \s+ requires leading whitespace — top-level keys like `decisions:` don't match
    if (/^\s+\w+:/.test(line) && !/^\s+-/.test(line)) { inSection = null; continue; }
    if (inSection && /^\s+-\s+(.+)/.test(line)) {
      files.push(line.match(/^\s+-\s+(.+)/)[1].trim());
    }
  }
  return files;
}

/**
 * Extracts files using the FIXED logic (\s* instead of \s+).
 */
function parseFilesWithFixedLogic(frontmatterYaml) {
  const files = [];
  let inSection = null;
  for (const line of frontmatterYaml.split('\n')) {
    if (/^\s+created:/.test(line)) { inSection = 'created'; continue; }
    if (/^\s+modified:/.test(line)) { inSection = 'modified'; continue; }
    // FIX: \s* allows zero leading whitespace — handles top-level YAML keys
    if (/^\s*\w+:/.test(line) && !/^\s*-/.test(line)) { inSection = null; continue; }
    if (inSection && /^\s+-\s+(.+)/.test(line)) {
      files.push(line.match(/^\s+-\s+(.+)/)[1].trim());
    }
  }
  return files;
}

// SUMMARY.md YAML frontmatter that mirrors a realistic post-execution artifact.
// key_files.modified has ONE real file; decisions has TWO entries that must NOT
// appear in the extracted file list.
const FRONTMATTER = [
  'type: summary',
  'phase: "02"',
  'key_files:',
  '  modified:',
  '    - src/real-file.js',
  '  created:',
  '    - src/new-file.js',
  'decisions:',
  '  - Used async/await over callbacks',
  '  - Kept error handling inline',
  'metrics:',
  '  lines_changed: 42',
  'tags:',
  '  - refactor',
  '  - async',
].join('\n');

describe('code-review SUMMARY.md YAML parser', () => {
  it('RED: buggy parser mis-classifies decisions entries as files (demonstrates the bug)', () => {
    const files = parseFilesWithBuggyLogic(FRONTMATTER);

    // With the bug, `decisions:` at column 0 never resets inSection, so the
    // two decision strings are incorrectly captured as modified files.
    // This assertion documents the broken behavior we are fixing.
    const hasDecisionContamination = files.some(
      (f) => f === 'Used async/await over callbacks' || f === 'Kept error handling inline'
    );
    assert.ok(
      hasDecisionContamination,
      'Expected buggy parser to include decision entries in file list, but it did not — ' +
        'the bug may already be fixed or the test replication is wrong. Got: ' +
        JSON.stringify(files)
    );
  });

  it('GREEN: fixed parser returns only the actual file paths', () => {
    const files = parseFilesWithFixedLogic(FRONTMATTER);

    assert.deepStrictEqual(
      files.sort(),
      ['src/new-file.js', 'src/real-file.js'],
      'Fixed parser should return only the two real file paths, not decision strings'
    );
  });

  it('fixed parser: modified-only frontmatter with top-level sibling keys', () => {
    const yaml = [
      'key_files:',
      '  modified:',
      '    - src/a.ts',
      '    - src/b.ts',
      'decisions:',
      '  - Some decision',
      'metrics:',
      '  count: 2',
    ].join('\n');

    const files = parseFilesWithFixedLogic(yaml);
    assert.deepStrictEqual(files.sort(), ['src/a.ts', 'src/b.ts']);
  });

  it('fixed parser: created-only frontmatter with top-level sibling keys', () => {
    const yaml = [
      'key_files:',
      '  created:',
      '    - src/brand-new.ts',
      'tags:',
      '  - feature',
    ].join('\n');

    const files = parseFilesWithFixedLogic(yaml);
    assert.deepStrictEqual(files, ['src/brand-new.ts']);
  });

  it('fixed parser: no key_files section returns empty array', () => {
    const yaml = [
      'type: summary',
      'decisions:',
      '  - A decision',
    ].join('\n');

    const files = parseFilesWithFixedLogic(yaml);
    assert.deepStrictEqual(files, []);
  });
});

// ---------------------------------------------------------------------------
// #2694: the OUTER frontmatter-boundary extraction (the `node -e` one-liner's
// first step) was never covered by this file — only the inner YAML-line loop
// above was. The shipped boundary regex used a literal `\n` and silently
// returned null on CRLF-saved artifacts, dropping every file in that summary.
// These tests replicate the exact shipped boundary step (the FIXED variant:
// normalize `\r\n` -> `\n` before matching) and lock CRLF == LF at the boundary.
// ---------------------------------------------------------------------------

/**
 * The frontmatter boundary regex as it ships in the workflow one-liners
 * (`/^---\n([\s\S]*?)\n---/`). Built via `new RegExp` rather than a RegExpLiteral
 * so the `local/no-crlf-fragile-split` lint (which flags frontmatter-shape
 * RegExpLiterals) does not fire on this faithful replica — the whole point of
 * `extractFrontmatterBoundaryBuggy` below is to demonstrate that THIS EXACT
 * literal-`\n` regex fails on CRLF input. The fixed path normalizes CRLF first.
 */
const FRONTMATTER_BOUNDARY_RE = new RegExp('^---\\n([\\s\\S]*?)\\n---');

/**
 * Replicates the FIXED boundary extraction shipped in
 * gsd-core/workflows/code-review.md (compute_file_scope) and code-review-fix.md:
 * normalize CRLF to LF, then locate the YAML block between the first two `---`.
 * Returns the captured YAML body, or null if no frontmatter block is present.
 */
function extractFrontmatterBoundary(content) {
  const match = content.replace(/\r\n/g, '\n').match(FRONTMATTER_BOUNDARY_RE);
  return match ? match[1] : null;
}

/**
 * Replicates the BUGGY boundary extraction (literal `\n`, pre-#2694) to prove RED.
 */
function extractFrontmatterBoundaryBuggy(content) {
  const match = content.match(FRONTMATTER_BOUNDARY_RE);
  return match ? match[1] : null;
}

// A realistic SUMMARY.md frontmatter + body. Built with array.join('\n') so the
// fixture's indentation is exact (CONTRIBUTING.md "Fixture Data Formatting").
const SUMMARY_LINES = [
  '---',
  'type: summary',
  'phase: "02"',
  'key_files:',
  '  modified:',
  '    - src/real-file.js',
  '  created:',
  '    - src/new-file.js',
  'decisions:',
  '  - Used async/await over callbacks',
  '---',
  '',
  '## Summary',
  '',
  'Body prose that must NOT be parsed as frontmatter.',
];

// REVIEW.md frontmatter exercises the `status:` field consumed at the other 8
// boundary sites (code-review.md:552/625, code-review-fix.md:*).
const REVIEW_LINES = [
  '---',
  'status: needs-changes',
  'phase: "02"',
  'critical: 1',
  'warning: 2',
  'info: 0',
  'total: 3',
  'files_reviewed_list: [src/real-file.js, src/new-file.js]',
  '---',
  '',
  '## Review',
];

describe('code-review frontmatter boundary extraction (#2694 CRLF)', () => {
  it('RED: buggy literal-\\n boundary returns null on a CRLF SUMMARY.md', () => {
    const crlf = SUMMARY_LINES.join('\r\n') + '\r\n';
    const yaml = extractFrontmatterBoundaryBuggy(crlf);
    assert.strictEqual(
      yaml,
      null,
      'Expected the pre-fix literal-\\n boundary to fail on CRLF input — ' +
        'if it matches, the bug reproduction is wrong. Got: ' + JSON.stringify(yaml)
    );
  });

  it('GREEN: fixed boundary extracts a CRLF SUMMARY.md identically to the LF equivalent', () => {
    const lf = SUMMARY_LINES.join('\n') + '\n';
    const crlf = SUMMARY_LINES.join('\r\n') + '\r\n';

    const lfYaml = extractFrontmatterBoundary(lf);
    const crlfYaml = extractFrontmatterBoundary(crlf);

    assert.ok(lfYaml !== null, 'LF fixture must parse (reference)');
    assert.ok(crlfYaml !== null, 'CRLF fixture must parse after the fix');
    // The load-bearing assertion: CRLF yields the byte-identical YAML body as LF,
    // so every downstream inner-parser / shell grep sees the same text.
    assert.strictEqual(crlfYaml, lfYaml);

    // And the inner parse yields the same file set from both (acceptance criterion 1).
    assert.deepStrictEqual(
      parseFilesWithFixedLogic(crlfYaml).sort(),
      parseFilesWithFixedLogic(lfYaml).sort()
    );
  });

  it('GREEN: fixed boundary extracts a CRLF REVIEW.md status field identically to LF', () => {
    const lf = REVIEW_LINES.join('\n') + '\n';
    const crlf = REVIEW_LINES.join('\r\n') + '\r\n';

    const lfYaml = extractFrontmatterBoundary(lf);
    const crlfYaml = extractFrontmatterBoundary(crlf);

    assert.ok(crlfYaml !== null, 'CRLF REVIEW.md frontmatter must parse');
    assert.strictEqual(crlfYaml, lfYaml);
    // The `status:` field consumed at code-review.md:552 / code-review-fix.md:121.
    const crlfStatus = crlfYaml.match(/status:\s*(\S+)/);
    assert.ok(crlfStatus, 'status field must be reachable through the CRLF boundary');
    assert.strictEqual(crlfStatus[1], 'needs-changes');
  });

  it('no frontmatter block: fixed boundary returns null (no false extraction from body)', () => {
    const noFm = ['## Summary', '', 'No frontmatter here.', '', '---', '', 'a horizontal rule'].join('\n') + '\n';
    assert.strictEqual(extractFrontmatterBoundary(noFm), null);
    // CRLF variant behaves the same.
    const noFmCrlf = noFm.replace(/\n/g, '\r\n');
    assert.strictEqual(extractFrontmatterBoundary(noFmCrlf), null);
  });

  it('lone CR (not part of CRLF) does not defeat the boundary', () => {
    // A lone \r inside the body (old Mac line ending remnant) is left untouched by
    // the \r\n -> \n normalize; it must not prevent the real \r\n-delimited boundary
    // from matching.
    const content = SUMMARY_LINES.join('\r\n') + '\r\n' + 'body with a lone\rcarriage\r\n';
    const yaml = extractFrontmatterBoundary(content);
    assert.ok(yaml !== null, 'lone CR in the body must not break the boundary match');
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2 (#2694): a phase with a MIX of one CRLF SUMMARY.md and
// one LF SUMMARY.md must yield the UNION of both artifacts' files — the CRLF
// artifact's contribution must not be silently dropped. This replicates the
// full shipped Tier-2 extractor (boundary + inner key_files parse) and runs it
// across a mixed-ending phase, locking the silent-partial-masking behavior the
// issue's triage named as the more serious half of the defect.
// ---------------------------------------------------------------------------

/**
 * Replicates the FULL shipped Tier-2 file-scope extractor from
 * gsd-core/workflows/code-review.md (compute_file_scope): normalize -> boundary
 * -> inner key_files.created/modified parse. Returns the extracted file list
 * for one SUMMARY.md document, exactly as the shipped `node -e` one-liner does.
 */
function extractTier2Files(summaryContent) {
  const yaml = extractFrontmatterBoundary(summaryContent);
  if (yaml === null) return [];
  return parseFilesWithFixedLogic(yaml);
}

describe('code-review mixed CRLF/LF phase scope (#2694 criterion 2)', () => {
  it('a phase with one CRLF SUMMARY.md and one LF SUMMARY.md yields the union of both', () => {
    // Two plans in the same phase. Plan A is saved LF, plan B is saved CRLF
    // (Windows checkout / CRLF-saving editor). Each contributes distinct files.
    const planA_LF = [
      '---',
      'type: summary',
      'key_files:',
      '  modified:',
      '    - src/alpha.ts',
      '---',
      '',
      'Plan A body.',
    ].join('\n') + '\n';

    const planB_CRLF = [
      '---',
      'type: summary',
      'key_files:',
      '  created:',
      '    - src/beta.ts',
      '    - lib/gamma.js',
      '---',
      '',
      'Plan B body.',
    ].join('\r\n') + '\r\n';

    // The shipped loop iterates each summary and accumulates into REVIEW_FILES.
    const reviewFiles = [];
    for (const doc of [planA_LF, planB_CRLF]) {
      for (const f of extractTier2Files(doc)) reviewFiles.push(f);
    }

    // The union — NOT just plan A's files. Pre-fix, planB_CRLF contributed
    // nothing (boundary returned null), so reviewFiles would have been only
    // ['src/alpha.ts'] with no warning (the aggregate was non-zero, so the
    // Tier-3 eq-zero fallback at code-review.md:217 never fired).
    assert.deepStrictEqual(
      reviewFiles.sort(),
      ['lib/gamma.js', 'src/alpha.ts', 'src/beta.ts'],
      'A mixed CRLF/LF phase must review the union of both artifacts. ' +
        'If planB_CRLF dropped out, the fix regressed: ' + JSON.stringify(reviewFiles)
    );
  });

  it('RED proof: with the buggy boundary, the CRLF artifact contributes nothing (silent partial)', () => {
    // Same scenario, but using the BUGGY boundary replica to demonstrate the
    // exact silent-partial masking the issue reported: the CRLF plan yields [],
    // so the phase scope is just the LF plan's files, with zero warning.
    const planA_LF = ['---', 'key_files:', '  modified:', '    - src/alpha.ts', '---', ''].join('\n') + '\n';
    const planB_CRLF = ['---', 'key_files:', '  created:', '    - src/beta.ts', '---', ''].join('\r\n') + '\r\n';

    const buggyFiles = [];
    for (const doc of [planA_LF, planB_CRLF]) {
      const yaml = extractFrontmatterBoundaryBuggy(doc);
      if (yaml === null) continue; // buggy boundary returns null on CRLF -> skip
      for (const f of parseFilesWithFixedLogic(yaml)) buggyFiles.push(f);
    }

    // The bug: only the LF plan's file survives; the CRLF plan's file is gone,
    // and because the aggregate is non-zero (1), no fallback warning fired.
    assert.deepStrictEqual(buggyFiles.sort(), ['src/alpha.ts']);
    assert.ok(
      !buggyFiles.includes('src/beta.ts'),
      'The buggy boundary must have dropped the CRLF artifact file (RED demonstration).'
    );
  });
});

describe('shipped workflow frontmatter boundary is CRLF-safe (#2694 structural guard)', () => {
  // The two shipped workflow files whose inline `node -e` one-liners extract
  // frontmatter. Resolved relative to the repo root (the test runner's CWD is the
  // repo root under gsd-test).
  const WORKFLOW_FILES = [
    path.join('gsd-core', 'workflows', 'code-review.md'),
    path.join('gsd-core', 'workflows', 'code-review-fix.md'),
  ];

  for (const rel of WORKFLOW_FILES) {
    it(`${rel}: every frontmatter-boundary site normalizes CRLF before matching`, () => {
      const src = fs.readFileSync(rel, 'utf-8');

      // Locate every shipped boundary-match site. The shipped line shape is:
      //   const match = content...match(/^---\n([\s\S]*?)\n---/);
      // After #2694 the `content...` part must be `content.replace(/\r\n/g, '\n')`.
      // Assert no site uses a raw `content.match(...)` against the boundary regex,
      // and that the CRLF normalize is present at each site.
      const lines = src.split(/\r?\n/);
      const boundarySites = [];
      const unsafeSites = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!/\/\^---\\n\(\[\\s\\S\]\*\?\)\\n---\/\)/.test(line)) continue;
        boundarySites.push(i + 1);
        // SAFE: the match is taken on the result of content.replace(/\r\n/g, '\n').
        // UNSAFE: a direct content.match(/<boundary>/) with no preceding normalize.
        const isNormalized = /content\.replace\(\s*\/\\r\\n\/g\s*,\s*'\\n'\s*\)\.match\(/.test(line);
        const isRawContentMatch = /(^|[^.])\bcontent\.match\(\s*\/\^---\\n/.test(line);
        if (!isNormalized || isRawContentMatch) {
          unsafeSites.push({ line: i + 1, text: line.trim() });
        }
      }

      assert.ok(
        boundarySites.length >= 3,
        `${rel}: expected several frontmatter-boundary sites; found ${boundarySites.length}. ` +
          'If the workflow no longer uses this regex, update this guard.'
      );
      assert.deepStrictEqual(
        unsafeSites,
        [],
        `${rel}: ${unsafeSites.length} frontmatter-boundary site(s) lack the CRLF normalize ` +
          '(regression of #2694): ' + JSON.stringify(unsafeSites, null, 2)
      );
    });
  }
});
