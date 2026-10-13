/**
 * task-draft-generator - LLM draft generator for mem:create-task / mem:update-task.
 *
 * A module where the proxy proactively issues requests to the LLM, calling OpenAI-compatible
 * chat/completions directly with AbortSignal.timeout, without any third-party SDK.
 *
 * On failure it returns { ok: false, error } (an explicit error), because a Task is a persistent entity
 * and a bad draft would pollute the store; the upper-layer command appends the error to the failure message.
 *
 * Used by: mem-command/commands/create-task.ts / update-task.ts (stage 3.2 / 3.3)
 *
 * Reference: docs/design/... TODO(stage 5) add design doc
 */

/** LLM endpoint configuration. */
export interface TaskDraftConfig {
  /** Master switch. Defaults to false -- when disabled the command layer returns a "not configured" error directly. */
  enabled: boolean;
  /** Model name, e.g. "deepseek-v3-0324". */
  model: string;
  /**
   * API endpoint base (without the specific endpoint). Joined according to protocol:
   *   openai:    `${url}/chat/completions`
   *   anthropic: `${url}/v1/messages`
   *   responses: `${url}/responses`
   */
  url: string;
  /** API Key. openai/responses use Bearer, anthropic uses x-api-key. */
  apiKey: string;
  /** Per-call timeout (ms). 15000-30000 recommended (the draft must be written in full). */
  timeoutMs: number;
  /**
   * Upstream API family. Defaults to "openai" (chat/completions).
   * Determines the shape of the request URL / headers / body / response parsing in attemptDraftOnce.
   */
  protocol?: "openai" | "anthropic" | "responses";
}

/** Recent conversation message snippet (gives the LLM context). */
export interface DraftMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Existing Task (required in update mode). */
export interface CurrentTask {
  title: string;
  description: string;
  status: string;
}

/** Generator input. */
export interface TaskDraftInput {
  /** create: create a new task; update: decide changes and rewrite based on the existing task. */
  mode: "create" | "update";
  /** Extra hint (reason) the user wrote after mem:create-task/update-task; may be empty. */
  hint?: string;
  /** Recent conversation messages (the proxy slices them from sessionMessages, usually the latest 30). */
  recentMessages: DraftMessage[];
  /** Required in update mode, ignored in other modes. */
  currentTask?: CurrentTask;
  /**
   * Only effective in create mode. The user already wrote a title after mem:create-task, and the proxy locks it:
   * the LLM only generates the description from the conversation, and the returned title field is ignored.
   * The upstream caller must pass lockedTitle down itself (the generator does not truncate to 40 chars; the caller guarantees it).
   */
  lockedTitle?: string;
}

/** Generator output: on success carries a structured draft; on failure carries an error message. */
export type TaskDraftResult =
  | {
      ok: true;
      title: string;
      description: string;
      /** Suggested status, which the model may provide (optional). */
      suggestedStatus?: string;
      /**
       * Only meaningful in update mode. false means "the recent conversation produced no new progress; the Task needs no update" -- the upper layer
       * should return "Task needs no update" to the user directly and skip the dialog flow. Always true in create mode.
       */
      changed: boolean;
    }
  | { ok: false; error: string };

/**
 * Status validation (relaxed):
 *   Per the TAPD requirement & user decision, the proxy does not validate status against an enum; whatever the LLM emits is passed through;
 *   only trim + empty/non-string filtering is done, and the kernel finally decides whether to accept it.
 */
const MAX_STATUS_LEN = 40;
/** Output schema limits. */
const MAX_TITLE_LEN = 40;
const MAX_DESC_LEN = 300;
/** Recent conversation truncation (prevents an overlong prompt). */
const MAX_RECENT_MSGS = 30;
const MAX_MSG_CONTENT_LEN = 800;
/**
 * Token limit for a single LLM generation.
 *
 * Raised from 800 to 2000 (fixed 2026-08-18): in practice the total of desc + title + status + JSON
 * structural characters often exceeds 800 in mixed Chinese/English scenarios and got truncated, so the JSON ended midway and parsing failed.
 * Reference: wiki-ingest uses 8192, the L1 extractor uses 4096; here the draft output is limited to title<=40
 * + desc<=300 + status, theoretical max ~800 characters -> a 2000 token limit leaves ample headroom.
 */
const LLM_MAX_TOKENS = 2000;

