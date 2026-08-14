#!/usr/bin/env node
'use strict';

/**
 * Generates the `<error_codes>` and `<repair_actions>` tables in
 * `gsd-core/workflows/health.md` from `src/health-diagnostic.cts`'s `RULES`
 * table (Phase 11 follow-up, #3309 "Proposed behavior": "health.md's tables
 * are generated rather than hand-maintained, closing the 16-vs-30+
 * documentation gap structurally").
 *
 * Sources:
 *   - The 31 real rules in the compiled `RULES` array
 *     (`gsd-core/bin/lib/health-diagnostic.cjs`, built from
 *     `src/health-diagnostic.cts` + `src/health-diagnostic-rules/*.cts`),
 *     each carrying a static `description`/`repairable` (see
 *     `src/health-diagnostic-types.cts`'s `Rule` interface).
 *   - `PRECHECK_CODES` below — E001, E010, I010 — the three diagnostics
 *     `cmdValidateHealth` (`src/verify.cts`) emits as pre-checks OUTSIDE the
 *     rule table entirely (ADR-3180 §8.2 rule 4, "no precedence system" —
 *     see `.gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md`,
 *     "Two guards that stay OUTSIDE the rule table entirely"). These will
 *     never appear in `RULES`, so they are a small, static, clearly-labeled
 *     list merged in here instead.
 *   - `REMEDY_ACTION_METADATA` below — the Effect/Risk prose for each of the
 *     6 real repair actions (`REMEDY_ACTION`, excluding `ADVISE`, which never
 *     acts). Static because the compiled module carries no Effect/Risk text
 *     of its own — only the action identifier.
 *
 * Deliberately EXCLUDED from the generated `<error_codes>` table: `W025`
 * (the `workflow.use_worktrees`/`dispatch.isolation` check, #2486). It is a
 * workflow-layer diagnostic emitted directly by this same file's own
 * `run_health_check` step (a bash block in `health.md` itself), never by
 * `cmdValidateHealth`/`RULES` — it has no `Rule` entry and is not one of the
 * three pre-checks above. It stays fully documented in prose at its own step
 * (`<step name="run_health_check">`), which is the authoritative, more
 * detailed source `<error_codes>` used to merely summarize; dropping the
 * redundant table row is not a loss of information, and folding it back in
 * here would require this generator to parse bash, which it does not do.
 * Same reasoning for `I002` (stale Windows task-directory cleanup,
 * `<stale_task_cleanup>` step) — it was never part of the `<error_codes>`
 * tagged region even before this generator existed.
 *
 * Usage:
 *   node scripts/gen-health-docs.cjs              # print both tables to stdout
 *   node scripts/gen-health-docs.cjs --write       # rewrite the tagged regions in health.md
 *   node scripts/gen-health-docs.cjs --check       # exit 1 if either region is stale
 *   node scripts/gen-health-docs.cjs --write --target <path>  # test-only: target a fixture file
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const HEALTH_MD_REL = 'gsd-core/workflows/health.md';
const HEALTH_MD_PATH = path.join(ROOT, HEALTH_MD_REL);
const COMPILED_MODULE_REL = 'gsd-core/bin/lib/health-diagnostic.cjs';
const COMPILED_MODULE_PATH = path.join(ROOT, COMPILED_MODULE_REL);

const ERROR_CODES_START = '<error_codes>';
const ERROR_CODES_END = '</error_codes>';
const REPAIR_ACTIONS_START = '<repair_actions>';
const REPAIR_ACTIONS_END = '</repair_actions>';

/**
 * The 3 pre-check diagnostics `cmdValidateHealth` emits OUTSIDE the rule
 * table (see module header). All three are non-repairable safety rails, not
 * `.planning/` findings a remedy could act on.
 */
const PRECHECK_CODES = [
  {
    code: 'E001',
    severity: 'error',
    description: '.planning/ directory not found',
    repairable: false,
  },
  {
    code: 'E010',
    severity: 'error',
    description: "CWD resolves to the user's home directory — health check would target the wrong .planning/",
    repairable: false,
  },
  {
    code: 'I010',
    severity: 'info',
    description: 'Resolved CWD reported alongside the E010 home-directory guard',
    repairable: false,
  },
];

