#!/usr/bin/env node
/**
 * lint-response-language-coverage.cjs
 *
 * Enforces #2529: every workflow must be covered by the response-language
 * contract, so a workflow can never ship English-only when the user has
 * configured `response_language`.
 *
 * A workflow file passes when it contains EITHER:
 *   - a reference to the shared directive
 *     (`references/response-language-directive.md`), OR
 *   - its own inline `response_language` directive (the ~half of the catalog
 *     that already carried one before #2529, plus workflow-specific extracts
 *     like `references/execute-phase-response-language.md`).
 *
 * A bare config-field mention is not coverage: the same line must direct how
 * user-facing output is rendered, or the workflow must load a known directive.
 *
 * Nor is a directive that names only the question/answer surface. #2529's stated
 * defect is that inter-tool NARRATION stays in English while the answers around
 * it are translated, so a line saying "all user-facing questions, prompts, and
 * explanations" describes the gap rather than closing it. Coverage therefore
 * requires a narration-class token as well — see `NARRATION_CLASS_RE`.
 *
 * A workflow FRAGMENT (`<workflow>/<modes|steps|templates>/<name>.md`, the shape
 * the #1671 fragment epic extracts) additionally passes when its parent workflow
 * names that exact fragment path and is itself covered — see
 * `inheritsParentCoverage`, which proves the inheritance per file instead of
 * granting it to a directory.
 *
 * Exit 0 only when workflows were actually found AND every one of them is
 * covered; exit 1 with a per-file listing if not. "No violations" alone is not
 * a pass: a run that inspected nothing has established nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
// A reference resolves as a sibling of the workflow catalog, so a fixture tree
// and the real one resolve by one rule.
const REFERENCE_ROOT = path.join(ROOT, 'gsd-core');
const DIRECTIVE_REFS = [
  'references/response-language-directive.md',
  'references/execute-phase-response-language.md',
];
// Names the narration class explicitly for the same reason the inline directives
// in the workflow bodies do (see NARRATION_CLASS_RE): "user-facing prose" alone
// reads, in practice, as the question/answer surface, which is the half of the
// output #2529 was never about.
const INLINE_RESPONSE_LANGUAGE_DIRECTIVE =
  'Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.';
// These lazy-loaded modes/steps/templates cannot rely on an eager @-reference.
// Pin their shared wording (plus settings-advanced's former bare field mention)
// so a partial typo or rewording cannot silently split the contract.
const EXACT_INLINE_DIRECTIVE_WORKFLOWS = new Set([
  'discuss-phase/modes/advisor.md',
  'discuss-phase/modes/all.md',
  'discuss-phase/modes/analyze.md',
  'discuss-phase/modes/auto.md',
  'discuss-phase/modes/batch.md',
  'discuss-phase/modes/chain.md',
  'discuss-phase/modes/default.md',
  'discuss-phase/modes/power.md',
  'discuss-phase/modes/text.md',
  'discuss-phase/templates/context.md',
  'discuss-phase/templates/discussion-log.md',
  'execute-phase/steps/codebase-drift-gate.md',
  'execute-phase/steps/executor-isolation-dispatch.md',
  'execute-phase/steps/per-plan-worktree-gate.md',
  'execute-phase/steps/post-merge-gate.md',
  'execute-phase/steps/gap-closure-artifacts.md',
  'execute-phase/steps/partial-wave.md',
  'execute-phase/steps/regression-gate.md',
  'execute-phase/steps/regression-gate-run.md',
  'execute-phase/steps/worktree-recovery-policy.md',
  'help/modes/brief.md',
  'help/modes/default.md',
  'help/modes/full.md',
  'help/modes/topic.md',
  'plan-phase/steps/adr-ingest-express-path.md',
  'plan-phase/steps/chunked-planning-mode.md',
  'plan-phase/steps/closed-phase-gate.md',
  'plan-phase/steps/prd-express-gate.md',
  'plan-phase/steps/research-only-early-exit.md',
  'plan-phase/steps/research-only-modifiers.md',
  'plan-phase/steps/reviews-prerequisite.md',
  'plan-phase/steps/stall-detection-helpers.md',
  'plan-phase/steps/prd-express-path.md',
  'plan-phase/steps/windows-troubleshooting.md',
  'settings-advanced.md',
]);
// This lint once carried a third coverage form, for `verify-phase.md`: a
// workflow file nothing entered directly, covered instead by the directive
// execute-phase.md injects into its `gsd-verifier` dispatch prompt. `next`
// deleted that workflow in #3421 (an orphan that shipped ~40 KB to every runtime
// and was never loaded) and migrated its live gates into the verifier, so the
// form has no subject left and is gone with it.
//
// The dispatch contract itself is NOT gone — the verifier subagent still runs and
// still emits user-facing prose, so `references/execute-phase-response-language.md`
// still tells the orchestrator to carry the directive into that prompt. It is
// simply no longer a statement about any file in this catalog, which is all this
// lint reads. `tests/response-language-coverage.test.cjs` pins both ends of it
// (the reference's directive text and the `Create VERIFICATION.md.` anchor it
// positions against in execute-phase.md) directly against the real tree.
// Fragment directories produced by the workflow-fragment epic (#1671). A file
// under one of these is a SECTION of its parent workflow, never an entry point:
// it is reached by a `read and execute gsd-core/workflows/<path>` stub, which
// fires with the parent — and therefore the parent's response-language
// directive — already loaded.
//
// The stub is USUALLY in the top-level parent, which is the only case
// `inheritsParentCoverage` can prove, and it deliberately proves no more. Three
// fragments arrive by a different route today, and none of them relies on this
// function: `execute-phase/steps/regression-gate-run.md` and
// `plan-phase/steps/prd-express-path.md` are dispatched by a SIBLING fragment
// (`regression-gate.md`, `prd-express-gate.md`), and `help/modes/topic.md` is
// routed from a table in `help.md` that names the path without a dispatch verb
// at all. All three carry the pinned inline directive and are listed in
// `EXACT_INLINE_DIRECTIVE_WORKFLOWS`, so `findViolations` settles them before
// inheritance is ever consulted.
//
// Left as one hop on purpose. Walking the sibling chain would let a fragment
// inherit through a file this lint has not proven reachable, trading a loud
// failure for a quiet assumption; as it stands, extracting a fragment-of-a-
// fragment without pinning it turns the lint RED, which is the correct answer
// and names the file to fix.
const FRAGMENT_DIRS = new Set(['modes', 'steps', 'templates']);
const DIRECTIVE_ACTION_RE = /\b(?:apply|present|render|respond|translate|use|write|must|should)\b/i;
const USER_OUTPUT_RE = /\b(?:explanations?|language|narration|output|prompts?|prose|questions?|templates?|user-facing)\b/i;
// The defect #2529 reports is NARRATION, not the question/answer surface: a
// directive worded as "all user-facing questions, prompts, and explanations" is
// read as covering what the user is asked and told at a turn boundary, and the
// running commentary the model emits between tool calls stays in English beside
// it. A line that names only that surface therefore certifies the exact gap the
// issue exists to close, so coverage additionally requires a narration-class
// token — narration, status, progress, findings, or output "between tool calls".
// Round 21 tightening: the accepted forms are the two that NAME the class — the
// word "narration", or output described as running "between tool calls". The
// earlier list also accepted a bare "status", "progress" or "findings", which
// are words that merely APPEAR in the canonical phrasing: a line reading "Use
// response_language for all user-facing output; report status." passed while
// naming nothing about inter-tool narration, i.e. weaker than REQ-LANG-04
// requires. Verified before tightening: all 79 catalog files that passed under
// the old list still pass under this one, so no workflow needed rewording — the
// dropped tokens were reachable only by directives nobody ships.
// Still deliberately not a phrase match: pinning one sentence would push authors
// toward copying wording instead of stating the rule (`tests/response-language-coverage.test.cjs`
// pins the old weak wording as a FAILING case so this cannot silently loosen).
const NARRATION_CLASS_RE = /\bnarration\b|\bbetween tool calls\b/i;

/**
 * Walk the catalog, FOLLOWING symlinked subtrees.
 *
 * `Dirent` uses lstat semantics, so a symlinked directory answers false to both
 * `isDirectory()` and `isFile()`. Branching on those alone skipped a symlinked
 * subtree in silence while `files.length > 0` kept the run green — the exact
 * "reported OK while coverage regressed" outcome `main()` claims to make
 * impossible. Each symlink is resolved with `statSync` and followed.
 *
 * Cycles are bounded by the `seen` set of resolved real paths: a link pointing
 * at an ancestor is entered once and not re-entered. A broken link resolves to
 * nothing and is skipped — it contributes no file to inspect, and no coverage
 * claim rides on it.
 */
