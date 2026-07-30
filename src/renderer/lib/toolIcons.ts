/**
 * Kozum Cowork — tool icon + label map.
 *
 * toolIcon(name) returns a Lucide icon name (string, not the component, so this
 * file is plain-TS with zero React deps) and a short human label.
 *
 * Resolution order:
 *   1. Exact match in EXACT_MAP
 *   2. Group-prefix match in PREFIX_MAP (longest prefix wins)
 *   3. Fallback: { icon: "wrench", label: name }
 */

export interface ToolIconInfo {
  icon: string;
  label: string;
}

// ── Exact matches ──────────────────────────────────────────────────────────

const EXACT_MAP: Record<string, ToolIconInfo> = {
  // Shell / process
  shell_exec: { icon: "terminal", label: "Run command" },
  shell_run: { icon: "terminal", label: "Run command" },
  bash: { icon: "terminal", label: "Run command" },
  bash_exec: { icon: "terminal", label: "Run command" },
  process_run: { icon: "terminal", label: "Run process" },
  process_exec: { icon: "terminal", label: "Run process" },
  process_kill: { icon: "x-circle", label: "Kill process" },
  process_list: { icon: "list", label: "List processes" },
  process_spawn: { icon: "play", label: "Spawn process" },

  // File system
  file_read: { icon: "file-text", label: "Read file" },
  read_file: { icon: "file-text", label: "Read file" },
  file_write: { icon: "file-plus", label: "Write file" },
  write_file: { icon: "file-plus", label: "Write file" },
  file_edit: { icon: "file-pen", label: "Edit file" },
  edit_file: { icon: "file-pen", label: "Edit file" },
  file_patch: { icon: "file-pen", label: "Patch file" },
  file_delete: { icon: "file-minus", label: "Delete file" },
  delete_file: { icon: "file-minus", label: "Delete file" },
  file_copy: { icon: "copy", label: "Copy file" },
  file_move: { icon: "move", label: "Move file" },
  file_rename: { icon: "file-pen", label: "Rename file" },
  file_stat: { icon: "file-search", label: "Stat file" },
  file_exists: { icon: "file-search", label: "Check file" },
  file_list: { icon: "files", label: "List files" },
  file_search: { icon: "file-search", label: "Search file" },
  file_glob: { icon: "file-search", label: "Glob files" },
  file_append: { icon: "file-plus", label: "Append file" },
  file_chmod: { icon: "lock", label: "Set permissions" },
  file_truncate: { icon: "file-minus", label: "Truncate file" },

  // Directory
  dir_create: { icon: "folder-plus", label: "Create folder" },
  dir_list: { icon: "folder-open", label: "List folder" },
  dir_delete: { icon: "folder-minus", label: "Delete folder" },
  dir_move: { icon: "folder-open", label: "Move folder" },
  dir_copy: { icon: "folder-open", label: "Copy folder" },
  dir_exists: { icon: "folder-search", label: "Check folder" },
  dir_read: { icon: "folder-open", label: "Read folder" },
  dir_watch: { icon: "eye", label: "Watch folder" },

  // Web / network
  web_fetch: { icon: "globe", label: "Fetch URL" },
  web_search: { icon: "search", label: "Web search" },
  web_get: { icon: "globe", label: "HTTP GET" },
  web_post: { icon: "globe", label: "HTTP POST" },
  web_request: { icon: "globe", label: "HTTP request" },
  web_screenshot: { icon: "camera", label: "Web screenshot" },
  web_extract: { icon: "code-2", label: "Extract content" },
  web_crawl: { icon: "globe", label: "Crawl URL" },
  web_download: { icon: "download", label: "Download file" },

  // Browser
  browser_open: { icon: "compass", label: "Open browser" },
  browser_navigate: { icon: "compass", label: "Navigate to URL" },
  browser_click: { icon: "mouse-pointer-2", label: "Click element" },
  browser_type: { icon: "keyboard", label: "Type text" },
  browser_fill: { icon: "keyboard", label: "Fill input" },
  browser_screenshot: { icon: "camera", label: "Screenshot" },
  browser_scroll: { icon: "scroll", label: "Scroll page" },
  browser_wait: { icon: "clock", label: "Wait" },
  browser_eval: { icon: "code-2", label: "Evaluate JS" },
  browser_select: { icon: "list", label: "Select option" },
  browser_check: { icon: "check-square", label: "Check checkbox" },
  browser_extract: { icon: "code-2", label: "Extract DOM" },
  browser_back: { icon: "arrow-left", label: "Browser back" },
  browser_forward: { icon: "arrow-right", label: "Browser forward" },
  browser_close: { icon: "x", label: "Close browser" },
  browser_tab_new: { icon: "plus", label: "New tab" },
  browser_tab_close: { icon: "x", label: "Close tab" },
  browser_tab_switch: { icon: "layers", label: "Switch tab" },

  // Computer / desktop
  computer_screenshot: { icon: "monitor", label: "Screenshot" },
  computer_click: { icon: "mouse-pointer-2", label: "Click" },
  computer_type: { icon: "keyboard", label: "Type text" },
  computer_key: { icon: "keyboard", label: "Press key" },
  computer_move: { icon: "mouse-pointer-2", label: "Move mouse" },
  computer_scroll: { icon: "scroll", label: "Scroll" },
  computer_drag: { icon: "move", label: "Drag" },
  computer_double_click: { icon: "mouse-pointer-2", label: "Double-click" },
  computer_right_click: { icon: "mouse-pointer-2", label: "Right-click" },
  computer_hotkey: { icon: "keyboard", label: "Hotkey" },
  computer_clipboard: { icon: "clipboard", label: "Clipboard" },

  // Agent / subagent
  agent_spawn: { icon: "bot", label: "Spawn agent" },
  agent_run: { icon: "bot", label: "Run agent" },
  agent_call: { icon: "bot", label: "Call agent" },
  agent_stop: { icon: "square", label: "Stop agent" },
  agent_status: { icon: "activity", label: "Agent status" },

  // Task
  task_create: { icon: "list-checks", label: "Create task" },
  task_update: { icon: "list-checks", label: "Update task" },
  task_complete: { icon: "list-checks", label: "Complete task" },
  task_list: { icon: "list-checks", label: "List tasks" },
  task_delete: { icon: "list-checks", label: "Delete task" },
  task_get: { icon: "list-checks", label: "Get task" },

  // Skill
  skill_run: { icon: "sparkles", label: "Run skill" },
  skill_invoke: { icon: "sparkles", label: "Invoke skill" },
  skill_call: { icon: "sparkles", label: "Call skill" },

  // MCP
  mcp_call: { icon: "plug", label: "MCP call" },
  mcp_invoke: { icon: "plug", label: "MCP invoke" },
  mcp_list: { icon: "plug", label: "MCP list" },
  mcp_connect: { icon: "plug", label: "MCP connect" },

  // Plugin
  plugin_run: { icon: "package", label: "Run plugin" },
  plugin_call: { icon: "package", label: "Call plugin" },
  plugin_invoke: { icon: "package", label: "Invoke plugin" },

  // Schedule
  schedule_create: { icon: "calendar", label: "Schedule task" },
  schedule_list: { icon: "calendar", label: "List schedules" },
  schedule_delete: { icon: "calendar", label: "Delete schedule" },
  schedule_update: { icon: "calendar", label: "Update schedule" },
  schedule_run: { icon: "calendar", label: "Run scheduled" },

  // Memory
  memory_read: { icon: "brain", label: "Read memory" },
  memory_write: { icon: "brain", label: "Write memory" },
  memory_search: { icon: "brain", label: "Search memory" },
  memory_delete: { icon: "brain", label: "Delete memory" },
  memory_list: { icon: "brain", label: "List memories" },
  memory_update: { icon: "brain", label: "Update memory" },

  // Grep / search tools
  grep: { icon: "search", label: "Search text" },
  glob: { icon: "search", label: "Glob files" },
  ripgrep: { icon: "search", label: "Search text" },
  find: { icon: "search", label: "Find files" },
};

