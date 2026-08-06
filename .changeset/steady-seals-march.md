---
type: Fixed
pr: 3121
---
**Documentation now consistently warns about `--dangerously-skip-permissions`** — the flag was presented without a caveat in the user guide, the onboarding tutorial, and all four translated locales (ja-JP, zh-CN, ko-KR, pt-BR), while the English first-project tutorial carried a proper caution. All occurrences now carry the same `[!CAUTION]` block. (#3043)