/**
 * LLM call retry policy (added 2026-08-18).
 *
 * Scenario: the LLM occasionally flakes (empty object / truncation / timeout), so single-call success is below 100%,
 * but the chance of 2 consecutive empty-object/truncated results is very low. From the user's view it is seamless: one click = one success.
 *
 * Parameters:
 *   - LLM_RETRY_MAX_ATTEMPTS=4: 4 chances in total (1 initial attempt + 3 retries)
 *   - LLM_RETRY_BASE_DELAY_MS=200: exponential backoff base; attempts 2/3/4 wait 200/400/800ms respectively
 *
 * When to retry: retry whenever attemptDraftOnce returns ok=false (no distinction between error types,
 * since empty object / truncation / schema violation / upstream 5xx are all cases where "trying again may just work").
 * When not to retry: cfg.enabled=false / parameter validation fails / all attempts failed.
 */
const LLM_RETRY_MAX_ATTEMPTS = 4;
const LLM_RETRY_BASE_DELAY_MS = 200;

/**
 * Timeout cap for the first attempt (2026-08-20): in production the gateway occasionally hangs for 20-30s,
 * and using cfg.timeoutMs (default 30s) on the first try makes users wait. The first attempt now uses min(cfg.timeoutMs,
 * FIRST_TIMEOUT_MS=10s); after a timeout it backs off 200ms and retries, and the retry uses the full timeoutMs
 * as a safety net for the "really slow but will succeed" case. Can be overridden by env TDAI_TASK_DRAFT_FIRST_TIMEOUT_MS.
 */
const LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT = 10_000;

function firstAttemptTimeoutMs(configuredTimeoutMs: number): number {
  const raw = process.env.TDAI_TASK_DRAFT_FIRST_TIMEOUT_MS;
  let cap = LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) cap = n;
  }
  // Must not exceed the configured value itself (otherwise the change has no effect)
  return Math.min(configuredTimeoutMs, cap);
}

/**
 * Smartly join the taskDraft request URL -- handles the pitfall where "the base tail may already contain a leading segment of the endpoint".
 *
 * ## Background (2026-09-01 fix for Claude Code 404)
 *
 * Convention of the main path (guard-adapter.joinUrl): the `/v1`, `/v2` tail in `upstream.agents[x].url`
 * is part of the base, and the endpoint only writes the trailing path segment (e.g. anthropic uses `/messages`).
 * For example in the config:
 *   claude-code.url = "https://copilot.tencent.com/v1"   (base carries a /v1 tail)
 *   codebuddy.url   = "https://copilot.tencent.com/v2"   (base carries a /v2 tail)
 *   codex.url       = "https://copilot.tencent.com"      (base is the root, no prefix)
 *
 * But the taskDraft generator, to be self-contained, writes the endpoint as a "full path":
 *   anthropic  -> "/v1/messages"
 *   openai     -> "/chat/completions" (unambiguous anyway)
 *   responses  -> "/responses"
 *
 * Plain `${base}${endpoint}` would break:
 *   base=".../v1" + endpoint="/v1/messages" -> ".../v1/v1/messages" ❌ 404
 *
 * ## Joining rules
 *
 * 1. base already ends with the whole endpoint -> return as-is (idempotent; handles a base that is already a full URL)
 * 2. base already ends with **a leading segment of** the endpoint (e.g. base=`.../v1`, endpoint=`/v1/messages`)
 *    -> strip that existing prefix from the endpoint and append only the rest (`.../v1/messages`)
 * 3. base and endpoint do not overlap -> join directly (`.../responses`)
 *
 * See the main path's joinUrl handling (guard-adapter.ts:326).
 */
export function joinTaskDraftUrl(base: string, endpoint: string): string {
  const normalized = base.replace(/\/+$/, "");
  // Rule 1: exact match
  if (normalized.endsWith(endpoint)) return normalized;
  // Rule 2: the endpoint can be split into segments (e.g. "/v1/messages" -> ["v1", "messages"]); from longest to shortest,
  // check whether base already carries a leading segment of the endpoint. Strip it on a hit.
  const segs = endpoint.split("/").filter(Boolean);
  for (let i = segs.length - 1; i > 0; i--) {
    const prefix = "/" + segs.slice(0, i).join("/");
    if (normalized.endsWith(prefix)) {
      return normalized + "/" + segs.slice(i).join("/");
    }
  }
  // Rule 3: no overlap, join directly
  return normalized + endpoint;
}

