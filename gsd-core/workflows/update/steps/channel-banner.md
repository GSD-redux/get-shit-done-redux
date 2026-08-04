**Only when `TAG=next`** (the user passed `--next`/`--rc`), prepend a channel banner so they know they are leaving the stable line — add this line immediately after the `**Latest:**` line in whichever output block renders:

**Channel:** {CHANNEL_LABEL}

On the default stable channel (`TAG=latest`), do NOT add a channel line — the output must match the prior stable behavior exactly.

When `TAG=next`, the "latest" value is the release candidate published under `@next` (e.g. `1.4.0-rc.1`). Apply standard semver precedence for prereleases (`1.4.0-rc.1` is newer than `1.3.1` but older than the final `1.4.0`). Do NOT treat an `-rc.N` suffix as a dev install or as "behind" — offer it as an available update.
