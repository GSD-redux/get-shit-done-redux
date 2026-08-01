<!-- provenance: template-derived (gsd-core/templates/). NOT real-user-sourced. See #2371 — adequate for happy-path/sequence scenarios, NOT sufficient as a negative fixture asserting the engine correctly rejects input. -->
---
phase: "01"
name: "Parser"
created: 2026-01-01
status: failed
---

# Phase 1: Parser — User Acceptance Testing

## Current Test

number: 1
name: Parse checklist
expected: |
  Items parse without crashing

## Test Results

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Parse checklist | FAIL | tokenizer crashes on empty file |

## Summary

UAT FAILED — tokenizer crashes on empty file.