/**
 * Effect/Risk prose per real `REMEDY_ACTION` (everything except `ADVISE`,
 * which never acts and has no row in `<repair_actions>`). Text for the 5
 * actions the hand-written table already documented is reused VERBATIM;
 * `addAiIntegrationPhaseKey` is new — #3309 itself notes it was "live in
 * code, missing from docs" (mirrors `addNyquistKey`, its structural sibling:
 * same shape, one config key each).
 */
const REMEDY_ACTION_METADATA = new Map([
  ['createConfig', { effect: 'Create config.json with defaults', risk: 'None' }],
  ['resetConfig', { effect: 'Delete + recreate config.json', risk: 'Loses custom settings' }],
  [
    'regenerateState',
    {
      effect: 'Create STATE.md from ROADMAP structure when it is missing',
      risk: 'Loses session history',
    },
  ],
  [
    'addNyquistKey',
    { effect: 'Add workflow.nyquist_validation: true to config.json', risk: 'None — matches existing default' },
  ],
  [
    'addAiIntegrationPhaseKey',
    { effect: 'Add workflow.ai_integration_phase: true to config.json', risk: 'None — matches existing default' },
  ],
  [
    'backfillMilestones',
    {
      effect: 'Synthesize missing MILESTONES.md entries from `.planning/milestones/vX.Y-ROADMAP.md` snapshots',
      risk: 'None — additive only; triggered by `--backfill` flag',
    },
  ],
]);

/** Order the Effect/Risk table renders in — matches `REMEDY_ACTION`'s own declaration order. */
const REMEDY_ACTION_ORDER = [
  'createConfig',
  'resetConfig',
  'regenerateState',
  'addNyquistKey',
  'addAiIntegrationPhaseKey',
  'backfillMilestones',
];

/**
 * Per-code override for the "Repairable" cell's display text, for codes
 * whose remedy is conditional on a flag the plain `Yes`/`No` can't express
 * (mirrors the hand-written table's pre-existing `W018` row: `Yes (--backfill)`).
 */
const REPAIRABLE_DISPLAY_OVERRIDE = new Map([['W018', 'Yes (`--backfill`)']]);

const STATIC_NOT_REPAIRABLE_BULLETS = [
  'PROJECT.md, ROADMAP.md content',
  'Phase directory renaming',
  'Orphaned plan cleanup',
];

const FOOTNOTE_PARAGRAPH =
  'Note: this table is **generated** — do not hand-edit it. It is produced by ' +
  '`node scripts/gen-health-docs.cjs --write` from `src/health-diagnostic.cts`\'s `RULES` table ' +
  '(31 rules as of #3309, each carrying a static `description`/`repairable` on its `Rule` entry — ' +
  'see `src/health-diagnostic-types.cts`) plus the 3 pre-checks that stay outside the rule table by ' +
  'design (`E001`, `E010`, `I010` — safety rails in `cmdValidateHealth`, `src/verify.cts`, never ' +
  '`.planning/` findings). `scripts/lint-health-diagnostic-rule-table.cjs` already enforces the 1:1 ' +
  'code invariant this table depends on (no duplicate codes; severity is always a `Rule` property, ' +
  'never set per emit call) — before assigning a new code, add a `Rule` entry under ' +
  '`src/health-diagnostic-rules/` (its `code` is simply the next free number the lint guard has not ' +
  'yet seen) and run `node scripts/gen-health-docs.cjs --write` to regenerate this table; ' +
  '`npm run lint:generated-sync` fails if it drifts. `W025` (the `workflow.use_worktrees`/' +
  '`dispatch.isolation` check, #2486) is a workflow-layer diagnostic emitted directly by this file\'s ' +
  'own `run_health_check` step, not by `cmdValidateHealth` — it stays documented in that step, not in ' +
  'this generated table.';

/**
 * Load the compiled health-diagnostic module. Throws a clear ExitError (not
 * a raw MODULE_NOT_FOUND) if `npm run build:lib` has not run — mirrors
 * `scripts/lint-health-diagnostic-rule-table.cjs`'s `loadCompiledModule`.
 */
