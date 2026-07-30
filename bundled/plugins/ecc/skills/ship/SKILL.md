---
name: Ship Workflow
description: Systematic pre-ship checklist — lint, test, build, diff review, commit message craft, push. Never skip steps.
when_to_use: Invoke when asked to ship, commit, or prepare a change for review. Run the full checklist before any push.
modes: [code]
---

## The checklist is not optional

Every item below must pass before a change is pushed. Skipping steps produces the failure mode this skill exists to prevent: broken builds on the remote, test regressions discovered after merge, and commits that are impossible to bisect.

## Step 1 — Diff review

Before anything runs, read your own diff.

```bash
git diff          # unstaged changes
git diff --staged # staged changes
git status        # files in each state
```

Ask:
- Is every changed file intentional? (Stray debug files, `.env` changes, editor swap files are not.)
- Is there anything in the diff that should not ship? (Console logs, commented-out code, hardcoded values that belong in config.)
- Is the diff minimal? (The smallest correct change is the easiest to review and revert.)

If you see something wrong, fix it before running the suite.

## Step 2 — Lint

Run the project's linter without `--fix`. Read the output. Fix violations manually so you understand what changed.

```bash
# TypeScript/JS
npx tsc --noEmit          # type-check
npx eslint src/            # lint rules
npx biome check .         # or biome

# Python
ruff check .
mypy src/

# Rust
cargo clippy -- -D warnings
```

A linter warning suppressed with a `// eslint-disable` comment without explanation is a code smell. If the suppression is justified, add the reason.

## Step 3 — Tests

Run the full suite. Zero failures is the only acceptable result before a push.

See the `test` skill for how to interpret failures.

## Step 4 — Build

If the project has a build step, run it. A build may surface issues that tests and the type-checker miss (missing assets, incorrect import paths in the output, bundle size regressions).

```bash
npm run build
cargo build --release
go build ./...
```

## Step 5 — Commit message

A commit message is the permanent record of why a change was made. It will be read during bisect, revert, and blame — not just during review.

**Format:**
```
<type>(<scope>): <imperative summary under 72 characters>

<body — what changed and why; omit if the summary is sufficient>

<footer — breaking changes, issue refs>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`.

The summary is imperative: "add session branching" not "added session branching" or "this commit adds session branching".

The body explains *why*, not *what* — the diff already shows what. "Fix null dereference when session has no messages" is a what. "The session store's `branch` method assumed at least one message existed, which was never guaranteed for newly-created sessions" is a why.

## Step 6 — Push

```bash
git push origin <branch>
```

If the push is to a branch that has a CI pipeline, wait for it to pass before marking the work done. A green local suite on a machine-specific environment configuration does not guarantee a green CI on a clean environment.

## What "shipped" means

Shipped means: the change is on the remote branch, the CI pipeline passed, and the change is either merged or is in a pull request that is ready for review. "Pushed" alone is not shipped.
