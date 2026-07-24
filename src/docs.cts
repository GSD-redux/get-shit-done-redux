/**
 * Docs — Commands for the docs-update workflow
 *
 * Provides `cmdDocsInit` which returns project signals, existing doc inventory
 * with GSD marker detection, doc tooling detection, monorepo awareness, and
 * model resolution. Used by Phase 2 to route doc generation appropriately.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/docs.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { loadConfig } = configLoader;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelResolver = require('./model-resolver.cjs');
const { resolveModelInternal } = modelResolver;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { pathExistsInternal, toPosixPath } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import agentInstallCheck = require('./agent-install-check.cjs');
const { checkAgentsInstalled } = agentInstallCheck;
import { resolveRuntime } from './runtime-slash.cjs';
import { platformReadSync } from './shell-command-projection.cjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const GSD_MARKER = '<!-- generated-by: gsd-doc-writer -->';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.planning', '.claude', '__pycache__',
  'target', 'dist', 'build', '.next', '.nuxt', 'coverage',
  '.vscode', '.idea',
]);

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Check whether a file begins with the GSD doc writer marker.
 * Reads the first 500 bytes only — avoids loading large files.
 */
function hasGsdMarker(filePath: string): boolean {
  try {
    const buf = Buffer.alloc(500);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 500, 0);
    fs.closeSync(fd);
    return buf.slice(0, bytesRead).toString('utf-8').includes(GSD_MARKER);
  } catch {
    return false;
  }
}

interface DocEntry {
  path: string;
  has_gsd_marker: boolean;
}

/**
 * Recursively scan the project root (immediate .md files) and docs/ directory
 * (up to 4 levels deep) for Markdown files, excluding dirs in SKIP_DIRS.
 */