function findMarkdownFilesRecursive(dir, seen = new Set()) {
  const files = [];
  let real;
  try { real = fs.realpathSync(dir); } catch { real = dir; }
  if (seen.has(real)) return files;
  seen.add(real);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      isDirectory = stat.isDirectory();
      isFile = stat.isFile();
    }
    if (isDirectory) files.push(...findMarkdownFilesRecursive(full, seen));
    else if (isFile && entry.name.endsWith('.md')) files.push(full);
  }
  return files.sort();
}

/**
 * Does the file LOAD a shared directive, rather than merely name one?
 *
 * The distinction is the same one `namesFragmentAsEntryPoint` draws a level
 * down, and it matters for the same reason: only a real `@`-import puts the
 * directive in context. A changelog line ("#2529: added the shared
 * response-language-directive.md reference"), a deprecation note, or any prose
 * naming the path proves nothing about what loads — but a bare substring test
 * cannot tell those apart, so such a workflow would be certified covered while
 * shipping the very defect #2529 exists to close.
 *
 * The catalog emits the import exactly one way: an `@`-path occupying the whole
 * line — line 1 for the 43 top-level workflows, line 96 for `execute-phase.md`.
 * Both `@~/` and `@$HOME/` spellings are accepted because the repo writes both
 * (see `scripts/strip-prose-atrefs.cjs`).
 *
 * LIMITATION, stated rather than papered over: like the fragment check, this
 * reads Markdown as text. An import inside a fenced block quoted as an example
 * still counts, and one whose line carries a trailing `<!-- ... -->` no longer
 * does. Neither shape occurs in the catalog today, and both would be visible in
 * review as a quoted or edited import.
 */
