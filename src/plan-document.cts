/**
 * Plan Document Module — the single parser for a `*-PLAN.md` document BODY.
 *
 * Owns: objective extraction, the task-block grammar (`<task>` elements, with
 * the legacy `## Task N` heading fallback — including the optional `tracker-id`
 * attribute, ADR-3646 Phase 1, read verbatim and never split here), planned-file
 * extraction, and the frontmatter-derived scheduling metadata (`wave`,
 * `depends_on`, `autonomous`, `agent_hint`, `files_modified`).
 *
 * WHY THIS IS A LEAF MODULE. This logic was written inline inside
 * `cmdPhasePlanIndex` (`src/phase.cts`). Two commands in two different families
 * now need it — `phase.plan-index` and `planning.inspect` (#2790) — so leaving
 * it in `phase.cts` would force `planning` to depend on `phase`, and copying it
 * would be the *Generative Fix Divergence* class `CLAUDE.md` names. A leaf owned
 * by neither family is the seam that matches the actual usage (Conway's Law).
 *
 * NOT an ADR-3180 §7 derivation. §6 puts the document-parsing layer explicitly
 * out of that epic's scope (#2143); this module answers "what does this plan
 * document say", never "how many plans are outstanding" (that is
 * `scanPhasePlans`, §7.5) or "is this phase complete" (`isPhaseComplete`, §7.4).
 *
 * BEHAVIOUR IS PRESERVED BYTE-FOR-BEHAVIOUR from the prior inline code. In
 * particular `tasks.length` is exactly the legacy `taskCount`
 * (`xmlTasks.length || mdTasks.length`), including its known fence-blindness —
 * a `## Task 1` inside a fenced code block still counts, exactly as it does
 * today. That is a characterised limit, not an endorsement: changing it would
 * silently change `phase.plan-index`'s output for existing projects, which is a
 * Hyrum's-Law break that belongs in its own issue rather than riding along on a
 * read-only query addition.
 *
 * ADR-457 build-at-publish: source in src/plan-document.cts, compiled to
 * gsd-core/bin/lib/plan-document.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;

// ─── Frozen vocabularies ──────────────────────────────────────────────────────

/**
 * How a task row was expressed in the document. `auto` is the ordinary
 * executable task; `checkpoint` is a `<task type="checkpoint:*">` block, which
 * carries an entirely different element set (`<decision>`/`<what-built>`, no
 * `<name>`/`<files>`/`<acceptance_criteria>`). Distinguishing them is what
 * stops a checkpoint from being reported as a malformed auto task.
 */
const TASK_KIND = Object.freeze({
  AUTO: 'auto',
  CHECKPOINT: 'checkpoint',
});

type TaskKind = (typeof TASK_KIND)[keyof typeof TASK_KIND];

// ─── Shapes ───────────────────────────────────────────────────────────────────

interface PlanTask {
  /** 1-based position in document order. */
  index: number;
  kind: TaskKind;
  /** The verbatim `type` attribute when present (e.g. `auto`, `checkpoint:decision`). */
  type: string | null;
  /** `<name>` text, or null — always null for a checkpoint block. */
  name: string | null;
  /** `<files>` split on commas, trimmed, empties dropped. Never null; `[]` means "none declared". */
  plannedFiles: string[];
  /** `<acceptance_criteria>` bullet lines, in document order. */
  acceptanceCriteria: string[];
  /** `<done>` text, or null. */
  done: string | null;
  /**
   * Verbatim `tracker-id` attribute value (e.g. `beads:GSD-42`), or null.
   * Never split or parsed here — that belongs to the resolution seam
   * (ADR-3646), not this grammar layer. Null for a checkpoint task (never
   * read), an absent attribute, or an empty-string value (`tracker-id=""`
   * normalises to null, same as every other optional attribute here).
   */
  trackerId: string | null;
  /**
   * Verbatim `tdd` attribute value on a `<task>` opening tag (e.g. `"true"`),
   * or null. Never coerced to boolean — read exactly like `trackerId`. Null
   * for a checkpoint task (never read), an absent attribute, or an
   * empty-string value. #4273 (epic #4272, ADR-3473's 4th application).
   */
  tdd: string | null;
}

