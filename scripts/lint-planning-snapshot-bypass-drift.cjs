#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the DIAGNOSTIC-RULE raw-`.planning/`-read
 * bypass of the planning snapshot single owner (epic #3180, ADR-3180
 * "Planning Semantic Model Single Owner", §8.1 rule 2).
 *
 * ADR-3180 §8.1 rule 2: a diagnostic rule may see only PARSED values coming
 * off `src/planning-snapshot.cts`, never raw `.planning/` document text —
 * every diagnostic rule is expected to consume the snapshot's already-parsed
 * fields (via the ADR-3180 §7 owner functions: `getMilestoneInfo`,
 * `listMilestonePhaseDirs`, `isPhaseComplete`, `scanPhasePlans`,
 * `stateFieldValue`, etc.), not re-derive its own view of the filesystem with
 * `platformReadSync(`/`readFileSync(`/`readdirSync(`.
 *
 * `cmdValidateHealth` (`src/verify.cts`) is the one diagnostic-rule-shaped
 * function in the repo today that has NOT yet been migrated onto the
 * snapshot — it predates ADR-3180 and still does its own raw reads for
 * roughly thirty W0xx/W1xx diagnostic codes. Migrating it is Phase 11
 * (#3309), not this phase (#3308) — this guard's job is only to make that
 * acknowledged debt VISIBLE and SHRINK-ONLY via a ratchet baseline, exactly
 * like `scripts/lint-planning-prompt-drift.cjs` and
 * `scripts/lint-state-field-drift.cjs` do for their own re-derivations, so it
 * cannot silently grow while Phase 11 is pending.
 *
 * FUNCTION-SCOPED, not whole-file or whole-repo. `DIAGNOSTIC_RULE_FUNCTIONS`
 * (a `Map<repo-relative file, Set<function name>>`) names the exact functions
 * this rule applies to — the semantic inverse of
 * `lint-completion-ratio-drift.cjs`'s `FUNCTION_SCOPED_EXEMPTIONS` (which
 * names functions a rule does NOT apply to), but the identical data shape and
 * lookup pattern. A raw-read primitive anywhere OUTSIDE a registered function
 * — including elsewhere in the very same file — is not this derivation and is
 * never flagged; `src/verify.cts` itself is full of legitimate raw reads
 * outside `cmdValidateHealth` (health-check plumbing, non-diagnostic-rule
 * helpers) that this guard must not see.
 *
 * Line-to-enclosing-function attribution is a TRIMMED copy of
 * `lint-state-field-drift.cjs`'s `buildFunctionInfo` — the same
 * comment/string-stripping tokenizer (`scanCode`) feeding the same
 * brace-depth function-frame stack, producing the same `innermostAt[line] ->
 * function name | null` attribution — with that guard's LADDER WINDOW
 * co-occurrence logic dropped entirely: this guard only ever needs "which
 * function encloses this line", never a multi-line pattern within one
 * function body.
 *
 * RATCHET, not an allowlist — mirrors `lint-planning-prompt-drift.cjs`'s
 * `diffAgainstBaseline`/`writeBaseline`/`dedupeViolationsForBaseline`/
 * `sortEntries` machinery verbatim (baseline path, owner issue, and
 * `derivation` label are the only differences): a violation whose (file,
 * text) pair is already RECORDED in the baseline is KNOWN and never fails; an
 * unrecorded pair is FRESH and fails; a recorded pair that no longer fires is
 * STALE and ALSO fails, forcing `--update` (run by a maintainer, expected to
 * run to completion — zero remaining entries — once #3309 lands) to prune it.
 *
 * Tree-walk / root-confinement / symlink / sanitizer machinery is shared via
 * `scripts/lib/drift-scan.cjs`, exactly like every sibling guard.
 */

const fs = require('node:fs');
const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { sanitizeForReport, scanTree } = driftScan;

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts']);

const BASELINE_REL_PATH = path.join('scripts', 'baselines', 'planning-snapshot-bypass-baseline.json');

// ADR-3180 §8.1 rule 2's acknowledged debt is owned by Phase 11 (#3309, "give
// cmdValidateHealth the snapshot"), NOT the epic (#3180) itself and NOT
// Phase 8 (#3218, the sibling prompt-layer guard's owner issue — a different
// derivation entirely).
const RATCHET_OWNER_ISSUE = '#3309';

// Per ADR-3180 §8.1 rule 2: function-scoped registry of exactly which
// diagnostic-rule-shaped functions this guard applies to. Not a bare file
// allowlist (ADR-3180 Decision 4(a) forbids that) — every other function in
// `src/verify.cts`, and every function in every other file, is scanned like
// normal code and simply never matches because it is not in this Map.
const DIAGNOSTIC_RULE_FUNCTIONS = new Map([[path.join('src', 'verify.cts'), new Set(['cmdValidateHealth'])]]);

// `scanTree` builds its repo-relative path via `path.relative()`, which uses
// NATIVE separators: on Windows that is `src\verify.cts`, while
// `DIAGNOSTIC_RULE_FUNCTIONS` above and the committed baseline both store
// POSIX paths (`src/verify.cts`). Normalized UNCONDITIONALLY — never gated on
// `process.platform` — so the POSIX path is never the only tested case (see
// `lint-planning-prompt-drift.cjs`'s `toPosixRel` for the full rationale;
// applied here at the same single seam: `findSnapshotBypassDrift` is the only
// place a repo-relative path enters this guard's violation objects).
function toPosixRel(relPath) {
  return relPath.replace(/\\/g, '/');
}

// Looks up `DIAGNOSTIC_RULE_FUNCTIONS` by POSIX-normalizing BOTH the incoming
// `relPath` and each registered key before comparing, so a native-separator
// caller (Windows) and a POSIX-separator caller (every other platform, and
// every test in this repo) resolve to the same registered `Set` — see
// `toPosixRel` above.
function lookupRegisteredFunctions(relPath) {
  const posix = toPosixRel(relPath);
  for (const [key, fns] of DIAGNOSTIC_RULE_FUNCTIONS) {
    if (toPosixRel(key) === posix) return fns;
  }
  return null;
}

// A raw `.planning/` filesystem read primitive. ADR-3180 §7 owner functions
// (`getMilestoneInfo`, `listMilestonePhaseDirs`, `isPhaseComplete`,
// `scanPhasePlans`, `stateFieldValue`, ...) never match this — none of their
// names or call shapes contain `platformReadSync(`, `readFileSync(`, or
// `readdirSync(`, so a registered function that has already been migrated
// onto the snapshot correctly stops producing violations without needing any
// separate allowlist of "safe" calls.
const RAW_READ_RE = /platformReadSync\(|readFileSync\(|readdirSync\(/;

// `function NAME(` — top-level or nested, matches the DECLARATION line
// itself (mirrors `lint-state-field-drift.cjs`'s `FUNCTION_DECL_RE`).
const FUNCTION_DECL_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/;

// `const NAME = (...): ReturnType => {` — an arrow function assigned to a
// const, whose own line already carries `=>\s*\{` (mirrors
// `lint-state-field-drift.cjs`'s `ARROW_CONST_RE`).
const ARROW_CONST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{/;

/**
 * Strip line-comments, block comments, and the CONTENTS of string/template
 * literals (excluded from brace-depth counting so a brace inside a string
 * never desyncs `depth`) while keeping quoted text verbatim in `detect` (so
 * declaration/call regexes can still see identifiers that happen to sit
 * inside a template literal's interpolation-free text). Trimmed, unchanged
 * copy of `lint-state-field-drift.cjs`'s `scanCode` — this guard needs the
 * identical comment/string-safety, not a domain-specific variant.
 * Returns `{ detect, braces }`, one string per input line.
 */
function scanCode(lines) {
  const detect = new Array(lines.length);
  const braces = new Array(lines.length);
  let inBlockComment = false;
  let inTemplate = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let outDetect = '';
    let outBraces = '';
    let i = 0;
    if (inTemplate) {
      const start = i;
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === '`') {
          i++;
          inTemplate = false;
          break;
        }
        i++;
      }
      outDetect += line.slice(start, i);
      if (inTemplate) {
        detect[li] = outDetect;
        braces[li] = '';
        continue;
      }
    }
    while (i < line.length) {
      if (inBlockComment) {
        const close = line.indexOf('*/', i);
        if (close === -1) {
          i = line.length;
          break;
        }
        i = close + 2;
        inBlockComment = false;
        continue;
      }
      const ch = line[i];
      if (ch === '/' && line[i + 1] === '/') {
        i = line.length;
        break;
      }
      if (ch === '/' && line[i + 1] === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const quote = ch;
        const start = i;
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === quote) {
            j++;
            break;
          }
          j++;
        }
        outDetect += line.slice(start, j);
        i = j;
        continue;
      }
      if (ch === '`') {
        const start = i;
        let j = i + 1;
        let closed = false;
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === '`') {
            j++;
            closed = true;
            break;
          }
          j++;
        }
        if (!closed) {
          outDetect += line.slice(start);
          inTemplate = true;
          i = line.length;
          break;
        }
        outDetect += line.slice(start, j);
        i = j;
        continue;
      }
      outDetect += ch;
      outBraces += ch;
      i++;
    }
    detect[li] = outDetect;
    braces[li] = outBraces;
  }
  return { detect, braces };
}

