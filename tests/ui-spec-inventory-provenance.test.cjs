'use strict';

/**
 * UI-SPEC component-inventory provenance (#2845).
 *
 * Two contracts are under test, and both are SHARED FORMATS spread across surfaces
 * with no generator — the `DEFECT.GENERATIVE-FIX-DIVERGENCE` class:
 *
 *   1. The gsd-ui-checker DIMENSION ROSTER, asserted independently on twelve surfaces
 *      (eight English, four translated). Adding Dimension 7 is only correct if every
 *      one of them moves together; a count-only guard would miss a relabel, and a
 *      guard that reads only the real tree never executes its own failure branch.
 *      Every parity assertion below is therefore paired with a synthetic MUTATION case.
 *
 *   2. The PROVENANCE-LINE GRAMMAR, emitted by `gsd-core/templates/UI-SPEC.md`
 *      (`## Component Inventory`) and consumed by `agents/gsd-ui-checker.md`
 *      (Dimension 7). One format, two surfaces, opposite directions — the two must
 *      quote it byte-identically or the checker keys on a shape the template never emits.
 *
 * The units under test are the shipped markdown documents themselves: their text IS
 * what the runtime loads (CONTRIBUTING.md — `source-text-is-the-product`). Structure is
 * asserted on parsed, typed records (`{ n, label }`, token sets, violation objects)
 * rather than on raw substrings, per CONTRIBUTING.md's "Prohibited: Raw Text Matching".
 *
 * Three assertions are a deliberate exception: Dimension 7's allowlist-downgrade
 * wording, its not-applicable PASS clause, and the template's non-exhaustive clause are
 * CONTRACT PROSE — the sentence itself is the deliverable an agent reads at runtime, so
 * there is no typed IR to assert on instead. That is the `source-text-is-the-product`
 * category, not an escape from the rule.
 *
 * They carry NO `allow-test-rule` marker, deliberately and against first instinct.
 * `no-source-grep` only inspects reads of `.cjs`/`.cts`/`.js`/`.mjs`/`.mts`/`.ts` paths,
 * never `.md` ones, so a marker here suppresses nothing: it lands in the gate's
 * "unverified" bucket, which is ceilinged. Measured on 2026-08-21 — adding three markers
 * took that count 280 -> 281 and FAILED `scripts/lint-allow-test-rule-refs.cjs`. Raising
 * the ceiling for markers that suppress nothing is the "just bump the baseline" weakening
 * the ratchet exists to prevent, so the honest answer is no marker and this note.
 *
 * See https://github.com/open-gsd/gsd-core/issues/2845
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const ROOT = path.join(__dirname, '..');

// ─── Shipped surfaces ─────────────────────────────────────────────────────────

const SURFACE = Object.freeze({
  CHECKER: 'agents/gsd-ui-checker.md',
  RESEARCHER: 'agents/gsd-ui-researcher.md',
  TEMPLATE: 'gsd-core/templates/UI-SPEC.md',
  WORKFLOW: 'gsd-core/workflows/ui-phase.md',
  FEATURES: 'docs/FEATURES.md',
  HOWTO: 'docs/how-to/design-a-ui-phase.md',
  FEATURES_JA: 'docs/ja-JP/FEATURES.md',
  HOWTO_JA: 'docs/ja-JP/how-to/design-a-ui-phase.md',
  FEATURES_ZH: 'docs/zh-CN/FEATURES.md',
  HOWTO_ZH: 'docs/zh-CN/how-to/design-a-ui-phase.md',
  FEATURES_KO: 'docs/ko-KR/FEATURES.md',
  HOWTO_KO: 'docs/ko-KR/how-to/design-a-ui-phase.md',
  HOWTO_PT: 'docs/pt-BR/how-to/design-a-ui-phase.md',
  PROBE_REFERENCE: 'gsd-core/references/ui-consideration-probe.md',
});

function readShipped(rel) {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

/** CRLF-normalize before any line splitting — a raw `\n` split leaves `\r` on every
 *  captured label and makes a Windows checkout parse differently (CRLF bug class). */
const lf = (text) => String(text == null ? '' : text).replace(/\r\n/g, '\n');

// ─── Parsers → typed IR ───────────────────────────────────────────────────────

/** Line-oriented scan yielding `{ n, label }` for every line matching `re`.
 *  `skipFenced` drops lines inside ``` blocks — a `## Dimension 8:` shown as an
 *  EXAMPLE inside a fence is documentation, not a roster entry. The verdict block
 *  is itself fenced, so its parser must NOT skip fences. */