interface PlanDocument {
  /** `<objective>` body, else frontmatter `objective`, else null. */
  objective: string | null;
  /** Frontmatter `type` value, read verbatim (e.g. `"tdd"`, `"standard"`), or null when absent. #4273. */
  type: string | null;
  /** Frontmatter `wave` as an integer, or null when absent/unparseable. */
  declaredWave: number | null;
  dependsOn: string[];
  autonomous: boolean;
  agentHint: string | null;
  /** Frontmatter `files_modified` / `files-modified`, normalised to an array. */
  filesModified: string[];
  /**
   * #3003: frontmatter `files_deleted` / `files-deleted`, normalised to an array.
   * Paths the plan declares it will REMOVE, so `worktree cleanup-wave`'s deletions
   * guard can authorize exactly those and keep blocking anything undeclared.
   * OPTIONAL — a plan that omits it declares nothing and keeps the guard's original
   * unconditional block.
   */
  filesDeleted: string[];
  tasks: PlanTask[];
  /**
   * Legacy count. Invariant: `taskCount === tasks.length`, always. Exposed as
   * its own field so the invariant is assertable rather than assumed.
   */
  taskCount: number;
}

// ─── Task grammar ─────────────────────────────────────────────────────────────

// The legacy counting rule, preserved verbatim from cmdPhasePlanIndex. `g` is
// required (we count every occurrence) and these are rebuilt per call rather
// than hoisted to module scope: a global regex carries mutable `lastIndex`
// state, and a shared instance is a cross-call contamination bug.
function xmlTaskOpenings(content: string): RegExpMatchArray[] {
  return [...content.matchAll(/<task(?=[\s>])[^>]*>/gi)];
}

