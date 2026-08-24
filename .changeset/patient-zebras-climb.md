---
type: Fixed
pr: 0
---
**Every reviewer lane can now be given a prompt-token cap, and the documented global `review.max_prompt_tokens` finally works** — the nine CLI reviewer lanes declared no budget key, so no cap could reach them by any configuration, and the central global was advertised in the config schema but declared nowhere, so setting it changed nothing. Each CLI lane now accepts `review.max_prompt_tokens_per_reviewer.<slug>` on the same terms as the local-server lanes, and the global resolves as the documented fallback. Defaults are unchanged: with nothing configured, no lane trims. (#3691)
