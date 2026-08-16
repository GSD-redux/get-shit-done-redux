#!/usr/bin/env node
/**
 * lint-command-contract.cjs  (ADR-0002)
 *
 * Enforces the commands/gsd/*.md contract across all 65 command files:
 *
 *   1. name:        present, non-empty, matches gsd: or gsd- prefix
 *   2. description: present, non-empty
 *   3. allowed-tools: block present, non-empty, all entries from CANONICAL_TOOLS
 *   4. execution_context @-refs: every @-reference resolves to an existing file on disk
 *   5. execution_context @-refs: each appears on its own line (no trailing prose)
 *   6. every gsd-core/workflows/*.md file is reachable from at least one
 *      commands/agents/skills loader, transitively through gsd-core/**
 *      (repo-level check, runs once — not per command file)
 *
 * Exit 0 = clean. Exit 1 = violations (with diagnostics).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function resolveRoot(argv) {
  const idx = argv.indexOf('--root');
  if (idx === -1) return path.join(__dirname, '..');
  const value = argv[idx + 1];
  if (!value) {
    throw new Error('lint-command-contract: --root requires a directory argument');
  }
  return path.resolve(value);
}

const ROOT          = resolveRoot(process.argv.slice(2));
const COMMANDS_DIR  = path.join(ROOT, 'commands', 'gsd');
const GSD_ROOT      = path.join(ROOT, 'gsd-core');

const {
  CANONICAL_TOOLS,
  parseFrontmatter,
  executionContextRefs: extractExecutionContextRefs,
  unreachableWorkflows,
} = require('./command-contract-helpers.cjs');

const { runMain } = require('./lib/cli-exit.cjs');

// ─── rule 6: repo-level workflow reachability ─────────────────────────────────

function walkMarkdownFiles(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
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

function toGsdRelative(absPath) {
  return path.relative(GSD_ROOT, absPath).split(path.sep).join('/');
}

function checkWorkflowReachability() {
  const loaderFiles = [
    ...walkMarkdownFiles(path.join(ROOT, 'commands'), []),
    ...walkMarkdownFiles(path.join(ROOT, 'agents'), []),
    ...walkMarkdownFiles(path.join(ROOT, 'skills'), []),
  ];
  const loaderContents = loaderFiles.map(f => fs.readFileSync(f, 'utf-8'));

  const gsdFileAbsPaths = walkMarkdownFiles(GSD_ROOT, []);
  const gsdFiles = new Map();
  for (const abs of gsdFileAbsPaths) {
    gsdFiles.set(toGsdRelative(abs), fs.readFileSync(abs, 'utf-8'));
  }

  const workflowAbsPaths = walkMarkdownFiles(path.join(GSD_ROOT, 'workflows'), []);
  const workflowPaths = workflowAbsPaths.map(toGsdRelative);

  const unreachable = unreachableWorkflows(loaderContents, gsdFiles, workflowPaths);

  return { workflowCount: workflowPaths.length, unreachable };
}

// ─── check one file ───────────────────────────────────────────────────────────

function check(filePath) {
  const content  = fs.readFileSync(filePath, 'utf-8');
  const rel      = path.relative(ROOT, filePath);
  const fm       = parseFrontmatter(content);
  const violations = [];

  // 1. name: present + gsd: / gsd- prefix
  if (!fm.name || !fm.name.trim()) {
    violations.push('name: field missing or empty');
  } else if (!/^gsd[:-]/.test(fm.name.trim())) {
    violations.push(`name: must start with "gsd:" or "gsd-", got "${fm.name.trim()}"`);
  }

  // 2. description: present + non-empty
  if (!fm.description || !fm.description.trim()) {
    violations.push('description: field missing or empty');
  }

  // 3. allowed-tools: present + non-empty + all entries canonical
  if (!fm['allowed-tools'] || !fm['allowed-tools'].trim()) {
    violations.push('allowed-tools: block missing or empty');
  } else {
    const tools = fm['allowed-tools'].split('\n').map(t => t.trim()).filter(Boolean);
    for (const tool of tools) {
      const valid =
        CANONICAL_TOOLS.has(tool) ||
        (tool.startsWith('mcp__context7__') && CANONICAL_TOOLS.has('mcp__context7__*'));
      if (!valid) violations.push(`allowed-tools: unknown tool "${tool}"`);
    }
  }

  // 4+5. execution_context @-refs resolve + no trailing prose
  const refs = extractExecutionContextRefs(content);
  for (const { token, normalized, trailingProse } of refs) {
    const absPath = path.join(GSD_ROOT, normalized);
    if (!fs.existsSync(absPath)) {
      violations.push(`execution_context: @-ref "${normalized}" does not exist on disk`);
    }
    if (trailingProse) {
      violations.push(`execution_context: @-ref "${token}" has trailing prose on the same line`);
    }
  }

  if (violations.length === 0) return null;
  return { file: rel, violations };
}

// ─── run ─────────────────────────────────────────────────────────────────────

function main() {
  const commandFiles = fs
    .readdirSync(COMMANDS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(COMMANDS_DIR, f));

  const results = commandFiles.map(check).filter(Boolean);
  const { workflowCount, unreachable } = checkWorkflowReachability();

  let ok = true;

  if (results.length === 0) {
    console.log(
      `ok lint-command-contract: ${commandFiles.length} command files checked, 0 violations`,
    );
  } else {
    ok = false;
    const total = results.reduce((n, r) => n + r.violations.length, 0);
    process.stderr.write(
      `\nERROR lint-command-contract: ${total} violation(s) across ${results.length} file(s)\n\n`,
    );
    for (const r of results) {
      process.stderr.write(`  ${r.file}\n`);
      for (const v of r.violations) {
        process.stderr.write(`    - ${v}\n`);
      }
      process.stderr.write('\n');
    }
    process.stderr.write('See docs/adr/0002-command-contract-validation-module.md for the contract spec.\n\n');
  }

  if (unreachable.length === 0) {
    console.log(
      `ok lint-command-contract: ${workflowCount} workflow files, ${workflowCount} reachable, 0 unreachable`,
    );
  } else {
    ok = false;
    process.stderr.write(
      `\nERROR lint-command-contract: ${unreachable.length} unreachable workflow file(s) of ${workflowCount}\n\n`,
    );
    for (const p of unreachable) {
      process.stderr.write(`  gsd-core/${p}\n`);
    }
    process.stderr.write(
      '\nEach file above ships to every runtime but is never referenced by any command,\n' +
      'agent, or skill loader (directly or transitively). Either wire it to a loader\n' +
      'or delete it — removing a command must sweep its orphaned workflow.\n\n',
    );
  }

  return ok ? 0 : 1;
}

runMain(main);
