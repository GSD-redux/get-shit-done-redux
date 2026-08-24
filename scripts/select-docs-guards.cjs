#!/usr/bin/env node
'use strict';

/**
 * select-docs-guards.cjs — pure selector mapping a PR's changed docs/ paths
 * to the subset of scripts/docs-guard-registry.cjs's DOCS_GUARD_TESTS that
 * actually reads any of them (#3753 follow-up).
 *
 * Deliberately dependency-free: no fs, no git, no process. Callers (the
 * docs-required.yml workflow, tests) are responsible for producing the
 * changed-paths list and reading the registry; this module only implements
 * the matching semantics so they are independently unit-testable.
 *
 * Pattern semantics (mirrors scripts/docs-guard-registry.cjs's header doc):
 *   - a plain path matches an exact changed path;
 *   - a trailing-slash path is a DIRECTORY PREFIX match — 'docs/adr/'
 *     matches 'docs/adr/README.md' but must NOT match 'docs/adrenaline.md'
 *     (a naive `startsWith('docs/adr')` without the trailing slash would
 *     wrongly match the latter; matching against the full prefix INCLUDING
 *     the trailing slash is what keeps this boundary correct);
 *   - the sentinel '*' matches any non-empty changedDocsPaths.
 */

/**
 * @param {string} changedPath - a single changed docs/ path (e.g. 'docs/AGENTS.md').
 * @param {string} pattern - one entry from a registry value array.
 * @returns {boolean}
 */
function patternMatches(changedPath, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('/')) return changedPath.startsWith(pattern);
  return changedPath === pattern;
}

/**
 * @param {string[]} changedDocsPaths - repo-relative paths under docs/ that
 *   changed in this PR. An empty array always yields an empty selection.
 * @param {Record<string, string[]>} registry - DOCS_GUARD_TESTS shape: test
 *   file -> array of patterns it reads.
 * @returns {string[]} sorted, deduped list of selected test file paths.
 */
function selectDocsGuards(changedDocsPaths, registry) {
  if (!Array.isArray(changedDocsPaths) || changedDocsPaths.length === 0) return [];

  const selected = new Set();
  for (const [testFile, patterns] of Object.entries(registry)) {
    const hit = patterns.some((pattern) =>
      changedDocsPaths.some((changedPath) => patternMatches(changedPath, pattern)),
    );
    if (hit) selected.add(testFile);
  }

  return [...selected].sort();
}

module.exports = { selectDocsGuards, patternMatches };
