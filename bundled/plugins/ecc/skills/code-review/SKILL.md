---
name: Code Review
description: Systematic code review method — correctness before style, hunt specific defect classes, review in context of the diff, report defects not preferences.
when_to_use: Invoke when asked to review a diff, PR, or block of code for quality, correctness, or safety.
modes: [code]
---

## Correctness before style

Review in this order:
1. **Correctness** — does it do what it is supposed to do? Are the edge cases handled?
2. **Safety** — can it fail in ways that cause data loss, security exposure, or inconsistent state?
3. **Clarity** — can the next person understand it without running it?
4. **Style** — does it match local conventions?

Do not block a review on style if correctness and safety are acceptable. Style comments go at the bottom, clearly marked as non-blocking.

## Defect classes worth hunting

These categories produce the most real-world bugs per review hour.

**Error paths that swallow failures:**
```
// Wrong: error is swallowed
try { doSomething() } catch (_e) {}

// Wrong: logged but not propagated when the caller needs to know
try { doSomething() } catch (e) { console.error(e) }
```
A caught error that does not propagate, rethrow, or return an error value is a silent failure. The caller proceeds as if success occurred.

**Unhandled promise rejections:**
- `async` functions called without `await` and without `.catch()`.
- `Promise.all` where one rejection cancels the rest and the error is not surfaced.
- Event handlers that call `async` functions: `element.on('click', async () => { ... })` — rejections here are silently dropped by most runtimes.

**Off-by-one at boundaries:**
- `array[array.length]` (undefined, not the last element).
- `for (let i = 0; i <= array.length; i++)` (one iteration past the end).
- Slice/substring arguments that are off by one in either direction.
- Date range queries: `>=` vs `>` at the boundary is the most common database off-by-one.

**Resource leaks:**
- File handles, database connections, or HTTP clients opened but not closed in all code paths (not just the happy path).
- Event listeners added but never removed on a component or object that is destroyed.
- Timers (`setInterval`, `setTimeout`) that continue after the context that created them is gone.

**Time-of-check to time-of-use (TOCTOU):**
- Check if a file exists, then open it — it may be deleted between the check and the open.
- Check a permission or role, then act — the role may change between the check and the act in concurrent systems.
- Read a value, decide based on it, write — the value may have changed in concurrent systems.

**Unbounded input:**
- No limit on array/list size before iterating.
- No character limit on strings before storing or sending.
- No pagination on queries that could return the entire table.
- Recursive functions without a depth cap on user-controlled input.

**Missing cancellation:**
- Long-running operations that cannot be aborted once started.
- API calls initiated from UI components with no cleanup on unmount (React useEffect, etc.).
- Background tasks that continue after the session or context that started them is gone.

## Review the diff in context, not in isolation

A change that looks correct in isolation can be wrong in context. Before concluding a review:
- Look at the callsites for changed functions — do they handle the new return type or error contract?
- Look at the tests — does the test suite exercise the changed paths?
- Look at the migration path — if a database schema changed, is there a migration file and is it reversible?
- Look at the API contract — if a public interface changed, are all consumers updated?

## Distinguish defects from preferences

A **defect** is something that can produce incorrect behaviour, data loss, security exposure, or a failure mode. Report defects as blockers.

A **preference** is a style or design choice that differs from your preference but works correctly. Do not report preferences as defects. If a preference comment is worth making, mark it explicitly: "Non-blocking: I'd prefer X because Y — but this is correct as written."

A review that mixes defects and preferences at the same severity level is a review that trains authors to ignore review comments.
