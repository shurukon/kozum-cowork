# Kozum Cowork

A provider-agnostic desktop agent for Windows, with two independent modes —
**Cowork** for creative and knowledge work, **Code** for software engineering.

It is not tied to any AI company: it runs on whichever model you configure,
across 18 providers including several with free tiers.

---

## What makes it different

**No Linux VM.** The comparable product ships a Hyper-V image of roughly 12 GB
and runs its tools inside it. Kozum's installer is ~86 MB and every tool runs
directly on Windows through Electron's bundled Node runtime. Nothing to
provision, nothing to keep in sync, and no `Claude-3p`-style data directory that
refuses to open when OneDrive turns `%APPDATA%` into a junction.

**It installs its own extensions.** `mcp_install` and `plugin_install` let the
agent find, add, connect and hot-reload an MCP server or a plugin with no manual
config editing and no restart. Adding an MCP server by hand needs only a URL and
an optional token, the way claude.ai does it — not a JSON file.

**Both modes run at once.** Cowork and Code hold separate sessions, providers,
API keys and models. Switching tabs is a view change; neither is interrupted, and
you can run MiniMax-M3 in one while GLM drives the other.

**Zero native modules.** Computer use is PowerShell + .NET P/Invoke rather than a
compiled input library, so the installer never fails on node-gyp and needs no
Visual Studio Build Tools.

---

## Capabilities

| | |
|---|---|
| **82 built-in tools** | filesystem, shell with background jobs, processes, web fetch/search, screenshots, tasks, subagents, skills, memory, scheduling, MCP, plugins, browser, computer use |
| **Internal browser** | Electron `WebContentsView` — navigate, click, type, scrape, extract JSON, screenshot. Also the artifact preview and the Code-mode UI test harness |
| **Computer use** | screen capture and synthetic input, gated on a vision-capable model |
| **Memory** | Obsidian-compatible markdown vault: `_index.md` hub, hot cache, `[[wikilinks]]`, four note types |
| **Project knowledge base** | Code mode builds it once, then updates incrementally so sessions never re-scan a repo |
| **Scheduled tasks** | own 5-field cron with correct dom/dow OR semantics, DST handling, overlap-skip and bounded catch-up. Cowork only |
| **Plugins** | real Claude plugin format, from a `.zip` or straight from GitHub, plus marketplaces |

### Providers

Anthropic · OpenAI · NVIDIA NIM · Cerebras · Google AI Studio · Cloudflare Workers AI ·
OpenRouter · Kilo · Wafer · OpenCode Zen · AgentRouter · DeepSeek · Moonshot ·
MiniMax · Z.AI · Vertex AI · ChatGPT subscription · any OpenAI-compatible endpoint

Multiple API keys per provider, dynamic model refresh, and independent selection
per mode.

---

## Build

CI does this on every push; `verify` runs on Linux and gates the Windows build.

```bash
npm install
npm run verify        # typecheck both projects + 666 tests + capability gate
npm run build:win     # NSIS installer into release/
```

`npm run icons` regenerates the icon set from `assets/logo-source.png` (needs
Python with pillow and numpy).

---

## Honest limitations

- **The installer is unsigned.** Windows SmartScreen warns on first run — More
  info → Run anyway. Signing needs a paid OV/EV certificate.
- **Four provider protocols are stubs.** Only `openai-chat` has an adapter, which
  covers 14 of the 18 providers. Anthropic Messages, OpenAI Responses, Gemini
  native and Vertex throw a named "not implemented" error rather than silently
  falling back to the wrong wire format.
- **Windows-only paths are unverified.** Everything was built and tested on
  Linux, so the PowerShell computer-use scripts and the Electron browser backend
  are correct by construction and by unit tests on the generated script text, but
  have not executed on real Windows. Same for the NSIS firewall rule.
- **Page selection in `file_read_pdf` is approximate.** Content streams are mapped
  to pages in document order, which is not true page segmentation. Scanned PDFs
  fail honestly and suggest `file_read_image`.
- **`file_search` runs the model's regex in a worker with a 5-second budget.**
  A catastrophic pattern is cut off rather than allowed to freeze the UI.

## Security posture

An adversarial audit proved 19 defects with running reproductions; all were
fixed and each has a regression test. The threat model that drove it: the agent
reads untrusted content and a model then chooses tool arguments.

- Workspace confinement resolves symlinks before checking, refuses UNC and device
  paths, and protects the app's own key store.
- SSRF is blocked on every redirect hop, including IPv4-mapped IPv6 and alternate
  IPv4 encodings, across the web, MCP and marketplace paths.
- Archive extraction is guarded against zip-slip and zip-bombs, bounded by
  *actual* inflated output rather than the attacker's declared size.
- Third-party plugin, skill and MCP metadata is sanitised before it reaches the
  system prompt, so it cannot forge a section tag.
- API keys are encrypted with Electron `safeStorage`; the renderer only ever sees
  a masked form. `env_get` masks secret-shaped variable names.
- The markdown renderer builds React elements and never uses
  `dangerouslySetInnerHTML`.
