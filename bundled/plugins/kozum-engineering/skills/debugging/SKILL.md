---
name: Debugging
description: Reproduce before theorising, bisect to isolate, read the actual error, verify the fix addresses the cause not the symptom.
when_to_use: Invoke when asked to debug a failure, investigate unexpected behaviour, or diagnose why something is not working.
modes: [code]
---

## Reproduce before theorising

You cannot fix a bug you have not reproduced. Before forming a hypothesis, establish that you can produce the failure on demand.

A reproduction is: a specific sequence of inputs and conditions that reliably produces the incorrect outcome. "Sometimes it fails" is not a reproduction. "Run the test suite in watch mode for 30 seconds and one of the async tests occasionally fails" is a reproduction.

If you cannot reproduce it, you do not yet understand it. The first question is always: what are the exact conditions under which it fails?

## Read the actual error

Pattern-matching on error type and guessing the cause is the most common debugging trap. Read the full error message and the full stack trace before doing anything else.

What to read:
- The error message itself (the full text, not just the first line).
- The first frame in the stack that belongs to this codebase (not a library or runtime frame).
- The arguments at that frame if they are available.
- Any "caused by" or inner exception, if the language chains exceptions.

What the stack tells you that the message alone does not: where in the execution path the failure occurred. A `TypeError: Cannot read property 'x' of undefined` is useless without knowing which line threw it and what the undefined value was supposed to be.

## Bisect to isolate

When the failure is in a system with many moving parts, bisect to find the smallest change or component that is sufficient to produce it.

**Binary search on code history:** If the bug was introduced in a recent change, `git bisect` identifies the exact commit. Identify a known-good commit, a known-bad commit, run `git bisect start bad good`, then test each midpoint the tool presents.

**Remove dependencies:** If the bug occurs in a complex integration, reproduce it with a minimal self-contained case that does not involve the full system. If you cannot reproduce it without the full system, the isolation is incomplete.

**Comment out code paths:** If the failure is in a function with multiple branches, disable branches until the failure disappears or narrows. The branch that, when removed, makes the failure disappear contains the bug.

## Verify the fix addresses the cause, not the symptom

A symptom fix makes the symptom disappear. A cause fix makes the symptom impossible.

**Symptom fix:**
```
// Bug: function throws when array is empty
// Fix: catch the throw and return a default
try { return processItems(items) } catch { return [] }
```

**Cause fix:**
```
// Fix: handle empty array inside the function
function processItems(items: Item[]): Result[] {
  if (items.length === 0) return [];
  // ... rest of the logic
}
```

The symptom fix hides future related failures. The cause fix prevents them. After making a change, ask: if a different caller passed the same input, would they still hit the original bug? If yes, you fixed the symptom.

## The cautionary example: the passing test suite

This project shipped 666 passing tests over an inert UI — a test suite that exercised the tool wiring and business logic in isolation while the UI had buttons wired to nothing, forms that silently discarded input, and a session system that never actually sent messages.

A green test suite proves only what it exercises. If the tests do not exercise the broken path, they cannot fail. Before declaring a bug fixed, check whether the existing tests covered the broken path. If they did not, add a test that fails before your fix and passes after it — otherwise you are relying on the same testing gap that allowed the bug to ship.

The test should fail on the original code. If it passes without your fix, you wrote a test that cannot detect the bug.

## Structured hypothesis cycle

When reproduction and direct reading do not immediately reveal the cause:

1. **Hypothesis:** State a specific, falsifiable claim about the cause. "The HTTP client is reusing a closed connection from the pool."
2. **Prediction:** State what you expect to see if the hypothesis is true. "Adding a connection-reset before the failing request will make it succeed."
3. **Test:** Make a minimal change that tests the prediction. Do not refactor, do not clean up — just test the hypothesis.
4. **Observe:** Read the result. If the prediction was wrong, discard the hypothesis and form a new one. Do not rationalize a failed prediction.

Cycling through this quickly — form hypothesis, test, discard or confirm — is faster than extended reasoning without testing.
