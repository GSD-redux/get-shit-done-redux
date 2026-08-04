**If `--auto` flag present OR `AUTO_MODE` is true:**

Display banner:
```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► AUTO-ADVANCING TO PLAN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Context captured (assumptions mode). Launching plan-phase...
```

Launch: `Skill(skill="gsd-plan-phase", args="${PHASE} --auto")`

Handle return: PHASE COMPLETE / PLANNING COMPLETE / INCONCLUSIVE / GAPS FOUND
(identical handling to discuss-phase.md auto_advance step)
