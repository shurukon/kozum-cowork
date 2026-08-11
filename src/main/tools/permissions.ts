/**
 * Permission mode gate for tool execution.
 *
 * Implements the four permission postures defined in the product spec:
 *
 *   manual          — every mutating tool asks before running.
 *   accept_edits    — file-edit tools auto-approve; shell/process still ask.
 *   plan            — mutating tools are blocked with a "present a plan" message.
 *   bypass_permissions — nothing asks; all tools run immediately.
 *
 * "Mutating" means any tool whose group is filesystem (write/edit/delete/move),
 * shell, process, or computer. Read-only filesystem tools (file_read,
 * file_read_image, file_read_pdf, glob_match, file_search, directory_list)
 * are never blocked.
 */

import type { ToolResult } from "../../shared/types.ts";
import type { PermissionMode } from "../../shared/types.ts";

/** Tool groups that always mutate the system. */
const SHELL_GROUPS = new Set(["shell", "process", "computer"]);

/**
 * Tool names within the filesystem group that are pure reads — never blocked.
 * Fixed: removed phantom entries (dir_list, dir_tree, dir_stats, env_list)
 * and added real read-only tools (file_read_image, file_read_pdf, directory_list).
 */
const READ_ONLY_FS_TOOLS = new Set([
  "file_read",
  "file_read_image",
  "file_read_pdf",
  "glob_match",
  "file_search",
  "directory_list",
  "env_get",
  "system_info",
]);

/** Tool groups for filesystem write/edit/delete operations. */
const FS_WRITE_GROUPS = new Set(["filesystem"]);

export interface PermissionGateOpts {
  toolName: string;
  toolGroup: string;
  permissionMode: PermissionMode;
  /** Emit a permission_request event and wait for reply. */
  requestPermission: (requestId: string, reason: string) => Promise<string[]>;
  sessionId: string;
}

export interface PermissionDecision {
  /** True if the tool is allowed to run. */
  allowed: boolean;
  /** Non-null when the decision was "blocked" — the reason to return to the model. */
  blockedMessage: string | null;
}

/**
 * Decide whether a tool is allowed to run under the current permission mode.
 *
 * Returns { allowed: true, blockedMessage: null } when the tool may proceed.
 * Returns { allowed: false, blockedMessage } when it must not.
 * For modes that ask, this waits for the user to reply — the caller must await.
 */
export async function checkPermission(opts: PermissionGateOpts): Promise<PermissionDecision> {
  const { toolName, toolGroup, permissionMode } = opts;
  const allowed = { allowed: true, blockedMessage: null };

  // Bypass: nothing asks, nothing blocks.
  if (permissionMode === "bypass_permissions") return allowed;

  // Determine if this tool is mutating.
  const isShellLike = SHELL_GROUPS.has(toolGroup);
  const isFsWrite = FS_WRITE_GROUPS.has(toolGroup) && !READ_ONLY_FS_TOOLS.has(toolName);
  const isMutating = isShellLike || isFsWrite;

  if (!isMutating) return allowed;

  if (permissionMode === "plan") {
    return {
      allowed: false,
      blockedMessage:
        `The current permission mode is "plan". The tool "${toolName}" ` +
        `would mutate the system, which is not allowed in plan mode. ` +
        `Present a plan to the user (listing exactly which files you will write, ` +
        `which commands you will run, and why) and ask for approval before proceeding.`,
    };
  }

  if (permissionMode === "accept_edits") {
    // File edits auto-approve; shell/process/computer still ask.
    if (isFsWrite && !isShellLike) return allowed;
    // Shell/process/computer fall through to ask.
  }

  // manual mode: ask for everything mutating.
  // accept_edits mode: ask for shell/process/computer.
  const requestId = `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const reason =
    permissionMode === "accept_edits"
      ? `The agent wants to run "${toolName}" (shell/process/computer). Allow?`
      : `The agent wants to run "${toolName}". Allow?`;

  try {
    const answers = await opts.requestPermission(requestId, reason);
    // The user's reply is expected to be "yes", "no", or similar.
    const answer = (answers[0] ?? "no").toLowerCase();
    if (answer === "yes" || answer === "allow" || answer === "approve" || answer === "y") {
      return allowed;
    }
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

/** Build a ToolResult for a blocked tool. */
export function blockedResult(message: string): ToolResult {
  return {
    ok: false,
    content: message,
    error: message,
    display: { summary: message.slice(0, 160) },
  };
}
