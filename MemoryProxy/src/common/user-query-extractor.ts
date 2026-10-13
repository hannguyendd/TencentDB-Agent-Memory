/**
 * User query extractor -- strips all harness context from the user
 * message content of CC / CodeBuddy / other coding agents, keeping only "the text the user actually typed".
 *
 * Usage scenarios (shared in three places within the proxy):
 *   1. tdai/recorder.ts::extractLatestUserMessage -- L0 write
 *   2. agent-adapters/codebuddy.ts::extractUserText -- mem command parser +
 *      normalize-conversation extracting clean text for the skill buffer
 *   3. mem-command calls it indirectly through adapter.extractUserText
 *
 * Extraction semantics (in priority order):
 *
 *   0) CC client internal prompts / tool_result impersonation / session-init receipts,
 *      and the DSH plain-text `Current runtime context.` snapshot -> discard the whole message and return "",
 *      from which the caller decides that this turn is not written to L0 / does not enter the skill buffer
 *
 *   1) An explicit `<user_query>...</user_query>` block (CodeBuddy standard + some CC templates)
 *      -> extract only the joined block contents, unaffected even if the same message also contains a session-init form
 *
 *   2) With no user_query, strip in order:
 *      - `<question_answer>...</question_answer>` (session-init form fill-in)
 *      - common XML wrappers (system-reminder / additional_data / user_info /
 *        open_and_recently_viewed_files / session / persisted-output /
 *        tool_use_error / tool_result, etc.)
 *      - single-line tool echoes (Bash completed / Read's cat -n format / Write success receipts)
 *      - MEMORY.md-style yaml frontmatter blocks
 *      - leftover title lines "Session Init — ..." (legacy Chinese marker "会话初始化" also matched for old sessions)
 *      -> whatever remains after stripping is what the user typed
 *
 * Migration history: this file was extracted from tdai/recorder.ts (originally private to tdai); semantics unchanged.
 * See the appendix of docs/design/2026-07-30-cc-request-routing-plan.md + the codebuddy adapter
 * packet-capture conclusions.
 */

/**
 * Title marker of the session initialization (choose Team / Agent / task) form Q&A.
 * Used to strip leftover title lines; real user input is unaffected.
 */
const SESSION_INIT_TITLE_MARKERS = ["Session Init", "会话初始化"];

/**
 * Recognizer for "internal auxiliary prompts" that the Claude Code CLI stuffs into the conversation stream with role=user.
 *
 * Scenario: the CC client uses role=user to carry many kinds of content that is **not real user input**; if the whole message matches
 * any pattern, it is judged "non-human input" -> this turn is not written to L0, to avoid polluting the memory store.
 *
 * Match rule design:
 *   - an obvious CC pattern marker appears at the **start** of the whole message ([SUGGESTION MODE], [TITLE MODE], etc.);
 *   - or CC structured metadata JSON ({"parentUuid": ..., "promptId": ...});
 *   - or a system-level recap/summary prompt ("The user stepped away and is coming back...");
 *   - or the receipt of a session-init AskUserQuestion ("Your questions have been answered:");
 *   - or the typical format of tool output disguised as user ("(Bash completed with no output)",
 *     `<persisted-output>` large-file placeholder, CC timestamp log blocks).
 *
 * Matching uses startsWith / whole-string anchoring -- does not hurt real user input.
 */
const CC_INTERNAL_PROMPT_PATTERNS: RegExp[] = [
  // CC pattern marker: [XXX MODE: ...] / [XXX: ...]
  /^\s*\[(?:SUGGESTION|TITLE|SUMMARY|COMPACT|COMPACTION|ANALYSIS|EVAL|RECAP|MEMORY|SIDECHAIN)\s+MODE[:\s]/i,
  // CC session resume prompt (defined in core prompts/session-resume)
  /^\s*The user stepped away and is coming back\.\s*Recap/i,
  // AskUserQuestion receipt (session-init or runtime Q&A)
  /^\s*Your questions have been answered:\s*"/i,
  // CC structured promptId metadata JSON (first char is a digit + JSON, or JSON metadata directly)
  /^\s*\d+\s*\{"parentUuid"|^\s*\{"parentUuid":\s*"[^"]+","isSidechain"/,
  // CC replays the conversation log with a timestamp prefix ([2026-07-11T...][user] / [assistant])
  /^\s*\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\]]*\]\[(?:user|assistant|system)\]/,
  // Note: <persisted-output> / (Bash completed with no output) are moved to the wrapper-stripping layer of 2b/2c --
  //     they are often concatenated into the same user message as the user's next sentence,
  //     so only they themselves should be stripped, keeping the user's subsequent input.
];

function isClaudeCodeInternalPrompt(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return CC_INTERNAL_PROMPT_PATTERNS.some((re) => re.test(t));
}

/**
 * DSH appends the runtime environment snapshot as a separate `role=user` message after the real question.
 * Fixed prefix, the same anchor as the session-init skip logic, to prevent L0 from treating harness metadata
 * as user input. Real user questions do not start with this English passage.
 */
export const DSH_RUNTIME_CONTEXT_PREFIX = "Current runtime context.";

export function isDshRuntimeContextSnapshot(text: string): boolean {
  return text.trimStart().startsWith(DSH_RUNTIME_CONTEXT_PREFIX);
}

