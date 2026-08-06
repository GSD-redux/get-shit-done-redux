/**
 * Graphify integration module — config gate, subprocess execution, knowledge-graph
 * query, status, diff, build pipeline, and snapshot helpers.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/graphify.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execTool, execGit, platformWriteSync } from './shell-command-projection.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateMod = require('./capability-state.cjs');
const { isCapabilityActive } = capabilityStateMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import ioMod = require('./io.cjs');
const { serializeForOutput } = ioMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- prompt-budget.cjs is an export= CommonJS module
import promptBudget = require('./prompt-budget.cjs');
// The repo's single token scale (phase-estimation.cts documents the rule: a
// ratio between two measurement methods measures the methods, not the miss).
// This module previously carried a private copy of the same chars/4 formula.
const { estimateTokens } = promptBudget;

// ─── Config Gate ─────────────────────────────────────────────────────────────

interface DisabledResponse {
  disabled: true;
  message: string;
}

/**
 * Return the standard disabled response object.
 */
function disabledResponse(): DisabledResponse {
  return { disabled: true, message: 'graphify is not enabled. Enable with: gsd-tools config-set graphify.enabled true' };
}

// ─── Subprocess Helper ───────────────────────────────────────────────────────

/**
 * Frozen enum of typed reason codes for execGraphify failures (#2974).
 * Tests assert on result.reason instead of grepping stderr text.
 */
const GRAPHIFY_REASON = Object.freeze({
  OK: 'ok',
  ENOENT: 'graphify_not_found',
  TIMEOUT: 'graphify_timed_out',
  EXIT_NONZERO: 'graphify_exit_nonzero',
} as const);

type GraphifyReason = typeof GRAPHIFY_REASON[keyof typeof GRAPHIFY_REASON];

interface GraphifyExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  reason: GraphifyReason;
  timeout_ms?: number;
}

/**
 * Execute graphify CLI as a subprocess with proper env and timeout handling.
 */
function execGraphify(cwd: string, args: string[], options: { timeout?: number } = {}): GraphifyExecResult {
  const timeout = options.timeout ?? 30000;
  const result = execTool('graphify', args, {
    cwd,
    timeout,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });

  // ENOENT — seam normalizes to exitCode 127. Surface as typed reason.
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return {
      exitCode: 127,
      stdout: '',
      stderr: 'graphify not found on PATH',
      reason: GRAPHIFY_REASON.ENOENT,
    };
  }

  // Timeout — result.timedOut is derived by the shared isSpawnTimeout predicate
  // (shell-command-projection.cts), keyed on error.code === 'ETIMEDOUT' rather
  // than signal === 'SIGTERM': Windows does not reliably report SIGTERM on a
  // timeout kill, and an externally-delivered SIGTERM (error is null) is not
  // a timeout at all.
  if (result.timedOut) {
    return {
      exitCode: 124,
      stdout: result.stdout,
      stderr: 'graphify timed out after ' + timeout + 'ms',
      reason: GRAPHIFY_REASON.TIMEOUT,
      timeout_ms: timeout,
    };
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    reason: result.exitCode === 0 ? GRAPHIFY_REASON.OK : GRAPHIFY_REASON.EXIT_NONZERO,
  };
}

// ─── Presence & Version ──────────────────────────────────────────────────────

interface InstalledResult {
  installed: boolean;
  message?: string;
}

/**
 * Check whether the graphify CLI binary is installed and accessible on PATH.
 * Uses --help (NOT --version, which graphify does not support).
 */
function checkGraphifyInstalled(): InstalledResult {
  const result = execTool('graphify', ['--help'], { timeout: 5000 });

  if (result.error) {
    return {
      installed: false,
      message: 'graphify is not installed.\n\nInstall with:\n  uv pip install graphifyy && graphify install',
    };
  }

  return { installed: true };
}

interface VersionResult {
  version: string | null;
  compatible: boolean | null;
  warning: string | null;
}

/**
 * Detect graphify version and check compatibility.
 * Tested range: >=0.4.0,<1.0
 *
 * Detection strategy:
 * 1. Try `graphify --version` (works for most CLI installations, incl. venv installs)
 * 2. Fall back to python3 importlib.metadata (legacy / system Python path)
 * 3. Return null version gracefully if both fail
 */
