"use strict";
/**
 * Installer migration: retire Antigravity's configHome skills/agents surfaces (#3738).
 *
 * Antigravity's machine-local discovery scans ~/.gemini/config/{skills,agents}
 * (antigravity.google/docs/skills, /docs/subagents); the configHome
 * (~/.gemini/antigravity{,-ide,-cli}) is not scanned for global artifacts, so
 * skills installed there are silently ignored. Since #3738 the global layout
 * declares a `home: ".gemini/config"` override for both kinds, and new
 * installs land in the scanned dir. This migration converges an existing
 * installation: manifest-managed files under the configHome's skills/ and
 * agents/ subtrees are removed (modified ones backed up first), unmanifested
 * files are preserved, and now-empty container directories are retired.
 *
 * Scope is GLOBAL only: the local workspace layout (.agents/skills,
 * .agents/agents) is the documented, still-live surface and is never touched.
 *
 * Is the action safe in non-interactive install?
 *   Yes. Every emitted action type (`remove-managed`, `backup-and-remove`,
 *   `remove-empty-dir`) is non-interactive and journaled; none requires a
 *   user choice, and unknown files never produce an action.
 *
 * See docs/installer-migrations.md#shipped-migrations and the antigravity row
 * of docs/installer-migrations.md#runtime-configuration-contract-registry.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/** The two retired configHome-relative artifact subpaths. */
const RETIRED_SUBPATHS = ['skills', 'agents'];
/** Only GSD-owned top-level entries are retirement candidates. */
const GSD_PREFIX = 'gsd-';
const FILE_REASON = 'Antigravity scans ~/.gemini/config/{skills,agents} for global discovery and does not scan the ' +
    'configHome, so these artifacts are invisible to the runtime (#3738); the same artifacts reinstall ' +
    "under the global layout's .gemini/config home override";
const FILE_OWNERSHIP_EVIDENCE = 'pre-#3738 antigravity installs record skills/gsd-*/** and agents/gsd-*.md keys in ' +
    'gsd-file-manifest.json at the configHome root; the migration only walks gsd--prefixed entries ' +
    'under the two retired subpaths';
const DIR_REASON = 'the retired container directory is removed only once every GSD-owned entry inside it is gone; a ' +
    'directory that still holds an unmanifested user file — or any file-level action that failed to ' +
    'apply — is left in place by the emptiness re-check';
const DIR_OWNERSHIP_EVIDENCE = 'skills/ and agents/ at the antigravity configHome root are GSD-installed container directories ' +
    'from the pre-#3738 layout; removal is gated on emptiness by the shared remove-empty-dir action';
/**
 * Recursively collect files and directories under `root/relDir`, never
 * following a symlink (whether it names a file or a directory) and never
 * emitting a path that resolves outside `baseResolved`. Mirrors the traversal
 * guard in migration 009 (`walkPiHooksTree`).
 */
function walkTree(root, relDir, baseResolved, files, dirs) {
    const dir = node_path_1.default.join(root, relDir);
    const entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        // Never follow a symlink into or through: it must not be traversed,
        // hashed, or removed, regardless of what it points at.
        if (entry.isSymbolicLink())
            continue;
        const relPath = node_path_1.default.posix.join(relDir, entry.name);
        const resolved = node_path_1.default.resolve(root, relPath);
        if (resolved !== baseResolved && !resolved.startsWith(baseResolved + node_path_1.default.sep))
            continue;
        if (entry.isDirectory()) {
            dirs.push(relPath);
            walkTree(root, relPath, baseResolved, files, dirs);
        }
        else if (entry.isFile()) {
            files.push(relPath);
        }
    }
}
const migration = {
    id: '2026-08-26-antigravity-retire-confighome-artifacts',
    title: "Retire Antigravity's configHome skills/agents surfaces",
    description: 'Remove manifest-managed skills/gsd-*/ and agents/gsd-*.md under the Antigravity configHome ' +
        '(~/.gemini/antigravity{,-ide,-cli}) — a location Antigravity does not scan for global discovery — ' +
        'and retire the now-empty container directories, now that the global layout installs both kinds ' +
        'under the ~/.gemini/config home override (#3738). Global scope only; the local .agents workspace ' +
        'surface is untouched.',
    introducedIn: '1.11.0',
    runtimes: ['antigravity'],
    scopes: ['global'],
    destructive: true,
    plan: (ctx) => {
        // Defense in depth ahead of the framework's own runtimes/scope filters:
        // a claude/kimi/etc. skills/ or agents/ directory is a live install
        // surface, never a retirement target, and so is antigravity's LOCAL
        // .agents/skills layout.
        if (ctx.runtime !== 'antigravity')
            return [];
        if (ctx.scope !== 'global')
            return [];
        const actions = [];
        for (const subpath of RETIRED_SUBPATHS) {
            const surfaceRoot = node_path_1.default.join(ctx.configDir, subpath);
            let rootLstat;
            try {
                rootLstat = node_fs_1.default.lstatSync(surfaceRoot);
            }
            catch {
                continue; // absent -> nothing to retire for this surface, idempotent
            }
            // Never follow a symlinked surface root: walking through it could plan
            // actions against paths outside the config directory entirely.
            if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory())
                continue;
            const baseResolved = node_path_1.default.resolve(ctx.configDir);
            const files = [];
            const dirs = [];
            try {
                const entries = node_fs_1.default.readdirSync(surfaceRoot, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isSymbolicLink() || !entry.name.startsWith(GSD_PREFIX))
                        continue;
                    const relPath = node_path_1.default.posix.join(subpath, entry.name);
                    if (entry.isDirectory()) {
                        dirs.push(relPath);
                        walkTree(ctx.configDir, relPath, baseResolved, files, dirs);
                    }
                    else if (entry.isFile()) {
                        files.push(relPath);
                    }
                }
            }
            catch {
                // Unreadable directory: nothing safe to plan for this surface.
                continue;
            }
            for (const relPath of files) {
                const { classification } = ctx.classifyArtifact(relPath);
                if (classification === 'managed-pristine') {
                    actions.push({ type: 'remove-managed', relPath, reason: FILE_REASON, ownershipEvidence: FILE_OWNERSHIP_EVIDENCE });
                }
                else if (classification === 'managed-modified') {
                    actions.push({ type: 'backup-and-remove', relPath, reason: FILE_REASON, ownershipEvidence: FILE_OWNERSHIP_EVIDENCE });
                }
                // 'unknown' (user-added, not manifest-recorded): no action, preserved.
                // 'missing' / 'managed-missing': impossible here — relPath was just
                // discovered by walking the live filesystem, so it currently exists.
            }
            // Deepest directories first, so a child has already been evaluated
            // (and possibly removed) before its parent's own emptiness is
            // re-checked by the executor. The surface root itself is appended
            // last, unconditionally: the executor's own emptiness re-check is what
            // actually decides whether it goes, not this ordering.
            const orderedDirs = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
            orderedDirs.push(subpath);
            for (const relPath of orderedDirs) {
                actions.push({
                    type: 'remove-empty-dir',
                    relPath,
                    reason: DIR_REASON,
                    ownershipEvidence: DIR_OWNERSHIP_EVIDENCE,
                    // Declared, not derived: classifyArtifact() hashes file contents
                    // via sha256File(), which throws EISDIR against a directory path.
                    // These relPaths name directories, so classification is stated
                    // directly (never 'unknown', so the planner's
                    // unknown-classification block never fires for them).
                    classification: 'managed-pristine',
                    originalHash: null,
                    currentHash: null,
                });
            }
        }
        return actions;
    },
};
module.exports = migration;