function loadCompiledModule(compiledPath = COMPILED_MODULE_PATH) {
  if (!fs.existsSync(compiledPath)) {
    throw new ExitError(
      2,
      `gen-health-docs: compiled artifact not found at ${COMPILED_MODULE_REL}.\n` +
        'Run `npm run build:lib` first.',
    );
  }
  return require(compiledPath);
}

/**
 * Sort order for the `<error_codes>` table: E-codes, then W-codes
 * numerically, then I-codes — matching the hand-written table's pre-existing
 * order. NOT insertion order from `RULES` (which is grouped by
 * subject-area file, not sorted by code).
 */
const PREFIX_RANK = { E: 0, W: 1, I: 2 };

function parseCode(code) {
  const m = code.match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`gen-health-docs: unparseable diagnostic code "${code}"`);
  return { prefix: m[1], number: Number(m[2]) };
}

function compareCodes(a, b) {
  const pa = parseCode(a.code);
  const pb = parseCode(b.code);
  const rankA = PREFIX_RANK[pa.prefix] ?? 99;
  const rankB = PREFIX_RANK[pb.prefix] ?? 99;
  if (rankA !== rankB) return rankA - rankB;
  return pa.number - pb.number;
}

/**
 * Combine the 31 real rules + the 3 static pre-checks into one sorted row
 * list for the `<error_codes>` table.
 *
 * @param {Array<{code: string, severity: string, description: string, repairable: boolean}>} rules
 */
function buildErrorCodeRows(rules) {
  const seen = new Set();
  const rows = [];
  for (const entry of [...rules, ...PRECHECK_CODES]) {
    if (seen.has(entry.code)) {
      throw new Error(`gen-health-docs: duplicate diagnostic code "${entry.code}" across RULES + PRECHECK_CODES`);
    }
    seen.add(entry.code);
    rows.push(entry);
  }
  rows.sort(compareCodes);
  return rows;
}

/** Escape a cell's markdown-table-hostile characters (mirrors gen-adr-index.cjs's `cellText`). */
function cellText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function repairableCell(row) {
  if (REPAIRABLE_DISPLAY_OVERRIDE.has(row.code)) return REPAIRABLE_DISPLAY_OVERRIDE.get(row.code);
  return row.repairable ? 'Yes' : 'No';
}

function renderErrorCodesRegion(rules) {
  const rows = buildErrorCodeRows(rules);
  const lines = ['', '| Code | Severity | Description | Repairable |', '|------|----------|-------------|------------|'];
  for (const row of rows) {
    lines.push(`| ${row.code} | ${row.severity} | ${cellText(row.description)} | ${repairableCell(row)} |`);
  }
  lines.push('', FOOTNOTE_PARAGRAPH, '');
  return lines.join('\n');
}

