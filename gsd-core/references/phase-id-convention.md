# Bracket phase-ID convention

The bracket convention is opt-in through `phase_id_convention: "bracket"`.
Its compact grammar card below is generated from `src/phase-id-card.cts`; edit
that module, not this block.

<!-- PHASE-ID-CARD:START -->
```text
[GSD.02] 05.03-01
 │   │   │  │   │
 │   │   │  │   └── plan        01
 │   │   │  └────── subphase    03
 │   │   └───────── phase       05
 │   └───────────── milestone   02
 └───────────────── project     GSD

milestone = bracket integer; dots = phase-levels; one hyphen = plan; no 'Phase' word, no vX.Y
```
<!-- PHASE-ID-CARD:END -->

The display form is `[PROJECT.MM] PP[.SS][-LL]`: the bracket carries the
project and milestone, dots join phase levels, and the single hyphen introduces
the optional plan. A phase directory encodes the same identity without brackets:
`PROJECT.MM-PP[.SS]-slug/`.

Human-facing bracket surfaces omit both the literal `Phase` label and the
legacy `vX.Y` milestone marker. Repositories using the unset, `sequential`, or
`milestone-prefixed` conventions retain their existing display forms.
