---
type: Security
pr: 3506
---
**Path validation no longer accepts a symbolic link whose target is missing** — `validatePath` canonicalizes a path with `realpath`, and for a path that does not exist yet it fell back to canonicalizing the parent directory instead. A symlink inside the project pointing at a **non-existent** location outside it took that fallback and was accepted, while a symlink pointing at an **existing** outside location was correctly refused — a difference an attacker could use to test whether arbitrary absolute paths exist. Such a link is now refused outright. The same fallback also compared an uncanonicalized path against a canonicalized base when several leading directories were missing, wrongly refusing legitimate not-yet-created paths on any non-canonical working directory (every macOS temp directory, for one); it now canonicalizes from the nearest existing ancestor. (#3493)
