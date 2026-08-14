---
type: Fixed
pr: 0
---
Managed /gsd:debug auto-resume no longer stalls after an answered checkpoint: the respawned session manager now receives the recorded next action and checkpoint status, plus the disposition that prior checkpoints were already answered, so the debug loop proceeds on the persisted next step instead of stopping behind the no-progress guard.
