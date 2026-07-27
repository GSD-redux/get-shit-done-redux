---
type: Fixed
pr: 2715
---
**The claude-orchestration Workflow backend now honors your model settings** — with that BETA capability enabled, every plan was dispatched with no model at all, so `model_overrides`, `model_policy` and `model_profile` were silently ignored and each agent ran on whatever the session happened to be using. Plans now run on the same model the normal dispatch path would have used, and the generated script states which model was applied. Two consequences to expect: agents that were inheriting the session model will now run on the model your profile selects, and the first run after upgrading re-executes any in-flight resumable run, because the dispatch options changed. (#2686)
