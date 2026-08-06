---
type: Fixed
pr: 3092
---
**`roadmap validate` now performs real structural validation** — it previously returned `{"warnings":[]}` (exit 0) for every input including empty files, garbage text, and missing files, providing false assurance. It now checks file existence/readability, emptiness, frontmatter well-formedness, and the presence of at least one phase entry, exiting non-zero on any warning (per its documented contract). The existing opt-in milestone-prefix consistency check is preserved. (#2978)
