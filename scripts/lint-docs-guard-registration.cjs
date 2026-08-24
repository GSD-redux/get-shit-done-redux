#!/usr/bin/env node
'use strict';

/**
 * lint-docs-guard-registration.cjs — every test file that READS a docs/ path
 * (via a real filesystem read call, not merely a string mention) must either
 * be named in the docs-guard lane registry, or carry an explicit
 * `// docs-guard-exempt: <reason>` marker.
 *
 * Exported pure function `checkDocsGuardRegistration({ testsDir, registry })`
 * so tests can drive it against a synthetic fixture directory; also runnable
 * as a CLI against the real tree (`node scripts/lint-docs-guard-registration.cjs`).
 */

const fs = require('fs');
const path = require('path');
const { assertWithinAllowlist } = require('./lib/allowlist-ratchet.cjs');
const { assertNoSuiteCollision } = require('./docs-guard-registry.cjs');
const {
  DOCS_GUARD_EXEMPT_BASELINE,
  DOCS_GUARD_EXEMPT_DOCS_PATHS,
} = require('./lint-docs-guard-registration.exempt-baseline.cjs');

/**
 * The lint's registry MUST derive from scripts/docs-guard-registry.cjs's
 * `DOCS_GUARD_TESTS` export — not from a second, hand-maintained list.
 * #3753 found exactly that split: this file used to carry its own
 * DOCS_GUARD_REGISTRY literal (20 entries) while the list that actually
 * drives the CI lane only had 10, so the lint reported "registered and
 * fine" for ten guards the lane never ran — the silent gap #3753 exists to
 * close, rebuilt one level down. Two lists holding one shared fact are free
 * to drift; one list read from two places cannot.
 *
 * Returns basenames (test files all live flat under tests/), matching the
 * shape `checkDocsGuardRegistration` expects.
 */
function deriveDocsGuardRegistry() {
  const { DOCS_GUARD_TEST_FILES } = require('./docs-guard-registry.cjs');
  if (!Array.isArray(DOCS_GUARD_TEST_FILES) || DOCS_GUARD_TEST_FILES.length === 0) {
    throw new Error(
      'lint-docs-guard-registration: scripts/docs-guard-registry.cjs exported an empty or ' +
      'missing DOCS_GUARD_TEST_FILES — cannot derive a registry. An empty registry would either flag ' +
      'every docs-reading test as unregistered, or (with an empty comparison set) silently pass ' +
      'with zero coverage. Fix the registry rather than defaulting this to [].',
    );
  }
  // Redundant with docs-guard-registry.cjs's own module-load-time self-check
  // (both consumers of that module — this lint and the docs-required.yml
  // derivation step — must independently reject a suite-token collision per
  // #3753's security follow-up FIX 3), but kept explicit here rather than
  // relying solely on the shared module's require()-time throw: this call
  // makes the guard visible and independently testable from this file's own
  // exports, instead of depending on an implicit side effect of another
  // module's load.
  assertNoSuiteCollision(DOCS_GUARD_TEST_FILES);
  return DOCS_GUARD_TEST_FILES.map(t => path.basename(t));
}

