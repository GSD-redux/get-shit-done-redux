/**
 * Roadmap Upgrade — Migration tool for converting legacy 'Phase N' phase IDs
 * to milestone-prefixed 'Phase M-NN' form.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/roadmap-upgrade.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { retryRenameSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { planningDir } = planningWorkspace;
const { stripProjectCodePrefix, PHASE_NUMBER_TOKEN_SOURCE } = phaseIdMod;

// ─── Regex helpers ────────────────────────────────────────────────────────────

// Matches legacy phase headings: ### Phase N: Name  (also decimal: Phase 2.1:)
// Captures: (hashes)(spaces)(phase-number)(rest-of-line)
const LEGACY_PHASE_HEADING_RE = new RegExp(
  `^(#{2,4})\\s*(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})\\s*:(.*)`,
  'i'
);

// Matches already-migrated phase headings: ### Phase M-NN: Name
const MIGRATED_PHASE_HEADING_RE = /^#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+\d+-\d{2}\s*:/i;

// Matches milestone section headings: ## v1.0, ## Roadmap v2.0, ## ✅ v1.0, ## [GSD] v1.0, etc.
// The optional bracket-token prefix (e.g., [GSD]) must be tested before the emoji group.
const MILESTONE_HEADING_RE = /^##\s+(?:\[[^\]]{1,200}\]\s+|Roadmap\s+|[✅🚧]\s*)?v(\d+)\.(\d+)(?:\s|:)/iu;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedPhaseEntry {
  lineIndex: number;
  headingLine: string;
  alreadyMigrated: boolean;
  milestoneInt?: number | null;
  legacyPhaseNum?: string;
  phaseName?: string;
  hashes?: string;
}

interface AssignedMapping {
  newId: string;
  milestoneInt: number;
  subIndex: number;
  legacyPhaseNum: string;
}

interface PhaseRename {
  oldId: string;
  newId: string;
  oldDir: string;
  newDir: string;
}

interface RoadmapEdit {
  lineIndex: number;
  from: string;
  to: string;
}

interface CrossRefEdit {
  file: string;
  from: string;
  to: string;
}

interface MigrationPlan {
  alreadyMigrated: boolean;
  phases: PhaseRename[];
  roadmapEdits: RoadmapEdit[];
  crossRefEdits: CrossRefEdit[];
}

interface ApplyMigrationResult {
  applied?: boolean;
  alreadyMigrated?: boolean;
  dryRun?: boolean;
  renamedDirs?: string[];
  editedFiles?: string[];
}

// ─── Pure computation helpers ─────────────────────────────────────────────────

/**
 * Parse the ROADMAP.md content and build a list of phase entries with their
 * enclosing milestone major version.
 *
 * Returns an array of:
 *   { lineIndex, headingLine, milestoneInt, legacyPhaseNum, phaseName }
 */
function parseRoadmapPhases(lines: string[]): ParsedPhaseEntry[] {
  const results: ParsedPhaseEntry[] = [];
  let currentMilestoneInt: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const milestoneMatch = line.match(MILESTONE_HEADING_RE);
    if (milestoneMatch) {
      currentMilestoneInt = parseInt(milestoneMatch[1], 10);
      continue;
    }

    if (MIGRATED_PHASE_HEADING_RE.test(line)) {
      // Already-migrated heading found — caller will detect this
      results.push({ lineIndex: i, headingLine: line, alreadyMigrated: true });
      continue;
    }

    const phaseMatch = line.match(LEGACY_PHASE_HEADING_RE);
    if (phaseMatch) {
      results.push({
        lineIndex: i,
        headingLine: line,
        milestoneInt: currentMilestoneInt,
        legacyPhaseNum: phaseMatch[2],
        phaseName: phaseMatch[3].trim(),
        hashes: phaseMatch[1],
        alreadyMigrated: false,
      });
    }
  }

  return results;
}

