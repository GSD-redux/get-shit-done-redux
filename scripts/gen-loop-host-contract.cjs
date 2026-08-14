#!/usr/bin/env node
'use strict';

/**
 * gen-loop-host-contract.cjs — generates gsd-core/bin/lib/loop-host-contract.cjs
 * from the <!-- gsd:loop-host ... --> blocks in the five step workflows.
 *
 * Usage:
 *   node scripts/gen-loop-host-contract.cjs              # print to stdout
 *   node scripts/gen-loop-host-contract.cjs --write      # write loop-host-contract.cjs
 *   node scripts/gen-loop-host-contract.cjs --check      # exit 1 if committed file is stale
 *
 * ADR-894 phase 3a-impl-2. Parses structured markers from workflow files,
 * cross-checks declared agent-roles against actual agent references in each
 * workflow, asserts that the union of all points equals the 12 canonical points,
 * and emits a committed CommonJS module exporting the contract array.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { escapeRegex: escapeRegExp } = require('../gsd-core/bin/lib/pattern.cjs');
const { normalizeEol } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const CONTRACT_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'loop-host-contract.cjs');

// The five step workflows in pipeline order
const STEP_WORKFLOWS = [
  { file: 'discuss-phase.md', step: 'discuss' },
  { file: 'plan-phase.md',    step: 'plan' },
  { file: 'execute-phase.md', step: 'execute' },
  { file: 'verify-work.md',   step: 'verify' },
  { file: 'ship.md',          step: 'ship' },
];

// Canonical 12 loop points in pipeline order
const CANONICAL_POINTS = [
  'discuss:pre',
  'discuss:post',
  'plan:pre',
  'plan:post',
  'execute:pre',
  'execute:wave:pre',
  'execute:wave:post',
  'execute:post',
  'verify:pre',
  'verify:post',
  'ship:pre',
  'ship:post',
];

// FIX 1: Per-step canonical point ownership. Each step must declare exactly these points.
const EXPECTED_POINTS_BY_STEP = {
  discuss: ['discuss:pre', 'discuss:post'],
  plan:    ['plan:pre', 'plan:post'],
  execute: ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'],
  verify:  ['verify:pre', 'verify:post'],
  ship:    ['ship:pre', 'ship:post'],
};

// Role → agent-name mapping used for cross-check.
// Each non-orchestrator role must correspond to an actual agent reference in
// the workflow file (e.g. gsd-planner, gsd-executor, gsd-verifier, etc.).
const ROLE_TO_AGENT = {
  researcher: 'gsd-phase-researcher',
  planner:    'gsd-planner',
  checker:    'gsd-plan-checker',
  executor:   'gsd-executor',
  verifier:   'gsd-verifier',
};

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a single <!-- gsd:loop-host ... --> block from file content.
 * Returns a plain object with keys: step, points[], agentRoles[], produces[], consumes[].
 * Throws a descriptive error if the block is malformed or missing.
 *
 * Block format (one key: value per line, comma-separated list values):
 *   <!-- gsd:loop-host
 *   step: plan
 *   points: plan:pre, plan:post
 *   agent-roles: researcher, planner, checker
 *   produces: PLAN.md
 *   consumes: CONTEXT.md
 *   -->
 *
 * For empty list values (e.g. "consumes:") the field is an empty array.
 *
 * @param {string} content   File content
 * @param {string} fileName  For error messages
 * @returns {{ step: string, points: string[], agentRoles: string[], coreArtifacts: { produces: string[], consumes: string[] } }}
 */
