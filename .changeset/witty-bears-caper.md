---
type: Fixed
pr: 0
---
**Plan-coverage manifest now counts and lists plan ids correctly under zsh.** Reviews with 2+ plans were undercounting the manifest's plan total and merging all ids onto one bullet line under zsh (macOS's default shell), because the count and list were derived from re-splitting an unquoted string — bash word-splits that by default, zsh does not. (#4099)
