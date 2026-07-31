/**
 * Slug parity and single-truncation invariants (#2848, #2849).
 *
 * Slug generation used to be inlined at eleven sites, and the copies had
 * already drifted apart (one trimmed a single hyphen instead of a run, one
 * never truncated at all, two truncated a second time against a second limit).
 * This file pins the two invariants that keep them from drifting again:
 *
 *   1. BEHAVIOURAL PARITY — every reachable entry point returns exactly what
 *      `generateSlugInternal(input, itsOwnLimit)` returns. A second truncation
 *      breaks that equality no matter how it is spelled (a neighbouring line,
 *      an intermediate variable, a destructure, a `truncate()` wrapper in
 *      another file), because this asserts on the OUTPUT, not on the text.
 *
 *      Honest limit of that arbiter, stated so a reader does not over-trust it:
 *      a second truncation using the SAME limit as the canonical generator is a
 *      no-op and therefore invisible here. It is still a landmine — someone
 *      changes the limit in one of the two places later — which is why the
 *      structural scan below is kept as a second, independent signal.
 *
 *   2. STRUCTURAL ANTI-REINTRODUCTION — the slug filter character class appears
 *      only in the canonical module and in an explicit allowlist of sites that
 *      use the same class for a different job. Same idea, and the same
 *      "re-export, never re-implement" spirit, as
 *      tests/phase-id-drift-guard.test.cjs.
 *
 *      The scanner IGNORES COMMENTS ON PURPOSE. It reads source text, so a doc
 *      comment that merely mentions the character class must not turn it red;
 *      only executable code counts. Lines whose first non-blank characters are
 *      `//`, `*` or the start of a block comment are dropped.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const coreUtils = require('../gsd-core/bin/lib/core-utils.cjs');
const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
const phaseLocator = require('../gsd-core/bin/lib/phase-locator.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const { generateSlugInternal, DEFAULT_SLUG_MAX_LENGTH } = coreUtils;

/**
 * Neutral corpus. Deliberately mixes scripts, because the whole point of the
 * fix is that a non-Latin title stops producing a nameless directory.
 */
const CORPUS = [
  'Plain ASCII Title',
  'Phase 42 Done',
  'Café Naïve',
  'Расчёт показателей за квартал',
  'Ёжик щёлкает объявления',
  'Її ґудзик',
  'Фаза 42 Done',
  // Long enough to be truncated at both limits, and shaped so the character at
  // index 39 of the 60-limit slug is a hyphen — see TRUNCATION_PROBE below.
  'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll',
];

/** Inputs with no slug-safe content at all: every entry point must refuse them. */
const DEGENERATE = ['!!!', '   ', 'Ελληνικά μαθήματα', '中文'];

// ─── 1. Behavioural parity across entry points ───────────────────────────────

