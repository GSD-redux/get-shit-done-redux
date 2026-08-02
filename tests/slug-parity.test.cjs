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
const gsd2Import = require('../gsd-core/bin/lib/gsd2-import.cjs');
const fc = require('fast-check');
const { execFileSync } = require('node:child_process');
const { runGsdTools, createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');

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

// This file reads src/*.cts as raw text on purpose: a dead re-implementation
// of the slug filter is invisible to a behavioral test (nothing ever calls
// it), so the only way to catch it is to read the source itself.
//
// allow-test-rule: structural anti-reintroduction scan for the slug filter, see #2986
//
// Honest scope of that scan, stated so nobody over-trusts it: it catches a
// literal copy-paste of the character class and a reordering of its internal
// parts (`[^0-9a-z]` vs. `[^a-z0-9]`). It does NOT catch a rewrite using a
// positive class (`[a-z0-9]` inverted via `.replace` logic instead of `[^…]`),
// a class assembled from string parts at runtime, or a transliteration table
// rewritten without any character class at all. Those cases are the
// behavioral net's job — the property-parity section above (#2986) — not
// this one's.

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
// Order-insensitive on purpose: the maintainer flagged that a copy which
// permutes the class's internal ordering (`[^0-9a-z]` instead of `[^a-z0-9]`)
// slipped past a literal `/\[\^a-z/` match. Matching on EITHER part being
// present inside a negated class — regardless of what precedes it — closes
// that gap without widening the allowlist (see the "18 vs 17" measurement
// in the plan check for this task).
const FILTER_CLASS = /\[\^[^\]]*(?:a-z|0-9)/i;
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

// ─── 4b. Guard against the specific #2908-review anti-pattern reappearing ────

/**
 * Section 4's scan looks for the slug FILTER CLASS re-implemented anywhere.
 * This scan is narrower and looks for a different, specific shape: a call to
 * the real `generateSlugInternal` immediately followed by `??` — the exact
 * construction that let an empty string slip past the guard at all six sites
 * fixed above. Matching against the WHOLE file text (not line-by-line) is the
 * point: the original bug was invisible to line-anchored `grep` because the
 * call and the `??` operator sat on different lines.
 */
const NULLISH_SLUG_GUARD_PATTERN = /generateSlugInternal\((?:[^()]|\([^()]*\))*\)\s*\?\?/g;

function scanTextForNullishSlugGuard(label, text) {
  const offenders = [];
  let m;
  while ((m = NULLISH_SLUG_GUARD_PATTERN.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    offenders.push(`${label}:${line}`);
  }
  return offenders;
}

/** Files that legitimately call generateSlugInternal (canon excluded — it defines it). */
const SLUG_GENERATOR_CALLER_FILES = [
  'commands.cts', 'gsd2-import.cts', 'init.cts', 'phase-id.cts',
  'phase-locator.cts', 'phase.cts', 'template.cts', 'workstream.cts',
];

describe('slug generation does not reintroduce the #2908 nullish-coalescing gap', () => {
  test('the generator still has a name and at least one caller — otherwise the scan below is a vacuous zero', () => {
    const canon = fs.readFileSync(path.join(SRC_DIR, 'core-utils.cts'), 'utf-8');
    assert.ok(
      /function generateSlugInternal\b|generateSlugInternal\s*[:=]/.test(canon),
      'generateSlugInternal is no longer defined in the canonical module — renaming it would silently zero out the scan below',
    );
    const callers = SLUG_GENERATOR_CALLER_FILES.filter((name) => {
      const p = path.join(SRC_DIR, name);
      return fs.existsSync(p) && fs.readFileSync(p, 'utf-8').includes('generateSlugInternal');
    });
    assert.ok(
      callers.length > 0,
      'no listed caller file mentions generateSlugInternal anymore — the subject was lost, and a green zero below would be meaningless',
    );
  });

  test('no src/*.cts file reintroduces "generateSlugInternal(...) ??", including a two-line split', () => {
    const offenders = [];
    for (const entry of fs.readdirSync(SRC_DIR)) {
      if (!entry.endsWith('.cts')) continue;
      const text = fs.readFileSync(path.join(SRC_DIR, entry), 'utf-8');
      offenders.push(...scanTextForNullishSlugGuard(`src/${entry}`, text));
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `the nullish-coalescing guard was reintroduced at: ${offenders.join(', ')}`,
    );
  });

  test('the scan catches a two-line reintroduction that a line-anchored grep would miss', () => {
    const planted = [
      'function cmdProbe(name) {',
      '  const slug = generateSlugInternal(name)',
      '    ?? error(`probe has no slug-safe characters: ${JSON.stringify(name)}`);',
      '  return slug;',
      '}',
    ].join('\n');

    const structural = scanTextForNullishSlugGuard('planted-probe.cts', planted);
    assert.strictEqual(
      structural.length,
      1,
      'the whole-file scan must catch a construction split across two lines',
    );
    assert.strictEqual(
      structural[0],
      'planted-probe.cts:2',
      'offender must name the file and the line the call starts on',
    );

    // The same probe reproduces the #2908 review trap: a plain, line-anchored
    // grep for `") ?? error("` sees neither line (the call ends without `??`
    // on line 2; `??` opens line 3 without the call on it), so it reports
    // zero — a false-clean result on a file that structural scanning above
    // correctly flags.
    const lineAnchoredHits = planted.split('\n').filter((line) => /"\)\s*\?\?\s*error\(/.test(line));
    assert.deepStrictEqual(
      lineAnchoredHits,
      [],
      'the planted probe must be invisible to a single-line grep, or it does not reproduce the review trap',
    );
  });
});

// ─── 5. Property-parity across all four entry points (#2986) ─────────────────

/**
 * Maintainer's outstanding acceptance criterion on #2848: resurrecting any of
 * the (now-removed) inline copies of the slug rule must fail CI on its own,
 * not just on a manual re-read of the diff. This asserts equality against
 * `generateSlugInternal` itself (the same arbiter as section 1), across
 * hundreds of generated titles per entry point.
 *
 * Every generated title carries at least one Cyrillic word on purpose: on a
 * random ASCII-only string, a resurrected inline copy and the canonical
 * generator agree by coincidence, so the property would never turn red on the
 * exact regression the maintainer flagged. The Cyrillic word is what makes
 * this able to distinguish "delegates" from "reimplements".
 */
const CYRILLIC_WORDS = [
  'Расчёт', 'Ёжик', 'Її', 'объявления', 'щёлкает', 'Фаза', 'ґудзик', 'показателей',
];
const cyrillicWord = fc.constantFrom(...CYRILLIC_WORDS);
const noise = fc.string({
  unit: fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyz0123456789 -_.!'.split(''),
    'é', 'ß', 'ё', 'ї', 'щ', '中', 'ε',
  ),
  maxLength: 34,
});
const propertyTitle = fc.tuple(noise, cyrillicWord, noise, cyrillicWord).map((parts) => parts.join(' '));

/**
 * Entry points described as two small tables (in-process call vs. spawned
 * command), one row per limit that applies at that call site. The subject
 * guard below asserts their combined length is 4 — one row per property test
 * further down — so a row silently dropped from either table is caught here
 * instead of a property test quietly running for one fewer entry point.
 */
const INTERNAL_ENTRY_POINTS = [
  { name: 'phaseId.getPhaseDirFromPhaseId', limit: DEFAULT_SLUG_MAX_LENGTH },
  { name: 'gsd2Import.slugify', limit: Number.POSITIVE_INFINITY },
];
const COMMAND_ENTRY_POINTS = [
  { name: 'gsd generate-slug', limit: DEFAULT_SLUG_MAX_LENGTH },
  { name: 'gsd init quick', limit: 40 },
];

describe('slug parity: property across all four entry points (#2986)', () => {
  test('the parity property has a subject', () => {
    assert.strictEqual(
      typeof generateSlugInternal,
      'function',
      'canonical generator is unreachable — the parity property would be vacuous',
    );
    assert.strictEqual(
      INTERNAL_ENTRY_POINTS.length + COMMAND_ENTRY_POINTS.length,
      4,
      'an entry-point table lost a row — the parity property would be vacuous',
    );
  });

  test('property: phaseId.getPhaseDirFromPhaseId matches the canonical generator', () => {
    fc.assert(
      fc.property(propertyTitle, (text) => {
        const dir = phaseId.getPhaseDirFromPhaseId('1-01', text, null);
        const slug = dir.slice('01-01-'.length);
        return slug === generateSlugInternal(text, DEFAULT_SLUG_MAX_LENGTH);
      }),
    );
  });

  test('property: gsd2Import.slugify matches the canonical generator', () => {
    fc.assert(
      fc.property(propertyTitle, (text) => {
        return gsd2Import.slugify(text) === generateSlugInternal(text, Number.POSITIVE_INFINITY);
      }),
    );
  });

  test('property: gsd generate-slug matches the canonical generator', () => {
    const tmp = createTempProject();
    try {
      fc.assert(
        fc.property(propertyTitle, (text) => {
          const res = runGsdTools(['generate-slug', text], tmp);
          if (!res.success) return false;
          return JSON.parse(res.output).slug === generateSlugInternal(text, DEFAULT_SLUG_MAX_LENGTH);
        }),
        { numRuns: 20 },
      );
    } finally {
      cleanup(tmp);
    }
  });

  test('property: gsd init quick matches the canonical generator', () => {
    const tmp = createTempProject();
    try {
      fc.assert(
        fc.property(propertyTitle, (text) => {
          const res = runGsdTools(['init', 'quick', text], tmp);
          if (!res.success) return false;
          return JSON.parse(res.output).slug === generateSlugInternal(text, 40);
        }),
        { numRuns: 20 },
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── 6. Regression: six guarded call sites refuse an empty slug (PR 2908 review) ───

/**
 * trek-e's CHANGES_REQUESTED blocker on #2908: `generateSlugInternal('!!!')`
 * returns `''`, not `null` — so the `?? error(...)` pattern at six call sites
 * never fires (`??` only reacts to null/undefined, and `''` is neither). Each
 * site below is exercised through its real CLI command, never by calling the
 * guard's helper function directly, so a fix that patches the wrong branch
 * cannot pass this by accident.
 *
 * Every test carries BOTH halves: a healthy Cyrillic name (positive control —
 * proves the probe actually reaches this call site and is not silently
 * skipped) and the all-punctuation input `'!!!'` (the regression itself).
 * Test titles embed the exact `file:line` from the read so the gate can count
 * "6 of 6" by grepping titles, not by trusting a bare pass count.
 */
const REGRESSION_HEALTHY_NAME = 'Фаза сборки';
const REGRESSION_HEALTHY_SLUG = generateSlugInternal(REGRESSION_HEALTHY_NAME, DEFAULT_SLUG_MAX_LENGTH);
const REGRESSION_BAD_NAME = '!!!';

const ROADMAP_ONE_PHASE = [
  '# Roadmap',
  '',
  '## Milestones',
  '',
  '### Phase 1: Foundation',
  '',
  '**Goal:** something',
  '**Status:** ✅ Complete',
  '',
].join('\n');

/** ROADMAP.md whose active-milestone bullet carries `name` as the milestone name. */
function roadmapWithMilestone(name) {
  return [
    '# Roadmap',
    '',
    '## Milestones',
    '',
    `- 🚧 **v1.0 ${name}**`,
    '',
    '### Phase 1: Foundation',
    '',
    '**Goal:** something',
    '**Status:** ✅ Complete',
    '',
  ].join('\n');
}

function currentBranch(cwd) {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
}

describe('regression: six guarded call sites refuse an empty slug (#2908 review)', () => {
  test('src/phase.cts:808 (phase add) refuses "!!!" and creates no nameless phase directory', () => {
    const tmpOk = createTempProject();
    const tmpBad = createTempProject();
    try {
      fs.writeFileSync(path.join(tmpOk, '.planning', 'ROADMAP.md'), ROADMAP_ONE_PHASE);
      const ok = runGsdTools(['phase', 'add', REGRESSION_HEALTHY_NAME], tmpOk);
      assert.ok(ok.success, `healthy name must still succeed: ${ok.error}`);
      assert.strictEqual(JSON.parse(ok.output).slug, REGRESSION_HEALTHY_SLUG);
      assert.ok(
        fs.readdirSync(path.join(tmpOk, '.planning', 'phases')).some((d) => d.includes(REGRESSION_HEALTHY_SLUG)),
        'probe does not reach phase.cts:808 — positive control failed',
      );

      fs.writeFileSync(path.join(tmpBad, '.planning', 'ROADMAP.md'), ROADMAP_ONE_PHASE);
      const bad = runGsdTools(['phase', 'add', REGRESSION_BAD_NAME], tmpBad);
      assert.strictEqual(bad.success, false, `"!!!" must be refused, not silently sluggified: ${bad.output}`);
      assert.deepStrictEqual(
        fs.readdirSync(path.join(tmpBad, '.planning', 'phases')),
        [],
        'a nameless phase directory (e.g. "02-") was created for an unrenderable description',
      );
    } finally {
      cleanup(tmpOk);
      cleanup(tmpBad);
    }
  });

  test('src/phase.cts:957 (phase add-batch) refuses "!!!" and creates no nameless phase directory', () => {
    const tmpOk = createTempProject();
    const tmpBad = createTempProject();
    try {
      fs.writeFileSync(path.join(tmpOk, '.planning', 'ROADMAP.md'), ROADMAP_ONE_PHASE);
      const ok = runGsdTools(['phase', 'add-batch', '--descriptions', JSON.stringify([REGRESSION_HEALTHY_NAME])], tmpOk);
      assert.ok(ok.success, `healthy name must still succeed: ${ok.error}`);
      assert.strictEqual(JSON.parse(ok.output).phases[0].slug, REGRESSION_HEALTHY_SLUG);
      assert.ok(
        fs.readdirSync(path.join(tmpOk, '.planning', 'phases')).some((d) => d.includes(REGRESSION_HEALTHY_SLUG)),
        'probe does not reach phase.cts:957 — positive control failed',
      );

      fs.writeFileSync(path.join(tmpBad, '.planning', 'ROADMAP.md'), ROADMAP_ONE_PHASE);
      const bad = runGsdTools(['phase', 'add-batch', '--descriptions', JSON.stringify([REGRESSION_BAD_NAME])], tmpBad);
      assert.strictEqual(bad.success, false, `"!!!" must be refused, not silently sluggified: ${bad.output}`);
      assert.deepStrictEqual(
        fs.readdirSync(path.join(tmpBad, '.planning', 'phases')),
        [],
        'a nameless phase directory (e.g. "02-") was created for an unrenderable description',
      );
    } finally {
      cleanup(tmpOk);
      cleanup(tmpBad);
    }
  });

  test('src/phase.cts:1014 (phase insert) refuses "!!!" and creates no nameless decimal directory', () => {
    const tmpOk = createTempProject();
    const tmpBad = createTempProject();
    try {
      fs.writeFileSync(path.join(tmpOk, '.planning', 'ROADMAP.md'), ROADMAP_ONE_PHASE);
      const ok = runGsdTools(['phase', 'insert', '1', REGRESSION_HEALTHY_NAME], tmpOk);
      assert.ok(ok.success, `healthy name must still succeed: ${ok.error}`);
      assert.strictEqual(JSON.parse(ok.output).slug, REGRESSION_HEALTHY_SLUG);
      assert.ok(
        fs.readdirSync(path.join(tmpOk, '.planning', 'phases')).some((d) => d.includes(REGRESSION_HEALTHY_SLUG)),
        'probe does not reach phase.cts:1014 — positive control failed',
      );

      fs.writeFileSync(path.join(tmpBad, '.planning', 'ROADMAP.md'), ROADMAP_ONE_PHASE);
      const bad = runGsdTools(['phase', 'insert', '1', REGRESSION_BAD_NAME], tmpBad);
      assert.strictEqual(bad.success, false, `"!!!" must be refused, not silently sluggified: ${bad.output}`);
      assert.deepStrictEqual(
        fs.readdirSync(path.join(tmpBad, '.planning', 'phases')),
        [],
        'a nameless decimal directory (e.g. "01.1-") was created for an unrenderable description',
      );
    } finally {
      cleanup(tmpOk);
      cleanup(tmpBad);
    }
  });

  test('src/workstream.cts:165 (workstream create migration) refuses an unrenderable milestone name and starts no migration', () => {
    const tmpOk = createTempProject();
    const tmpBad = createTempProject();
    try {
      fs.writeFileSync(path.join(tmpOk, '.planning', 'ROADMAP.md'), roadmapWithMilestone(REGRESSION_HEALTHY_NAME));
      const ok = runGsdTools(['workstream', 'create', 'feature-x'], tmpOk);
      assert.ok(ok.success, `healthy milestone name must still succeed: ${ok.error}`);
      assert.ok(
        fs.existsSync(path.join(tmpOk, '.planning', 'workstreams', REGRESSION_HEALTHY_SLUG)),
        'probe does not reach workstream.cts:165 — positive control failed (no migrated workstream named after the milestone)',
      );

      fs.writeFileSync(path.join(tmpBad, '.planning', 'ROADMAP.md'), roadmapWithMilestone(REGRESSION_BAD_NAME));
      const bad = runGsdTools(['workstream', 'create', 'feature-x'], tmpBad);
      assert.strictEqual(
        bad.success,
        false,
        `an unrenderable milestone name must be refused, not silently migrated under an empty directory: ${bad.output}`,
      );
      assert.strictEqual(
        fs.existsSync(path.join(tmpBad, '.planning', 'workstreams')),
        false,
        'migration proceeded (workstreams/ was created) for an unrenderable milestone name',
      );
    } finally {
      cleanup(tmpOk);
      cleanup(tmpBad);
    }
  });

  test('src/commands.cts:861 (commit milestone-branch guard) refuses an unrenderable milestone name and creates no nameless branch', () => {
    const tmpOk = createTempGitProject();
    const tmpBad = createTempGitProject();
    try {
      const config = JSON.stringify({
        commit_docs: true,
        branching_strategy: 'milestone',
        milestone_branch_template: 'milestone/{milestone}-{slug}',
      });

      fs.writeFileSync(path.join(tmpOk, '.planning', 'ROADMAP.md'), roadmapWithMilestone(REGRESSION_HEALTHY_NAME));
      fs.writeFileSync(path.join(tmpOk, '.planning', 'config.json'), config);
      fs.writeFileSync(path.join(tmpOk, 'touched.txt'), 'x');
      const ok = runGsdTools(['commit', 'test: probe', '--files', 'touched.txt'], tmpOk);
      assert.ok(ok.success, `healthy milestone name must still succeed: ${ok.error}`);
      assert.strictEqual(
        currentBranch(tmpOk),
        `milestone/v1.0-${REGRESSION_HEALTHY_SLUG}`,
        'probe does not reach commands.cts:861 — positive control failed (branch was not renamed after the milestone)',
      );

      fs.writeFileSync(path.join(tmpBad, '.planning', 'ROADMAP.md'), roadmapWithMilestone(REGRESSION_BAD_NAME));
      fs.writeFileSync(path.join(tmpBad, '.planning', 'config.json'), config);
      fs.writeFileSync(path.join(tmpBad, 'touched.txt'), 'x');
      const branchBefore = currentBranch(tmpBad);
      const bad = runGsdTools(['commit', 'test: probe', '--files', 'touched.txt'], tmpBad);
      assert.strictEqual(
        bad.success,
        false,
        `an unrenderable milestone name must be refused, not silently checked out onto a nameless branch: ${bad.output}`,
      );
      assert.strictEqual(
        currentBranch(tmpBad),
        branchBefore,
        'a nameless branch (e.g. "milestone/v1.0-") was created for an unrenderable milestone name',
      );
    } finally {
      cleanup(tmpOk);
      cleanup(tmpBad);
    }
  });

  test('src/init.cts:544 (init execute-phase branch_name) refuses an unrenderable milestone name', () => {
    const tmpOk = createTempProject();
    const tmpBad = createTempProject();
    try {
      const config = JSON.stringify({
        commit_docs: true,
        branching_strategy: 'milestone',
        milestone_branch_template: 'milestone/{milestone}-{slug}',
      });

      fs.mkdirSync(path.join(tmpOk, '.planning', 'phases', '01-foundation'), { recursive: true });
      fs.writeFileSync(path.join(tmpOk, '.planning', 'ROADMAP.md'), roadmapWithMilestone(REGRESSION_HEALTHY_NAME));
      fs.writeFileSync(path.join(tmpOk, '.planning', 'config.json'), config);
      const ok = runGsdTools(['init', 'execute-phase', '1'], tmpOk);
      assert.ok(ok.success, `healthy milestone name must still succeed: ${ok.error}`);
      assert.strictEqual(
        JSON.parse(ok.output).branch_name,
        `milestone/v1.0-${REGRESSION_HEALTHY_SLUG}`,
        'probe does not reach init.cts:544 — positive control failed',
      );

      fs.mkdirSync(path.join(tmpBad, '.planning', 'phases', '01-foundation'), { recursive: true });
      fs.writeFileSync(path.join(tmpBad, '.planning', 'ROADMAP.md'), roadmapWithMilestone(REGRESSION_BAD_NAME));
      fs.writeFileSync(path.join(tmpBad, '.planning', 'config.json'), config);
      const bad = runGsdTools(['init', 'execute-phase', '1'], tmpBad);
      assert.strictEqual(
        bad.success,
        false,
        `an unrenderable milestone name must be refused, not silently reported as a nameless branch_name: ${bad.output}`,
      );
    } finally {
      cleanup(tmpOk);
      cleanup(tmpBad);
    }
  });
});
