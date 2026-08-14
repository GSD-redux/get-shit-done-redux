---
type: Fixed
pr: 0
---
**A file belonging to another phase no longer blocks the phase you are in** — six scans collected verification and UAT artifacts from a phase directory without checking they belonged to that phase, so a stray or copied file such as `04-VERIFICATION.md` sitting in phase 03's directory contributed its status to phase 03. The worst case was not cosmetic: a stray file carrying `gaps_found` or `human_needed` pushed a blocker that flipped the UAT-passed predicate to false, and `transition` gates on that — so a leftover file could refuse to let a phase advance. Two scans could also claim the opposite, reporting verification passed on the strength of a file the phase does not own. All six now check phase membership, and fall back to including everything if the phase cannot be determined, so a scan can never become silently permissive. (#3511)
