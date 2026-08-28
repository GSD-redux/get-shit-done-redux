#!/usr/bin/env node
'use strict';

/**
 * gen-exit-code-docs.cjs — ADR-3889 (#3913), the terminal phase of the exit-
 * code-registry epic.
 *
 * Generates docs/reference/exit-codes.md FROM the exit-code declaration
 * (gsd-core/bin/shared/exit-codes.json), so the human-facing reference page
 * can never drift from the actual registered codes — the same allocator-less
 * failure mode this epic exists to close, now closed for the doc surface too.
 * Modelled directly on scripts/gen-capability-matrix.cjs ->
 * docs/reference/capability-matrix.md: same --check/--write/stdout modes,
 * same "generated, do not edit" banner convention, same normalize-then-
 * byte-compare drift check.
 *
 * The declaration JSON is read directly (not the compiled
 * gsd-core/bin/lib/exit-code-registry.cjs artifact, which is gitignored tsc
 * output) so this generator — like scripts/gen-exit-code-registry.cjs itself —
 * works on an unbuilt clone. The "Reserved bands" table below is DERIVED,
 * not retyped: its ranges and allocatable/reserved status come from
 * `classifyBand`/`computeBandRanges`, which are themselves composed
 * entirely from `isAllocatableCode`/`bandFor` in
 * scripts/gen-exit-code-registry.cjs (all four imported below). Only the
 * per-band RATIONALE prose (BAND_PROSE) is hand-authored; widening or
 * narrowing a band in gen-exit-code-registry.cjs changes the ranges this
 * page renders, with no second literal to keep in sync.
 *
 * Usage:
 *   node scripts/gen-exit-code-docs.cjs            # print to stdout
 *   node scripts/gen-exit-code-docs.cjs --write     # write the committed file
 *   node scripts/gen-exit-code-docs.cjs --check     # exit 1 if the committed file is stale
 *   node scripts/gen-exit-code-docs.cjs --declaration <path> --out <path>  # override for tests
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const {
  DEFAULT_DECLARATION_PATH,
  loadDeclaration,
  validateEntries,
  computeBandRanges,
  BANDS,
} = require('./gen-exit-code-registry.cjs');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'reference', 'exit-codes.md');

/**
 * How far above the highest defined band (125, the top of 'domain') to scan
 * when deriving band ranges. Large enough to prove the 'shell-signal'
 * (126+) run is genuinely open-ended (classifyBand is constant well past
 * it), not just an artifact of stopping the scan too early.
 */
const BAND_SCAN_MAX = 500;

/** Hand-authored rationale prose per band category — the only part of the
 * "Reserved bands" table that stays authored; the ranges themselves are
 * derived by computeBandRanges from isAllocatableCode/bandFor. */
const BAND_PROSE = Object.freeze({
  free: '**Free — never allocatable.** `0` is the universal "succeeded" convention and `1` is the universal "failed, no further detail" convention across nearly every CLI ecosystem. Registering either here would collide with that universal meaning instead of adding a distinct, named signal — so the registry leaves both permanently unallocated.',
  'hook-only': 'Reserved exclusively to the Claude Code hook-protocol deny (`HOOK_DENY`) — owned by `hook-adapter` and no other module.',
  'node-reserved': '**Node-reserved.** Node.js itself assigns meaning to this range (e.g. internal JavaScript errors, fatal exceptions, invalid argument errors) before a GSD process ever gets a chance to project its own outcome. Allocating one of these would be indistinguishable from a Node-level failure the process never intended to report.',
  'outside-every-band': 'Outside every allocatable band — not Node-reserved, but also not opened for GSD use. `126`+ additionally collides with the shell convention for "command not executable" / "signal N" (`128+N`), which a process exit code must never impersonate.',
  generic: '**Generic band.** Codes any module may use for caller-facing, non-domain-specific outcomes (bad argv, no input in scope, a missing prerequisite, an internal crash).',
  domain: '**Domain band.** Codes reserved for a specific product surface\'s own vocabulary — currently only `gsd-tools`\' `DEGRADED` (a completed run reporting a condition through its payload rather than as a process failure).',
});

/**
 * The 'shell-signal' category (126+) is folded into the SAME rendered row
 * as 'outside-every-band' (both read "not opened for GSD use" to a reader —
 * the original hand-authored table merged them into one row, and the prose
 * above documents the 126+ collision inline). Every other category gets its
 * own row, in this fixed display order.
 */
const CATEGORY_ROW_ORDER = ['free', 'hook-only', 'node-reserved', 'outside-every-band', 'generic', 'domain'];
const CATEGORY_MERGE_INTO = Object.freeze({ 'shell-signal': 'outside-every-band' });

