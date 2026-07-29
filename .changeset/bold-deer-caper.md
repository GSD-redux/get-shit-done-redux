---
type: Changed
pr: 2575
---
**The UI consideration probe now asks about loading and error states for interactive controls** — a UI surface classified only as an interactive control (a button, toggle, switch, or slider, with no accompanying form or list) previously had only its long-text state probed, so a spec could omit what the control shows while its action is in flight or when it fails and still pass. Control-only surfaces are now probed for their in-flight and failure states too. (#2151)
