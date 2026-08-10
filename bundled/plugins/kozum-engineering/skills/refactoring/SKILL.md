---
name: Refactoring
description: Smallest change that solves the problem, match local conventions, do not reformat untouched lines, keep behaviour identical and prove it with existing tests.
when_to_use: Invoke when asked to refactor, clean up, restructure, or improve existing code without changing its behaviour.
modes: [code]
---

## Smallest change that solves the problem

Every refactoring should have a stated goal: "extract this function so it can be tested independently", "collapse these three near-identical switch cases", "rename this to match the domain language we now use". The change should be exactly what is needed to achieve that goal, and nothing else.

The failure mode is scope creep: starting with a function extraction, noticing adjacent code that could be cleaner, cleaning that, noticing a pattern across the module, addressing the pattern, finishing two hours later with a diff that touches 40 files and mixes behavioural changes with structural ones. That diff is unreviable, unbiectable, and will introduce bugs that cannot be attributed to any specific change.

Before making a change, state the goal in one sentence. If the change is not in service of that goal, stop.

## Match local conventions over global "correct"

A codebase has conventions. They may not be the conventions you would choose. Refactoring is not an opportunity to impose your preferences on code you did not write.

If the codebase uses `snake_case` for variables, use `snake_case`. If it uses 2-space indentation, use 2-space indentation. If it handles errors by returning `null` rather than throwing, use `null`. If it uses callbacks rather than promises, match that.

The exception: if the stated goal of the refactoring is to bring code into alignment with a new convention (e.g., migrating from callbacks to async/await), the diff should be exactly and only that migration — not the migration plus "I also cleaned up a few things while I was here."

Applying inconsistent conventions to refactored lines while leaving surrounding code unchanged makes the code harder to read, not easier.

## Do not reformat untouched lines

This is a rule about diff hygiene, not aesthetics.

A reviewer comparing the before and after of a refactoring needs to see what actually changed. If reformatting is interleaved with structural changes, the diff becomes unreadable. Every whitespace change forces the reviewer to re-examine a line to determine whether it changed in substance.

If the code has a formatter, run it as a separate commit on the whole file before making structural changes, or after. Do not mix formatter output with structural changes in the same commit.

If no formatter is configured, do not reformat manually. Leave indentation, line breaks, and whitespace exactly as they were in lines you did not need to change.

## Keep behaviour identical

A refactoring that changes behaviour is not a refactoring — it is a feature or a fix, and should be committed separately.

**Signs that a refactoring changed behaviour:**
- A previously passing test now fails.
- A new code path exists that did not exist before.
- An edge case that was handled (even if incorrectly) is now unhandled.
- An error that was previously thrown is now swallowed, or vice versa.

If you discover a bug while refactoring, do one of two things:
1. Stop the refactoring, fix the bug in a separate commit, then resume.
2. Note the bug and leave it for a follow-up, finishing the refactoring with the original behaviour preserved.

Do not fix the bug as part of the refactoring. A diff that says "refactoring" but also changes behaviour is a diff that makes bisecting future bugs harder.

## Prove it with existing tests

Before committing a refactoring, run the existing test suite. It should pass identically — same tests passing, same tests failing (if there are pre-existing failures), no new failures.

If the existing tests do not cover the refactored code, note that as a gap but do not add tests in the same commit unless they are testing the original behaviour (i.e., tests that would have passed on the old code too). Tests that would fail on the old code are behavioural changes.

A test suite that passes after the refactoring does not guarantee correctness — it guarantees consistency with the tested paths. The coverage gap is a separate problem to address separately.
