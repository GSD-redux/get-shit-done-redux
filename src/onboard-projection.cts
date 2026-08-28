import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtils = require('./core-utils.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';

const { pathExistsInternal, toPosixPath } = coreUtils;
const { planningDir, planningRoot } = planningWorkspace;

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.swift', '.java',
  '.kt', '.kts', '.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.rb', '.php', '.dart',
  '.m', '.mm', '.scala', '.groovy', '.lua', '.r', '.R', '.zig', '.ex', '.exs', '.clj',
]);

const CODE_SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', '.planning', '.claude', '.codex', '__pycache__', 'target',
  'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage', 'vendor', '.venv', 'venv',
]);

const PACKAGE_FILES = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  'Package.swift', 'build.gradle', 'build.gradle.kts', 'pom.xml', 'Gemfile',
  'composer.json', 'pubspec.yaml', 'CMakeLists.txt', 'Makefile', 'build.zig',
  'mix.exs', 'project.clj',
];

const REQUIRED_CODEBASE_MAP_FILES = [
  'STACK.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md',
  'INTEGRATIONS.md', 'CONCERNS.md',
];

const FAST_CODEBASE_MAP_FILES = [
  'STACK.md', 'INTEGRATIONS.md', 'ARCHITECTURE.md', 'STRUCTURE.md',
];

const PLANNING_DOC_SEGMENTS = new Set([
  'adr', 'adrs', 'prd', 'prds', 'spec', 'specs', 'rfc', 'rfcs',
]);

type MapReadiness = 'none' | 'fast' | 'complete';

interface OnboardHandoffCommands {
  ingest_docs: string;
  manager: string;
  map_codebase: string;
  map_codebase_fast: string;
  new_project: string;
  onboard: string;
}

type OnboardNextAction =
  | { kind: 'map-codebase'; command: string; reason: string }
  | { kind: 'ingest-docs'; command: string; reason: string }
  | { kind: 'new-project'; command: string; reason: string }
  | { kind: 'complete-map-before-new-project'; command: string; reason: string }
  | { kind: 'partial-planning'; missing: string[]; reason: string }
  | { kind: 'write-summary'; summary_path: string; reason: string }
  | { kind: 'ready'; reason: string };

interface BuildOnboardProjectionOptions {
  commitDocs: boolean;
  fast: boolean;
  textMode: boolean;
}

interface OnboardProjection {
  commit_docs: boolean;
  text_mode: boolean;

  project_exists: boolean;
  planning_exists: boolean;
  requirements_exists: boolean;
  roadmap_exists: boolean;
  state_exists: boolean;
  config_exists: boolean;

  handoff_commands: OnboardHandoffCommands;

  has_existing_code: boolean;
  has_package_file: boolean;
  is_brownfield: boolean;
  fast_mode: boolean;
  map_readiness: MapReadiness;
  next_action: OnboardNextAction;
  needs_codebase_map: boolean;
  needs_fast_codebase_map: boolean;
  has_codebase_map: boolean;
  has_fast_codebase_map: boolean;
  codebase_dir_exists: boolean;
  fast_codebase_map_files_required: string[];
  codebase_map_files_present: string[];
  missing_codebase_map_files: string[];
  missing_fast_codebase_map_files: string[];
  codebase_map_summary_status: string;
  codebase_map_final_status: string;

  has_docs_candidates: boolean;
  doc_candidate_count: number;
  doc_candidates: string[];

  onboarding_summary_exists: boolean;
  onboarding_summary_path: string;

  project_path: string;
  requirements_path: string;
  roadmap_path: string;
  state_path: string;
  codebase_dir: string;
  onboarding_dir: string;
}

function hasCodeFilesInternal(dir: string, depth = 0): boolean {
  if (depth > 3) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) return true;
    if (entry.isDirectory() && !CODE_SCAN_SKIP_DIRS.has(entry.name)) {
      if (hasCodeFilesInternal(path.join(dir, entry.name), depth + 1)) return true;
    }
  }

  return false;
}

