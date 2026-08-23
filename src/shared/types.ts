/**
 * Kozum Cowork — shared domain model.
 *
 * Imported by main, preload and renderer alike, so it must stay free of any
 * Node or DOM imports. Everything crossing the IPC boundary is structured-clone
 * safe: plain objects, no class instances, no functions, no Dates.
 */

/* ============================================================== modes ==== */

/**
 * The two runtimes. They are fully independent: each owns its own provider,
 * API key, model, session list and agent loop, and switching between them never
 * interrupts work in progress on the other.
 */
export type Mode = "cowork" | "code";

/* ========================================================== providers ==== */

/**
 * Wire protocols we speak. Providers are grouped by protocol rather than by
 * vendor because a single adapter serves many vendors -- most of the ecosystem
 * is OpenAI-Chat-shaped, and the interesting work is in the four that are not.
 */
export type ProviderProtocol =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-responses"
  | "gemini-generative"
  | "vertex-gemini";

/** How the credential is attached to each request. */
export type AuthScheme =
  | "bearer" // Authorization: Bearer <key>
  | "x-api-key" // x-api-key: <key>            (Anthropic)
  | "query-key" // ?key=<key>                  (Gemini native)
  | "google-adc"; // short-lived OAuth token   (Vertex)

/**
 * Tri-state on purpose.
 *
 * Validated against 689 models with published modality data: a name-pattern
 * table gets 100% precision but only ~51% recall, because the multimodal
 * frontier moves faster than any shipped list. Collapsing that to a boolean
 * means silently blocking capable models — so "unknown" is a real state that
 * the agent is allowed to attempt, letting the provider's own error be the
 * authority instead of our guess.
 */
export type VisionSupport = "yes" | "no" | "unknown";

export interface ModelCapabilities {
  /** Accepts image content blocks. Gates computer use and screenshot reasoning. */
  vision: VisionSupport;
  /** Supports native tool/function calling. Without it the agent loop cannot run. */
  tools: boolean;
  /** Emits incremental deltas over SSE. */
  streaming: boolean;
  /** Exposes a separate reasoning/thinking channel. */
  reasoning: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelInfo {
  id: string;
  /** Human label; falls back to `id` when the provider gives us nothing better. */
  displayName: string;
  providerId: string;
  capabilities: ModelCapabilities;
  /** Populated from the provider's catalogue when available. */
  description?: string;
  /** Epoch ms of the refresh that produced this record. */
  fetchedAt: number;
  /** True when capabilities came from the curated table, not the provider. */
  capabilitiesInferred: boolean;
}

/**
 * A provider definition. Presets ship with the app; users may add their own,
 * and may override any field of a preset (base URL in particular, since several
 * of these vendors run regional endpoints).
 */
export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  authScheme: AuthScheme;
  /** Path appended to baseUrl for dynamic model refresh. Null = no catalogue. */
  modelsPath: string | null;
  /** Shipped fallback list, used when the provider has no models endpoint. */
  staticModels?: string[];
  docsUrl?: string;
  /** Vendor requires extra path segments interpolated from user config. */
  requiresAccountId?: boolean;
  requiresProjectId?: boolean;
  requiresRegion?: boolean;
  /** Headers always sent to this vendor (e.g. anthropic-version). */
  defaultHeaders?: Record<string, string>;
  /**
   * Per-model protocol routing for gateways that expose several wire
   * protocols under one base URL (e.g. OpenCode Zen). Keys are protocols;
   * values are model-id prefixes routed to them. A model matching no prefix
   * uses the preset's own `protocol`. Verified against vendor docs only —
   * do not add routes without one.
   */
  protocolRoutes?: Partial<Record<ProviderProtocol, string[]>>;
  notes?: string;
  builtIn: boolean;
}

/**
 * One credential. A provider may hold several; the user picks which is active,
 * per mode. Keys are never held here in plaintext -- `id` indexes into the
 * OS-encrypted secret store and the renderer only ever sees `maskedKey`.
 */
export interface ApiKeyEntry {
  id: string;
  providerId: string;
  label: string;
  /** e.g. "nvapi-…7f3c" — safe to render. */
  maskedKey: string;
  createdAt: number;
  lastUsedAt?: number;
  /** Result of the most recent connectivity probe. */
  status: "untested" | "valid" | "invalid" | "error";
  statusMessage?: string;
  /** Vendor-specific extras (Cloudflare account id, Vertex project/region…). */
  meta?: Record<string, string>;
}

/** A fully-resolved selection: which provider, which key, which model. */
export interface ModelSelection {
  providerId: string;
  keyId: string | null;
  modelId: string;
}

/* ========================================================== messages ==== */

