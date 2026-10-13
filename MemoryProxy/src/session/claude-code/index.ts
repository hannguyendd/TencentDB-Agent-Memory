/**
 * Claude Code Session Init — Public API.
 *
 * Standalone Claude Code session-init implementation:
 *   - Form: `AskUserQuestion` tool_use (Anthropic SSE only)
 *   - Extractor: JSON tool_result parsing
 *   - Cleaner: tool_use id matching
 *   - Pagination mode: 3 agents per page + "More →" button
 */

export { handleSessionInit } from "./init.js";
export type { SessionRequestContext, SessionInitResult } from "./init.js";

export { buildFormResponse, containsFormTitle, isSessionInitToolCallId } from "./form.js";
export { TOOL_NAME, TOOLCALL_PREFIX, SKIP_LABEL, MORE_LABEL, TEAM_FORM_TITLE, AGENT_TASK_FORM_TITLE, RETRY_FORM_TITLE } from "./form.js";
export type { FormData, FormStage } from "./form.js";

export { extractFromOptionText, extractTeamFromOptionText, extractTaskFromOptionText, extractStructured, resolveAgent, resolveTask, BYPASS_MARKER, MORE_MARKER } from "./extractor.js";
export { getLastUserMessageText } from "./cleaner.js";
