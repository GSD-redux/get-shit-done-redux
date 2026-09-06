/**
 * #4145: hash-first recovery for gsd-pristine/ baselines stored at an
 * unexpected path.
 *
 * Some installs hold a pristine snapshot whose SHA-256 equals the hash recorded
 * in backup-meta.json.pristine_hashes for a manifest-keyed file, but at a path
 * that is not `path.join(pristineDir, relPath)` — e.g. stored without the
 * `gsd-core/` top-level segment by an earlier release's writer. Both readers
 * (verify-reapply-patches.cjs verifyFile and install.js saveLocalPatches)
 * resolved strictly by that join, missed the snapshot, and reported
 * ok_no_baseline / fell into regeneration that can never satisfy the recorded
 * outgoing hash — a self-perpetuating gap.
 *
 * Hash equality with the recorded pristine_hashes entry is the same authority
 * the #3657 drift guard already trusts, so a match cannot be the wrong
 * baseline regardless of which release wrote it or where under gsd-pristine/
 * it lives. This module owns the shared scan so the two readers cannot drift
 * apart again (two private strict joins drifting is exactly the bug class).
 *
 * ADR-457: runtime module in src/*.cts, compiled to
 * gsd-core/bin/lib/pristine-baseline.cjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * SHA-256 hex digest of a file's raw bytes. Byte-for-byte the same digest
 * install.js fileHash() records into manifests and backup-meta.json.
 */
export function sha256File(absPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function walkSorted(dir: string, relPrefix: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // absent or unreadable — nothing to scan here
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    // Never follow symlinks: gsd-pristine/ is installer-authored plain files;
    // a link here is not a baseline and must not redirect the walk out of the
    // tree (same posture as migration 004's walker).
    if (entry.isSymbolicLink()) continue;
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkSorted(path.join(dir, entry.name), rel, results);
    } else if (entry.isFile()) {
      results.push(rel);
    }
  }
}

/**
 * Find the first file under `pristineDir` (deterministic sorted walk) whose
 * SHA-256 equals `recordedHash`, as a pristineDir-relative POSIX path.
 *
 * - `skipRel` (POSIX, forward slashes) is never returned — callers pass the
 *   canonical `relPath` they already consulted, so a mismatching canonical
 *   file can never be re-adopted through the scan.
 * - Multiple matches are byte-identical by sha-256 authority; sorted order
 *   makes the choice deterministic.
 * - Returns null when pristineDir is absent/unreadable or nothing matches.
 */
export function findPristineByHash(
  pristineDir: string,
  recordedHash: string,
  skipRel?: string,
): string | null {
  if (!pristineDir || typeof recordedHash !== 'string' || recordedHash.length === 0) {
    return null;
  }
  const rels: string[] = [];
  walkSorted(pristineDir, '', rels);
  for (const rel of rels) {
    if (skipRel !== undefined && rel === skipRel) continue;
    try {
      if (sha256File(path.join(pristineDir, rel)) === recordedHash) {
        return rel;
      }
    } catch {
      // unreadable candidate — keep scanning
    }
  }
  return null;
}
