'use strict';
/**
 * command-contract-helpers.cjs  (ADR-0002)
 *
 * Single source of truth for the commands/gsd/*.md contract constants and
 * parsers shared by scripts/lint-command-contract.cjs and
 * tests/command-contract.test.cjs.
 *
 * Keeping these in one place ensures the lint script and the test suite
 * always agree on what constitutes a valid tool, a valid @-ref, and a valid
 * frontmatter structure. A new canonical tool added here is automatically
 * enforced by both consumers.
 */

const CANONICAL_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'Task', 'Agent', 'Skill', 'SlashCommand',
  'AskUserQuestion', 'WebFetch', 'WebSearch', 'TodoWrite',
  'mcp__context7__resolve-library-id',
  'mcp__context7__query-docs',
  'mcp__context7__*',
]);

function parseFrontmatter(content) {
  // CRLF-tolerant split: Windows checkouts (autocrlf=true) leave a trailing
  // \r on every line, making lines.indexOf('---', 1) return -1 (the value
  // would be '---\r', not '---') → returns {} → every field appears missing.
  const lines = content.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const end = lines.indexOf('---', 1);
  if (end === -1) return {};
  const fm = {};
  let key = null;
  for (const line of lines.slice(1, end)) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);
    if (kv) { key = kv[1]; fm[key] = kv[2].trim(); }
    else if (key && line.match(/^\s+-\s+/)) {
      const val = line.replace(/^\s+-\s+/, '').trim();
      fm[key] = fm[key] ? fm[key] + '\n' + val : val;
    }
  }
  return fm;
}

function executionContextRefs(content) {
  const refs = [];
  const re = /<execution_context(?:_extended)?>([\s\S]*?)<\/execution_context(?:_extended)?>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    for (const rawLine of m[1].split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('@')) continue;
      const token = line.split(/\s+/)[0];
      const trailingProse = line.length > token.length;
      const normalized = token
        .replace(/^@(?:~|\$HOME)\//, '')
        .replace(/^(?:\.claude\/)?(?:gsd-core\/)?/, '');
      refs.push({ token, normalized, trailingProse });
    }
  }
  return refs;
}

/**
 * workflowPathRefs(content)
 *
 * Locates every gsd-core-relative workflow path referenced in a markdown
 * string, whether the reference is an eager @-include (already covered by
 * executionContextRefs) or a *lazy* path mentioned only in prose/code — a
 * path a command reads on demand via Read/Bash rather than an @-inclusion
 * the harness inlines automatically. Both kinds are load-bearing: the
 * progressive-disclosure split (#717) deliberately keeps most workflow
 * content out of the eager path so the common case stays cheap, but that
 * means a command naming a workflow only in prose is invisible to
 * executionContextRefs even though the runtime still needs the file to
 * exist. Recognizes three reference shapes:
 *
 *   A. Any path whose segments include `workflows/`, optionally preceded by
 *      an eager `@`, a home-dir prefix (`~/` or `$HOME/`), `.claude/`, and/or
 *      `gsd-core/` — e.g. `@~/.claude/gsd-core/workflows/scan.md`,
 *      `gsd-core/workflows/x.md`, or a bare `workflows/x.md`.
 *   B. Same as A but without the eager `@` — a lazy reference read on
 *      demand rather than inlined at load time.
 *   C. Parent-relative sub-file paths with no `workflows/` prefix at all —
 *      `execute-phase/steps/post-merge-gate.md` — implicitly rooted under
 *      `workflows/` because that's the only place `steps/`, `modes/`, and
 *      `templates/` subdirectories live.
 *
 * Traversal segments (`..`) are dropped rather than surfaced: this resolver
 * only ever reports paths under `workflows/`, never something a `..` could
 * walk outside of it. Results are de-duplicated, first-seen order preserved.
 *
 * Both regexes anchor `\.md` with a trailing `(?![A-Za-z0-9_])` negative
 * lookahead so a longer extension (`.mdx`, `.md5`) is rejected outright
 * rather than silently truncated into a plausible-looking `.md` path.
 */
