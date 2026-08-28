#!/usr/bin/env node
'use strict';

/**
 * qa-smell-ratchet.cjs — turn a QA-walk "smell" into a decision (#2966).
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `tests/qa/run-report.cjs` computes "smells" — legal-but-questionable engine
 * behavior (see `oracles.cjs`'s `SEVERITY.SMELL`) — and writes them into a
 * gitignored `qa-report.json` that nothing reads. In CI, that means every
 * smell is invisible: a NEW one can appear silently and nobody notices. This
 * script is the pipeline that turns a smell into a decision.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE DESIGN INVARIANT (read this before touching anything below)
 * ══════════════════════════════════════════════════════════════════════════
 *   A smell must NEVER fail a build on its own merits. What fails is an
 *   UNACKNOWLEDGED NEW smell — i.e. the absence of a human decision.
 *   Existing/known smells stay green forever.
 *
 * Concretely, that means:
 *   - A smell whose fingerprint (`tests/qa/smell-fingerprint.cjs`) is already
 *     recorded in `tests/qa/smell-baseline.json` OR in any fragment under
 *     `tests/qa/smell-acks/` is KNOWN and never fails the build, no matter
 *     how many times it fires or how bad it sounds.
 *   - A smell whose fingerprint has never been seen before is NEW, and fails
 *     the build — not because the behavior is wrong (it may be perfectly
 *     fine), but because nobody has looked at it and said so in writing.
 *   - The baseline is SHRINK-ONLY: an entry that stops firing (the engine
 *     was fixed, or the scenario changed) becomes STALE and ALSO fails the
 *     build, forcing `--update` to prune it. A baseline that only ever grows
 *     would let acknowledgments outlive the behavior they describe.
 *   - A VIOLATION (`SEVERITY.VIOLATION` — the engine broke a documented
 *     contract) is a completely different thing and is NEVER acknowledgeable
 *     through this mechanism: it always fails, baseline or no baseline. This
 *     script's whole ratchet apparatus applies to smells alone.
 *   - A scenario EXPECTATION FAILURE (a step's declared `expect` did not
 *     hold — `step.expectFailures`) is, like a VIOLATION, NEVER
 *     acknowledgeable through this ratchet: it has no fingerprint and no
 *     baseline/fragment path, and it always fails the build.
 *
 * WHY A BASELINE FILE *AND* A FRAGMENTS DIRECTORY (not just one)
 * ──────────────────────────────────────────────────────────────
 * This follows the exact idiom `tests/emitted-drift-acks/` and `.changeset/`
 * already use in this repo, for the exact same reason: `smell-baseline.json`
 * is a single shared file every PR that acknowledges a smell would otherwise
 * have to rewrite, guaranteeing merge conflicts between any two such PRs in
 * flight at once. A fragment per PR under `tests/qa/smell-acks/` — uniquely
 * named (its own issue/PR number) — means two PRs can never conflict on this
 * seam. A maintainer periodically folds spent fragments into the committed
 * baseline via `--update` and deletes them (see that directory's README).
 *
 * USAGE
 * ─────
 *   node scripts/qa-smell-ratchet.cjs                  # check (CI entry point)
 *   node scripts/qa-smell-ratchet.cjs --update          # regenerate the baseline
 *   node scripts/qa-smell-ratchet.cjs --json <path>     # also write the full qa-report
 *   node scripts/qa-smell-ratchet.cjs --keep            # preserve scenario temp dirs
 *                                                        # (real repro commands; see
 *                                                        # `report.cjs`'s buildRepro)
 *
 * Exit code 0 only when: zero violations, zero scenario expectation
 * failures, zero NEW smells, zero STALE baseline/fragment entries. Exit
 * code 1 otherwise.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runAllScenarios } = require('../tests/qa/run-report.cjs');
const { buildReport } = require('../tests/qa/report.cjs');
const { fingerprint } = require('../tests/qa/smell-fingerprint.cjs');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BASELINE_REL_PATH = 'tests/qa/smell-baseline.json';
const ACKS_DIR_REL_PATH = 'tests/qa/smell-acks';
const BASELINE_PATH = path.join(REPO_ROOT, ...BASELINE_REL_PATH.split('/'));
const ACKS_DIR = path.join(REPO_ROOT, ...ACKS_DIR_REL_PATH.split('/'));

/** Bump when `smell-baseline.json` / fragment shape changes incompatibly. */
const BASELINE_VERSION = 1;