export type Role = "user" | "assistant" | "system";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mimeType: string;
  /** base64, no data: prefix. */
  data: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: Array<TextBlock | ImageBlock>;
  isError: boolean;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  createdAt: number;
  /** Present on assistant turns once the provider reports usage. */
  usage?: TokenUsage;
  /** Which model produced this turn; sessions may span models. */
  model?: string;
  /** Set when generation ended abnormally. */
  stopReason?: StopReason;
  error?: string;
  /** Present when this message was produced by a subagent run (P1-1). */
  runId?: string;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "cancelled"
  | "error";

/**
 * Stable product-level categories for tool invocations. Drives the per-category
 * tint on `ToolCard` and the subagent progress bar. The single mapping table
 * lives in `src/renderer/lib/toolCategory.ts` so a new tool gets one place to
 * be classified (falls back to "other").
 */
export type ToolCategory =
  | "todo"
  | "write"
  | "edit"
  | "read"
  | "run"
  | "search"
  | "fetch"
  | "skill"
  | "ask"
  | "other";

/**
 * Mirror of the six open-design run-status kinds (specs/current/status.md).
 * `RunDisplayStatus` is the *derived* display state a run resolves to; the raw
 * `SubagentRun.status` and the loop's `stopReason` feed into it via
 * `src/main/agent/runStatus.ts`.
 */
export type RunDisplayStatus =
  | "not_started"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/* ============================================================= tools ==== */

/**
 * Every built-in tool is described once, here, and that description drives
 * three things at once: the JSON schema sent to the model, the parameter list
 * rendered in Settings, and the invocation card shown in the transcript.
 */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** JSON Schema draft-07 object describing `input`. */
  inputSchema: JsonSchema;
  /** Lucide icon name; every tool has one, per spec. */
  icon: string;
  group: ToolGroup;
  /** Requires an explicit confirmation before it runs. */
  dangerous?: boolean;
  /** Refuses to run unless the active model reports `vision`. */
  requiresVision?: boolean;
  /** Which modes expose this tool. */
  modes: Mode[];
}

export type ToolGroup =
  | "filesystem"
  | "shell"
  | "process"
  | "web"
  | "browser"
  | "computer"
  | "agent"
  | "task"
  | "skill"
  | "system"
  | "mcp"
  | "plugin";

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "object" | "array" | "integer";
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
}

/** Uniform tool return shape. `display` drives the transcript card. */
export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /** Images handed back to the model (screenshots, rendered pages). */
  images?: Array<{ mimeType: string; data: string }>;
  /** Structured payload for the UI card; never sent to the model. */
  display?: ToolDisplay;
  error?: string;
}

export interface ToolDisplay {
  summary: string;
  detail?: string;
  /** Renders a diff view for edit-type tools. */
  diff?: { path: string; before: string; after: string };
  /** Renders a file chip the user can click to open. */
  files?: string[];
  /** Renders stdout/stderr in a terminal block. */
  terminal?: { command: string; stdout: string; stderr: string; exitCode: number | null };
}

/* ========================================================== sessions ==== */

export type SessionStatus = "idle" | "running" | "waiting_input" | "error" | "cancelled";

export interface Session {
  id: string;
  mode: Mode;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  /** Directory the agent is scoped to, when one is chosen. */
  workingFolder: string | null;
  projectId: string | null;
  selection: ModelSelection;
  messageCount: number;
  totalUsage: TokenUsage;
  archived: boolean;
  /** Code mode: permission posture for edits and commands. */
  permissionMode: PermissionMode;
}

export type PermissionMode =
  | "bypass_permissions"
  | "plan"
  | "accept_edits"
  | "ask_permission"
  /** Cowork posture: run everything except irreversible/destructive tools. */
  | "ask_dangerous";

export interface Project {
  id: string;
  name: string;
  /** Absolute path on disk. */
  folder: string | null;
  instructions: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  mode: Mode;
  icon?: string;
}

/* ======================================================== agent events == */

/**
 * The event stream the main process pushes to the renderer during a turn.
 * Deliberately fine-grained so the UI can render partial text, live tool cards
 * and progress without polling.
 */
/**
 * Every event the loop emits carries an optional `runId` (UUID v4) so the
 * renderer can group a whole turn's events and the session store can persist a
 * sidecar of in-flight events for reattachment after a refresh. `run_start`-era
 * events (turn/tool/question/permission) get one from `runAgentLoop`; manager-
 * and task-level events may omit it where no turn is in flight. The three
 * `subagent_*` events always carry `runId` (the subagent run id).
 */