function hasPackageFileInternal(cwd: string): boolean {
  return PACKAGE_FILES.some((file) => pathExistsInternal(cwd, file));
}

function listPlanningDocCandidates(cwd: string): string[] {
  const roots = ['docs', 'adr', 'adrs', 'prd', 'prds', 'spec', 'specs', 'rfc', 'rfcs'];
  const candidates = new Set<string>();

  function isPlanningDocCandidate(rel: string, name: string): boolean {
    const upperName = name.toUpperCase();
    const relLower = rel.toLowerCase();
    const pathSegments = relLower.split('/');
    return (
      /(^|[-_ ])(ADR|PRD|SPEC|RFC)([-_ ]|\.)/i.test(name) ||
      /^\d{4}[-_].+\.md$/i.test(name) ||
      pathSegments.some((segment) => PLANNING_DOC_SEGMENTS.has(segment)) ||
      upperName === 'REQUIREMENTS.MD'
    );
  }

  function addCandidate(rel: string, name: string): void {
    if (name.toLowerCase().endsWith('.md') && isPlanningDocCandidate(rel, name)) {
      candidates.add(toPosixPath(rel));
    }
  }

  function visit(dir: string, relDir: string, depth: number): void {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!CODE_SCAN_SKIP_DIRS.has(entry.name)) {
          visit(path.join(dir, entry.name), rel, depth + 1);
        }
        continue;
      }

      if (entry.isFile()) addCandidate(rel, entry.name);
    }
  }

  let rootEntries: fs.Dirent[] = [];
  try {
    rootEntries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    rootEntries = [];
  }

  for (const entry of rootEntries) {
    if (entry.isFile()) addCandidate(entry.name, entry.name);
  }

  for (const root of roots) {
    const full = path.join(cwd, root);
    if (fs.existsSync(full)) visit(full, root, 0);
  }

  return [...candidates].sort();
}

function listCodebaseMapFiles(cwd: string): string[] {
  // #3964: project-scoped, agreeing with init's map-codebase surface and
  // verify.cts's codebase drift check — a flat-root read made
  // has_codebase_map/needs_codebase_map answer for the wrong project under
  // GSD_PROJECT.
  const codebaseDir = path.join(planningDir(cwd), 'codebase');
  if (!fs.existsSync(codebaseDir)) return [];
  return REQUIRED_CODEBASE_MAP_FILES.filter((file) =>
    fs.existsSync(path.join(codebaseDir, file)),
  );
}

function getMapReadiness(hasCompleteMap: boolean, hasFastMap: boolean): MapReadiness {
  if (hasCompleteMap) return 'complete';
  if (hasFastMap) return 'fast';
  return 'none';
}

function mapSummaryStatus(mapReadiness: MapReadiness): string {
  if (mapReadiness === 'complete') return '.planning/codebase/ (complete codebase map)';
  if (mapReadiness === 'fast') return '.planning/codebase/ (fast/partial codebase map; complete map still required for project setup)';
  return 'missing';
}

function mapFinalStatus(mapReadiness: MapReadiness): string {
  if (mapReadiness === 'complete') return 'complete';
  if (mapReadiness === 'fast') return 'fast/partial; complete map still required for project setup';
  return 'missing';
}

function planningMissing(
  projectExists: boolean,
  requirementsExists: boolean,
  roadmapExists: boolean,
  stateExists: boolean,
): string[] {
  const missing: string[] = [];
  if (!projectExists) missing.push('PROJECT.md');
  if (!requirementsExists) missing.push('REQUIREMENTS.md');
  if (!roadmapExists) missing.push('ROADMAP.md');
  if (!stateExists) missing.push('STATE.md');
  return missing;
}