function parseLoopHostBlock(content, fileName) {
  // FIX 2: Detect ALL marker blocks — more than one is a hard error.
  const blockRe = /<!--\s*gsd:loop-host\s*([\s\S]*?)-->/g;
  const allMatches = Array.from(content.matchAll(blockRe));
  if (allMatches.length === 0) {
    throw new Error(fileName + ': missing <!-- gsd:loop-host ... --> block');
  }
  if (allMatches.length > 1) {
    throw new Error(
      fileName + ': expected exactly one gsd:loop-host marker block, found ' + allMatches.length,
    );
  }

  const blockBody = allMatches[0][1];

  // FIX 2: Detect duplicate keys within the block.
  const RECOGNIZED_KEYS = ['step', 'points', 'agent-roles', 'produces', 'consumes'];
  const keyCounts = {};
  for (const line of blockBody.split('\n')) {
    const trimmed = line.trim();
    for (const key of RECOGNIZED_KEYS) {
      if (trimmed === key + ':' || trimmed.startsWith(key + ': ') || trimmed.startsWith(key + ':')) {
        keyCounts[key] = (keyCounts[key] || 0) + 1;
        break;
      }
    }
  }
  for (const key of RECOGNIZED_KEYS) {
    if (keyCounts[key] > 1) {
      throw new Error(fileName + ': duplicate key \'' + key + '\' in gsd:loop-host marker');
    }
  }

  /**
   * Parse a field line: "key: value1, value2" → [value1, value2] (trimmed, empty strings removed)
   */
  function parseField(key) {
    // Split on newlines and find the line starting with "key:"
    const lines = blockBody.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === key + ':' || trimmed.startsWith(key + ': ') || trimmed.startsWith(key + ':')) {
        const colonIdx = trimmed.indexOf(':');
        const raw = trimmed.slice(colonIdx + 1).trim();
        if (raw === '') return [];
        return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }
    }
    throw new Error(fileName + ': gsd:loop-host block missing required field "' + key + '"');
  }

  function parseScalar(key) {
    const lines = blockBody.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === key + ':' || trimmed.startsWith(key + ': ') || trimmed.startsWith(key + ':')) {
        const colonIdx = trimmed.indexOf(':');
        const val = trimmed.slice(colonIdx + 1).trim();
        if (val === '') {
          throw new Error(fileName + ': gsd:loop-host block field "' + key + '" must be a non-empty string');
        }
        return val;
      }
    }
    throw new Error(fileName + ': gsd:loop-host block missing required field "' + key + '"');
  }

  const step       = parseScalar('step');
  const points     = parseField('points');
  const agentRoles = parseField('agent-roles');
  const produces   = parseField('produces');
  const consumes   = parseField('consumes');

  if (points.length === 0) {
    throw new Error(fileName + ': gsd:loop-host block "points" must have at least one value');
  }
  if (agentRoles.length === 0) {
    throw new Error(fileName + ': gsd:loop-host block "agent-roles" must have at least one value');
  }

  return {
    step,
    points,
    agentRoles,
    coreArtifacts: { produces, consumes },
  };
}

// ─── Cross-check: declared roles vs. actual agent references ─────────────────

/**
 * For each non-orchestrator role in agentRoles, verify the workflow content
 * contains a reference to the corresponding agent name.
 *
 * @param {string}   content     Full workflow file content
 * @param {string[]} agentRoles  Roles declared in the block
 * @param {string}   fileName    For error messages
 * @returns {string[]}           Array of error strings; empty = OK
 */
function crossCheckRoles(content, agentRoles, fileName) {
  const errors = [];
  for (const role of agentRoles) {
    if (role === 'orchestrator') continue; // orchestrator = host itself; no agent file needed
    const agentName = ROLE_TO_AGENT[role];
    if (!agentName) {
      errors.push(
        fileName + ': declared agent-role "' + role + '" has no entry in ROLE_TO_AGENT mapping',
      );
      continue;
    }
    // FIX 3: Use word-boundary match so "gsd-plan-checker-v2" does NOT satisfy a required
    // "gsd-plan-checker". Treat '-' as part of the token: boundary = start/end of string or
    // a character that is neither \w nor '-'.
    // Note: this is a presence check (any reference in the file), not a spawn-site check —
    // a known limitation; spawn-site checks would require AST-level analysis.
    const agentRe = new RegExp(
      '(^|[^\\w-])' + escapeRegExp(agentName) + '($|[^\\w-])',
    );
    if (!agentRe.test(content)) {
      errors.push(
        fileName + ': declared agent-role "' + role + '" maps to agent "' + agentName +
        '" but "' + agentName + '" is not referenced anywhere in the workflow file',
      );
    }
  }
  return errors;
}

// ─── 12-points coverage assertion ────────────────────────────────────────────

/**
 * Assert that the union of all points across all contract entries equals
 * exactly the 12 canonical points (no more, no fewer), AND that each step
 * declares exactly its own canonical points (FIX 1: per-step ownership).
 *
 * @param {{ step: string, points: string[] }[]} entries
 * @returns {string[]}  Error strings; empty = OK
 */
