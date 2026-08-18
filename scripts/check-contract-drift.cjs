#!/usr/bin/env node
/**
 * check-contract-drift.cjs
 *
 * Enforces that gsd-core/references/agent-contracts.md's `## Agent Registry`
 * table stays in sync with reality:
 *
 *   1. The table itself must parse cleanly (no malformed rows).
 *   2. Every agents/*.md file must have its fenced code blocks properly
 *      closed (an unclosed fence makes in-fence marker detection unreliable).
 *   3. Every marker an agent actually emits in-fence, and every marker the
 *      registry declares for it, must agree (contractViolations' declared/
 *      emitted checks) -- unless the row opts out via `kind:
 *      artifact+query`/`structured-return`, in which case any emitted
 *      marker is itself a violation (vestigial_marker).
 *   4. Every `sentinel-match` row's declared markers must have at least one
 *      exact-case consumer somewhere under gsd-core/workflows/, commands/,
 *      or agents/ (excluding the producing agent's own file).
 *   5. Registry roster coverage: every agents/*.md file has exactly one
 *      row, every row names an agent file that exists
 *      (agent_without_contract / duplicate_registry_row / unknown_producer),
 *      and every file-shaped `Consumed by` entry resolves (unknown_consumer).
 *   6. Read-tag arm: no `<files_to_read>` survives anywhere in the consumer
 *      corpus (legacy_read_tag), and whenever a declared consumer emits
 *      `<required_reading>` the producing agent's file must reference the
 *      gate (read_tag_gate_missing).
 *   7. Reverse direction: a workflow/command matching a quoted `## TOKEN`
 *      no agent declares or emits is dispatch-on-phantom
 *      (unmatched_consumer_token) — F9's shape from the consumer side.
 *
 * Exit 0 = clean. Exit 1 = violations (with diagnostics on stderr).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function resolveRoot(argv) {
  const idx = argv.indexOf('--root');
  if (idx === -1) return path.join(__dirname, '..');
  const value = argv[idx + 1];
  if (!value) {
    throw new Error('check-contract-drift: --root requires a directory argument');
  }
  return path.resolve(value);
}

const ROOT           = resolveRoot(process.argv.slice(2));
const CONTRACTS_FILE = path.join(ROOT, 'gsd-core', 'references', 'agent-contracts.md');
const AGENTS_DIR      = path.join(ROOT, 'agents');
const WORKFLOWS_DIR    = path.join(ROOT, 'gsd-core', 'workflows');
const COMMANDS_DIR     = path.join(ROOT, 'commands');

const {
  extractMarkers,
  parseAgentContracts,
  contractViolations,
  readTagViolations,
  parseConsumedByCell,
  unmatchedConsumerTokens,
  sanitizeEcho,
  REMEDIES,
} = require('./command-contract-helpers.cjs');

const { runMain } = require('./lib/cli-exit.cjs');

// ─── helpers ────────────────────────────────────────────────────────────────

function walkMarkdownFiles(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

function toRepoRelative(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

/**
 * referenceIncludes(content)
 *
 * Plain scan for `@~/.claude/gsd-core/references/*.md` tokens anywhere in an
 * agent file's content -- inside an `<execution_context>` block (already
 * covered structurally by `executionContextRefs` in command-contract-helpers,
 * but a raw regex over the whole string picks those up too) and, just as
 * importantly, OUTSIDE one: agents frequently point at a reference doc from
 * plain prose (e.g. "See @~/.claude/gsd-core/references/planner-guidance.md
 * for ...") rather than from the eager `<execution_context>` include list.
 * An agent's completion-marker contract can be authored in such a reference
 * file rather than the agent file itself -- gsd-planner declares
 * `PLANNING COMPLETE` in its registry row, but the example heading itself
 * lives in `gsd-core/references/planner-guidance.md`, which the agent only
 * `@`-includes -- so the producer scan below must follow these includes to
 * see markers an agent's contract legitimately delegates to a reference doc.
 * Returns ROOT-relative paths (`gsd-core/references/foo.md`), de-duplicated.
 */
function referenceIncludes(content) {
  const seen = new Set();
  const re = /@~\/\.claude\/gsd-core\/references\/[A-Za-z0-9._-]+\.md/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const relPath = 'gsd-core/references/' + m[0].slice('@~/.claude/gsd-core/references/'.length);
    seen.add(relPath);
  }
  return [...seen];
}

function remedyFor(kind) {
  return REMEDIES[kind] || 'review the registry row and agent file for drift';
}