/**
 * Command keyword stripping table: the LLM sometimes copies the user's raw command verbatim into the title (e.g.
 * "Fix mem:create-task LLM ..."); such prefixes are redundant and eat the character budget.
 * Strip them when matched so the real semantic part fits within 40 characters.
 */
const COMMAND_KEYWORD_PATTERNS = [
  /^\s*(?:mem:[a-z-]+)\s*[:：、,，]?\s*/i,
  /^\s*(?:fix|refactor|update|create|add|remove)\s+mem:[a-z-]+\s*[:：、,，]?\s*/i,
];

/**
 * create-mode system prompt.
 *
 * Hardened 2026-08-18 (targeting the root cause of production failures):
 *   - use hard-constraint words such as STRICT / MUST NOT / NEVER instead of the earlier <= 40 (the LLM would overshoot)
 *   - add good and bad examples so the LLM knows exactly "what is too long" and "what is an empty object"
 *   - explicitly forbid empty objects: if info is insufficient, give a reasonable default to avoid `{}`
 */
const SYSTEM_PROMPT_CREATE = `You are a task drafting assistant for a coding agent's memory system.

Given the recent conversation, generate ONE task that captures what the user is currently working on.

STRICT rules (violations will be rejected):
- title: MUST be 1 to 40 characters. NEVER exceed 40. Imperative form preferred.
- description: MUST be 1 to 300 characters, plain text. Cover three parts in order:
    Background → Goal → Known constraints
- suggestedStatus: short lowercase word (e.g. "running", "completed").
- NEVER return an empty object {}. If the conversation is unclear, infer a reasonable
  task from the most recent user message and produce a best-effort title + description.

Examples of GOOD output:
  {"title":"Refactor auth module","description":"Background: existing auth logic is spread across 3 files. Goal: merge it into auth-service. Constraint: no changes to the public API.","suggestedStatus":"running"}

Examples of BAD output (DO NOT produce these):
  {}                                                     // ❌ empty object
  {"title":"Fix mem:create-task LLM JSON parse failure and add retry logic here"}  // ❌ title too long
  {"title":"Refactor","description":""}                  // ❌ empty description

Return ONLY the JSON object with keys: title, description, suggestedStatus. No prose, no markdown fence.`;

/** create-mode (title locked) system prompt -- only asks the LLM for the description. */
const SYSTEM_PROMPT_CREATE_LOCKED_TITLE = `You are a task drafting assistant for a coding agent's memory system.

The user has ALREADY specified the task title. Your ONLY job is to write a good description
based on the recent conversation that matches this title.

STRICT rules:
- description: MUST be 1 to 300 characters, plain text. Cover three parts:
    Background → Goal → Known constraints
- NEVER return an empty object {}. If unclear, infer a best-effort description from the title
  and most recent messages.
- Do NOT include title in the output (it is fixed by the user).

Return ONLY a JSON object with a single key: description. No prose, no markdown fence.`;

/** update-mode system prompt. */
const SYSTEM_PROMPT_UPDATE = `You are a task update assistant for a coding agent's memory system.

Given an existing task and recent conversation, decide:
1. Whether the conversation adds meaningful updates to the task.
2. If yes, produce an updated description and a suggested status.

Classify what changed into ONE OR MORE of these five categories (only if applicable):
  - goal changes
  - constraint changes
  - progress
  - linked resources / references
  - collaborating agents

STRICT rules:
- If NO meaningful update → return {"changed": false}
- If YES → return {"changed": true, "title": ..., "description": ..., "suggestedStatus": ...}
- title: keep the original title unchanged (return it as-is); the caller ignores any change.
- description: MUST be 1 to 300 characters, rewrite/merge current description with categorized new info.
- suggestedStatus: short lowercase word; prefer "completed" if conversation signals done, else "running".
- NEVER return an empty object {}. If truly no update, return {"changed": false} explicitly.

Return ONLY a JSON object. No prose, no markdown fence.`;

/**
 * Build the user message sent to the LLM.
 */