function assertPointsCoverage(entries) {
  const errors = [];

  // FIX 1: Per-step ownership check — each step must declare exactly its own canonical points.
  for (const entry of entries) {
    const expected = EXPECTED_POINTS_BY_STEP[entry.step];
    if (!expected) continue; // unknown step — caught elsewhere
    const expectedSet = new Set(expected);
    const actualSet = new Set(entry.points);
    let mismatch = false;
    for (const p of expectedSet) {
      if (!actualSet.has(p)) mismatch = true;
    }
    for (const p of actualSet) {
      if (!expectedSet.has(p)) mismatch = true;
    }
    if (mismatch) {
      errors.push(
        'step "' + entry.step + '" declares points [' + entry.points.join(', ') +
        '] but expected [' + expected.join(', ') + ']',
      );
    }
  }

  // Global union + duplicate check (belt and suspenders alongside per-step check).
  const allPoints = new Set();
  for (const entry of entries) {
    for (const p of entry.points) {
      if (allPoints.has(p)) {
        errors.push('point "' + p + '" declared more than once across all step workflows');
      }
      allPoints.add(p);
    }
  }

  const canonical = new Set(CANONICAL_POINTS);
  for (const p of allPoints) {
    if (!canonical.has(p)) {
      errors.push('declared point "' + p + '" is not in the canonical 12-point set');
    }
  }
  for (const p of canonical) {
    if (!allPoints.has(p)) {
      errors.push('canonical point "' + p + '" is not declared in any step workflow');
    }
  }
  return errors;
}

// ─── Contract builder ─────────────────────────────────────────────────────────

/**
 * Read and parse all five step workflows. Returns the contract array.
 * Throws on any parse or cross-check error.
 *
 * @param {string} [workflowsDir]  Override for testing
 * @returns {{ step: string, points: string[], agentRoles: string[], coreArtifacts: { produces: string[], consumes: string[] } }[]}
 */
function buildContract(workflowsDir) {
  const resolvedDir = workflowsDir !== undefined ? workflowsDir : WORKFLOWS_DIR;
  const contract = [];
  const allErrors = [];

  for (const { file, step } of STEP_WORKFLOWS) {
    const filePath = path.join(resolvedDir, file);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      allErrors.push('Could not read ' + file + ': ' + String(err.message));
      continue;
    }

    let entry;
    try {
      entry = parseLoopHostBlock(content, file);
    } catch (err) {
      allErrors.push(String(err.message));
      continue;
    }

    // Validate the declared step matches the expected step for this file
    if (entry.step !== step) {
      allErrors.push(
        file + ': gsd:loop-host block declares step "' + entry.step +
        '" but expected "' + step + '"',
      );
    }

    // Cross-check roles
    const roleErrors = crossCheckRoles(content, entry.agentRoles, file);
    allErrors.push(...roleErrors);

    contract.push(entry);
  }

  if (allErrors.length > 0) {
    throw new Error('Loop host contract generation failed:\n' + allErrors.map((e) => '  ' + e).join('\n'));
  }

  // Assert 12-points coverage
  const pointErrors = assertPointsCoverage(contract);
  if (pointErrors.length > 0) {
    throw new Error('Loop host contract points coverage failed:\n' + pointErrors.map((e) => '  ' + e).join('\n'));
  }

  return contract;
}

// ─── Serialization ────────────────────────────────────────────────────────────

/**
 * Serialize the contract array to a CommonJS module string.
 *
 * @param {object[]} contract
 * @returns {string}
 */
