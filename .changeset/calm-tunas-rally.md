---
type: Fixed
pr: 0
---
writing any markdown file no longer converts tight multi-line lists to loose ones — a blank line was injected before every bullet following a wrapped item (61 blanks on a 1015-line ROADMAP via phase.complete; the defect sat in the write seam every .md write uses), and tight vs loose lists render differently so this was a rendering change plus large misleading diffs, not just whitespace (#3854)