function markdownTaskHeadings(content: string): RegExpMatchArray[] {
  return [...content.matchAll(/##\s*Task\s*\d+[^\n]*/gi)];
}

/** Extract the value of one attribute from a `<task ...>` opening tag. */
function tagAttribute(openTag: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"|\\b${attr}\\s*=\\s*'([^']*)'`, 'i');
  const m = re.exec(openTag);
  if (!m) return null;
  const value = (m[1] ?? m[2] ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Body of the first `<tag>…</tag>` inside `block`, or null. Non-greedy and
 * case-insensitive; a tag that is opened but never closed yields null rather
 * than swallowing the rest of the document.
 */
function elementBody(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}\\s*>`, 'i');
  const m = re.exec(block);
  return m ? m[1] : null;
}

/**
 * Split a `<files>` body into paths. Comma-separated per the shipped
 * `templates/phase-prompt.md` grammar; newline-separated forms are tolerated
 * too (Postel — liberal in what we accept), and the caller records nothing
 * special for them because a path list is a path list either way.
 */
function splitFileList(body: string | null): string[] {
  if (body === null) return [];
  return body
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** `<acceptance_criteria>` carries `- ` bullets, one criterion per line. */
function splitCriteria(body: string | null): string[] {
  if (body === null) return [];
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*]\s*/, ''))
    .filter((line) => line.length > 0);
}

function collapseWhitespace(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the `<task>` blocks. Each opening tag found by `xmlTaskOpenings` yields
 * exactly one row — the block runs from that tag to its `</task>`, or to the
 * next opening tag, or to end-of-document. Bounding on the NEXT OPENING rather
 * than only on `</task>` is what keeps an unclosed block from consuming its
 * siblings, so the row count still equals the opening count.
 */
function parseXmlTasks(content: string): PlanTask[] {
  const openings = xmlTaskOpenings(content);
  return openings.map((match, i) => {
    const start = match.index ?? 0;
    const openTag = match[0];
    const nextStart = i + 1 < openings.length ? (openings[i + 1].index ?? content.length) : content.length;
    const window = content.slice(start, nextStart);
    const closeIdx = window.search(/<\/task\s*>/i);
    const block = closeIdx === -1 ? window : window.slice(0, closeIdx);

    const type = tagAttribute(openTag, 'type');
    const kind: TaskKind = type !== null && type.toLowerCase().startsWith('checkpoint')
      ? TASK_KIND.CHECKPOINT
      : TASK_KIND.AUTO;

    // A checkpoint block has no <name>/<files>/<acceptance_criteria>/<done> in
    // the shipped grammar. Reading them anyway would be harmless but dishonest:
    // the caller must be able to tell "this element is absent because this kind
    // of task has no such element" from "this element is missing and should not
    // be".
    if (kind === TASK_KIND.CHECKPOINT) {
      return {
        index: i + 1,
        kind,
        type,
        name: null,
        plannedFiles: [],
        acceptanceCriteria: [],
        done: null,
        trackerId: null,
        tdd: null,
      };
    }

    return {
      index: i + 1,
      kind,
      type,
      name: collapseWhitespace(elementBody(block, 'name')),
      plannedFiles: splitFileList(elementBody(block, 'files')),
      acceptanceCriteria: splitCriteria(elementBody(block, 'acceptance_criteria')),
      done: collapseWhitespace(elementBody(block, 'done')),
      trackerId: tagAttribute(openTag, 'tracker-id'),
      tdd: tagAttribute(openTag, 'tdd'),
    };
  });
}

/**
 * Legacy fallback: `## Task N` headings, used ONLY when the document carries no
 * `<task>` blocks at all. Deliberately fence-blind, matching the counting rule
 * `cmdPhasePlanIndex` has always used — see this module's header comment.
 */
function parseMarkdownTasks(content: string): PlanTask[] {
  return markdownTaskHeadings(content).map((match, i) => ({
    index: i + 1,
    kind: TASK_KIND.AUTO,
    type: null,
    name: collapseWhitespace(match[0].replace(/^##\s*/, '')),
    plannedFiles: [],
    acceptanceCriteria: [],
    done: null,
    trackerId: null,
    tdd: null,
  }));
}

// ─── Objective ────────────────────────────────────────────────────────────────

/**
 * Preserved verbatim from `cmdPhasePlanIndex`: the first line following an
 * `<objective>` tag. Deliberately NOT widened to the full element body — that
 * would change `phase.plan-index`'s existing output for any multi-line
 * objective.
 */
function extractObjective(content: string): string | null {
  const m = content.match(/<objective>\s*\n?\s*(.+)/);
  return m ? m[1].trim() : null;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * The plan id for a plan FILE ENTRY, exactly as `scanPhasePlans` stores it
 * (root entries bare, nested entries `plans/`-prefixed).
 *
 * This is the established derivation from `cmdPhasePlanIndex`, moved here
 * VERBATIM (#2790) so `phase.plan-index` and `planning.inspect` cannot report
 * different ids for the same plan — a consumer correlating the two surfaces
 * needs them to join. Deliberately NOT "improved": it is a display/lookup key
 * with existing callers, and changing what it returns would be a Hyrum's-Law
 * break on `phase-plan-index`.
 */
function planIdFromFile(planFile: string): string {
  return planFile.replace('-PLAN.md', '').replace('PLAN.md', '');
}

/**
 * Parse one plan document.
 *
 * @param content  Raw `*-PLAN.md` text.
 * @param planPath Optional path, used only to name the file in `extractFrontmatter`'s
 *                 truncated-frontmatter diagnostic (#1882). Callers that do not have
 *                 one omit it — this default IS the shape production uses from the
 *                 read-only query path.
 */
function parsePlanDocument(content: string, planPath = ''): PlanDocument {
  const fm = extractFrontmatter(content, planPath);

  const xmlTasks = parseXmlTasks(content);
  const tasks = xmlTasks.length > 0 ? xmlTasks : parseMarkdownTasks(content);

  const parsedWave = parseInt(fm['wave'] as string, 10);
  const declaredWave = Number.isNaN(parsedWave) ? null : parsedWave;

  let dependsOn: string[] = [];
  const fmDeps = fm['depends_on'];
  if (Array.isArray(fmDeps)) {
    dependsOn = fmDeps.map(String);
  } else if (typeof fmDeps === 'string' && fmDeps.trim() !== '') {
    dependsOn = [fmDeps];
  }

  let autonomous = true;
  if (fm['autonomous'] !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue comparison
    autonomous = fm['autonomous'] === 'true' || String(fm['autonomous']) === 'true';
  }

  let filesModified: string[] = [];
  const fmFiles = fm['files_modified'] || fm['files-modified'];
  if (fmFiles) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
    filesModified = Array.isArray(fmFiles) ? fmFiles.map(String) : [String(fmFiles)];
  }

  let filesDeleted: string[] = [];
  const fmDeleted = fm['files_deleted'] || fm['files-deleted'];
  if (fmDeleted) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
    filesDeleted = Array.isArray(fmDeleted) ? fmDeleted.map(String) : [String(fmDeleted)];
  }

  let agentHint: string | null = null;
  const fmAgentHint = fm['agent_hint'];
  if (fmAgentHint !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
    const hintStr = String(fmAgentHint).trim();
    agentHint = hintStr !== '' ? hintStr : null;
  }

  let planType: string | null = null;
  const fmType = fm['type'];
  if (fmType !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
    planType = String(fmType);
  }

  return {
    objective: extractObjective(content) || (fm['objective'] as string | null) || null,
    type: planType,
    declaredWave,
    dependsOn,
    autonomous,
    agentHint,
    filesModified,
    filesDeleted,
    tasks,
    taskCount: tasks.length,
  };
}

const planDocument = { TASK_KIND, parsePlanDocument, planIdFromFile };

// Required to merge the compile-time-only types onto the `export =` runtime
// value; there is no ES-module-syntax way to export a type alongside a CJS
// `export =`.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace planDocument {
  export { PlanDocument, PlanTask, TaskKind };
}

export = planDocument;
