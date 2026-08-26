#!/usr/bin/env node
'use strict';

/**
 * Generates the schema-derived MARKED REGIONS inside `gsd-core/templates/state.md`
 * and the five `docs/{,ja-JP/,zh-CN/,ko-KR/,pt-BR/}reference/state-md.md` pages
 * from `STATE_FIELD_SCHEMA` (`src/state-md-schema.cts`, ADR-3473 §8.8, #3873).
 *
 * WHY THIS EXISTS. Four hand-maintained declarations of "which STATE.md keys
 * exist and what they carry" already disagreed (see `src/state-md-schema.cts`'s
 * own docstring for the `last_activity` case). Two of the SIX places named in
 * `.gsd/phase/feat-3873-state-md-schema/40-design.md`'s table are documents,
 * not code: the shipped template and the reference docs. This generator is
 * their half of the consolidation. `FIELD_CLASSIFICATION` /
 * `FRONTMATTER_BODY_SOURCE` / `FRONTMATTER_KEY_TO_BODY_LABEL` project from the
 * same schema at MODULE LOAD (`src/state-transition.cts`, `src/state.cts`);
 * this script projects at BUILD TIME instead, into committed markdown.
 *
 * GENERATED REGIONS, NOT GENERATED FILES (design doc §4). The five reference
 * pages are hand-translated prose with schema-derived tables and section
 * skeletons embedded in them; a generator that rewrote the whole file would
 * clobber a community translation. So — following `gen-features.cjs`, not
 * `gen-context-index.cjs` (the design's own precedent choice) — this script
 * owns only explicitly MARKED regions inside otherwise hand-authored files,
 * and never touches a byte outside a marker pair.
 *
 * Two regions are declared today:
 *   - `frontmatter`  — the initial YAML frontmatter block in
 *     `gsd-core/templates/state.md`, the block a new project starts from.
 *   - `status-lifecycle` — the `### Status lifecycle (ADR-2207)` section
 *     documenting the `status` field's lifecycle. This is the section
 *     ISSUE #3873's own design doc found missing from all four locale
 *     translations (verified by line/heading count) — the generator emitting
 *     this skeleton is what turns `tests/docs-state-md-locale-parity.test.cjs`
 *     green.
 *
 * A NOTE ON WHAT "SCHEMA-DERIVED" MEANS HERE. `STATE_FIELD_SCHEMA.status.enum`
 * (`STATUS_LIFECYCLE_ENUM`) is the seven-member NORMALIZED status value set
 * `normalizeStateStatus()` computes. The `### Status lifecycle (ADR-2207)`
 * table documents a DIFFERENT, narrower vocabulary — the raw `Status:` body
 * strings `completePhaseCore`/`milestoneCompleteCore` actually write
 * (`Ready to plan`, `All phases complete`, ...) — `src/state-md-schema.cts`'s
 * own docstring is explicit that these are not the same set. This generator
 * therefore does not literally enumerate `schema.status.enum` into the table;
 * it asserts `schema.status.enum` is declared and non-empty (so a future
 * removal of the `status` row's enum fails this generator loudly, keeping the
 * link real) and renders the ADR-2207 table from `STATUS_LIFECYCLE_ROWS`
 * below, which the codebase does not (yet) declare in one place either. This
 * is a section SKELETON, not a full re-derivation, per the design's own
 * scoping: "Parsers are checked, not generated."
 *
 * COLUMN HEADERS ARE PER-LOCALE (design doc §4: "Column headers come from a
 * per-locale string table so a translated table has translated headers").
 * Table BODY content (the four `Ready to plan` / ... rows) is left in English
 * across every locale deliberately: those are literal STATE.md body-field
 * values a project actually writes, not prose to translate, and the
 * "Meaning" column is exactly the kind of hand-translatable prose the design
 * doc says a human still owns — the generator's contract there is only that
 * the SECTION exists (structural, ADR-3873/#3853), never that its prose is
 * translated (design doc "Not-corruption": "A locale is not 'wrong' for
 * having different prose").
 *
 * Usage:
 *   node scripts/gen-state-md-docs.cjs                # print every region to stdout
 *   node scripts/gen-state-md-docs.cjs --write         # rewrite every region in place
 *   node scripts/gen-state-md-docs.cjs --check         # exit 1 if any region is stale
 *   node scripts/gen-state-md-docs.cjs --json          # --check semantics; JSON report
 *   node scripts/gen-state-md-docs.cjs --write --force # write despite violations
 *   node scripts/gen-state-md-docs.cjs ... --root <dir># resolve target files under <dir>
 *                                                       # instead of the repo root (test-only;
 *                                                       # the schema module itself is always
 *                                                       # required from THIS repo's build output)
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_LIB_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'state-md-schema.cjs');

const MARKER_TAG = 'STATE-MD-SCHEMA';

/** Stable reason codes for every violation this gate can emit. */
const REASON = Object.freeze({
  SCHEMA_LIB_MISSING: 'schema_lib_missing',
  LOCALE_STRINGS_MISSING: 'locale_strings_missing',
  MARKERS_MISSING: 'markers_missing',
  MARKER_UNCLOSED: 'marker_unclosed',
  MARKER_ORDER_INVALID: 'marker_order_invalid',
  REGION_STALE: 'region_stale',
  FIELD_REFERENCE_DRIFT: 'field_reference_drift',
  STATUS_VALUES_DRIFT: 'status_values_drift',
});