function checkGraphifyVersion(): VersionResult {
  // Strategy 1: try `graphify --version` directly (2s timeout -- fast path)
  const versionResult = execTool('graphify', ['--version'], { timeout: 2000 });

  let versionStr: string | null = null;

  if (!versionResult.error && versionResult.exitCode === 0) {
    // graphify --version may emit "graphify 0.4.23" or just "0.4.23"
    const match = versionResult.stdout.match(/(\d+\.\d+(?:\.\d+)*)/);
    if (match) {
      versionStr = match[1];
    }
  }

  // Strategy 2: fall back to python3 importlib.metadata
  let pyPackageConfirmed = false;
  if (!versionStr) {
    const pyResult = execTool('python3', [
      '-c',
      'from importlib.metadata import version; print(version("graphifyy"))',
    ], { timeout: 5000 });

    if (!pyResult.error && pyResult.exitCode === 0 && pyResult.stdout) {
      versionStr = pyResult.stdout.trim();
      pyPackageConfirmed = true; // importlib.metadata confirmed the package
    }
  } else {
    // #3020: verify the `graphify` binary on PATH is actually the graphifyy
    // package — a foreign binary that happens to print a version-like string
    // must not silently report compatible. If importlib.metadata cannot confirm
    // the package, emit an identity warning even if the version looks right.
    const pyVerify = execTool('python3', [
      '-c',
      'from importlib.metadata import version; print(version("graphifyy"))',
    ], { timeout: 5000 });
    pyPackageConfirmed = !pyVerify.error && pyVerify.exitCode === 0 && !!pyVerify.stdout;
  }

  if (!versionStr) {
    return { version: null, compatible: null, warning: 'Could not determine graphify version' };
  }

  const parts = versionStr.split('.').map(Number);

  if (parts.length < 2 || parts.some(isNaN)) {
    return { version: versionStr, compatible: null, warning: 'Could not parse version: ' + versionStr };
  }

  const versionInRange = parts[0] === 0 && parts[1] >= 4;

  // #3020: if the `graphify` binary answered --version but the Python package
  // graphifyy could not be confirmed, the tool identity is unverified — emit
  // a warning naming the mismatch regardless of version-range compatibility.
  if (!pyPackageConfirmed) {
    return {
      version: versionStr,
      compatible: false,
      warning: 'graphify version ' + versionStr + ' detected but the graphifyy Python package could not be confirmed — the `graphify` binary on PATH may be a different tool. Verify with: pip show graphifyy',
    };
  }

  const warning = versionInRange ? null : 'graphify version ' + versionStr + ' is outside tested range >=0.4.0,<1.0';

  return { version: versionStr, compatible: versionInRange, warning };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  label?: string;
  description?: string;
  [key: string]: unknown;
}

interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  relation?: string;
  confidence?: string;
  confidence_score?: string;
  [key: string]: unknown;
}

interface Graph {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  links?: GraphEdge[];
  hyperedges?: unknown[];
  built_at_commit?: unknown;
  [key: string]: unknown;
}

/**
 * Safely read and parse a JSON file. Returns null on missing file or parse error.
 * Prevents crashes on malformed JSON (T-02-01 mitigation).
 */
function safeReadJson(filePath: string): Graph | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Graph;
  } catch {
    return null;
  }
}

interface AdjEntry {
  target: string;
  edge: GraphEdge;
}

/**
 * Build a bidirectional adjacency map from graph nodes and edges.
 * Each node ID maps to an array of { target, edge } entries.
 * Bidirectional: both source->target and target->source are added (Pitfall 3).
 */
function buildAdjacencyMap(graph: Graph): Record<string, AdjEntry[]> {
  const adj: Record<string, AdjEntry[]> = {};
  for (const node of (graph.nodes || [])) {
    adj[node.id] = [];
  }
  for (const edge of (graph.edges || graph.links || [])) {
    if (!adj[edge.source]) adj[edge.source] = [];
    if (!adj[edge.target]) adj[edge.target] = [];
    adj[edge.source].push({ target: edge.target, edge });
    adj[edge.target].push({ target: edge.source, edge });
  }
  return adj;
}

interface ExpandResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  seeds: Set<string>;
  trimmed?: string | null;
}