function workflowPathRefs(content) {
  const refs = [];
  const seen = new Set();

  function addRef(normalized) {
    if (normalized.split('/').includes('..')) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    refs.push(normalized);
  }

  const shapeARe = /@?(?:(?:~|\$HOME)\/)?(?:\.claude\/)?(?:gsd-core\/)?workflows\/[A-Za-z0-9._/-]+\.md(?![A-Za-z0-9_])/g;
  let m;
  while ((m = shapeARe.exec(content)) !== null) {
    const normalized = m[0]
      .replace(/^@/, '')
      .replace(/^(?:~|\$HOME)\//, '')
      .replace(/^\.claude\//, '')
      .replace(/^gsd-core\//, '');
    addRef(normalized);
  }

  const shapeCRe = /(?:^|[\s`("'>])([A-Za-z0-9._-]+\/(?:steps|modes|templates)\/[A-Za-z0-9._-]+\.md(?![A-Za-z0-9_]))/gm;
  while ((m = shapeCRe.exec(content)) !== null) {
    addRef('workflows/' + m[1]);
  }

  return refs;
}

/**
 * unreachableWorkflows(loaderContents, gsdFiles, workflowPaths)
 *
 * Computes reachability over the gsd-core file graph and reports which
 * `workflowPaths` are never reached, starting only from `loaderContents`
 * (commands/agents/skills — the files a runtime actually loads) and walking
 * `workflowPathRefs` edges transitively through `gsdFiles`.
 *
 * The seed set is deliberately restricted to loaders and never includes a
 * workflow's own content. Seeding from workflows too would let two failure
 * modes hide: a workflow that only references itself would satisfy its own
 * reachability, and a pair of workflows that reference only each other would
 * form an island that looks connected from the inside but that no command,
 * agent, or skill ever actually opens. Both are orphans in every sense that
 * matters — nothing external can reach them — and both must be reported.
 * Requiring every path to originate at a loader is what makes "reachable"
 * mean "a runtime can actually get here," not merely "something points to
 * it."
 *
 * `gsdFiles` covers all of `gsd-core/**`, not just `workflows/`, because a
 * `references/` or `templates/` file can itself name a workflow path and
 * needs to be walked through to propagate reachability — restricting the map
 * to `workflows/` would silently break any chain that passes through a
 * non-workflow file.
 *
 * `visited` guards the walk against reference cycles (including the
 * mutual/self cases above) so traversal always terminates.
 */
function unreachableWorkflows(loaderContents, gsdFiles, workflowPaths) {
  const visited = new Set();
  const queue = [];

  for (const content of loaderContents) {
    for (const ref of workflowPathRefs(content)) queue.push(ref);
  }

  while (queue.length > 0) {
    const p = queue.pop();
    if (visited.has(p)) continue;
    visited.add(p);
    if (gsdFiles.has(p)) {
      for (const ref of workflowPathRefs(gsdFiles.get(p))) queue.push(ref);
    }
  }

  return workflowPaths.filter(p => !visited.has(p));
}

/**
 * splitOutsideDelimiter(str, delimiter)
 *
 * Splits `str` on `delimiter` characters that fall outside any backtick
 * span AND outside any parenthetical span. A backtick toggles an "inside a
 * code span" flag; `(` / `)` track nesting depth. Delimiters seen while
 * inside either construct are treated as literal content rather than split
 * points. Used both for comma-splitting a completion-markers cell and for
 * pipe-splitting a table row, so a marker annotation
 * (`(unconsumed: draft presentation, approved interactively)`) or a path
 * that happens to contain the delimiter inside backticks or parens is never
 * torn in half.
 */
function splitOutsideDelimiter(str, delimiter) {
  const parts = [];
  let cur = '';
  let inBacktick = false;
  let parenDepth = 0;
  for (const ch of str) {
    if (ch === '`') inBacktick = !inBacktick;
    if (!inBacktick) {
      if (ch === '(') parenDepth += 1;
      else if (ch === ')' && parenDepth > 0) parenDepth -= 1;
    }
    if (ch === delimiter && !inBacktick && parenDepth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return splitOutsideDelimiter(s, '|').map(c => c.trim());
}

function isSeparatorRow(line) {
  const t = line.trim();
  return t.length > 0 && /^[|:\- ]+$/.test(t) && t.includes('-');
}

/**
 * parseCompletionMarkersCell(value)
 *
 * Parses one `Completion Markers` table cell into `{markers, notes}`.
 * Entries are comma-separated OUTSIDE backticks (so a marker's own text
 * never leaks a split point). Each entry is stripped of a trailing
 * parenthetical annotation (`(title case)`, `(non-standard)`, ...) — that
 * annotation is captured into `notes` rather than the marker text — then
 * stripped of surrounding backticks and a leading `## ` heading prefix. A
 * bare `No marker` entry (post-annotation-strip) contributes nothing to
 * `markers`; its parenthetical still lands in `notes`.
 */
function parseCompletionMarkersCell(value) {
  const markers = [];
  const notes = [];
  const unconsumedMarkers = [];
  if (!value) return { markers, notes, unconsumedMarkers };
  const entries = splitOutsideDelimiter(value, ',');
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (entry === '') continue;
    let markerPortion = entry;
    let annotation = null;
    const noteMatch = entry.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    if (noteMatch) {
      markerPortion = noteMatch[1].trim();
      annotation = noteMatch[2].trim();
      notes.push(annotation);
    }
    markerPortion = markerPortion.replace(/`/g, '').trim();
    markerPortion = markerPortion.replace(/^#{1,6}\s+/, '').trim();
    if (markerPortion === '' || markerPortion === 'No marker') continue;
    // An `(unconsumed: <reason>)` annotation declares a marker that is
    // emitted deliberately but matched by no consumer (e.g. a user-facing
    // presentation format). It stays in the declared+emitted contract and in
    // case-collision scope; only the consumer requirement is waived.
    if (annotation !== null && /^unconsumed\b/i.test(annotation)) {
      unconsumedMarkers.push(markerPortion);
      continue;
    }
    markers.push(markerPortion);
  }
  return { markers, notes, unconsumedMarkers };
}

/**
 * extractMarkers(content, knownMarkers)
 *
 * Scans a markdown string line by line for H1-H6 headings, and reports
 * whether each heading sits inside a fenced code block. A heading counts as
 * a marker only when its captured text EXACTLY matches (case-sensitively)
 * one of `knownMarkers` — the declared vocabulary from the agent-contracts
 * registry, supplied by the caller. There is deliberately no shape
 * heuristic (e.g. "ends in COMPLETE") here: the registry already declares
 * every marker string, several of which do NOT end in COMPLETE (`##
 * ISSUES FOUND`, `## ROADMAP CREATED`, `## CHECKPOINT REACHED`, `##
 * ESCALATE`, ...), so guessing the shape both over-matches ordinary prose
 * headings that happen to look marker-shaped and under-matches every real
 * marker that doesn't end in the word COMPLETE. When `knownMarkers` is
 * omitted or empty, `markers` is always `[]` — this function never falls
 * back to guessing.
 *
 * `candidates` separately reports in-fence headings that are NOT in
 * `knownMarkers` but still look marker-shaped (`/^[A-Z][A-Z0-9 _:'\/-]*$/`,
 * no backticks, <= 60 chars) — these feed the `emitted_marker_not_declared`
 * check. They are reported as candidates, never silently treated as
 * markers.
 *
 * Fence tracking is a single boolean, not a stack: a line whose trimmed
 * form starts with a run of 3+ backticks or tildes toggles it, but only a
 * closing run of the SAME character and AT LEAST the same length actually
 * closes an open fence — a shorter or differently-charred run nested inside
 * (e.g. a 3-backtick span shown inside a 4-backtick outer fence) is inert
 * and leaves the outer fence open. `unclosedFence` reports when the file
 * ends without ever closing the last-opened fence, so callers can tell a
 * truncated/malformed file from one that's actually well-formed.
 */
function extractMarkers(content, knownMarkers) {
  const markers = [];
  const candidates = [];
  if (content == null || typeof content !== 'string' || content.trim() === '') {
    return { markers, candidates, unclosedFence: false };
  }

  const known = new Set(knownMarkers || []);
  const lines = content.split(/\r?\n/);
  const headingRe = /^(#{1,6})\s+(\S.*?)\s*$/;
  const candidateShapeRe = /^[A-Z][A-Z0-9 _:'/-]*$/;

  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const stateForThisLine = inFence;

    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const runChar = fenceMatch[1][0];
      const runLen = fenceMatch[1].length;
      if (!inFence) {
        inFence = true;
        fenceChar = runChar;
        fenceLen = runLen;
      } else if (runChar === fenceChar && runLen >= fenceLen) {
        inFence = false;
        fenceChar = null;
        fenceLen = 0;
      }
      // else: nested/mismatched run — does not close the outer fence.
    }

    const hm = line.match(headingRe);
    if (hm) {
      const text = hm[2].trim();
      if (known.has(text)) {
        markers.push({ marker: text, inFence: stateForThisLine, line: i + 1 });
      } else if (stateForThisLine && text.length <= 60 && candidateShapeRe.test(text)) {
        candidates.push({ marker: text, inFence: stateForThisLine, line: i + 1 });
      }
    }
  }

  return { markers, candidates, unclosedFence: inFence };
}

/**
 * parseAgentContracts(markdown)
 *
 * Parses the `## Agent Registry` pipe table in
 * gsd-core/references/agent-contracts.md into structured rows, keyed by
 * lowercased, underscore-joined column headers (`Completion Markers` ->
 * `completion_markers`). Column set is read from the header row itself, so
 * the table can grow a `Consumed By` / `Kind` column later without this
 * parser needing an update — rows simply gain the corresponding key.
 *
 * The `completion_markers` column gets special handling via
 * parseCompletionMarkersCell: it is never a plain string on the returned
 * row, always the parsed `{markers}` array (with any parenthetical
 * annotation split out into a row-level `notes` array instead).
 *
 * Malformed rows (wrong cell count for the header, or an empty agent name)
 * are reported in `errors` as `{line, reason}` and excluded from `rows`
 * rather than thrown.
 */
function parseAgentContracts(markdown) {
  const rows = [];
  const errors = [];
  if (markdown == null || typeof markdown !== 'string') return { rows, errors };

  const lines = markdown.split(/\r?\n/);
  const registryIdx = lines.findIndex(l => /^##\s+Agent Registry\s*$/.test(l.trim()));
  if (registryIdx === -1) return { rows, errors };

  let i = registryIdx + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !lines[i].trim().startsWith('|')) return { rows, errors };

  const columnKeys = splitTableRow(lines[i]).map(h =>
    h.trim().toLowerCase().replace(/\s+/g, '_')
  );
  i++;
  if (i < lines.length && isSeparatorRow(lines[i])) i++;

  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim().startsWith('|')) break;

    const lineNum = i + 1;
    const cells = splitTableRow(raw);
    if (cells.length !== columnKeys.length) {
      errors.push({
        line: lineNum,
        reason: `column count mismatch: expected ${columnKeys.length}, got ${cells.length}`,
      });
      continue;
    }

    const row = {};
    for (let j = 0; j < columnKeys.length; j++) {
      const key = columnKeys[j];
      const value = cells[j];
      if (key === 'completion_markers') {
        const parsed = parseCompletionMarkersCell(value);
        row.completion_markers = parsed.markers;
        row.notes = parsed.notes;
        row.unconsumed_markers = parsed.unconsumedMarkers;
      } else {
        row[key] = value;
      }
    }

    if (!row.agent) {
      errors.push({ line: lineNum, reason: 'empty agent name' });
      continue;
    }

    rows.push(row);
  }

  return { rows, errors };
}

const CONTRACT_KINDS = new Set(['sentinel-match', 'artifact+query', 'structured-return']);

/**
 * contractViolations({registry, producerMarkers, candidateMarkers, consumerTexts})
 *
 * Cross-checks the agent-contracts registry (from parseAgentContracts)
 * against what agent files actually emit in-fence (from extractMarkers) and
 * what every workflow/command/agent file actually consumes, exact-case.
 * Rows are evaluated independently; `registry`, `producerMarkers`,
 * `candidateMarkers`, and `consumerTexts` default to empty when omitted so a
 * partial call never throws.
 *
 * `emitted_marker_not_declared` is driven by `candidateMarkers` (agent ->
 * [in-fence heading text]) rather than `producerMarkers` -- a heading only
 * lands in `producerMarkers` once it already matches a KNOWN registry
 * marker (see extractMarkers), so it can never be "emitted but undeclared";
 * `candidateMarkers` is exactly the set of marker-shaped in-fence headings
 * extractMarkers could NOT resolve against the known vocabulary.
 *
 * A row declaring `kind: 'artifact+query'` or `'structured-return'` opts
 * out of the sentinel-marker contract entirely — its only possible
 * violation is `vestigial_marker` (it still emits an in-fence marker
 * despite the row saying completion isn't detected that way). Every other
 * row (kind `sentinel-match`, or the column simply absent/empty) is held to
 * the full contract: declared markers must be emitted, emitted markers must
 * be declared, and — for sentinel-match rows specifically — every declared
 * marker must have at least one EXACT-CASE consumer somewhere in
 * `consumerTexts`, excluding the producing agent's own file (an agent can
 * never satisfy its own marker, even when the same map entry also serves as
 * a consumer of some OTHER agent's marker). A case-insensitive-only match
 * is reported (`case_only_match`), never treated as satisfying the
 * contract. `case_collision` is computed once across the whole registry,
 * independent of kind, since two markers differing only by case is a
 * registry-wide authoring hazard.
 */
function contractViolations({ registry, producerMarkers, candidateMarkers, consumerTexts } = {}) {
  const violations = [];
  try {
    const rows = Array.isArray(registry) ? registry : [];
    const producers = producerMarkers instanceof Map ? producerMarkers : new Map();
    const candidatesByAgent = candidateMarkers instanceof Map ? candidateMarkers : new Map();
    const consumers = consumerTexts instanceof Map ? consumerTexts : new Map();

    // case_collision — global, across every declared marker in the registry,
    // including `(unconsumed: …)` entries: a case-variant of an unconsumed
    // marker is still an authoring hazard even though no consumer matches it.
    const byLower = new Map();
    for (const row of rows) {
      for (const m of [...(row.completion_markers || []), ...(row.unconsumed_markers || [])]) {
        const lower = m.toLowerCase();
        if (!byLower.has(lower)) byLower.set(lower, new Set());
        byLower.get(lower).add(m);
      }
    }
    for (const row of rows) {
      for (const m of [...(row.completion_markers || []), ...(row.unconsumed_markers || [])]) {
        const variants = byLower.get(m.toLowerCase());
        if (variants && variants.size > 1) {
          const others = [...variants].filter(v => v !== m);
          violations.push({
            kind: 'case_collision',
            agent: row.agent,
            marker: m,
            detail: `case-insensitive collision with: ${others.join(', ')}`,
          });
        }
      }
    }

    // roster coverage — the registry is the declaration of record for every
    // agents/*.md file: an agent with no row, two rows for one agent, or a
    // row naming an agent that does not exist are all contract drift. The
    // roster is the producer map's key set; guards on map size keep empty
    // inputs inert rather than spuriously "missing".
    const seenAgents = new Set();
    for (const row of rows) {
      const agent = row.agent;
      if (seenAgents.has(agent)) {
        violations.push({
          kind: 'duplicate_registry_row',
          agent,
          marker: null,
          detail: `agent "${agent}" has more than one registry row`,
        });
      }
      seenAgents.add(agent);
      if (producers.size > 0 && !producers.has(agent)) {
        violations.push({
          kind: 'unknown_producer',
          agent,
          marker: null,
          detail: `registry row for "${agent}" but no agents/${agent}.md exists`,
        });
      }
    }
    for (const agent of producers.keys()) {
      if (!seenAgents.has(agent)) {
        violations.push({
          kind: 'agent_without_contract',
          agent,
          marker: null,
          detail: `agents/${agent}.md exists but has no registry row in agent-contracts.md`,
        });
      }
    }

    for (const row of rows) {
      const agent = row.agent;
      const declared = row.completion_markers || [];
      const unconsumed = row.unconsumed_markers || [];
      const declaredAll = [...declared, ...unconsumed];
      // Deduped: the same marker emitted on several lines/files is one
      // emission fact, never several violations.
      const produced = [...new Set(producers.get(agent) || [])];
      const kind = row.kind;
      const kindProvided = kind !== undefined && kind !== null && kind !== '';

      // A row naming a nonexistent agent file: unknown_producer (above) is
      // the violation; per-marker noise on top of it hides nothing.
      if (producers.size > 0 && !producers.has(agent)) continue;

      // unknown_consumer — the `Consumed by` column feeds readTagViolations,
      // so a file-shaped entry that resolves to nothing would make that arm a
      // lint over fiction. Only checked when a consumer corpus was supplied.
      for (const p of parseConsumedByCell(row.consumed_by)) {
        if (consumers.size > 0 && !consumers.has(p)) {
          violations.push({
            kind: 'unknown_consumer',
            agent,
            marker: null,
            detail: `Consumed by names "${p}" but no such file exists`,
          });
        }
      }

      if (kindProvided && !CONTRACT_KINDS.has(kind)) {
        violations.push({
          kind: 'unknown_kind',
          agent,
          marker: null,
          detail: `row declares unknown kind "${kind}"`,
        });
      }

      const isArtifactOrStructured =
        kindProvided && (kind === 'artifact+query' || kind === 'structured-return');

      // declaredAll includes unconsumed entries: an `(unconsumed: …)` marker
      // must still be emitted — the exemption waives the consumer
      // requirement only, never the declared↔emitted agreement (Marker
      // Rule 7). This runs for EVERY row kind.
      for (const m of declaredAll) {
        if (!produced.includes(m)) {
          violations.push({
            kind: 'declared_marker_not_emitted',
            agent,
            marker: m,
            detail: `declared in registry but not emitted in-fence by ${agent}`,
          });
        }
      }

      if (isArtifactOrStructured) {
        // An `(unconsumed: …)` annotation on an artifact/structured row is a
        // recorded decision to keep emitting a marker the completion route
        // doesn't need (Marker Rule 2's intentional title-case markers) —
        // exempt from vestigial_marker. Every OTHER emitted marker on such a
        // row is reported ONCE, as vestigial_marker: the candidate check
        // below is skipped for these rows because emitted_marker_not_declared
        // on top of vestigial_marker double-reports the same fact, and the
        // consumer contract cannot apply to a row whose completion is not
        // detected by marker matching at all.
        const unconsumedSet = new Set(unconsumed);
        for (const m of produced) {
          if (unconsumedSet.has(m)) continue;
          violations.push({
            kind: 'vestigial_marker',
            agent,
            marker: m,
            detail: `row kind "${kind}" expects no marker, but agent still emits "${m}" in-fence`,
          });
        }
        continue;
      }

      // Deduped per marker: "emitted but undeclared" is a fact about the
      // marker, and a caller-supplied list carrying the same marker twice
      // (two template lines, or agent file + @-included reference) is one
      // violation, not two.
      const candidates = [...new Set(candidatesByAgent.get(agent) || [])];
      for (const m of candidates) {
        if (!declaredAll.includes(m)) {
          violations.push({
            kind: 'emitted_marker_not_declared',
            agent,
            marker: m,
            detail: `emitted in-fence by ${agent} but absent from its registry row`,
          });
        }
      }

      const isSentinelMatchKind = !kindProvided || kind === 'sentinel-match';
      if (isSentinelMatchKind) {
        // Only markers the agent actually emits participate in the consumer
        // contract — a declared_marker_not_emitted finding already covers a
        // phantom declaration, and stacking no_consumer on top of it is
        // double-reporting the same dead row.
        const declaredConsumerPaths = parseConsumedByCell(row.consumed_by);
        for (const m of declared) {
          if (!produced.includes(m)) continue;
          let exactMatch = false;
          let caseInsensitiveMatch = false;
          let declaredConsumerMatch = false;
          for (const [consumerId, text] of consumers.entries()) {
            // consumerTexts is keyed by repo-relative path — an agent's own
            // file is 'agents/<name>.md'. The producer's own template can
            // never satisfy its marker.
            if (consumerId === `agents/${agent}.md`) continue;
            if (typeof text !== 'string') continue;
            if (text.includes(m)) {
              exactMatch = true;
              if (declaredConsumerPaths.includes(consumerId)) declaredConsumerMatch = true;
            } else if (text.toLowerCase().includes(m.toLowerCase())) {
              caseInsensitiveMatch = true;
            }
          }
          if (!exactMatch) {
            if (caseInsensitiveMatch) {
              violations.push({
                kind: 'case_only_match',
                agent,
                marker: m,
                detail: `no exact-case consumer for "${m}"; case-insensitive match found only`,
              });
            } else {
              violations.push({
                kind: 'no_consumer',
                agent,
                marker: m,
                detail: `no consumer text contains "${m}" (exact case)`,
              });
            }
          } else if (
            declaredConsumerPaths.length > 0 &&
            !declaredConsumerMatch
          ) {
            // The marker IS consumed somewhere, but by none of the consumers
            // the row cites — the `Consumed by` cell is documentation the
            // read-tag arm and humans both navigate by, so a cell naming
            // files that never match is registry drift even when the corpus
            // at large happens to contain the token.
            violations.push({
              kind: 'declared_consumer_no_match',
              agent,
              marker: m,
              detail: `consumed somewhere, but none of the row's Consumed by entries ( ${declaredConsumerPaths.join(', ')} ) contain "${m}"`,
            });
          }
        }
      }
    }
  } catch (e) {
    // A drift gate must fail RED, never green: an internal error here must
    // surface, not be swallowed into '0 violations'.
    e.message = `contractViolations (internal failure — failing red): ${e.message}`;
    throw e;
  }
  return violations;
}

/**
 * parseConsumedByCell(value)
 *
 * Extracts every file-shaped path from a `Consumed by` table cell. Cell
 * entries are comma-separated outside backticks, and an entry may carry
 * several backtick-wrapped tokens (a path, a command, a marker string) in
 * prose — so every backtick span is inspected and only tokens that look like
 * repo-relative markdown paths (`^[\w][\w./-]*\.md$` — no spaces, no glob
 * stars) are returned. A glob (`*-VERIFICATION.md`) or a command
 * (`gsd_run query verification.status`) describes the consumption mechanism
 * in prose; it is not a file the check can open, and is ignored.
 */
function parseConsumedByCell(value) {
  if (!value || typeof value !== 'string') return [];
  const paths = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    const token = m[1].trim();
    if (!/^[\w][\w./-]*\.md$/.test(token) || token.includes('*')) continue;
    // Traversal segments are dropped, never surfaced — the same rule
    // workflowPathRefs applies to its refs: this resolver only ever reports
    // paths inside the repo, never something a `..` could walk outside of
    // (the driver reads these paths under --root, so an interior `..` would
    // be an out-of-root file read).
    if (token.split('/').includes('..')) continue;
    paths.push(token);
  }
  return paths;
}

/**
 * readTagViolations({registry, agentTexts, consumerTexts})
 *
 * The read-tag arm — F8 one layer up. Two invariants:
 *
 *   legacy_read_tag — no `<files_to_read>` may survive anywhere in the
 *   consumer corpus (workflows/, commands/, agents/). #3423 standardized on
 *   `<required_reading>` and retired the old vocabulary via a test; this
 *   folds that assertion into the gate itself.
 *
 *   read_tag_gate_missing — for every registry row, every file-shaped
 *   `Consumed by` consumer that itself emits `<required_reading>` requires
 *   the producing agent's file to reference `<required_reading>`. A spawner
 *   that sends a required-reading block to an agent whose instructions never
 *   mention the gate is exactly the F8 shape: the emit side is correct, the
 *   gate side never fires — and #3423's per-agent test cannot see it,
 *   because an agent carrying no reading instruction at all is skipped by
 *   it. The registry supplies the producer↔consumer pair, so this check
 *   needs no spawn-site parsing heuristics.
 */
function readTagViolations({ registry, agentTexts, consumerTexts } = {}) {
  const violations = [];
  try {
    const rows = Array.isArray(registry) ? registry : [];
    const agents = agentTexts instanceof Map ? agentTexts : new Map();
    const consumers = consumerTexts instanceof Map ? consumerTexts : new Map();

    for (const [file, text] of consumers.entries()) {
      if (typeof text === 'string' && text.includes('<files_to_read>')) {
        violations.push({
          kind: 'legacy_read_tag',
          agent: null,
          marker: null,
          detail: `${file} still contains the retired <files_to_read> tag`,
        });
      }
    }

    for (const row of rows) {
      const agent = row.agent;
      const agentText = agents.get(agent);
      if (typeof agentText !== 'string') continue; // unknown_producer reports this
      if (agentText.includes('<required_reading>')) continue;
      for (const p of parseConsumedByCell(row.consumed_by)) {
        const text = consumers.get(p);
        if (typeof text === 'string' && text.includes('<required_reading>')) {
          violations.push({
            kind: 'read_tag_gate_missing',
            agent,
            marker: null,
            detail: `consumer ${p} emits <required_reading> but agents/${agent}.md never references the gate`,
          });
          break; // one violation per agent is the fact; more is noise
        }
      }
    }
  } catch (e) {
    // A drift gate must fail RED, never green: an internal error here must
    // surface, not be swallowed into '0 violations'.
    e.message = `readTagViolations (internal failure — failing red): ${e.message}`;
    throw e;
  }
  return violations;
}

/**
 * Tokens that look like completion markers but are NOT agent contracts, and
 * therefore exempt from the reverse-direction check. Each entry carries its
 * justification inline; a test locks the set's membership so it cannot grow
 * silently.
 */
const NON_AGENT_TOKENS = new Set([
  // Display headings the /gsd:graphify command itself renders from
  // `gsd_run graphify build` CLI output — tool output shown to the user,
  // not an agent return any spawner dispatches on.
  'GRAPHIFY BUILD COMPLETE',
  'GRAPHIFY BUILD FAILED',
]);

/**
 * unmatchedConsumerTokens({consumerTexts, vocabulary})
 *
 * The reverse direction of the registry contract: a consumer that matches a
 * `## TOKEN` string no producer emits is dispatch-on-phantom — F9's shape
 * (a sanctioned return that no dispatch branch ever keyed on), seen from
 * the consumer side. Scans ONLY workflow/command files (the dispatch
 * surfaces); `agents/` is excluded because an agent mentioning a token in
 * its own file is a self-description, not a spawner's match instruction —
 * the forward direction already validates agent-to-agent consumption.
 *
 * A token is extracted when it appears quoted (`## X`, "## X", '## X') —
 * the shape a match/dispatch instruction actually writes — is ALL-CAPS
 * marker-shaped (the same candidate shape extractMarkers uses, ≤60 chars),
 * is absent from the declared vocabulary, and is not exempt via
 * NON_AGENT_TOKENS.
 */
function unmatchedConsumerTokens({ consumerTexts, vocabulary } = {}) {
  const violations = [];
  try {
    const consumers = consumerTexts instanceof Map ? consumerTexts : new Map();
    const known = vocabulary instanceof Set ? vocabulary : new Set(knownMarkersArray(vocabulary));
    const shapeRe = /^[A-Z][A-Z0-9 _:'/-]*$/;
    const tokenRe = /[`'"]## ([^`'"\n]+)[`'"]/g;

    const reported = new Set();
    for (const [file, text] of consumers.entries()) {
      if (!file.startsWith('gsd-core/workflows/') && !file.startsWith('commands/')) continue;
      if (typeof text !== 'string') continue;
      tokenRe.lastIndex = 0;
      let m;
      while ((m = tokenRe.exec(text)) !== null) {
        const token = m[1].trim();
        if (known.has(token)) continue;
        if (NON_AGENT_TOKENS.has(token)) continue;
        if (token.length > 60 || !shapeRe.test(token)) continue;
        const key = `${file}\0${token}`;
        if (reported.has(key)) continue;
        reported.add(key);
        violations.push({
          kind: 'unmatched_consumer_token',
          agent: null,
          marker: token,
          detail: `${file} matches \`## ${token}\` but no agent declares or emits it`,
        });
      }
    }
  } catch (e) {
    // A drift gate must fail RED, never green: an internal error here must
    // surface, not be swallowed into '0 violations'.
    e.message = `unmatchedConsumerTokens (internal failure — failing red): ${e.message}`;
    throw e;
  }
  return violations;
}

function knownMarkersArray(vocabulary) {
  // vocabulary may arrive as an array (tests) — normalize; the Set branch
  // above handles the driver's Set.
  return Array.isArray(vocabulary) ? vocabulary : [];
}

/**
 * The frozen violation-kind vocabulary — one entry per finding the check
 * can emit. Tests lock this set and the driver's REMEDIES parity, so a new
 * kind is three coordinated changes: enum + remedy + test, the same
 * discipline verify-reapply-patches' REASON enum follows.
 */
const VIOLATION_KINDS = Object.freeze({
  PARSE_ERROR: 'parse_error',
  UNCLOSED_FENCE: 'unclosed_fence',
  DECLARED_MARKER_NOT_EMITTED: 'declared_marker_not_emitted',
  EMITTED_MARKER_NOT_DECLARED: 'emitted_marker_not_declared',
  CASE_COLLISION: 'case_collision',
  CASE_ONLY_MATCH: 'case_only_match',
  NO_CONSUMER: 'no_consumer',
  DECLARED_CONSUMER_NO_MATCH: 'declared_consumer_no_match',
  UNKNOWN_KIND: 'unknown_kind',
  VESTIGIAL_MARKER: 'vestigial_marker',
  AGENT_WITHOUT_CONTRACT: 'agent_without_contract',
  DUPLICATE_REGISTRY_ROW: 'duplicate_registry_row',
  UNKNOWN_PRODUCER: 'unknown_producer',
  UNKNOWN_CONSUMER: 'unknown_consumer',
  LEGACY_READ_TAG: 'legacy_read_tag',
  READ_TAG_GATE_MISSING: 'read_tag_gate_missing',
  UNMATCHED_CONSUMER_TOKEN: 'unmatched_consumer_token',
});

/**
 * The remedy shown per violation kind — one entry per VIOLATION_KINDS value.
 * The parity test locks REMEDIES keys against VIOLATION_KINDS values, so a
 * new kind cannot ship without its remedy.
 */
const REMEDIES = Object.freeze({
  parse_error: 'fix the malformed row in gsd-core/references/agent-contracts.md',
  unclosed_fence: 'close the unterminated code fence in this agent file',
  declared_marker_not_emitted:
    'remove the marker from the registry row, or emit it as an in-fence example in the agent file',
  emitted_marker_not_declared:
    "add this marker to the agent's Completion Markers cell in the registry table",
  case_collision: 'rename one of the colliding markers so they no longer differ only by case',
  case_only_match:
    'fix the consumer file to match this marker exact-case, or update the marker/registry to match the consumer',
  no_consumer:
    'add an exact-case consumer for this marker, or reclassify the row Kind to artifact+query/structured-return',
  declared_consumer_no_match:
    "the marker is consumed, but not by any file the row's Consumed by cell names — fix the cell to name a real consumer",
  unknown_kind: 'set the Kind column to one of sentinel-match, artifact+query, structured-return',
  vestigial_marker:
    "remove this marker heading from the agent file, since the row's Kind says no marker is expected",
  agent_without_contract: 'add a registry row for this agent in agent-contracts.md',
  duplicate_registry_row: 'merge the two rows for this agent into one',
  unknown_producer: 'remove the row, or create the agents/<name>.md file it names',
  unknown_consumer:
    'fix the path in the Consumed by cell, or drop it — only real files the check can open belong there',
  legacy_read_tag:
    'replace <files_to_read> with <required_reading> (#3423 standardized on the gate tag)',
  read_tag_gate_missing:
    "add the <required_reading> MUST-Read gate clause to this agent's instructions (see docs/AGENTS.md)",
  unmatched_consumer_token:
    'declare the producing agent and marker in the registry, or remove the dispatch — nothing emits this token',
});

/**
 * sanitizeEcho(text)
 *
 * File-derived strings (registry cells, marker tokens, workflow text) are
 * echoed into lint output that AI agents read as trusted instructions —
 * every interpolated field is control-char-stripped and length-capped
 * before it is written, so a malicious repo file cannot make the lint emit
 * instruction-shaped text. Implemented as a code-point filter rather than a
 * regex so no control-character regex literal exists to lint.
 */
function sanitizeEcho(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) continue;
    out += ch;
  }
  return out.length > 200 ? out.slice(0, 200) : out;
}

module.exports = {
  CANONICAL_TOOLS,
  parseFrontmatter,
  executionContextRefs,
  workflowPathRefs,
  unreachableWorkflows,
  extractMarkers,
  parseAgentContracts,
  contractViolations,
  parseConsumedByCell,
  readTagViolations,
  unmatchedConsumerTokens,
  NON_AGENT_TOKENS,
  VIOLATION_KINDS,
  REMEDIES,
  sanitizeEcho,
};
