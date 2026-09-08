'use strict';

/**
 * inventory-roster.cjs — the pure half of the `docs/INVENTORY.md` roster gate (#3762).
 *
 * `docs/INVENTORY-MANIFEST.json` is anchored against the filesystem by
 * `tests/inventory-manifest-sync.test.cjs`. This module supplies the second
 * comparison that test runs: every manifest entry must also have a hand-written row
 * in `docs/INVENTORY.md`, which calls itself "Authoritative roster of every shipped
 * GSD surface" (`docs/INVENTORY.md:3`) and promises "a new file without a matching
 * row here will fail CI" (`docs/INVENTORY.md:681`). Until #3762 neither claim was
 * true: PR #3758 shipped `gsd-core/references/planner-coupling.md` with a manifest
 * entry, no roster row, and fully green CI.
 *
 * Everything here is PURE — text and the manifest object in, findings out, no
 * filesystem access — so the matcher is drivable by fixture. A drift guard that can
 * only be exercised against a clean repo proves nothing about its own comparison.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────────
 *
 * IN: the SIX FLAT families — `agents`, `commands`, `workflows`, `references`,
 * `cli_modules`, `hooks`. `docs/INVENTORY.md:7` says the file "enumerates every
 * shipped surface across all six families", and each has its own `##` section.
 *
 * OUT: the four NESTED families — `workflow_steps`, `workflow_modes`, `workflow_detail`,
 * `workflow_templates`. `docs/INVENTORY.md` §"Workflow Sub-Files" is an explicit shipped
 * decision that these carry no hand-written per-file rows: "Adding a step, mode, detail,
 * or template file requires no hand-written row here … The per-file roster deliberately lives in
 * `docs/INVENTORY-MANIFEST.json` rather than being duplicated in this table — 60
 * rows that must be hand-maintained in lockstep with a generated artifact is the
 * drift this file exists to catch." Demanding rows there would override that
 * decision, not enforce the roster.
 *
 * ── WHAT COUNTS AS A ROW ───────────────────────────────────────────────────────
 *
 * Deliberately narrow, because this runs on every PR and must tolerate formatting it
 * has no business policing:
 *
 *   • Each family is searched ONLY inside its own `##` section. A cell in another
 *     family's section does not count — `smart-entry.md` (a workflow) and
 *     `smart-entry.cjs` (a CLI module) are different surfaces. A MISSING section is
 *     reported as one structural failure, never as one phantom row per entry.
 *   • Matching is on a whole table CELL equal to the manifest entry after stripping
 *     WRAPPING backticks — never a substring. The real roster's
 *     `host-integration-adapters/imperative-hook-bus.cjs` row must not satisfy the
 *     separate top-level `hook-bus.cjs` entry, which is genuinely unrostered.
 *   • Subsections (`###`), column count, column order, CRLF, and trailing HTML
 *     comments (`| … |<!-- gsd-allow-legacy-name -->`) are all irrelevant.
 *   • COMMANDS MATCH ON THEIR SOURCE LINK, not their rendered name. Six namespace
 *     routers deliberately render `/gsd-workflow` while sourcing
 *     `commands/gsd/ns-workflow.md`; the display value is not the file identity.
 *     `docs/INVENTORY.md:63` documents every command row as carrying "a link to the
 *     source file", so the link is both the documented shape and the only
 *     collision-free key.
 *
 * Restructuring `docs/INVENTORY.md`'s `##` headings, or dropping the command Source
 * column, is what ROSTER_SECTIONS below has to be updated for — in the same change.
 */

/**
 * Manifest family name → the level-2 heading in `docs/INVENTORY.md` that rosters it.
 * The four nested families are absent BY DESIGN (see above).
 */
const ROSTER_SECTIONS = Object.freeze({
  agents: 'Agents',
  commands: 'Commands',
  workflows: 'Workflows',
  references: 'References',
  cli_modules: 'CLI Modules',
  hooks: 'Hooks',
});

/** A manifest `commands` entry (`/gsd-ns-workflow`) → its source basename (`ns-workflow.md`). */
function commandSourceBasename(entry) {
  return entry.replace(/^\/gsd-/, '') + '.md';
}

/**
 * Split `text` into a Map of `heading → lines[]` keyed by level-2 (`##`) heading.
 * Level-3 headings stay INSIDE their parent section, so a family's rows are found
 * regardless of which `###` subsection a contributor files them under. Split on
 * `\r?\n`: a Windows checkout is a supported working tree, and a `\n`-only split
 * would leave a trailing `\r` on every cell and red the whole gate there.
 *
 * Fenced code blocks (``` or ~~~) are skipped wholesale — neither their headings
 * nor their pipe-delimited lines participate. `docs/INVENTORY.md` carries no fence
 * today, which is exactly why this is worth writing down: the day someone documents
 * a `## ` example inside one, an unfenced scanner would silently truncate a family
 * section and red the gate on a document that is perfectly correct.
 *
 * The heading pattern is deliberately `(.*)` + trim rather than a lazy `(.+?)` with
 * a trailing `[ \t]*$`: the lazy form backtracks quadratically on a heading line
 * padded with thousands of spaces, and this gate parses a file any contributor can
 * write.
 *
 * Both the heading and the fence marker allow CommonMark's LEADING INDENT of up to
 * three spaces. Anchoring hard at `^##` looks harmless and is not: an author who
 * indents a heading by one space writes a perfectly valid document that this gate
 * would read as having NO family sections at all, reporting all six as missing —
 * a structural red for zero real drift.
 */