/**
 * Assign sub-indices within each milestone, building a per-entry mapping.
 *
 * Input: array from parseRoadmapPhases (non-migrated entries only).
 * Returns: Map<lineIndex, { newId, milestoneInt, subIndex }>
 *
 * Keyed by `lineIndex` (the unique position of the heading line in ROADMAP.md)
 * so that identical legacy phase numbers in different milestones (e.g., two
 * `Phase 1` headings in v1.0 and v2.0) each get their own correct M-NN ID
 * instead of the later milestone's mapping overwriting the earlier one.
 *
 * Sub-indices are 1-based and sequential within each milestone.
 */
function assignSubIndices(phaseEntries: ParsedPhaseEntry[]): Map<number, AssignedMapping> {
  const milestoneCounters = new Map<number, number>(); // milestoneInt → counter
  const mapping = new Map<number, AssignedMapping>(); // lineIndex → { newId, milestoneInt, subIndex }

  for (const entry of phaseEntries) {
    if (entry.alreadyMigrated) continue;
    const m = entry.milestoneInt;
    if (m === null || m === undefined) continue;

    const counter = (milestoneCounters.get(m) || 0) + 1;
    milestoneCounters.set(m, counter);

    const subIndex = String(counter).padStart(2, '0');
    const newId = `${m}-${subIndex}`;

    mapping.set(entry.lineIndex, { newId, milestoneInt: m, subIndex: counter, legacyPhaseNum: entry.legacyPhaseNum! });
  }

  return mapping;
}

/**
 * Read a phase directory name and return its numeric token (stripping project_code prefix).
 * e.g. "GSD-01-setup" → "01", "01-setup" → "01", "02-implement" → "02", "02.1-hotfix" → "02.1"
 */
