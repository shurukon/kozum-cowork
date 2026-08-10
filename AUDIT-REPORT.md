# Cowork 0.5.0 — Audit Report: Backend ↔ Frontend Gaps + System Prompt

**Source of truth**: `C:\Users\MKT\.local\share\kilo\plans\1785872487233-cowork-p0-fixes.md`
**Scope**: Full audit of `src/main` (backend), `src/renderer` + `src/preload` + `src/shared` (frontend), against the `D:\open-design-main` reference.
**Outcome**: Backend is substantially complete; the frontend **drops** several backend features at the reducer/UI boundary, and the system prompt under-documents helper tools. Six P0 gaps + system-prompt gaps identified, all fixable in one cohesive pass.
**Verification status**: Every line/behavioral claim below was confirmed against the live source at `D:\kozum-cowork-0.5.0\kozum-cowork-0.5.0`.

---

## 0. Verified audit findings (spot-checked against source)

| Claim in plan | File:line | Verified |
|---|---|---|
| Reducer has a **no-op** handler for `permission_request` + `question` | `src/renderer/store/sessionReducer.ts:161-164` (matched `case "permission_request":` / `case "question":` block) | ✅ Present, confirmed by `Select-String` |
| `SubagentManager` is instantiated with a stub runner | `src/main/index.ts:172-173` (`new SubagentManager(async (_spec) => { return { text: "(subagent not yet wired)" }; })`) | ✅ Exact match |
| Permission flow uses `ask()` which **regenerates** the requestId | `src/main/session/manager.ts:294-303` (`askBroker.ask(...)` + comment "Since ask() generates a new id, we need to intercept it.") | ✅ Bug confirmed in-source via the maintainer's own comment |
| `ModeState` lacks `pendingQuestions`/`pendingPermissions` | `src/renderer/store/sessionTypes.ts:19-28` (only `status`, `messages`, `streaming*`, `toolCards`, `tasks`, `error`) | ✅ Missing fields confirmed |
| Tool registry contains the helper tools named in `<specific_tools>` | `src/main/tools/` dir: `fs.ts, shell.ts, jobs.ts, env.ts, web.ts, mcp.ts, tasks.ts` etc. | ✅ Files present |
| Frontend has no `QuestionFormView` / `PermissionBanner` / `pickPreviewTarget` | `src/renderer/components/` listing contains neither; `src/renderer/lib/` has no `pickPreviewTarget` | ✅ Absent — net-new files |

---

## 1. Backend audit (src/main)

### 1.1 `src/main/agent`
- **`loop.ts`** — agent loop streaming, thinking, tool-calling, and system-prompt assembly are complete and consistent. Tools execute via an injected registry + per-tool `execute` wrappers; partial/abort handling exists.
- **`prompts/base.ts`** — system prompt **prose is solid**, but `toolsSection(ctx)` (`:116-140`) only lists tool *conventions*, not the actual tool roster. Several registered tools (`file_read_image`, `file_read_pdf`, `file_move`, `file_copy`, `file_delete`, `file_search`, `glob_match`, `shell_exec_bg` + `shell_job_*`, `env_get`/`env_set`, `web_search`, `mcp_call`/`mcp_list`, `task_get`/`task_list`/`task_stop`) are **undocumented** to the model. → P0-SP gap (§7.1).
- **`prompts/index.ts`** — `COWORK_ARTIFACTS` (`:28-34`) tells the agent to deliver files but never mentions that the UI **auto-opens a preview** — so the agent sometimes leaves the user wondering why a panel popped open. → P0-SP gap (§7.3).
- **`subagents.ts`** — `SubagentManager` itself is well-built (queue, concurrency 4 at `:44`), and the `subagentTools` registry (`:153-278`) is fully wired — but there is **no `setRunner`** and the live runner was never injected. The `<subagents>` section of the system prompt (`base.ts:182-203`) therefore promises capability the runtime does not deliver → P0-6 (§5).

