/**
 * Stable product-level tool categories (P1-4 / §6.1).
 *
 * Every tool invocation is classified into one of ten categories so the UI can
 * tint ToolCards and the subagent progress bar consistently. The mapping lives
 * in exactly one place: a new tool falls under "other" until it is added here,
 * never throwing and never needing changes elsewhere.
 *
 * Keep this file in sync with the tool registry in src/main/tools — but the
 * contract is tolerant: unknown names default to "other".
 */

import type { ToolCategory } from "@shared/types.ts";

/** Explicit overrides — checked before the prefix rules. */
const EXACT: Record<string, ToolCategory> = {
  // tasks
  task_create: "todo",
  task_get: "todo",
  task_list: "todo",
  task_update: "todo",
  task_stop: "todo",

  // write / edit / read filesystem
  file_write: "write",
  file_copy: "write",
  file_move: "write",
  file_edit: "edit",
  file_edit_enhanced: "edit",
  file_read: "read",
  file_read_image: "read",
  file_read_pdf: "read",
  directory_list: "read",

  // run
  shell_exec: "run",
  shell_exec_bg: "run",
  shell_job_status: "run",
  shell_job_result: "run",
  shell_job_list: "run",
  shell_job_kill: "run",
  shell_job_clear: "run",
  process_list: "run",
  process_kill: "run",
  system_info: "run",
  env_get: "run",
  env_set: "run",

  // search
  file_search: "search",
  glob_match: "search",
  web_search: "search",

  // fetch / web / browser
  web_fetch: "fetch",
  browser_navigate: "fetch",
  browser_click: "fetch",
  browser_type: "fetch",
  browser_scroll: "fetch",
  browser_screenshot: "fetch",
  browser_extract: "fetch",
  browser_get_content: "fetch",
  browser_wait: "fetch",
  browser_back: "fetch",
  browser_forward: "fetch",
  browser_close: "fetch",
  screenshot: "fetch",
  pixelshot_help: "fetch",
  computer_screenshot: "fetch",

  // ask
  ask_user_question: "ask",
};

/** Prefix rules, evaluated in order after EXACT misses. */
const PREFIX: Array<[string, ToolCategory]> = [
  ["task_", "todo"],
  ["file_edit", "edit"],
  ["file_write", "write"],
  ["file_read", "read"],
  ["file_", "write"],
  ["shell_", "run"],
  ["process_", "run"],
  ["env_", "run"],
  ["directory_", "read"],
  ["web_", "fetch"],
  ["browser_", "fetch"],
  ["computer_", "other"],
  ["skill_", "skill"],
  ["agent_", "other"],
  ["mcp_", "other"],
  ["plugin_", "other"],
  ["schedule_", "other"],
  ["memory_", "other"],
  ["marketplace_", "other"],
  ["project_kb_", "other"],
  ["preview_", "other"],
];

/** Classify a tool by name into one of the ten categories. */
export function toolCategory(name: string): ToolCategory {
  const exact = EXACT[name];
  if (exact) return exact;
  for (const [prefix, category] of PREFIX) {
    if (name.startsWith(prefix)) return category;
  }
  return "other";
}