const DIRECTIVE_IMPORT_RES = DIRECTIVE_REFS.map(
  (ref) => new RegExp(`^@(?:~|\\$HOME)/\\S*${ref.replaceAll('.', '\\.')}$`),
);

function importsDirectiveReference(content) {
  return importedDirectiveReference(content) !== null;
}

/** Which known reference does this file import, if any? */
function importedDirectiveReference(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  for (const [index, ref] of DIRECTIVE_REFS.entries()) {
    if (lines.some((line) => DIRECTIVE_IMPORT_RES[index].test(line))) return ref;
  }
  return null;
}

/** The four-predicate test for an actionable directive on a single line. */
function carriesInlineDirective(content) {
  return content.split(/\r?\n/).some((line) =>
    /\bresponse_language\b/i.test(line) &&
    DIRECTIVE_ACTION_RE.test(line) &&
    USER_OUTPUT_RE.test(line) &&
    NARRATION_CLASS_RE.test(line)
  );
}

/**
 * Does the SHARED FILE a workflow imports itself carry an actionable directive?
 *
 * Checking only that the `@`-import LINE exists is a hole the size of the
 * bucket: 43 workflows take their entire coverage from one file, and nothing in
 * the repo pinned that file's text. Rewriting it back to the pre-#2529 wording —
 * the sentence this PR's own round-10 finding calls the DEFECT — left the lint
 * green and every workflow "covered". That is the same "the gate certifies the
 * defect" failure the round-10 fix closed, one level up.
 *
 * So an import is coverage only when the referenced file passes the very
 * predicate an inline directive must pass. A missing, unreadable, or weakened
 * reference covers nobody, and `main()` reports it as one systemic failure
 * rather than as 43 identical per-file violations.
 */
const referenceDirectiveCache = new Map();
function referenceCarriesDirective(ref, refRoot) {
  const key = refRoot + '\u0000' + ref;
  if (!referenceDirectiveCache.has(key)) {
    let ok = false;
    try { ok = carriesInlineDirective(fs.readFileSync(path.join(refRoot, ref), 'utf8')); }
    catch { ok = false; }
    referenceDirectiveCache.set(key, ok);
  }
  return referenceDirectiveCache.get(key);
}

/**
 * Of the references these files actually import, which are missing, unreadable,
 * or no longer actionable?
 *
 * Scoped to imported references on purpose: a reference nobody imports cannot
 * uncover anybody, so failing on it would red a run over a file it never
 * consulted. Every reference that IS imported is load-bearing for every workflow
 * that imports it.
 */
function findBrokenDirectiveReferences(files, refRoot = REFERENCE_ROOT) {
  const imported = new Set();
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const ref = importedDirectiveReference(content);
    if (ref !== null) imported.add(ref);
  }
  return [...imported].filter((ref) => !referenceCarriesDirective(ref, refRoot)).sort();
}

