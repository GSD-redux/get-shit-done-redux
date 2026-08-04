/**
 * Conservative cleanup for artifact surfaces retired by a runtime descriptor.
 *
 * A descriptor may stop materializing an artifact kind while old installs
 * still contain files from that surface. Install and profile/surface apply
 * both call this helper so either path converges an existing installation.
 * Only files proven managed by the previous install manifest are removed;
 * modified and unknown files are preserved for the journaled installer
 * migration (or the user) to handle without data loss.
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import installerMigrations = require('./installer-migrations.cjs');
import { isPathConfined } from './external-descriptor-trust.cjs';

interface RetiredArtifactDescriptor {
  destSubpath?: unknown;
  prefix?: unknown;
  suffix?: unknown;
}

interface CleanupResult {
  removed: string[];
  preserved: string[];
}

interface RegistryShape {
  runtimes?: Record<string, {
    runtime?: {
      hostBehaviors?: {
        retiredArtifacts?: RetiredArtifactDescriptor[];
      };
    };
  }>;
}

// Generated at build time, so no TypeScript source declaration exists.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const capabilityRegistry = require('./capability-registry.cjs') as unknown as RegistryShape;

function retiredArtifactsFor(runtime: string): RetiredArtifactDescriptor[] {
  const configured = capabilityRegistry.runtimes?.[runtime]?.runtime?.hostBehaviors?.retiredArtifacts;
  return Array.isArray(configured) ? configured : [];
}

function pruneRetiredRuntimeArtifacts(runtime: string, configDir: string): CleanupResult {
  const result: CleanupResult = { removed: [], preserved: [] };
  const declarations = retiredArtifactsFor(runtime);
  if (declarations.length === 0) return result;

  const manifest = installerMigrations.readInstallManifest(configDir);
  for (const declaration of declarations) {
    const destSubpath = declaration.destSubpath;
    const prefix = declaration.prefix;
    const suffix = declaration.suffix;
    if (
      typeof destSubpath !== 'string' || destSubpath.length === 0 ||
      typeof prefix !== 'string' || prefix.length === 0 ||
      typeof suffix !== 'string' || suffix.length === 0 ||
      !isPathConfined(destSubpath, configDir)
    ) {
      continue;
    }

    const destDir = path.resolve(configDir, destSubpath);
    let entries: fs.Dirent[];
    try {
      if (!fs.existsSync(destDir) || fs.lstatSync(destDir).isSymbolicLink()) continue;
      entries = fs.readdirSync(destDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
      const relPath = path.posix.join(destSubpath.replace(/\\/g, '/'), entry.name);
      const artifact = installerMigrations.classifyArtifact(configDir, relPath, manifest);
      if (artifact.classification !== 'managed-pristine') {
        result.preserved.push(relPath);
        continue;
      }
      try {
        fs.unlinkSync(path.join(destDir, entry.name));
        result.removed.push(relPath);
      } catch {
        result.preserved.push(relPath);
      }
    }

    try {
      if (fs.readdirSync(destDir).length === 0) fs.rmdirSync(destDir);
    } catch {
      // Non-empty, unreadable, or concurrently changed: preserve the directory.
    }
  }
  return result;
}

export = { pruneRetiredRuntimeArtifacts, retiredArtifactsFor };