/**
 * Guard against category-set drift across the three authored lists the
 * "Reserved bands" table depends on: BANDS (gen-exit-code-registry.cjs — the
 * single source of every category classifyBand can ever return),
 * CATEGORY_ROW_ORDER (the rendered row order here), and BAND_PROSE (the
 * hand-authored rationale text per row). Nothing type-checks that these three
 * agree, so adding a BANDS category with no row/prose entry silently drops it
 * from the table, and a row with no prose entry renders the literal string
 * "undefined" — see #3913 P9 review finding (unchecked `BAND_PROSE[category]`
 * lookup) and its root cause: three authored lists, only one of them derived.
 * Throws loudly the first time any of the three sets diverge instead of
 * silently omitting a row or rendering `undefined`.
 */
function assertBandCategoriesConsistent() {
  // Every category classifyBand can ever return: each BANDS entry's own
  // category, plus the synthetic 'outside-every-band' residual classifyBand
  // falls back to for a code no BANDS entry claims (14-63, 79).
  const producedCategories = new Set([...BANDS.map((b) => b.category), 'outside-every-band']);

  // 1. Every produced category must resolve — directly, or via
  //    CATEGORY_MERGE_INTO — to a row this page actually renders. Otherwise
  //    it is silently dropped from the table (the #3913 P9 finding).
  for (const category of producedCategories) {
    const rowCategory = CATEGORY_MERGE_INTO[category] || category;
    if (!CATEGORY_ROW_ORDER.includes(rowCategory)) {
      throw new ExitError(1, `fail_band_category_unaccounted: BANDS category "${category}" resolves to row ` +
        `"${rowCategory}", which is in neither CATEGORY_ROW_ORDER nor a CATEGORY_MERGE_INTO target — add it to ` +
        'one or the other in scripts/gen-exit-code-docs.cjs.');
    }
  }

  // 2. Every rendered row must have hand-authored rationale prose — otherwise
  //    the table cell literally renders the string "undefined".
  for (const category of CATEGORY_ROW_ORDER) {
    if (!(category in BAND_PROSE)) {
      throw new ExitError(1, `fail_band_prose_missing: CATEGORY_ROW_ORDER category "${category}" has no ` +
        'BAND_PROSE entry — it would render the literal string "undefined" in the generated table.');
    }
  }

  // 3. Reverse drift: a CATEGORY_ROW_ORDER or BAND_PROSE entry naming a
  //    category no BANDS entry (nor the 'outside-every-band' residual)
  //    produces is stale prose for a band that no longer exists.
  const resolvedRowCategories = new Set(
    [...producedCategories].map((category) => CATEGORY_MERGE_INTO[category] || category),
  );
  for (const category of CATEGORY_ROW_ORDER) {
    if (!resolvedRowCategories.has(category)) {
      throw new ExitError(1, `fail_band_category_stale: CATEGORY_ROW_ORDER names "${category}", which no BANDS ` +
        'entry (directly, or via CATEGORY_MERGE_INTO) produces — remove it, or fix the drift between BANDS in ' +
        'scripts/gen-exit-code-registry.cjs and CATEGORY_MERGE_INTO here.');
    }
  }
  for (const category of Object.keys(BAND_PROSE)) {
    if (!CATEGORY_ROW_ORDER.includes(category)) {
      throw new ExitError(1, `fail_band_category_stale: BAND_PROSE has an entry for "${category}", which is not ` +
        'in CATEGORY_ROW_ORDER — remove the stale prose, or add the row.');
    }
  }
}

/** Format one contiguous range as a Markdown-table-cell token. */
function formatRange(range) {
  if (range.openEnded) return `\`${range.start}+\``;
  if (range.start === range.end) return `\`${range.start}\``;
  return `\`${range.start}\`–\`${range.end}\``;
}

/**
 * Render the "Reserved bands" table. Ranges come from computeBandRanges
 * (itself derived from isAllocatableCode/bandFor); only BAND_PROSE and the
 * row grouping/order above are authored.
 */
function renderBandTable() {
  assertBandCategoriesConsistent();

  const byCategory = new Map();
  for (const { category, ranges } of computeBandRanges(BAND_SCAN_MAX)) {
    const rowCategory = CATEGORY_MERGE_INTO[category] || category;
    if (!byCategory.has(rowCategory)) byCategory.set(rowCategory, []);
    byCategory.get(rowCategory).push(...ranges);
  }

  const rows = CATEGORY_ROW_ORDER.map((category) => {
    const ranges = byCategory.get(category) || [];
    const label = ranges.map(formatRange).join(', ');
    return `| ${label} | ${BAND_PROSE[category]} |`;
  });

  return ['| Band | Meaning |', '|---|---|', ...rows].join('\n');
}

/** Load + validate the declaration, throwing (loud) on anything malformed — mirrors gen-exit-code-registry.cjs's own gate. */
function loadEntries(declarationPath) {
  const loaded = loadDeclaration(declarationPath);
  if (!loaded.ok) {
    throw new ExitError(1, `${loaded.reason}: ${loaded.message}`);
  }
  const validated = validateEntries(loaded.entries);
  if (!validated.ok) {
    throw new ExitError(1, `${validated.reason}: ${validated.message}`);
  }
  return loaded.entries;
}

