---
name: Document Craft
description: Produce documents, spreadsheets, and decks as real files — gather facts first, write to disk, choose the right format for native preview, state assumptions.
when_to_use: Invoke when producing any document, report, presentation, spreadsheet, or structured written deliverable as a file rather than as a chat reply.
modes: [cowork]
---

## Gather facts before loading a format

The most common failure pattern: load a "presentation skill" or "Excel template generator" as the first action, fill context with layout instructions and format boilerplate, then discover you have no actual content to put in the template.

The correct order is:
1. Gather all required facts, data, and content — from the user, from searches, from referenced files.
2. Organise the content into an outline or structure that fits the deliverable.
3. Only then apply format concerns: which headings, how many slides, what columns.

If step 1 is incomplete, stop and ask rather than fabricating content to fill a structure. A document with accurate gaps stated explicitly is more useful than a document filled with plausible-sounding invention.

## Write to disk — do not paste into chat

Documents belong on the filesystem, not in a code block in the chat reply. The user cannot open a code block in their spreadsheet application.

- Use `write_file` (or the appropriate tool) to write the output to a file path the user can open.
- Use an absolute path or a path relative to the project's working folder.
- Confirm the path in your reply so the user knows where to find it.

Pasting the document content into the chat as a fallback is acceptable only when the user explicitly requests it or when file I/O is unavailable.

## Formats that preview natively in this application

| Format | Notes |
|---|---|
| Markdown (`.md`) | Renders natively. Best for text-heavy documents, READMEs, notes, structured writing. |
| HTML (`.html`) | Renders natively. Best for documents requiring precise layout, tables, or visual structure that markdown cannot express. |
| SVG (`.svg`) | Renders natively. Best for diagrams, charts, and vector graphics. |
| PDF (`.pdf`) | Renders natively (read-only). Best when the output will be printed or the layout must be preserved across machines. |

Formats that do NOT preview natively: `.docx`, `.xlsx`, `.pptx`, `.csv` (opens as text). They can still be created and opened with external applications — just make clear to the user they need to open them in the appropriate app.

## Self-contained HTML with inlined CSS

When producing an HTML document, make it fully self-contained: inline all CSS in a `<style>` tag, do not reference external stylesheets, and avoid JavaScript unless it is essential and can be inlined.

A self-contained HTML file opens correctly in any browser, including offline, and can be shared without dependencies.

**Minimal structure:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document Title</title>
  <style>
    /* All styles inline here */
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
  </style>
</head>
<body>
  <!-- Content -->
</body>
</html>
```

Do not introduce a build step (webpack, Vite, PostCSS) for a single document. No build step means no dependency on the local toolchain and no breakage when the toolchain changes.

## Spreadsheets

For CSV, write clean columnar data: one header row, consistent column count per row, quoted fields if they contain commas or newlines.

For `.xlsx`, use the appropriate library (e.g. `xlsx` / SheetJS, `exceljs`) if available. State which library you used so the user can install it if it is not present.

Document the column meanings in the file itself (a "Legend" sheet or header comments) — do not rely on the user remembering what each column means from context.

## Presentations

Presentations are a forcing function for clarity, not a decoration layer over bullet points. Each slide should carry one idea.

For Markdown-based presentations (Marp, Slidev), keep the markup clean and invoke the appropriate runtime to produce the final format.

For HTML presentations, produce a single self-contained file as above. Navigation between slides should work without a server.

Do not generate a 40-slide deck when the content warrants 10 slides. Density is not thoroughness.

## State assumptions and gaps explicitly

Every document should end with or contain a clearly marked section:

**Assumptions:** List anything that was assumed rather than confirmed (e.g., "Assumed financial year ends 31 December", "Assumed the audience is technical").

**Verification needed:** List any specific claims, numbers, or assertions that could not be verified from available information and should be checked before distribution.

A reviewer who finds an assumption stated explicitly will correct it. A reviewer who finds an unstated assumption presented as fact will pass it forward.
