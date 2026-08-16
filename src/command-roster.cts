'use strict';

/**
 * Command Roster Module
 *
 * Read-only helper for discovering canonical commands/gsd command stems and
 * applying the shared GSD slash-command namespace transform.
 */

import path from 'node:path';
// #2874 (ADR-58 cleanup phase): readGsdCommandNames is reached from
// installRuntimeArtifacts's call tree (skillsKind's stage() closure reads it
// for cross-referencing), so its own directory read is routed through the
// injectable seam — see install-fs-adapter.cts's module doc. `readCmdNames`
// in scripts/fix-slash-commands.cjs uses real `node:fs` directly (that
// script lives outside src/ and is also a standalone CLI tool), so its
// directory-read logic is reimplemented here against the adapter instead of
// delegated to, keeping the pure regex/transform helpers below delegated as
// before.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installFsAdapter = require('./install-fs-adapter.cjs');
const { installFs } = installFsAdapter;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const slashCommandTransformer = require('../../../scripts/fix-slash-commands.cjs') as {
  readCmdNames: () => string[];
  transformContentToHyphen: (src: string, cmdNames: string[]) => string;
  transformContent: (src: string, cmdNames: string[]) => string;
  buildPattern: (cmdNames: string[]) => RegExp | null;
  buildColonPattern: (cmdNames: string[]) => RegExp | null;
};

// Mirrors scripts/fix-slash-commands.cjs's own `COMMANDS_DIR` computation
// (`path.join(__dirname, '..', 'commands', 'gsd')` from repo-root/scripts) —
// same target directory, resolved from this module's own compiled location
// (repo-root/gsd-core/bin/lib) instead, so the walk-up depth differs.
const COMMANDS_DIR = path.join(__dirname, '..', '..', '..', 'commands', 'gsd');

function readGsdCommandNames(): string[] {
  try {
    return installFs().readdirSync(COMMANDS_DIR)
      .filter((f: string) => f.endsWith('.md'))
      .map((f: string) => f.replace(/\.md$/, ''));
  } catch (err) {
    // Only swallow the missing-directory case — mirrors readCmdNames' own
    // contract (scripts/fix-slash-commands.cjs).
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [];
  }
}

export = {
  readGsdCommandNames,
  transformContentToHyphen: slashCommandTransformer.transformContentToHyphen,
  transformContent: slashCommandTransformer.transformContent,
  buildPattern: slashCommandTransformer.buildPattern,
  buildColonPattern: slashCommandTransformer.buildColonPattern,
};