/**
 * Seed-then-expand query: find nodes matching term, then BFS-expand up to maxHops.
 * Matches on node label and description (case-insensitive substring, D-01).
 */
function seedAndExpand(graph: Graph, term: string, maxHops = 2): ExpandResult {
  const lowerTerm = term.toLowerCase();
  const nodeMap = Object.fromEntries((graph.nodes || []).map(n => [n.id, n]));
  const adj = buildAdjacencyMap(graph);

  // Seed: match on label and description (case-insensitive substring)
  const seeds = (graph.nodes || []).filter(n =>
    (n.label || '').toLowerCase().includes(lowerTerm) ||
    (n.description || '').toLowerCase().includes(lowerTerm)
  );

  // BFS expand from seeds
  const visitedNodes = new Set(seeds.map(n => n.id));
  const collectedEdges: GraphEdge[] = [];
  const seenEdgeKeys = new Set<string>();
  let frontier = seeds.map(n => n.id);

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      for (const entry of (adj[nodeId] || [])) {
        // Deduplicate edges by source::target::label key
        const edgeKey = `${entry.edge.source}::${entry.edge.target}::${entry.edge.label || ''}`;
        if (!seenEdgeKeys.has(edgeKey)) {
          seenEdgeKeys.add(edgeKey);
          collectedEdges.push(entry.edge);
        }
        if (!visitedNodes.has(entry.target)) {
          visitedNodes.add(entry.target);
          nextFrontier.push(entry.target);
        }
      }
    }
    frontier = nextFrontier;
  }

  const resultNodes = [...visitedNodes].map(id => nodeMap[id]).filter((n): n is GraphNode => Boolean(n));
  return { nodes: resultNodes, edges: collectedEdges, seeds: new Set(seeds.map(n => n.id)) };
}

interface BudgetResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  trimmed: string | null;
  total_nodes: number;
  total_edges: number;
  budget_met: boolean;
  budget_estimate: number;
}

/** The core payload a query response wraps, before the wire shape is applied. */
interface QueryResponseCore {
  nodes: GraphNode[];
  edges: GraphEdge[];
  trimmed: string | null;
  budget?: { met: boolean; estimate: number };
}

/**
 * The single definition of `graphifyQuery`'s wire shape.
 *
 * Both the emitter (`graphifyQuery`'s return) and the budget estimator go
 * through here, so `budget_estimate` measures the object the caller actually
 * receives rather than a private approximation of it (#2738).
 */
function buildQueryResponse(term: string, core: QueryResponseCore) {
  return {
    term,
    nodes: core.nodes,
    edges: core.edges,
    total_nodes: core.nodes.length,
    total_edges: core.edges.length,
    trimmed: core.trimmed,
    // Budget outcome (#2738) — only present when a budget was requested
    ...(core.budget ? { budget_met: core.budget.met, budget_estimate: core.budget.estimate } : {}),
  };
}

/**
 * Apply token budget by dropping edges by confidence tier (D-04, D-05, D-06).
 * Drop order: AMBIGUOUS -> INFERRED -> EXTRACTED.
 *
 * The estimate measures the response **as emitted** — `serializeForOutput()`
 * over the same object `graphifyQuery` returns, pretty-printed and including
 * the wrapper keys. Measuring a compact `{nodes, edges}` instead understates
 * the payload the caller receives, which makes `budget_met` a confident claim
 * about a payload nobody is handed (#2738).
 *
 * `term` participates in the emitted bytes, so it is threaded through; the
 * default keeps direct unit calls on the same wire shape, minus those bytes.
 */
