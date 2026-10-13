/**
 * CodeBuddy Session Init — Public API.
 *
 * Standalone CodeBuddy session-init implementation:
 *   - Form: `ask_followup_question` tool_call
 *   - Extractor: `<question_answer>` XML
 *   - Cleaner: XML envelope detection
 *   - No pagination, no option-count limit
 */

export { handleSessionInit } from "./init.js";
export type { SessionRequestContext, SessionInitResult } from "./init.js";

export { buildFormResponse, containsFormTitle, isSessionInitToolCallId } from "./form.js";
export { TOOL_NAME, TOOLCALL_PREFIXES, SKIP_LABEL, TEAM_FORM_TITLE, AGENT_TASK_FORM_TITLE, RETRY_FORM_TITLE, COMBINED_FORM_TITLE } from "./form.js";
export type { FormData, FormStage } from "./form.js";

export { extractFromOptionText, extractTeamFromOptionText, extractStructured, resolveAgent, resolveTask, BYPASS_MARKER } from "./extractor.js";
export { getLastUserMessageText } from "./cleaner.js";
