/**
 * CodeBuddy Session Init — LastUser text extractor.
 *
 * This file used to contain `stripInitArtifacts`, which stripped the fake
 * form conversation after session_init completed (so the LLM never saw the form
 * interaction). **That feature has been removed**: all real user conversation
 * (including the session_init form interaction) is now always preserved and nothing is deleted.
 * Only one export remains: `getLastUserMessageText`, used by the session_init
 * state machine to read the text of the last user / tool message and parse the user's choice.
 *
 * ── CodeBuddy ask_followup_question reply format (openai branch) ──
 *
 * Message structure carrying the Q&A in the next CodeBuddy request after the user clicks the form:
 *
 *   [N-2] role=assistant  tool_calls=[{id:"call_session_init_...", function:{name:"ask_followup_question"}}]
 *   [N-1] role=tool       tool_call_id=call_session_init_...  content=<multi_question_result JSON>
 *   [N]   role=user       content=<additional_data> or another ordinary user message
 *
 * multi_question_result JSON (format captured from real traffic):
 *   Empty-shell intermediate state (form just displayed, user has not clicked yet):
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","options":[...],"multiSelect":false}],
 *      "answers":{},
 *      "message":"Questions displayed. User response will be in <que"}}
 *
 *   Real answer (after the user clicks):
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","answer":"Team name (last 8 chars of id)",...}],
 *      "answers":{"team":"Team name (last 8 chars of id)"}}}
 *
 * ── dsh v0.2+ reply format (anthropic branch) ──
 *
 * After dsh v0.2 switched to the anthropic /v1/messages protocol, the tool_result carrier changed from openai's
 *   `role: "tool" + tool_call_id + content: <JSON>`
 * to anthropic's
 *   `role: "user" + content: [{type:"tool_result", tool_use_id, content}]`
 *
 * getMessageText must be able to extract the content of tool_result blocks (fully symmetric with CC's
 * claude-code/cleaner.ts:66-74).
 */

import { containsFormTitle } from "./form.js";

interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  tool_use_id?: unknown;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get text from last user or tool message containing form answer data.
 *
 * Two carriers (protocol-dependent):
 *   1. openai (CB / WB / opencode / dsh v0.1.x): `role: "tool"` message,
 *      `tool_call_id` matches the session-init prefix → content is the tool_result JSON.
 *   2. anthropic (CC / dsh v0.2+): `role: "user"` message, a
 *      `type: "tool_result"` block in `content[]` whose `tool_use_id` matches the session-init prefix
 *      → block.content is the tool_result JSON.
 */
export function getLastUserMessageText(messages: RawMessage[]): string {
  // Sweep from end: the last message (user or tool) that relates to
  // session init is what we want. Tool messages are preferred because
  // CB writes "Yes, link team assets" etc. into tool_result content.
  let best = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role !== "user" && role !== "tool") continue;

    const text = getMessageText(messages[i]);
    if (!text) continue;

    // openai branch: role=tool + top-level tool_call_id matches the session-init prefix
    // Four prefixes supported: CB's `call_session_init_`, WB's `call_wb_session_init_`
    // (TOOLCALL_PREFIX = "call_wb_session_init_" in workbuddy/form.ts),
    // dsh's `call_dsh_session_init_` (TOOLCALL_PREFIX in dsh/form.ts),
    // opencode's `call_oc_session_init_` (TOOLCALL_PREFIX in opencode/form.ts).
    const tcid = (messages[i] as any).tool_call_id as string | undefined;
    if (role === "tool" && tcid && /call_(wb_|dsh_|oc_)?session_init_/.test(tcid)) {
      return text;
    }

    // anthropic branch (dsh v0.2+): a role=user message containing a tool_result block;
    // a block.tool_use_id matching the session-init prefix hits directly (equivalent to the openai branch).
    if (role === "user" && Array.isArray(messages[i].content)) {
      for (const raw of messages[i].content as AnthropicBlock[]) {
        if (raw.type !== "tool_result") continue;
        const tuid = typeof raw.tool_use_id === "string" ? raw.tool_use_id : "";
        if (/call_(wb_|dsh_|oc_)?session_init_|toolu_cc_session_init_/.test(tuid)) {
          return text;
        }
      }
    }

    // User messages with form markers have highest priority for old format
    if (role === "user" && (text.includes("<question_answer") || containsFormTitle(text))) {
      return text;
    }

    // Remember the last user/tool text as fallback
    if (!best && role === "user") {
      best = text;
    }
  }
  return best;
}

function getMessageText(msg: RawMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content as AnthropicBlock[]) {
      const type = raw.type;
      if (type === "text" && typeof raw.text === "string") {
        parts.push(raw.text);
        continue;
      }
      // anthropic tool_result block (dsh v0.2+ / same as CC):
      //   { type:"tool_result", tool_use_id, content: <string or [{type:"text",text}]> }
      if (type === "tool_result") {
        const inner = raw.content;
        if (typeof inner === "string") {
          parts.push(inner);
        } else if (Array.isArray(inner)) {
          for (const c of inner as AnthropicBlock[]) {
            if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
          }
        }
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}