function hasResponseLanguageCoverage(content, refRoot = REFERENCE_ROOT) {
  const ref = importedDirectiveReference(content);
  if (ref !== null) return referenceCarriesDirective(ref, refRoot);

  return carriesInlineDirective(content);
}

/**
 * How far a read/execute verb may sit from the fragment path it governs on the
 * same line. Sized from the widest shape the catalog actually emits —
 * ``read and execute `gsd-core/workflows/...` `` (14 characters between verb and
 * path) — with room for a variant, and deliberately far short of a sentence, so
 * a verb belonging to a different clause cannot reach across and vouch for a
 * path it never dispatches.
 */
const ENTRY_POINT_VERB_WINDOW = 40;
const ENTRY_POINT_VERB_RE = new RegExp(`\\b(?:read|execute|run)\\b.{0,${ENTRY_POINT_VERB_WINDOW}}$`, 'i');

/**
 * Does the parent name this fragment as a live ENTRY POINT, rather than merely
 * mentioning its path?
 *
 * The distinction is the whole basis of inherited coverage: the inheritance is
 * sound only because the fragment cannot be reached except through the parent's
 * dispatch stub, which fires with the parent's directive already loaded. A path
 * that appears in a changelog line, a deprecation note, or a comment proves
 * nothing about how the fragment is reached — but a bare substring test cannot
 * tell those apart, so before this check any mention at all granted coverage.
 *
 * The catalog emits exactly one shape, in four spellings: ``read and execute
 * `<path>` ``, ``Read+execute `<path>` ``, ``Read `<path>` if <condition>``, and
 * ``run `<path>` to <effect>`` (the spelling #1689's per-plan executor routing
 * introduced). A read/execute/run verb within `ENTRY_POINT_VERB_WINDOW`
 * characters ahead of the path on the SAME LINE covers all four.
 *
 * LIMITATION, stated rather than papered over: this reads Markdown as text, not
 * as a parsed document. A dispatch stub that a future edit comments out with
 * `<!-- ... -->`, or moves inside a fenced block quoted as an example, still
 * matches — the verb and the path are both still there. Distinguishing those
 * needs a Markdown parser, and the cheap approximations (tracking fence state,
 * skipping `<!--` lines) buy little: neither shape occurs in the catalog today,
 * and both would be visible in review as a deleted dispatch. What this DOES
 * close is the common, invisible case — a path mentioned in prose that never
 * dispatches anything. `tests/response-language-coverage.test.cjs` pins both the
 * accepted spellings and the rejected mention forms.
 *
 * SECOND LIMITATION, same class: a dispatch line may sit inside a
 * `<!-- gsd:section id="X" when="…" -->` guard, and nothing here checks that the
 * guard is satisfiable or that its `id` still matches the fragment it gates.
 * Every such pairing lines up today. If one drifts, the fragment becomes
 * unreachable while this function still calls it dispatched — an orphan the lint
 * reports as covered. That is not the defect #2529 is about: a dispatch that
 * never fires renders nothing, so no English prose reaches the user through it.
 * The gap is a soundness one, worth naming rather than implying.
 */
function namesFragmentAsEntryPoint(parent, relative) {
  const needle = `gsd-core/workflows/${relative}`;
  return parent.split(/\r?\n/).some((line) => {
    const at = line.indexOf(needle);
    return at !== -1 && ENTRY_POINT_VERB_RE.test(line.slice(0, at));
  });
}

/**
 * A fragment inherits its parent workflow's coverage, but only when the
 * inheritance is PROVEN per file rather than assumed from the directory:
 *   1. the path is `<workflow>/<fragment-dir>/<name>.md`,
 *   2. `<workflow>.md` exists and dispatches this exact fragment path from a
 *      read/execute context — i.e. the parent really is the way in, not just a
 *      file that happens to spell the name (see `namesFragmentAsEntryPoint`), and
 *   3. the parent is itself covered.
 * A fragment nobody dispatches, or one hanging off an uncovered parent, stays a
 * violation. Without this the lint reds on every new fragment the #1671 epic
 * extracts, even though the extraction moved prose that was already covered.
 */
function inheritsParentCoverage(workflowsDir, relative, refRoot = REFERENCE_ROOT) {
  const segments = relative.split('/');
  if (segments.length !== 3 || !FRAGMENT_DIRS.has(segments[1])) return false;
  const parentPath = path.join(workflowsDir, `${segments[0]}.md`);
  if (!fs.existsSync(parentPath)) return false;
  const parent = fs.readFileSync(parentPath, 'utf8');
  if (!namesFragmentAsEntryPoint(parent, relative)) return false;
  return hasResponseLanguageCoverage(parent, refRoot);
}