/**
 * Trimmed copy of `lint-state-field-drift.cjs`'s `buildFunctionInfo`: a
 * single pass over `lines` maintaining a brace-depth stack of open named
 * function frames, producing `innermostAt[lineIndex] -> function name |
 * null` — which function frame is innermost at each source line. The LADDER
 * WINDOW co-occurrence tracking from the sibling guard is dropped entirely;
 * this guard needs only line-to-enclosing-function attribution.
 */
function buildFunctionInfo(lines) {
  const { detect, braces } = scanCode(lines);
  const innermostAt = new Array(lines.length).fill(null);
  const stack = []; // { name, openDepth }
  let depth = 0;
  let pendingDeclName = null;
  for (let i = 0; i < lines.length; i++) {
    const detectCode = detect[i];
    const braceCode = braces[i];

    let immediateName = null;
    if (detectCode.trim()) {
      const arrowMatch = ARROW_CONST_RE.exec(detectCode);
      if (arrowMatch) {
        immediateName = arrowMatch[1];
      } else {
        const declMatch = FUNCTION_DECL_RE.exec(detectCode);
        if (declMatch) pendingDeclName = declMatch[1];
      }
    }

    const opens = (braceCode.match(/\{/g) || []).length;
    const closes = (braceCode.match(/\}/g) || []).length;
    depth += opens - closes;

    if (immediateName) stack.push({ name: immediateName, openDepth: depth });

    if (pendingDeclName) {
      if (opens > 0) {
        stack.push({ name: pendingDeclName, openDepth: depth });
        pendingDeclName = null;
      } else if (detectCode.includes(';')) {
        pendingDeclName = null;
      }
    }

    while (stack.length > 0 && depth < stack[stack.length - 1].openDepth) stack.pop();

    innermostAt[i] = stack.length > 0 ? stack[stack.length - 1].name : null;
  }
  return { innermostAt };
}