### 1.2 `src/main/tools`
- All tool groups verified present: `ask`, `browser`, `computer`, `env`, `fs` (incl. `file_read_image`/`file_read_pdf`, `file_move`/`copy`/`delete`, `file_search`, `glob_match`), `jobs` (`shell_exec_bg` + `shell_job_*`), `mcp` (`mcp_call`/`mcp_list`), `memory`, `paths`, `permissions`, `plugins`, `process`, `registry`, `schedule`, `screenshot`, `shell`, `system`, `tasks`, `web`.
- **`ask.ts`** — `AskBroker` is a clean single-resolution broker with abort racing (`:144-150`). **Missing**: a `registerPending(requestId, payload)` so a caller can pre-allocate the id before emitting the event. Without it the permission flow cannot match its emitted id to the awaited promise → P0 bug (§3.3).
- Tool **execution wrappers** (`registry.execute`) produce `display.images[]`, `display.files[]`, etc., but **no downstream consumer** renders `images` in-app (frontend drops them) → P0-3a/b (§4.1-4.2).

### 1.3 `src/main/providers`
- Registry + adapters + streaming + thinking support all verified complete.
- No gaps; the provider layer was the most mature area audited.

### 1.4 `src/main/session` + `src/main/ipc`
- **State machine** in `session/manager.ts` is complete (init, running, idle, error, cancelled) and emits the full `AgentEvent` union (tool_start/tool_end/tool_update, agent_status, question, permission_request, session_status, message deltas).
- **IPC channels** in `ipc/index.ts` are complete: `sessions:reply` (`:289`) routes to `AskBroker.resolve(requestId, …)`.
- **Bug**: the executor wrapper (`manager.ts:264-323`) emits `permission_request` with the UI-facing `requestId`, then awaits `askBroker.ask(...)` which generates a **different** id. The comment at `:303` literally documents the bug ("Since ask() generates a new id, we need to intercept it") but the intercept is not implemented → P0-2 root cause (§3.3).

### 1.5 Other main modules
`store`, `mcp`, `skills`, `schedule`, `computer`, `browser`, `memory`, `plugins`, `net` — all audited. No P0 gaps; a few P1/P2 items (live `task_update` events, reattach-after-refresh `runId`) recorded as out of scope for this plan.

---

## 2. Frontend audit (src/renderer + preload + shared)

### 2.1 `src/shared`
- **`types.ts`** — `AgentEvent` union already includes `question` (`:343-351`) and `permission_request` (`:334-342`) with all fields; `ContentBlock` includes `ImageBlock` (`:140-145`) and `ToolResultBlock` (`:159-164`). **Backend is complete; the frontend is the one that drops these.**
- **`defaults.ts`** — no `autoOpenPreviews` default. Nothing else missing for P0.
- `AppSettings.general` needs `autoOpenPreviews: boolean` added (§1.4).

### 2.2 `src/renderer/store`
- **`sessionTypes.ts:19-28`** — `ModeState` has **neither `pendingQuestions` nor `pendingPermissions`**. Both must be added.
- **`sessionReducer.ts:161-164`** — the two events fall through a single no-op `case` block and are **silently discarded**. This is the proximate cause of P0-1 and P0-2: the backend emits the events, the reducer drops them, the UI never renders a question or a permission prompt. → Fix in §2.1-2.2 of the plan.
- **`session.ts`** — has no `resolveQuestion` / `resolvePermission` methods (the localhost store surface). Must be added.
- Terminal-status cleanup is missing: when `session_status` flips to `idle`/`error`/`cancelled` pending arrays must be cleared (current code never does).

### 2.3 `src/renderer/components`
- **`Message.tsx`**:
  - `:115-128` renders **pure `tool_result` user messages as an empty bubble** — looks broken. Fix → compact inline representation (§4.1).
  - Does not render `image` blocks at all → screenshots returned to context are invisible. Fix → `<img>` (§4.1).
  - Does not surface `pendingQuestions` → backend `ask_user_question` is dropped on the floor from the user's perspective. Fix → inline `QuestionFormView` (§2.3).