function buildUserMessage(input: TaskDraftInput): string {
  const lines: string[] = [];

  if (input.mode === "update" && input.currentTask) {
    lines.push(
      "=== Current Task ===",
      `Title: ${input.currentTask.title}`,
      `Description: ${input.currentTask.description}`,
      `Status: ${input.currentTask.status}`,
      "",
    );
  }

  if (input.mode === "create" && input.lockedTitle) {
    lines.push(
      "=== Task Title (fixed by user, DO NOT change) ===",
      input.lockedTitle,
      "",
    );
  }

  if (input.hint && input.hint.trim().length > 0) {
    lines.push("=== User Hint ===", input.hint.trim(), "");
  }

  lines.push("=== Recent Conversation ===");
  const msgs = input.recentMessages.slice(-MAX_RECENT_MSGS);
  for (const m of msgs) {
    const content = m.content.length > MAX_MSG_CONTENT_LEN
      ? `${m.content.slice(0, MAX_MSG_CONTENT_LEN)}...[truncated]`
      : m.content;
    lines.push(`[${m.role}] ${content}`);
  }

  return lines.join("\n");
}

/**
 * Extract a JSON object from the raw LLM output.
 *
 * Three-level fallback:
 *   1) direct JSON.parse -- covers the standard case
 *   2) strip the markdown fence (```json ... ``` or ``` ... ```) and then parse
 *   3) bracket-balanced scan: find the first `{`, pair forward to the matching `}`, slice the substring and parse
 *      -- covers cases where the LLM added natural language around it, e.g.:
 *      "Sure, here is the JSON: {...}", "Here you go:\n{...}\nHope this helps"
 *
 * The scan correctly handles `{` `}` `"` inside string literals (they do not count toward balancing).
 *
 * If all three levels fail, returns null (the caller produces a "LLM output is not valid JSON" error).
 */
export function extractJsonObject(raw: string): unknown | null {
  // 1) direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // fall-through
  }

  // 2) strip markdown fence
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall-through
    }
  }

  // 3) bracket-balanced scan
  const balanced = findBalancedJsonObject(raw);
  if (balanced !== null) {
    try {
      return JSON.parse(balanced);
    } catch {
      // fall-through
    }
  }

  return null;
}

/**
 * Bracket-balanced scan: find the first self-consistently closed `{...}` substring in raw.
 * The state machine handles string literals and escapes so `{}` inside strings does not disturb counting.
 */
function findBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Normalize a string field: trim + length validation.
 *
 * mode:
 *   - "strict" (default): return null when too long (legacy behavior, for cases that must be strict)
 *   - "clip": auto-truncate to maxLen when too long (keeps useful content; for title/description
 *     fields where "imperfect is better than failing")
 *
 * An empty string always returns null (no truncation can rescue an empty string).
 */
function normalizeStr(
  v: unknown,
  maxLen: number,
  mode: "strict" | "clip" = "strict",
): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > maxLen) {
    return mode === "clip" ? s.slice(0, maxLen).trim() : null;
  }
  return s;
}

/**
 * Strip a command-keyword prefix such as mem:xxx from the title.
 * The LLM often writes the user's current command into the title (e.g. "Fix mem:create-task JSON parse"),
 * and stripping it keeps the real semantic part within the length limit.
 * Only prefixes are stripped, not the middle; an empty match returns the input unchanged.
 */
function stripCommandKeywords(s: string): string {
  let out = s;
  for (const pat of COMMAND_KEYWORD_PATTERNS) {
    out = out.replace(pat, "");
  }
  return out.trim();
}

/** Normalize the status field: optional, may be missing; no enum validation, only basic cleanup. */
function normalizeStatus(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.length === 0 || s.length > MAX_STATUS_LEN) return undefined;
  return s;
}

/**
 * Generate a Task draft (with automatic retry).
 *
 * Outer responsibilities:
 *   - upfront parameter validation (no retry)
 *   - loop calling attemptDraftOnce, at most LLM_RETRY_MAX_ATTEMPTS times
 *   - log every failure (attempt=N/M reason=xxx), then retry after exponential backoff
 *
 * @returns { ok:true, ... } or { ok:false, error }
 */