function renderRegisteredTable(entries) {
  const rows = [...entries]
    .sort((a, b) => a.code - b.code)
    .map((e) => `| ${e.code} | \`${e.name}\` | ${e.meaning} | \`${e.owner}\` | ${e.authorizedBy} |`);
  return [
    '| code | name | meaning | owning module | authorized by |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function buildDoc(entries) {
  const registeredTable = renderRegisteredTable(entries);
  const registeredCount = entries.length;
  const bandTable = renderBandTable();

  return `# Exit code reference

> **Generated file — do not edit by hand.**
> This page is generated from the exit-code declaration
> (\`gsd-core/bin/shared/exit-codes.json\`) by \`scripts/gen-exit-code-docs.cjs\`
> and kept honest by a drift guard in \`npm run lint:generated-sync\` (which runs
> \`node scripts/gen-exit-code-docs.cjs --check\`). Any manual edit is overwritten
> on the next generation run. To register a new code, add an entry to the
> declaration and run \`node scripts/gen-exit-code-registry.cjs --write && node
> scripts/gen-exit-code-docs.cjs --write\`.

See also: [ADR-3889 — one exit-code registry](../adr/3889-process-exit-contract.md) —
[Adopt the v2 exit contract](../how-to/adopt-the-v2-exit-contract.md) —
[JSON error mode](../json-errors.md)

---

## Registered codes (${registeredCount})

Every process-level exit code \`gsd-tools\`, its hooks, and its scripts may terminate
with, by name, meaning, and the module that owns it.

${registeredTable}

---

## Reserved bands

The registered codes above are not chosen freely — each falls inside one of a
fixed set of allocatable bands (ADR-3889 §1). A code outside these bands can
never be registered; validation rejects it before it reaches the tables above.
This is what makes an unfamiliar number in a CI log actionable: look up its
band first, then its registered name if it has one.

${bandTable}

## The v1/v2 exit contract

ADR-3889 §4 adds a **version projection** on top of this registry, not a second
registry: every registered name above projects to the *same* code under both
contract versions, with one deliberate exception — \`DEGRADED\`. Under the
default, backward-compatible \`v1\` contract, a payload-carried error
(\`output({error})\`) still exits \`0\`, exactly as
[ADR-2980](../adr/2980-payload-carried-error-is-a-degraded-result.md) ratified
for the pre-existing call sites that already depended on that behavior — **64**
call sites across 9 modules per that ADR's own amendment (its original text
said ~60). Under the
opt-in \`v2\` contract, the same outcome exits \`80\` (\`DEGRADED\`) instead, so a
caller that wants to branch on the exit code alone — without parsing stdout —
can opt in without breaking every existing consumer. See
[Adopt the v2 exit contract](../how-to/adopt-the-v2-exit-contract.md) for how to
turn this on, and [JSON error mode](../json-errors.md) for the full fault vs.
degraded-result channel taxonomy this registry sits underneath.
`;
}

/** Normalize CRLF→LF + ensure a single trailing newline, for cross-platform compare. */
function normalize(s) {
  return s.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
}

/**
 * Parse the small flag set this CLI accepts. `--declaration`/`--out` exist
 * only so tests can redirect both the source and the target to a tmpdir
 * without ever touching the real committed declaration or doc page — the
 * same reason scripts/gen-exit-code-registry.cjs and
 * scripts/gen-capability-matrix.cjs's sibling generators take path overrides.
 */
function parseArgs(argv) {
  let mode = null;
  let declarationPath = null;
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check' || arg === '--write') {
      mode = arg.slice(2);
    } else if (arg === '--declaration') {
      declarationPath = argv[++i];
    } else if (arg === '--out') {
      outPath = argv[++i];
    } else {
      throw new ExitError(1, `unrecognized argument: ${arg}`);
    }
  }
  return { mode, declarationPath, outPath };
}

function main() {
  const { mode, declarationPath, outPath } = parseArgs(process.argv.slice(2));
  const docPath = outPath || DOC_PATH;
  const entries = loadEntries(declarationPath || DEFAULT_DECLARATION_PATH);
  const content = buildDoc(entries);

  if (mode === 'check') {
    let committed;
    try {
      committed = fs.readFileSync(docPath, 'utf8');
    } catch {
      throw new ExitError(1, `${path.relative(ROOT, docPath)} is missing. Run:\n  node scripts/gen-exit-code-docs.cjs --write`);
    }
    if (normalize(committed) !== normalize(content)) {
      throw new ExitError(1, `${path.relative(ROOT, docPath)} is stale. Run:\n  node scripts/gen-exit-code-docs.cjs --write`);
    }
    console.log(`${path.relative(ROOT, docPath)} is up to date.`);
    return;
  }
  if (mode === 'write') {
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, content, 'utf8');
    console.log(`Wrote ${path.relative(ROOT, docPath)}`);
    return;
  }
  process.stdout.write(content);
}

if (require.main === module) runMain(main);

module.exports = { buildDoc, loadEntries, DOC_PATH };
