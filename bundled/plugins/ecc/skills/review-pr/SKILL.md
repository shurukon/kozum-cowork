---
name: Review PR
description: Pull request review process — read the description first, verify CI, hunt defect classes, distinguish blockers from suggestions, leave a structured verdict.
when_to_use: Invoke when asked to review a pull request, a branch diff, or a change ready for merge.
modes: [code]
---

## Read the description before the diff

The PR description explains what changed and why. The diff shows how. Reading the diff without the context of the description produces review comments that misunderstand the intent.

If the description is absent or inadequate, that is the first review comment: "The description does not explain what this changes or why. Please add one before I can review the intent."

## Check CI before reviewing

If CI has not passed, do not review. A review on a broken build is wasted — the failures will require further changes that may invalidate your review comments.

If CI is passing, note which checks ran. A suite that only lint-checks but does not run tests is not sufficient evidence that the change is correct.

## The review order

Review in this order, and stop and comment at the first blocking issue rather than continuing to review code that will change:

1. **Scope:** Does this PR do one thing? A PR that mixes a feature, a refactor, and a dependency upgrade is three PRs. Review them separately.
2. **Tests:** Are there tests for the new behaviour? Do the tests exercise the failure paths, not just the happy path? Would they have caught the bug this PR fixes?
3. **Correctness:** Does the code do what the description says? See the `code-review` skill for the specific defect classes worth hunting.
4. **Contracts:** If a public interface changed, are all consumers updated? If a database schema changed, is there a migration?
5. **Style:** Does the code match local conventions? This is non-blocking unless the codebase has enforced style tooling.

## Blocking vs. non-blocking

**Blocking (must fix before merge):**
- Correctness defects — incorrect behaviour in the happy path or at edge cases.
- Missing error handling that will produce silent failures.
- Security vulnerabilities.
- Missing or incorrect tests for new behaviour.
- API contract violations.

**Non-blocking (suggestions):**
- Style preferences that differ from yours but comply with project conventions.
- Alternative implementations that are neither more correct nor more clear.
- Documentation improvements.

Mark non-blocking comments explicitly: "Non-blocking suggestion: …". A reviewer who marks everything at the same severity teaches authors to ignore review comments.

## The verdict

Every review ends with a clear verdict:

- **Approve:** The change is correct, tested, and ready to merge. Minor suggestions may accompany an approval.
- **Request changes:** One or more blocking issues must be resolved before merge. List them specifically, in priority order.
- **Comment:** Used when you have observations but are not the right reviewer to make the final call (e.g., you reviewed only one module of a change that spans several).

"Looks good, some minor things" without an explicit approve or request-changes is not a verdict. It is noise that leaves the author uncertain about whether they can merge.

## What you are not reviewing

You are reviewing the code. You are not reviewing the person. "This is wrong" is a code comment. "You always do this wrong" is not a code review. Every comment is addressed to the code, not the author.
