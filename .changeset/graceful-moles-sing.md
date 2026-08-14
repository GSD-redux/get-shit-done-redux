---
type: Fixed
pr: 3446
---
Phase writes now guard the current milestone's scope. phase add/add-batch/insert reject a description containing a level 1-3 heading with a milestone marker (version token, status marker, or the word Milestone) before anything is written, and the edit-phase workflow captures roadmap milestone-scope (new read-only probe) around its in-place section write and rolls the edit back with an explicit error if the milestone window's scope or phase set changed.