// ── Prefix matches (applied in longest-prefix-first order) ─────────────────

const PREFIX_MAP: Array<[string, ToolIconInfo]> = [
  ["shell_", { icon: "terminal", label: "Run command" }],
  ["process_", { icon: "terminal", label: "Run process" }],
  ["bash_", { icon: "terminal", label: "Run command" }],
  ["file_", { icon: "file", label: "File operation" }],
  ["dir_", { icon: "folder", label: "Folder operation" }],
  ["web_", { icon: "globe", label: "Web operation" }],
  ["browser_", { icon: "compass", label: "Browser action" }],
  ["computer_", { icon: "monitor", label: "Desktop action" }],
  ["agent_", { icon: "bot", label: "Agent action" }],
  ["task_", { icon: "list-checks", label: "Task operation" }],
  ["skill_", { icon: "sparkles", label: "Skill operation" }],
  ["mcp_", { icon: "plug", label: "MCP tool" }],
  ["plugin_", { icon: "package", label: "Plugin operation" }],
  ["schedule_", { icon: "calendar", label: "Schedule operation" }],
  ["memory_", { icon: "brain", label: "Memory operation" }],
  // Filesystem aliases
  ["read_", { icon: "file-text", label: "Read" }],
  ["write_", { icon: "file-plus", label: "Write" }],
  ["edit_", { icon: "file-pen", label: "Edit" }],
  ["delete_", { icon: "trash-2", label: "Delete" }],
  ["search_", { icon: "search", label: "Search" }],
  ["list_", { icon: "list", label: "List" }],
];

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns { icon: lucide-icon-name, label: human-readable-label } for a tool.
 *
 * Strategy:
 *   1. Exact match
 *   2. Group prefix (longest matching prefix wins)
 *   3. Fallback wrench
 */
export function toolIcon(name: string): ToolIconInfo {
  // 1. Exact match
  const exact = EXACT_MAP[name];
  if (exact) return exact;

  // 2. Prefix — try from most specific (longest) to least
  const lower = name.toLowerCase();
  let best: ToolIconInfo | null = null;
  let bestLen = 0;

  for (const [prefix, info] of PREFIX_MAP) {
    if (lower.startsWith(prefix) && prefix.length > bestLen) {
      best = info;
      bestLen = prefix.length;
    }
  }

  if (best) return best;

  // 3. Fallback
  return { icon: "wrench", label: name };
}
