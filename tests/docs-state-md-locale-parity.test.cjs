'use strict';

// Regression tests for issue #3873 (ADR-3473 §8.8, Phase 3 design/test-matrix
// row 12 — `localeMissingASchemaDeclaredSectionFails`).
//
// `docs/reference/state-md.md` is the English STATE.md schema reference; its
// four locale siblings (`docs/{ja-JP,zh-CN,ko-KR,pt-BR}/reference/state-md.md`)
// are hand-translated copies that are supposed to mirror its section
// structure. As of this branch they do not: every translation is missing
// `### Status lifecycle (ADR-2207)`, the section documenting the `status`
// frontmatter enum — the same enum whose clobbering is issue #3853. A reader
// of any translated reference page is silently missing the one section that
// explains #3853's failure mode.
//
// This test derives the heading list from the English reference (never
// hard-codes "Status lifecycle" as the expected gap) so it keeps working
// once the schema declares further sections. Because heading TEXT is
// translated per locale, headings are matched by their ordered sequence of
// levels (via an LCS alignment) rather than by literal string — the missing
// section is whichever English heading has no positional counterpart in a
// locale's heading-level sequence.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fsMod = require('node:fs');

const ROOT = path.join(__dirname, '..');
const EN_REFERENCE_PATH = path.join(ROOT, 'docs/reference/state-md.md');
const LOCALES = ['ja-JP', 'zh-CN', 'ko-KR', 'pt-BR'];

/**
 * Extract ATX headings (`#`.."######") from a markdown file, skipping any
 * line inside a fenced code block (``` ... ```) so a YAML comment like
 * `# Phase-lifecycle fields` inside an example frontmatter block is never
 * mistaken for a real section heading.
 */
function extractHeadings(filePath) {
  const text = fsMod.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  let inFence = false;
  const headings = [];
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) headings.push({ level: m[1], text: m[2].trim() });
  }
  return headings;
}

/**
 * Longest-common-subsequence alignment over two arrays, returning the set of
 * indices in `a` that participate in the alignment with `b`. Used here over
 * heading LEVEL sequences (not translated text) so a locale's heading list —
 * whose section TITLES are translated but whose STRUCTURE should mirror the
 * English source 1:1 — can be compared without needing to literal-match
 * prose in a language this test does not read.
 */
function lcsMatchedIndices(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j] && dp[i][j] === dp[i + 1][j + 1] + 1) {
      matched.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matched;
}

test('localeMissingASchemaDeclaredSectionFails', () => {
  const enHeadings = extractHeadings(EN_REFERENCE_PATH);
  const enLevels = enHeadings.map((h) => h.level);

  // Sanity: the English reference actually declares the section this
  // regression is about, and it is not vacuously empty (CLAUDE.md's Test
  // Cleanup rule — a passing loop over zero headings proves nothing).
  assert.ok(enHeadings.length > 0, 'expected the English reference to declare at least one heading');
  assert.ok(
    enHeadings.some((h) => h.text === 'Status lifecycle (ADR-2207)'),
    'expected the English reference to declare "### Status lifecycle (ADR-2207)" — the section ' +
      'behind #3853 this regression is anchored on',
  );

  const failures = [];
  for (const locale of LOCALES) {
    const localePath = path.join(ROOT, 'docs', locale, 'reference/state-md.md');
    const localeHeadings = extractHeadings(localePath);
    const localeLevels = localeHeadings.map((h) => h.level);
    const matched = lcsMatchedIndices(enLevels, localeLevels);
    for (let idx = 0; idx < enHeadings.length; idx++) {
      if (!matched.has(idx)) {
        failures.push(`${locale}/reference/state-md.md is missing the section "${enHeadings[idx].level} ${enHeadings[idx].text}"`);
      }
    }
  }

  assert.deepStrictEqual(
    failures,
    [],
    `locale(s) missing a schema-declared section from docs/reference/state-md.md:\n${failures.join('\n')}`,
  );
});