/**
 * Upper bound on fragment files read in one pass — this cap is this script's own,
 * for its own acknowledgment set (`tests/qa/smell-acks/`), which ADR-3942 does not
 * touch. The emitted-drift ack this cap used to mirror moved to a commit trailer
 * (ADR-3942) and no longer has a fragment-directory cap of its own to mirror.
 * Exceeding it throws rather than silently truncating the listing, which would
 * silently drop acknowledgments from consideration — exactly the class of silent
 * failure this whole seam exists to prevent.
 */
const MAX_ACK_FRAGMENTS = 500;

/**
 * `--update` writes this into a newly-discovered entry's OPTIONAL `reason`
 * field (alongside `issue: null`) as a note-to-self, never as a substitute for
 * `issue` — see the header's "THE DESIGN INVARIANT" and #2966 FIX 3. A plain
 * (non-`--update`) run rejects any entry whose `issue` is not a positive
 * integer regardless of what `reason` says, and additionally rejects a
 * `reason` still carrying this placeholder prefix (see `isPlaceholderReason`),
 * so the baseline can never silently ship with a smell nobody has triaged.
 */
const PLACEHOLDER_REASON_PREFIX = 'TODO(qa-smell-ratchet):';
const PLACEHOLDER_REASON =
  `${PLACEHOLDER_REASON_PREFIX} triage this smell — either file a defect and set "issue" to its number (REAL), ` +
  'or fix the oracle so it stops firing (FALSE POSITIVE). A "reason" alone, with no "issue", is never accepted.';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPlaceholderReason = (reason) => typeof reason === 'string' && reason.startsWith(PLACEHOLDER_REASON_PREFIX);

/**
 * Parse CLI argv into `{ update, jsonOut, keep }`.
 *
 * @param {string[]} argv
 * @returns {{ update: boolean, jsonOut: string|null, keep: boolean }}
 */
function parseArgs(argv) {
  let update = false;
  let jsonOut = null;
  let keep = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update') {
      update = true;
    } else if (arg === '--json') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value === '') {
        throw new ExitError(2, 'qa-smell-ratchet: --json requires a path argument');
      }
      jsonOut = path.resolve(value);
      i += 1;
    } else if (arg === '--keep') {
      keep = true;
    } else {
      throw new ExitError(
        2,
        `qa-smell-ratchet: unrecognized argument "${arg}" (expected --update, --json <path>, and/or --keep)`,
      );
    }
  }
  return { update, jsonOut, keep };
}

/**
 * Validate one baseline/fragment entry, pushing a message per problem onto
 * `errors`. Does not mutate `entry`.
 *
 * Every entry MUST carry the three string fields (`key`, `id`, `scenario`)
 * AND a positive-integer `issue` — the ONLY two terminal states for a smell
 * are REAL (an assigned defect, cited by its issue number) or FALSE POSITIVE
 * (the oracle gets fixed and the entry is never baselined at all); there is
 * no third "accepted with a good explanation" state, so a free-text `reason`
 * can NEVER substitute for `issue` (#2966 FIX 3). `reason` remains an OPTIONAL
 * human note: when present it must be a non-empty, non-placeholder string,
 * but its absence is never itself an error.
 *
 * @param {unknown} entry
 * @param {string} where human-readable location for error messages
 *   (e.g. `"tests/qa/smell-baseline.json.smells[3]"` or a fragment's own
 *   relative path).
 * @param {string[]} errors
 * @returns {boolean} true when `entry` has all required fields, a valid
 *   `issue`, and (if present) a real (non-placeholder) `reason`.
 */
function validateEntryFields(entry, where, errors) {
  if (!isPlainObject(entry)) {
    errors.push(`${where} must be an object, got ${JSON.stringify(entry)}`);
    return false;
  }
  let ok = true;
  for (const field of ['key', 'id', 'scenario']) {
    if (typeof entry[field] !== 'string' || entry[field] === '') {
      errors.push(`${where}.${field} must be a non-empty string, got ${JSON.stringify(entry[field])}`);
      ok = false;
    }
  }
  if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
    errors.push(
      `${where}.issue must be a positive integer, got ${JSON.stringify(entry.issue)} — every acknowledged smell ` +
        'must be REAL (an assigned defect, cited by issue number) or a FALSE POSITIVE (the oracle is fixed, never ' +
        'baselined); a free-text "reason" can never substitute for a tracked issue number',
    );
    ok = false;
  }
  if (entry.reason !== undefined) {
    if (typeof entry.reason !== 'string' || entry.reason === '') {
      errors.push(`${where}.reason, when present, must be a non-empty string, got ${JSON.stringify(entry.reason)}`);
      ok = false;
    } else if (isPlaceholderReason(entry.reason)) {
      errors.push(
        `${where}.reason is still the placeholder ("${entry.reason}") — either remove it or replace it with a `
          + 'real human note; either way, "issue" (not "reason") is what makes this entry valid',
      );
      ok = false;
    }
  }
  return ok;
}