export async function generateTaskDraft(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
): Promise<TaskDraftResult> {
  if (!cfg.enabled) {
    return { ok: false, error: "task_draft LLM disabled (config.memCommand.taskDraft.enabled=false)" };
  }
  if (input.mode === "update" && !input.currentTask) {
    return { ok: false, error: "update mode requires currentTask" };
  }
  if (!input.recentMessages || input.recentMessages.length === 0) {
    return { ok: false, error: "no recent messages to draft from" };
  }

  // Entry observability: every generateTaskDraft records the target upstream/model/protocol, to help match the handler's arguments
  console.log(
    `[task-draft] START mode=${input.mode} protocol=${cfg.protocol ?? "openai"} url=${cfg.url} model=${cfg.model} msgs=${input.recentMessages.length}${input.lockedTitle ? ` lockedTitle="${input.lockedTitle}"` : ""}`,
  );

  const systemPrompt =
    input.mode === "create"
      ? (input.lockedTitle ? SYSTEM_PROMPT_CREATE_LOCKED_TITLE : SYSTEM_PROMPT_CREATE)
      : SYSTEM_PROMPT_UPDATE;
  const userMessage = buildUserMessage(input);

  let lastError = "unknown";
  for (let attempt = 1; attempt <= LLM_RETRY_MAX_ATTEMPTS; attempt++) {
    const result = await attemptDraftOnce(cfg, input, systemPrompt, userMessage, attempt);
    if (result.ok) {
      // Success log (printed every time, to see the flake rate and actual attempt consumption)
      // When attempt>1 the RETRY_SUCCEEDED keyword is added, so log aggregation can count how often a flake eventually self-healed.
      const titlePreview = "title" in result && result.title
        ? result.title.length > 40 ? `${result.title.slice(0, 40)}...` : result.title
        : "(no-title)";
      const retryTag = attempt > 1 ? " RETRY_SUCCEEDED" : "";
      console.log(
        `[task-draft] OK${retryTag} mode=${input.mode} attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} title="${titlePreview}"${attempt > 1 ? ` prev_error=${JSON.stringify(lastError)}` : ""}`,
      );
      return result;
    }
    lastError = result.error;
    // Last failure, no more waiting
    if (attempt < LLM_RETRY_MAX_ATTEMPTS) {
      const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `[task-draft] mode=${input.mode} RETRY attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} error=${JSON.stringify(result.error)} next_delay_ms=${delay}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.log(
    `[task-draft] mode=${input.mode} ALL_ATTEMPTS_FAILED total=${LLM_RETRY_MAX_ATTEMPTS} last_error=${JSON.stringify(lastError)}`,
  );
  return { ok: false, error: `LLM draft failed after ${LLM_RETRY_MAX_ATTEMPTS} attempts: ${lastError}` };
}

/**
 * Single LLM call + result parsing. **Internal function; callers outside must not call it directly**.
 *
 * Same main logic as the old generateTaskDraft, except:
 *   - parameter validation moved to the outer layer
 *   - added finish_reason / usage / http_status observability logs (also printed on first success, to see the flake rate)
 *
 * The attempt parameter is only used for logging.
 */
async function attemptDraftOnce(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
  systemPrompt: string,
  userMessage: string,
  attempt: number,
): Promise<TaskDraftResult> {
  let resp: Response;
  // Use a short timeout on the first attempt (default 10s), and the full cfg.timeoutMs afterwards
  const effectiveTimeoutMs = attempt === 1 ? firstAttemptTimeoutMs(cfg.timeoutMs) : cfg.timeoutMs;
  const protocol = cfg.protocol ?? "openai";
  // Record the full joined URL for observability logs (to spot wrong path joins such as /v1/v1/messages)
  let fetchUrl = cfg.url;
  try {
    if (protocol === "anthropic") {
      // Anthropic Messages API: /v1/messages, system goes in a top-level field, x-api-key + anthropic-version
      // Join with joinTaskDraftUrl: base may already carry a /v1 tail (main-path convention), avoiding /v1/v1/messages
      // ⚠️ The copilot upstream **forces SSE streaming** for /v1/messages (a non-streaming request returns 200 + an event-stream body,
      // making JSON.parse blow up with "Unexpected token 'e', event: mes..."). So stream:true is set explicitly
      // and parseAnthropicStream accumulates content_block_delta. Same strategy as the openai branch.
      // ⚠️ The auth headers send both x-api-key (native Anthropic spec) and Authorization: Bearer (OpenAI-
      // style compatibility layers, e.g. rcaaitoken -- which uses the Anthropic Messages payload format but only accepts Bearer).
      // Native Anthropic ignores Authorization and compatibility layers ignore x-api-key, so there is no conflict on either side.
      fetchUrl = joinTaskDraftUrl(cfg.url, "/v1/messages");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          Authorization: `Bearer ${cfg.apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.model,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          temperature: 0.3,
          max_tokens: LLM_MAX_TOKENS,
          stream: true,
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } else if (protocol === "responses") {
      // OpenAI Responses API: /responses, instructions go in a top-level field, input[] is structured,
      // the token limit field is named max_output_tokens. Bearer auth.
      // The upstream codex base is the root (no /v1/v2 prefix), so rule 3 ("join directly") in joinTaskDraftUrl applies.
      // ⚠️ The copilot upstream likewise **forces SSE streaming** for /responses (a non-streaming request gets a 200 + event-stream
      // body back, and the client parsing it as JSON blows up with "Unexpected token 'e', event: res..."). So
      // stream:true is set explicitly and parseResponsesStream accumulates response.output_text.delta.
      // Same strategy as the anthropic/openai branches -- copilot forces streaming on all three protocols.
      fetchUrl = joinTaskDraftUrl(cfg.url, "/responses");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          instructions: systemPrompt,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: userMessage }] },
          ],
          temperature: 0.3,
          max_output_tokens: LLM_MAX_TOKENS,
          stream: true,
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } else {
      // OpenAI chat/completions (default).
      // ⚠️ The copilot upstream requires stream:true (non-streaming returns 400 "Non-stream chat request
      // is currently not supported"). So response_format is dropped (some upstreams do not accept it when streaming),
      // JSON relies on prompt constraints + the three-level extractJsonObject fallback. stream_options.include_usage
      // makes the upstream send one extra usage chunk at the end for observability.
      // base usually carries a /v2 tail (main-path convention), so rule 3 ("join directly") in joinTaskDraftUrl applies
      // yielding .../v2/chat/completions (endpoint and base do not overlap).
      fetchUrl = joinTaskDraftUrl(cfg.url, "/chat/completions");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: LLM_MAX_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=fetch_error protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model} error=${JSON.stringify(msg)}`,
    );
    return { ok: false, error: `LLM request failed: ${msg}` };
  }

  // Log the HTTP status of every upstream response (success or failure, to help locate wrong path joins / 401 / upstream 502 etc.)
  console.log(
    `[task-draft] mode=${input.mode} attempt=${attempt} HTTP status=${resp.status} protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model}`,
  );

  if (!resp.ok) {
    let errBodyPreview = "";
    try {
      const errText = await resp.text();
      errBodyPreview = errText.length > 500 ? `${errText.slice(0, 500)}...[truncated]` : errText;
    } catch {
      errBodyPreview = "[read body failed]";
    }
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=http_status status=${resp.status} protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model} body=${JSON.stringify(errBodyPreview)}`,
    );
    return { ok: false, error: `LLM upstream ${resp.status}` };
  }

  let finishReason = "unknown";
  let completionTokens = -1;
  let content: string | undefined;

  if (protocol === "openai") {
    // Streaming: read the SSE text, accumulate delta.content + the final finish_reason / usage
    const sse = await parseOpenAiStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  } else if (protocol === "anthropic") {
    // The Anthropic upstream likewise only supports SSE (the copilot one especially). Read the event stream and accumulate
    // content_block_delta.delta.text_delta.text; stop_reason / output_tokens come from
    // the usage field of the message_delta event.
    const sse = await parseAnthropicStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  } else {
    // responses: the copilot upstream likewise forces SSE. Accumulate the delta of response.output_text.delta events;
    // status / usage.output_tokens come from the response.completed event.
    const sse = await parseResponsesStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  }

  // All three protocol branches return early when content is empty, so content is guaranteed non-empty here
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "LLM response content empty" };
  }

  // Common observability fields (every FAIL log carries these, so the root cause is visible at a glance)
  const obs = `attempt=${attempt} protocol=${protocol} finish_reason=${finishReason} completion_tokens=${completionTokens}`;

  // Three-level fallback: direct parse -> markdown fence -> bracket-balanced scan
  const parsed = extractJsonObject(content);
  if (parsed === null) {
    // Key diagnostic log: print the first 500 chars of the raw LLM content, to identify which failure mode occurred
    // (standard case / markdown fence / natural language around it / no JSON at all)
    // finish_reason=length means max_tokens truncation, so the limit needs raising
    console.log(
      `[task-draft] mode=${input.mode} FAIL=json_parse ${obs} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not valid JSON" };
  }
  if (typeof parsed !== "object") {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=not_object ${obs} parsed_type=${typeof parsed} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  // update mode: check the changed field first
  if (input.mode === "update" && obj.changed === false) {
    // Return the currentTask values unchanged; with changed=false the upper layer skips the dialog directly
    return {
      ok: true,
      changed: false,
      title: input.currentTask!.title,
      description: input.currentTask!.description,
      suggestedStatus: input.currentTask!.status,
    };
  }

  // create mode + lockedTitle: title is forced to lockedTitle, only description is parsed
  //
  // Lenient policy (2026-08-18): description fails only when **entirely missing/empty/non-string**;
  // an overlong one is auto-truncated to MAX_DESC_LEN -- the LLM writing a few fewer characters beats returning an error to the user.
  if (input.mode === "create" && input.lockedTitle) {
    const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
    if (!description) {
      console.log(
        `[task-draft] mode=create-locked FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
      );
      return { ok: false, error: `description missing or empty` };
    }
    const suggestedStatus = normalizeStatus(obj.suggestedStatus);
    return {
      ok: true,
      changed: true,
      title: input.lockedTitle,
      description,
      ...(suggestedStatus ? { suggestedStatus } : {}),
    };
  }

  // Title normalization: strip the command-keyword prefix first, then use clip mode.
  //   Typical case: "Fix mem:create-task JSON parse failure" (42 chars, would be rejected for exceeding 40)
  //   -> strip "Fix mem:create-task " -> "JSON parse failure" (tighter and within the limit)
  const rawTitle = typeof obj.title === "string" ? stripCommandKeywords(obj.title) : obj.title;
  const title = normalizeStr(rawTitle, MAX_TITLE_LEN, "clip");
  if (!title) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=title ${obs} keys=${JSON.stringify(Object.keys(obj))} title_type=${typeof obj.title} title_len=${typeof obj.title === "string" ? obj.title.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `title missing or empty` };
  }
  const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
  if (!description) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `description missing or empty` };
  }
  const suggestedStatus = normalizeStatus(obj.suggestedStatus);

  return {
    ok: true,
    changed: true,
    title,
    description,
    ...(suggestedStatus ? { suggestedStatus } : {}),
  };
}