function nextAction(params: {
  fastMode: boolean;
  isBrownfield: boolean;
  needsOnboardCodebaseMap: boolean;
  hasDocsCandidates: boolean;
  projectExists: boolean;
  mapReadiness: MapReadiness;
  onboardingSummaryExists: boolean;
  onboardingSummaryPath: string;
  hasPlanningArtifacts: boolean;
  missingPlanningFiles: string[];
  handoffCommands: OnboardHandoffCommands;
}): OnboardNextAction {
  if (params.isBrownfield && params.needsOnboardCodebaseMap) {
    return {
      kind: 'map-codebase',
      command: params.fastMode ? params.handoffCommands.map_codebase_fast : params.handoffCommands.map_codebase,
      reason: 'Existing code was detected, but the required .planning/codebase/ map is missing.',
    };
  }

  if (params.hasPlanningArtifacts && params.missingPlanningFiles.length > 0) {
    return {
      kind: 'partial-planning',
      missing: params.missingPlanningFiles,
      reason: 'Project planning exists but required planning files are missing.',
    };
  }

  if (params.fastMode && params.mapReadiness === 'fast' && !params.projectExists) {
    return {
      kind: 'complete-map-before-new-project',
      command: params.handoffCommands.map_codebase,
      reason: 'The fast map is enough for lightweight onboarding, but project setup still requires the complete codebase map.',
    };
  }

  if (params.hasDocsCandidates && !params.projectExists) {
    return {
      kind: 'ingest-docs',
      command: params.handoffCommands.ingest_docs,
      reason: 'Detected existing ADR/PRD/SPEC/RFC document(s) before project setup.',
    };
  }

  if (!params.isBrownfield && !params.projectExists && !params.hasDocsCandidates) {
    return {
      kind: 'new-project',
      command: params.handoffCommands.new_project,
      reason: 'No existing code or planning docs were detected.',
    };
  }

  if (!params.projectExists) {
    return {
      kind: 'new-project',
      command: params.handoffCommands.new_project,
      reason: 'Codebase context is ready for project initialization.',
    };
  }

  if (!params.onboardingSummaryExists) {
    return {
      kind: 'write-summary',
      summary_path: params.onboardingSummaryPath,
      reason: 'Onboarding summary is missing.',
    };
  }

  return {
    kind: 'ready',
    reason: 'Onboarding summary already exists.',
  };
}

function buildHandoffCommands(cwd: string): OnboardHandoffCommands {
  const runtime = resolveRuntime(cwd);
  return {
    ingest_docs: formatGsdSlash('ingest-docs', runtime) as string,
    manager: formatGsdSlash('manager', runtime) as string,
    map_codebase: formatGsdSlash('map-codebase', runtime) as string,
    map_codebase_fast: formatGsdSlash('map-codebase --fast', runtime) as string,
    new_project: formatGsdSlash('new-project', runtime) as string,
    onboard: formatGsdSlash('onboard', runtime) as string,
  };
}