/**
 * Pure: find every raw `.planning/`-read line inside a
 * `DIAGNOSTIC_RULE_FUNCTIONS`-registered function in `text`. `relPath` is the
 * repo-relative path (native separators or POSIX, either is accepted) — used
 * both as the (POSIX-normalized) `file` on every result and to look up the
 * registered function set for this file. A file with no registered entry
 * short-circuits to `[]` immediately, before any line is scanned.
 * Returns [{ file, line, found, text }] — `file` is always POSIX-separated,
 * `text` is the TRIMMED source line, the same value the baseline keys on.
 */
function findSnapshotBypassDrift(text, relPath) {
  const registeredFns = lookupRegisteredFunctions(relPath);
  if (!registeredFns) return [];

  const file = toPosixRel(relPath);
  const lines = text.split('\n');
  const { innermostAt } = buildFunctionInfo(lines);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const fn = innermostAt[i];
    if (!fn || !registeredFns.has(fn)) continue;
    const line = lines[i];
    const match = RAW_READ_RE.exec(line);
    if (!match) continue;
    out.push({ file, line: i + 1, found: match[0], text: line.trim() });
  }
  return out;
}

/**
 * Scan the authored source tree and return every registered-function raw-read
 * bypass, each annotated with the (POSIX-normalized) repo-relative file path.
 */