/**
 * Read and validate `tests/qa/smell-baseline.json`.
 *
 * @param {{ allowMissing: boolean }} opts `allowMissing: true` is used only
 *   by `--update`'s bootstrap path — a not-yet-existing baseline is the
 *   expected first-run state there, never an error. In check mode a missing
 *   baseline is always an error (there is nothing to ratchet against).
 * @returns {{ entries: Array<{key:string,id:string,scenario:string,issue:number,reason?:string}>, errors: string[], existed: boolean }}
 */
function readBaseline({ allowMissing }) {
  const existed = fs.existsSync(BASELINE_PATH);
  if (!existed) {
    if (allowMissing) return { entries: [], errors: [], existed };
    return {
      entries: [],
      errors: [`${BASELINE_REL_PATH} is missing — run \`node scripts/qa-smell-ratchet.cjs --update\` to generate it`],
      existed,
    };
  }

  const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
  if (raw.trim() === '') {
    return { entries: [], errors: [`${BASELINE_REL_PATH} is present but empty`], existed };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { entries: [], errors: [`${BASELINE_REL_PATH} is not valid JSON: ${err.message}`], existed };
  }
  const errors = [];
  if (!isPlainObject(doc)) {
    errors.push(`${BASELINE_REL_PATH} must be a JSON object, got ${Array.isArray(doc) ? 'array' : typeof doc}`);
    return { entries: [], errors, existed };
  }
  if (doc.version !== BASELINE_VERSION) {
    errors.push(`${BASELINE_REL_PATH}: unsupported version ${JSON.stringify(doc.version)} (expected ${BASELINE_VERSION})`);
  }
  if (!Array.isArray(doc.smells)) {
    errors.push(`${BASELINE_REL_PATH}: "smells" must be an array, got ${JSON.stringify(doc.smells)}`);
    return { entries: [], errors, existed };
  }

  const entries = [];
  doc.smells.forEach((entry, i) => {
    const where = `${BASELINE_REL_PATH}.smells[${i}]`;
    if (validateEntryFields(entry, where, errors)) entries.push(entry);
  });
  return { entries, errors, existed };
}

/**
 * Fragment filenames under `tests/qa/smell-acks/`, sorted. Absent directory
 * == zero fragments. Throws (naming the dir, cap, and actual count) rather
 * than silently truncating when the cap is exceeded.
 *
 * @returns {string[]}
 */
function listFragmentFiles() {
  if (!fs.existsSync(ACKS_DIR)) return [];
  const names = fs.readdirSync(ACKS_DIR).filter((n) => n.endsWith('.json')).sort();
  if (names.length > MAX_ACK_FRAGMENTS) {
    throw new ExitError(
      1,
      `qa-smell-ratchet: ${ACKS_DIR_REL_PATH} contains ${names.length} ack fragments, exceeding the cap of `
        + `${MAX_ACK_FRAGMENTS}. Refusing to read only some of them — a truncated read would silently drop `
        + 'acknowledgments. Prune spent fragments from this directory.',
    );
  }
  return names;
}

/**
 * Read and validate every fragment under `tests/qa/smell-acks/`. Each
 * fragment is ONE acknowledgment: the same shape as a baseline entry — `key`,
 * `id`, `scenario`, a positive-integer `issue`, and an OPTIONAL `reason` —
 * validated identically via `validateEntryFields` (#2966 FIX 3: there is no
 * separate "acknowledge via PR number" path; every acknowledgment cites the
 * issue tracking the underlying defect).
 *
 * @returns {{ entries: Array<{key:string,id:string,scenario:string,issue:number,reason?:string,_source:string}>, errors: string[] }}
 */
function readAckFragments() {
  const errors = [];
  const entries = [];
  for (const name of listFragmentFiles()) {
    const label = `${ACKS_DIR_REL_PATH}/${name}`;
    const raw = fs.readFileSync(path.join(ACKS_DIR, name), 'utf8');
    if (raw.trim() === '') {
      errors.push(`${label} is present but empty`);
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      errors.push(`${label} is not valid JSON: ${err.message}`);
      continue;
    }
    if (!validateEntryFields(doc, label, errors)) continue;
    entries.push({ ...doc, _source: label });
  }
  return { entries, errors };
}