function extractPhaseNumFromDir(dirName: string): string | null {
  // Strip optional project_code prefix: "GSD-01-setup" → "01-setup"
  const stripped = stripProjectCodePrefix(dirName);
  // Matches: digits + optional letter + optional decimal suffix, followed by '-' or end.
  // e.g. "02.1-hotfix" → "02.1", "01-setup" → "01"
  const m = stripped.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})(?:-|$)`, 'i'));
  return m ? m[1] : null;
}


/**
 * Build the new directory name from old name and new phase ID.
 * old: "01-setup"         newId: "1-02"  projectCode: "GSD"  → "GSD-01-02-setup"
 * old: "01-setup"         newId: "1-02"  projectCode: null   → "01-02-setup"
 * old: "GSD-01-setup"     newId: "1-02"  projectCode: "GSD"  → "GSD-01-02-setup"
 */
function buildNewDirName(oldDirName: string, newId: string, projectCode: string | null): string {
  // Strip existing project_code prefix
  const stripped = stripProjectCodePrefix(oldDirName);

  // Extract slug: everything after "NN-" (the old phase num, including decimal like 02.1)
  const slugMatch = stripped.match(new RegExp(`^${PHASE_NUMBER_TOKEN_SOURCE}-(.*)`, 'i'));
  const slug = slugMatch ? slugMatch[1] : stripped;

  // Build M-NN prefix (zero-pad both parts)
  const [milestoneStr, subStr] = newId.split('-');
  const milestoneInt = parseInt(milestoneStr, 10);
  const paddedMilestone = String(milestoneInt).padStart(2, '0');
  const newBase = slug ? `${paddedMilestone}-${subStr}-${slug}` : `${paddedMilestone}-${subStr}`;

  return projectCode ? `${projectCode}-${newBase}` : newBase;
}

// ─── computeMigrationPlan ─────────────────────────────────────────────────────

/**
 * Compute a migration plan without touching the filesystem.
 */
function computeMigrationPlan(cwd: string, options: Record<string, unknown> = {}): MigrationPlan {
  void options;
  const pDir = planningDir(cwd);
  const roadmapPath = path.join(pDir, 'ROADMAP.md');
  const configPath = path.join(pDir, 'config.json');
  const phasesDir = path.join(pDir, 'phases');

  // ── Check config for existing convention ─────────────────────────────────
  let configData: Record<string, unknown> = {};
  try {
    configData = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch { /* config may not exist */ }

  if (configData['phase_id_convention'] === 'milestone-prefixed') {
    return { alreadyMigrated: true, phases: [], roadmapEdits: [], crossRefEdits: [] };
  }

  const projectCode = typeof configData['project_code'] === 'string' ? configData['project_code'] : null;

  // ── Read ROADMAP.md ───────────────────────────────────────────────────────
  let roadmapContent = '';
  try {
    roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
  } catch {
    throw new Error(`ROADMAP.md not found at ${roadmapPath}`);
  }

  const lines = roadmapContent.split('\n');
  const parsedPhases = parseRoadmapPhases(lines);

  // Check for any already-migrated headings
  const hasAnyMigrated = parsedPhases.some(e => e.alreadyMigrated);
  if (hasAnyMigrated) {
    return { alreadyMigrated: true, phases: [], roadmapEdits: [], crossRefEdits: [] };
  }

  const legacyPhases = parsedPhases.filter(e => !e.alreadyMigrated);
  const idMapping = assignSubIndices(legacyPhases);

  // Secondary lookup: (milestoneInt, normalizedLegacyNum) → newId
  // Used for directory renames and checklist rewrites where line position is unknown.
  // For simplicity, each milestone gets its own Map from legacy num → newId.
  const milestoneIdMap = new Map<number, Map<string, string>>(); // milestoneInt → Map<normalizedLegacyNum, newId>
  for (const [, entry] of idMapping) {
    if (!milestoneIdMap.has(entry.milestoneInt)) {
      milestoneIdMap.set(entry.milestoneInt, new Map<string, string>());
    }
    const mMap = milestoneIdMap.get(entry.milestoneInt)!;
    const legacyNum = entry.legacyPhaseNum;
    // Register integer forms (covers plain numeric and letter-suffix IDs)
    const intPart = parseInt(legacyNum, 10);
    const paddedLegacy = String(intPart).padStart(2, '0');
    const unpaddedLegacy = String(intPart);
    mMap.set(paddedLegacy, entry.newId);
    mMap.set(unpaddedLegacy, entry.newId);
    // Also register the original form and padded-integer+decimal form
    // so decimal IDs like "2.1" / "02.1" round-trip correctly.
    mMap.set(legacyNum, entry.newId);
    const dotIdx = legacyNum.indexOf('.');
    if (dotIdx !== -1) {
      const decimalSuffix = legacyNum.slice(dotIdx); // e.g. ".1"
      mMap.set(paddedLegacy + decimalSuffix, entry.newId);
      mMap.set(unpaddedLegacy + decimalSuffix, entry.newId);
    }
  }

  // ── Read existing phase directories ───────────────────────────────────────
  let existingDirs: string[] = [];
  try {
    existingDirs = fs.readdirSync(phasesDir).filter(d => {
      try {
        return fs.statSync(path.join(phasesDir, d)).isDirectory();
      } catch { return false; }
    });
  } catch { /* phases dir may not exist */ }

  // ── Build phase rename pairs ───────────────────────────────────────────────
  // Flat ordered list of (legacyPhaseNum, newId) in ROADMAP order, for dir matching.
  const orderedMappings = [...idMapping.values()].map(e => ({
    legacyPhaseNum: e.legacyPhaseNum,
    newId: e.newId,
    milestoneInt: e.milestoneInt,
    _used: false,
  }));

  // Note: if the same legacy phase number appears in multiple milestones (the exact legacy
  // ambiguity this tool is designed to resolve), directories are matched in ROADMAP document
  // order — the first ROADMAP occurrence of a given number claims the first matching disk dir.
  // This is the only unambiguous assignment strategy for flat dirs that carry no milestone
  // context. The dry-run output shows the complete rename plan so users can review before
  // applying with --apply.

  const phases: PhaseRename[] = [];
  for (const dirName of existingDirs) {
    const phaseNum = extractPhaseNumFromDir(dirName);
    if (!phaseNum) continue;

    const intPart = parseInt(phaseNum, 10);
    const paddedPhaseNum = String(intPart).padStart(2, '0');
    const unpaddedPhaseNum = String(intPart);
    // For decimal IDs like "02.1", also try "2.1"
    const dotIdx = phaseNum.indexOf('.');
    const decimalUnpadded = dotIdx !== -1 ? unpaddedPhaseNum + phaseNum.slice(dotIdx) : null;

    // Find the first unused mapping whose legacy number matches (exact, padded, unpadded, or decimal)
    const found = orderedMappings.find(m => !m._used && (
      m.legacyPhaseNum === phaseNum ||
      m.legacyPhaseNum === paddedPhaseNum ||
      m.legacyPhaseNum === unpaddedPhaseNum ||
      (decimalUnpadded && m.legacyPhaseNum === decimalUnpadded)
    ));
    if (!found) continue;
    found._used = true;

    const newDirName = buildNewDirName(dirName, found.newId, projectCode);
    if (newDirName !== dirName) {
      phases.push({
        oldId: phaseNum,
        newId: found.newId,
        oldDir: dirName,
        newDir: newDirName,
      });
    }
  }

  // ── Build ROADMAP.md line edits ────────────────────────────────────────────
  const roadmapEdits: RoadmapEdit[] = [];

  for (const entry of legacyPhases) {
    // Use lineIndex as the canonical key (not legacyPhaseNum, which may collide across milestones)
    const mapping = idMapping.get(entry.lineIndex);
    if (!mapping) continue;

    // Rewrite heading line: "### Phase N: Name" → "### Phase M-NN: Name"
    const oldLine = lines[entry.lineIndex];
    const newLine = oldLine.replace(
      new RegExp(`^(#{2,4}\\s*(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+)${PHASE_NUMBER_TOKEN_SOURCE}(\\s*:)`, 'i'),
      `$1${mapping.newId}$2`
    );
    if (newLine !== oldLine) {
      roadmapEdits.push({ lineIndex: entry.lineIndex, from: oldLine, to: newLine });
    }
  }

  // Rewrite checklist lines in ROADMAP.md — use milestone context to resolve collisions.
  let currentChecklistMilestone: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track enclosing milestone section for context-aware lookup
    const milestoneHeadingMatch = line.match(MILESTONE_HEADING_RE);
    if (milestoneHeadingMatch) {
      currentChecklistMilestone = parseInt(milestoneHeadingMatch[1], 10);
    }

    // Already in roadmapEdits? skip
    if (roadmapEdits.some(e => e.lineIndex === i)) continue;

    // Match checklist items: "- [ ] **Phase N:**" or "- [x] Phase N:"  (also decimal)
    const checklistMatch = line.match(
      new RegExp(`^(\\s*-\\s*\\[[ x]\\]\\s*\\*{0,2}Phase\\s+)(${PHASE_NUMBER_TOKEN_SOURCE})(\\s*[:\\s*])`, 'i')
    );
    if (checklistMatch) {
      const legacyNum = checklistMatch[2];
      const cIntPart = parseInt(legacyNum, 10);
      const paddedLegacy = String(cIntPart).padStart(2, '0');
      const unpaddedLegacy = String(cIntPart);
      const cDotIdx = legacyNum.indexOf('.');
      const paddedLegacyDecimal = cDotIdx !== -1 ? paddedLegacy + legacyNum.slice(cDotIdx) : null;

      // Prefer milestone-context lookup (avoids collision across milestones)
      let newId: string | undefined;
      if (currentChecklistMilestone !== null && milestoneIdMap.has(currentChecklistMilestone)) {
        const mMap = milestoneIdMap.get(currentChecklistMilestone)!;
        newId = mMap.get(legacyNum) || mMap.get(paddedLegacy) || mMap.get(unpaddedLegacy);
        if (!newId && paddedLegacyDecimal) newId = mMap.get(paddedLegacyDecimal);
      }
      if (!newId) {
        // Fallback: use ordered flat list (no milestone collision in this roadmap)
        const found = orderedMappings.find(m =>
          m.legacyPhaseNum === legacyNum ||
          m.legacyPhaseNum === paddedLegacy ||
          m.legacyPhaseNum === unpaddedLegacy ||
          (paddedLegacyDecimal && m.legacyPhaseNum === paddedLegacyDecimal)
        );
        if (found) newId = found.newId;
      }

      if (newId) {
        const newLine = line.replace(
          new RegExp(`^(\\s*-\\s*\\[[ x]\\]\\s*\\*{0,2}Phase\\s+)${PHASE_NUMBER_TOKEN_SOURCE}(\\s*[:\\s*])`, 'i'),
          `$1${newId}$2`
        );
        if (newLine !== line) {
          roadmapEdits.push({ lineIndex: i, from: line, to: newLine });
        }
      }
    }
  }

  // ── Build cross-ref edits for STATE.md and PROJECT.md ────────────────────
  const crossRefEdits: CrossRefEdit[] = [];
  const crossRefFiles = ['STATE.md', 'PROJECT.md'];

  for (const fileName of crossRefFiles) {
    const filePath = path.join(pDir, fileName);
    if (!fs.existsSync(filePath)) continue;

    const fileContent = fs.readFileSync(filePath, 'utf8');

    // Iterate using orderedMappings (ROADMAP order) — idMapping is now keyed by lineIndex.
    for (const m of orderedMappings) {
      const legacyNum = m.legacyPhaseNum;
      const xIntPart = parseInt(legacyNum, 10);
      const paddedNum = String(xIntPart).padStart(2, '0');
      const unpaddedNum = String(xIntPart);
      // Decimal suffix (e.g. ".1" from "2.1") — preserve in cross-ref patterns
      const xDotIdx = legacyNum.indexOf('.');
      const decimalSuffix = xDotIdx !== -1 ? legacyNum.slice(xDotIdx) : '';

      // Rewrite project_code-prefixed references: "GSD-01-" → "GSD-01-02-"
      if (projectCode) {
        const [milestoneStr, subStr] = m.newId.split('-');
        const paddedMilestone = String(parseInt(milestoneStr, 10)).padStart(2, '0');
        const prefixedNew = `${projectCode}-${paddedMilestone}-${subStr}-`;
        // Try both padded and original forms as old prefix
        for (const oldNum of new Set([paddedNum + decimalSuffix, unpaddedNum + decimalSuffix, paddedNum, unpaddedNum])) {
          const prefixedOld = `${projectCode}-${oldNum}-`;
          if (fileContent.includes(prefixedOld)) {
            crossRefEdits.push({ file: fileName, from: prefixedOld, to: prefixedNew });
          }
        }
      }

      // Rewrite prose references: "Phase 1:" → "Phase 1-01:", "Phase 2.1:" → "Phase 1-02:"
      const proseOldPatterns = new Set([
        `Phase ${unpaddedNum}${decimalSuffix}:`,
        `Phase ${paddedNum}${decimalSuffix}:`,
        `Phase ${legacyNum}:`,
      ]);
      for (const proseOld of proseOldPatterns) {
        if (fileContent.includes(proseOld)) {
          const proseNew = `Phase ${m.newId}:`;
          crossRefEdits.push({ file: fileName, from: proseOld, to: proseNew });
        }
      }
    }
  }

  return {
    alreadyMigrated: false,
    phases,
    roadmapEdits,
    crossRefEdits,
  };
}