/**
 * Log helper: truncate long strings so an LLM flood does not blow up the logs.
 * 500 chars suffice to see the JSON structure and main content; the rest is marked with `...[truncated N]`.
 */
function previewContent(s: string): string {
  const MAX = 500;
  return s.length > MAX ? `${s.slice(0, MAX)}...[truncated ${s.length - MAX}]` : s;
}

/**
 * Log helper: serialize the parsed obj to a compact string and then truncate (keeping the structure).
 * Used in failure branches -- so that troubleshooting can see at a glance which fields and values the LLM actually filled in.
 */
function previewObj(obj: Record<string, unknown>): string {
  try {
    return previewContent(JSON.stringify(obj));
  } catch {
    return "[unserializable]";
  }
}

/**
 * Parse the SSE streaming response of OpenAI chat/completions.
 *
 * The copilot upstream only supports stream:true and returns `text/event-stream`, with each line shaped like
 * `data: {...}` and a trailing `data: [DONE]`. Here all `choices[].delta.content`
 * fragments are accumulated into the full body, recording the last non-empty finish_reason, plus
 * the completion_tokens of the final usage chunk when stream_options.include_usage=true.
 *
 * Returns null to indicate a stream read failure (body unreadable / no valid content).
 */
async function parseOpenAiStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue; // keep-alive / partial packets etc., ignore
    }

    const choices = evt.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      if (first.finish_reason && typeof first.finish_reason === "string") {
        finishReason = first.finish_reason;
      }
      const delta = first.delta as Record<string, unknown> | undefined;
      const deltaContent = delta?.content;
      if (typeof deltaContent === "string" && deltaContent.length > 0) {
        parts.push(deltaContent);
      }
    }

    const usage = evt.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage.completion_tokens === "number") {
      completionTokens = usage.completion_tokens;
    }
  }

  const content = parts.join("");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}

