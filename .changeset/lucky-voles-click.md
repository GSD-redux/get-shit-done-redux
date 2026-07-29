---
type: Changed
pr: 0
---
**Reviewer config keys are now owned by their reviewer-lane capabilities** — `review.models.<lane>`, `review.<lane>_host` and `review.max_prompt_tokens_per_reviewer.<lane>` moved from the central config schema to federated slices on the lanes that use them. Key names and existing `.planning/config.json` files are unchanged and no migration is needed. Two consequences are user-visible: a `review.models.<x>` or `review.max_prompt_tokens_per_reviewer.<x>` key naming something that is not a declared lane is now rejected by `config-set` where it was previously accepted and silently ignored; and clearing one of these keys now reads back as empty rather than reporting key-not-found, because a federated key always resolves to its declared default. `review.max_prompt_tokens`, `review.default_reviewers` and `review.reviewer_instances` describe policy across lanes and deliberately remain central. (#2797)
