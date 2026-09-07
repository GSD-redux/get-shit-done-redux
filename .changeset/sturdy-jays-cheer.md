---
type: Fixed
pr: 4501
---
**`hooks.commit_types` and `hooks.community` are now settable via `config-set`** — both keys are consumed by shipped hooks (`hooks/gsd-validate-commit.sh`), and `hooks.commit_types` is documented in `docs/COMMANDS.md`, but neither was registered in `config-schema.manifest.json`'s `validKeys`, so `config-set` rejected them with "Unknown config key" — the only way to configure either was hand-editing `.planning/config.json`. (#4443)
