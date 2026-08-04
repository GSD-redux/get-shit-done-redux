**Reviewer instances (#1517, optional):** if `review.reviewer_instances` is configured,
instance names in `review.default_reviewers` run as independent identities. Resolution rules
are in `gsd-core/references/reviewer-instances.md` — load it lazily only when instances are
configured. Unconfigured → default path unchanged.