/**
 * The five reference-doc locales plus the shipped template — each an
 * independent target file, each declaring the ordered list of region names it
 * carries. `en` and the four translations all carry `status-lifecycle`;
 * only the template carries `frontmatter`.
 */
const TARGETS = Object.freeze([
  { key: 'template', relPath: path.join('gsd-core', 'templates', 'state.md'), regions: ['frontmatter'] },
  { key: 'en', relPath: path.join('docs', 'reference', 'state-md.md'), locale: 'en', regions: ['status-lifecycle', 'cardinality'] },
  { key: 'ja-JP', relPath: path.join('docs', 'ja-JP', 'reference', 'state-md.md'), locale: 'ja-JP', regions: ['status-lifecycle', 'cardinality'] },
  { key: 'zh-CN', relPath: path.join('docs', 'zh-CN', 'reference', 'state-md.md'), locale: 'zh-CN', regions: ['status-lifecycle', 'cardinality'] },
  { key: 'ko-KR', relPath: path.join('docs', 'ko-KR', 'reference', 'state-md.md'), locale: 'ko-KR', regions: ['status-lifecycle', 'cardinality'] },
  { key: 'pt-BR', relPath: path.join('docs', 'pt-BR', 'reference', 'state-md.md'), locale: 'pt-BR', regions: ['status-lifecycle', 'cardinality'] },
]);

/** `<!-- STATE-MD-SCHEMA:START:<region> — generated by ...; do not edit by hand -->` */
function startMarker(region) {
  return `<!-- ${MARKER_TAG}:START:${region} — generated by scripts/gen-state-md-docs.cjs from src/state-md-schema.cts; do not edit by hand -->`;
}
/** `<!-- STATE-MD-SCHEMA:END:<region> -->` */
function endMarker(region) {
  return `<!-- ${MARKER_TAG}:END:${region} -->`;
}

// ─── Frontmatter region (gsd-core/templates/state.md) ──────────────────────

/**
 * The subset of `STATE_FIELD_SCHEMA` keys a FRESH project's initial STATE.md
 * frontmatter declares. Validated against the schema at render time — if a
 * future schema change drops one of these keys, rendering throws rather than
 * silently emitting a template field the schema no longer recognizes.
 */
const TEMPLATE_FRONTMATTER_FIELDS = Object.freeze(['gsd_state_version', 'status', 'progress']);

