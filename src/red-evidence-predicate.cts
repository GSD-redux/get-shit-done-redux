import path from 'node:path';
import { safeJsonParse } from './security.cjs';

/**
 * RED-Evidence Predicate — issue #3770 (Phase 3)
 *
 * Pure leaf evaluator for the `red-evidence:` trailer against a task's
 * `<red_contract>` declaration. `gsd-core/references/tdd.md`'s `### RED
 * Predicate` fence is the canonical predicate; this module implements it and
 * never restates or quotes it beyond naming the conjuncts as code.
 *
 * This is a leaf pure module: no fs, no child_process, no config. The caller
 * (`routeRedEvidenceVerdict` in `task-command-router.cts`) reads the task
 * file and the trailer text itself and passes both in as strings — this
 * module owns all JSON parsing and every key-set equality check: the
 * trailer's top level, `location`'s two points, each point's two fields,
 * and `expected`/`actual`'s three fields.
 *
 * `evaluateRedEvidence` never throws and never defaults to `authorize`: every
 * malformed or ambiguous input returns `red_commit_not_failing` with a
 * `reason`, and only a fully-conforming six-key trailer that satisfies the
 * predicate returns `authorize`.
 */

interface RedContractPlan {
  target_test: string;
  expected_failure: {
    phase: string;
    class_or_mode: string;
    subject: string;
  };
}

type RedEvidenceVerdict = 'authorize' | 'red_commit_not_failing' | 'unexpected_pass';

