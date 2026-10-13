/**
 * CodeBuddy system prompt known XML tags and their display names.
 */

/**
 * All known XML tag names in CodeBuddy's system prompt, in typical order.
 */
export const CODEBUDDY_KNOWN_TAGS = [
  "content_policy",
  "communication",
  "tool_calling",
  "maximize_parallel_tool_calls",
  "maximize_context_understanding",
  "code-explorer_subagent_usage",
  "making_code_changes",
  "citing_code",
  "inline_line_numbers",
  "task_management",
  "mcp_protocol",
  "integrations_protocol",
  "response_language",
  "agent_skills",
  "automations",
  "memories",
  "rules",
  "project_context",
  "cb_summary",
  "conversation_history_summary",
  "additional_data",
  "system_reminder",
  // Tags injected by CodeBuddy IDE into user messages (not system prompt),
  // but also recognized here for completeness and future anchoring.
  "user_info",
  "git_status",
  "open_and_recently_viewed_files",
  "always_applied_workspace_rules",
  // Nested sub-tags used inside agent_skills / available_skills
  "available_skills",
  "skill",
  "name",
  "description",
  "location",
] as const;

export type CodeBuddyTag = (typeof CODEBUDDY_KNOWN_TAGS)[number];

/**
 * Human-readable names for each tag (for debugging).
 */
export const TAG_DISPLAY_NAMES: Record<string, string> = {
  content_policy: "Content Safety Policy",
  communication: "Communication Guidelines",
  tool_calling: "Tool Calling Guidelines",
  maximize_parallel_tool_calls: "Parallel Tool Call Guidance",
  maximize_context_understanding: "Context Understanding Guidance",
  "code-explorer_subagent_usage": "Code Explorer Subagent",
  making_code_changes: "Code Change Guidelines",
  citing_code: "Code Citation Guidelines",
  inline_line_numbers: "Line Number Guidelines",
  task_management: "Task Management",
  mcp_protocol: "MCP Protocol",
  integrations_protocol: "Integrations Protocol",
  response_language: "Response Language",
  agent_skills: "Agent Skills",
  automations: "Automated Tasks",
  memories: "Memories",
  rules: "Rules",
  project_context: "Project Context",
  cb_summary: "Conversation Summary",
  conversation_history_summary: "Conversation History Summary",
  additional_data: "Additional Data",
  system_reminder: "System Reminder",
  user_info: "User Environment Info",
  git_status: "Git Status",
  open_and_recently_viewed_files: "Recently Opened Files",
  always_applied_workspace_rules: "Workspace Rules",
};

/**
 * Tags that serve as "tool/skill injection anchors" in CodeBuddy.
 */
export const TOOL_ANCHOR_TAGS = ["agent_skills"] as const;

/**
 * Tags that serve as "memory injection anchors".
 */
export const MEMORY_ANCHOR_TAGS = ["memories"] as const;

// ── Unknown Tag Detection ────────────────────────────────────────────────────────

const KNOWN_TAG_SET: Set<string> = new Set(CODEBUDDY_KNOWN_TAGS);

/**
 * Scan a text for XML tags that are NOT in CODEBUDDY_KNOWN_TAGS.
 * Returns a list of unique unknown tag names found.
 *
 * This is useful for detecting when CodeBuddy IDE adds new tags that we
 * haven't yet catalogued. Call this on the system prompt at request time
 * (in debug/logging path) to get early warning of format changes.
 */
export function detectUnknownTags(text: string): string[] {
  const tagRegex = /<(\w[\w-]*)(?:\s[^>]*?)?>/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    const tagName = match[1];
    if (!KNOWN_TAG_SET.has(tagName)) {
      found.add(tagName);
    }
  }
  return Array.from(found).sort();
}

/**
 * Scan a text for ALL XML tags (both known and unknown).
 * Returns { known: string[], unknown: string[] }.
 */
export function classifyTags(text: string): { known: string[]; unknown: string[] } {
  const tagRegex = /<(\w[\w-]*)(?:\s[^>]*?)?>/g;
  const known = new Set<string>();
  const unknown = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    const tagName = match[1];
    if (KNOWN_TAG_SET.has(tagName)) {
      known.add(tagName);
    } else {
      unknown.add(tagName);
    }
  }
  return {
    known: Array.from(known).sort(),
    unknown: Array.from(unknown).sort(),
  };
}
