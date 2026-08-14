---
type: Fixed
pr: 0
---
verify plan-structure now recognizes task child elements that carry attributes on their opening tag (e.g. <verify type="auto">), so plans annotating verify mode (auto vs human) or other child-tag attributes no longer produce false "missing <verify>" / "missing <action>" / etc. warnings. Bare tags continue to validate exactly as before.
