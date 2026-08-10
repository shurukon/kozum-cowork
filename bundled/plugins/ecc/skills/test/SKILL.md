---
name: Test Workflow
description: Run the full test suite, interpret failures, report what is broken and what must be fixed before shipping.
when_to_use: Invoke before shipping any change, after a significant refactor, or when asked to verify that the codebase is in a shippable state.
modes: [code]
---

## Run before interpreting

Do not guess whether tests pass. Run them. Every modern project has a test command — find it (`package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`) and run it before reporting any status.

```bash
# Node / TypeScript
npm test / pnpm test / yarn test
node --experimental-strip-types --test tests/**/*.test.ts

# Rust
cargo test

# Python
pytest / python -m pytest

# Go
go test ./...
```

If the test command is unclear, read `README.md` or `CONTRIBUTING.md` first.

## Interpret failures before reporting

A failing test tells you three things:
1. Which assertion failed (the error message).
2. Where it failed (the stack trace — look at the first frame in *this* codebase, not a test-runner frame).
3. What the test expected vs. what it got.

Do not report "tests failed" without reading the failure. "Tests failed" is not actionable. "The `sessions.branch` test failed because the new session's title was `undefined` rather than `Session title (branch)`" is actionable.

## Distinguish test bugs from code bugs

A failing test may mean:
- The code is wrong (most likely).
- The test is wrong — it asserts something that was never correct.
- The test environment is wrong — a missing dependency, stale build artefact, or wrong working directory.

Before changing code to make a test pass, confirm the test is asserting something correct. A test that passes after you change the assertion to match the wrong behaviour is worse than a failing test — it hides the bug and makes future regressions invisible.

## Fix the shallowest failure first

When multiple tests fail, they often share a root cause. Fix the shallowest failure in the call stack first. A broken constructor makes every test that calls it fail — fixing the constructor clears the cascade. Fixing individual downstream failures one by one is slower and produces unnecessary churn.

## Coverage gaps are not the same as failures

A green test suite with 40% branch coverage does not mean 60% of the code is broken — it means 60% of the branches were not exercised by the suite. Do not confuse "not tested" with "broken". If asked to add coverage, write tests that would fail if the code were wrong, not tests that merely call the code and assert it does not throw.

## Before marking done

- All tests pass (`0 failures`).
- No tests were skipped that were passing before.
- If you added code, you added or updated tests for it.
- If you fixed a bug, the test that catches it would fail on the original code.