function matchLines(text, re, { skipFenced = false } = {}) {
  const out = [];
  let inFence = false;
  for (const line of lf(text).split('\n')) {
    if (skipFenced && /^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = re.exec(line);
    if (m) out.push({ n: Number(m[1]), label: m[2].trim() });
  }
  return out;
}

/** `## Dimension <N>: <Label>` — the canonical roster. */
function parseDimensionHeadings(text) {
  return matchLines(text, /^##\s+Dimension\s+(\d+):\s*(\S.*?)\s*$/, { skipFenced: true });
}

/** `Dimension <N> — <Label>: {PASS / FLAG / BLOCK}` — the verdict block (itself fenced). */
function parseVerdictBlock(text) {
  return matchLines(text, /^Dimension\s+(\d+)\s*[—-]\s*(\S.*?):\s*\{/);
}

/** `- [ ] Dimension <N> <Label>: PASS` — the template's Checker Sign-Off. */
function parseSignOff(text) {
  return matchLines(text, /^-\s+\[\s*\]\s+Dimension\s+(\d+)\s+(\S.*?):\s*PASS\s*$/);
}

/** `| <N> <Label> | {PASS/FLAG} | … |` — the structured-return dimension tables.
 *  Two such tables ship (VERIFIED and ISSUES FOUND), so rows are de-duplicated. */
function parseReturnTableRows(text) {
  const seen = new Map();
  for (const line of lf(text).split('\n')) {
    const m = /^\|\s*(\d+)\s+([^|]+?)\s*\|/.exec(line);
    if (m) seen.set(`${m[1]}|${m[2]}`, { n: Number(m[1]), label: m[2] });
  }
  return [...seen.values()];
}

/** `1. **<Label>** — …` inside a "Validation Dimensions" list. Numerals stay ASCII in
 *  every locale, so this parses the translated lists too. */
function parseNumberedDimensionList(text) {
  const out = [];
  for (const line of lf(text).split('\n')) {
    const m = /^(\d+)\.\s+\*\*(\S.*?)\*\*/.exec(line);
    if (m) out.push({ n: Number(m[1]), label: m[2] });
  }
  return out;
}

const WORD_NUMERAL = Object.freeze({
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  seis: 6, sete: 7, oito: 8,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  여섯: 6, 일곱: 7, 여덟: 8,
});

/** A numeral introduced by "other" or "remaining" is a BACK-REFERENCE to the rest of a set
 *  — "the same as the other six dimensions" — never a claim about the set's SIZE. Counting
 *  one turned `next` red on dacae9273 against entirely correct documentation, and a drift
 *  guard that fires on accurate prose is a false positive, which is how guards end up
 *  disabled.
 *
 *  Declared once and shared by both English scans so the two can never drift apart — the
 *  same divergence class this whole suite exists to catch. `\b` anchors it to the whole
 *  word, so "another six dimensions" (a real claim about a second set) still counts, and
 *  both scans apply it case-insensitively: a sentence-initial "Other six dimensions…" is
 *  the same back-reference as a mid-sentence one.
 *
 *  Known limits: the exclusion is English-only — the ja/zh/ko/pt patterns have no
 *  equivalent, because translated docs here are CORRECTED to match English rather than
 *  authored, so there is no instance to model the grammar on. And it cannot tell a
 *  back-reference from a genuine total that happens to open with the same word ("Other 6
 *  dimensions were added"); prose alone does not disambiguate those, and the false-negative
 *  is the safer side of that trade for a guard whose failure mode is being switched off. */
const NOT_A_BACK_REFERENCE = String.raw`(?<!\b(?:other|remaining)\s)`;

/** Every numeric "N dimensions" claim in `text`, in any of the shipped languages.
 *  Returns plain numbers — the typed IR the parity function consumes.
 *
 *  `excludeBackReferences: false` reproduces the pre-fix behavior. It exists so a test can
 *  prove, against the real shipped files, that the exclusion is load-bearing rather than
 *  decorative — see the dacae9273 regression block. */
function parseDeclaredCounts(text, { excludeBackReferences = true } = {}) {
  const body = lf(text);
  const found = [];
  const push = (v) => { if (Number.isInteger(v)) found.push(v); };
  const scan = (re, take) => { for (const m of body.matchAll(re)) take(m); };
  const guard = excludeBackReferences ? NOT_A_BACK_REFERENCE : '';

  // "6 dimensions", "6 design quality dimensions", "6 Validation Dimensions"
  scan(new RegExp(`${guard}(\\d+)\\s+(?:[A-Za-z][A-Za-z-]*\\s+){0,3}?[Dd]imensions?\\b`, 'gi'),
    (m) => push(Number(m[1])));
  // "six dimensions", "six quality dimensions"
  scan(new RegExp(`${guard}\\b(five|six|seven|eight|nine|ten)\\s+(?:[A-Za-z][A-Za-z-]*\\s+){0,3}?dimensions\\b`, 'gi'),
    (m) => push(WORD_NUMERAL[m[1].toLowerCase()]));
  // "Dimensions: 6/6 passed"
  scan(/Dimensions:\s*(\d+)\/(\d+)/g, (m) => { push(Number(m[1])); push(Number(m[2])); });
  // ja: "6つの次元", "6つのバリデーション次元", "6 つの側面"
  scan(/(\d+)\s*つの[^\s。、]*?(?:次元|側面)/g, (m) => push(Number(m[1])));
  // zh: "6 个维度"
  scan(/(\d+)\s*个[^\s：:，,。]{0,6}?维度/g, (m) => push(Number(m[1])));
  // zh: "六个维度"
  scan(/([五六七八九十])\s*个[^\s：:，,。]{0,6}?维度/g, (m) => push(WORD_NUMERAL[m[1]]));
  // ko: "7개 차원", "7가지 유효성 검사 차원"
  scan(/(\d+)\s*(?:개|가지)\s*[^\n]{0,12}?차원/g, (m) => push(Number(m[1])));
  // ko: "일곱 가지 차원"
  scan(/(여섯|일곱|여덟)\s*가지\s*[^\n]{0,12}?차원/g, (m) => push(WORD_NUMERAL[m[1]]));
  // pt: "7 dimensões"
  scan(/(\d+)\s+dimens(?:ão|ões)/g, (m) => push(Number(m[1])));
  // pt: "sete dimensões"
  scan(/\b(seis|sete|oito)\s+dimens(?:ão|ões)\b/gi, (m) => push(WORD_NUMERAL[m[1].toLowerCase()]));

  return found;
}

/** The `##`/`###`/`####` section whose body contains `needle`. */
function sectionContaining(text, needle) {
  const lines = lf(text).split('\n');
  const hit = lines.findIndex((l) => l.includes(needle));
  if (hit === -1) return '';
  const isHeading = (l) => /^#{2,4}\s/.test(l);
  let start = hit;
  while (start > 0 && !isHeading(lines[start])) start -= 1;
  let end = hit + 1;
  while (end < lines.length && !isHeading(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

const PROVENANCE_TOKEN = Object.freeze({
  COMMAND: 'command',
  COUNT: 'count',
  VERSION: 'version',
  DATE: 'date',
});

const REQUIRED_PROVENANCE_TOKENS = Object.freeze([
  PROVENANCE_TOKEN.COMMAND, PROVENANCE_TOKEN.COUNT,
  PROVENANCE_TOKEN.VERSION, PROVENANCE_TOKEN.DATE,
]);

/** The canonical provenance grammar line and the placeholder tokens it carries.
 *  `null` when the section states no grammar at all. */
function parseProvenanceGrammar(text) {
  const line = lf(text).split('\n').map((l) => l.trim())
    .find((l) => /^Enumerated by\b/.test(l));
  if (!line) return null;
  const tokens = new Set();
  if (/`<command>`/.test(line)) tokens.add(PROVENANCE_TOKEN.COMMAND);
  if (/<N>\s+components/.test(line)) tokens.add(PROVENANCE_TOKEN.COUNT);
  if (/<package>@<version>/.test(line)) tokens.add(PROVENANCE_TOKEN.VERSION);
  if (/<YYYY-MM-DD>/.test(line)) tokens.add(PROVENANCE_TOKEN.DATE);
  return { line, tokens };
}

/** The "could not enumerate" shape that must live in the SAME slot (#2845 A3). */
function parseCannotEnumerateShape(text) {
  return lf(text).split('\n').map((l) => l.trim())
    .find((l) => /^Could not enumerate:\s*<reason>/.test(l)) || null;
}

/** A fenced ```yaml example-issue block, as flat `key: value` records. */
function parseYamlExampleBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of lf(text).split('\n')) {
    if (/^```ya?ml\s*$/.test(line)) { current = {}; continue; }
    if (current && /^```\s*$/.test(line)) { blocks.push(current); current = null; continue; }
    if (current) {
      const m = /^([a-z_]+):\s*(.*)$/.exec(line);
      if (m) current[m[1]] = m[2].replace(/^"(.*)"$/, '$1').trim();
    }
  }
  return blocks;
}

/** Which verdict tiers a dimension section declares criteria for. */
function parseVerdictTiers(section) {
  const tiers = new Set();
  for (const line of lf(section).split('\n')) {
    const m = /^\*\*(BLOCK|FLAG|PASS) if:\*\*/.exec(line.trim());
    if (m) tiers.add(m[1]);
  }
  return tiers;
}

// ─── The parity function (typed IR in, violations out) ────────────────────────

const rosterKey = (d) => `${d.n}|${d.label}`;
const rosterFingerprint = (roster) => roster.map(rosterKey).join(' ');

/**
 * @returns {{kind:string, surface:string}[]} — empty when every surface agrees with
 * `canonical`. Never throws; a surface that declares no count at all is itself a
 * violation, because a pattern that went stale is how a parity guard turns vacuous.
 */
function checkRosterParity({ canonical, rosterSurfaces = [], countSurfaces = [] }) {
  const violations = [];

  if (canonical.length === 0) {
    violations.push({ kind: 'empty-roster', surface: 'canonical' });
    return violations;
  }
  const seen = new Set();
  canonical.forEach((d, i) => {
    if (d.n !== i + 1) violations.push({ kind: 'non-contiguous', surface: 'canonical', at: d.n });
    if (seen.has(d.n)) violations.push({ kind: 'duplicate', surface: 'canonical', at: d.n });
    seen.add(d.n);
  });

  const want = rosterFingerprint(canonical);
  for (const s of rosterSurfaces) {
    if (rosterFingerprint(s.roster) !== want) {
      violations.push({ kind: 'roster-mismatch', surface: s.name, found: s.roster, expected: canonical });
    }
  }

  for (const s of countSurfaces) {
    if (s.counts.length === 0) {
      violations.push({ kind: 'no-count-found', surface: s.name });
      continue;
    }
    for (const c of s.counts) {
      if (c !== canonical.length) {
        violations.push({ kind: 'count-mismatch', surface: s.name, found: c, expected: canonical.length });
      }
    }
  }
  return violations;
}

// ─── Real-tree reads ──────────────────────────────────────────────────────────

const checker = readShipped(SURFACE.CHECKER);
const researcher = readShipped(SURFACE.RESEARCHER);
const template = readShipped(SURFACE.TEMPLATE);
const workflow = readShipped(SURFACE.WORKFLOW);

const CANONICAL = parseDimensionHeadings(checker);
const EXPECTED_DIMENSIONS = 7;
const DIMENSION_7_LABEL = 'Inventory Provenance';

const featuresRegion = (rel) => sectionContaining(readShipped(rel), 'REQ-UI-03');

// ─── Suites ───────────────────────────────────────────────────────────────────

describe('#2845 — gsd-ui-checker dimension roster', () => {
  test('the checker declares a contiguous 1..7 roster whose 7th is Inventory Provenance', () => {
    assert.equal(CANONICAL.length, EXPECTED_DIMENSIONS);
    assert.deepEqual(CANONICAL.map((d) => d.n), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(CANONICAL[6], { n: 7, label: DIMENSION_7_LABEL });
  });

  test('the verdict block lists exactly the roster, same numbers and same labels', () => {
    assert.deepEqual(parseVerdictBlock(checker), CANONICAL);
  });

  test('every roster dimension appears in the structured-return tables', () => {
    const rowKeys = new Set(parseReturnTableRows(checker).map(rosterKey));
    for (const d of CANONICAL) {
      assert.ok(rowKeys.has(rosterKey(d)), `return tables omit "${d.n} ${d.label}"`);
    }
  });

  test('the template Checker Sign-Off lists exactly the roster', () => {
    assert.deepEqual(parseSignOff(template), CANONICAL);
  });
});

describe('#2845 — cross-surface dimension-count parity (12 surfaces)', () => {
  // Every surface that states a UI-checker dimension count, in any shipped language.
  // ko-KR, pt-BR and the probe reference were MISSED on the first pass of #2845 and
  // shipped stale — a guard that omits a surface is exactly as blind as no guard.
  const COUNT_SURFACES = [
    SURFACE.CHECKER, SURFACE.RESEARCHER, SURFACE.WORKFLOW, SURFACE.PROBE_REFERENCE,
    SURFACE.FEATURES, SURFACE.HOWTO,
    SURFACE.FEATURES_JA, SURFACE.HOWTO_JA,
    SURFACE.FEATURES_ZH, SURFACE.HOWTO_ZH,
    SURFACE.FEATURES_KO, SURFACE.HOWTO_KO,
    SURFACE.HOWTO_PT,
  ];

  test('no shipped surface still declares a stale dimension count', () => {
    const countSurfaces = COUNT_SURFACES.map((rel) => ({
      name: rel,
      // FEATURES.md is a whole-product doc; scope it to the UI Design Contract section
      // so gsd-plan-checker's own dimension counts elsewhere are not swept in.
      counts: parseDeclaredCounts(
        rel.endsWith('FEATURES.md') ? featuresRegion(rel) : readShipped(rel),
      ),
    }));
    const violations = checkRosterParity({ canonical: CANONICAL, countSurfaces });
    assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
  });

  test('each FEATURES.md locale numbers its validation-dimension list 1..7', () => {
    for (const rel of [SURFACE.FEATURES, SURFACE.FEATURES_JA, SURFACE.FEATURES_ZH, SURFACE.FEATURES_KO]) {
      const list = parseNumberedDimensionList(featuresRegion(rel));
      assert.deepEqual(list.map((d) => d.n), [1, 2, 3, 4, 5, 6, 7], `${rel} dimension list`);
    }
  });

  test("the English FEATURES.md list uses the checker's own labels", () => {
    assert.deepEqual(parseNumberedDimensionList(featuresRegion(SURFACE.FEATURES)), CANONICAL);
  });
});

describe('#2845 — parity guard non-vacuity (mutation cases)', () => {
  const canonical = [
    { n: 1, label: 'Copywriting' }, { n: 2, label: 'Visuals' }, { n: 3, label: 'Color' },
    { n: 4, label: 'Typography' }, { n: 5, label: 'Spacing' }, { n: 6, label: 'Registry Safety' },
    { n: 7, label: DIMENSION_7_LABEL },
  ];
  const kinds = (v) => v.map((x) => x.kind);

  test('accepts the aligned roster at the limit (7 on every surface)', () => {
    assert.deepEqual(checkRosterParity({
      canonical,
      rosterSurfaces: [{ name: 'verdict', roster: canonical }],
      countSurfaces: [{ name: 'docs', counts: [7, 7] }],
    }), []);
  });

  test('fails at limit-1 — a surface still declaring 6', () => {
    const v = checkRosterParity({ canonical, countSurfaces: [{ name: 'docs', counts: [6] }] });
    assert.deepEqual(kinds(v), ['count-mismatch']);
    assert.equal(v[0].found, 6);
    assert.equal(v[0].surface, 'docs');
  });

  test('fails at limit+1 — a surface declaring 8', () => {
    const v = checkRosterParity({ canonical, countSurfaces: [{ name: 'docs', counts: [8] }] });
    assert.deepEqual(kinds(v), ['count-mismatch']);
    assert.equal(v[0].found, 8);
  });

  test('fails when a surface stops declaring any count at all (stale pattern)', () => {
    const v = checkRosterParity({ canonical, countSurfaces: [{ name: 'docs', counts: [] }] });
    assert.deepEqual(kinds(v), ['no-count-found']);
  });

  test('fails when a dimension is dropped from one roster surface', () => {
    const v = checkRosterParity({
      canonical,
      rosterSurfaces: [{ name: 'verdict', roster: canonical.slice(0, 6) }],
    });
    assert.deepEqual(kinds(v), ['roster-mismatch']);
  });

  test('fails on a label that drifts on one surface only — a count-only guard would pass this', () => {
    const drifted = canonical.map((d) => (d.n === 7 ? { n: 7, label: 'Inventory Sourcing' } : d));
    const v = checkRosterParity({ canonical, rosterSurfaces: [{ name: 'verdict', roster: drifted }] });
    assert.deepEqual(kinds(v), ['roster-mismatch']);
    // and the count-only lane is genuinely blind to it, which is why both lanes exist
    assert.deepEqual(
      checkRosterParity({ canonical, countSurfaces: [{ name: 'docs', counts: [drifted.length] }] }),
      [],
    );
  });

  test('fails on a non-contiguous roster', () => {
    const gapped = [...canonical.slice(0, 4), { n: 6, label: 'Registry Safety' }];
    assert.ok(kinds(checkRosterParity({ canonical: gapped })).includes('non-contiguous'));
  });

  test('fails on a duplicated dimension number', () => {
    const duped = [...canonical.slice(0, 6), { n: 6, label: DIMENSION_7_LABEL }];
    assert.ok(kinds(checkRosterParity({ canonical: duped })).includes('duplicate'));
  });

  test('an empty roster is a violation, not a silent pass', () => {
    assert.deepEqual(kinds(checkRosterParity({ canonical: [] })), ['empty-roster']);
  });
});

describe('#2845 — parsers are total and newline-agnostic', () => {
  const parsers = [
    parseDimensionHeadings, parseVerdictBlock, parseSignOff,
    parseReturnTableRows, parseNumberedDimensionList, parseDeclaredCounts,
  ];

  test('CRLF text parses identically to LF text on every real surface', () => {
    for (const text of [checker, template, workflow, researcher]) {
      const crlf = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      for (const parse of parsers) {
        assert.deepEqual(parse(crlf), parse(text), `${parse.name} differs under CRLF`);
      }
    }
  });

  test('empty, whitespace-only, null and absent input yield empty results, never a throw', () => {
    for (const input of ['', '   \n\t\n  ', null, undefined, readShipped('docs/does-not-exist.md')]) {
      for (const parse of parsers) assert.deepEqual(parse(input), []);
      assert.equal(parseProvenanceGrammar(input), null);
      assert.equal(parseCannotEnumerateShape(input), null);
      assert.deepEqual(parseYamlExampleBlocks(input), []);
      assert.equal(sectionContaining(input, 'REQ-UI-03'), '');
    }
  });
});

describe('#2845 — a back-reference is not a count claim (regression: `next` red on dacae9273)', () => {
  // The how-to gained "Dimension 7 is a rule gsd-ui-checker follows, the same as the
  // other six dimensions" — correct prose — and the guard read "six dimensions" as that
  // document claiming the checker has six. `next` went red on documentation that was
  // right.
  //
  // Worth recording WHY it reached `next`: the docs PR was green. A doc-only diff
  // inert-skips the test matrix in the PR lane, so the guard that reads docs never ran
  // against the docs change that broke it. It fired on push to `next` — after merge.

  test('"the other N dimensions" / "the remaining N dimensions" are not counted', () => {
    for (const phrase of [
      'Dimension 7 is a rule the checker follows, the same as the other six dimensions.',
      'the same as the other 6 dimensions',
      'the remaining six dimensions are unchanged',
      'the remaining 6 dimensions are unchanged',
      // Sentence-initial: the digit scan was case-SENSITIVE while the word scan was not,
      // so these two slipped through the first version of this fix.
      'Other six dimensions apply.',
      'Other 6 dimensions apply.',
      'Remaining six dimensions are unaffected.',
      'Remaining 6 dimensions are unaffected.',
    ]) {
      assert.deepEqual(parseDeclaredCounts(phrase), [], `counted a back-reference: ${phrase}`);
    }
  });

  test('a real count claim is still counted — the fix must not blind the guard', () => {
    assert.deepEqual(parseDeclaredCounts('validates the spec across six dimensions'), [6]);
    assert.deepEqual(parseDeclaredCounts('System MUST validate against 7 dimensions'), [7]);
    assert.deepEqual(parseDeclaredCounts('All 7 dimensions evaluated'), [7]);
    assert.deepEqual(parseDeclaredCounts('**7 Validation Dimensions:**'), [7]);
    assert.deepEqual(parseDeclaredCounts('gsd-ui-checker seven quality dimensions'), [7]);
  });

  test('the exclusion is anchored to the whole word, not a substring', () => {
    // "another" contains "other" but has no word boundary before it, so a genuine claim
    // about a second set must survive.
    assert.deepEqual(parseDeclaredCounts('another six dimensions'), [6]);
  });

  test('the exclusion is load-bearing on the real shipped how-to, not just on fixtures', () => {
    // Typed proof rather than a substring match on prose: run the matcher over the real
    // file with the exclusion OFF and then ON. Off, it must report a 6 — that 6 is the
    // back-reference, and is literally what turned `next` red. On, only 7s survive.
    // If the docs prose is ever reworded away, the first assertion fails loudly rather
    // than this guard quietly ceasing to exercise the path it exists for.
    const howto = readShipped(SURFACE.HOWTO);
    const withoutExclusion = [...new Set(parseDeclaredCounts(howto, { excludeBackReferences: false }))].sort();
    const withExclusion = [...new Set(parseDeclaredCounts(howto))].sort();

    assert.deepEqual(withoutExclusion, [6, 7],
      'vacuous unless the how-to still carries the back-reference this guard exists for');
    assert.deepEqual(withExclusion, [7]);
  });
});

describe('#2845 — Dimension 7 contract text', () => {
  const dim7 = () => sectionContaining(checker, `## Dimension 7: ${DIMENSION_7_LABEL}`);
  const dim6 = () => sectionContaining(checker, '## Dimension 6: Registry Safety');

  test('declares criteria for all three verdict tiers', () => {
    assert.deepEqual([...parseVerdictTiers(dim7())].sort(), ['BLOCK', 'FLAG', 'PASS']);
  });

  test('ships a well-formed example issue keyed to dimension 7', () => {
    const examples = parseYamlExampleBlocks(dim7());
    assert.ok(examples.length >= 1, 'Dimension 7 must ship at least one example issue');
    const [first] = examples;
    assert.equal(first.dimension, '7');
    for (const field of ['severity', 'description', 'fix_hint']) {
      assert.ok(first[field] && first[field].length > 0, `example issue is missing ${field}`);
    }
  });

  test('records the allowlist downgrade an executor depends on (#2845 acceptance B2)', () => {
    const body = lf(dim7()).toLowerCase();
    assert.ok(body.includes('closed allowlist'), 'must name what the inventory is NOT');
    assert.ok(body.includes('non-exhaustive'), 'must name what it is downgraded TO');
  });

  test('passes a spec that carries no component inventory at all (backward compatibility)', () => {
    const body = lf(dim7()).toLowerCase();
    assert.ok(
      body.includes('no component inventory'),
      'Dimension 7 must state the not-applicable PASS, or every UI-SPEC predating #2845 blocks',
    );
  });

  test('is not scoped by workflow.ui_safety_gate — that clause belongs to Dimension 6 alone', () => {
    assert.ok(dim6().includes('workflow.ui_safety_gate'), 'Dimension 6 keeps its config gate');
    assert.ok(!dim7().includes('workflow.ui_safety_gate'), 'Dimension 7 must not inherit it');
  });
});

describe('#2845 — provenance grammar parity (template emits, checker consumes)', () => {
  const templateSlot = () => sectionContaining(template, '## Component Inventory');
  const dim7 = () => sectionContaining(checker, `## Dimension 7: ${DIMENSION_7_LABEL}`);

  test('the template slot states the grammar and requires all four tokens', () => {
    const grammar = parseProvenanceGrammar(templateSlot());
    assert.ok(grammar, 'template must state the provenance grammar');
    assert.deepEqual([...grammar.tokens].sort(), [...REQUIRED_PROVENANCE_TOKENS].sort());
  });

  test('the could-not-enumerate shape lives in the SAME slot (#2845 acceptance A3)', () => {
    assert.ok(parseCannotEnumerateShape(templateSlot()), 'same slot must accept a negative record');
  });

  test('the slot states the inventory is non-exhaustive without provenance (#2845 acceptance B2)', () => {
    assert.ok(lf(templateSlot()).toLowerCase().includes('non-exhaustive'));
  });

  test('template and checker quote a byte-identical grammar line', () => {
    const emitted = parseProvenanceGrammar(templateSlot());
    const consumed = parseProvenanceGrammar(dim7());
    assert.ok(emitted && consumed, 'both surfaces must state the grammar');
    assert.equal(consumed.line, emitted.line);
    assert.deepEqual([...consumed.tokens].sort(), [...emitted.tokens].sort());
  });

  test('token parity is non-vacuous at 3, 4 and 4-plus-extra tokens', () => {
    const four = new Set(REQUIRED_PROVENANCE_TOKENS);
    const three = new Set([...four].slice(0, 3));                      // limit-1
    const extra = new Set([...four, 'unrecognized']);                  // limit+1
    const missing = (set) => REQUIRED_PROVENANCE_TOKENS.filter((t) => !set.has(t));

    assert.deepEqual(missing(three), ['date']);                        // divergence reported
    assert.deepEqual(missing(four), []);                               // exact match
    assert.deepEqual(missing(extra), []);                              // superset still satisfies
  });

  test('a grammar line missing a token parses as missing it — either surface, both directions', () => {
    const full = 'Enumerated by `<command>` — <N> components — <package>@<version> — <YYYY-MM-DD>.';
    const noVersion = 'Enumerated by `<command>` — <N> components — <YYYY-MM-DD>.';
    const noCommand = 'Enumerated by the design system — <N> components — <package>@<version> — <YYYY-MM-DD>.';

    assert.deepEqual([...parseProvenanceGrammar(full).tokens].sort(),
      [...REQUIRED_PROVENANCE_TOKENS].sort());
    assert.ok(!parseProvenanceGrammar(noVersion).tokens.has(PROVENANCE_TOKEN.VERSION));
    assert.ok(!parseProvenanceGrammar(noCommand).tokens.has(PROVENANCE_TOKEN.COMMAND));
    assert.notEqual(parseProvenanceGrammar(noVersion).line, parseProvenanceGrammar(full).line);
  });
});

describe('#2845 — template structure and researcher duty', () => {
  const topHeadings = (text) => lf(text).split('\n')
    .map((l) => /^##\s+(\S.*?)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].toLowerCase());

  test('the template gains Component Inventory without merging any existing section', () => {
    const headings = topHeadings(template);
    for (const required of [
      'component inventory', 'design system', 'spacing scale', 'typography',
      'color', 'copywriting contract', 'ui considerations', 'registry safety',
    ]) {
      assert.ok(headings.includes(required), `template lost or merged "## ${required}"`);
    }
  });

  test('Component Inventory sits with the design system, above the token sections', () => {
    const headings = topHeadings(template);
    const at = (h) => headings.indexOf(h);
    assert.ok(at('design system') < at('component inventory'));
    assert.ok(at('component inventory') < at('spacing scale'));
  });

  test('the researcher is told to enumerate rather than recall, and to record the line', () => {
    assert.ok(/enumerat/i.test(lf(researcher)), 'researcher must carry an enumeration duty');
    const fromResearcher = parseProvenanceGrammar(researcher);
    assert.ok(fromResearcher, 'researcher must quote the provenance grammar');
    assert.equal(
      fromResearcher.line,
      parseProvenanceGrammar(sectionContaining(template, '## Component Inventory')).line,
      'researcher and template must quote the identical grammar line',
    );
  });
});

describe('#2845 — property: roster parity under formatting noise', () => {
  const LABELS = [
    'Copywriting', 'Visuals', 'Color', 'Typography', 'Spacing',
    'Registry Safety', 'Inventory Provenance', 'Motion', 'Density',
    'Iconography', 'Localization', 'Elevation',
  ];

  // Document-shaped, not writer-seeded: the arbitrary varies the DOCUMENT (heading
  // padding, interleaved unrelated sections, blank-line runs, CRLF) as well as the
  // roster, so the property explores shapes a single renderer would never emit (#2371).
  const rosterArb = fc.integer({ min: 1, max: LABELS.length })
    .map((k) => LABELS.slice(0, k).map((label, i) => ({ n: i + 1, label })));

  const noiseArb = fc.record({
    crlf: fc.boolean(),
    trailingSpaces: fc.boolean(),
    interleave: fc.boolean(),
    decoy: fc.boolean(),
    blankLines: fc.integer({ min: 0, max: 3 }),
  });

  function renderChecker(roster, noise) {
    const pad = noise.trailingSpaces ? '   ' : '';
    const gap = '\n'.repeat(noise.blankLines + 1);
    const parts = [];
    for (const d of roster) {
      parts.push(`## Dimension ${d.n}: ${d.label}${pad}`);
      parts.push('**Question:** does it hold?');
      if (noise.interleave) { parts.push('### Notes'); parts.push('prose'); }
    }
    // A heading-shaped line inside a fence is an EXAMPLE, never a roster entry. The
    // round-trip assertion only holds if the parser skips it, so this decoy is what
    // stops the property from being a writer-seeded tautology: a fence-blind parser
    // reports roster.length + 1 and the property fails.
    if (noise.decoy) {
      parts.push('```');
      parts.push(`## Dimension ${roster.length + 1}: Decoy`);
      parts.push('```');
    }
    const body = parts.join(gap);
    return noise.crlf ? body.replace(/\n/g, '\r\n') : body;
  }

  function renderVerdict(roster, noise) {
    const body = roster.map((d) => `Dimension ${d.n} — ${d.label}: {PASS / FLAG / BLOCK}`).join('\n');
    return noise.crlf ? body.replace(/\n/g, '\r\n') : body;
  }

  test('a rendered roster round-trips, and dropping any one heading always violates', () => {
    fc.assert(
      fc.property(rosterArb, noiseArb, fc.nat(), (roster, noise, pick) => {
        const parsedHeadings = parseDimensionHeadings(renderChecker(roster, noise));
        const parsedVerdict = parseVerdictBlock(renderVerdict(roster, noise));
        assert.deepEqual(parsedHeadings, roster);
        assert.deepEqual(parsedVerdict, roster);
        assert.deepEqual(checkRosterParity({
          canonical: parsedHeadings,
          rosterSurfaces: [{ name: 'verdict', roster: parsedVerdict }],
          countSurfaces: [{ name: 'docs', counts: [roster.length] }],
        }), []);

        // strictly sensitive: remove one dimension from the verdict surface only
        const dropped = parsedVerdict.filter((_, i) => i !== pick % roster.length);
        assert.deepEqual(
          checkRosterParity({
            canonical: parsedHeadings,
            rosterSurfaces: [{ name: 'verdict', roster: dropped }],
          }).map((v) => v.kind),
          ['roster-mismatch'],
        );
      }),
      { seed: 2845, numRuns: 200 },
    );
  });
});