interface RedEvidenceResult {
  verdict: RedEvidenceVerdict;
  reason: string;
  failed?: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** The six top-level `red-evidence:` trailer keys, sorted. */
const TOP_LEVEL_KEYS = [
  'actual', 'command', 'exit_status', 'expected', 'location', 'target_test',
].sort();

/** `location`'s two sub-keys, sorted. */
const LOCATION_KEYS = ['declared', 'observed'].sort();

/** `location.declared` / `location.observed`'s two sub-keys, sorted. */
const LOCATION_POINT_KEYS = ['file', 'line'].sort();

/** `expected` / `actual`'s three sub-keys, sorted. */
const TRIPLE_KEYS = ['class_or_mode', 'phase', 'subject'].sort();

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `path.win32.basename('')` is `''`, so an all-empty `location` pair would
 * satisfy `locationsAgree` without either side ever declaring a real file.
 * This guard is what stops that — not decoration. Same predicate
 * `src/gate-predicate-evaluator.cts:95` uses; copied rather than imported
 * because it is module-local there, absent from that file's `export =`
 * block, and importing it would widen that leaf module's public surface to
 * share one helper.
 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function keysEqual(obj: unknown, expectedSortedKeys: readonly string[]): boolean {
  if (!isPlainObject(obj)) return false;
  const actual = Object.keys(obj).sort();
  if (actual.length !== expectedSortedKeys.length) return false;
  return actual.every((key, i) => key === expectedSortedKeys[i]);
}

/** `expected_failure` / `actual` triple structural equality over the three declared fields. */
function sameTriple(a: Record<string, unknown>, b: RedContractPlan['expected_failure']): boolean {
  return a['phase'] === b['phase']
    && a['class_or_mode'] === b['class_or_mode']
    && a['subject'] === b['subject'];
}

/**
 * `location.observed == location.declared`, exactly as `### RED Predicate`'s
 * shared conjunct defines it: file compared by basename only (`path.win32`
 * normalizes both `/` and `\` separators, so a POSIX-reported and a
 * Windows-reported path for the same file still compare equal), line
 * compared strictly. No column, no prefix/suffix/substring matching.
 */
function locationsAgree(
  declared: { file: string; line: number },
  observed: { file: string; line: number },
): boolean {
  return path.win32.basename(declared.file) === path.win32.basename(observed.file)
    && declared.line === observed.line;
}

function countRedContracts(taskContent: string): number {
  const matches = taskContent.match(/<red_contract>/g);
  return matches ? matches.length : 0;
}

function extractRedContractBlock(taskContent: string): string | null {
  const start = taskContent.indexOf('<red_contract>');
  const end = taskContent.indexOf('</red_contract>');
  if (start === -1 || end === -1 || end < start) return null;
  return taskContent.slice(start, end + '</red_contract>'.length);
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : '';
}

function extractPlan(block: string): RedContractPlan {
  const failureMatch = block.match(/<expected_failure>([\s\S]*?)<\/expected_failure>/);
  const failureBlock = failureMatch ? failureMatch[1] : '';
  return {
    target_test: extractTag(block, 'target_test'),
    expected_failure: {
      phase: extractTag(failureBlock, 'phase'),
      class_or_mode: extractTag(failureBlock, 'class_or_mode'),
      subject: extractTag(failureBlock, 'subject'),
    },
  };
}

/** The trailer's JSON payload sits after `red-evidence:` — locate it by its opening brace. */
function extractTrailerJson(trailerText: string): string {
  if (typeof trailerText !== 'string') return '';
  const idx = trailerText.indexOf('{');
  return idx === -1 ? '' : trailerText.slice(idx);
}

// ─── Evaluator ──────────────────────────────────────────────────────────────

/**
 * Evaluate a `red-evidence:` trailer against a task's `<red_contract>`
 * declaration. `taskContent` is the whole task file (or task element) text;
 * `trailerText` is the raw trailer line (or its JSON payload) as committed.
 *
 * The `<red_contract>` cardinality guard (exactly one, never zero or more
 * than one) proves the declaration is unambiguous — it is a cardinality
 * check, not an ownership check: a file with two behavior-adding tasks
 * sharing one `<red_contract>` still passes the count. See plan 03-03.
 */
function evaluateRedEvidence(taskContent: string, trailerText: string): RedEvidenceResult {
  const contractCount = countRedContracts(taskContent);
  if (contractCount !== 1) {
    return {
      verdict: 'red_commit_not_failing',
      reason: contractCount === 0
        ? 'the task carries no <red_contract> declaration to gate the RED commit against'
        : `the task carries ${contractCount} <red_contract> declarations; exactly one is `
          + 'required so the gate binds to an unambiguous declaration',
    };
  }

  const block = extractRedContractBlock(taskContent);
  if (!block) {
    return {
      verdict: 'red_commit_not_failing',
      reason: 'the <red_contract> declaration is malformed and could not be extracted',
    };
  }
  const plan = extractPlan(block);

  const jsonText = extractTrailerJson(trailerText);
  const parsed = safeJsonParse(jsonText, { label: 'red-evidence trailer' });
  if (!parsed.ok) {
    return {
      verdict: 'red_commit_not_failing',
      reason: parsed.error || 'the red-evidence trailer failed to parse as JSON',
    };
  }

  if (!keysEqual(parsed.value, TOP_LEVEL_KEYS)) {
    return {
      verdict: 'red_commit_not_failing',
      reason: `the red-evidence trailer's top-level key set must equal exactly `
        + `[${TOP_LEVEL_KEYS.join(', ')}]`,
    };
  }
  const trailer = parsed.value as Record<string, unknown>;

  if (!keysEqual(trailer['location'], LOCATION_KEYS)) {
    return {
      verdict: 'red_commit_not_failing',
      reason: `the trailer's "location" key set must equal exactly [${LOCATION_KEYS.join(', ')}]`,
    };
  }
  const location = trailer['location'] as Record<string, unknown>;

  if (!keysEqual(location['declared'], LOCATION_POINT_KEYS)
    || !keysEqual(location['observed'], LOCATION_POINT_KEYS)) {
    return {
      verdict: 'red_commit_not_failing',
      reason: '"location.declared" and "location.observed" must each equal exactly '
        + `[${LOCATION_POINT_KEYS.join(', ')}]`,
    };
  }
  const declared = location['declared'] as Record<string, unknown>;
  const observed = location['observed'] as Record<string, unknown>;

  if (typeof declared['line'] !== 'number' || typeof observed['line'] !== 'number') {
    return {
      verdict: 'red_commit_not_failing',
      reason: '"location.declared.line" and "location.observed.line" must each be a number',
    };
  }
  if (!isNonEmptyString(declared['file']) || !isNonEmptyString(observed['file'])) {
    return {
      verdict: 'red_commit_not_failing',
      reason: '"location.declared.file" and "location.observed.file" must each be a '
        + 'non-empty string',
    };
  }
  const declaredPoint = { file: declared['file'], line: declared['line'] };
  const observedPoint = { file: observed['file'], line: observed['line'] };

  if (!isNonEmptyString(trailer['command'])) {
    return {
      verdict: 'red_commit_not_failing',
      reason: '"command" must be a non-empty string so the evidence names a reproducible run',
    };
  }

  const exitStatus = trailer['exit_status'];
  if (!Number.isInteger(exitStatus)) {
    return {
      verdict: 'red_commit_not_failing',
      reason: '"exit_status" must be a JSON number and a non-integer cannot be compared against 0',
    };
  }
  if (exitStatus === 0) {
    return {
      verdict: 'unexpected_pass',
      reason: 'the recorded command exited 0 — the run passed, so nothing failed to evaluate',
    };
  }

  if (!keysEqual(trailer['expected'], TRIPLE_KEYS) || !keysEqual(trailer['actual'], TRIPLE_KEYS)) {
    return {
      verdict: 'red_commit_not_failing',
      reason: '"expected" and "actual" must each equal exactly '
        + `[${TRIPLE_KEYS.join(', ')}]`,
    };
  }
  const expectedTriple = trailer['expected'] as Record<string, unknown>;
  const actualTriple = trailer['actual'] as Record<string, unknown>;

  const checks: Array<[string, boolean]> = [
    ['trailer.expected == plan.expected_failure',
      sameTriple(expectedTriple, plan.expected_failure)],
    ['actual.phase == expected.phase', actualTriple['phase'] === expectedTriple['phase']],
    ['actual.class_or_mode == expected.class_or_mode',
      actualTriple['class_or_mode'] === expectedTriple['class_or_mode']],
    ['trailer.target_test == plan.target_test', trailer['target_test'] === plan.target_test],
    ['location.observed == location.declared', locationsAgree(declaredPoint, observedPoint)],
    ['actual.subject == plan.target_test', actualTriple['subject'] === plan.target_test],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);

  if (failed.length === 0) {
    return {
      verdict: 'authorize',
      reason: 'every conjunct of the RED Predicate holds',
    };
  }

  return {
    verdict: 'red_commit_not_failing',
    reason: `the RED Predicate does not hold; failed conjuncts: ${failed.join(' | ')}`,
    failed,
  };
}

export = {
  evaluateRedEvidence,
};