function splitLevel2Sections(text) {
  const sections = new Map();
  let current = null;
  let fence = null;
  for (const line of String(text).split(/\r?\n/)) {
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMark) {
      if (fence === null) {
        fence = fenceMark[1][0];
        continue;
      }
      if (fenceMark[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const m = /^ {0,3}##[ \t]+(.*)$/.exec(line);
    if (m) {
      current = m[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current).push(line);
  }
  return sections;
}

/**
 * Peel the presentation off a whole table cell, one layer at a time, and return
 * every form encountered — the raw text and each unwrapped result.
 *
 * Two layers are recognized, and only when they wrap the cell ENTIRELY:
 *   • a code span:      `` `x.md` ``            → `x.md`
 *   • a markdown link:  `` [`x.md`](../x.md) `` → `` `x.md` `` → `x.md`
 *
 * ENTIRELY is the whole safety property. A role cell reading "superseded by
 * `ghost.md`" keeps its text intact, so a file merely MENTIONED in prose can never
 * masquerade as a row — which is the false PASS this gate exists to prevent, and is
 * strictly worse than the false red that motivated handling the link form. The link
 * text may not itself contain `]`, so a cell holding two links degrades to "no
 * unwrap" rather than to a garbled middle substring.
 */
function unwrapCellForms(cell) {
  const forms = [cell];
  let current = cell;
  // At most two peels: link → code span. Bounded, so no pathological input can
  // turn this into a loop.
  for (let i = 0; i < 2; i++) {
    const code = /^`(.+)`$/.exec(current);
    if (code) {
      current = code[1].trim();
      forms.push(current);
      continue;
    }
    const link = /^\[([^\]]+)\]\([^)]*\)$/.exec(current);
    if (link) {
      current = link[1].trim();
      forms.push(current);
      continue;
    }
    break;
  }
  return forms;
}

/**
 * Every whole table cell in `lines`, trimmed, plus the unwrapped forms of each (see
 * `unwrapCellForms`). Only cells are collected — a line that is not a table row
 * contributes nothing.
 */
function tableCells(lines) {
  const cells = new Set();
  for (const line of lines) {
    if (!line.trimStart().startsWith('|')) continue;
    for (const raw of line.split('|')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      for (const form of unwrapCellForms(trimmed)) cells.add(form);
    }
  }
  return cells;
}

/**
 * Basenames of every `commands/gsd/<file>.md` markdown-link target in `lines`,
 * regardless of how many `../` hops the relative path takes or whether it carries a
 * `#anchor` / `?query`.
 */
function commandSourceLinks(lines) {
  const basenames = new Set();
  for (const line of lines) {
    const linkRe = /\]\(([^)\s]+)/g;
    let m;
    while ((m = linkRe.exec(line)) !== null) {
      const target = m[1].split('#')[0].split('?')[0];
      const hit = /(?:^|\/)commands\/gsd\/([^/]+\.md)$/.exec(target);
      if (hit) basenames.add(hit[1]);
    }
  }
  return basenames;
}

/**
 * Compare `docs/INVENTORY.md`'s rows against the manifest's family arrays.
 *
 * @param {string} inventoryText contents of `docs/INVENTORY.md`
 * @param {object} families      the manifest's `families` object
 * @returns {{missingSections: string[], missingRows: string[]}}
 *   `missingRows` entries read `"<family>/<entry>"`, matching the phrasing the
 *   manifest half of the gate already uses for additions/removals.
 */
function findMissingRosterRows(inventoryText, families) {
  const sections = splitLevel2Sections(inventoryText);
  const missingSections = [];
  const missingRows = [];

  for (const [family, heading] of Object.entries(ROSTER_SECTIONS)) {
    const lines = sections.get(heading);
    if (lines === undefined) {
      missingSections.push(heading);
      continue;
    }
    const entries = (families || {})[family] || [];
    if (family === 'commands') {
      const links = commandSourceLinks(lines);
      for (const entry of entries) {
        if (!links.has(commandSourceBasename(entry))) missingRows.push(family + '/' + entry);
      }
      continue;
    }
    const cells = tableCells(lines);
    for (const entry of entries) {
      if (!cells.has(entry)) missingRows.push(family + '/' + entry);
    }
  }

  return { missingSections, missingRows };
}

/** Human-readable remediation for a non-empty `findMissingRosterRows` result. */
function formatRosterFailure({ missingSections, missingRows }) {
  return [
    missingSections.length
      ? 'docs/INVENTORY.md is missing a "## <heading>" section this gate rosters against:\n' +
        missingSections.map((h) => '  ## ' + h).join('\n') +
        '\nIf the section was deliberately renamed or merged, update ROSTER_SECTIONS in\n' +
        'tests/helpers/inventory-roster.cjs in the same change.'
      : '',
    missingRows.length
      ? 'Shipped surfaces in docs/INVENTORY-MANIFEST.json with NO row in docs/INVENTORY.md (#3762):\n' +
        missingRows.map((e) => '  ! ' + e).join('\n') +
        '\nAdd a row to the matching "## " section of docs/INVENTORY.md: the file name in a cell,\n' +
        'plus the one-line role that section\'s table asks for. For a command, the row\'s Source\n' +
        'column must link to ../commands/gsd/<file>.md — that link, not the rendered /gsd-name,\n' +
        'is what this gate reads. Regenerating the manifest does NOT satisfy this: the roster row\n' +
        'is hand-written by design, because a role sentence cannot be generated.'
      : '',
  ].filter(Boolean).join('\n\n');
}

// Only the three names the gate actually consumes are exported. The parsing
// helpers above stay module-private on purpose: exporting them would create a
// surface nothing calls, and every one of their behaviors is already pinned
// through `findMissingRosterRows` by the fixture rows in
// `tests/inventory-manifest-sync.test.cjs` — asserting them directly would test
// the implementation instead of the contract.
module.exports = {
  ROSTER_SECTIONS,
  findMissingRosterRows,
  formatRosterFailure,
};