function scanRepo(root) {
  return scanTree({
    root,
    scanDirs: SCAN_DIRS,
    scanExt: SCAN_EXT,
    onFile(rel, text) {
      return findSnapshotBypassDrift(text, rel);
    },
  });
}

/**
 * Read and parse the ratchet baseline. Returns `{ entries, errors }` —
 * mirrors `lint-planning-prompt-drift.cjs`'s `loadBaseline` verbatim, adapted
 * to this guard's baseline path.
 */
function loadBaseline(root) {
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  if (!fs.existsSync(baselinePath)) {
    return { entries: [], errors: [`${BASELINE_REL_PATH} is missing — run \`node scripts/lint-planning-snapshot-bypass-drift.cjs --update\` to generate it`] };
  }
  const raw = fs.readFileSync(baselinePath, 'utf8');
  if (raw.trim() === '') {
    return { entries: [], errors: [`${BASELINE_REL_PATH} is present but empty`] };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { entries: [], errors: [`${BASELINE_REL_PATH} is not valid JSON: ${err.message}`] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { entries: [], errors: [`${BASELINE_REL_PATH} must be a JSON object, got ${Array.isArray(doc) ? 'array' : typeof doc}`] };
  }
  if (!Array.isArray(doc.entries)) {
    return { entries: [], errors: [`${BASELINE_REL_PATH}: "entries" must be an array, got ${JSON.stringify(doc.entries)}`] };
  }
  const errors = [];
  const entries = [];
  doc.entries.forEach((entry, i) => {
    const where = `${BASELINE_REL_PATH}.entries[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where} must be an object, got ${JSON.stringify(entry)}`);
      return;
    }
    if (typeof entry.file !== 'string' || entry.file === '') {
      errors.push(`${where}.file must be a non-empty string, got ${JSON.stringify(entry.file)}`);
      return;
    }
    if (typeof entry.text !== 'string' || entry.text === '') {
      errors.push(`${where}.text must be a non-empty string, got ${JSON.stringify(entry.text)}`);
      return;
    }
    if (entry.count !== undefined && !(Number.isInteger(entry.count) && entry.count >= 1)) {
      errors.push(`${where}.count must be a positive integer when present, got ${JSON.stringify(entry.count)}`);
      return;
    }
    entries.push(entry);
  });
  return { entries, errors };
}

/**
 * Diff scanned `violations` against baseline `entries`, matched by the pair
 * (`file`, TRIMMED `text`), count-aware — mirrors
 * `lint-planning-prompt-drift.cjs`'s `diffAgainstBaseline` verbatim. See that
 * module's header for the full "COUNT, not duplicate rows" rationale.
 */
function diffAgainstBaseline(violations, baseline) {
  const key = (file, text) => `${file} ${text}`;

  const actualByKey = new Map();
  for (const v of violations) {
    const k = key(v.file, v.text);
    let vs = actualByKey.get(k);
    if (!vs) { vs = []; actualByKey.set(k, vs); }
    vs.push(v);
  }

  const knownKeys = new Set(baseline.map((e) => key(e.file, e.text)));

  const fresh = [];
  const stale = [];

  for (const [k, vs] of actualByKey) {
    if (!knownKeys.has(k)) fresh.push(...vs);
  }

  for (const entry of baseline) {
    const k = key(entry.file, entry.text);
    const expected = entry.count ?? 1;
    const vs = actualByKey.get(k) || [];
    const actual = vs.length;
    if (actual < expected) {
      stale.push({ ...entry, count: expected, actualCount: actual });
    } else if (actual > expected) {
      fresh.push(...vs.slice(expected));
    }
  }

  return { fresh, stale };
}

/** Stable sort: by `file`, then by `text`. */
function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.text !== b.text) return a.text < b.text ? -1 : 1;
    return 0;
  });
}

/**
 * Collapse `violations` into one baseline row per distinct (file, text) pair,
 * carrying a `count` of how many occurrences that pair has in THIS run. Pure;
 * no I/O.
 */
