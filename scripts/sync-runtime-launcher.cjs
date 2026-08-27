'use strict';
/**
 * sync-runtime-launcher.cjs
 *
 * Idempotent transform: for every gsd-core/workflows/*.md (and subdirs)
 * AND every agents/*.md, rewrite all bash/sh/shell fenced blocks to:
 *   1. Strip ALL old resolver forms from every bash block (GSD_TOOLS=,
 *      GSD_SDK=, the if/elif/else/fi resolver, _GSD_SHIM_NAME=, and any
 *      previously-inserted gsd_run preamble).
 *   2. Replace $GSD_SDK tokens with gsd_run (idempotent).
 *   3. Insert the canonical preamble at the TOP of ONLY the FIRST bash block
 *      (document order) that contains a gsd_run call. All other bash blocks
 *      keep their gsd_run calls with NO preamble. (Define once per file,
 *      use across blocks — original footprint.)
 *
 * Run: node scripts/sync-runtime-launcher.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const { escapeRegex: escapeRegExp } = require('../gsd-core/bin/lib/pattern.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const SNIPPET_FILE = path.join(WORKFLOWS_DIR, '_runtime-launcher.snippet.sh');

// Read canonical preamble (full content of snippet file)
function loadPreamble() {
  const raw = fs.readFileSync(SNIPPET_FILE, 'utf8');
  const lines = raw.split('\n');
  // Strip trailing empty line (trailing newline produces an empty last element)
  const content = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  if (content.length < 1) {
    throw new Error(`_runtime-launcher.snippet.sh is empty`);
  }
  return content;
}

/**
 * Collect all .md files recursively.
 */
function collectFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Given the lines of a bash block (without fence markers), strip all resolver
 * boilerplate (old and new preamble forms) and replace $GSD_SDK tokens.
 * Does NOT insert preamble — that is done by the file-level transform.
 *
 * Returns the stripped lines array.
 */
function stripAndReplace(lines, preamble) {
  let result = lines.slice();

  // Step 1: Remove ALL resolver boilerplate lines (including existing preamble).
  result = removeResolverLines(result, preamble);

  // Step 2: Replace $GSD_SDK tokens with gsd_run
  result = result.map((line) => replaceGsdSdk(line));

  return result;
}

/**
 * Remove resolver boilerplate lines from a block.
 *
 * Patterns to remove:
 * A) Multi-line if block:
 *      GSD_TOOLS="...gsd-tools.cjs"   (or ...${_GSD_SHIM_NAME})
 *      if [ -f "$GSD_TOOLS" ]; then
 *        ...
 *      fi
 *
 * B) One-liner form:
 *      GSD_TOOLS=...; if [ -f "$GSD_TOOLS" ]; then GSD_SDK=...; elif ...; else ...; fi
 *
 * C) _GSD_SHIM_NAME= line
 *
 * D) Bare GSD_SDK= line
 *
 * E) The canonical preamble comment line (so we strip old inserted preambles too)
 *
 * F) The gsd_run() function definitions that are part of the preamble
 *    (so previously-inserted preambles are stripped and will be re-inserted
 *    exactly once at the right location)
 */
