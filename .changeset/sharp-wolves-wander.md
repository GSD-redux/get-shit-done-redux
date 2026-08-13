---
type: Fixed
pr: 0
---
**`/gsd-sync-skills` now refuses cross-runtime skill sync** — skill content and directory layout are runtime-specific (the installer applies per-runtime converters/adapter headers/brand swaps/layout rules), and two runtimes alias another runtime's skills root, so a verbatim cross-runtime copy silently corrupted destination skills and could overwrite a runtime the user never named. sync now refuses any `--to` that differs from `--from` and points at the installer, keeping identity sync (`--from` == `--to`) as a no-op. (#3025)