function dedupeViolationsForBaseline(violations) {
  const order = [];
  const byKey = new Map();
  for (const v of violations) {
    const k = `${v.file} ${v.text}`;
    let entry = byKey.get(k);
    if (!entry) {
      entry = { file: v.file, text: v.text, derivation: 'planning-snapshot-bypass', owner_issue: RATCHET_OWNER_ISSUE, count: 0 };
      byKey.set(k, entry);
      order.push(entry);
    }
    entry.count += 1;
  }
  return order;
}

function writeBaseline(root, violations) {
  const entries = sortEntries(dedupeViolationsForBaseline(violations));
  const doc = {
    $comment:
      'ADR-3180 §8.1 rule 2 ratchet, owned by Phase 11 (#3309). See scripts/lint-planning-snapshot-bypass-drift.cjs. '
      + 'SHRINK-ONLY: entries are removed as cmdValidateHealth migrates onto src/planning-snapshot.cts; new or '
      + 'changed entries fail lint:ci. `count` is the number of byte-identical (file, text) occurrences '
      + 'acknowledged at this site — a run producing fewer fails as a partial migration, more fails as an '
      + 'unacknowledged new copy.',
    entries,
  };
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return entries;
}

function main() {
  const root = path.join(__dirname, '..');
  const update = process.argv.includes('--update');
  const violations = scanRepo(root);

  if (update) {
    const entries = writeBaseline(root, violations);
    process.stdout.write(`ok planning-snapshot-bypass: baseline regenerated with ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n`);
    return;
  }

  const { entries: baseline, errors } = loadBaseline(root);
  if (errors.length > 0) {
    process.stderr.write('planning-snapshot-bypass: baseline load error(s):\n');
    for (const e of errors) process.stderr.write(`  ${e}\n`);
    process.exitCode = 1;
    return;
  }

  const { fresh, stale } = diffAgainstBaseline(violations, baseline);

  if (fresh.length === 0 && stale.length === 0) {
    process.stdout.write(`ok planning-snapshot-bypass: no unacknowledged raw .planning/ reads in registered diagnostic-rule functions (${baseline.length} known)\n`);
    return;
  }

  if (fresh.length > 0) {
    process.stderr.write('planning-snapshot-bypass: NEW raw .planning/ read(s) found inside a DIAGNOSTIC_RULE_FUNCTIONS-registered function.\n');
    process.stderr.write('Route the read through src/planning-snapshot.cts (ADR-3180 §7 owner functions: getMilestoneInfo,\n');
    process.stderr.write('listMilestonePhaseDirs, isPhaseComplete, scanPhasePlans, stateFieldValue, ...) instead of calling\n');
    process.stderr.write(`platformReadSync(/readFileSync(/readdirSync( directly, or add an acknowledged entry to ${BASELINE_REL_PATH}\n`);
    process.stderr.write('via --update:\n');
    for (const v of fresh) {
      process.stderr.write(`  ${sanitizeForReport(v.file)}:${v.line}  ${sanitizeForReport(v.found)}  ${sanitizeForReport(v.text)}\n`);
    }
  }

  if (stale.length > 0) {
    process.stderr.write('\nplanning-snapshot-bypass: STALE baseline entr' + (stale.length === 1 ? 'y' : 'ies') + " (fully migrated, or a PARTIAL migration — fewer occurrences found than acknowledged; delete or re-record the row):\n");
    for (const e of stale) {
      process.stderr.write(`  ${sanitizeForReport(e.file)}  ${sanitizeForReport(e.text)}  (found ${e.actualCount}/${e.count} acknowledged occurrence${e.count === 1 ? '' : 's'})\n`);
    }
    process.stderr.write(`\n  remedy: node scripts/lint-planning-snapshot-bypass-drift.cjs --update\n`);
  }

  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findSnapshotBypassDrift,
  scanRepo,
  toPosixRel,
  loadBaseline,
  diffAgainstBaseline,
  writeBaseline,
  dedupeViolationsForBaseline,
  sortEntries,
  buildFunctionInfo,
  DIAGNOSTIC_RULE_FUNCTIONS,
  RAW_READ_RE,
  SCAN_DIRS,
  SCAN_EXT,
  BASELINE_REL_PATH,
  RATCHET_OWNER_ISSUE,
};
