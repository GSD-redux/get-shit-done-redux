'use strict';

/**
 * injection-patterns.js — the shared prompt-injection pattern list (#3504, epic #1900).
 *
 * Single source of truth for the standard injection signatures used by BOTH
 * gsd-prompt-guard.js (PreToolUse scan of writes into .planning/) and
 * gsd-read-injection-scanner.js (PostToolUse scan of Read/WebFetch/WebSearch
 * content). Previously each hook carried a byte-identical copy ("inlined for
 * hook independence") that could silently drift — a pattern tightened in one
 * would stop protecting the other surface.
 *
 * Why a shared lib require is safe here (the old inlining rationale, retired):
 * the installer stages hooks/lib/ from the GSD_HOOK_LIB_FILES allowlist for the
 * shared-bundle surfaces (Claude-family settings.json runtimes and Kimi), the
 * Cursor stager auto-discovers require('./lib/...') in staged scripts and fails
 * the install loudly when a helper is missing (#2587), and the plugin path
 * ships this directory wholesale.
 *
 * Deliberately NOT unified with src/security.cts's scanForInjection set: that
 * set runs inside the compiled lib tree; hooks must stay loadable standalone
 * without it. The two lists are different surfaces by design, not drift.
 *
 * Keep this file free of literal 'gsd:' text — the stager rewrites that marker
 * in staged hook content.
 */

const INJECTION_PATTERNS = Object.freeze([
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /override\s+(system|previous)\s+(prompt|instructions)/i,
  /you\s+are\s+now\s+(?:a|an|the)\s+/i,
  /act\s+as\s+(?:a|an|the)\s+(?!plan|phase|wave)/i,
  /pretend\s+(?:you(?:'re| are)\s+|to\s+be\s+)/i,
  /from\s+now\s+on,?\s+you\s+(?:are|will|should|must)/i,
  /(?:print|output|reveal|show|display|repeat)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i,
  /<\/?(?:system|assistant|human)>/i,
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<<\s*SYS\s*>>/i,
]);

module.exports = { INJECTION_PATTERNS };