function buildOnboardProjection(cwd: string, options: BuildOnboardProjectionOptions): OnboardProjection {
  const handoffCommands = buildHandoffCommands(cwd);
  const codebaseMapFiles = listCodebaseMapFiles(cwd);
  const missingCodebaseMapFiles = REQUIRED_CODEBASE_MAP_FILES.filter(
    (file) => !codebaseMapFiles.includes(file),
  );
  const missingFastCodebaseMapFiles = FAST_CODEBASE_MAP_FILES.filter(
    (file) => !codebaseMapFiles.includes(file),
  );
  const docCandidates = listPlanningDocCandidates(cwd);
  const hasCode = hasCodeFilesInternal(cwd);
  const hasPackageFile = hasPackageFileInternal(cwd);
  const isBrownfield = hasCode || hasPackageFile;
  const hasCodebaseMap = codebaseMapFiles.length === REQUIRED_CODEBASE_MAP_FILES.length;
  const hasFastCodebaseMap = missingFastCodebaseMapFiles.length === 0;
  const mapReadinessValue = getMapReadiness(hasCodebaseMap, hasFastCodebaseMap);
  const needsCodebaseMap = isBrownfield && !hasCodebaseMap;
  const needsFastCodebaseMap = isBrownfield && !hasFastCodebaseMap;
  const needsOnboardCodebaseMap = options.fast ? needsFastCodebaseMap : needsCodebaseMap;
  const projectRootPath = path.join(planningRoot(cwd), 'PROJECT.md');
  const projectScopedPath = path.join(planningDir(cwd), 'PROJECT.md');
  const projectExists =
    fs.existsSync(projectRootPath) || fs.existsSync(projectScopedPath);
  const requirementsExists = fs.existsSync(path.join(planningDir(cwd), 'REQUIREMENTS.md'));
  const roadmapExists = fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md'));
  const stateExists = fs.existsSync(path.join(planningDir(cwd), 'STATE.md'));
  const onboardingSummaryPath = path.join(planningRoot(cwd), 'onboarding', 'SUMMARY.md');
  const onboardingSummaryExists = fs.existsSync(onboardingSummaryPath);
  const hasPlanningArtifacts = projectExists || requirementsExists || roadmapExists || stateExists;
  const missingPlanningFiles = planningMissing(
    projectExists,
    requirementsExists,
    roadmapExists,
    stateExists,
  );

  return {
    commit_docs: options.commitDocs,
    text_mode: options.textMode,

    project_exists: projectExists,
    planning_exists: fs.existsSync(planningRoot(cwd)),
    requirements_exists: requirementsExists,
    roadmap_exists: roadmapExists,
    state_exists: stateExists,
    config_exists: fs.existsSync(path.join(planningDir(cwd), 'config.json')),

    handoff_commands: handoffCommands,

    has_existing_code: hasCode,
    has_package_file: hasPackageFile,
    is_brownfield: isBrownfield,
    fast_mode: options.fast,
    map_readiness: mapReadinessValue,
    next_action: nextAction({
      fastMode: options.fast,
      isBrownfield,
      needsOnboardCodebaseMap,
      hasDocsCandidates: docCandidates.length > 0,
      projectExists,
      mapReadiness: mapReadinessValue,
      onboardingSummaryExists,
      // #2376: absolute (anchored on cwd/project_root), not orchestrator-cwd-relative —
      // a spawned subagent's own cwd may differ from the orchestrator's.
      onboardingSummaryPath: toPosixPath(onboardingSummaryPath),
      hasPlanningArtifacts,
      missingPlanningFiles,
      handoffCommands,
    }),
    needs_codebase_map: needsCodebaseMap,
    needs_fast_codebase_map: needsFastCodebaseMap,
    has_codebase_map: hasCodebaseMap,
    has_fast_codebase_map: hasFastCodebaseMap,
    codebase_dir_exists: fs.existsSync(path.join(planningRoot(cwd), 'codebase')),
    fast_codebase_map_files_required: FAST_CODEBASE_MAP_FILES,
    codebase_map_files_present: codebaseMapFiles,
    missing_codebase_map_files: missingCodebaseMapFiles,
    missing_fast_codebase_map_files: missingFastCodebaseMapFiles,
    codebase_map_summary_status: mapSummaryStatus(mapReadinessValue),
    codebase_map_final_status: mapFinalStatus(mapReadinessValue),

    has_docs_candidates: docCandidates.length > 0,
    doc_candidate_count: docCandidates.length,
    doc_candidates: docCandidates,

    onboarding_summary_exists: onboardingSummaryExists,
    // #2376: absolute — see comment on onboardingSummaryPath above.
    onboarding_summary_path: toPosixPath(onboardingSummaryPath),

    project_path: toPosixPath(fs.existsSync(projectRootPath) ? projectRootPath : projectScopedPath),
    requirements_path: toPosixPath(path.join(planningDir(cwd), 'REQUIREMENTS.md')),
    roadmap_path: toPosixPath(path.join(planningDir(cwd), 'ROADMAP.md')),
    state_path: toPosixPath(path.join(planningDir(cwd), 'STATE.md')),
    codebase_dir: toPosixPath(path.join(planningRoot(cwd), 'codebase')),
    onboarding_dir: toPosixPath(path.join(planningRoot(cwd), 'onboarding')),
  };
}

export = {
  REQUIRED_CODEBASE_MAP_FILES,
  FAST_CODEBASE_MAP_FILES,
  buildOnboardProjection,
  hasCodeFilesInternal,
  hasPackageFileInternal,
  listCodebaseMapFiles,
  listPlanningDocCandidates,
};
