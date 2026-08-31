#!/usr/bin/env node
'use strict';

/**
 * #3626: verify every CONTEXT.md `SEAM.<id>.owns=` claim carries a
 * `SEAM.<id>.enforced-by=` pointer that RESOLVES — the named lint rule is
 * registered in eslint.config.mjs and its source file exists, or the named
 * test file exists on disk. Deliberately resolves-only (maintainer decision,
 * chat, 2026-08-27): it does not verify the mechanism's surface actually
 * covers the seam's files — see .gsd/phase/feat-3626-context-seam-claim-gate/40-design.md.
 *
 * Design:      .gsd/phase/feat-3626-context-seam-claim-gate/40-design.md
 * Test matrix: .gsd/phase/feat-3626-context-seam-claim-gate/50-test-matrix.md
 *
 * Usage:
 *   node scripts/lint-seam-enforcement.cjs [path-to-context-md]
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONTEXT_PATH = path.join(ROOT, 'CONTEXT.md');
const ESLINT_CONFIG_PATH = path.join(ROOT, 'eslint.config.mjs');

const SEAM_FACT_RE = /^`SEAM\.([A-Za-z0-9_-]+)\.(owns|enforced-by)=(.*)`\s*$/;

/**
 * Extract SEAM.<id>.owns / SEAM.<id>.enforced-by facts from CONTEXT.md text.
 * Any other `*.SEAM.*` line (WORKTREE.SEAM.*, PLANNING.PATH.SEAM.*, ...) does
 * not match this anchored regex and is silently ignored — see design doc
 * "Not-corruption / negative space".
 *
 * Returns { owns: Map<id,string>, enforcedBy: Map<id,string> }.
 */
function extractSeamFacts(text) {
  const owns = new Map();
  const enforcedBy = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const match = SEAM_FACT_RE.exec(line);
    if (!match) continue;
    const [, id, key, value] = match;
    if (key === 'owns') {
      owns.set(id, value);
    } else {
      enforcedBy.set(id, value);
    }
  }
  return { owns, enforcedBy };
}

/**
 * Parse a `lint-rule:<name>` or `test:<path>` enforcement pointer value.
 * Returns { scheme: 'lint-rule'|'test'|null, target: string }.
 */
function parseEnforcementPointer(value) {
  const lintMatch = /^lint-rule:(\S+)$/.exec(value);
  if (lintMatch) return { scheme: 'lint-rule', target: lintMatch[1] };
  const testMatch = /^test:(\S+)$/.exec(value);
  if (testMatch) return { scheme: 'test', target: testMatch[1] };
  return { scheme: null, target: value };
}

/**
 * Pure check function — no filesystem access, everything injected, so the
 * unit tests can drive every branch (dangling pointer, unrecognized scheme,
 * owns-with-no-enforced-by, enforced-by-with-no-owns, ...) without touching
 * disk. `deps.ruleIsRegistered(name)` / `deps.ruleFileExists(name)` /
 * `deps.testFileExists(relPath)` are the three injected filesystem seams.
 *
 * Returns an array of finding strings; empty means clean.
 */
function checkSeamFacts({ owns, enforcedBy }, deps) {
  const findings = [];
  const ids = new Set([...owns.keys(), ...enforcedBy.keys()]);

  for (const id of ids) {
    const hasOwns = owns.has(id);
    const hasEnforcedBy = enforcedBy.has(id);

    if (hasOwns && !hasEnforcedBy) {
      findings.push(`SEAM.${id}: declared (owns=${JSON.stringify(owns.get(id))}) but no enforced-by pointer — no enforcement pointer`);
      continue;
    }
    if (hasEnforcedBy && !hasOwns) {
      findings.push(`SEAM.${id}: has enforced-by but no matching owns claim — enforcement pointer with no ownership claim`);
      continue;
    }

    const pointerValue = enforcedBy.get(id);
    const { scheme, target } = parseEnforcementPointer(pointerValue);

    if (scheme === 'lint-rule') {
      if (!deps.ruleIsRegistered(target)) {
        findings.push(`SEAM.${id}: enforced-by=lint-rule:${target} — dangling lint-rule pointer (not registered in eslint.config.mjs)`);
      } else if (!deps.ruleFileExists(target)) {
        findings.push(`SEAM.${id}: enforced-by=lint-rule:${target} — registered rule has no source file`);
      }
    } else if (scheme === 'test') {
      if (!deps.testFileExists(target)) {
        findings.push(`SEAM.${id}: enforced-by=test:${target} — dangling test-anchor pointer (file does not exist)`);
      }
    } else {
      findings.push(`SEAM.${id}: enforced-by=${JSON.stringify(pointerValue)} — unrecognized enforcement-pointer scheme (expected lint-rule: or test:)`);
    }
  }

  return findings.sort();
}