function applyBudget(
  result: ExpandResult,
  budgetTokens: number | null,
  term = '',
): ExpandResult | BudgetResult {
  // == null (not truthiness): --budget 0 is a valid parsed budget the router
  // forwards, and treating it as "no budget" silently returns the unbounded
  // result — the same silent-non-application defect class as #974/#2738.
  //
  // Number.isFinite additionally keeps NaN out of the comparisons below, where
  // every `estimate <= NaN` is false: the loop would strip all three tiers and
  // return a seeds-only payload indistinguishable from a legitimate aggressive
  // trim. The CLI cannot reach that state — graphify-command-router rejects a
  // non-numeric --budget before this is called — but graphifyQuery and
  // applyBudget are module-level entry points a future caller could reach
  // without that validation. Infinity routes here too, and deliberately: an
  // unbounded budget is not a budget.
  if (budgetTokens == null || !Number.isFinite(budgetTokens)) return result;

  const CONFIDENCE_ORDER = ['AMBIGUOUS', 'INFERRED', 'EXTRACTED'];
  let edges = [...result.edges];
  let omitted = 0;

  // Nodes that survive a given edge set: edge-reachable, plus seeds (always kept)
  const survivingNodes = (edgeSet: GraphEdge[]) => {
    const reachableNodes = new Set<string>();
    for (const edge of edgeSet) {
      reachableNodes.add(edge.source);
      reachableNodes.add(edge.target);
    }
    return result.nodes.filter(n => reachableNodes.has(n.id) || (result.seeds && result.seeds.has(n.id)));
  };

  const trimmedLabel = (dropped: number, unreachable: number) =>
    dropped > 0 ? `[${dropped} edges omitted, ${unreachable} nodes unreachable]` : null;

  /**
   * Tokens of the response as `output()` will emit it.
   *
   * Self-referential by construction: `budget_estimate` is itself one of the
   * emitted fields, so its own digit width counts toward the total. Resolved by
   * iterating to a fixed point — the sequence is non-decreasing (a wider number,
   * and `false` over `true`, can only add characters), so it settles in a couple
   * of passes. The cap is a guard rather than an expectation, and it exits on the
   * larger value: over-reporting is the safe direction for a budget signal;
   * under-reporting is the defect this fixes.
   */
  const wireEstimate = (
    candidateNodes: GraphNode[],
    candidateEdges: GraphEdge[],
    trimmed: string | null,
  ): number => {
    let est = 0;
    for (let i = 0; i < 8; i++) {
      const next = estimateTokens(
        serializeForOutput(
          buildQueryResponse(term, {
            nodes: candidateNodes,
            edges: candidateEdges,
            trimmed,
            budget: { met: est <= budgetTokens, estimate: est },
          }),
        ),
      );
      if (next === est) break;
      est = next;
    }
    return est;
  };

  // Estimate against the post-pruning node set after each tier removal, so a
  // removal that already fits (once orphaned nodes are excluded) stops the loop
  // instead of dropping the next, higher-confidence tier too (#2738).
  let nodes = survivingNodes(edges);
  let estimate = wireEstimate(nodes, edges, trimmedLabel(omitted, result.nodes.length - nodes.length));

  for (const tier of CONFIDENCE_ORDER) {
    if (estimate <= budgetTokens) break;
    const before = edges.length;
    // Check both confidence and confidence_score field names (Open Question 1)
    edges = edges.filter(e => (e.confidence || e.confidence_score) !== tier);
    omitted += before - edges.length;
    nodes = survivingNodes(edges);
    estimate = wireEstimate(nodes, edges, trimmedLabel(omitted, result.nodes.length - nodes.length));
  }

  const unreachable = result.nodes.length - nodes.length;

  return {
    nodes,
    edges,
    trimmed: trimmedLabel(omitted, unreachable),
    total_nodes: nodes.length,
    total_edges: edges.length,
    // Seeds are retained unconditionally, so the seed set is a floor the
    // reduction cannot go below — report the outcome instead of hiding a miss (#2738)
    budget_met: estimate <= budgetTokens,
    budget_estimate: estimate,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Strict 4-40 hex fence for graph.built_at_commit values (#3170). Anything
 * else (dashed, prose, empty) is treated as absent so a hostile graph.json
 * cannot smuggle a `--upload-pack=…` option into a `git` argv.
 */
const COMMIT_HASH_RE = /^[0-9a-f]{4,40}$/i;

/**
 * Read git HEAD for the project at `cwd`. Returns the full commit hash on
 * success, or null when cwd is not a git repo / `git` is not on PATH.
 */
function readGitHead(cwd: string): string | null {
  const r = execGit(['rev-parse', 'HEAD'], { cwd });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Count commits between `from` and `to` (exclusive..inclusive, like
 * `git rev-list --count A..B`). Returns null when either ref is unreachable
 * or the cwd is not a git repo.
 */
function countCommitsBetween(cwd: string, from: string, to: string): number | null {
  const r = execGit(['rev-list', '--count', `${from}..${to}`], { cwd });
  if (r.exitCode !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ─── Graph location resolution (#1825) ───────────────────────────────────────
//
// `graphify.graph_path` (in .planning/config.json) lets one umbrella-level graph
// serve multiple sibling projects without a per-project mirror. When set, query /
// status / diff read the configured graph, and the diff snapshot travels with it
// (alongside graph.json). When unset/blank/non-string, behaviour is byte-identical
// to the historical `<planningDir>/graphs/graph.json`.

const GRAPH_FILENAME = 'graph.json';
const SNAPSHOT_FILENAME = '.last-build-snapshot.json';

interface GraphLocation {
  /** Absolute path to graph.json. */
  graphPath: string;
  /** True iff graphify.graph_path was explicitly configured (non-empty string). */
  configured: boolean;
}

/**
 * Resolve the absolute graph.json location. Honors `graphify.graph_path` in
 * config.json (resolved relative to the project root, `cwd`); falls back to the
 * default `<planningDir>/graphs/graph.json` when unset/blank/non-string.
 */
function resolveGraphLocation(cwd: string, planningDir: string): GraphLocation {
  const config = safeReadJson(path.join(planningDir, 'config.json'));
  const graphify = (config && (config as Record<string, unknown>)['graphify']) as Record<string, unknown> | undefined;
  const configuredValue = graphify && graphify['graph_path'];
  if (typeof configuredValue === 'string' && configuredValue.trim().length > 0) {
    return { graphPath: path.resolve(cwd, configuredValue), configured: true };
  }
  return { graphPath: path.join(planningDir, 'graphs', GRAPH_FILENAME), configured: false };
}

/**
 * Query the knowledge graph for nodes matching a term, with optional budget cap.
 * Uses seed-then-expand BFS traversal (D-01).
 */
function graphifyQuery(cwd: string, term: string, options: { budget?: number | null } = {}): unknown {
  const planningDir = path.join(cwd, '.planning');
  if (!isCapabilityActive('graphify', cwd)) return disabledResponse();

  const { graphPath, configured } = resolveGraphLocation(cwd, planningDir);
  if (!fs.existsSync(graphPath)) {
    return { error: configured
      ? `Configured graph not found at ${graphPath}. Set graphify.graph_path or run /gsd:graphify build.`
      : 'No graph built yet. Run graphify build first.' };
  }

  const graph = safeReadJson(graphPath);
  if (!graph) {
    return { error: 'Failed to parse graph.json' };
  }

  let result: ExpandResult | BudgetResult = seedAndExpand(graph, term);

  if (options.budget != null) {
    result = applyBudget(result, options.budget, term);
  }

  // Same builder the estimator measured, so budget_estimate describes exactly
  // these bytes (#2738).
  return buildQueryResponse(term, {
    nodes: result.nodes,
    edges: result.edges,
    trimmed: 'trimmed' in result ? (result.trimmed || null) : null,
    budget: 'budget_met' in result
      ? { met: result.budget_met, estimate: result.budget_estimate }
      : undefined,
  });
}

/**
 * Return status information about the knowledge graph (STAT-01, STAT-02).
 *
 * Surfaces the graphify v0.7+ commit-staleness signal as four optional
 * fields when graph.built_at_commit is present and validly formatted
 * (#3170). Tri-state on commit_stale: null means "we don't know" (pre-v0.7
 * graph, no git, or unreachable commit), distinct from false ("known
 * fresh").
 */
function graphifyStatus(cwd: string): unknown {
  const planningDir = path.join(cwd, '.planning');
  if (!isCapabilityActive('graphify', cwd)) return disabledResponse();

  const { graphPath, configured } = resolveGraphLocation(cwd, planningDir);
  if (!fs.existsSync(graphPath)) {
    return { exists: false, message: configured
      ? `Configured graph not found at ${graphPath}. Set graphify.graph_path or run /gsd:graphify build.`
      : 'No graph built yet. Run graphify build to create one.' };
  }

  const stat = fs.statSync(graphPath);
  const graph = safeReadJson(graphPath);
  if (!graph) {
    return { error: 'Failed to parse graph.json' };
  }

  const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const age = Date.now() - stat.mtimeMs;

  // Commit-staleness signal (#3170). Validate before passing to git.
  const builtAtCommit = graph.built_at_commit;
  const rawBuilt = (typeof builtAtCommit === 'string' ? builtAtCommit : '').trim();
  const builtAt = COMMIT_HASH_RE.test(rawBuilt) ? rawBuilt : null;
  const head = readGitHead(cwd);
  let commitsBehind: number | null = null;
  let commitStale: boolean | null = null;
  if (builtAt && head) {
    commitsBehind = countCommitsBetween(cwd, builtAt, head);
    if (commitsBehind !== null) commitStale = commitsBehind > 0;
  }

  // Auto-update status (#3347). Read .last-build-status.json written by the
  // hooks/gsd-graphify-update.sh PostToolUse hook (opt-in via graphify.auto_update,
  // default false). When the most recent auto-build is "failed" or still "running",
  // fold that into the existing `stale: true` signal so consumers (gsd-planner,
  // gsd-phase-researcher) surface the standard "treat semantic relationships as
  // approximate" annotation without per-consumer prompt changes. The full state
  // (running/failed/exit_code/duration_ms/head_at_build) is exposed under
  // `last_build` for callers that want richer context.
  const statusPath = path.join(planningDir, 'graphs', '.last-build-status.json');
  const lastBuildAutoUpdate = fs.existsSync(statusPath) ? safeReadJson(statusPath) : null;
  const autoUpdateStale =
    lastBuildAutoUpdate &&
    (lastBuildAutoUpdate.status === 'failed' || lastBuildAutoUpdate.status === 'running');

  return {
    exists: true,
    last_build: stat.mtime.toISOString(),
    node_count: (graph.nodes || []).length,
    edge_count: (graph.edges || graph.links || []).length,
    hyperedge_count: (graph.hyperedges || []).length,
    stale: age > STALE_MS || Boolean(autoUpdateStale),
    age_hours: Math.round(age / (60 * 60 * 1000)),
    built_at_commit: builtAt ? builtAt.slice(0, 7) : null,
    current_commit: head ? head.slice(0, 7) : null,
    commits_behind: commitsBehind,
    commit_stale: commitStale,
    last_build_auto_update: lastBuildAutoUpdate || null,
  };
}

/**
 * Compute topology-level diff between current graph and last build snapshot (D-07, D-08, D-09).
 */
function graphifyDiff(cwd: string): unknown {
  const planningDir = path.join(cwd, '.planning');
  if (!isCapabilityActive('graphify', cwd)) return disabledResponse();

  const { graphPath } = resolveGraphLocation(cwd, planningDir);
  const snapshotPath = path.join(path.dirname(graphPath), SNAPSHOT_FILENAME);

  if (!fs.existsSync(snapshotPath)) {
    return { no_baseline: true, message: 'No previous snapshot. Run graphify build first, then build again to generate a diff baseline.' };
  }

  if (!fs.existsSync(graphPath)) {
    return { error: 'No current graph. Run graphify build first.' };
  }

  const current = safeReadJson(graphPath);
  const snapshot = safeReadJson(snapshotPath);

  if (!current || !snapshot) {
    return { error: 'Failed to parse graph or snapshot file' };
  }

  // Diff nodes
  const currentNodeMap = Object.fromEntries((current.nodes || []).map(n => [n.id, n]));
  const snapshotNodeMap = Object.fromEntries((snapshot.nodes || []).map(n => [n.id, n]));

  const nodesAdded = Object.keys(currentNodeMap).filter(id => !snapshotNodeMap[id]);
  const nodesRemoved = Object.keys(snapshotNodeMap).filter(id => !currentNodeMap[id]);
  const nodesChanged = Object.keys(currentNodeMap).filter(id =>
    snapshotNodeMap[id] && JSON.stringify(currentNodeMap[id]) !== JSON.stringify(snapshotNodeMap[id])
  );

  // Diff edges (keyed by source+target+relation)
  const edgeKey = (e: GraphEdge) => `${e.source}::${e.target}::${e.relation || e.label || ''}`;
  const currentEdgeMap = Object.fromEntries((current.edges || current.links || []).map(e => [edgeKey(e), e]));
  const snapshotEdgeMap = Object.fromEntries((snapshot.edges || snapshot.links || []).map(e => [edgeKey(e), e]));

  const edgesAdded = Object.keys(currentEdgeMap).filter(k => !snapshotEdgeMap[k]);
  const edgesRemoved = Object.keys(snapshotEdgeMap).filter(k => !currentEdgeMap[k]);
  const edgesChanged = Object.keys(currentEdgeMap).filter(k =>
    snapshotEdgeMap[k] && JSON.stringify(currentEdgeMap[k]) !== JSON.stringify(snapshotEdgeMap[k])
  );

  return {
    nodes: { added: nodesAdded.length, removed: nodesRemoved.length, changed: nodesChanged.length },
    edges: { added: edgesAdded.length, removed: edgesRemoved.length, changed: edgesChanged.length },
    timestamp: snapshot.timestamp || null,
  };
}

// ─── Build Pipeline (Phase 3) ───────────────────────────────────────────────

/**
 * Pre-flight checks for graphify build (BUILD-01, BUILD-02, D-09).
 * Does NOT invoke graphify -- returns structured JSON for the builder agent.
 */
function graphifyBuild(cwd: string): unknown {
  const planningDir = path.join(cwd, '.planning');
  if (!isCapabilityActive('graphify', cwd)) return disabledResponse();

  const installed = checkGraphifyInstalled();
  if (!installed.installed) return { error: installed.message };

  const version = checkGraphifyVersion();

  // Ensure output directory exists (D-05). Build stays project-scoped: the build
  // skill cp's artifacts into `<planningDir>/graphs/` regardless of graph_path, so
  // graphs_dir reflects that real destination (not the configured read location).
  // A shared umbrella graph is built in the umbrella project; sub-projects only
  // READ it via graphify.graph_path (#1825).
  const graphsDir = path.join(planningDir, 'graphs');
  fs.mkdirSync(graphsDir, { recursive: true });

  // Read build timeout from config -- default 300s per D-02
  const config = safeReadJson(path.join(planningDir, 'config.json')) || {};
  const graphifyConfig = config.graphify as Record<string, unknown> | undefined;
  const timeoutSec = (graphifyConfig && graphifyConfig.build_timeout) || 300;

  return {
    action: 'spawn_agent',
    graphs_dir: graphsDir,
    graphify_out: path.join(cwd, 'graphify-out'),
    timeout_seconds: timeoutSec,
    version: version.version,
    version_warning: version.warning,
    artifacts: ['graph.json', 'graph.html', 'GRAPH_REPORT.md'],
  };
}

interface SnapshotResult {
  saved: boolean;
  timestamp: string;
  node_count: number;
  edge_count: number;
}

/**
 * Write a diff snapshot after successful build (D-06).
 * Reads graph.json from .planning/graphs/ and writes .last-build-snapshot.json
 * using platformWriteSync for crash safety.
 */
function writeSnapshot(cwd: string): SnapshotResult | { error: string } {
  const planningDir = path.join(cwd, '.planning');
  const { graphPath } = resolveGraphLocation(cwd, planningDir);
  const graph = safeReadJson(graphPath);
  if (!graph) return { error: 'Cannot write snapshot: graph.json not parseable' };

  const snapshot = {
    version: 1,
    timestamp: new Date().toISOString(),
    nodes: graph.nodes || [],
    edges: graph.edges || graph.links || [],
  };

  const snapshotPath = path.join(path.dirname(graphPath), SNAPSHOT_FILENAME);
  platformWriteSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  return {
    saved: true,
    timestamp: snapshot.timestamp,
    node_count: snapshot.nodes.length,
    edge_count: snapshot.edges.length,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export = {
  // Config gate
  disabledResponse,
  // Subprocess
  execGraphify,
  GRAPHIFY_REASON,
  // Presence and version
  checkGraphifyInstalled,
  checkGraphifyVersion,
  // Query (Phase 2)
  graphifyQuery,
  safeReadJson,
  buildAdjacencyMap,
  seedAndExpand,
  applyBudget,
  // Status (Phase 2)
  graphifyStatus,
  // Diff (Phase 2)
  graphifyDiff,
  // Build (Phase 3)
  graphifyBuild,
  writeSnapshot,
};