function findViolations(workflowsDir, refRoot = REFERENCE_ROOT) {
  return findMarkdownFilesRecursive(workflowsDir).filter((file) => {
    const relative = path.relative(workflowsDir, file).replaceAll(path.sep, '/');
    const content = fs.readFileSync(file, 'utf8');
    if (EXACT_INLINE_DIRECTIVE_WORKFLOWS.has(relative)) {
      return !content.split(/\r?\n/).includes(INLINE_RESPONSE_LANGUAGE_DIRECTIVE);
    }
    if (hasResponseLanguageCoverage(content, refRoot)) return false;
    return !inheritsParentCoverage(workflowsDir, relative, refRoot);
  });
}

function main(workflowsDir = WORKFLOWS_DIR, io = console, refRoot = REFERENCE_ROOT) {
  // The catalog is discovered, not declared, so an unreadable or empty
  // directory yields an empty violation list — indistinguishable from full
  // coverage if the only success condition is `violations.length === 0`. Both
  // discovery failures below are therefore lint failures in their own right:
  // a stripped install tree, a `__dirname`-relative path typo, or an
  // unfollowed symlink must not be able to report OK while coverage silently
  // regresses to the pre-#2529 state.
  let files;
  try {
    files = findMarkdownFilesRecursive(workflowsDir);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    io.error(
      `lint-response-language-coverage: cannot read the workflow directory ${workflowsDir} (${error.code}).\n` +
      `Coverage cannot be established, so this is a failure and not a pass (#2529).`,
    );
    return 1;
  }

  if (files.length === 0) {
    io.error(
      `lint-response-language-coverage: no workflow files found under ${workflowsDir}.\n` +
      `A run that inspected zero workflows cannot establish coverage (#2529).`,
    );
    return 1;
  }

  // The shared references are checked ONCE, before the per-file pass. 43
  // workflows hold no directive of their own, so a reference that has gone
  // missing or been reworded back to the pre-#2529 sentence is a single
  // systemic failure, not 43 identical ones — and reporting it as 43 would bury
  // the cause under its symptoms.
  const brokenReferences = findBrokenDirectiveReferences(files, refRoot);
  if (brokenReferences.length > 0) {
    io.error(
      'lint-response-language-coverage: ' + brokenReferences.length +
      ' shared directive reference(s) no longer carry an actionable directive (#2529, REQ-LANG-04).\n' +
      'Workflows that @-import a reference take ALL of their coverage from it, so a missing,\n' +
      'unreadable, or reworded reference silently uncovers every one of them:\n\n' +
      brokenReferences.map((ref) => '  - ' + ref).join('\n') + '\n\n' +
      'The file must itself name the narration class on the same line as response_language\n' +
      '— the same rule an inline directive must satisfy.',
    );
    return 1;
  }

  const violations = findViolations(workflowsDir, refRoot);

  if (violations.length > 0) {
    io.error(
      `lint-response-language-coverage: ${violations.length} workflow(s) have no response-language coverage (#2529).\n` +
      `Each workflow must either @-reference a recognized response-language directive\n` +
      `or carry its own inline \`response_language\` directive (unless its parent dispatches it).\n` +
      `An inline directive names the narration class with the word "narration" or the phrase\n` +
      `"between tool calls" (REQ-LANG-04); enumerating status updates, progress notes or\n` +
      `findings without naming the class does not satisfy it:\n\n` +
      violations.map((file) => `  - ${path.relative(workflowsDir, file).replaceAll(path.sep, '/')}`).join('\n'),
    );
    return 1;
  }

  io.log(`lint-response-language-coverage: OK (${files.length} workflows covered)`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  EXACT_INLINE_DIRECTIVE_WORKFLOWS,
  INLINE_RESPONSE_LANGUAGE_DIRECTIVE,
  NARRATION_CLASS_RE,
  WORKFLOWS_DIR,
  REFERENCE_ROOT,
  carriesInlineDirective,
  findBrokenDirectiveReferences,
  findMarkdownFilesRecursive,
  findViolations,
  hasResponseLanguageCoverage,
  importedDirectiveReference,
  importsDirectiveReference,
  inheritsParentCoverage,
  namesFragmentAsEntryPoint,
  main,
};