/**
 * Parse eslint.config.mjs's localPlugin.rules map to get the set of
 * registered rule names, e.g. { 'no-source-grep': ..., 'no-private-binary-resolution': ... }.
 * A textual scan, not a real ESM import — this file is a static, hand-authored
 * literal object (see eslint.config.mjs:35-60), and importing ESM config from
 * a CJS script for one lint gate is not worth the module-system friction.
 */
function readRegisteredRuleNames(eslintConfigText) {
  const rulesBlockMatch = /const localPlugin = \{\s*rules: \{([\s\S]*?)\},\s*\};/.exec(eslintConfigText);
  if (!rulesBlockMatch) return new Set();
  const names = new Set();
  const keyRe = /'([a-z0-9-]+)':/g;
  let m;
  while ((m = keyRe.exec(rulesBlockMatch[1])) !== null) {
    names.add(m[1]);
  }
  return names;
}

function main() {
  const contextPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CONTEXT_PATH;

  let contextText;
  try {
    contextText = fs.readFileSync(contextPath, 'utf8');
  } catch (error) {
    throw new ExitError(1, `lint-seam-enforcement: failed to read ${contextPath}: ${error.message}`);
  }

  let eslintConfigText = '';
  try {
    eslintConfigText = fs.readFileSync(ESLINT_CONFIG_PATH, 'utf8');
  } catch {
    eslintConfigText = '';
  }
  const registeredRules = readRegisteredRuleNames(eslintConfigText);

  const facts = extractSeamFacts(contextText);
  const totalIds = new Set([...facts.owns.keys(), ...facts.enforcedBy.keys()]).size;

  if (totalIds === 0) {
    process.stdout.write('ok lint-seam-enforcement: 0 SEAM.*.owns/enforced-by claims found in CONTEXT.md — nothing to check\n');
    return 0;
  }

  const findings = checkSeamFacts(facts, {
    ruleIsRegistered: (name) => registeredRules.has(name),
    ruleFileExists: (name) => fs.existsSync(path.join(ROOT, 'eslint-rules', `${name}.cjs`)),
    testFileExists: (relPath) => fs.existsSync(path.join(ROOT, relPath)),
  });

  if (findings.length === 0) {
    process.stdout.write(`ok lint-seam-enforcement: ${totalIds} seam claim(s) checked, all enforcement pointers resolve\n`);
    return 0;
  }

  process.stderr.write(`ERROR lint-seam-enforcement: ${findings.length} unbacked seam claim(s) in ${path.relative(ROOT, contextPath)}\n`);
  for (const finding of findings) {
    process.stderr.write(`  - ${finding}\n`);
  }
  process.stderr.write('Every SEAM.<id>.owns claim needs a SEAM.<id>.enforced-by=lint-rule:<name>|test:<path> pointer that resolves.\n');
  process.stderr.write('Back the claim with a real, registered rule or existing test, or correct the prose to stop claiming single ownership.\n');
  return 1;
}

module.exports = { extractSeamFacts, parseEnforcementPointer, checkSeamFacts, readRegisteredRuleNames };

if (require.main === module) {
  runMain(main);
}