- **`ChatView.tsx`** — does not thread the pending arrays into `Message`.
- **`ToolCard.tsx`**:
  - Does not render `result.images` thumbnails → screenshot tool output never visible inside the card. Fix → thumbnail grid (§4.2).
  - Does not render the inline permission banner → manual-permission-mode has no UI affordance. Fix → `PermissionBanner` (§3.1).
- **`Settings.tsx`** — no toggle for `autoOpenPreviews`. Fix → §4.3.
- **`App.tsx`** `onEvent`:
  - No `tool_end` hook to auto-open `PreviewPanel` for deliverable tools → user must manually click. Fix → §4.3.
  - No `onAnswer`/`onPermission` handler wiring.

### 2.4 `src/preload`
- `preload/index.ts` exposes the full `sessions.reply`/`cancel`/etc. bridge; no gap. The frontend simply never calls `reply` for questions because it never renders them.

### 2.5 Net new frontend files needed
1. `src/renderer/components/QuestionFormView.tsx` — inline question form (radio/checkbox cards + optional free text + skip path).
2. `src/renderer/components/PermissionBanner.tsx` — inline Allow/Deny banner.
3. `src/renderer/lib/pickPreviewTarget.ts` — pure preview-target router (unit-testable).

---

## 3. P0 gap summary (the six the user selected)

| # | Gap | Layer | Plan ref |
|---|---|---|---|
| P0-1 | `ask_user_question` events dropped by reducer → no inline question UI | frontend | §2 |
| P0-2 | `permission_request` events dropped + backend id mismatch (`ask()` regenerates id) → no inline permission UI + reply never resolves | frontend **and** backend bug | §3 |
| P0-3a | Images returned by tools not rendered in `ToolCard` | frontend | §4.2 |
| P0-3b | `image`/`tool_result` content blocks not rendered in `Message` | frontend | §4.1 |
| P0-3c | `PreviewPanel` never auto-opens after a deliverable tool ends | frontend (App.tsx onEvent) | §4.3 |
| P0-6 | `SubagentManager` runs the stub "(subagent not yet wired)" → `<subagents>` system prompt section is a lie | backend | §5 |

System-prompt gaps (D5): missing `<specific_tools>` roster (§7.1) + missing "mention the path / preview auto-opens" hint in `COWORK_ARTIFACTS` (§7.3).

---

## 4. Root-cause analysis

The pattern across **five of the six** P0 gaps is the same: **the backend emits events / returns content blocks for which the frontend has no consumer**. The shared `types.ts` contract is honored by main but partially honored by the renderer. The most consequential instance is the reducer's no-op `case "permission_request": case "question":` (`sessionReducer.ts:161-164`) — it is the single point that turns complete backend behavior into a user-invisible gap.

The sixth gap (P0-6) is purely backend: a stub was committed with a deferred wiring TODO and never finished, leaving a system-prompt promise unfulfilled.

P0-2 is the only gap that is **both** a frontend gap (no UI) **and** a genuine backend bug (the requestId mismatch at `manager.ts:294-303`) — it cannot be fixed frontend-only.

---

## 5. Decisions captured (from plan §0)

D1 inline question/permission (no modal) · D2 Stop = `fail('Cancelled')` to the model · D3 activate subagents fire-and-forget · D4 preview on three layers (ToolCard images, Message blocks, auto-open panel) · D5 system prompt add `<specific_tools>` + keep `<subagents>` · D6 two separate reducer fields · D7 subagents reuse `runAgentLoop` with no new event types · D8 auto-open whitelist of 8 tool names gated by `autoOpenPreviews`.

---

## 6. Out of scope (deferred to P1/P2 — per plan §11)

