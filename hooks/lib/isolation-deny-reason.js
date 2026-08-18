'use strict';
// hooks/lib/isolation-deny-reason.js — shared, frozen reason-code enum for
// the #3045 dispatch-isolation guards' block/deny decisions
// (hooks/gsd-agent-isolation-guard.js, hooks/gsd-cursor-subagent-start.js).
//
// CONTRIBUTING.md ("Prohibited: Raw Text Matching on Test Outputs") bans
// asserting on a hook's free-form, human-readable reason/user_message prose
// — that text is for the operator/model reading the denial and may change
// wording without notice. Every block/deny decision therefore ALSO carries
// one of these STABLE codes (surfaced on the hook's stdout JSON as
// `reason_code`), so tests assert `out.reason_code === REASON_CODE.X`
// instead of regexing the message (mirrors the REASON enum convention in
// gsd-core/bin/verify-reapply-patches.cjs).
//
// Adding a new code requires updating this enum AND any test that locks the
// documented set.
const REASON_CODE = Object.freeze({
  // The compiled runtime library (gsd-core/bin/lib/*.cjs) is missing and
  // could not be self-built (ensure-runtime-build.cjs's RuntimeBuildError).
  RUNTIME_BUILD_FAILED: 'runtime_build_failed',
  // The project's dispatch-isolation configuration ('.planning/config.json')
  // could not be read or resolved for a reason OTHER than a runtime-build
  // failure (unreadable/malformed config, unexpected resolver error).
  CONFIG_UNREADABLE: 'config_unreadable',
  // Isolation resolves to "harness-worktree" but the Agent()/Task() dispatch
  // is missing the harness's isolation flag/kwarg.
  HARNESS_FLAG_MISSING: 'harness_flag_missing',
  // Isolation resolves to "harness-worktree" but the dispatch payload carries
  // no usable subagent_type, so the guard cannot confirm it is a GSD executor.
  NO_SUBAGENT_TYPE: 'no_subagent_type',
  // Isolation resolves to "harness-worktree" but whether the workspace root
  // is an isolated worktree could not be determined (e.g. git unresponsive).
  CANNOT_DETERMINE_ISOLATION: 'cannot_determine_isolation',
  // Isolation resolves to "harness-worktree" and the workspace root is
  // confirmed NOT an isolated worktree.
  NOT_ISOLATED_WORKTREE: 'not_isolated_worktree',
});

module.exports = { REASON_CODE };
