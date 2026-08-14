---
type: Fixed
pr: 3486
---
Phase-directory collisions in .planning/phases/ (two in-scope dirs normalizing to the same phase number) no longer resolve by filesystem mtime — a checkout-order signal that made progress.total_plans and completed_plans differ across clones of the same commit. The survivor is now chosen deterministically by lexicographic directory name, and the collision is surfaced as a stderr warning naming both directories.
