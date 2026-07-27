---
type: Fixed
pr: 2712
---
**A truncated or half-written frontmatter file is no longer silently read as "no metadata"** — a document whose `---` fence was opened and never closed used to return exactly the same empty result as a file that legitimately has no frontmatter, so a crash mid-write left every phase/state reader proceeding with empty contracts and no signal. GSD now names the offending file on stderr while returning the same value as before, so nothing that consumed the old result changes. A Markdown horizontal rule at the top of a document — including one above a labelled line such as `Note:` or `Author:` — is not mistaken for a truncated fence. (#1882)
