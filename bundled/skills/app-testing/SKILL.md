---
name: App Testing
description: Browser-driven application testing — start the server, enumerate interactive elements, exercise every state, find what is actually broken, report honestly.
when_to_use: Invoke when asked to test, validate, or do a QA pass on a running or buildable web application.
modes: [cowork]
---

## The goal

Find things that are actually broken and report them honestly. The opposite failure is declaring success after a superficial pass — clicking the happy path twice and concluding the application works. A test that cannot fail is not a test.

## The loop

### 1. Start the application

Use `shell_exec_bg` to start the dev server in the background. The command is typically `npm run dev`, `npm start`, `yarn dev`, or similar — check `package.json` scripts first.

```
shell_exec_bg({ command: "npm run dev", cwd: "/path/to/project" })
```

### 2. Wait until the server is ready

Poll with `shell_job_status` and watch stdout for the port line, OR poll with `browser_navigate` and retry on connection error. Do not assume the server is ready immediately — it typically takes 1–5 seconds.

```
// Poll up to 15 seconds
browser_navigate({ url: "http://localhost:3000" })
// if fails → wait 1s → retry
```

Once the page loads without a connection error, proceed.

### 3. Enumerate all interactive elements

Use `browser_extract` with a targeted instruction to list every interactive element on the page.

```
browser_extract({ instruction: "List every button, link, input, select, textarea, and clickable element. Include its visible label, type, current state (enabled/disabled/loading), and whether it has an accessible label." })
```

Do not skip elements that appear secondary or decorative — those are the ones that are most often unwired.

### 4. Exercise each element

For each interactive element found:

**Buttons:**
- Click it. Observe what changed. If nothing changed, that is a finding.
- If it submits a form, look for a success confirmation, an error message, or a navigation change. If none of these occur, that is a finding.

**Links:**
- Follow them. Verify the destination is correct. A link that navigates nowhere or 404s is a finding.

**Text inputs and textareas:**
- Type a valid value and submit. Assert the result changed.
- Submit the form empty. Verify validation fires and an error message appears. If the form submits silently with empty required fields, that is a finding.
- Type an invalid value (e.g., `not-an-email` into an email field, `<script>alert(1)</script>` into a text field). Assert validation fires.

**Selects and dropdowns:**
- Open the dropdown. Assert options are visible.
- Select a non-default option. Assert the selection is reflected.

**Checkboxes and radio buttons:**
- Toggle each. Assert the visual state changes and any dependent behaviour fires.

### 5. Check for console errors

After exercising each major flow, use `browser_get_content` or the browser's console via `browser_extract` to check for JavaScript errors. Unhandled errors in the console are findings — they indicate code paths that threw without recovery.

### 6. Screenshot at each viewport

```
browser_screenshot({ title: "Desktop — after action X" })
```

Test at minimum:
- Desktop: 1440px wide (default)
- Tablet: 768px wide
- Mobile: 375px wide

Resize using `browser_navigate` with viewport parameters, or use browser devtools emulation. Visual breakage at any viewport is a finding.

## What counts as a finding

Report only things that are broken or absent. Do not report aesthetic preferences as defects.

**Report:**
- A button wired to nothing (click produces no observable change, no network request, no UI update).
- A form that accepts submission with invalid or empty required data without error.
- A form that silently fails (submits, no visible confirmation, no visible error, no network request).
- A link that 404s or navigates to the wrong place.
- An element that is visually present but not keyboard-accessible.
- JavaScript errors in the console during normal operation.
- A page that breaks at a standard viewport width.
- Content that overflows its container and is clipped or invisible.

**Do not report:**
- Colour or typography choices (unless they fail contrast requirements — then report them as accessibility defects).
- Wording preferences.
- Things that are disabled by design and visually indicate it.
- Features that are not yet implemented and are clearly marked as such.

## Reporting findings

For each finding:
1. **What:** Describe the element and the operation.
2. **Expected:** What a working implementation would do.
3. **Actual:** What actually happened.
4. **Reproduction steps:** Exact sequence of browser actions.
5. **Screenshot:** Attach if the visual state is relevant.

Be direct. "The Submit button on the Contact form does nothing when clicked — no request, no feedback, no error" is a finding. "The button seems like it might not work perfectly" is not.

## Tool reference

| Tool | Purpose |
|---|---|
| `shell_exec_bg` | Start dev server in background |
| `shell_job_status` | Check server startup output |
| `browser_navigate` | Go to a URL |
| `browser_click` | Click a specific element |
| `browser_type` | Type into an input |
| `browser_extract` | Extract structured data from the page |
| `browser_get_content` | Get raw page text or HTML |
| `browser_screenshot` | Capture the current state |
| `browser_wait` | Wait for an element or duration |