function renderFrontmatterRegion(schema) {
  for (const field of TEMPLATE_FRONTMATTER_FIELDS) {
    if (!(field in schema)) {
      throw new ExitError(
        1,
        `template frontmatter field '${field}' is not declared in STATE_FIELD_SCHEMA (src/state-md-schema.cts) — update TEMPLATE_FRONTMATTER_FIELDS or the schema`,
      );
    }
  }
  // NOTE: this body deliberately opens the SAME ```markdown fence the
  // hand-authored File Template body continues in — it does NOT wrap the
  // frontmatter in its own separate ```yaml fence. `tests/state-transition
  // .test.cjs`'s bug #21 regression guard extracts the entire ```markdown
  // ... ``` block and asserts the extracted text STARTS with '---': a
  // separate preceding fence broke that contract (#3873 fixed-forward). The
  // END marker therefore lands inside the still-open fence, right after the
  // frontmatter's closing '---' and before the hand-authored '# Project
  // State' line — that is intentional, not a rendering bug.
  return [
    '```markdown',
    '---',
    "gsd_state_version: '1.0'  # placeholder; syncStateFrontmatter overwrites on first state.* call",
    'status: planning',
    'progress:',
    '  total_phases: 0',
    '  completed_phases: 0',
    '  total_plans: 0',
    '  completed_plans: 0',
    '  percent: 0',
    '---',
  ].join('\n');
}

// ─── Status-lifecycle region (the five reference docs) ──────────────────────

/** Per-locale heading text and translated column headers (design §4). */
const STATUS_LIFECYCLE_STRINGS = Object.freeze({
  en: { heading: 'Status lifecycle (ADR-2207)', cols: ['Value', 'Written by', 'Meaning'] },
  'ja-JP': { heading: 'ステータスライフサイクル (ADR-2207)', cols: ['値', '書き込み元', '意味'] },
  'zh-CN': { heading: '状态生命周期 (ADR-2207)', cols: ['值', '写入方', '含义'] },
  'ko-KR': { heading: '상태 라이프사이클 (ADR-2207)', cols: ['값', '작성자', '의미'] },
  'pt-BR': { heading: 'Ciclo de vida do status (ADR-2207)', cols: ['Valor', 'Escrito por', 'Significado'] },
});

/** Canonical, deliberately untranslated across locales — see file header note. */
const STATUS_LIFECYCLE_ROWS = Object.freeze([
  ['`Ready to plan`', '`completePhaseCore` (non-last phase)', 'Next phase is ready for planning'],
  ['`All phases complete`', '`completePhaseCore` (last phase)', 'All phases done; milestone awaiting formal close'],
  ['`<version> milestone complete`', '`milestoneCompleteCore`', 'Milestone formally closed and archived'],
  ['`Awaiting next milestone`', '`milestoneCompleteCore`', 'Terminal/archived state'],
]);

const STATUS_LIFECYCLE_INTRO =
  'The `Status` field follows a strict lifecycle across phase and milestone boundaries:';
const STATUS_LIFECYCLE_FOOTNOTE =
  'Phase-completion verbs never write `Milestone complete` (the overloaded bare value was removed in ' +
  '#2204 per ADR-2207 to decouple phase-level writes from milestone termination).';

/**
 * Render the status-lifecycle region for `locale`.
 *
 * `schema.status` lacking a non-empty `enum` is a hard SCHEMA DEFECT (there
 * is nothing coherent to render for any locale) and remains a thrown
 * `ExitError` — unlike the locale-strings case below, `--force` could not
 * meaningfully "override" it, because no fallback content exists.
 *
 * A locale absent from `STATUS_LIFECYCLE_STRINGS`, by contrast, is exactly
 * the forceable-violation shape `gen-features.cjs` established (a corpus gap
 * that still has a renderable fallback): pushed onto `violations` rather
 * than thrown, and rendered using the English strings so `--write --force`
 * can still emit something reviewable while `--check`/`--write` (no force)
 * refuse.
 */
function renderStatusLifecycleRegion(locale, schema, violations) {
  const statusRow = schema.status;
  if (!statusRow || !Array.isArray(statusRow.enum) || statusRow.enum.length === 0) {
    throw new ExitError(
      1,
      "STATE_FIELD_SCHEMA.status must declare a non-empty 'enum' for the status-lifecycle section to be generated",
    );
  }
  let strings = STATUS_LIFECYCLE_STRINGS[locale];
  if (!strings) {
    violations.push({ reason: REASON.LOCALE_STRINGS_MISSING, file: null, region: 'status-lifecycle', locale });
    strings = STATUS_LIFECYCLE_STRINGS.en;
  }
  const [c0, c1, c2] = strings.cols;
  const lines = [
    `### ${strings.heading}`,
    '',
    STATUS_LIFECYCLE_INTRO,
    '',
    `| ${c0} | ${c1} | ${c2} |`,
    '|---|---|---|',
  ];
  for (const [value, writtenBy, meaning] of STATUS_LIFECYCLE_ROWS) {
    lines.push(`| ${value} | ${writtenBy} | ${meaning} |`);
  }
  lines.push('', STATUS_LIFECYCLE_FOOTNOTE);
  return lines.join('\n');
}