/**
 * Parse the SSE streaming response of the Anthropic Messages API.
 *
 * The copilot upstream forces SSE (`text/event-stream`) for /v1/messages, in the format:
 *   event: message_start
 *   data: {"type":"message_start", "message":{...,"usage":{"input_tokens":N,"output_tokens":M}}}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 * Extraction:
 *   - content = all content_block_delta.delta.text_delta.text concatenated in order
 *   - finishReason = message_delta.delta.stop_reason (unknown if absent)
 *   - completionTokens = message_delta.usage.output_tokens
 *     (if the upstream puts output_tokens in message_start.message.usage, that is also picked up; the last value overrides)
 *
 * Consistent with parseOpenAiStream: ignore `event:` lines, ignore keep-alive/partial JSON,
 * ignore non-text_delta deltas (e.g. input_json_delta is for tool_use and not needed here).
 *
 * Returns null to indicate: body unreadable / content empty at the end of accumulation (no text_delta).
 */
async function parseAnthropicStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // Only `data:` lines matter; `event:` lines only separate events and carry no payload
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue; // keep-alive / partial packets etc., ignore
    }

    const evtType = evt.type;

    // 1) content_block_delta: accumulate text
    if (evtType === "content_block_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta && delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        parts.push(delta.text);
      }
      continue;
    }

    // 2) message_delta: get stop_reason + output_tokens
    if (evtType === "message_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.stop_reason === "string") {
        finishReason = delta.stop_reason;
      }
      const usage = evt.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number") {
        completionTokens = usage.output_tokens;
      }
      continue;
    }

    // 3) message_start: some upstreams put output_tokens here (may be 0/1; pick it up as a fallback first)
    if (evtType === "message_start") {
      const message = evt.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number" && completionTokens < 0) {
        completionTokens = usage.output_tokens;
      }
      continue;
    }
    // Other events (content_block_start / content_block_stop / message_stop / ping) need no handling
  }

  const content = parts.join("");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}

