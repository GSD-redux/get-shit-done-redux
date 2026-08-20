---
type: Fixed
pr: 3693
---
**`verify plan-structure` no longer false-flags positively-asserted literals in entity-escaped verify chains** — planners emit `&amp;&amp;` as the chain operator, which the negative-grep gate's segment splitter did not recognize, so a `= 0` clause poisoned `-ge 3` clauses joined to it and pushed authors toward suppressing a real gate. The gate now scans the decoded text the shell would actually run. (#3611)