function serializeContract(contract) {
  const lines = [];

  lines.push("'use strict';");
  lines.push('');
  lines.push('/**');
  lines.push(' * loop-host-contract.cjs — generated by scripts/gen-loop-host-contract.cjs');
  lines.push(' * DO NOT EDIT BY HAND. Run: node scripts/gen-loop-host-contract.cjs --write');
  lines.push(' * ADR-894 §3 — Loop Host Contract, generated from workflow markers.');
  lines.push(' * 12 points: discuss:pre/post, plan:pre/post, execute:pre/wave:pre/wave:post/post,');
  lines.push(' * verify:pre/post, ship:pre/post. Per-step agentRoles and coreArtifacts.');
  lines.push(' */');
  lines.push('');
  lines.push('const LOOP_HOST_CONTRACT = ' + JSON.stringify(contract, null, 2) + ';');
  lines.push('');
  lines.push('module.exports = { LOOP_HOST_CONTRACT };');
  lines.push('');

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const flag = process.argv[2];

  if (flag === '--check') {
    let contract;
    try {
      contract = buildContract();
    } catch (err) {
      process.stderr.write(String(err.message) + '\n');
      throw new ExitError(1, 'loop-host contract generation failed');
    }
    const live = serializeContract(contract);

    if (!fs.existsSync(CONTRACT_PATH)) {
      process.stderr.write(
        'gsd-core/bin/lib/loop-host-contract.cjs does not exist. Run:\n' +
        '  node scripts/gen-loop-host-contract.cjs --write\n',
      );
      throw new ExitError(1);
    }

    const committed = fs.readFileSync(CONTRACT_PATH, 'utf8');
    // FIX 4: Compare full content (no generated-by stripping) so header drift is caught.
    if (normalizeEol(committed) !== normalizeEol(live)) {
      process.stderr.write(
        'gsd-core/bin/lib/loop-host-contract.cjs is stale. Run:\n' +
        '  node scripts/gen-loop-host-contract.cjs --write\n',
      );
      throw new ExitError(1);
    }

    process.stdout.write('gsd-core/bin/lib/loop-host-contract.cjs is up to date.\n');
  } else if (flag === '--write') {
    let contract;
    try {
      contract = buildContract();
    } catch (err) {
      process.stderr.write(String(err.message) + '\n');
      throw new ExitError(1, 'loop-host contract generation failed — file not written');
    }
    const content = serializeContract(contract);
    fs.mkdirSync(path.dirname(CONTRACT_PATH), { recursive: true });
    fs.writeFileSync(CONTRACT_PATH, content, 'utf8');
    process.stdout.write('Wrote ' + CONTRACT_PATH + '\n');
  } else {
    // Default: print to stdout
    let contract;
    try {
      contract = buildContract();
    } catch (err) {
      process.stderr.write(String(err.message) + '\n');
      throw new ExitError(1, 'loop-host contract generation failed');
    }
    process.stdout.write(serializeContract(contract) + '\n');
  }
}

// ─── Derived single-source-of-truth exports ───────────────────────────────────

/**
 * Repo-relative paths to every host-loop workflow file, derived from STEP_WORKFLOWS.
 * This is the ONLY canonical enumeration of host-loop files — all consumers (tests,
 * registry generator, conformance gate) must derive from this rather than maintaining
 * a separate hardcoded list.
 */
const HOST_LOOP_FILES = STEP_WORKFLOWS.map((w) => 'gsd-core/workflows/' + w.file);

/**
 * Pure function: scan a text string for `loop render-hooks <point>` call sites.
 * Returns a Set of matched point strings.
 *
 * @param {string} text  Content of a workflow file (or any text).
 * @returns {Set<string>}
 */
function scanWiredPoints(text) {
  const re = /loop render-hooks\s+([a-z:]+)/g;
  const result = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    result.add(m[1]);
  }
  return result;
}

/**
 * Read every host-loop workflow file and return the union of all wired loop points
 * (i.e. points that have a `loop render-hooks <point>` call site).
 *
 * @param {string} [repoRoot]  Path to the repository root. Defaults to ROOT.
 * @returns {Set<string>}
 */
function getWiredLoopPoints(repoRoot) {
  const resolvedRoot = repoRoot !== undefined ? repoRoot : ROOT;
  const result = new Set();
  for (const relPath of HOST_LOOP_FILES) {
    const absPath = path.join(resolvedRoot, relPath);
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      throw new Error('getWiredLoopPoints: cannot read host-loop file ' + absPath + ': ' + err.message);
    }
    for (const point of scanWiredPoints(content)) {
      result.add(point);
    }
  }
  return result;
}

// ─── Exports (for tests) ─────────────────────────────────────────────────────

module.exports = {
  parseLoopHostBlock,
  crossCheckRoles,
  assertPointsCoverage,
  buildContract,
  serializeContract,
  normalizeLineEndings: normalizeEol,
  STEP_WORKFLOWS,
  HOST_LOOP_FILES,
  CANONICAL_POINTS,
  EXPECTED_POINTS_BY_STEP,
  ROLE_TO_AGENT,
  scanWiredPoints,
  getWiredLoopPoints,
};

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runMain(main);
}