// ─── Cardinality region (the five reference docs) ───────────────────────────
//
// ADR-3473 §8.8 names three schema-derived tables: "field reference, status
// values, cardinality". No "### Field cardinality" section existed anywhere
// before this generator — unlike status-lifecycle (which REPLACED an
// existing English section and filled a gap in the four translations), this
// is wholly NEW content, so there is nothing hand-translated to lose by
// generating it. Every row is schema-derived: the field NAME and its
// `cardinality` value ('one' | 'optional' | 'many'), nothing else — no
// prose, so no translation to overwrite.
//
// EXCLUDED_FIELD_TABLE_KEYS: the bare `progress` object row. The existing
// Field-reference table (hand-authored) never lists `progress` itself as its
// own row either — only its five `progress.*` leaves — matching this repo's
// "reporting granularity is the dotted leaf path" convention (ADR-3473 §8.8,
// "Rule — reporting granularity is the dotted leaf path"). The cardinality
// table mirrors that same convention rather than introducing a new one.
const EXCLUDED_FIELD_TABLE_KEYS = Object.freeze(['progress']);

const CARDINALITY_STRINGS = Object.freeze({
  en: { heading: 'Field cardinality', cols: ['Field', 'Cardinality'] },
  'ja-JP': { heading: 'フィールドの多重度', cols: ['フィールド', '多重度'] },
  'zh-CN': { heading: '字段基数', cols: ['字段', '基数'] },
  'ko-KR': { heading: '필드 카디널리티', cols: ['필드', '카디널리티'] },
  'pt-BR': { heading: 'Cardinalidade dos campos', cols: ['Campo', 'Cardinalidade'] },
});

function renderCardinalityRegion(locale, schema) {
  const strings = CARDINALITY_STRINGS[locale];
  if (!strings) {
    throw new ExitError(1, `no localized strings registered in CARDINALITY_STRINGS for locale '${locale}'`);
  }
  const [c0, c1] = strings.cols;
  const lines = [`### ${strings.heading}`, '', `| ${c0} | ${c1} |`, '|---|---|'];
  for (const key of Object.keys(schema)) {
    if (EXCLUDED_FIELD_TABLE_KEYS.includes(key)) continue;
    lines.push(`| \`${key}\` | ${schema[key].cardinality} |`);
  }
  return lines.join('\n');
}

// ─── Field-reference / status-values KEY-SET PARITY (detection, not generation) ──
//
// The Field-reference and Status-values tables carry hand-translated PROSE
// per row (a field's "Purpose"/"When populated" description; a status
// value's "Matched text" description) that the schema does not model at all
// — `StateFieldSchema` has no descriptive-text field, and translating that
// prose into a per-locale static registry inside this generator would mean
// OVERWRITING genuinely hand-translated ja-JP/zh-CN/ko-KR/pt-BR content with
// canonical English text on every `--write`. That is a real content loss,
// not a cosmetic one, and it is the "column the schema does not model"
// case (see the module header and the PR discussion this code answers).
//
// What the schema DOES let us check, losslessly: the ROW SET. A field's
// Purpose/When-populated text can be hand-authored forever; but the fact
// that `last_activity_desc` (declared in STATE_FIELD_SCHEMA) has NO row in
// the English Field-reference table at all is exactly the "unrepresentable
// drift" ADR-3473 §8.8 exists to close, and it is real, live, and pre-dates
// this generator (found while building it; fixed alongside it in this same
// change). This check makes that class of drift DETECTABLE (fails --check)
// without touching a single byte of translated prose.
//
// KNOWN_SCHEMA_GAP_FIELDS: `active_phase`, `next_action`, `next_phases` are
// real STATE.md frontmatter keys (ADR issue #2833), documented in the
// Field-reference table today, but NOT declared in `STATE_FIELD_SCHEMA` —
// they are computed/reported outside the classification/preservation
// dispatch model `FIELD_CLASSIFICATION` projects, and deciding whether they
// belong in that schema at all is a cross-cutting call this generator does
// not make unilaterally (it would ripple into `state-transition.cts` /
// `state.cts`'s pinned projection-parity tests). Grandfathered here, by
// name, so the check is a real ratchet (a FIFTH undeclared field would still
// fail) rather than silently disabled.
const KNOWN_SCHEMA_GAP_FIELDS = Object.freeze(['active_phase', 'next_action', 'next_phases']);

