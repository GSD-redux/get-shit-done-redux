/**
 * UI Safety Gate — shell-free implementation (ADR-457 build-at-publish: the
 * hand-written bin/lib/ui-safety-gate.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * Replaces the bash shell-based one-liner that silently degraded on Windows
 * PowerShell / cmd.exe because the locale env-var prefix was not recognised.
 * This module runs inside Node.js — no shell dependency, works identically
 * on bash, Git-Bash, PowerShell, and cmd.exe.
 *
 * Word-boundary anchoring:
 *   (^|[^a-zA-Z0-9])(TOKEN)([^a-zA-Z0-9]|$)
 * Equivalent to POSIX ERE [^[:alnum:]] — matches tokens only when they are not
 * interior substrings of alphanumeric compound words (e.g. "microfrontend" is NOT
 * matched; "micro-frontend" and "micro frontend" ARE matched).
 *
 * Public API:
 *   checkUiPresence(text: string): { hasUI: boolean, tokens: string[],
 *                                    matchedToken: string|null, matchedLine: string|null }
 *
 * CLI usage — reads phase-section text from STDIN to avoid ARG_MAX limits:
 *   echo "$PHASE_SECTION" | node gsd-core/bin/lib/ui-safety-gate.cjs
 *   echo $?   → 0 if UI tokens found, 1 if not, 2 on usage error
 *
 * Exit codes mirror grep: 0 = match found, 1 = no match, 2 = usage error.
 *
 * Canonical location: gsd-core/bin/lib/ui-safety-gate.cjs (#448)
 * This path is deployed by the GSD installer to $RUNTIME_DIR/gsd-core/bin/lib/.
 * bin/lib/ui-safety-gate.cjs (root) is retained for source-repo and npm usage.
 */

export interface UiPresenceResult {
  hasUI: boolean;
  tokens: string[];
  /**
   * #3312: first token matched (lowercased) and the line it matched on, so gate
   * consumers can surface WHAT tripped the sniffer without re-reading the source.
   * Null when nothing matched (or when `**UI hint**: yes` short-circuits with no
   * token match — the declaration, not vocabulary, is then the signal).
   */
  matchedToken: string | null;
  matchedLine: string | null;
}

export const UI_TOKENS: ReadonlyArray<string> = [
  'UI',
  'interface',
  'frontend',
  'component',
  'layout',
  'page',
  'screen',
  'view',
  'form',
  'dashboard',
  'widget',
];

/**
 * Built once at module load — no per-call compilation overhead.
 * ASCII word boundaries — matches the original ASCII-grep intent of #3706.
 * Note: JS [a-zA-Z0-9] is ASCII-only and NOT equivalent to POSIX [[:alnum:]],
 * which is locale-sensitive and includes accented characters.
 */
const UI_GATE_PATTERN = new RegExp(
  '(^|[^a-zA-Z0-9])(' + UI_TOKENS.join('|') + ')([^a-zA-Z0-9]|$)',
  'i',
);

// Global-flagged variant for extracting ALL matches per line (matchAll).
const UI_GATE_PATTERN_GLOBAL = new RegExp(UI_GATE_PATTERN.source, 'gi');

/**
 * Check a roadmap phase section string for frontend UI indicators.
 *
 * @param text - The roadmap phase section content (may be multi-line, CRLF or LF).
 * @returns hasUI — true if any UI token was matched as a standalone word;
 *          tokens — matched token strings (lowercased), deduplicated.
 */
export function checkUiPresence(text: string): UiPresenceResult {
  if (typeof text !== 'string') {
    return { hasUI: false, tokens: [], matchedToken: null, matchedLine: null };
  }

  // Normalise CRLF so the pattern sees consistent line boundaries.
  const normalised = text.replace(/\r\n/g, '\n');

  // #2150: an explicit `**UI hint**: yes|no` metadata line is the author's
  // authoritative declaration of whether the phase has a UI surface — progress.md
  // and new-project.md already parse this line (`UI hint.*yes`). The bare token
  // `UI` in the line itself must not count as a UI indicator, and the declaration
  // overrides token-sniffing. Line-anchored (`m`) so a mid-line prose mention is
  // not treated as the metadata line; word-boundary on the value so `nope`/`not`
  // do not match `no`.
  const hintMatch = normalised.match(/^\s*\*\*UI hint\*\*\s*:\s*(yes|no)\b/im);
  const hint = hintMatch ? hintMatch[1].toLowerCase() : null;

  // Strip ANY `**UI hint**:` line before token-sniffing so a hint without a
  // recognised yes/no (or one we did not short-circuit on) cannot false-positive
  // on the bare `UI` token.
  const sniffable = normalised
    .split('\n')
    .filter((line) => !/^\s*\*\*UI hint\*\*\s*:/i.test(line))
    .join('\n');

  const found = new Set<string>();
  let matchedToken: string | null = null;
  let matchedLine: string | null = null;
  for (const line of sniffable.split('\n')) {
    // Reset lastIndex before each line so the global pattern restarts from 0.
    UI_GATE_PATTERN_GLOBAL.lastIndex = 0;
    for (const m of line.matchAll(UI_GATE_PATTERN_GLOBAL)) {
      if (matchedToken === null) {
        // #3312: record the FIRST match so gate consumers can surface the
        // triggering token/line for one-second operator triage.
        matchedToken = m[2].toLowerCase();
        matchedLine = line;
      }
      found.add(m[2].toLowerCase());
    }
  }

  if (hint === 'no') {
    return { hasUI: false, tokens: [], matchedToken: null, matchedLine: null };
  }
  if (hint === 'yes') {
    return { hasUI: true, tokens: [...found], matchedToken, matchedLine };
  }

  return { hasUI: found.size > 0, tokens: [...found], matchedToken, matchedLine };
}

// ── CLI entry point ─────────────────────────────────────────────────────────
// Reads phase-section text from STDIN (not argv) to avoid OS ARG_MAX limits.
// Invoked by workflow .md bash blocks as: echo "$PHASE_SECTION" | node .../ui-safety-gate.cjs
// Exit 0 = UI found, 1 = no UI, 2 = startup error.

if (require.main === module) {
  // Collect stdin chunks asynchronously.
  const chunks: string[] = [];
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', (chunk: string) => chunks.push(chunk));

  process.stdin.on('end', () => {
    const input = chunks.join('');
    const result = checkUiPresence(input);
    process.exit(result.hasUI ? 0 : 1);
  });

  process.stdin.on('error', (err: Error) => {
    process.stderr.write(`ERROR: ui-safety-gate.cjs stdin read failed: ${err.message}\n`);
    process.exit(2);
  });
}