/**
 * Extract what the user actually typed from the raw user content text.
 *
 * Returning an empty string means "this user message is entirely harness noise", from which the caller should
 * decide not to write L0 / not to enter the skill buffer / not to match mem commands.
 *
 * The parameter `raw` must already be a **string** (array content is joined by the caller -- see
 * each of the agent-adapters' extractUserText implementations).
 */
export function extractUserQueryText(raw: string): string {
  // 0) CC internal prompt / tool_result impersonation / form receipt -> discard the whole message (not written to L0)
  //    This is the highest priority: even if it also contains <user_query>, the whole message is judged non-human input.
  //    Real user input does not hit these patterns anchored at the start / whole string.
  if (isClaudeCodeInternalPrompt(raw)) return "";
  // DSH runtime-context snapshot: plain text, no XML wrapper, must be discarded entirely,
  // otherwise extractLatestUserMessage scanning from back to front would treat it as a real question and write it to L0.
  if (isDshRuntimeContextSnapshot(raw)) return "";

  // 1) Preferred: an explicit <user_query> block (even if the same message is interleaved with session-init Q&A,
  //    only the real query is taken, and the user input is fully preserved).
  const queries: string[] = [];
  const re = /<user_query>([\s\S]*?)<\/user_query>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const inner = m[1].trim();
    if (inner) queries.push(inner);
  }
  if (queries.length > 0) return queries.join("\n\n");

  // 2) No explicit user_query: strip all "not typed by the user" content fragments, keeping the remaining
  //    real user input. Core principle: only text the user typed by hand deserves L0; all tool echoes
  //    / system reminders / file bodies / form artifacts / CC local memory content -- all stripped.
  let text = raw;

  // 2a) session-init form answer <question_answer>...</question_answer>
  text = text.replace(/<question_answer[^>]*>[\s\S]*?<\/question_answer>/gi, "");

  // 2b) XML wrapper kinds: various harness segments CC / CodeBuddy stuff into the user role
  //     - system-reminder / system_reminder (both spellings covered)
  //     - additional_data (CB puts this in the first segment of every user message: current_time etc.)
  //     - user_info (OS/shell/workspace metadata CB stuffs into the first user message)
  //     - open_and_recently_viewed_files
  //     - session (the session context wrapper the proxy injects itself)
  //     - persisted-output (CC "Output too large" large-file placeholder)
  //     - tool_use_error / tool-use-error / tool-result / tool_result (fake wrappers)
  for (const tag of [
    "system-reminder", "system_reminder",
    "additional_data",
    "user_info",
    "open_and_recently_viewed_files",
    "session",
    "persisted-output", "persisted_output",
    "tool_use_error", "tool-use-error",
    "tool_result", "tool-result",
    // The proxy may prepend L1 recall inside a user-role message. It is
    // context for the model, not text typed by the user.
    "tdai_recalled_l1_memories",
  ]) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }

  // 2c) Line-level filtering: single-line matching tool echoes / file fragments / memory frontmatter
  //     each rule judges a single line; on a match the line is deleted; user input on other lines is not blocked.
  const LINE_DROP_PATTERNS: RegExp[] = [
    // CC Write/Edit tool success receipt
    /^\s*The file .+ has been (updated|created) successfully.*$/i,
    /^\s*File created successfully at:/i,
    // CC Bash tool silent completion
    /^\s*\(Bash completed with no output\)\s*$/,
    /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/,
    // CC read tool cat -n line-number format ("     1  content" / "1  content")
    // Requiring at least 3 digits is stricter; 1-2 digits may conflict with user input (e.g. user list "1 abc")
    // so here we only match "digits + 2 spaces + content" with no other characters at the line start -- the cat -n specific format
    /^\s{0,6}\d+\t/,   // cat -n separates with a tab (the standard format of the Read tool)
    // MEMORY.md related: output produced by CC session_init/memory commands
    /^\s*File .+ has been (updated|created)/i,
  ];
  text = text
    .split("\n")
    .filter((line) => !LINE_DROP_PATTERNS.some((re) => re.test(line)))
    .join("\n");

  // 2d) Block-level stripping: MEMORY.md yaml frontmatter (--- to ---, including metadata)
  //     Format:
  //       ---
  //       name: ...
  //       description: ...
  //       metadata: ...
  //       ---
  //     Only matches frontmatter that "contains at least the name / description / metadata / node_type keywords"
  //     to avoid hurting markdown horizontal rules.
  text = text.replace(
    /(?:^|\n)---\s*\n(?:[a-z_][a-z0-9_]*:\s*.*\n)*?(?:name|description|metadata|node_type|originSessionId):[\s\S]*?\n---\s*(?:\n|$)/gi,
    "\n",
  );

  // 2e) Leftover session initialization form title lines (e.g. "Session Init — choose Agent and task"; legacy Chinese "会话初始化 — ..." also matched)
  text = text
    .split("\n")
    .filter((line) => !SESSION_INIT_TITLE_MARKERS.some((m) => line.includes(m)))
    .join("\n");

  // 2f) Collapse extra blank lines (large blank runs may remain after the earlier stripping)
  text = text.replace(/\n{3,}/g, "\n\n");

  // The remainder is the user's real input; if the whole message was CC artifacts, it becomes empty here naturally -> not written to L0.
  return text.trim();
}