function removeResolverLines(lines, preamble) {
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // B) One-liner form: GSD_TOOLS=... ; if ... GSD_SDK=... fi
    if (
      /^GSD_TOOLS=.*gsd-tools\.cjs.*;\s*if\s+\[/.test(trimmed) ||
      /^GSD_TOOLS=.*\/\$\{_GSD_SHIM_NAME\}.*;\s*if\s+\[/.test(trimmed)
    ) {
      // Skip the whole one-liner, and any adjacent SDK comment above it
      const lastIdx = result.length - 1;
      if (lastIdx >= 0 && isSdkComment(result[lastIdx])) {
        result.pop();
      }
      i++;
      continue;
    }

    // C) _GSD_SHIM_NAME= line
    if (/^_GSD_SHIM_NAME=/.test(trimmed)) {
      // Check if there's a canonical preamble comment just before it
      const lastIdx = result.length - 1;
      if (lastIdx >= 0 && isCanonicalPreambleComment(result[lastIdx])) {
        result.pop();
      } else if (lastIdx >= 0 && isSdkComment(result[lastIdx])) {
        result.pop();
      }
      i++;
      continue;
    }

    // A) Multi-line form: starts with GSD_TOOLS=...gsd-tools.cjs or GSD_TOOLS=...${_GSD_SHIM_NAME}
    if (
      /^GSD_TOOLS=.*gsd-tools\.cjs"$/.test(trimmed) ||
      /^GSD_TOOLS=.*\/\$\{_GSD_SHIM_NAME\}"$/.test(trimmed)
    ) {
      // Check if there's a canonical preamble comment just before it (preamble already installed)
      // or an old SDK comment — either way, remove the whole block
      const lastIdx = result.length - 1;
      if (lastIdx >= 0 && (isCanonicalPreambleComment(result[lastIdx]) || isSdkComment(result[lastIdx]))) {
        result.pop();
      }

      // Consume the if block that follows (if it exists)
      const ahead = lines[i + 1] ? lines[i + 1].trim() : '';
      if (/^if\s+\[\s+-f\s+"\$GSD_TOOLS"\s*\]/.test(ahead)) {
        // Consume until matching `fi`
        i += 2; // skip GSD_TOOLS= and `if [...]`
        let depth = 1;
        while (i < lines.length && depth > 0) {
          const t = lines[i].trim();
          if (/^if\s+/.test(t)) depth++;
          if (/^fi(\s|$)/.test(t)) {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          i++;
        }
        // After fi, skip a blank line if present
        if (i < lines.length && lines[i].trim() === '') {
          i++;
        }
        continue;
      } else {
        // Just skip the GSD_TOOLS= line
        i++;
        continue;
      }
    }

    // D) Bare GSD_SDK= line (not inside an if block, defensive)
    if (/^GSD_SDK=/.test(trimmed) && !/gsd_run/.test(trimmed)) {
      i++;
      continue;
    }

    // E+F) Strip lines that are part of the canonical preamble (to remove previously-inserted preambles).
    // We match the canonical preamble comment, _GSD_SHIM_NAME (handled above at C),
    // and gsd_run() function definition lines.
    if (isCanonicalPreambleComment(trimmed.startsWith('#') ? line : '')) {
      // Start of a previously-inserted canonical preamble — skip preamble lines
      // by consuming lines that match the preamble array in order.
      // Check how many consecutive lines match the preamble.
      let matchLen = 0;
      for (let p = 0; p < preamble.length; p++) {
        if (lines[i + p] === preamble[p]) {
          matchLen++;
        } else {
          break;
        }
      }
      if (matchLen === preamble.length) {
        // Exact preamble match — skip all preamble lines
        i += matchLen;
        // Skip trailing blank line if present
        if (i < lines.length && lines[i].trim() === '') {
          i++;
        }
        continue;
      }
      // Partial match or just the comment — still remove the comment line
      i++;
      continue;
    }

    result.push(line);
    i++;
  }

  return result;
}

/**
 * Returns true if the line looks like an old SDK resolver comment (to be removed).
 * Must NOT match the new canonical preamble comment.
 */
function isSdkComment(line) {
  // The new canonical preamble comment starts with "# Runtime launcher:" — preserve it.
  if (isCanonicalPreambleComment(line)) return false;
  return /^\s*#\s*SDK resolution/.test(line) || /^\s*#.*prefer local.*gsd-tools/.test(line);
}

/**
 * Returns true if the line is the new canonical preamble comment.
 * This identifies the start of the new multi-line canonical preamble.
 */
function isCanonicalPreambleComment(line) {
  return /^\s*#\s*Runtime launcher:.*prefer local gsd-tools\.cjs.*installed gsd-tools on PATH/.test(line);
}

/**
 * Replace all $GSD_SDK tokens with gsd_run in a line.
 * Handles: $GSD_SDK, ${GSD_SDK} forms.
 */
function replaceGsdSdk(line) {
  return line.replace(/\$\{?GSD_SDK\}?(?=\s|$|;|"|'|\))/g, 'gsd_run');
}

/**
 * Ensure the canonical preamble appears at the top of the block.
 * Rules:
 * - Skip leading blank lines
 * - Check if preamble lines 0..N-1 already match at the scan position
 * - If not, insert preamble at the top (after leading blanks)
 * - Idempotent: if preamble already present, do nothing
 */
function insertPreamble(lines, preamble) {
  // Find insertion point: skip blanks only
  let scanIdx = 0;
  while (scanIdx < lines.length && lines[scanIdx].trim() === '') scanIdx++;

  // Check if preamble already present at scanIdx
  let alreadyPresent = preamble.length > 0;
  for (let p = 0; p < preamble.length; p++) {
    if (lines[scanIdx + p] !== preamble[p]) {
      alreadyPresent = false;
      break;
    }
  }

  if (alreadyPresent) return lines; // idempotent

  // Insert preamble at scanIdx (after leading blanks)
  const insertAt = scanIdx;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);

  return [...before, ...preamble, ...after];
}

/**
 * Transform a single markdown file's content.
 * Returns new content string, or null if no changes needed.
 *
 * Strategy:
 * 1. Parse all shell blocks, strip resolver boilerplate from each.
 * 2. Find the FIRST block (document order) that has a gsd_run call.
 * 3. Insert preamble into that block only.
 * 4. Reconstruct the file.
 *
 * Handles both column-0 fences (```bash) and indented fences (   ```bash).
 */
function transformFile(content, preamble) {
  const allLines = content.split('\n');

  // --- Pass 1: identify all shell blocks and their positions ---
  // Each entry: { openIdx, closeIdx, blockLines, isShell }
  // We'll reconstruct by replacing block lines in-place.

  const shellBlockRanges = []; // { openLineIdx, contentStart, contentEnd, closingLineIdx }
  let i = 0;

  while (i < allLines.length) {
    const line = allLines[i];
    const fenceOpen = line.match(/^(\s*)```(\w+)?\s*$/);
    if (!fenceOpen) { i++; continue; }

    const indent = fenceOpen[1];
    const lang = (fenceOpen[2] || '').toLowerCase();
    const isShellBlock = ['bash', 'sh', 'shell', 'zsh', ''].includes(lang);
    const closingPattern = new RegExp('^' + escapeRegExp(indent) + '```\\s*$');

    const openLineIdx = i;
    i++;
    const contentStart = i;

    while (i < allLines.length && !closingPattern.test(allLines[i])) {
      i++;
    }
    const contentEnd = i; // exclusive
    const closingLineIdx = i < allLines.length ? i : -1;
    if (i < allLines.length) i++;

    if (isShellBlock) {
      shellBlockRanges.push({ openLineIdx, contentStart, contentEnd, closingLineIdx });
    }
  }

  if (shellBlockRanges.length === 0) return null;

  // --- Pass 2: transform each block ---
  // Build a new lines array by splicing in transformed block contents.
  // Process ranges in reverse order so indices stay valid.

  const outputLines = allLines.slice();
  let changed = false;
  let firstGsdRunBlockIdx = -1; // index into shellBlockRanges of the first gsd_run block (after strip)

  // A file may place the preamble in a bootstrap-only block that defines
  // gsd_run without calling it (gsd-core/workflows/explore.md Step 1, which
  // documents exactly why). Stripping empties that block of gsd_run calls, so
  // a pure "first block that CALLS gsd_run" target silently relocates the
  // preamble forward and breaks define-before-use. Honour where it already is.
  const existingPreambleBlockIdx = shellBlockRanges.findIndex((range) =>
    allLines
      .slice(range.contentStart, range.contentEnd)
      .some((l) => /^\s*_GSD_SHIM_NAME=/.test(l)));

  // First: strip + replace in all blocks, find first gsd_run block
  const strippedBlocks = shellBlockRanges.map((range) => {
    const blockLines = outputLines.slice(range.contentStart, range.contentEnd);
    const stripped = stripAndReplace(blockLines, preamble);
    return stripped;
  });

  // Find the first block that has a gsd_run call (after stripping)
  for (let bi = 0; bi < strippedBlocks.length; bi++) {
    if (strippedBlocks[bi].some((l) => /\bgsd_run\b/.test(l))) {
      firstGsdRunBlockIdx = bi;
      break;
    }
  }

  // If the preamble already existed in a specific block before stripping,
  // keep it there (even if that block no longer calls gsd_run after
  // stripping). Otherwise fall back to the first gsd_run-calling block.
  const preambleTargetIdx = existingPreambleBlockIdx >= 0 ? existingPreambleBlockIdx : firstGsdRunBlockIdx;

  // Insert preamble into the target block only — UNLESS this file
  // delegates to the shared resolver reference (@-include). Delegating files keep
  // the stripped blocks (any inline preamble removed) but never get one inserted.
  const delegates = delegatesToResolverReference(content);
  const finalBlocks = strippedBlocks.map((stripped, bi) => {
    if (!delegates && bi === preambleTargetIdx) {
      return insertPreamble(stripped, preamble);
    }
    return stripped;
  });

  // --- Pass 3: splice back into output (reverse order to preserve indices) ---
  for (let bi = shellBlockRanges.length - 1; bi >= 0; bi--) {
    const range = shellBlockRanges[bi];
    const originalBlock = allLines.slice(range.contentStart, range.contentEnd);
    const newBlock = finalBlocks[bi];

    if (originalBlock.join('\n') !== newBlock.join('\n')) {
      changed = true;
    }

    // Replace contentStart..contentEnd with newBlock
    outputLines.splice(range.contentStart, range.contentEnd - range.contentStart, ...newBlock);
  }

  if (!changed) return null;

  return outputLines.join('\n');
}

/**
 * A file "delegates to the shared resolver" when it pulls the canonical gsd_run
 * preamble in from gsd-core/references/gsd-run-resolver.md via an @-include
 * instead of inlining the snippet (see onboard.md / issue #1990).
 *
 * These files must NOT carry an inline preamble: the resolver reference ships the
 * one canonical copy, and onboard-command.test.cjs asserts the inline form is
 * absent. transformFile still STRIPS any inline preamble from them (so a stray
 * copy is removed) but never re-inserts one — mirroring the exemption in
 * runtime-launcher-parity.test.cjs (subtest B / B2).
 */
function delegatesToResolverReference(content) {
  return content.includes('references/gsd-run-resolver.md');
}

// Main
function main() {
  const preamble = loadPreamble();

  let transformedCount = 0;
  let unchangedCount = 0;

  // Process workflow files
  const workflowFiles = collectFiles(WORKFLOWS_DIR);
  for (const f of workflowFiles) {
    const content = fs.readFileSync(f, 'utf8');
    const result = transformFile(content, preamble);
    if (result !== null) {
      fs.writeFileSync(f, result, 'utf8');
      transformedCount++;
      console.log(`transformed (workflow): ${path.relative(WORKFLOWS_DIR, f)}`);
    } else {
      unchangedCount++;
    }
  }

  // Process agent files
  const agentFiles = collectFiles(AGENTS_DIR);
  for (const f of agentFiles) {
    const content = fs.readFileSync(f, 'utf8');
    const result = transformFile(content, preamble);
    if (result !== null) {
      fs.writeFileSync(f, result, 'utf8');
      transformedCount++;
      console.log(`transformed (agent): ${path.relative(AGENTS_DIR, f)}`);
    } else {
      unchangedCount++;
    }
  }

  console.log(`\nDone. ${transformedCount} files transformed, ${unchangedCount} unchanged.`);
}

if (require.main === module) {
  main();
}

module.exports = { transformFile };
