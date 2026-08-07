---
type: Fixed
pr: 3124
---
The api-coverage detector's negation-suppression check no longer takes superlinear time on long prose, which was hanging the verification gate (#2784, #3127). It also no longer fails to suppress a negated pair ("this phase integrates no external API") when the negation sits in any clause other than the first on a line — a latent offset bug made negation suppression a no-op for every clause after the first.