export type AgentEventPayload =
  | { type: "turn_start"; mode: Mode; sessionId: string; messageId: string; model: string; runId?: string }
  | { type: "text_delta"; mode: Mode; sessionId: string; messageId: string; delta: string; runId?: string }
  | { type: "thinking_delta"; mode: Mode; sessionId: string; messageId: string; delta: string; runId?: string }
  | { type: "tool_start"; mode: Mode; sessionId: string; toolUseId: string; name: string; input: unknown; runId?: string }
  | { type: "tool_progress"; mode: Mode; sessionId: string; toolUseId: string; note: string; runId?: string }
  | { type: "tool_end"; mode: Mode; sessionId: string; toolUseId: string; result: ToolResult; runId?: string }
  | {
      type: "permission_request";
      mode: Mode;
      sessionId: string;
      requestId: string;
      toolName: string;
      input: unknown;
      reason: string;
      runId?: string;
    }
  | {
      type: "question";
      mode: Mode;
      sessionId: string;
      requestId: string;
      question: string;
      options: Array<{ label: string; value: string }>;
      multiSelect: boolean;
      allowFreeform?: boolean;
      runId?: string;
    }
  | { type: "turn_end"; mode: Mode; sessionId: string; messageId: string; usage: TokenUsage; stopReason: StopReason; runId?: string }
  | { type: "error"; mode: Mode; sessionId: string; message: string; recoverable: boolean; runId?: string }
  | { type: "session_status"; mode: Mode; sessionId: string; status: SessionStatus; runId?: string }
  | { type: "task_update"; mode: Mode; sessionId: string; tasks: AgentTask[]; runId?: string }
  /* ── Subagent live stream (P1-1) ─────────────────────────────────────────── */
  | { type: "subagent_start"; mode: Mode; sessionId: string; parentMessageId?: string; run: SubagentRun; runId: string }
  | { type: "subagent_progress"; mode: Mode; sessionId: string; runId: string; note: string; progress?: number }
  | { type: "subagent_end"; mode: Mode; sessionId: string; runId: string; status: "completed" | "failed" | "cancelled"; result?: string; error?: string };

/** Stable identity added by the emitter for renderer-side idempotency. */
export type AgentEvent = AgentEventPayload & { eventId?: string };

/** Summary of a persisted run, returned by `sessions:listRuns` (P1-7). */
export interface RunSummary {
  runId: string;
  eventCount: number;
  lastEventAt: number;
  /** True when the run's final event was a terminal one (turn_end / subagent_end). */
  finished: boolean;
}

export interface AgentTask {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "stopped";
  createdAt: number;
  updatedAt: number;
}

/* ============================================================== mcp ===== */

export type McpTransport = "http" | "sse" | "stdio";

/** Per-tool execution policy for a connector. */
export type McpPolicyAction = "allow" | "deny" | "ask";

/**
 * Tool-level gate for an MCP server. `default` applies to every tool that has
 * no explicit entry in `tools`. Newly added servers default to `{default:
 * "ask"}` so nothing executes without the user's blessing until they opt out.
 */
export interface McpToolPolicy {
  default: McpPolicyAction;
  /** Per-tool overrides keyed by the BARE tool name (no mcp__server__ prefix). */
  tools?: Record<string, McpPolicyAction>;
}

/**
 * MCP server config. The add-flow is deliberately claude.ai-shaped: a URL and
 * an optional token is the whole required surface. stdio lives behind an
 * "Advanced" disclosure for local servers.
 */
export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  /** http/sse */
  url?: string;
  /** Stored in the encrypted secret store; renderer sees only a boolean. */
  hasAuthToken: boolean;
  /** Header the token rides in. Defaults to Authorization: Bearer. */
  authHeader?: string;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  createdAt: number;
  /** Set when Kozum installed this itself rather than the user adding it. */
  installedByAgent: boolean;
  status: McpStatus;
  statusMessage?: string;
  toolCount: number;
  /**
   * When true, allows connections to localhost/127.x.x.x.
   * Required for local development MCP servers; false by default.
   */
  allowLocal?: boolean;
  /** Per-tool execution policy; manager.add defaults it to {default:"ask"}. */
  toolPolicy?: McpToolPolicy;
}

export type McpStatus = "connected" | "connecting" | "disconnected" | "error";

/** Result of a non-persisting MCP initialize + tools/list handshake. */
export interface McpConnectionTest {
  transport: McpTransport;
  toolCount: number;
  toolNames: string[];
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

/* ============================================================ plugins === */

export interface Plugin {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  enabled: boolean;
  /** Where it came from, so we can offer update/reinstall. */
  source: PluginSource;
  installedAt: number;
  updatedAt: number;
  /** Absolute install path under the app data dir. */
  path: string;
  /** Contributions discovered on load. */
  skills: string[];
  agents: string[];
  commands: string[];
  mcpServers: string[];
  hasHooks: boolean;
  installedByAgent: boolean;
  /** Populated when a load error occurred; plugin stays listed but disabled. */
  error?: string;
}

export type PluginSource =
  | { kind: "zip"; originalName: string }
  | { kind: "github"; repo: string; ref?: string; subPath?: string }
  | { kind: "marketplace"; marketplace: string; pluginName: string }
  | { kind: "builtin" }
  | { kind: "local"; path: string };

export interface Marketplace {
  id: string;
  name: string;
  /** owner/repo or a full URL. */
  source: string;
  pluginCount: number;
  lastFetchedAt: number;
}

/* ============================================================= skills === */

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Extra matching context, merged with description for auto-invocation. */
  whenToUse?: string;
  /** Absolute path to SKILL.md. */
  path: string;
  source: "builtin" | "user" | "plugin";
  pluginId?: string;
  enabled: boolean;
  modes: Mode[];
  allowedTools?: string[];
}