// ─── run ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(CONTRACTS_FILE)) {
    process.stderr.write(`\nERROR check-contract-drift: contracts file not found at ${toRepoRelative(CONTRACTS_FILE)}\n\n`);
    return 1;
  }

  const contractsMd = fs.readFileSync(CONTRACTS_FILE, 'utf-8');
  const { rows: registry, errors: parseErrors } = parseAgentContracts(contractsMd);

  // knownMarkers: every marker string declared anywhere in the registry --
  // extractMarkers only ever resolves a heading against this vocabulary, it
  // never falls back to guessing a shape. Includes `(unconsumed: …)` entries
  // so their declared↔emitted agreement is checked too.
  const knownMarkers = new Set();
  for (const row of registry) {
    for (const m of row.completion_markers || []) knownMarkers.add(m);
    for (const m of row.unconsumed_markers || []) knownMarkers.add(m);
  }

  // producerMarkers: agent -> [in-fence marker strings that matched knownMarkers]
  // candidateMarkers: agent -> [in-fence marker-shaped headings NOT in knownMarkers,
  //   deduped per marker — "emitted but undeclared" is a fact about the
  //   marker, not about each line or file it appears in]
  // agentTexts: agent -> file content CONCATENATED with every
  // references/*.md file the agent @-includes, for the read-tag arm's gate
  // check. The fold is load-bearing: planner/executor/phase-researcher
  // deliver the MUST-Read gate via the shared mandatory-initial-read.md
  // include, so the agent file alone would report a gate that actually
  // arrives (the same producer-scope gap referenceIncludes() fixes for
  // markers, one layer up).
  const producerMarkers = new Map();
  const candidateMarkers = new Map();
  const agentTexts = new Map();
  const unclosedFenceViolations = [];

  const agentFiles = fs.existsSync(AGENTS_DIR)
    ? fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'))
    : [];

  for (const file of agentFiles) {
    const agent = file.replace(/\.md$/, '');
    const abs = path.join(AGENTS_DIR, file);
    const content = fs.readFileSync(abs, 'utf-8');
    // Single pass over the agent's @-included references: each file is read
    // once and feeds BOTH the read-tag fold (agentTexts) and marker
    // extraction (producer/candidate attribution).
    const includeTexts = [];
    for (const refRelPath of referenceIncludes(content)) {
      try {
        includeTexts.push(fs.readFileSync(path.join(ROOT, refRelPath), 'utf-8'));
      } catch {
        // include miss — lint-command-contract rule 4 owns @-ref existence
      }
    }
    agentTexts.set(agent, [content, ...includeTexts].join('\n'));
    const { markers, candidates, unclosedFence } = extractMarkers(agentTexts.get(agent), knownMarkers);
    const inFenceMarkers = markers.filter(m => m.inFence).map(m => m.marker);
    const inFenceCandidates = candidates.filter(m => m.inFence).map(m => m.marker);

    producerMarkers.set(agent, inFenceMarkers);
    candidateMarkers.set(agent, [...new Set(inFenceCandidates)]);

    if (unclosedFence) {
      unclosedFenceViolations.push({
        kind: 'unclosed_fence',
        agent,
        marker: null,
        detail: `${toRepoRelative(abs)} has an unterminated code fence`,
      });
    }
  }

  // consumerTexts: every *.md under gsd-core/workflows/, commands/, agents/
  // — plus every file-shaped `Consumed by` entry that resolves on disk, so
  // a row citing a reference doc or an ADR (e.g. intel-updater's
  // docs/adr/22-plan-drift-guard.md) is validated against the real file and
  // its text participates in consumer matching, not just workflows.
  const consumerTexts = new Map();
  const consumerDirs = [WORKFLOWS_DIR, COMMANDS_DIR, AGENTS_DIR];
  for (const dir of consumerDirs) {
    for (const abs of walkMarkdownFiles(dir, [])) {
      consumerTexts.set(toRepoRelative(abs), fs.readFileSync(abs, 'utf-8'));
    }
  }
  for (const row of registry) {
    for (const rel of parseConsumedByCell(row.consumed_by)) {
      if (consumerTexts.has(rel)) continue;
      const abs = path.join(ROOT, rel);
      try {
        consumerTexts.set(rel, fs.readFileSync(abs, 'utf-8'));
      } catch {
        // absent — contractViolations reports it as unknown_consumer
      }
    }
  }

  const contractViolationsList = contractViolations({ registry, producerMarkers, candidateMarkers, consumerTexts });
  const readTagViolationsList = readTagViolations({ registry, agentTexts, consumerTexts });
  const reverseViolationsList = unmatchedConsumerTokens({ consumerTexts, vocabulary: knownMarkers });

  const parseViolations = parseErrors.map(e => ({
    kind: 'parse_error',
    agent: null,
    marker: null,
    detail: `agent-contracts.md:${e.line} — ${e.reason}`,
  }));

  const allViolations = [
    ...parseViolations,
    ...unclosedFenceViolations,
    ...contractViolationsList,
    ...readTagViolationsList,
    ...reverseViolationsList,
  ];

  const agentCount = registry.length;
  const markerCount = registry.reduce((n, r) => n + (r.completion_markers || []).length, 0);

  // --json: the typed surface tests consume (CONTRIBUTING "Raw Text
  // Matching" rule — the human formatter below is for operators only).
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({
        check: 'check-contract-drift',
        status: allViolations.length === 0 ? 'ok' : 'violations',
        agents: agentCount,
        markers: markerCount,
        violations: allViolations.map((v) => ({
          kind: v.kind,
          agent: v.agent ?? null,
          marker: v.marker ?? null,
          detail: sanitizeEcho(v.detail),
        })),
      }),
    );
    return allViolations.length === 0 ? 0 : 1;
  }

  if (allViolations.length === 0) {
    console.log(`ok check-contract-drift: ${agentCount} agents, ${markerCount} markers, 0 violations`);
    return 0;
  }

  // group by violation kind
  const byKind = new Map();
  for (const v of allViolations) {
    if (!byKind.has(v.kind)) byKind.set(v.kind, []);
    byKind.get(v.kind).push(v);
  }

  process.stderr.write(
    `\nERROR check-contract-drift: ${allViolations.length} violation(s) across ${byKind.size} kind(s)\n\n`,
  );

  for (const [kind, violations] of byKind) {
    process.stderr.write(`  ${kind} (${violations.length}):\n`);
    for (const v of violations) {
      const agentLabel = v.agent ? sanitizeEcho(v.agent) : '(registry)';
      const markerLabel = v.marker ? ` marker "${sanitizeEcho(v.marker)}"` : '';
      process.stderr.write(`    - ${agentLabel}${markerLabel}: ${sanitizeEcho(v.detail)}\n`);
      process.stderr.write(`      remedy: ${remedyFor(kind)}\n`);
    }
    process.stderr.write('\n');
  }

  process.stderr.write('See gsd-core/references/agent-contracts.md for the registry contract spec.\n\n');

  return 1;
}

runMain(main);
