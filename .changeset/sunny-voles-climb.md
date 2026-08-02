---
type: Fixed
pr: 2967
---
**Slug no longer ends with a trailing hyphen when truncated** — long titles whose 60-character cut landed on a word separator produced a slug ending in `-`, which then leaked into phase directory and branch names. The trailing-hyphen strip now runs after truncation. (#2849)
