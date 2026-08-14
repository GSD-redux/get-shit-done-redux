/**
 * Static frontend-evidence detector — plan-time structural corroboration for the
 * UI plan gate (#3312).
 *
 * `checkUiPresence` (ui-safety-gate.cjs) is a *vocabulary* signal: a hyphen is a
 * word boundary, so a phase section naming the repo `dashboard-financeiro` matches
 * the token `dashboard` exactly like the real UI compound `micro-frontend` does.
 * That boundary rule is intentional (#3718) and must not be weakened — instead,
 * the plan gate (`computeUiPlanGate` in check-command-router.cjs) corroborates the
 * token match against the static repo tree before blocking.
 *
 * This mirrors what the sibling post-wave gate (`computeUiSafetyGate`) already
 * does dynamically: it blocks only when `git diff HEAD~1 HEAD` touches UI files.
 * Plan time has no diff to inspect, so the corroboration here is static:
 *
 *   (a) a `package.json` (root) with a known UI-framework dependency — a project
 *       that ships react/vue/svelte/... in its manifest is a frontend regardless
 *       of file layout;
 *   (b) any `*.tsx` / `*.jsx` / `*.vue` / `*.svelte` file in the tree — the
 *       component-framework subset of `UI_FILE_EXTENSIONS_RE`
 *       (check-command-router.cjs). The weaker members of that list (css, scss,
 *       html, ...) are deliberately NOT static evidence: docs sites and
 *       markdown/bash/config repos routinely carry stray `.html`/`.css`, which
 *       is precisely the false-positive class #3312 reports.
 *
 * All I/O failures degrade to `false` (no evidence) — never throw.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Component-framework file extensions — the static-evidence subset of UI_FILE_EXTENSIONS_RE. */
export const UI_COMPONENT_FILE_RE = /\.(tsx|jsx|vue|svelte)$/i;

/**
 * UI-framework package.json dependencies (dependencies OR devDependencies).
 * Component frameworks/renderers only — deliberately excludes meta tooling
 * (typescript, eslint, ...) that non-frontend Node projects also carry.
 */
const UI_FRAMEWORK_DEPS: ReadonlySet<string> = new Set([
  'react',
  'react-dom',
  'vue',
  'svelte',
  '@sveltejs/kit',
  'angular',
  '@angular/core',
  'preact',
  'solid-js',
  'lit',
  'lit-element',
  'ember-source',
  '@remix-run/react',
  'react-native',
  'expo',
  'next',
  'nuxt',
  'gatsby',
  'astro',
  '@ionic/react',
  '@ionic/vue',
  '@ionic/angular',
]);

/** Directories never walked — dependencies, VCS data, build output, GSD planning state. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.planning',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  'vendor',
  '.cache',
]);

/** Walk safety cap — beyond this the tree is treated as scanned (evidence decided by then). */
const MAX_WALK_ENTRIES = 10_000;

function packageJsonHasUiFramework(projectDir: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8');
  } catch {
    return false; // no/unreadable package.json → no evidence from this signal
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // malformed package.json → no evidence from this signal
  }
  if (parsed === null || typeof parsed !== 'object') return false;
  const pkg = parsed as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = pkg[field];
    if (deps === null || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      if (UI_FRAMEWORK_DEPS.has(name)) return true;
    }
  }
  return false;
}

function treeHasComponentFile(projectDir: string): boolean {
  // Iterative BFS — bounded by MAX_WALK_ENTRIES so a pathological tree cannot
  // stall the gate. Symlinks are never followed (withFileTypes + isDirectory).
  const queue: string[] = [projectDir];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_WALK_ENTRIES) {
    const dir = queue.shift() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory → skip it
    }
    for (const entry of entries) {
      visited++;
      if (visited >= MAX_WALK_ENTRIES) return false;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name));
      } else if (entry.isFile() && UI_COMPONENT_FILE_RE.test(entry.name)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Does the project tree carry static evidence of a frontend?
 *
 * @param projectDir - Absolute path to the project root (the gate's cwd).
 * @returns true when package.json declares a UI-framework dependency or the
 *          tree contains a component-framework file; false otherwise (including
 *          on any I/O failure — evidence must be affirmative).
 */
export function hasStaticFrontendEvidence(projectDir: string): boolean {
  if (typeof projectDir !== 'string' || projectDir === '') return false;
  if (packageJsonHasUiFramework(projectDir)) return true;
  return treeHasComponentFile(projectDir);
}