/**
 * Merge baseline entries and ack fragments into one `key -> entry` map (the
 * full set of KNOWN smells this run is ratcheted against), plus the list of
 * fragments that are now redundant because the baseline already carries
 * their key (an advisory, not a failure — see this file's header on why
 * cross-source duplication is not hard-blocked here).
 *
 * @param {Array<{key:string}>} baselineEntries
 * @param {Array<{key:string,_source:string}>} fragmentEntries
 * @returns {{ byKey: Map<string, object>, redundantFragments: Array<{key:string, source:string}> }}
 */
function mergeKnown(baselineEntries, fragmentEntries) {
  const byKey = new Map();
  for (const e of baselineEntries) byKey.set(e.key, { ...e, source: BASELINE_REL_PATH });

  const redundantFragments = [];
  for (const e of fragmentEntries) {
    if (byKey.has(e.key)) {
      redundantFragments.push({ key: e.key, source: e._source });
      continue;
    }
    byKey.set(e.key, { ...e, source: e._source });
  }
  return { byKey, redundantFragments };
}

/**
 * Walk `reportObject.scenarios[].steps[]` and split every finding into three
 * buckets: `smells` (fingerprinted, ratcheted against the baseline),
 * `violations` (never acknowledgeable — see this file's header), and
 * `expectationFailures` (a step's declared `expect` did not hold; also never
 * acknowledgeable — see this file's header). All three carry the step's
 * `repro` command for later use in failure messages / the GitHub step
 * summary.
 *
 * `expectationFailures` entries deliberately carry NO `key` field and are
 * never passed through `fingerprint()`: unlike a smell, an expectation
 * failure has no baseline/fragment acknowledgment path at all, so giving it
 * a fingerprint would invite exactly the laundering this ratchet exists to
 * prevent (#3597).
 *
 * INVARIANT: `violations.length + expectationFailures.length` must always
 * equal `reportObject.totals.violations` — see `tests/qa/report.cjs`'s
 * `buildReport()`, which computes that total the same way. This is the
 * parity that broke in #3597: this function used to read only
 * `step.violations`, so a scenario whose `expect` failed produced
 * `totals.violations: 1` while this script counted (and printed) 0.
 *
 * @param {ReturnType<import('../tests/qa/report.cjs').buildReport>} reportObject
 * @returns {{
 *   smells: Array<{key:string,id:string,scenario:string,argv:string[],detail:string,at:string,repro:string}>,
 *   violations: Array<{id:string,scenario:string,argv:string[],detail:string,at:string,repro:string}>,
 *   expectationFailures: Array<{scenario:string,argv:string[],detail:string,at:string,repro:string}>,
 * }}
 */
function collectFindings(reportObject) {
  const smells = [];
  const violations = [];
  const expectationFailures = [];
  for (const scenario of reportObject.scenarios) {
    for (const step of scenario.steps) {
      for (const v of step.violations || []) {
        violations.push({
          id: v.id, scenario: scenario.name, argv: step.argv, detail: v.detail, at: step.at, repro: step.repro,
        });
      }
      for (const detail of step.expectFailures || []) {
        expectationFailures.push({
          scenario: scenario.name, argv: step.argv, detail, at: step.at, repro: step.repro,
        });
      }
      for (const smell of step.smells || []) {
        const key = fingerprint(scenario.name, { id: smell.id, subject: smell.subject, argv: step.argv });
        smells.push({
          key,
          id: smell.id,
          scenario: scenario.name,
          argv: step.argv,
          detail: smell.detail,
          at: step.at,
          repro: step.repro,
        });
      }
    }
  }
  return { smells, violations, expectationFailures };
}

