---
type: Fixed
pr: 2628
---
**`/gsd-execute-phase` and `/gsd-quick` branches no longer auto-track `origin/master`** — the branch-creation `git checkout -b <branch> origin/$DEFAULT_BRANCH` omitted `--no-track`, so with the default `branch.autoSetupMerge=true` git wired the new branch's upstream to `refs/heads/$DEFAULT_BRANCH`. A subsequent GUI sync (GitHub Desktop, VS Code) then pushed the branch's commits straight onto `origin/$DEFAULT_BRANCH`, bypassing PR review — in one project every commit of a 7-plan phase landed on `origin/master`. `--no-track` is now passed; the first `git push -u origin <branch>` sets up correct same-name tracking. (#2498)