function scanExistingDocs(cwd: string): DocEntry[] {
  const MAX_DEPTH = 4;
  const results: DocEntry[] = [];

  function walkDir(dir: string, depth: number): void {
    if (depth > MAX_DEPTH) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(abs, depth + 1);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const rel = toPosixPath(path.relative(cwd, abs));
          results.push({ path: rel, has_gsd_marker: hasGsdMarker(abs) });
        }
      }
    } catch { /* directory may not exist — best-effort */ }
  }

  // Scan root-level .md files (non-recursive)
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const abs = path.join(cwd, entry.name);
        const rel = toPosixPath(path.relative(cwd, abs));
        results.push({ path: rel, has_gsd_marker: hasGsdMarker(abs) });
      }
    }
  } catch { /* best-effort */ }

  // Recursively scan docs/ directory
  const docsDir = path.join(cwd, 'docs');
  walkDir(docsDir, 1);

  // Fallback: if docs/ does not exist, try documentation/ or doc/
  try {
    fs.statSync(docsDir);
  } catch {
    const alternatives = ['documentation', 'doc'];
    for (const alt of alternatives) {
      const altDir = path.join(cwd, alt);
      try {
        const stat = fs.statSync(altDir);
        if (stat.isDirectory()) {
          walkDir(altDir, 1);
          break;
        }
      } catch { /* not present */ }
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

interface ProjectTypeSignals {
  has_package_json: boolean;
  has_api_routes: boolean;
  has_cli_bin: boolean;
  is_open_source: boolean;
  has_deploy_config: boolean;
  is_monorepo: boolean;
  has_tests: boolean;
}

/**
 * Detect project type signals from the filesystem and package.json.
 * All checks are best-effort and never throw.
 */
function detectProjectType(cwd: string): ProjectTypeSignals {
  const exists = (rel: string): boolean => {
    try { return pathExistsInternal(cwd, rel); } catch { return false; }
  };

  // Read package.json once — used by has_cli_bin, is_monorepo, has_tests checks.
  const pkgRaw = platformReadSync(path.join(cwd, 'package.json'));
  let pkg: Record<string, unknown> | null = null;
  if (pkgRaw) {
    try { pkg = JSON.parse(pkgRaw) as Record<string, unknown>; } catch { /* invalid JSON */ }
  }

  // has_cli_bin: package.json has a `bin` field
  const binField = pkg?.['bin'];
  const has_cli_bin = !!(binField && (
    typeof binField === 'string' ||
    (typeof binField === 'object' && Object.keys(binField).length > 0)
  ));

  // is_monorepo: pnpm-workspace.yaml, lerna.json, or package.json workspaces
  let is_monorepo = exists('pnpm-workspace.yaml') || exists('lerna.json');
  if (!is_monorepo && pkg) {
    is_monorepo = Array.isArray(pkg['workspaces']) && (pkg['workspaces'] as unknown[]).length > 0;
  }

  // has_tests: common test directories or test frameworks in devDependencies
  let has_tests = exists('test') || exists('tests') || exists('__tests__') || exists('spec');
  if (!has_tests && pkg) {
    const devDeps = Object.keys((pkg['devDependencies'] as Record<string, unknown> | undefined) || {});
    has_tests = devDeps.some(d => ['vitest', 'jest', 'mocha', 'jasmine', 'ava'].includes(d));
  }

  // has_deploy_config: various deployment config files
  const deployFiles = [
    'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
    'fly.toml', 'render.yaml', 'vercel.json', 'netlify.toml', 'railway.json',
    '.github/workflows/deploy.yml', '.github/workflows/deploy.yaml',
  ];
  const has_deploy_config = deployFiles.some(f => exists(f));

  return {
    has_package_json: exists('package.json'),
    has_api_routes: (
      exists('src/app/api') || exists('routes') || exists('src/routes') ||
      exists('api') || exists('server')
    ),
    has_cli_bin,
    is_open_source: exists('LICENSE') || exists('LICENSE.md'),
    has_deploy_config,
    is_monorepo,
    has_tests,
  };
}

interface DocToolingSignals {
  docusaurus: boolean;
  vitepress: boolean;
  mkdocs: boolean;
  storybook: boolean;
}

/**
 * Detect known documentation tooling in the project.
 */
function detectDocTooling(cwd: string): DocToolingSignals {
  const exists = (rel: string): boolean => {
    try { return pathExistsInternal(cwd, rel); } catch { return false; }
  };

  return {
    docusaurus: exists('docusaurus.config.js') || exists('docusaurus.config.ts'),
    vitepress: (
      exists('.vitepress/config.js') ||
      exists('.vitepress/config.ts') ||
      exists('.vitepress/config.mts')
    ),
    mkdocs: exists('mkdocs.yml'),
    storybook: exists('.storybook'),
  };
}

/**
 * Extract monorepo workspace globs from pnpm-workspace.yaml, package.json
 * workspaces, or lerna.json.
 */
function detectMonorepoWorkspaces(cwd: string): string[] {
  // pnpm-workspace.yaml
  const pnpmRaw = platformReadSync(path.join(cwd, 'pnpm-workspace.yaml'));
  if (pnpmRaw) {
    const workspaces: string[] = [];
    for (const line of pnpmRaw.split('\n')) {
      const m = line.match(/^\s*-\s+['"]?(.+?)['"]?\s*$/);
      if (m) workspaces.push(m[1].trim());
    }
    if (workspaces.length > 0) return workspaces;
  }

  // package.json workspaces
  const pkgRaw = platformReadSync(path.join(cwd, 'package.json'));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      if (Array.isArray(pkg['workspaces']) && (pkg['workspaces'] as unknown[]).length > 0) {
        return pkg['workspaces'] as string[];
      }
    } catch { /* invalid JSON */ }
  }

  // lerna.json
  const lernaRaw = platformReadSync(path.join(cwd, 'lerna.json'));
  if (lernaRaw) {
    try {
      const lerna = JSON.parse(lernaRaw) as Record<string, unknown>;
      if (Array.isArray(lerna['packages']) && (lerna['packages'] as unknown[]).length > 0) {
        return lerna['packages'] as string[];
      }
    } catch { /* invalid JSON */ }
  }

  return [];
}

// ─── Public commands ──────────────────────────────────────────────────────────

/**
 * Return JSON context for the docs-update workflow: project signals, existing
 * doc inventory, doc tooling detection, monorepo workspaces, and model
 * resolution. Follows the cmdInitMapCodebase pattern.
 *
 * @example
 * node gsd-tools.cjs docs-init --raw
 */
function cmdDocsInit(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const result: Record<string, unknown> = {
    doc_writer_model: resolveModelInternal(cwd, 'gsd-doc-writer'),
    commit_docs: config.commit_docs,
    existing_docs: scanExistingDocs(cwd),
    project_type: detectProjectType(cwd),
    doc_tooling: detectDocTooling(cwd),
    monorepo_workspaces: detectMonorepoWorkspaces(cwd),
    planning_exists: pathExistsInternal(cwd, '.planning'),
  };
  // Inject project_root and agent installation status (mirrors withProjectRoot in init.cjs)
  result['project_root'] = cwd;
  const agentStatus = checkAgentsInstalled(resolveRuntime(cwd), cwd);
  result['agents_installed'] = agentStatus.agents_installed;
  result['missing_agents'] = agentStatus.missing_agents;
  // #2402: withProjectRoot injects response_language when set; cmdDocsInit predates
  // that helper and never picked it up, so docs-update's orchestrator-owned prompts
  // silently stayed English even with response_language configured.
  if (config.response_language) {
    result['response_language'] = config.response_language;
  }
  output(result, raw, undefined);
}

export = { cmdDocsInit };
