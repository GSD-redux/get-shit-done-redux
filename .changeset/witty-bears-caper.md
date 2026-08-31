---
type: Fixed
pr: 4102
---
**Plan-coverage manifest miscounted multi-plan reviews under zsh** — the count and bullet list were derived by re-splitting an unquoted string, which bash word-splits by default but zsh does not, so reviews with 2+ plans collapsed onto one manifest entry. (#4099)