/**
 * Lowercase, transliterate, hyphenate, and strip anything that isn't
 * `[a-z0-9-]`, for a fragment-filename skeleton.
 *
 * Routed through the canonical `generateSlugInternal` seam (`src/core-utils.cts`,
 * issue #3987) instead of hand-rolling the same collapse/strip/truncate shape:
 * this local copy trimmed leading/trailing hyphens BEFORE truncating to 60
 * chars, which is the live #2849 bug (`.slice(0, 60)` can land on a separator,
 * re-introducing a trailing hyphen the strip step was meant to prevent), and
 * it never transliterated non-Latin scripts (#2848). `generateSlugInternal`
 * returns `null` for empty/nullish input; a fragment-filename skeleton needs a
 * string, so `?? ''` preserves this function's prior never-null contract.
 *
 * `gsd-core/bin/lib/core-utils.cjs` is required LAZILY, here, rather than at
 * module load — it is `src/core-utils.cts`'s gitignored `build:lib` output,
 * so a top-level `require` made this ENTIRE script (including `--help`, which
 * never calls `slugify`) hard-fail `MODULE_NOT_FOUND` on a fresh clone before
 * any build ran. Deferring the require to the one call site that actually
 * needs it means every other code path (in particular `--help`) still works
 * with `gsd-core/bin/lib/` absent, and a genuinely missing build only surfaces
 * as an error when a NEW smell finding is rendered (the only caller of this
 * function).
 */
function slugify(value) {
  let generateSlugInternal;
  try {
    ({ generateSlugInternal } = require('../gsd-core/bin/lib/core-utils.cjs'));
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw new ExitError(
        1,
        'qa-smell-ratchet: gsd-core/bin/lib/core-utils.cjs is missing — run `npm run build:lib` first.',
      );
    }
    throw err;
  }
  return generateSlugInternal(value, 60) ?? '';
}

/**
 * Render the paste-ready fragment skeleton for one NEW smell finding.
 *
 * @param {{key:string,id:string,scenario:string}} finding
 * @returns {string}
 */
function fragmentSkeleton(finding) {
  const doc = {
    version: 1,
    key: finding.key,
    id: finding.id,
    scenario: finding.scenario,
    issue: '<YOUR ISSUE NUMBER>',
  };
  const suggestedName = `${ACKS_DIR_REL_PATH}/<issue>-${slugify(finding.id)}-${slugify(finding.scenario)}.json`;
  return `${suggestedName}:\n${JSON.stringify(doc, null, 2)}`;
}

/**
 * Flatten one untrusted, scenario-authored string for safe single-line
 * rendering into CI logs and the GitHub step summary.
 *
 * `detail` / `scenario` / `at` values originate in scenario JSON
 * (`expect[].path` reaches `detail` verbatim via `evaluateExpectations`)
 * and are validated only as non-empty strings. Rendered raw into
 * `$GITHUB_STEP_SUMMARY` — which GitHub renders as markdown — a newline
 * plus a forged heading or a fake "0 expectation failures" line lets a
 * red run present a green-looking summary; a backtick breaks out of the
 * code span it is rendered inside; an ANSI escape repaints the CI log.
 *
 * The 300-char truncation is a SEPARATE concern from the neutralization
 * above and is controllable via `maxLen`: every existing caller keeps the
 * default (a long `detail`/`scenario`/`at` value is fine to summarize), but
 * the `repro` field is a copy-pasteable command — truncating it produces a
 * string that *looks* like a complete, runnable command but silently isn't
 * (it dies mid-argv or mid-path), which is worse than no repro at all. Pass
 * `{ maxLen: Infinity }` at those call sites to lift the cap while keeping
 * every other neutralization (newlines/control chars/backticks) intact.
 *
 * @param {unknown} value
 * @param {{maxLen?: number}} [opts]
 * @returns {string}
 */
