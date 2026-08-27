---
type: Changed
pr: 0
---
**`--pick <field>` now exits non-zero when a field is absent, and `parseNamedArgs` strictly rejects unrecognized flags and stray positionals** — previously an absent `--pick` field printed an empty string at exit 0 (indistinguishable from a genuinely empty answer, #3365), and a stray or unrecognized argv token was silently dropped rather than rejected, in one case corrupting STATE.md by running a command against the wrong phase (#3358). Both now fail loudly instead of silently: `X=$(gsd_run query V --pick F) || X=default` observes the real failure it was written for, and an unrecognized flag or positional exits non-zero naming what was wrong. (#3884)