// Real filesystem read calls we treat as "this file reads a path". A docs/
// path appearing only inside a string literal handed to something else
// (e.g. assert.equal(msg, 'see docs/foo.md')) must NOT trip this.
//
// Detector 1 (segment-shaped): `fs.readFileSync(path.join(ROOT, 'docs', 'x.md'))`.
// The docs/ path is built from separate path-segment arguments to a known
// Node fs read function, so it looks for a bare `'docs'` (or `"docs"`/`` `docs` ``)
// segment, or a `'docs/...'` literal, inside the parenthesized argument list
// of one of READ_FN_NAMES.
const READ_FN_NAMES = ['readFileSync', 'readFile', 'readdirSync', 'readdir', 'createReadStream'];
const READ_CALL_RE = new RegExp(
  `\\b(?:${READ_FN_NAMES.join('|')})\\s*\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`,
  'g',
);
const DOCS_QUOTED_PATH_RE = /(['"`])\/?docs\/[^'"`]*\1/;
const DOCS_QUOTED_SEGMENT_RE = /(['"`])docs\1/;

// Detector 2 (single-string-shaped, #3753): `readShipped('docs/how-to/x.md')`.
// Detector 1 is blind to this spelling — the docs/ path is a single string
// literal, not a `path.join('docs', ...)` segment, and it is not always
// handed straight to a bare `fs.read*` call. This is exactly how
// tests/ui-spec-inventory-provenance.test.cjs reads — the guard whose
// unregistered drift broke `next` on dacae9273 and motivated #3753 in the
// first place — so a lint that cannot see its own motivating case's spelling
// is not a fix.
//
// A naive "flag any 'docs/...' string literal" rule produces 59 hits on the
// real tree (most are mention-only, e.g. assert messages), which is enough
// false-positive noise that the lint gets disabled rather than obeyed. This
// heuristic instead requires the docs/ literal to be an argument to a call
// whose CALLEE NAME looks like a reader (contains read/load/parse/shipped/
// content/file/doc, case-insensitively) — e.g. `readShipped`, `readRepoFile`,
// `loadDoc`, `parseContent`. That name-shape restriction is what keeps the
// count at 6 new hits instead of 59, at the cost of also matching a few
// call sites (e.g. `groupFilesBySubrepo('docs/x.md', ...)`) whose name
// happens to contain one of those substrings without actually reading a
// file — those get `// docs-guard-exempt:` markers instead of registration.
//
// Detector 3 (co-occurrence, #3753 correctness follow-up — DEFECT B): the
// two detectors above only catch a docs/ PATH EXPRESSION passed INLINE, as
// an argument, to a call in the same statement. The dominant real idiom in
// this repo builds the path first (`const P = path.join(ROOT, 'docs',
// 'X.md');`) and reads it later (`fs.readFileSync(P);`) — a two-step form
// neither detector above can see, along with template-literal
// (`` `${ROOT}/docs/X.md` ``) and string-concat (`ROOT + '/docs/X.md'`)
// paths. This detector decouples "does the file build a docs/ path" from
// "does the file perform a read call" and flags the file when BOTH are true
// anywhere in it, regardless of whether they share a call site. This trades
// precision for recall deliberately: a false positive costs one
// `// docs-guard-exempt:` marker with a reason; a false negative is the
// #3753 bug shipping again.
//
// A docs/ path EXPRESSION is: a quoted 'docs/...' / "docs/..." literal
// (optionally with a leading slash, for the `ROOT + '/docs/x.md'`
// string-concat form), a backtick template literal containing `docs/`
// anywhere inside it (covers both a bare `` `docs/x.md` `` literal and an
// interpolated `` `${ROOT}/docs/x.md` `` prefix), or a bare `'docs'` segment
// passed as one of the arguments to a `path.join(...)` call anywhere in the
// file (not just when that call is itself an argument to a read function).
const DOCS_TEMPLATE_LITERAL_RE = /`[^`]*\bdocs\/[^`]*`/;
const PATH_JOIN_CALL_RE = /\bpath\s*\.\s*join\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

function pathJoinHasDocsSegment(content) {
  let match;
  PATH_JOIN_CALL_RE.lastIndex = 0;
  while ((match = PATH_JOIN_CALL_RE.exec(content)) !== null) {
    if (DOCS_QUOTED_SEGMENT_RE.test(match[1]) || DOCS_QUOTED_PATH_RE.test(match[1])) return true;
  }
  return false;
}

function hasDocsPathExpression(content) {
  return DOCS_QUOTED_PATH_RE.test(content) ||
    DOCS_TEMPLATE_LITERAL_RE.test(content) ||
    pathJoinHasDocsSegment(content);
}

// A "real read" for the co-occurrence detector: any call to a known Node fs
// read function, ANYWHERE in the file — deliberately not requiring its
// argument to look like a docs/ path here (that pairing is what
// hasDocsPathExpression establishes separately). Does not include
// `existsSync`: a pure existence check with no content read is exactly the
// "incidental" case this lint's exemption path exists for, not a guard.
const READ_CALL_PRESENT_RE = new RegExp(`\\b(?:${READ_FN_NAMES.join('|')})\\s*\\(`);

// Detector 2 (single-string-shaped, #3753): `readShipped('docs/how-to/x.md')`.
// Detector 1 is blind to this spelling — the docs/ path is a single string
// literal, not a `path.join('docs', ...)` segment, and it is not always
// handed straight to a bare `fs.read*` call. This is exactly how
// tests/ui-spec-inventory-provenance.test.cjs reads — the guard whose
// unregistered drift broke `next` on dacae9273 and motivated #3753 in the
// first place — so a lint that cannot see its own motivating case's spelling
// is not a fix.
//
// A naive "flag any 'docs/...' string literal" rule produces 59 hits on the
// real tree (most are mention-only, e.g. assert messages), which is enough
// false-positive noise that the lint gets disabled rather than obeyed. This
// heuristic instead requires the docs/ literal to be an argument to a call
// whose CALLEE NAME looks like a reader (contains read/load/parse/shipped/
// content/file/doc, case-insensitively) — e.g. `readShipped`, `readRepoFile`,
// `loadDoc`, `parseContent`. The callee-name test is applied to the WHOLE
// captured identifier (never requiring a non-keyword prefix before it — see
// DEFECT A, #3753 correctness follow-up: a prior version of this regex wove
// the keyword alternation into the SAME character class as a mandatory
// leading identifier-start character, which made it structurally impossible
// for the keyword to start at index 0 and silently missed every bare `read(`,
// `load(`, `parse(`, `content(`, `file(`, and `doc(` callee — this repo's
// most common reader-helper name among them), at the cost of also matching a
// few call sites (e.g. `groupFilesBySubrepo('docs/x.md', ...)`) whose name
// happens to contain one of those substrings without actually reading a
// file — those get `// docs-guard-exempt:` markers instead of registration.
const READER_NAME_KEYWORDS_RE = /read|load|parse|shipped|content|file|doc/i;
const READER_CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(\s*[^)]{0,60}?["'`]docs\//gi;

function readerNameCallHasDocsPath(content) {
  let match;
  READER_CALL_RE.lastIndex = 0;
  while ((match = READER_CALL_RE.exec(content)) !== null) {
    if (READER_NAME_KEYWORDS_RE.test(match[1])) return true;
  }
  return false;
}

// Neither detector can see every spelling a docs read could take (e.g. a
// path built through an indirect helper with a read-agnostic name whose call
// site never contains a real fs read call in the same file). This registry
// is a curated, best-effort net with known holes, not an exhaustive static
// analysis.
function argsReadDocsPath(args) {
  return DOCS_QUOTED_PATH_RE.test(args) || DOCS_QUOTED_SEGMENT_RE.test(args);
}

function readsDocsPath(content) {
  let match;
  READ_CALL_RE.lastIndex = 0;
  while ((match = READ_CALL_RE.exec(content)) !== null) {
    if (argsReadDocsPath(match[1])) return true;
  }
  if (readerNameCallHasDocsPath(content)) return true;
  return hasDocsPathExpression(content) && READ_CALL_PRESENT_RE.test(content);
}

// Only scan the file's HEADER — the first EXEMPTION_SCAN_LINES lines. Scanning
// the whole file lets a `// docs-guard-exempt:`-shaped string embedded in a
// fixture/template literal (this lint's own test file writes exactly such
// strings to synthesize fixtures) exempt the entire real file it appears in.
// A header marker convention closes that hole while still finding every
// genuine exemption comment, which by convention sits near the top of the
// file next to its module docstring.
const EXEMPTION_SCAN_LINES = 20;

// DEFECT C (#3753 correctness follow-up): a marker is only honored when the
// line it appears on is an actual COMMENT, not merely a line whose text
// contains the marker shape. Probed pre-fix: a string literal like
//   const s = "// docs-guard-exempt: whatever";
// self-exempted the file with zero signal — the header-window narrowing
// (EXEMPTION_SCAN_LINES) constrains WHERE the marker may appear but never
// constrained WHAT KIND of line it must be, so relocating the marker inside
// a string literal anywhere in the header window still worked. Requiring
// the line, after trimming leading whitespace, to actually START with a
// comment token (`//`, `/*`, or a JSDoc-block `*` continuation line) closes
// this without narrowing the legitimate cases: every real marker in this
// repo's tests/ sits at column 0 as a full-line `//` comment (verified
// against every current `docs-guard-exempt:` occurrence in tests/).
const EXEMPTION_LINE_IS_COMMENT_RE = /^(?:\/\/|\/\*|\*)/;

// Security follow-up FIX 4: a marker line inside a multi-line template
// literal in the header window (e.g. `const F = \`\n// docs-guard-exempt: x\n\`;`)
// still exempted the file pre-fix — the line, taken on its own, starts with
// `//` and so passed EXEMPTION_LINE_IS_COMMENT_RE even though it is actually
// backtick-string CONTENT, not a real comment. Track backtick parity across
// lines: a line whose entire span is inside an open template literal (i.e.
// the literal was already open when the line STARTED) is never honored as a
// comment, no matter what its own text looks like.
function findExemption(content) {
  const lines = content.split(/\r?\n/).slice(0, EXEMPTION_SCAN_LINES);
  let inTemplateLiteral = false;
  let inBlockComment = false;
  for (const line of lines) {
    const lineStartedInTemplateLiteral = inTemplateLiteral;
    // Count unescaped backticks on this line to toggle template-literal state.
    const backtickCount = (line.match(/\\`|`/g) || []).filter((tok) => tok === '`').length;
    if (backtickCount % 2 === 1) inTemplateLiteral = !inTemplateLiteral;
    if (lineStartedInTemplateLiteral) continue;

    // Track (real) /* ... */ block-comment state across lines: a line that
    // is genuinely CONTENT inside an open, unterminated block comment is
    // still a real comment (JS syntax), so it stays eligible — this state is
    // tracked only so a future check can distinguish "inside a real block
    // comment" from "inside a template literal" rather than conflating them.
    const opensBlockComment = /\/\*/.test(line);
    const closesBlockComment = /\*\//.test(line);
    if (!inBlockComment && opensBlockComment && !closesBlockComment) {
      inBlockComment = true;
    } else if (inBlockComment && closesBlockComment) {
      inBlockComment = false;
    }

    if (!EXEMPTION_LINE_IS_COMMENT_RE.test(line.trimStart())) continue;
    const m = /\/\/\s*docs-guard-exempt:(.*)$/.exec(line);
    if (m) return { present: true, reason: m[1].trim() };
  }
  return { present: false, reason: '' };
}

/**
 * Security follow-up FIX 3: the exempt ratchet gated on file IDENTITY only —
 * a baselined file that later STARTS genuinely reading shipped docs/ content
 * stayed exempt with zero signal (probed: a baselined file doing
 * `fs.readFileSync('docs/foo.md')` still reported `ok=true, violations=[]`).
 * This extracts every distinct `docs/...` path TOKEN referenced anywhere in
 * an exempted file's content, so the baseline can pin a per-file fingerprint
 * of what it references and fail loudly when that set changes — forcing a
 * human to re-confirm the exemption still holds. Deliberately broader than
 * "only tokens passed to a read call" (this module's readsDocsPath heuristics
 * above): the fingerprint's job is to catch ANY drift in what docs/ paths an
 * exempted file mentions, not just the ones already read-call-shaped, since
 * a mention today can become a read call tomorrow without changing the
 * mention text at all.
 */
const DOCS_PATH_TOKEN_RE = /\/?docs\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]/g;

/**
 * @param {string} content
 * @returns {string[]} sorted, deduped list of docs/ path tokens referenced —
 *   a readable, diffable fingerprint (never an opaque hash) so a reviewer can
 *   see exactly what changed.
 */
function extractDocsPathReferences(content) {
  const set = new Set();
  let m;
  DOCS_PATH_TOKEN_RE.lastIndex = 0;
  while ((m = DOCS_PATH_TOKEN_RE.exec(content)) !== null) {
    set.add(m[0].replace(/^\//, ''));
  }
  return [...set].sort();
}

/**
 * Compare each currently-exempted file's live docs-path fingerprint against
 * its pinned baseline fingerprint. A file present in `current` whose sorted
 * path list differs from the baseline's (paths added OR removed) is a
 * violation: the exemption's premise ("this file doesn't really guard
 * shipped docs content") may no longer hold and a human must re-confirm it.
 *
 * @param {Record<string, string[]>} current - file -> live sorted docs/ path list.
 * @param {Record<string, string[]>} baseline - file -> pinned sorted docs/ path list.
 * @returns {Array<{ file: string, reason: string }>}
 */
function checkExemptFingerprints(current, baseline) {
  const violations = [];
  for (const [file, paths] of Object.entries(current)) {
    const baselinePaths = baseline[file];
    if (!baselinePaths) continue; // identity ratchet (checkExemptBaseline) already flags a novel exemption
    const currentJoined = paths.join('\n');
    const baselineJoined = [...baselinePaths].sort().join('\n');
    if (currentJoined !== baselineJoined) {
      violations.push({
        file,
        reason:
          `the docs paths referenced by ${file} changed; re-confirm the exemption still holds and ` +
          `update the baseline in ${EXEMPT_BASELINE_FILE}:${EXEMPT_BASELINE_DOCS_PATHS_CONST}. ` +
          `was: [${baselinePaths.join(', ') || '(none)'}], now: [${paths.join(', ') || '(none)'}]`,
      });
    }
  }
  return violations;
}

/**
 * File referenced in this module's own remedy messages below (kept as a
 * named constant so the CLI path and the message text cannot drift).
 */
const EXEMPT_BASELINE_FILE = 'scripts/lint-docs-guard-registration.exempt-baseline.cjs';
const EXEMPT_BASELINE_CONST = 'DOCS_GUARD_EXEMPT_BASELINE';
const EXEMPT_BASELINE_DOCS_PATHS_CONST = 'DOCS_GUARD_EXEMPT_DOCS_PATHS';

/**
 * Ratchet the `// docs-guard-exempt:` marker on file identity, mirroring
 * scripts/lint-allow-test-rule-refs.cjs's `allow-test-rule` identity ratchet
 * (scripts/lib/allowlist-ratchet.cjs, ADR-456's pattern): a NEW exemption not
 * already in the pinned baseline fails the lint, and a baseline entry whose
 * file no longer carries a real marker (removed, renamed, or the marker was
 * deleted) is reported STALE and must be pruned — the baseline only ever
 * moves by deliberate edit, never silently grows or goes stale unnoticed.
 *
 * Unlike the sibling gate's generic "do not just add to the allowlist"
 * framing (which fits an offender-tracking allowlist), the correct remedy
 * for a genuinely-warranted new docs-guard exemption really is to add it to
 * the baseline — so the novel-entry case gets its own explicit remedy line
 * here rather than reusing that wording verbatim.
 *
 * @param {string[]} exemptedFiles - basenames with a present, non-empty
 *   `docs-guard-exempt:` marker, found in the current tree.
 * @param {string[]} baseline - the pinned baseline (DOCS_GUARD_EXEMPT_BASELINE).
 * @returns {Array<{ file: string, reason: string }>}
 */
function checkExemptBaseline(exemptedFiles, baseline) {
  const violations = [];
  const { novel } = assertWithinAllowlist({
    label: 'docs-guard-exempt',
    current: exemptedFiles,
    known: baseline,
    fail: (msg) => violations.push({ file: '(docs-guard-exempt baseline)', reason: msg }),
    pruneHint:
      `its file was removed, renamed, or no longer carries a docs-guard-exempt marker — ` +
      `prune it from the baseline in ${EXEMPT_BASELINE_FILE}:${EXEMPT_BASELINE_CONST}`,
  });
  if (novel.length > 0) {
    violations.push({
      file: '(docs-guard-exempt baseline)',
      reason:
        `${novel.length} NEW docs-guard-exempt marker(s) not in the pinned baseline: ` +
        `${novel.join(', ')} — if this exemption is correct, add it to the baseline in ` +
        `${EXEMPT_BASELINE_FILE}:${EXEMPT_BASELINE_CONST}`,
    });
  }
  return violations;
}

/**
 * @param {{ testsDir: string, registry: string[], exemptBaseline?: string[] }} opts
 *   `exemptBaseline`, when provided, ratchets the docs-guard-exempt marker on
 *   file identity against that pinned list (see `checkExemptBaseline`).
 *   Omitted entirely by callers (e.g. isolated fixture-only tests) that do
 *   not want the ratchet applied.
 * @returns {{ ok: boolean, violations: Array<{ file: string, reason: string }>, exemptedFiles: string[] }}
 */
function checkDocsGuardRegistration({ testsDir, registry, exemptBaseline, exemptDocsPathsBaseline }) {
  const violations = [];
  const exemptedFiles = [];
  const exemptedDocsPaths = {};

  for (const entry of registry) {
    const full = path.join(testsDir, entry);
    if (!fs.existsSync(full)) {
      violations.push({ file: entry, reason: `registry entry does not exist on disk: ${full}` });
    }
  }

  const registrySet = new Set(registry);
  let files;
  try {
    files = fs.readdirSync(testsDir).filter(f => f.endsWith('.test.cjs'));
  } catch (err) {
    // A guard that cannot read its own input must never report success.
    // Probed pre-fix: checkDocsGuardRegistration({testsDir:'/nonexistent',
    // registry:[]}) returned {ok:true, violations:[]} — a green check that
    // guarded nothing. Treat an unreadable testsDir as a HARD VIOLATION.
    return {
      ok: false,
      violations: [
        {
          file: '(testsDir)',
          reason: `cannot read testsDir ${testsDir}: ${err.message} — a docs-guard registration ` +
            'lint that cannot read its own input must fail, never silently report zero violations',
        },
      ],
      exemptedFiles: [],
    };
  }

  for (const file of files) {
    const full = path.join(testsDir, file);
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch (err) {
      // Same class: a directory or broken symlink named `*.test.cjs` (or any
      // other read failure) must be a hard violation, not a silent skip.
      violations.push({
        file,
        reason: `cannot read candidate test file ${full}: ${err.message} — an unreadable ` +
          'docs-guard candidate must fail the lint, not be silently skipped',
      });
      continue;
    }

    const exemption = findExemption(content);
    if (exemption.present) {
      if (exemption.reason.length === 0) {
        violations.push({ file, reason: 'docs-guard-exempt marker present with no reason' });
      } else {
        exemptedFiles.push(file);
        exemptedDocsPaths[file] = extractDocsPathReferences(content);
      }
      continue;
    }

    if (readsDocsPath(content) && !registrySet.has(file)) {
      violations.push({
        file,
        reason: 'reads a docs/ path but is not registered in the docs-guard lane and carries no docs-guard-exempt marker',
      });
    }
  }

  if (exemptBaseline) {
    violations.push(...checkExemptBaseline(exemptedFiles, exemptBaseline));
  }

  if (exemptDocsPathsBaseline) {
    violations.push(...checkExemptFingerprints(exemptedDocsPaths, exemptDocsPathsBaseline));
  }

  return { ok: violations.length === 0, violations, exemptedFiles, exemptedDocsPaths };
}

module.exports = {
  checkDocsGuardRegistration,
  checkExemptBaseline,
  checkExemptFingerprints,
  extractDocsPathReferences,
  deriveDocsGuardRegistry,
  EXEMPT_BASELINE_FILE,
  EXEMPT_BASELINE_CONST,
  EXEMPT_BASELINE_DOCS_PATHS_CONST,
};

if (require.main === module) {
  const ROOT = path.join(__dirname, '..');
  const result = checkDocsGuardRegistration({
    testsDir: path.join(ROOT, 'tests'),
    registry: deriveDocsGuardRegistry(),
    exemptBaseline: DOCS_GUARD_EXEMPT_BASELINE,
    exemptDocsPathsBaseline: DOCS_GUARD_EXEMPT_DOCS_PATHS,
  });
  if (!result.ok) {
    process.stderr.write(`lint-docs-guard-registration: ${result.violations.length} violation(s)\n`);
    for (const v of result.violations) {
      process.stderr.write(`  ${v.file}: ${v.reason}\n`);
    }
    process.exitCode = 1;
  } else {
    console.log('ok lint-docs-guard-registration: 0 violations');
  }
}