function flattenUntrusted(value, { maxLen = 300 } = {}) {
  let s = String(value)
    // eslint-disable-next-line no-control-regex -- deliberately stripping C0/C1 control chars (incl. CR/LF/ANSI escapes)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}

/**
 * Build the markdown block appended to `GITHUB_STEP_SUMMARY`, when set —
 * kept intentionally compact (a PR reviewer's first read, not a log dump).
 *
 * @param {{
 *   smells: ReturnType<typeof collectFindings>['smells'],
 *   violations: ReturnType<typeof collectFindings>['violations'],
 *   expectationFailures: ReturnType<typeof collectFindings>['expectationFailures'],
 *   newKeys: string[],
 *   staleEntries: Array<{key:string,id:string,scenario:string,source:string}>,
 *   smellSummary: Array<{id:string,count:number,examples:string[]}>,
 * }} data
 * @returns {string}
 */
function buildStepSummaryMarkdown({ smells, violations, expectationFailures, newKeys, staleEntries, smellSummary }) {
  const lines = [];
  lines.push('## QA smell ratchet');
  lines.push('');
  lines.push(
    `**${smells.length} smells** (${newKeys.length} new, ${staleEntries.length} stale) · `
      + `**${violations.length} violations** · **${expectationFailures.length} expectation failures**`,
  );
  lines.push('');

  if (expectationFailures.length) {
    lines.push('### ❌ Scenario expectation failures');
    lines.push('');
    for (const f of expectationFailures) {
      lines.push(`- \`${flattenUntrusted(f.scenario)}\` at **${flattenUntrusted(f.at)}** — ${flattenUntrusted(f.detail)}`);
    }
    lines.push('');
  }

  if (newKeys.length) {
    lines.push('### 🚨 NEW (unacknowledged) smells');
    lines.push('');
    for (const key of newKeys) {
      const f = smells.find((s) => s.key === key);
      lines.push(`- \`${flattenUntrusted(f.id)}\` in **${flattenUntrusted(f.scenario)}** — ${flattenUntrusted(f.detail)}`);
    }
    lines.push('');
  }

  if (staleEntries.length) {
    lines.push('### Stale baseline/fragment entries (no longer produced)');
    lines.push('');
    for (const e of staleEntries) {
      lines.push(`- \`${flattenUntrusted(e.id)}\` in **${flattenUntrusted(e.scenario)}** (${flattenUntrusted(e.source)})`);
    }
    lines.push('');
  }

  if (smellSummary.length) {
    lines.push('### Smells by oracle');
    lines.push('');
    lines.push('| oracle id | count |');
    lines.push('|---|---|');
    for (const entry of smellSummary) {
      lines.push(`| \`${flattenUntrusted(entry.id)}\` | ${entry.count} |`);
    }
    lines.push('');
  }

  const firstFailingRepro = (violations[0] && violations[0].repro)
    || (expectationFailures[0] && expectationFailures[0].repro)
    || (newKeys.length && smells.find((s) => s.key === newKeys[0]).repro);
  if (firstFailingRepro) {
    lines.push('### Repro (first failing step)');
    lines.push('');
    lines.push('```sh');
    // Backticks are replaced with `'` by flattenUntrusted, so the flattened
    // value can never contain a ``` run that would close this fence early.
    // maxLen: Infinity — a truncated repro looks runnable and isn't, which
    // is worse than no repro at all (see flattenUntrusted's JSDoc).
    lines.push(flattenUntrusted(firstFailingRepro, { maxLen: Infinity }));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  const { update, jsonOut, keep } = parseArgs(process.argv.slice(2));

  const scenarioReports = runAllScenarios({ keep });
  const meta = {
    nodeVersion: process.version,
    platform: process.platform,
    // Only ever used for report METADATA (and, when --json is passed, the
    // written artifact's meta.generatedAt) — never fed into a fingerprint or
    // into smell-baseline.json, which is what keeps this script's fingerprint
    // and baseline output deterministic despite this one real clock read.
    generatedAt: new Date().toISOString(),
  };
  const reportObject = buildReport(scenarioReports, meta);

  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, `${JSON.stringify(reportObject, null, 2)}\n`, 'utf8');
  }

  const { smells, violations, expectationFailures } = collectFindings(reportObject);
  const runKeys = new Set(smells.map((s) => s.key));

  const baseline = readBaseline({ allowMissing: update });
  const fragments = readAckFragments();
  const sourceErrors = [...baseline.errors, ...fragments.errors];

  if (update) {
    if (sourceErrors.length) {
      for (const e of sourceErrors) console.error(`  - ${e}`);
      throw new ExitError(
        1,
        `qa-smell-ratchet --update: ${sourceErrors.length} problem(s) in existing baseline/fragment source(s) `
          + '(printed above) — fix or delete the offending source(s) by hand before regenerating.',
      );
    }

    const { byKey: knownBeforeUpdate } = mergeKnown(baseline.entries, fragments.entries);
    const oldBaselineKeys = new Set(baseline.entries.map((e) => e.key));

    // `--update` NEVER invents an issue number (#2966 FIX 3). A key already
    // carrying a real `issue` (from the committed baseline or a fragment) keeps
    // it, along with its `reason` if any. A genuinely NEW smell — no prior
    // acknowledgment exists — gets `issue: null` and a TODO `reason`; the very
    // next plain (non-`--update`) run REJECTS that entry, forcing a human to
    // triage it as REAL (cite the issue) or FALSE POSITIVE (fix the oracle).
    const newBaselineEntries = [...runKeys].sort().map((key) => {
      const representative = smells.find((s) => s.key === key);
      const carried = knownBeforeUpdate.get(key);
      const hasKnownIssue = !!carried && Number.isInteger(carried.issue) && carried.issue > 0;
      const entry = {
        key,
        id: representative.id,
        scenario: representative.scenario,
        issue: hasKnownIssue ? carried.issue : null,
      };
      if (hasKnownIssue && typeof carried.reason === 'string' && !isPlaceholderReason(carried.reason)) {
        entry.reason = carried.reason;
      } else if (!hasKnownIssue) {
        entry.reason = PLACEHOLDER_REASON;
      }
      return entry;
    });
    const newBaselineKeys = new Set(newBaselineEntries.map((e) => e.key));

    const added = [...newBaselineKeys].filter((k) => !oldBaselineKeys.has(k)).sort();
    const removed = [...oldBaselineKeys].filter((k) => !newBaselineKeys.has(k)).sort();

    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ version: BASELINE_VERSION, smells: newBaselineEntries }, null, 2)}\n`,
      'utf8',
    );

    console.log(
      `qa-smell-ratchet --update: ${oldBaselineKeys.size} -> ${newBaselineKeys.size} baseline entries`
        + (added.length ? ` | added: ${added.length}` : '')
        + (removed.length ? ` | removed: ${removed.length}` : ''),
    );
    for (const key of added) {
      const e = newBaselineEntries.find((x) => x.key === key);
      const placeholderNote = e.issue === null ? ' [issue: null — TODO, needs triage before the next check run]' : '';
      console.log(`  + ${key}${placeholderNote}`);
    }
    for (const key of removed) console.log(`  - ${key}`);

    const redundant = fragments.entries.filter((e) => newBaselineKeys.has(e.key));
    if (redundant.length) {
      console.log(
        `\n${redundant.length} fragment(s) are now redundant — their key is already in the regenerated baseline. `
          + 'Delete them (CONTRIBUTING.md fragment idiom: fold, then delete):',
      );
      for (const e of redundant) console.log(`  - ${e._source}`);
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
      const md = buildStepSummaryMarkdown({
        smells,
        violations,
        expectationFailures,
        newKeys: added,
        staleEntries: removed.map((key) => ({ key, id: '(pruned)', scenario: '(pruned)', source: BASELINE_REL_PATH })),
        smellSummary: reportObject.smellSummary,
      });
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    }

    console.log(
      `\nqa-smell-ratchet: ${smells.length} smells (${added.length} new, ${removed.length} stale), `
        + `${violations.length} violations, ${expectationFailures.length} expectation failures`,
    );

    if (violations.length || expectationFailures.length) {
      if (violations.length) printViolations(violations);
      if (expectationFailures.length) printExpectationFailures(expectationFailures);
      throw new ExitError(
        1,
        'qa-smell-ratchet --update: baseline regenerated, but VIOLATIONS and/or SCENARIO EXPECTATION FAILURES remain '
          + '(neither is ever acknowledgeable — see above)',
      );
    }
    return;
  }

  // ── check mode ──────────────────────────────────────────────────────────
  const { byKey: known, redundantFragments } = mergeKnown(baseline.entries, fragments.entries);
  const newKeys = [...runKeys].filter((k) => !known.has(k)).sort();
  const staleKeys = [...known.keys()].filter((k) => !runKeys.has(k)).sort();
  const staleEntries = staleKeys.map((key) => known.get(key));

  if (sourceErrors.length) {
    console.error(`qa-smell-ratchet: ${sourceErrors.length} problem(s) in baseline/fragment source(s):\n`);
    for (const e of sourceErrors) console.error(`  - ${e}`);
  }

  if (violations.length) {
    printViolations(violations);
  }

  if (expectationFailures.length) {
    printExpectationFailures(expectationFailures);
  }

  if (newKeys.length) {
    console.error(`\nqa-smell-ratchet: ${newKeys.length} NEW (unacknowledged) smell(s):\n`);
    for (const key of newKeys) {
      const f = smells.find((s) => s.key === key);
      console.error(`NEW smell: ${flattenUntrusted(f.key)}`);
      console.error(`  oracle:   ${flattenUntrusted(f.id)}`);
      console.error(`  scenario: ${flattenUntrusted(f.scenario)}`);
      console.error(`  detail:   ${flattenUntrusted(f.detail)}`);
      console.error('  remedy:   exactly two options — no third "accepted with an explanation" state:');
      console.error('              1. fix the detector if this is a FALSE POSITIVE (the oracle is wrong; make it stop firing);');
      console.error('              2. file a defect and add an entry citing its issue number (REAL) — a fragment:\n');
      console.error(`${fragmentSkeleton(f).split('\n').map((l) => `    ${l}`).join('\n')}\n`);
    }
  }

  if (staleKeys.length) {
    console.error(`\nqa-smell-ratchet: ${staleKeys.length} STALE baseline/fragment entr${staleKeys.length === 1 ? 'y' : 'ies'} (no longer produced by the run):\n`);
    for (const e of staleEntries) {
      console.error(`STALE entry: ${flattenUntrusted(e.key)}`);
      console.error(`  source:   ${flattenUntrusted(e.source)}`);
      console.error(`  oracle:   ${flattenUntrusted(e.id)}`);
      console.error(`  scenario: ${flattenUntrusted(e.scenario)}`);
      console.error(`  issue:    ${flattenUntrusted(e.issue)}`);
      if (e.reason !== undefined) console.error(`  reason:   ${flattenUntrusted(e.reason)}`);
    }
    console.error('\n  remedy: node scripts/qa-smell-ratchet.cjs --update');
  }

  if (redundantFragments.length) {
    console.log(
      `\n${redundantFragments.length} fragment(s) are already covered by the baseline and can be deleted:`,
    );
    for (const e of redundantFragments) console.log(`  - ${e.source} (key ${e.key})`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = buildStepSummaryMarkdown({
      smells,
      violations,
      expectationFailures,
      newKeys,
      staleEntries,
      smellSummary: reportObject.smellSummary,
    });
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  }

  console.log(
    `\nqa-smell-ratchet: ${smells.length} smells (${newKeys.length} new, ${staleKeys.length} stale), `
      + `${violations.length} violations, ${expectationFailures.length} expectation failures`,
  );

  if (sourceErrors.length || violations.length || expectationFailures.length || newKeys.length || staleKeys.length) {
    throw new ExitError(1);
  }
}

/**
 * @param {ReturnType<typeof collectFindings>['violations']} violations
 */
function printViolations(violations) {
  console.error(`qa-smell-ratchet: ${violations.length} VIOLATION(s) — never acknowledgeable, always fail:\n`);
  for (const v of violations) {
    console.error(`VIOLATION: ${flattenUntrusted(v.id)}`);
    console.error(`  scenario: ${flattenUntrusted(v.scenario)}`);
    console.error(`  argv:     ${flattenUntrusted(v.argv.join(' '))}`);
    console.error(`  detail:   ${flattenUntrusted(v.detail)}`);
    // maxLen: Infinity — a truncated repro looks runnable and isn't.
    console.error(`  repro:    ${flattenUntrusted(v.repro, { maxLen: Infinity })}`);
  }
}

/**
 * @param {ReturnType<typeof collectFindings>['expectationFailures']} expectationFailures
 */
function printExpectationFailures(expectationFailures) {
  console.error(`qa-smell-ratchet: ${expectationFailures.length} SCENARIO EXPECTATION FAILURE(S) — never acknowledgeable, always fail:\n`);
  for (const f of expectationFailures) {
    console.error('EXPECTATION FAILURE:');
    console.error(`  scenario: ${flattenUntrusted(f.scenario)}`);
    console.error(`  at:       ${flattenUntrusted(f.at)}`);
    console.error(`  argv:     ${flattenUntrusted(f.argv.join(' '))}`);
    console.error(`  detail:   ${flattenUntrusted(f.detail)}`);
    // maxLen: Infinity — a truncated repro looks runnable and isn't.
    console.error(`  repro:    ${flattenUntrusted(f.repro, { maxLen: Infinity })}`);
  }
}

// `require()`ing this module (from `tests/loop-walk.qa.test.cjs`) must not
// trigger a real 20-scenario walk as a side effect — that's what made
// `collectFindings` untestable before #3597. Guard `runMain` so it only
// fires when this file is executed directly (`node scripts/qa-smell-ratchet.cjs`).
if (require.main === module) {
  runMain(main);
}

module.exports = {
  parseArgs,
  readBaseline,
  readAckFragments,
  mergeKnown,
  collectFindings,
  fragmentSkeleton,
  slugify,
  isPlaceholderReason,
  PLACEHOLDER_REASON_PREFIX,
  BASELINE_REL_PATH,
  ACKS_DIR_REL_PATH,
  MAX_ACK_FRAGMENTS,
};