// ─── applyMigration ───────────────────────────────────────────────────────────

/**
 * Apply the migration plan computed by computeMigrationPlan().
 *
 * @param cwd
 * @param plan
 * @param options
 * @param options.dryRun - Print plan and exit without mutating. (default true)
 */
function applyMigration(cwd: string, plan: MigrationPlan, options: { dryRun?: boolean } = {}): ApplyMigrationResult {
  const dryRun = options.dryRun !== false; // default true

  if (plan.alreadyMigrated) {
    return { alreadyMigrated: true };
  }

  if (dryRun) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return { dryRun: true };
  }

  // ── Real run: verify clean working tree ───────────────────────────────────
  let gitStatus: string;
  try {
    gitStatus = execSync('git status --porcelain', { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  } catch (err) {
    throw new Error(`git status failed: ${(err as Error).message}`);
  }
  if (gitStatus.trim().length > 0) {
    throw new Error('Working tree is dirty. Commit or stash changes before migrating.');
  }

  const pDir = planningDir(cwd);
  const phasesDir = path.join(pDir, 'phases');
  const roadmapPath = path.join(pDir, 'ROADMAP.md');
  const configPath = path.join(pDir, 'config.json');

  const renamedDirs: string[] = [];
  const editedFiles: string[] = [];

  // Surgical, git-independent rollback state (#1542). A `git reset --hard` +
  // `git clean` rollback restores NOTHING for a gitignored `.planning/`
  // (commit_docs:false — the default) and is a whole-repo operation besides.
  // Instead, record the exact renames performed and snapshot each file before
  // rewriting it, then undo precisely those on failure — correct whether
  // `.planning/` is git-tracked or ignored.
  const performedRenames: Array<{ oldPath: string; newPath: string }> = [];
  const fileBackups = new Map<string, { existed: boolean; content: string }>();
  const snapshotFile = (filePath: string): void => {
    if (fileBackups.has(filePath)) return;
    try {
      fileBackups.set(filePath, { existed: true, content: fs.readFileSync(filePath, 'utf8') });
    } catch {
      fileBackups.set(filePath, { existed: false, content: '' });
    }
  };

  try {
    // 1. Rename phase directories
    for (const phaseEntry of plan.phases) {
      const oldPath = path.join(phasesDir, phaseEntry.oldDir);
      const newPath = path.join(phasesDir, phaseEntry.newDir);
      if (fs.existsSync(oldPath)) {
        retryRenameSync(oldPath, newPath);
        performedRenames.push({ oldPath, newPath });
        renamedDirs.push(`${phaseEntry.oldDir} → ${phaseEntry.newDir}`);
      }
    }

    // 2. Rewrite ROADMAP.md phase headings
    if (plan.roadmapEdits.length > 0) {
      const roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
      const lines = roadmapContent.split('\n');

      // Sort edits by lineIndex to apply in order
      const sortedEdits = [...plan.roadmapEdits].sort((a, b) => a.lineIndex - b.lineIndex);
      for (const edit of sortedEdits) {
        if (lines[edit.lineIndex] === edit.from) {
          lines[edit.lineIndex] = edit.to;
        }
      }

      snapshotFile(roadmapPath);
      fs.writeFileSync(roadmapPath, lines.join('\n'), 'utf8');
      editedFiles.push('ROADMAP.md');
    }

    // 3. Rewrite cross-refs in STATE.md and PROJECT.md
    const crossRefsByFile = new Map<string, CrossRefEdit[]>();
    for (const edit of plan.crossRefEdits) {
      if (!crossRefsByFile.has(edit.file)) {
        crossRefsByFile.set(edit.file, []);
      }
      crossRefsByFile.get(edit.file)!.push(edit);
    }

    for (const [fileName, edits] of crossRefsByFile) {
      const filePath = path.join(pDir, fileName);
      if (!fs.existsSync(filePath)) continue;

      let content = fs.readFileSync(filePath, 'utf8');
      let changed = false;

      for (const edit of edits) {
        if (content.includes(edit.from)) {
          // Replace all occurrences
          content = content.split(edit.from).join(edit.to);
          changed = true;
        }
      }

      if (changed) {
        snapshotFile(filePath);
        fs.writeFileSync(filePath, content, 'utf8');
        editedFiles.push(fileName);
      }
    }

    // 4. Update config.json: set phase_id_convention to 'milestone-prefixed'
    let configData: Record<string, unknown> = {};
    try {
      configData = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch { /* config may not exist yet */ }

    configData['phase_id_convention'] = 'milestone-prefixed';
    snapshotFile(configPath);
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2) + '\n', 'utf8');
    editedFiles.push('config.json');

  } catch (err) {
    // Surgical rollback: reverse the renames (newest first) and restore every
    // file we snapshotted (deleting files that did not previously exist). This
    // actually restores `.planning/` regardless of git tracking — so the
    // "rolled back" claim is truthful — and never touches anything else.
    for (let i = performedRenames.length - 1; i >= 0; i--) {
      const { oldPath, newPath } = performedRenames[i];
      try {
        if (fs.existsSync(newPath)) retryRenameSync(newPath, oldPath);
      } catch { /* best-effort */ }
    }
    for (const [filePath, backup] of fileBackups) {
      try {
        if (backup.existed) fs.writeFileSync(filePath, backup.content, 'utf8');
        else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { /* best-effort */ }
    }
    throw new Error(`Migration failed and rolled back: ${(err as Error).message}`);
  }

  return { applied: true, renamedDirs, editedFiles };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export = {
  computeMigrationPlan,
  applyMigration,
};