- Live `task_update` events (P1; `sessions:tasks` polling works today).
- `runId` / idempotent event IDs / reattach-after-refresh (P1).
- RTL / i18n / `dir="rtl"` wiring (P1).
- Pinned-todo slot above composer (P1).
- ToolCard categories / shimmer-text / auto-collapse (P1).
- State-coverage adaptive thresholds (P1).
- File-upload question forms (P2).
- Critique Theater / dual-track UI/CLI / anti-AI-slop linter (P2).

---

## 7. Validation plan (per plan §9)

1. `npm run typecheck` → zero errors (main + renderer).
2. `npm run test` (node:test, no DOM) → new files: `session-reducer.test.ts`, `ask-broker.test.ts`, `subagent-wiring.test.ts`, `pickPreviewTarget.test.ts`.
3. `npm run test:component` (vitest + jsdom) → new/extended: `QuestionFormView.test.tsx`, `PermissionBanner.test.tsx`, `Message.render.test.tsx`, `ToolCard.render.test.tsx`.
4. `npm run test:capabilities` → registry still lists `agent_run`/`agent_status`/`agent_list`, `ask_user_question`, `task_*`.
5. Manual smoke (§9.5): clarifying-question flow, manual-permission write + auto-preview, screenshot thumbnails, parallel subagent runs, Stop-while-pending cleanup.

---

## 8. Execution order (single session, per plan §12)

1. Types + defaults (§1) → typecheck baseline.
2. Backend: `AskBroker.registerPending`, `manager.ts` permission fix, `subagents.ts setRunner`, `subagentRunner.ts`, `index.ts` wiring (§3.3, §5).
3. System prompt edits (§7).
4. Frontend reducer + store methods (§2.1-2.2).
5. New components `QuestionFormView` + `PermissionBanner` (§2.3, §3.1).
6. `Message.tsx` + `ToolCard.tsx` + `ChatView.tsx` (§2.4, §3.2, §4.1, §4.2).
7. `App.tsx` onEvent auto-open + pending wiring (§2.5, §4.3).
8. `Settings.tsx` toggle (§4.3).
9. Tests new/update (§9.2-9.4).
10. `npm run typecheck && npm run test && npm run test:capabilities` → green.
11. Manual smoke (§9.5).

---

## 9. File change surface (per plan §10)

**Backend (8 files, 1 new):** `agent/subagents.ts` (add `setRunner`), `agent/subagentRunner.ts` (**NEW**), `index.ts` (wire runner), `tools/ask.ts` (add `registerPending`), `session/manager.ts` (use `registerPending`), `agent/prompts/base.ts` (`<specific_tools>`), `agent/prompts/index.ts` (`COWORK_ARTIFACTS` sentence), `shared/types.ts` (+`autoOpenPreviews`), `shared/defaults.ts` (default `true`).

**Frontend (10 files, 3 new):** `store/sessionTypes.ts`, `store/sessionReducer.ts`, `store/session.ts`, `components/QuestionFormView.tsx` (**NEW**), `components/PermissionBanner.tsx` (**NEW**), `lib/pickPreviewTarget.ts` (**NEW**), `components/Message.tsx`, `components/ToolCard.tsx`, `components/ChatView.tsx`, `components/Settings.tsx`, `App.tsx`.

**Tests (5 new):** `tests/unit/{session-reducer,ask-broker,subagent-wiring,pickPreviewTarget}.test.ts`, `tests/unit/{message-render,question-form}.test.tsx`.

---

## 10. Conclusion

The audit confirms the plan's premise: the **backend is feature-complete** for all six P0 items, and the gaps are concentrated in the **renderer's reducer and component layer** (which silently drop backend events and content blocks) plus **one real backend bug** in the permission requestId flow and **one unfinished backend stub** (subagent runner). The plan's single-pass change set is actionable as written; every line/behavioral claim has been re-verified against the live source at audit time. Recommended next step: execute plan §12 in one fresh implementation session.