/** Per-locale heading text for the two hand-authored, prose-bearing tables (parity-parsed, never spliced). */
const FIELD_REFERENCE_HEADING = Object.freeze({
  en: 'Field reference',
  'ja-JP': 'フィールドリファレンス',
  'zh-CN': '字段参考',
  'ko-KR': '필드 참조',
  'pt-BR': 'Referência de campos',
});
const STATUS_VALUES_HEADING = Object.freeze({
  en: 'Status values',
  'ja-JP': 'ステータス値',
  'zh-CN': '状态值',
  'ko-KR': '상태 값',
  'pt-BR': 'Valores de status',
});

/**
 * The first column's cell values of the FIRST markdown table immediately
 * following the `### <headingText>` heading in `normalizedText` (LF-normalized).
 * Returns `null` if the heading is not found. Backtick-fenced inline code is
 * stripped (`` `key` `` -> `key`) since every row in both tables opens its
 * first cell that way.
 */
function firstColumnAfterHeading(normalizedText, headingText) {
  const lines = normalizedText.split('\n');
  const headingIdx = lines.findIndex((l) => l === `### ${headingText}`);
  if (headingIdx === -1) return null;
  const values = [];
  let sawHeaderRow = false;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) {
      if (sawHeaderRow) break; // table ended
      continue; // still skipping the heading's intro prose
    }
    const cells = line.split('|');
    const first = (cells[1] ?? '').trim();
    if (/^:?-+:?$/.test(first)) continue; // the `|---|---|` separator row
    if (!sawHeaderRow) {
      sawHeaderRow = true; // this is the `| Header | Header |` row itself
      continue;
    }
    values.push(first.replace(/`/g, ''));
  }
  return values;
}

/**
 * Field-reference / status-values row-set violations for one target, or `[]`
 * when the target has neither table (the template) or the parity holds.
 */
function collectKeySetParityViolations(target, schema, normalizedText) {
  if (!target.locale) return [];
  const found = [];

  const fieldHeading = FIELD_REFERENCE_HEADING[target.locale];
  const docFieldKeys = fieldHeading ? firstColumnAfterHeading(normalizedText, fieldHeading) : null;
  if (docFieldKeys !== null) {
    const schemaKeys = Object.keys(schema).filter((k) => !EXCLUDED_FIELD_TABLE_KEYS.includes(k));
    const docSet = new Set(docFieldKeys);
    const schemaSet = new Set(schemaKeys);
    const missingFromDoc = schemaKeys.filter((k) => !docSet.has(k));
    const undeclaredInSchema = docFieldKeys.filter(
      (k) => !schemaSet.has(k) && !KNOWN_SCHEMA_GAP_FIELDS.includes(k),
    );
    if (missingFromDoc.length > 0 || undeclaredInSchema.length > 0) {
      found.push({
        reason: REASON.FIELD_REFERENCE_DRIFT,
        file: target.relPath,
        region: null,
        missingFromDoc,
        undeclaredInSchema,
      });
    }
  }

  const statusHeading = STATUS_VALUES_HEADING[target.locale];
  const docStatusValues = statusHeading ? firstColumnAfterHeading(normalizedText, statusHeading) : null;
  if (docStatusValues !== null) {
    const enumMembers = schema.status && Array.isArray(schema.status.enum) ? schema.status.enum : [];
    const docSet = new Set(docStatusValues);
    const enumSet = new Set(enumMembers);
    const missingFromDoc = enumMembers.filter((v) => !docSet.has(v));
    const undeclaredInSchema = docStatusValues.filter((v) => !enumSet.has(v));
    if (missingFromDoc.length > 0 || undeclaredInSchema.length > 0) {
      found.push({
        reason: REASON.STATUS_VALUES_DRIFT,
        file: target.relPath,
        region: null,
        missingFromDoc,
        undeclaredInSchema,
      });
    }
  }

  return found;
}

const REGION_RENDERERS = Object.freeze({
  frontmatter: (target, schema, _violations) => renderFrontmatterRegion(schema),
  'status-lifecycle': (target, schema, violations) => renderStatusLifecycleRegion(target.locale, schema, violations),
  cardinality: (target, schema, _violations) => renderCardinalityRegion(target.locale, schema),
});

// ─── Marker splicing ─────────────────────────────────────────────────────────

/**
 * Locate a region's `[start, end)` byte range (over LF-normalized text),
 * INCLUSIVE of both marker lines, in `doc`. Mirrors `gen-features.cjs`'s
 * `spliceIntoFeatures`: the END marker is found via `lastIndexOf` so a forged
 * marker cannot shrink the region it governs.
 *
 * Returns `{ violation }` when the pair is missing, unclosed, or out of
 * order — the caller decides whether that is fatal (splice) or merely
 * reportable (check/json).
 */
function findRegion(doc, file, region) {
  const start = startMarker(region);
  const end = endMarker(region);
  const startIdx = doc.indexOf(start);
  const endIdx = doc.lastIndexOf(end);

  if (startIdx === -1 && endIdx === -1) {
    return { violation: { reason: REASON.MARKERS_MISSING, file, region } };
  }
  if (startIdx === -1 || endIdx === -1) {
    return { violation: { reason: REASON.MARKER_UNCLOSED, file, region } };
  }
  if (endIdx < startIdx) {
    return { violation: { reason: REASON.MARKER_ORDER_INVALID, file, region } };
  }
  return { range: [startIdx, endIdx + end.length] };
}

/** Replace `region`'s marked span in `doc` with `body`, markers included. */
function spliceRegion(doc, region, body) {
  const { range, violation } = findRegion(doc, '<in-memory>', region);
  if (violation) {
    throw new ExitError(
      1,
      `region '${region}' markers are ${violation.reason} — expected:\n  ${startMarker(region)}\n  ${endMarker(region)}\n`,
    );
  }
  const [start, end] = range;
  const replacement = `${startMarker(region)}\n${body}\n${endMarker(region)}`;
  return doc.slice(0, start) + replacement + doc.slice(end);
}

/** `true` if `text`'s line endings are predominantly CRLF. */
function isCrlf(text) {
  return /\r\n/.test(text);
}

// ─── Corpus assembly ─────────────────────────────────────────────────────────

function loadSchema() {
  if (!fs.existsSync(SCHEMA_LIB_PATH)) {
    throw new ExitError(
      1,
      `${SCHEMA_LIB_PATH} does not exist. Run 'npm run build:lib' first (STATE_FIELD_SCHEMA is compiled from src/state-md-schema.cts).`,
    );
  }
  // SCHEMA_LIB_PATH is a fixed, repo-relative constant computed from __dirname — never user input.
  const mod = require(SCHEMA_LIB_PATH);
  return mod.STATE_FIELD_SCHEMA;
}

/**
 * Build every target's rendered regions plus, for a given `filesRoot`, the
 * violations found reading its on-disk file (missing/unclosed markers,
 * staleness). `filesRoot` defaults to the real repo root; tests pass a temp
 * copy so no fixture is ever planted in the real tree.
 */
function buildCorpus(filesRoot) {
  const schema = loadSchema();
  const violations = [];
  const targets = TARGETS.map((target) => {
    const absPath = path.join(filesRoot, target.relPath);
    const regionBodies = {};
    for (const region of target.regions) {
      const renderer = REGION_RENDERERS[region];
      regionBodies[region] = renderer(target, schema, violations);
    }
    return { ...target, absPath, regionBodies };
  });
  return { schema, targets, violations };
}

/** Read `target.absPath`, returning `null` (with a violation appended) on ENOENT. */
function readTarget(target, violations) {
  try {
    return fs.readFileSync(target.absPath, 'utf8');
  } catch {
    violations.push({ reason: REASON.MARKERS_MISSING, file: target.relPath, region: null, detail: 'file unreadable' });
    return null;
  }
}

/** Splice every declared region of `target` into `original`, returning the new text (or throwing). */
function spliceTarget(target, original) {
  const crlf = isCrlf(original);
  let normalized = original.replace(/\r\n/g, '\n');
  for (const region of target.regions) {
    normalized = spliceRegion(normalized, region, target.regionBodies[region]);
  }
  return crlf ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/** Which of `target`'s regions differ between `original` and its spliced form. */
function staleRegionsOf(target, original) {
  const crlf = isCrlf(original);
  const normalizedOriginal = original.replace(/\r\n/g, '\n');
  const stale = [];
  for (const region of target.regions) {
    const { range, violation } = findRegion(normalizedOriginal, target.relPath, region);
    if (violation) continue; // already reported as a hostile violation elsewhere
    const [start, end] = range;
    const currentSpan = normalizedOriginal.slice(start, end);
    const freshSpan = `${startMarker(region)}\n${target.regionBodies[region]}\n${endMarker(region)}`;
    if (currentSpan !== freshSpan) stale.push(region);
  }
  return { stale, crlf };
}

/** Non-throwing per-target-per-region violation scan, for --check/--json. */
function collectTargetViolations(target, original) {
  const found = [];
  if (original === null) return found;
  const normalized = original.replace(/\r\n/g, '\n');
  for (const region of target.regions) {
    const { violation } = findRegion(normalized, target.relPath, region);
    if (violation) {
      found.push({ ...violation, file: target.relPath });
    }
  }
  return found;
}

/** Human one-liner for a violation, keyed off its typed reason. */
function describeViolation(v) {
  switch (v.reason) {
    case REASON.SCHEMA_LIB_MISSING:
      return `${SCHEMA_LIB_PATH} is missing — run 'npm run build:lib'`;
    case REASON.MARKERS_MISSING:
      return `${v.file}: region '${v.region}' markers are entirely absent — expected ${startMarker(v.region)} / ${endMarker(v.region)}`;
    case REASON.MARKER_UNCLOSED:
      return `${v.file}: region '${v.region}' has only one of its START/END markers — malformed or unclosed`;
    case REASON.MARKER_ORDER_INVALID:
      return `${v.file}: region '${v.region}' END marker precedes its START marker`;
    case REASON.REGION_STALE:
      return `${v.file}: region '${v.region}' is stale — run 'node scripts/gen-state-md-docs.cjs --write'`;
    case REASON.LOCALE_STRINGS_MISSING:
      return `no localized strings registered in STATUS_LIFECYCLE_STRINGS for locale '${v.locale}' — falls back to 'en' under --force`;
    case REASON.FIELD_REFERENCE_DRIFT:
      return (
        `${v.file}: Field-reference table row set disagrees with STATE_FIELD_SCHEMA — ` +
        `missing from doc: [${v.missingFromDoc.join(', ')}]; undeclared in schema: [${v.undeclaredInSchema.join(', ')}]`
      );
    case REASON.STATUS_VALUES_DRIFT:
      return (
        `${v.file}: Status-values table row set disagrees with STATE_FIELD_SCHEMA.status.enum — ` +
        `missing from doc: [${v.missingFromDoc.join(', ')}]; undeclared in schema: [${v.undeclaredInSchema.join(', ')}]`
      );
    default:
      return `${v.file}: ${v.reason}`;
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { write: false, check: false, json: false, force: false, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--root') {
      opts.root = argv[++i];
      if (!opts.root) throw new ExitError(1, '--root requires a directory argument');
    } else {
      throw new ExitError(1, `unknown flag: ${arg}\nRecognized flags: --write, --check, --json, --force, --root <dir>.`);
    }
  }
  return opts;
}

function main() {
  const { write, check, json, force, root } = parseArgs(process.argv.slice(2));

  const { schema, targets, violations } = buildCorpus(root);

  // Collect per-target hostile-input violations (missing/malformed markers)
  // up front — these are fatal for --write regardless of --force, because
  // --force overrides a STALE region (a legitimate "write it anyway" ask),
  // never a structurally broken target (there is nothing to splice into).
  const originals = new Map();
  for (const target of targets) {
    const original = readTarget(target, violations);
    originals.set(target.key, original);
    violations.push(...collectTargetViolations(target, original));
    if (original !== null) {
      violations.push(...collectKeySetParityViolations(target, schema, original.replace(/\r\n/g, '\n')));
    }
  }

  const hostileViolations = violations.filter((v) =>
    [REASON.MARKERS_MISSING, REASON.MARKER_UNCLOSED, REASON.MARKER_ORDER_INVALID].includes(v.reason),
  );

  // Staleness (only computable for targets with clean markers), per region.
  const staleTargets = [];
  for (const target of targets) {
    const original = originals.get(target.key);
    if (original === null) continue;
    const hasHostile = hostileViolations.some((v) => v.file === target.relPath);
    if (hasHostile) continue;
    const { stale } = staleRegionsOf(target, original);
    if (stale.length > 0) {
      staleTargets.push(target);
      for (const region of stale) violations.push({ reason: REASON.REGION_STALE, file: target.relPath, region });
    }
  }

  if (json) {
    const ok = violations.length === 0;
    process.stdout.write(
      JSON.stringify({
        ok,
        targetCount: targets.length,
        staleCount: staleTargets.length,
        violations,
      }) + '\n',
    );
    return ok ? 0 : 1;
  }

  if (check) {
    if (violations.length > 0) {
      process.stderr.write(`gen-state-md-docs: ${violations.length} violation(s).\n\n`);
      for (const v of violations) process.stderr.write(`  ✗ ${describeViolation(v)}\n`);
      process.stderr.write('\n');
      throw new ExitError(1);
    }
    process.stdout.write(`All ${targets.length} target(s) are up to date.\n`);
    return 0;
  }

  if (write) {
    // FAIL-CLOSED (gen-features.cjs precedent, design doc §3): a hostile
    // marker violation is ALWAYS fatal — --force overrides staleness, not a
    // structurally broken target with nothing to splice into.
    if (hostileViolations.length > 0) {
      process.stderr.write(`gen-state-md-docs: refusing to write — ${hostileViolations.length} target(s) have broken markers.\n\n`);
      for (const v of hostileViolations) process.stderr.write(`  ✗ ${describeViolation(v)}\n`);
      process.stderr.write('\n');
      throw new ExitError(1);
    }
    const otherViolations = violations.filter((v) => v.reason !== REASON.REGION_STALE && !hostileViolations.includes(v));
    if (otherViolations.length > 0 && !force) {
      process.stderr.write(`gen-state-md-docs: ${otherViolations.length} violation(s). Refusing to write; pass --force to override.\n\n`);
      for (const v of otherViolations) process.stderr.write(`  ✗ ${describeViolation(v)}\n`);
      process.stderr.write('\n');
      throw new ExitError(1);
    }
    let written = 0;
    for (const target of targets) {
      const original = originals.get(target.key);
      if (original === null) continue;
      const hasHostile = hostileViolations.some((v) => v.file === target.relPath);
      if (hasHostile) continue;
      const spliced = spliceTarget(target, original);
      if (spliced !== original) {
        fs.writeFileSync(target.absPath, spliced);
        written++;
      }
    }
    process.stdout.write(`Wrote ${written} of ${targets.length} target(s).\n`);
    return 0;
  }

  // Default: print every region, labeled, to stdout.
  for (const target of targets) {
    for (const region of target.regions) {
      process.stdout.write(`\n=== ${target.relPath} :: ${region} ===\n`);
      process.stdout.write(target.regionBodies[region] + '\n');
    }
  }
  return 0;
}

if (require.main === module) runMain(main);

module.exports = {
  REASON,
  TARGETS,
  MARKER_TAG,
  startMarker,
  endMarker,
  TEMPLATE_FRONTMATTER_FIELDS,
  STATUS_LIFECYCLE_STRINGS,
  STATUS_LIFECYCLE_ROWS,
  CARDINALITY_STRINGS,
  EXCLUDED_FIELD_TABLE_KEYS,
  KNOWN_SCHEMA_GAP_FIELDS,
  FIELD_REFERENCE_HEADING,
  STATUS_VALUES_HEADING,
  renderFrontmatterRegion,
  renderStatusLifecycleRegion,
  renderCardinalityRegion,
  firstColumnAfterHeading,
  collectKeySetParityViolations,
  findRegion,
  spliceRegion,
  spliceTarget,
  staleRegionsOf,
  isCrlf,
  buildCorpus,
  describeViolation,
};