/**
 * Parse the SSE streaming response of the OpenAI Responses API.
 *
 * The copilot upstream forces SSE (`text/event-stream`) for /responses. Event stream format (
 * see https://platform.openai.com/docs/api-reference/responses-streaming):
 *
 *   event: response.created
 *   data: {"type":"response.created","response":{"id":"resp_x","status":"in_progress",...}}
 *
 *   event: response.output_item.added
 *   data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message",...}}
 *
 *   event: response.content_part.added
 *   data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text",...}}
 *
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"..."}
 *
 *   event: response.output_text.done
 *   data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"full text"}
 *
 *   event: response.completed
 *   data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":42},...}}
 *
 * Extraction:
 *   - content = all response.output_text.delta.delta concatenated in order
 *     (fallback: if there is no delta event but there is response.output_text.done, use done.text directly)
 *   - finishReason = response.completed.response.status ("completed" / "incomplete" etc.)
 *   - completionTokens = response.completed.response.usage.output_tokens
 *
 * Ignore event: separator lines / partial JSON / other unrecognized events (such as response.in_progress,
 * response.output_item.done, response.reasoning_summary_* etc.).
 *
 * Returns null to indicate: body unreadable / content empty at the end of accumulation.
 */
async function parseResponsesStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  // Fallback: if the upstream sends no delta and only a single output_text.done (rare but allowed by the spec),
  // keep the last done.text as the fallback.
  let doneText: string | null = null;
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue;
    }

    const evtType = evt.type;

    // 1) response.output_text.delta: main path, accumulate incremental text
    if (evtType === "response.output_text.delta") {
      const delta = evt.delta;
      if (typeof delta === "string" && delta.length > 0) {
        parts.push(delta);
      }
      continue;
    }

    // 2) response.output_text.done: fallback, take the full text (used as a fallback when there is no delta)
    if (evtType === "response.output_text.done") {
      const t = evt.text;
      if (typeof t === "string" && t.length > 0) {
        doneText = t;
      }
      continue;
    }

    // 3) response.completed: take the final status / usage
    if (evtType === "response.completed") {
      const response = evt.response as Record<string, unknown> | undefined;
      if (response) {
        if (typeof response.status === "string") {
          finishReason = response.status;
        }
        const usage = response.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage.output_tokens === "number") {
          completionTokens = usage.output_tokens;
        }
      }
      continue;
    }
    // Other events (response.created / response.in_progress / response.output_item.* /
    // response.content_part.* / response.reasoning_summary_* / ping etc.) need no handling
  }

  // Prefer the delta-concatenated result; fall back to done.text only when there are no deltas at all
  const content = parts.length > 0 ? parts.join("") : (doneText ?? "");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}