function renderRepairActionsRegion() {
  const lines = ['', '| Action | Effect | Risk |', '|--------|--------|------|'];
  for (const action of REMEDY_ACTION_ORDER) {
    const meta = REMEDY_ACTION_METADATA.get(action);
    if (!meta) {
      throw new Error(
        `gen-health-docs: no Effect/Risk metadata registered for repair action "${action}" — add an entry to REMEDY_ACTION_METADATA.`,
      );
    }
    lines.push(`| ${action} | ${meta.effect} | ${meta.risk} |`);
  }
  lines.push('', '**Not repairable (too risky):**');
  for (const bullet of STATIC_NOT_REPAIRABLE_BULLETS) lines.push(`- ${bullet}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Splice `newInner` between `${startTag}`/`${endTag}` inside `text`. Throws
 * if either tag is missing, or if the tags appear more than once (this
 * generator only ever targets the FIRST occurrence pair, and a duplicate
 * tag anywhere in the file would silently corrupt the splice).
 */
function spliceRegion(text, startTag, endTag, newInner) {
  const startIdx = text.indexOf(startTag);
  const endIdx = text.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) {
    throw new ExitError(
      1,
      `gen-health-docs: ${HEALTH_MD_REL} is missing the ${startTag}/${endTag} tags.`,
    );
  }
  if (text.indexOf(startTag, startIdx + 1) !== -1 || text.indexOf(endTag, endIdx + 1) !== -1) {
    throw new ExitError(1, `gen-health-docs: ${HEALTH_MD_REL} has more than one ${startTag}/${endTag} pair.`);
  }
  const before = text.slice(0, startIdx + startTag.length);
  const after = text.slice(endIdx);
  return `${before}${newInner}\n${after}`;
}

/**
 * Regenerate `health.md`'s full text from `rules` (the compiled `RULES`
 * array) and the current on-disk `health.md` content.
 */
function regenerateHealthMd(rules, currentText) {
  let out = spliceRegion(currentText, ERROR_CODES_START, ERROR_CODES_END, renderErrorCodesRegion(rules));
  out = spliceRegion(out, REPAIR_ACTIONS_START, REPAIR_ACTIONS_END, renderRepairActionsRegion());
  return out;
}

/**
 * @param {string[]} argv
 * @returns {{write: boolean, check: boolean, targetPath: string|null}}
 */
function parseArgs(argv) {
  const opts = { write: false, check: false, targetPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--target') {
      const value = argv[i + 1];
      if (value === undefined) throw new ExitError(1, '--target requires a path argument.');
      opts.targetPath = value;
      i++;
    } else {
      throw new ExitError(1, `unknown flag: ${arg}\nRecognized flags: --write, --check, --target <path>.`);
    }
  }
  return opts;
}

function main() {
  const { write, check, targetPath } = parseArgs(process.argv.slice(2));
  const { RULES } = loadCompiledModule();

  // `--target` overrides the real committed health.md path, exclusively for
  // test isolation (mirrors gen-section-manifest.cjs's `--manifest-path`
  // override) — no production caller ever passes it.
  const resolvedPath = targetPath ? path.resolve(targetPath) : HEALTH_MD_PATH;
  const displayPath = targetPath ? targetPath : HEALTH_MD_REL;

  const currentText = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf8') : null;
  if (currentText === null) {
    throw new ExitError(1, `gen-health-docs: ${displayPath} not found.`);
  }

  const expected = regenerateHealthMd(RULES, currentText);

  if (write) {
    fs.writeFileSync(resolvedPath, expected, 'utf8');
    process.stdout.write(
      `Wrote ${displayPath} — ${RULES.length + PRECHECK_CODES.length} error/warning/info code(s), ` +
        `${REMEDY_ACTION_ORDER.length} repair action(s).\n`,
    );
    return 0;
  }

  if (check) {
    if (expected !== currentText) {
      process.stderr.write(
        `${displayPath} is stale — its <error_codes>/<repair_actions> tables do not match ` +
          "src/health-diagnostic.cts's RULES table.\nRun:\n  node scripts/gen-health-docs.cjs --write\n\n",
      );
      throw new ExitError(1);
    }
    process.stdout.write(
      `${displayPath} is up to date (${RULES.length + PRECHECK_CODES.length} codes, ${REMEDY_ACTION_ORDER.length} repair actions).\n`,
    );
    return 0;
  }

  process.stdout.write(renderErrorCodesRegion(RULES) + '\n\n' + renderRepairActionsRegion() + '\n');
  return 0;
}

// Guarded: requiring this module (the test suite imports the pure render
// functions directly) must not also run the generator as a side effect.
if (require.main === module) runMain(main);

module.exports = {
  loadCompiledModule,
  buildErrorCodeRows,
  renderErrorCodesRegion,
  renderRepairActionsRegion,
  regenerateHealthMd,
  spliceRegion,
  compareCodes,
  parseCode,
  PRECHECK_CODES,
  REMEDY_ACTION_METADATA,
  REMEDY_ACTION_ORDER,
  REPAIRABLE_DISPLAY_OVERRIDE,
  HEALTH_MD_PATH,
  COMPILED_MODULE_PATH,
  ERROR_CODES_START,
  ERROR_CODES_END,
  REPAIR_ACTIONS_START,
  REPAIR_ACTIONS_END,
};
