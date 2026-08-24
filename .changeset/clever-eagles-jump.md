---
type: Changed
pr: 3789
---
**Section separators now render responsively instead of wrapping** — stage banners, checkpoints, completion and error panels used fixed-width runs of box-drawing characters (a 53-column `━` rule, a 62-column `╔═╗` box). In a narrower pane those runs wrap and the border comes apart from the heading it framed. GSD now emits Markdown headings and `---` thematic breaks, which adapt to the available width in every runtime. (#3028)