/* ========================================================== subagents === */

export interface SubagentDefinition {
  name: string;
  description: string;
  /** Body of the markdown file = the subagent's system prompt. */
  systemPrompt: string;
  tools?: string[];
  model?: string;
  source: "builtin" | "user" | "plugin";
  pluginId?: string;
  modes: Mode[];
}

export interface SubagentRun {
  id: string;
  parentSessionId: string;
  /** The assistant message id in which the parent agent called `agent_run` (P1-1). */
  parentMessageId?: string;
  /** The AgentTask tracked by the parent session for this delegated outcome. */
  taskId?: string;
  name: string;
  description: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  result?: string;
  error?: string;
  usage?: TokenUsage;
  /** Explicit checks the parent must verify before accepting the delegation. */
  acceptanceCriteria?: string[];
  /** Best-effort progress metadata reported while the child loop is running. */
  currentStep?: string;
  progress?: number;
}

/* ==================================================== scheduled tasks === */

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  /** Standard 5-field cron, evaluated in `timezone`. */
  cron: string;
  timezone: string;
  enabled: boolean;
  mode: Mode;
  projectId: string | null;
  workingFolder: string | null;
  /** Null = inherit the mode's current selection at run time. */
  selection: ModelSelection | null;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: "success" | "failed" | "skipped";
  lastError?: string;
  runCount: number;
}

/* ============================================================= memory === */

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryNote {
  /** Slug derived from the filename; stable across edits. */
  id: string;
  title: string;
  type: MemoryType;
  path: string;
  description: string;
  tags: string[];
  updatedAt: number;
  /** Outgoing [[wikilinks]] resolved to note ids where possible. */
  links: string[];
}

/* =========================================================== settings === */

export interface AppSettings {
  general: {
    userName: string;
    workDescription: string;
    customInstructions: string;
    appearance: "system" | "light" | "dark";
    chatFont: "sans" | "serif" | "mono";
    motion: "system" | "reduced";
    language: "en" | "ar";
    /** Default working-folder used when no project/folder is selected, per mode. */
    defaultFolders: {
      cowork: string | null;
      code: string | null;
    };
    /**
     * One shared workspace for both modes, used when no project/mode folder
     * is selected. Initialized by main to Documents/Kozum on first boot;
     * changeable from Settings, never removable.
     */
    defaultWorkspace: string | null;
    /** Standing instructions injected into every session's system prompt. */
    rules: string;
    /** When true, deliverable-producing tools auto-open the PreviewPanel after tool_end. */
    autoOpenPreviews: boolean;
    /** When true, browser_* tool_start opens a live browser preview panel. */
    autoOpenBrowserPreview: boolean;
  };
  cowork: ModeSettings;
  code: ModeSettings;
  computerUse: {
    enabled: boolean;
    /** Apps Kozum must never interact with. */
    blocklist: string[];
    requireConfirmation: boolean;
  };
  browser: {
    enabled: boolean;
    userAgent: string | null;
    headless: boolean;
  };
  network: {
    /** Hosts that always bypass any proxy and get retry + mirror fallback. */
    alwaysAllowHosts: string[];
    proxyUrl: string | null;
    /** Installer-managed Windows Firewall allow rule for GitHub. */
    githubFirewallRule: boolean;
  };
  scheduler: {
    enabled: boolean;
    keepAwake: boolean;
  };
  privacy: {
    telemetry: false;
  };
  /** User-controlled visual accents used by the renderer shell and Customize preview. */
  customize: {
    accentColor: string;
    surfaceColor: string;
    fontFamily: "sans" | "serif" | "mono";
  };
  /** User-registered custom OpenAI-compatible providers. */
  customProviders: ProviderPreset[];
}

export interface ModeSettings {
  selection: ModelSelection;
  systemPromptOverride: string | null;
  maxTokens: number;
  temperature: number;
  /** Hard ceiling on agent-loop iterations per user turn. */
  maxIterations: number;
  permissionMode: PermissionMode;
  enabledToolNames: string[] | null;
}

/* ============================================================ results === */

/**
 * Uniform result envelope for every IPC call. Throwing across the IPC boundary
 * loses the stack and stringifies badly, so handlers return this instead.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: string, code?: string): Result<T> {
  return { ok: false, error, code };
}