describe('slug parity: every entry point delegates to the canonical generator', () => {
  test('canonical generator is the reference and is reachable', () => {
    assert.strictEqual(typeof generateSlugInternal, 'function');
    assert.strictEqual(DEFAULT_SLUG_MAX_LENGTH, 60);
  });

  test('`gsd generate-slug` (public command) matches the canonical generator', () => {
    const tmp = createTempProject();
    try {
      for (const text of CORPUS) {
        const res = runGsdTools(['generate-slug', text], tmp);
        assert.ok(res.success, `generate-slug failed for ${JSON.stringify(text)}: ${res.error}`);
        assert.strictEqual(
          JSON.parse(res.output).slug,
          generateSlugInternal(text, DEFAULT_SLUG_MAX_LENGTH),
          `generate-slug diverged for ${JSON.stringify(text)}`,
        );
      }
    } finally {
      cleanup(tmp);
    }
  });

  test('`gsd init quick` uses the canonical generator with its own limit of 40', () => {
    const tmp = createTempProject();
    try {
      for (const text of CORPUS) {
        const res = runGsdTools(['init', 'quick', text], tmp);
        assert.ok(res.success, `init quick failed for ${JSON.stringify(text)}: ${res.error}`);
        assert.strictEqual(
          JSON.parse(res.output).slug,
          generateSlugInternal(text, 40),
          `init quick diverged for ${JSON.stringify(text)}`,
        );
      }
    } finally {
      cleanup(tmp);
    }
  });

  test('getPhaseDirFromPhaseId embeds the canonical slug verbatim', () => {
    for (const text of CORPUS) {
      const dir = phaseId.getPhaseDirFromPhaseId('1-01', text, null);
      assert.strictEqual(
        dir,
        `01-01-${generateSlugInternal(text, DEFAULT_SLUG_MAX_LENGTH)}`,
        `getPhaseDirFromPhaseId diverged for ${JSON.stringify(text)}`,
      );
    }
  });

  test('phase_slug reported by the phase locator is the canonical slug', () => {
    const tmp = createTempProject();
    try {
      const name = 'Расчёт показателей';
      const slug = generateSlugInternal(name, DEFAULT_SLUG_MAX_LENGTH);
      fs.mkdirSync(path.join(tmp, '.planning', 'phases', `01-${slug}`), { recursive: true });
      const found = phaseLocator.findPhaseInternal(tmp, '1');
      assert.ok(found && found.found, 'phase directory was not found on read-back');
      assert.strictEqual(found.phase_slug, slug);
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── 2. No entry point degrades silently ─────────────────────────────────────

describe('slug parity: degenerate input fails loudly everywhere', () => {

  test('`gsd generate-slug` exits non-zero instead of printing an empty slug', () => {
    const tmp = createTempProject();
    try {
      for (const text of DEGENERATE) {
        const res = runGsdTools(['generate-slug', text], tmp);
        assert.strictEqual(
          res.success,
          false,
          `generate-slug silently accepted ${JSON.stringify(text)}: ${res.output}`,
        );
      }
    } finally {
      cleanup(tmp);
    }
  });

  test('`gsd init quick` exits non-zero instead of naming a directory after nothing', () => {
    const tmp = createTempProject();
    try {
      for (const text of DEGENERATE) {
        const res = runGsdTools(['init', 'quick', text], tmp);
        assert.strictEqual(
          res.success,
          false,
          `init quick silently accepted ${JSON.stringify(text)}: ${res.output}`,
        );
      }
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── 3. Truncation happens exactly once ──────────────────────────────────────

/**
 * Four-character words separated by single hyphens put a hyphen at index 39 of
 * the resulting slug. So `canonical(text, 60).slice(0, 40)` ends with a hyphen
 * while `canonical(text, 40)` does not: any caller that cuts a 60-limit slug
 * down to 40 by itself, instead of asking for 40 in the first place, is visible
 * in the output.
 */
const TRUNCATION_PROBE = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll';

describe('slug truncation is a single point', () => {
  test('the probe really does distinguish one cut from two', () => {
    const cutOnce = generateSlugInternal(TRUNCATION_PROBE, 40);
    const cutTwice = generateSlugInternal(TRUNCATION_PROBE, 60).slice(0, 40);
    assert.notStrictEqual(
      cutOnce,
      cutTwice,
      'probe is vacuous: cutting once and cutting twice give the same string',
    );
    assert.ok(cutTwice.endsWith('-'), 'probe is vacuous: the double cut leaves no trailing hyphen');
    assert.ok(!cutOnce.endsWith('-'), 'a single cut must not leave a trailing hyphen');
  });

  test('`gsd init quick` cuts once, at 40', () => {
    const tmp = createTempProject();
    try {
      const res = runGsdTools(['init', 'quick', TRUNCATION_PROBE], tmp);
      assert.ok(res.success, `init quick failed: ${res.error}`);
      assert.strictEqual(JSON.parse(res.output).slug, generateSlugInternal(TRUNCATION_PROBE, 40));
    } finally {
      cleanup(tmp);
    }
  });

  test('`gsd generate-slug` cuts once, at 60', () => {
    const tmp = createTempProject();
    try {
      const res = runGsdTools(['generate-slug', TRUNCATION_PROBE], tmp);
      assert.ok(res.success, `generate-slug failed: ${res.error}`);
      assert.strictEqual(JSON.parse(res.output).slug, generateSlugInternal(TRUNCATION_PROBE, 60));
    } finally {
      cleanup(tmp);
    }
  });

  test('truncation never resurrects the trailing hyphen the trim removed', () => {
    // 59 filler characters then a word boundary: the 60th character of the
    // untruncated slug is the hyphen, so a cut that does not re-trim keeps it.
    const slug = generateSlugInternal(`${'a'.repeat(59)} tail`, 60);
    assert.strictEqual(slug, 'a'.repeat(59));
    assert.ok(!slug.endsWith('-'));
  });

  test('truncation cuts code points, never half of a surrogate pair', () => {
    for (const text of CORPUS) {
      for (const limit of [40, 60]) {
        const slug = generateSlugInternal(text, limit);
        if (slug === null) continue;
        assert.ok(
          Array.from(slug).length <= limit,
          `slug longer than its limit for ${JSON.stringify(text)}`,
        );
        for (const ch of slug) {
          const cp = ch.codePointAt(0);
          assert.ok(cp < 0xd800 || cp > 0xdfff, `lone surrogate in slug for ${JSON.stringify(text)}`);
        }
      }
    }
  });
});

// ─── 4. Structural anti-reintroduction scan ──────────────────────────────────

/**
 * Sites that use the same character class for a different job, and are
 * therefore NOT slug generation. Each entry is `<path>` + the exact source line
 * with its indentation stripped. Two categories:
 *
 *   guard — the class is applied as an INPUT CHECK at a trust boundary
 *           (rejecting a path separator, `..`, an empty or all-digit segment),
 *           not to produce a slug. Folding these into the canonical generator
 *           would delete the check, which is a security regression rather than
 *           a refactor.
 *   other — tokenisation for matching, API-coverage scanning, word boundaries
 *           inside a constructed regexp, or normalising an identifier that is
 *           ASCII by construction.
 */
const NON_SLUG_ALLOWLIST = [
  // guard
  ['src/phase-id.cts', "const safeSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');"],
  ['src/workstream-name-policy.cts', ".replace(/[^a-z0-9]+/g, '-')"],
  ['src/active-workstream-store.cts', "const token = raw.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');"],
  // other
  ['src/active-workstream-store.cts', 'if (token) return `${envKey.toLowerCase().replace(/[^a-z0-9]+/g, \'-\')}-${token}`;'],
  ['src/check-command-router.cts', ".replace(/[^a-z0-9\\s]/g, ' ')"],
  ['src/api-coverage.cts', "const segments = tok.split(/[\\\\/]/).map((s) => s.replace(/[^A-Za-z0-9]/g, ''));"],
  ['src/api-coverage.cts', "'(^|[^a-zA-Z0-9])(' + effective.verbs.map(escapeRegex).join('|') + ')(?=[^a-zA-Z0-9]|$)',"],
  ['src/api-coverage.cts', "'(^|[^a-zA-Z0-9])(' + effective.nouns.map(escapeRegex).join('|') + ')(?=[^a-zA-Z0-9]|$)',"],
  ['src/api-coverage.cts', "const segs = content.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);"],
  ['src/ui-safety-gate.cts', "'(^|[^a-zA-Z0-9])(' + UI_TOKENS.join('|') + ')([^a-zA-Z0-9]|$)',"],
  ['src/commands.cts', ".map(w => w.replace(/[^a-z0-9]/g, ''))"],
  ['src/runtime-artifact-conversion.cts', 'new RegExp(`(^|[^A-Za-z0-9_./-])${escapedPath}`, \'g\'),'],
  ['src/runtime-artifact-conversion.cts', "text = text.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');"],
  ['src/runtime-artifact-conversion.cts', 'const colonPattern = new RegExp(`(?<![A-Za-z0-9_/:.-])/?gsd:(${commandGroup})(?=[^A-Za-z0-9_-]|$)`, \'g\');'],
  ['src/runtime-artifact-conversion.cts', 'const hyphenPattern = new RegExp(`(?:/|\\\\$)gsd-(${commandGroup})(?=[^A-Za-z0-9_-]|$)`, \'g\');'],
  ['src/assumption-delta.cts', "const pattern = new RegExp('(^|[^a-zA-Z0-9])(' + escaped + ')([^a-zA-Z0-9]|$)', 'gi');"],
];

const CANONICAL_MODULE = 'src/core-utils.cts';
const FILTER_CLASS = /\[\^a-z/i;
const SRC_DIR = path.join(__dirname, '..', 'src');

/** Executable lines only: comments mention the class legitimately. */
function codeLines(source) {
  const out = [];
  let inBlockComment = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

describe('slug generation is not re-implemented anywhere', () => {
  test('the canonical module still owns the filter character class', () => {
    const canon = fs.readFileSync(path.join(SRC_DIR, 'core-utils.cts'), 'utf-8');
    assert.ok(
      codeLines(canon).some((l) => FILTER_CLASS.test(l)),
      'the canonical module no longer contains the filter class — this scan would be vacuous',
    );
  });

  test('no source file outside the canon and the allowlist generates a slug', () => {
    const allowed = new Set(NON_SLUG_ALLOWLIST.map(([file, line]) => `${file} ${line}`));
    const offenders = [];
    let scanned = 0;

    for (const entry of fs.readdirSync(SRC_DIR)) {
      if (!entry.endsWith('.cts')) continue;
      const rel = `src/${entry}`;
      if (rel === CANONICAL_MODULE) continue;
      const lines = codeLines(fs.readFileSync(path.join(SRC_DIR, entry), 'utf-8'));
      scanned += lines.length;
      for (const line of lines) {
        if (!FILTER_CLASS.test(line)) continue;
        if (allowed.has(`${rel} ${line}`)) continue;
        offenders.push(`${rel}: ${line}`);
      }
    }

    assert.ok(scanned > 0, 'no source lines were scanned — this scan would be vacuous');
    assert.deepStrictEqual(
      offenders,
      [],
      'slug generation was re-implemented outside src/core-utils.cts; call generateSlugInternal instead',
    );
  });

  test('every allowlist entry still exists, so the allowlist cannot rot', () => {
    const missing = [];
    for (const [file, line] of NON_SLUG_ALLOWLIST) {
      const abs = path.join(__dirname, '..', file);
      const lines = codeLines(fs.readFileSync(abs, 'utf-8'));
      if (!lines.includes(line)) missing.push(`${file}: ${line}`);
    }
    assert.deepStrictEqual(missing, [], 'allowlist entries no longer present in the source');
  });
});
