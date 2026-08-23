/**
 * Permission mode gate for tool execution.
 *
 * The gate is intentionally applied immediately before the real tool handler.
 * Read-only tools remain available in every mode; mutating tools either run,
 * request an inline approval, or return a structured denial to the model.
 *
 *   bypass_permissions — run every exposed tool without asking (Cowork: Auto approve).
 *   plan               — allow inspection and planning, but refuse mutating tools.
 *   accept_edits      — apply filesystem edits automatically; ask for commands,
 *                       processes, browser interactions, connectors and host control.
 *   ask_permission    — ask before every mutating tool.
 *   ask_dangerous     — ask only for irreversible/destructive tools (Cowork default);
 *                       shell, computer control, browser and web pass without asking.
 */

import type { PermissionMode, ToolResult } from "../../shared/types.ts";

/** Groups whose tools can change the host or cause an external side effect. */
const MUTATING_GROUPS = new Set(["shell", "process", "computer", "browser", "mcp", "plugin"]);

/** Filesystem tools that only inspect data and never write or delete. */
const READ_ONLY_FS_TOOLS = new Set([
  "file_read",
  "file_read_image",
  "file_read_pdf",
  "glob_match",
  "file_search",
  "directory_list",
]);

/** Filesystem operations that remain confirmation-gated in accept edits. */
const DANGEROUS_FS_TOOLS = new Set(["file_delete", "directory_delete", "file_move"]);

/** Browser operations that only inspect or move the current browser view. */
const READ_ONLY_BROWSER_TOOLS = new Set([
  "browser_screenshot",
  "browser_extract",
  "browser_get_content",
  "browser_wait",
  "browser_back",
  "browser_forward",
]);

/** Connector/plugin catalog operations that do not mutate configuration. */
const READ_ONLY_EXTENSION_TOOLS = new Set([
  "mcp_list",
  "plugin_list",
  "marketplace_list",
]);

/** Local memory and project-index operations with persistent side effects. */
const MUTATING_SYSTEM_TOOLS = new Set([
  "memory_write",
  "memory_delete",
  "project_kb_build",
  "project_kb_update",
]);

/** Scheduled tasks change unattended future execution. */
const MUTATING_TASK_TOOLS = new Set([
  "schedule_create",
  "schedule_update",
  "schedule_delete",
  "schedule_run_now",
]);

/**
 * Irreversible/destructive operations — the ONLY tools `ask_dangerous` asks
 * about (Cowork's "Ask for dangerous actions" posture). Deliberately narrow:
 * shell commands, computer control, browser and web tools pass without asking.
 * Tune this one constant rather than adding new modes.
 *
 * `file_move` is included because it can silently overwrite an existing target.
 */
export const DANGEROUS_TOOLS = new Set([
  "file_delete",
  "directory_delete",
  "file_move",
  "process_kill",
  "memory_delete",
  "schedule_create",
  "schedule_update",
  "schedule_delete",
  "schedule_run_now",
]);

export interface PermissionGateOpts {
  toolName: string;
  toolGroup: string;
  permissionMode: PermissionMode;
  /** Emit a permission_request event and wait for the user's reply. */
  requestPermission: (requestId: string, reason: string) => Promise<string[]>;
  /** Tool names approved with "allow always" for this live session only. */
  sessionAllowedTools?: ReadonlySet<string>;
  /** Persist an allow-always decision in the live session cache. */
  rememberTool?: (toolName: string) => void;
  sessionId: string;
}

export interface PermissionDecision {
  allowed: boolean;
  /** Non-null when execution must not proceed. */
  blockedMessage: string | null;
}

function isMutating(toolName: string, toolGroup: string): boolean {
  if (toolGroup === "filesystem") return !READ_ONLY_FS_TOOLS.has(toolName);
  if (toolGroup === "system") return MUTATING_SYSTEM_TOOLS.has(toolName);
  if (toolGroup === "task") return MUTATING_TASK_TOOLS.has(toolName);
  if (toolGroup === "web" || toolGroup === "agent") return false;
  if (toolGroup === "browser") return !READ_ONLY_BROWSER_TOOLS.has(toolName);
  if (toolGroup === "mcp" || toolGroup === "plugin") {
    return !READ_ONLY_EXTENSION_TOOLS.has(toolName);
  }
  return MUTATING_GROUPS.has(toolGroup);
}

function newRequestId(): string {
  return `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function normalizeDecision(value: string): "allow_once" | "allow_always" | "deny" {
  const normalized = value.trim().toLowerCase();
  if (["allow_always", "always", "allow always", "remember", "yes_always"].includes(normalized)) {
    return "allow_always";
  }
  if (["yes", "allow", "approve", "approved", "y", "true", "allow_once", "once", "allow once"].includes(normalized)) {
    return "allow_once";
  }
  return "deny";
}

/** Decide whether the tool may run under the current session posture. */
export async function checkPermission(opts: PermissionGateOpts): Promise<PermissionDecision> {
  const { toolName, toolGroup, permissionMode } = opts;
  const allowed = { allowed: true, blockedMessage: null } as const;

  if (!isMutating(toolName, toolGroup) || permissionMode === "bypass_permissions") return allowed;
  // Session-scoped "allow always" decisions are honored before any mode logic.
  if (opts.sessionAllowedTools?.has(toolName)) return allowed;

  if (permissionMode === "plan") {
    return {
      allowed: false,
      blockedMessage:
        `The current permission mode is "plan", so the mutating tool "${toolName}" was not executed. ` +
        "Planning and read-only inspection remain available; ask the user to change the Code permission mode before applying changes.",
    };
  }

  // Cowork's "Ask for dangerous actions": only irreversible/destructive tools
  // ask; everything else (shell, computer, browser, web, edits) runs silently.
  const needsAsk = permissionMode === "ask_dangerous" ? DANGEROUS_TOOLS.has(toolName) : true;
  if (!needsAsk) return allowed;

  // accept_edits auto-approves filesystem edits but still protects commands,
  // process control, host/browser actions, connectors, plugins and persistence.
  const autoApprovedEdit =
    permissionMode === "accept_edits" &&
    toolGroup === "filesystem" &&
    !DANGEROUS_FS_TOOLS.has(toolName);
  if (autoApprovedEdit) return allowed;

  const requestId = newRequestId();
  const reason =
    permissionMode === "accept_edits"
      ? `The agent wants to run "${toolName}". File edits are automatic in this mode; this action needs approval.`
      : `The agent wants to run "${toolName}". Allow this action?`;

  try {
    const answers = await opts.requestPermission(requestId, reason);
    const decision = normalizeDecision(answers[0] ?? "deny");
    if (decision === "allow_always") {
      opts.rememberTool?.(toolName);
      return allowed;
    }
    if (decision === "allow_once") return allowed;
    return {
      allowed: false,
      blockedMessage: `The user denied permission for "${toolName}".`,
    };
  } catch {
    return {
      allowed: false,
      blockedMessage: `Permission request for "${toolName}" was cancelled.`,
    };
  }
}

/** Build a ToolResult for an action the current permission mode refused. */
export function blockedResult(message: string): ToolResult {
  return {
    ok: false,
    content: message,
    error: message,
    display: { summary: message.slice(0, 160) },
  };
}
