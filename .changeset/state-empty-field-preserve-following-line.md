---
type: Fixed
pr: 4021
---
**Updating an empty STATE.md field no longer silently deletes the line beneath it.** When a body field such as `**Status:**` had no value after the colon, `gsd-tools state update` consumed the following line break and overwrote the entire next line — e.g. `**Current Plan:** 2 of 5` vanished with exit 0 and no warning. `stateReplaceField`'s bold and plain patterns now confine the label-to-value gap to same-line whitespace (`[ \t]*` instead of `\s*`), matching the read side, and write a single separating space when the label line had none. The following line is preserved byte-for-byte; non-empty and pipe-table replacements are unchanged. (#4010)
