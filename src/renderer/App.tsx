/**
 * Application shell.
 *
 * Owns layout plus the state that is genuinely global: mode, navigation,
 * settings, and the catalogues Settings needs. Everything a control does goes
 * through `bridge()` to the main process — there are deliberately no local-only
 * handlers here, because the previous revision shipped placeholder callbacks
 * and the whole UI was inert as a result.
 *
 * Cowork and Code state lives in the session store keyed by mode, so switching
 * tabs is a view change and never interrupts a running turn.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderOpen, X } from "lucide-react";

import type {
  ApiKeyEntry,
  AppSettings,
  McpServerConfig,
  Mode,
  ModelInfo,
  ModelSelection,
  PermissionMode,
  Plugin,
  Project,
  ProviderPreset,
  ScheduledTask,
  Session,
  Skill,
} from "@shared/types.ts";
import { bridge } from "./bridge.ts";
import type { AddMenuKind } from "./components/AddMenu.tsx";
import type { PreviewTarget } from "./components/PreviewPanel.tsx";
import type { NavKey } from "./components/Sidebar.tsx";
import type { ScheduleDialogPrefill } from "./components/ScheduleDialog.tsx";
import type { PaletteCommand } from "./components/CommandPalette.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { HomeView } from "./components/HomeView.tsx";
import { CodeHome } from "./components/CodeHome.tsx";
import { ComposerBar } from "./components/ComposerBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { PreviewPanel } from "./components/PreviewPanel.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { CustomizePage } from "./pages/CustomizePage.tsx";
import type { CustomizeTab } from "./pages/CustomizePage.tsx";
import { FirstRun } from "./components/FirstRun.tsx";
import { PermissionPicker, COWORK_OPTIONS } from "./components/PermissionPicker.tsx";
import { Scheduled } from "./pages/Scheduled.tsx";
import { Projects } from "./pages/Projects.tsx";
import { ToastRegion } from "./components/Toast.tsx";
import { ScheduleDialog } from "./components/ScheduleDialog.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { TranscriptSkeleton } from "./components/TranscriptSkeleton.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.ts";
import { useSessionStore } from "./store/session.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useDir } from "./hooks/useDir.ts";
import { useToasts } from "./hooks/useToasts.ts";
import { shouldAutoOpen, pickPreviewTarget, shouldOpenBrowserPreview } from "./lib/pickPreviewTarget.ts";
import "./i18n/index.ts"; // initialize i18n
import styles from "./App.module.css";

function resolveSavedSelection(
  selection: ModelSelection,
  keys: Record<string, ApiKeyEntry[]>,
  modelsByProvider: Record<string, ModelInfo[]>,
  presets: ProviderPreset[],
): ModelSelection | null {
  const preferredProvider = selection.providerId && (keys[selection.providerId] ?? []).length > 0
    ? selection.providerId
    : Object.keys(keys).find((providerId) => (keys[providerId] ?? []).length > 0) ?? "";
  if (!preferredProvider) return null;

  const providerKeys = keys[preferredProvider] ?? [];
  const keyId = providerKeys.some((key) => key.id === selection.keyId)
    ? selection.keyId
    : providerKeys[0]?.id ?? null;
  const providerModels = modelsByProvider[preferredProvider] ?? [];
  const preset = presets.find((item) => item.id === preferredProvider);
  const modelId = providerModels.some((model) => model.id === selection.modelId)
    ? selection.modelId
    : providerModels[0]?.id ?? preset?.staticModels?.[0] ?? "";

  if (!keyId || !modelId) return null;
  return { providerId: preferredProvider, keyId, modelId };
}

export function App() {
  const [mode, setMode] = useState<Mode>("cowork");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [nav, setNav] = useState<NavKey>("new");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<"settings" | "customize">("settings");
  const [customizeInitialTab, setCustomizeInitialTab] = useState<CustomizeTab>("mcp");
  const [skippedSetup, setSkippedSetup] = useState(false);
  const [bootstrapReady, setBootstrapReady] = useState(false);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [keys, setKeys] = useState<Record<string, ApiKeyEntry[]>>({});
  // Keep model discovery callbacks stable while still seeing the latest key
  // catalogue. Recreating reloadModels whenever keys changes can retrigger the
  // bootstrap effect indefinitely because reloadPresets also reloads keys.
  const keysRef = useRef<Record<string, ApiKeyEntry[]>>({});
  keysRef.current = keys;
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelInfo[]>>({});
  const [skills, setSkills] = useState<Skill[]>([]);
  const [connectors, setConnectors] = useState<McpServerConfig[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledTask[]>([]);
  const [recents, setRecents] = useState<Array<{ id: string; title: string }>>([]);
  const [rules, setRules] = useState("");

  // Code-mode folders (starts from settings.general.defaultFolders.code)
  const [codeFolders, setCodeFolders] = useState<string[]>([]);

  // Files attached by the user for context tracking in RightPanel
  const [sharedFiles, setSharedFiles] = useState<string[]>([]);

  // Edit-back draft is isolated per mode and is consumed by that mode's Composer.
  const [composerDraft, setComposerDraft] = useState<Record<Mode, string | null>>({
    cowork: null,
    code: null,
  });

  // Preview panel target (file / url / project / computer / mcp)
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // React state updates are asynchronous. Keep a synchronous identity for
  // event callbacks and async hydration so an old session cannot bleed into a
  // newly selected one during the render gap.
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;
  const inFlightSend = useRef<Record<Mode, string | null>>({ cowork: null, code: null });
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  // TranscriptSkeleton shows while the active session's history is loading.
  const [loadingSession, setLoadingSession] = useState(false);

  // Errors from bootstrap/settings/actions belong in the active transcript, not
  // in a blocking toast or popup. Agent errors are also rendered from
  // modeState.error by ChatView.
  const [inlineErrors, setInlineErrors] = useState<Record<Mode, string | null>>({
    cowork: null,
    code: null,
  });

  // Command palette open state (Cmd+K).
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Dialog open state
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [schedulePrefill, setSchedulePrefill] = useState<ScheduleDialogPrefill | undefined>(
    undefined,
  );
  const [scheduleEditId, setScheduleEditId] = useState<string | undefined>(undefined);
  const [scheduleEditInitial, setScheduleEditInitial] = useState<ScheduledTask | undefined>(undefined);

  // Compatibility shim: existing action handlers call setBanner. Keep that
  // API, but render errors inline in the current chat instead of opening a
  // toast/popup that interrupts the task.
  function setBanner(msg: string | null) {
    setInlineErrors((prev) => ({ ...prev, [mode]: msg }));
  }

  const modeState = useSessionStore((s) => s[mode]);
  const applyEvent = useSessionStore((s) => s.applyEvent);
  const addUserMessage = useSessionStore((s) => s.addUserMessage);
  const clearMode = useSessionStore((s) => s.clearMode);
  const setSessionIdentity = useSessionStore((s) => s.setSessionIdentity);
  const setSessionMessages = useSessionStore((s) => s.setSessionMessages);

  // Sessions are per-mode; remember which one each tab was last on so switching
  // back returns you to your place instead of a blank screen.
  const lastSession = useRef<Record<Mode, string | null>>({ cowork: null, code: null });

  useTheme(settings);
  useDir(settings?.general.language);

  // Load transcript whenever activeSessionId changes
  useEffect(() => {
    // Establish the identity before any async IPC call or replay can complete.
    // This also clears the previous transcript immediately when switching to a
    // different session, instead of briefly rendering the old conversation.
    setSessionIdentity(mode, activeSessionId);
    if (!activeSessionId) {
      clearMode(mode);
      setLoadingSession(false);
      return;
    }
    let cancelled = false;
    setLoadingSession(true);
    void (async () => {
      try {
        const msgs = await bridge().sessions.messages(activeSessionId);
        if (cancelled || activeSessionIdRef.current !== activeSessionId) return;
        // Always replace the slice, including with an empty array. Otherwise a
        // newly opened empty session inherits the previous transcript.
        setSessionMessages(mode, msgs, activeSessionId);

        // INT-3: reattach to any in-flight run for this session and replay its
        // persisted events through applyEvent so a refresh-interrupted turn is
        // reconstructed in the UI. Also re-hydrate the task list from the
        // backend so the RightPanel doesn't show a stale "no tasks" state.
        try {
          const replay = await bridge().sessions.reattach(activeSessionId);
          if (!cancelled && activeSessionIdRef.current === activeSessionId) {
            for (const ev of replay.events) {
              if (ev.sessionId === activeSessionId) applyEvent(ev);
            }
          }
        } catch {
          /* reattach best-effort — sessions may have no persisted runs */
        }

        try {
          const tasks = await bridge().sessions.tasks(activeSessionId);
          if (!cancelled && activeSessionIdRef.current === activeSessionId) {
            applyEvent({
              type: "task_update",
              mode,
              sessionId: activeSessionId,
              tasks,
            });
          }
        } catch {
          /* tasks best-effort */
        }
      } catch {
        /* keep optimistic messages */
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, mode, clearMode, setSessionIdentity, setSessionMessages, applyEvent]);

  /* ------------------------------------------------------------ loading -- */

  const reloadKeys = useCallback(async (list: ProviderPreset[]) => {
    const next: Record<string, ApiKeyEntry[]> = {};
    await Promise.all(
      list.map(async (p) => {
        try {
          next[p.id] = await bridge().providers.listKeys(p.id);
        } catch {
          next[p.id] = [];
        }
      }),
    );
    setKeys(next);
  }, []);

  const reloadModels = useCallback(async (list: ProviderPreset[]) => {
    const availableKeys = keysRef.current;
    const next: Record<string, ModelInfo[]> = {};
    await Promise.all(
      list.map(async (p) => {
        try {
          const cached = await bridge().providers.listModels(p.id);
          if (cached.length > 0 || (availableKeys[p.id] ?? []).length === 0) {
            next[p.id] = cached;
            return;
          }
          // A saved key with an empty model cache is a valid configured state,
          // not a reason to show FirstRun. Refresh once so gateways such as
          // Kilo can resolve their current catalogue after a restart.
          const refreshed = await bridge().providers.refreshModels(p.id);
          next[p.id] = refreshed.ok ? refreshed.value.models : cached;
        } catch {
          next[p.id] = [];
        }
      }),
    );
    setModelsByProvider(next);
  }, []);

  const reloadPresets = useCallback(async () => {
    const b = bridge();
    const p = await b.providers.presets();
    setPresets(p);
    await Promise.all([reloadKeys(p), reloadModels(p)]);
  }, [reloadKeys, reloadModels]);

  const reloadExtensions = useCallback(async () => {
    const b = bridge();
    const [sk, mc, pl] = await Promise.allSettled([
      b.skills.list(),
      b.mcp.list(),
      b.plugins.list(),
    ]);
    if (sk.status === "fulfilled") setSkills(sk.value);
    if (mc.status === "fulfilled") setConnectors(mc.value);
    if (pl.status === "fulfilled") setPlugins(pl.value);
  }, []);

  const reloadSessions = useCallback(async (m: Mode) => {
    try {
      const list = await bridge().sessions.list(m);
      setRecents(list.slice(0, 30).map((s) => ({ id: s.id, title: s.title || "Untitled" })));
    } catch {
      setRecents([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBootstrapReady(false);
    void (async () => {
      try {
        const b = bridge();
        const [s, p] = await Promise.all([b.settings.get(), b.providers.presets()]);
        if (cancelled) return;
        setSettings(s);
        setPresets(p);

        // Seed code folders from default setting
        if (s.general.defaultFolders.code) {
          setCodeFolders([s.general.defaultFolders.code]);
        }

        await Promise.all([reloadKeys(p), reloadModels(p)]);
        await reloadExtensions();

        // Load standing rules
        try {
          const rulesResult = await bridge().memory.getRules();
          if (rulesResult.ok) setRules(rulesResult.value);
        } catch {
          /* memory may not be available yet */
        }

        try {
          setScheduled(await b.schedule.list());
        } catch {
          /* scheduler may be disabled */
        }

        // INT-3: fetch the projects list at startup so Projects nav shows real
        // data on first render. The store may not be initialised in some test
        // environments, so swallow the error.
        try {
          setProjects(await b.projects.list());
        } catch {
          /* projects store may not be initialised */
        }
        if (!cancelled) setBootstrapReady(true);
      } catch (e) {
        // If the bridge itself is missing the app is unusable — say so loudly
        // rather than rendering a shell that silently does nothing.
        setBanner(
          `Could not reach the application backend: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKeys, reloadModels, reloadExtensions]);

  useEffect(() => {
    void reloadSessions(mode);
  }, [mode, reloadSessions]);

  /* ------------------------------------------------------- agent events -- */

  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = bridge().sessions.onEvent((e) => {
        // Events are global on the IPC channel, but the visible transcript is
        // per session. Keep background work for the other mode, while refusing
        // stale events from another session in the currently visible mode.
        const belongsToVisibleSession = e.mode === mode
          ? e.sessionId === activeSessionIdRef.current
          : e.mode === undefined
            ? e.sessionId === activeSessionIdRef.current
            : true;
        if (!belongsToVisibleSession) return;
        applyEvent(e);
        if (e.type === "session_status" && e.status !== "running") {
          inFlightSend.current[e.mode] = null;
        }
        if (e.type === "error") setBanner(e.message);

        // BP-A: live browser preview. Open on tool_start for browser_* tools
        // (gated by autoOpenBrowserPreview) so the user watches the agent
        // navigate/click/type live. We only open if no preview is already
        // open, OR the existing one is also a browser preview (the live view
        // singletons — a second browser tool replaces, not stacks).
        if (
          e.type === "tool_start" &&
          settings?.general.autoOpenBrowserPreview &&
          shouldOpenBrowserPreview(e.name)
        ) {
          // A live browser interaction must take precedence over an earlier
          // static file preview opened by file_write. Otherwise the file card
          // captures the panel before browser_navigate starts and the user
          // never sees the internal browser surface.
          setPreviewTarget({ kind: "browser", sessionId: e.sessionId });
        }

        // P0-3c: auto-open the preview panel when a deliverable-producing
        // tool finishes successfully. Skip if a panel is already open so we
        // never fight the user; the setting autoOpenPreviews gates this so
        // it can be turned off entirely from Settings.
        if (
          e.type === "tool_end" &&
          e.result.ok &&
          settings?.general.autoOpenPreviews
        ) {
          // tool_end only carries toolUseId; resolve the tool name from the
          // active mode's toolCards map.
          const card = useSessionStore.getState()[mode].toolCards.get(e.toolUseId);
          const toolName = card?.name;
          if (toolName && shouldAutoOpen(toolName)) {
            const target = pickPreviewTarget(toolName, e.result);
            if (target) {
              setPreviewTarget((current) => {
                // Keep the live browser surface mounted for the whole active
                // turn. A later file_write or screenshot tool must not replace
                // it, because doing so unmounts BrowserPreview and detaches
                // the agent-controlled WebContentsView while browser work is
                // still in progress. Static previews can still be opened by
                // the user after closing the live browser preview.
                if (current?.kind === "browser") {
                  return current;
                }
                return current ? current : target;
              });
            }
          }
        }
      });
    } catch {
      /* reported by the loader above */
    }
    return () => off?.();
  }, [applyEvent, settings?.general.autoOpenPreviews, settings?.general.autoOpenBrowserPreview, mode]);

  // Keep a ref of the current preview target so the onEvent handler can read
  // the latest value without re-subscribing on every state change.
  const usePreviewTargetRef = useRef<PreviewTarget | null>(null);
  useEffect(() => {
    usePreviewTargetRef.current = previewTarget;
  }, [previewTarget]);

  /* -------------------------------------------------------------- state -- */

  /* -------------------------------------------------------------- state -- */

  const selection = settings?.[mode].selection;
  const hasAnyKeys = Object.values(keys).some((arr) => arr.length > 0);
  const activeProviderKeys = selection?.providerId ? (keys[selection.providerId] ?? []) : [];
  const configured = Boolean(
    selection?.providerId && selection?.modelId && activeProviderKeys.length > 0,
  );

  const inSession = activeSessionId !== null;
  // A stored key is sufficient to enter the shell; the resolver below selects a
  // provider/model before the first send. FirstRun is only for a truly empty
  // installation, never for a previously configured installation with stale or
  // partially missing selection metadata.
  const needsSetup =
    bootstrapReady && settings !== null && !hasAnyKeys && !configured && !skippedSetup;

  // Re-run model discovery after the key catalogue has arrived. The first
  // bootstrap pass intentionally runs in parallel; this follow-up handles
  // providers whose models are not cached yet without blocking the shell.
  useEffect(() => {
    if (!bootstrapReady || presets.length === 0 || !hasAnyKeys) return;
    void reloadModels(presets);
  }, [bootstrapReady, presets, hasAnyKeys, reloadModels]);

  // Resolve provider, key and model together from persisted memory. This also
  // repairs stale keyId/modelId metadata rather than leaving the UI half-ready.
  useEffect(() => {
    if (!settings || !hasAnyKeys) return;
    const resolved = resolveSavedSelection(settings[mode].selection, keys, modelsByProvider, presets);
    const current = settings[mode].selection;
    if (
      resolved &&
      (current.providerId !== resolved.providerId ||
        current.keyId !== resolved.keyId ||
        current.modelId !== resolved.modelId)
    ) {
      void patchSettings({
        [mode]: { selection: resolved },
      } as Partial<AppSettings>);
    }
  }, [settings, mode, keys, hasAnyKeys, modelsByProvider, presets]);

  async function patchSettings(patch: Partial<AppSettings>) {
    try {
      const next = await bridge().settings.set(patch);
      setSettings(next);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  /* ------------------------------------------------------------ actions -- */

  async function ensureSession(selectionOverride?: ModelSelection): Promise<string | null> {
    if (activeSessionIdRef.current) return activeSessionIdRef.current;
    const requestedSelection = selectionOverride ?? selection;
    if (!requestedSelection) {
      setBanner("Choose a provider and model before starting a task.");
      return null;
    }
    const resolvedKeyId =
      requestedSelection.keyId ?? keys[requestedSelection.providerId]?.[0]?.id ?? null;
    const resolvedSelection: ModelSelection = { ...requestedSelection, keyId: resolvedKeyId };
    const res = await bridge().sessions.create(mode, resolvedSelection);
    if (!res.ok) {
      setBanner(res.error);
      return null;
    }
    const storedSelection = settings?.[mode].selection;
    if (
      settings &&
      (!storedSelection ||
        storedSelection.providerId !== resolvedSelection.providerId ||
        storedSelection.keyId !== resolvedSelection.keyId ||
        storedSelection.modelId !== resolvedSelection.modelId)
    ) {
      void patchSettings({
        [mode]: { selection: resolvedSelection },
      } as Partial<AppSettings>);
    }
    activeSessionIdRef.current = res.value.id;
    setSessionIdentity(mode, res.value.id);
    setActiveSessionId(res.value.id);
    lastSession.current[mode] = res.value.id;
    void reloadSessions(mode);
    return res.value.id;
  }

  async function handleSubmit(text: string) {
    setBanner(null);
    setComposerDraft((prev) => ({ ...prev, [mode]: null }));
    if (inFlightSend.current[mode]) return;

    // Resolve a usable selection synchronously for this send. React state is
    // updated as well, but the current handler must not wait for a re-render
    // before creating the session (the first send after bootstrap used to fail).
    let effectiveSelection: ModelSelection | null | undefined = selection;
    if (!configured) {
      if (settings && hasAnyKeys) {
        effectiveSelection = resolveSavedSelection(settings[mode].selection, keys, modelsByProvider, presets);
        if (effectiveSelection) {
          await patchSettings({
            [mode]: { selection: effectiveSelection },
          } as Partial<AppSettings>);
        }
      }
      if (!effectiveSelection?.providerId || !effectiveSelection.modelId || !effectiveSelection.keyId || !hasAnyKeys) {
        setSkippedSetup(false);
        setBanner("Connect a provider and pick a model first.");
        return;
      }
    }

    const clientTurnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    inFlightSend.current[mode] = clientTurnId;
    const sid = await ensureSession(effectiveSelection);
    if (!sid) {
      inFlightSend.current[mode] = null;
      return;
    }

    // BUG-4 fix: attachments were dropped on the floor — the previous call
    // passed only `text` to the backend, so the agent never saw the files the
    // user had attached. We now both annotate the prompt with a
    // human-readable file list (so the model can reference them) and forward
    // the array as the third arg so the backend can register them as
    // context-tracking attachments.
    const attachedFiles = sharedFiles.length > 0 ? sharedFiles : undefined;
    let finalText = text;
    if (attachedFiles) {
      finalText = `${text}\n\n[Attached files]\n${attachedFiles.map((f) => `- ${f}`).join("\n")}`;
    }

    // Render the user's turn immediately; the backend echoes it back on reload.
    addUserMessage(mode, {
      id: `local-${clientTurnId}`,
      role: "user",
      content: [{ type: "text", text: finalText }],
      createdAt: Date.now(),
    });

    const res = await bridge().sessions.send(sid, finalText, attachedFiles, clientTurnId);
    if (res.ok) {
      // Clear attachments only after the backend accepted the send, so a
      // failed send doesn't silently throw away the user's file list.
      if (attachedFiles) setSharedFiles([]);
    } else {
      inFlightSend.current[mode] = null;
      // Keep send failures in the transcript flow; no popup interrupts the
      // conversation. The user can submit the same text again from the
      // composer after inspecting the inline error.
      setBanner(res.error);
    }
  }

  async function handleCancel() {
    if (!activeSessionId) return;
    const res = await bridge().sessions.cancel(activeSessionId);
    if (!res.ok) setBanner(res.error);
  }

  async function handleCopyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Unable to copy this message.");
    }
  }

  async function handleEditMessage(messageId: string, text: string) {
    if (!activeSessionId || inFlightSend.current[mode]) return;
    const messages = useSessionStore.getState()[mode].messages;
    const index = messages.findIndex((item) => item.id === messageId);
    if (index < 0) {
      setBanner("This message is no longer available for editing.");
      return;
    }
    const previousMessageId = index > 0 ? messages[index - 1].id : null;
    const res = await bridge().sessions.branch(activeSessionId, previousMessageId);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    const nextSession = res.value;
    await reloadSessions(mode);
    activeSessionIdRef.current = nextSession.id;
    setSessionIdentity(mode, nextSession.id);
    setActiveSessionId(nextSession.id);
    lastSession.current[mode] = nextSession.id;
    clearMode(mode);
    setComposerDraft((prev) => ({ ...prev, [mode]: text }));
    setNav("new");
  }

  async function handleRetryMessage(text: string) {
    if (inFlightSend.current[mode]) return;
    await handleSubmit(text);
  }

  /* Reply to a pending question or permission_request from the inline UI.
   * Question forms also collapse via `resolveQuestion` so the form disappears
   * immediately even though the backend keeps the answer. */
  async function handleReply(requestId: string, answer: string[]) {
    if (!activeSessionId) return;
    const res = await bridge().sessions.reply(activeSessionId, requestId, answer);
    if (!res.ok) setBanner(res.error);
  }

  function handleResolveQuestion(requestId: string) {
    if (!activeSessionId) return;
    useSessionStore.getState().resolveQuestion(mode, requestId);
  }

  /** Handles file attachment from the in-chat QuickPanel. Extension actions stay in chat. */
  async function handleAttach(kind: AddMenuKind) {
    switch (kind) {
      case "files": {
        try {
          const files = await bridge().dialog.selectFiles();
          if (!files.length) return;
          setSharedFiles((prev) => [...prev, ...files]);
          pushToast(
            "info",
            `Attached ${files.length} file${files.length > 1 ? "s" : ""}. ` +
              `Mention them in your message: ${files.slice(0, 3).join(", ")}` +
              (files.length > 3 ? ` and ${files.length - 3} more` : ""),
          );
        } catch (e) {
          setBanner(e instanceof Error ? e.message : String(e));
        }
        break;
      }
      case "connectors":
      case "skills":
      case "plugins":
        // Extension toggles and invocation are handled by QuickPanel callbacks.
        break;
    }
  }

  /**
   * Per-mode model selection. Persists immediately to settings[mode].selection
   * via settings.set and updates local state. No modal required.
   */
  async function handleSelectionChange(next: ModelSelection) {
    if (!settings) return;
    await patchSettings({
      [mode]: { selection: next },
    } as Partial<AppSettings>);
  }

  /**
   * Refresh models for a provider, update local cache, and return. A failed
   * live refresh is surfaced as a toast while the built-in static list keeps
   * the dropdown populated.
   */
  async function handleRefreshModels(providerId: string): Promise<ModelInfo[]> {
    const res = await bridge().providers.refreshModels(providerId);
    if (!res.ok) {
      setBanner(res.error);
      return [];
    }
    if (res.value.warning) {
      pushToast(
        "error",
        `Refresh failed: ${res.value.warning} — showing built-in list`,
      );
    }
    setModelsByProvider((prev) => ({ ...prev, [providerId]: res.value.models }));
    return res.value.models;
  }

  /**
   * NEW: addKey no longer takes a label — pass empty string and let the bridge
   * assign "Key N". meta carries accountId for Cloudflare, etc.
   */
  async function handleAddKey(
    providerId: string,
    rawKey: string,
    meta?: Record<string, string>,
  ) {
    const res = await bridge().providers.addKey(providerId, "", rawKey, meta);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadKeys(presets);
    // Hydrate the exact provider immediately; the presets closure may still be
    // one render behind when a custom provider was just created.
    const models = await bridge().providers.refreshModels(providerId);
    if (models.ok) {
      setModelsByProvider((prev) => ({ ...prev, [providerId]: models.value.models }));
    }
  }
  async function handleRemoveKey(keyId: string) {
    const res = await bridge().providers.removeKey(keyId);
    if (!res.ok) setBanner(res.error);
    await reloadKeys(presets);
  }

  /**
   * FirstRun: still calls addKey with a label for backward compat with the
   * component (it passes "Default" as the label — we forward to the new sig).
   */
  async function handleFirstRunKey(
    providerId: string,
    label: string,
    raw: string,
  ): Promise<string | null> {
    const res = await bridge().providers.addKey(providerId, label, raw);
    if (!res.ok) return res.error;
    await reloadKeys(presets);
    const models = await bridge().providers.refreshModels(providerId);
    if (models.ok) {
      setModelsByProvider((prev) => ({ ...prev, [providerId]: models.value.models }));
    }
    return null;
  }
  /**
   * Custom provider creation: name + base URL + protocol, optional inline API
   * key and comma/newline-separated model IDs (stored as the preset's static
   * fallback list). The addKey→refreshModels chain keeps populating the model
   * dropdown immediately after the provider exists.
   */
  async function handleAddCustomProvider(input: {
    name: string;
    baseUrl: string;
    protocol?: "openai-chat" | "openai-responses" | "anthropic-messages";
    modelIds?: string[];
    apiKey?: string;
  }): Promise<void> {
    const res = await bridge().providers.addCustom(input);
    if (!res.ok) throw new Error(res.error);
    await reloadPresets();
    if (input.apiKey && input.apiKey.trim()) {
      const models = await bridge().providers.refreshModels(res.value.id);
      if (models.ok) {
        setModelsByProvider((prev) => ({ ...prev, [res.value.id]: models.value.models }));
        if (models.value.warning) {
          pushToast("error", `Refresh failed: ${models.value.warning} — showing entered models`);
        }
      } else {
        pushToast("error", models.error);
      }
    }
    pushToast("success", `Custom provider "${input.name}" added.`);
  }

  async function handleRemoveCustomProvider(id: string) {
    const res = await bridge().providers.removeCustom(id);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadPresets();
    pushToast("success", "Provider removed.");
  }

  async function chooseModel(providerId: string, modelId: string) {
    if (!settings) return;
    const keyId = keys[providerId]?.[0]?.id ?? null;
    await patchSettings({
      [mode]: { selection: { providerId, keyId, modelId } },
    } as Partial<AppSettings>);
    setSkippedSetup(true);
  }

  async function pickWorkingFolder() {
    try {
      const dir = await bridge().dialog.selectFolder();
      if (!dir) return;
      if (!settings) return;
      // Persist as the mode's default folder
      await patchSettings({
        general: {
          ...settings.general,
          defaultFolders: {
            ...settings.general.defaultFolders,
            [mode]: dir,
          },
        },
      });
      pushToast("success", `Working folder set to ${dir}`);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Detach a mode's folder override (the × affordance). Sessions fall back to
   * the shared default workspace, which is changeable but never removable.
   */
  async function detachWorkingFolder(target: Mode) {
    if (!settings) return;
    try {
      await patchSettings({
        general: {
          ...settings.general,
          defaultFolders: {
            ...settings.general.defaultFolders,
            [target]: null,
          },
        },
      });
      if (target === "code") setCodeFolders([]);
      pushToast("info", "Detached — using the default workspace.");
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Settings.onPickWorkspaceFolder — picks the shared default workspace used
   * by both modes. Changeable from Settings; there is deliberately no clear
   * control.
   */
  async function pickDefaultWorkspace() {
    try {
      const dir = await bridge().dialog.selectFolder();
      if (!dir || !settings) return;
      await patchSettings({
        general: { ...settings.general, defaultWorkspace: dir },
      });
      pushToast("success", `Default workspace set to ${dir}`);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Settings.onPickFolder — opens the native folder picker and saves to
   * settings.general.defaultFolders[pickedMode].
   */
  async function handlePickFolder(pickedMode: Mode) {
    try {
      const dir = await bridge().dialog.selectFolder();
      if (!dir || !settings) return;
      await patchSettings({
        general: {
          ...settings.general,
          defaultFolders: {
            ...settings.general.defaultFolders,
            [pickedMode]: dir,
          },
        },
      });
      pushToast("success", `Default folder for ${pickedMode} set to ${dir}`);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * CodeHome: "Add another folder" calls selectFolder and appends to codeFolders.
   */
  async function handleAddCodeFolder() {
    try {
      const dir = await bridge().dialog.selectFolder();
      if (!dir) return;
      setCodeFolders((prev) => (prev.includes(dir) ? prev : [...prev, dir]));
      pushToast("info", `Added folder: ${dir}`);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  async function setPermissionMode(target: Mode, pm: PermissionMode) {
    if (!settings) return;
    // In a live session of that mode: update via bridge first.
    const sessionIdForMode = target === mode ? activeSessionId : null;
    if (sessionIdForMode) {
      const res = await bridge().sessions.setPermissionMode(sessionIdForMode, pm);
      if (!res.ok) {
        setBanner(res.error);
        return;
      }
    }
    // Also persist to settings for future sessions
    await patchSettings({ [target]: { ...settings[target], permissionMode: pm } });
  }

  function openSettings() {
    void reloadPresets();
    setSettingsView("settings");
    setSettingsOpen(true);
  }

  function openCustomize(tab: CustomizeTab = "mcp") {
    setCustomizeInitialTab(tab);
    setSettingsView("customize");
    setSettingsOpen(true);
  }

  async function handleExtensionInvoke(command: string) {
    const value = command.trim();
    if (!value) return;
    if (value.startsWith("/skill ")) {
      const id = value.slice("/skill ".length).trim();
      const skill = skills.find((item) => item.id === id);
      await handleSubmit(skill ? `Use the skill "${skill.name}" for this task.` : `Use the skill "${id}" for this task.`);
      return;
    }
    if (value.startsWith("/plugin ")) {
      const name = value.slice("/plugin ".length).trim();
      await handleSubmit(`Use the plugin "${name}" for this task.`);
      return;
    }
    if (value.startsWith("@")) {
      const name = value.slice(1).trim();
      await handleSubmit(`Use the MCP server "${name}" for this task.`);
    }
  }

  function handleNavKey(key: NavKey) {
    if (key === "customize") {
      openCustomize();
      return;
    }
    setNav(key);
    if (key === "new") {
      activeSessionIdRef.current = null;
      lastSession.current[mode] = null;
      setSessionIdentity(mode, null);
      setActiveSessionId(null);
      clearMode(mode);
      setPreviewTarget(null);
    }
  }

  function switchMode(m: Mode) {
    lastSession.current[mode] = activeSessionIdRef.current;
    const nextSessionId = lastSession.current[m];
    activeSessionIdRef.current = nextSessionId;
    setSessionIdentity(m, nextSessionId);
    setMode(m);
    setNav("new");
    // Restore where this tab was; the other mode keeps running regardless.
    setActiveSessionId(nextSessionId);
  }

  /* ------------------------------------------------- rules (memory) ------ */

  async function handleRulesBlur() {
    const res = await bridge().memory.setRules(rules);
    if (!res.ok) setBanner(res.error);
  }

  /* ------------------------------------------------ conversation actions - */

  async function handleConversationOpen(id: string) {
    if (id !== activeSessionIdRef.current) {
      // Establish the new identity before React renders or IPC hydration can
      // complete, so an event for the prior session is rejected at the store.
      activeSessionIdRef.current = id;
      setSessionIdentity(mode, id);
      setPreviewTarget(null);
    } else {
      activeSessionIdRef.current = id;
    }
    setActiveSessionId(id);
    lastSession.current[mode] = id;
    setNav("new");
  }

  async function handleConversationRename(id: string, title: string) {
    const res = await bridge().sessions.rename(id, title);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadSessions(mode);
    pushToast("success", "Session renamed.");
  }

  async function handleConversationBranch(id: string) {
    const res = await bridge().sessions.branch(id);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    const newSession: Session = res.value;
    await reloadSessions(mode);
    // Open the new branched session. Establish the identity synchronously so
    // live events cannot land in the previous session during IPC hydration.
    activeSessionIdRef.current = newSession.id;
    lastSession.current[mode] = newSession.id;
    setSessionIdentity(mode, newSession.id);
    setActiveSessionId(newSession.id);
    // Clear message store for this mode so it reloads
    clearMode(mode);
    setNav("new");
    pushToast("success", "Session branched.");
  }

  async function handleConversationArchive(id: string) {
    const res = await bridge().sessions.archive(id);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadSessions(mode);
    if (activeSessionIdRef.current === id) {
      activeSessionIdRef.current = null;
      lastSession.current[mode] = null;
      setSessionIdentity(mode, null);
      setActiveSessionId(null);
      clearMode(mode);
      setPreviewTarget(null);
    } else if (lastSession.current[mode] === id) {
      lastSession.current[mode] = null;
    }
    pushToast("success", "Session archived.");
  }

  async function handleConversationDelete(id: string) {
    const res = await bridge().sessions.delete(id);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadSessions(mode);
    if (activeSessionIdRef.current === id) {
      activeSessionIdRef.current = null;
      lastSession.current[mode] = null;
      setSessionIdentity(mode, null);
      setActiveSessionId(null);
      clearMode(mode);
      setPreviewTarget(null);
    } else if (lastSession.current[mode] === id) {
      lastSession.current[mode] = null;
    }
    pushToast("success", "Session deleted.");
  }

  /* ------------------------------------------------------------- render -- */

  // Context metadata is derived from the current run, preserving first-use order.
  // Tool cards are keyed by event id, so deduplicate repeated calls by tool name.
  const toolsUsed = Array.from(
    new Set(Array.from(modeState.toolCards.values()).map((toolCard) => toolCard.name)),
  );

  // Build the set of currently-running session ids for the sidebar's running
  // indicator. We only know about the active mode's loop directly; the other
  // mode may also be running, but we don't poll its state from here.
  const runningSessionIds = useMemo<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    if (modeState.status === "running" && activeSessionId) {
      s.add(activeSessionId);
    }
    return s;
  }, [modeState.status, activeSessionId]);

  // Current session's working folder (or mode default, or shared workspace)
  const folderOverride = settings?.general.defaultFolders[mode] ?? null;
  const sharedWorkspace = settings?.general.defaultWorkspace ?? null;
  const sessionWorkingFolder = folderOverride ?? sharedWorkspace;

  // Only surface skills enabled for the active mode. The skills subsystem may
  // auto-invoke them, so the renderer does not invent per-skill events.
  const skillsUsed = skills
    .filter((skill) => skill.enabled && skill.modes.includes(mode))
    .map((skill) => skill.name);

  // MCP usage is observable from the namespaced tool names emitted by the
  // registry: mcp__<serverName>__<toolName>.
  const usedMcpServers = connectors.filter(
    (server) =>
      server.enabled &&
      toolsUsed.some((toolName) => toolName.startsWith(`mcp__${server.name}__`)),
  );

  // A project is shown only when its real folder matches this session's
  // working folder; a default folder alone is not presented as a project.
  const activeProject = projects.find(
    (project) =>
      !project.archived &&
      project.mode === mode &&
      project.folder !== null &&
      project.folder === sessionWorkingFolder,
  );

  // Per-mode selection (with fallback to avoid null)
  const currentSelection: ModelSelection = selection ?? {
    providerId: "",
    keyId: null,
    modelId: "",
  };

  // Command palette: build the command list once per render. Memoizing would
  // require stable callback identities; the list is small enough that this is
  // not a concern.
  const paletteCommands: PaletteCommand[] = [
    { id: "nav.new", label: "New session", hint: "⌘N", group: "Navigation", run: () => handleNavKey("new") },
    { id: "nav.projects", label: "Open Projects", group: "Navigation", run: () => handleNavKey("projects") },
    { id: "nav.scheduled", label: "Open Scheduled tasks", group: "Navigation", run: () => handleNavKey("scheduled") },
    { id: "nav.customize", label: "Customize (Skills)", group: "Navigation", run: () => handleNavKey("customize") },
    { id: "app.settings", label: "Open Settings", hint: "⌘,", group: "App", run: () => openSettings() },
    {
      id: "app.toggleSidebar",
      label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
      hint: "⌘B",
      group: "App",
      run: () => setSidebarOpen((v) => !v),
    },
    {
      id: "mode.cowork",
      label: "Switch to Cowork mode",
      group: "Mode",
      run: () => switchMode("cowork"),
    },
    {
      id: "mode.code",
      label: "Switch to Code mode",
      group: "Mode",
      run: () => switchMode("code"),
    },
  ];

  useKeyboardShortcuts({
    onOpenPalette: () => setPaletteOpen(true),
    onNewSession: () => handleNavKey("new"),
    onToggleSidebar: () => setSidebarOpen((v) => !v),
    onOpenSettings: () => openSettings(),
    onCloseOverlay: () => {
      // Close whatever happens to be open — palette first, then dialogs.
      setPaletteOpen((v) => {
        if (v) return false;
        return v;
      });
      if (scheduleDialogOpen) {
        setScheduleDialogOpen(false);
        return;
      }
      if (settingsOpen) setSettingsOpen(false);
    },
  });

  // Permission pickers — BOTH modes now expose one in the composer slot.
  // Code keeps its four-mode picker; Cowork gets its own two-posture picker
  // (Auto approve / Ask for dangerous actions).
  const codePermissionPicker = settings ? (
    <PermissionPicker
      value={settings.code.permissionMode}
      onChange={(pm) => void setPermissionMode("code", pm)}
    />
  ) : undefined;

  const coworkPermissionPicker = settings ? (
    <PermissionPicker
      value={settings.cowork.permissionMode}
      onChange={(pm) => void setPermissionMode("cowork", pm)}
      options={COWORK_OPTIONS}
    />
  ) : undefined;

  // Cowork project slot: a split control — the main button opens the folder
  // picker, and an × detaches the override back to the default workspace.
  const coworkFolderOverride = settings?.general.defaultFolders?.cowork ?? null;
  const defaultWorkspace = sharedWorkspace;
  const workspaceBasename = (p: string | null | undefined): string =>
    p ? p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p : "";
  const projectSlotLabel = coworkFolderOverride
    ? coworkFolderOverride
    : defaultWorkspace
      ? `Default workspace (${workspaceBasename(defaultWorkspace)})`
      : "Choose project";

  const coworkProjectSlot = mode === "cowork" ? (
    <>
      <button
        type="button"
        onClick={() => void pickWorkingFolder()}
        aria-label="Choose project folder"
        title={coworkFolderOverride ?? defaultWorkspace ?? "Choose project"}
      >
        <FolderOpen size={14} aria-hidden="true" />
        <span className="kz-truncate">{projectSlotLabel}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {coworkFolderOverride && (
        <button
          type="button"
          className="kz-slot-detach"
          onClick={() => void detachWorkingFolder("cowork")}
          aria-label="Detach — use default workspace"
          title="Detach — use default workspace"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </>
  ) : undefined;

  // ComposerBar remains shared, but Cowork receives only visual/slot props.
  const openFilePreview = useCallback((path: string) => {
    // HTML files use the hardened loopback/live Chromium preview so relative
    // assets and safe interactions render like the user's browser.
    setPreviewTarget({ kind: "file", path });
  }, []);

  const composerBarShared = (
    <ComposerBar
      busy={modeState.status === "running" || modeState.streamingMessageId !== null}
      onSend={(t) => void handleSubmit(t)}
      onCancel={() => void handleCancel()}
      onAttach={(kind) => void handleAttach(kind)}
      selection={currentSelection}
      presets={presets}
      keysByProvider={keys}
      modelsByProvider={modelsByProvider}
      onSelectionChange={(next) => void handleSelectionChange(next)}
      onRefreshModels={(pid) => handleRefreshModels(pid)}
      permissionSlot={mode === "code" ? codePermissionPicker : coworkPermissionPicker}
      projectSlot={coworkProjectSlot}
      skills={skills}
      connectors={connectors}
      plugins={plugins}
      onToggleSkill={(id, enabled) => void toggle(() => bridge().skills.setEnabled(id, enabled))}
      onToggleConnector={(id, enabled) => void toggle(() => bridge().mcp.setEnabled(id, enabled))}
      onTogglePlugin={(id, enabled) => void toggle(() => bridge().plugins.setEnabled(id, enabled))}
      onInvokeExtension={(command) => void handleExtensionInvoke(command)}
      placeholder={mode === "cowork" ? "Give Kozum a followup..." : undefined}
    />
  );

  return (
    <div className={`${styles.app} ${mode === "cowork" ? "kz-cowork-shell" : "kz-code-shell"}`}>
      <TitleBar
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        sidebarOpen={sidebarOpen}
      />

      <ToastRegion toasts={toasts} onDismiss={dismissToast} />

      <div
        className={`${styles.body} ${mode === "cowork" ? styles.coworkBody : styles.codeBody} ${previewTarget ? styles.previewFocused : ""}`}
      >
        {sidebarOpen && (
          <Sidebar
            mode={mode}
            onModeChange={switchMode}
            active={nav}
            onNavigate={handleNavKey}
            recents={recents}
            accountLabel={settings?.general.userName || "You"}
            providerLabel={selection?.providerId || "No provider"}
            onAccountClick={openSettings}
            onSelectRecent={(id) => void handleConversationOpen(id)}
            conversationCallbacks={{
              onOpen: (id) => void handleConversationOpen(id),
              onRename: (id, title) => void handleConversationRename(id, title),
              onBranch: (id) => void handleConversationBranch(id),
              onArchive: (id) => void handleConversationArchive(id),
              onDelete: (id) => void handleConversationDelete(id),
            }}
            activeSessionId={activeSessionId}
            runningSessionIds={runningSessionIds}
          />
        )}

        <main className={styles.content}>
          {!inSession && inlineErrors[mode] && (
            <div className={styles.banner} role="alert" aria-live="assertive">
              <span>{inlineErrors[mode]}</span>
            </div>
          )}
          {nav === "new" &&
            (needsSetup ? (
              <FirstRun
                presets={presets}
                onSubmit={handleFirstRunKey}
                onRefreshModels={async (pid) => {
                  const res = await bridge().providers.refreshModels(pid);
                  if (!res.ok) throw new Error(res.error);
                  if (res.value.warning) {
                    pushToast("error", `Refresh failed: ${res.value.warning} — showing built-in list`);
                  }
                  return res.value.models;
                }}
                onChooseModel={(p, m) => void chooseModel(p, m)}
                onSkip={() => setSkippedSetup(true)}
              />
            ) : inSession ? (
              <div className={styles.sessionWrap}>
                <ErrorBoundary label="chat view">
                  {loadingSession ? (
                    <TranscriptSkeleton rows={4} />
                  ) : (
                    <ChatView
                      mode={mode}
                      sessionId={activeSessionId!}
                      inlineError={inlineErrors[mode]}
                      onSend={(t) => void handleSubmit(t)}
                      onCancel={() => void handleCancel()}
                      onAttach={(kind) => void handleAttach(kind)}
                      selection={currentSelection}
                      presets={presets}
                      keysByProvider={keys}
                      modelsByProvider={modelsByProvider}
                      onSelectionChange={(next) => void handleSelectionChange(next)}
                      onRefreshModels={(pid) => handleRefreshModels(pid)}
                      permissionSlot={mode === "code" ? codePermissionPicker : coworkPermissionPicker}
                      projectSlot={coworkProjectSlot}
                      skills={skills}
                      connectors={connectors}
                      plugins={plugins}
                      onToggleSkill={(id, enabled) => void toggle(() => bridge().skills.setEnabled(id, enabled))}
                      onToggleConnector={(id, enabled) => void toggle(() => bridge().mcp.setEnabled(id, enabled))}
                      onTogglePlugin={(id, enabled) => void toggle(() => bridge().plugins.setEnabled(id, enabled))}
                      onInvokeExtension={(command) => void handleExtensionInvoke(command)}
                      onOpenFile={openFilePreview}
                      onPreview={(target) => setPreviewTarget(target)}
                      onReply={(requestId, answer) => void handleReply(requestId, answer)}
                      onResolveQuestion={(requestId) => handleResolveQuestion(requestId)}
                      onCopyMessage={(text) => void handleCopyMessage(text)}
                      onEditMessage={(messageId, text) => void handleEditMessage(messageId, text)}
                      onRetryMessage={(text) => void handleRetryMessage(text)}
                      composerDraft={composerDraft[mode]}
                    />
                  )}
                </ErrorBoundary>
              </div>
            )             : mode === "code" ? (
              <CodeHome
                userName={settings?.general.userName ?? ""}
                folders={codeFolders}
                onAddFolder={() => void handleAddCodeFolder()}
                onOpenFolder={(path) => setPreviewTarget({ kind: "project", path })}
                onRemoveFolder={(path) => {
                  // Detaching a code folders-list entry clears the override so
                  // sessions fall back to the shared default workspace.
                  if (settings?.general.defaultFolders.code === path) {
                    void detachWorkingFolder("code");
                    return;
                  }
                  setCodeFolders((prev) => prev.filter((f) => f !== path));
                }}
                defaultWorkspace={defaultWorkspace}
                composerSlot={composerBarShared}
              />
            ) : (
              <HomeView
                userName={settings?.general.userName ?? ""}
                composerSlot={composerBarShared}
                onPickFolder={() => void pickWorkingFolder()}
                folderLabel={coworkFolderOverride}
              />
            ))}

          {nav === "scheduled" && (
            <Scheduled
              tasks={scheduled}
              inlineError={inlineErrors[mode]}
              keepAwake={settings?.scheduler.keepAwake ?? true}
              onToggleKeepAwake={() => {
                if (!settings) return;
                void patchSettings({
                  scheduler: {
                    ...settings.scheduler,
                    keepAwake: !settings.scheduler.keepAwake,
                  },
                });
              }}
              onNewTask={() => openScheduleDialog()}
              onDailyBrief={() =>
                openScheduleDialog({
                  name: "Daily brief",
                  prompt:
                    "Summarise what changed since yesterday and what needs my attention today.",
                  cadenceKind: "daily",
                  hour: 8,
                  minute: 0,
                })
              }
              onWeeklyReview={() =>
                openScheduleDialog({
                  name: "Weekly review",
                  prompt: "Review this week's work and produce a short written summary.",
                  cadenceKind: "weekly",
                  hour: 17,
                  minute: 0,
                  dayOfWeek: 5,
                })
              }
              onEdit={(task) => openScheduleDialog(undefined, task)}
              onDelete={async (id) => {
                const res = await bridge().schedule.remove(id);
                if (!res.ok) setBanner(res.error);
                setScheduled(await bridge().schedule.list());
              }}
              onRunNow={async (id) => {
                const res = await bridge().schedule.runNow(id);
                if (!res.ok) setBanner(res.error);
                else setBanner(null);
                setScheduled(await bridge().schedule.list());
              }}
              onPause={async (id) => {
                const res = await bridge().schedule.update(id, { enabled: false });
                if (!res.ok) setBanner(res.error);
                else setBanner(null);
                setScheduled(await bridge().schedule.list());
              }}
              onResume={async (id) => {
                const res = await bridge().schedule.update(id, { enabled: true });
                if (!res.ok) setBanner(res.error);
                else setBanner(null);
                setScheduled(await bridge().schedule.list());
              }}
            />
          )}

          {nav === "projects" && (
            <Projects
              projects={projects}
              onNew={() => void createProject()}
              onOpen={(id) => {
                const p = projects.find((x) => x.id === id);
                if (p) pushToast("info", `Opened project ${p.name}`);
              }}
              onArchive={async (id) => {
                const res = await bridge().projects.archive(id);
                if (!res.ok) setBanner(res.error);
                setProjects(await bridge().projects.list());
              }}
              onDelete={async (id) => {
                const res = await bridge().projects.remove(id);
                if (!res.ok) setBanner(res.error);
                setProjects(await bridge().projects.list());
              }}
            />
          )}
        </main>

        {!previewTarget && (inSession || (mode === "cowork" && !needsSetup)) && (
          <RightPanel
            mode={mode}
            tasks={modeState.tasks}
            subagents={modeState.subagents}
            mcpServers={usedMcpServers}
            toolsUsed={toolsUsed}
            skillsUsed={skillsUsed}
            projectName={activeProject?.name ?? null}
            workingFolder={activeProject?.folder ?? null}
          />
        )}

        {previewTarget && (
          <PreviewPanel
            target={previewTarget}
            onClose={() => setPreviewTarget(null)}
            onRefresh={() => {
              // Force re-mount of the inner preview by toggling target
              const t = previewTarget;
              setPreviewTarget(null);
              setTimeout(() => setPreviewTarget(t), 0);
            }}
          />
        )}
      </div>

      {settingsOpen && settings && settingsView === "settings" && (
        <div className={styles.fullPageOverlay} role="region" aria-label="Settings page">
          <SettingsPage
            settings={settings}
            presets={presets}
            keys={keys}
            rules={rules}
            onRulesChange={setRules}
            onRulesBlur={() => void handleRulesBlur()}
            onSave={(patch) => void patchSettings(patch)}
            onAddKey={(pid, rawKey, meta) => void handleAddKey(pid, rawKey, meta)}
            onRemoveKey={(keyId) => void handleRemoveKey(keyId)}
            onAddCustomProvider={(input) => handleAddCustomProvider(input)}
            onRemoveCustomProvider={(id) => void handleRemoveCustomProvider(id)}
            onPickFolder={(m) => void handlePickFolder(m)}
            onPickWorkspaceFolder={() => void pickDefaultWorkspace()}
            onBack={() => setSettingsOpen(false)}
          />
        </div>
      )}

      {settingsOpen && settings && settingsView === "customize" && (
        <div className={styles.fullPageOverlay} role="region" aria-label="Customize page">
          <CustomizePage
            skills={skills}
            connectors={connectors}
            plugins={plugins}
            initialTab={customizeInitialTab}
            onToggleSkill={(id, enabled) => void toggle(() => bridge().skills.setEnabled(id, enabled))}
            onToggleConnector={(id, enabled) => void toggle(() => bridge().mcp.setEnabled(id, enabled))}
            onTogglePlugin={(id, enabled) => void toggle(() => bridge().plugins.setEnabled(id, enabled))}
            onAddSkill={async (sourcePath) => {
              const res = await bridge().skills.add(sourcePath);
              if (res.ok) await reloadExtensions();
              else pushToast("error", res.error);
              return res;
            }}
            onRemoveSkill={async (id) => {
              const res = await bridge().skills.remove(id);
              if (!res.ok) pushToast("error", res.error);
              await reloadExtensions();
            }}
            onPickSkillSource={async () => {
              try {
                const files = await bridge().dialog.selectFiles();
                return files[0] ?? null;
              } catch {
                return null;
              }
            }}
            onLoadConnectorTools={(serverId) => bridge().mcp.tools(serverId)}
            onSetConnectorToolPolicy={async (serverId, policy) => {
              const res = await bridge().mcp.setToolPolicy(serverId, policy);
              if (res.ok) await reloadExtensions();
              else pushToast("error", res.error);
              return res;
            }}
            onRemoveConnector={async (id) => {
              const res = await bridge().mcp.remove(id);
              if (!res.ok) setBanner(res.error);
              await reloadExtensions();
            }}
            onRemovePlugin={async (id) => {
              const res = await bridge().plugins.remove(id);
              if (!res.ok) setBanner(res.error);
              await reloadExtensions();
            }}
            onAddConnector={async (input) => {
              const result = await bridge().mcp.add(input);
              if (result.ok) await reloadExtensions();
              return result;
            }}
            onTestConnector={(input) => bridge().mcp.testConnection(input)}
            onInstallPlugin={async (source) => {
              const result = source.kind === "zip"
                ? await bridge().plugins.installFromZip(source.value)
                : await bridge().plugins.installFromUrl(source.value);
              if (result.ok) await reloadExtensions();
              return result;
            }}
            onPickPluginZip={async () => {
              const files = await bridge().dialog.selectFiles();
              return files[0] ?? null;
            }}
            onBack={() => setSettingsOpen(false)}
          />
        </div>
      )}

      {scheduleDialogOpen && (
        <ScheduleDialog
          prefill={schedulePrefill}
          editId={scheduleEditId}
          projects={projects}
          initialMode={scheduleEditInitial?.mode}
          initialProjectId={scheduleEditInitial?.projectId ?? null}
          initialWorkingFolder={scheduleEditInitial?.workingFolder ?? null}
          onSave={(task) => {
            setScheduleDialogOpen(false);
            void (async () => {
              setScheduled(await bridge().schedule.list());
              pushToast(
                "success",
                scheduleEditId
                  ? `Scheduled task "${task.name}" updated.`
                  : `Scheduled task "${task.name}" created.`,
              );
              setScheduleEditId(undefined);
              setScheduleEditInitial(undefined);
            })();
          }}
          onClose={() => {
            setScheduleDialogOpen(false);
            setScheduleEditId(undefined);
            setScheduleEditInitial(undefined);
          }}
        />
      )}


      <CommandPalette
        open={paletteOpen}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );

  /* ---------------------------------------------------------- helpers --- */

  async function toggle(fn: () => Promise<{ ok: boolean; error?: string }>) {
    const res = await fn();
    if (!res.ok && res.error) setBanner(res.error);
    await reloadExtensions();
  }

  async function createProject() {
    const dir = await bridge().dialog.selectFolder();
    if (!dir) return;
    const res = await bridge().projects.create({
      name: dir.split(/[\\/]/).pop() || "Project",
      folder: dir,
      mode,
    });
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    setProjects(await bridge().projects.list());
  }

  function openScheduleDialog(prefill?: ScheduleDialogPrefill, editTask?: ScheduledTask) {
    setSchedulePrefill(prefill);
    if (editTask) {
      setScheduleEditId(editTask.id);
      setScheduleEditInitial(editTask);
      setSchedulePrefill({
        name: editTask.name,
        prompt: editTask.prompt,
      });
    } else {
      setScheduleEditId(undefined);
      setScheduleEditInitial(undefined);
    }
    setScheduleDialogOpen(true);
  }
}
