/**
 * SkillExtractor — extraction entry point accepting structured ExtractMessage[]
 *
 * Differences from the old SkillExtractor:
 *   - the input messages must be `ExtractMessage[]`; bare strings are no longer accepted
 *   - internally joins the messages into a transcript (keeping role markers)
 *   - tool calls go through SkillToolsV2 (operating on SkillCore)
 *   - candidates are returned in the ExtractedSkillCandidate shape (including skill_id / version)
 *
 * Every call goes through the LLM, with no conversation-level dedup/caching — the caching mechanism has been removed.
 */

import type { ExtractMessage } from "./types.js";
import type { SkillCore } from "./skill-core.js";
import { createSkillTools, type ExtractedSkillCandidate } from "./skill-tools.js";
import type {
  ISkillExtractor,
  ConversationMessage,
  ExtractedCandidate,
} from "./queue/types.js";
import { metricProducer } from "../report/kafka-metric-producer.js";
import { trace } from "../report/trace.js";
import { obsLogger } from "../report/obs-logger.js";

const TAG = "[skill-extractor]";

export interface ExtractorRunner {
  run(params: {
    prompt: string;
    systemPrompt?: string;
    tools?: Record<string, unknown>;
    enableTools?: boolean;
    maxIterations?: number;
    /** Output token cap; if omitted the runner falls back (the standard runner uses llm.maxTokens). */
    maxTokens?: number;
    taskId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Langfuse trace name (for UI filtering and naming, see LLMRunParams in core/types.ts). */
    traceName?: string;
    /** Langfuse tags (for UI filtering). */
    tags?: string[];
    /** Langfuse top-level sessionId. */
    sessionId?: string;
    /** Langfuse top-level userId. */
    userId?: string;
    /** Instance id; passed through as the telemetry instanceId (when missing the runner falls back to "unknown"). */
    instanceId?: string;
  }): Promise<string>;
}

export interface ExtractorOptions {
  core: SkillCore;
  runner?: ExtractorRunner;
  systemPrompt?: string;
  /**
   * Strict systemPrompt used for cold start / bulk import (SKILL_REVIEW_PROMPT_STRICT).
   * Enabled only when extract()'s input.mode==='strict' and this field has been injected; otherwise always
   * uses systemPrompt (backward compatible). Production wiring (tdai-core / server) injects
   * SKILL_REVIEW_PROMPT_STRICT by default; the test environment does not inject it → old behavior completely unchanged.
   */
  strictSystemPrompt?: string;
  maxIterations?: number;
  /** Transcript head-tail truncation: chars to keep from the start (default 8000). */
  headChars?: number;
  /** Transcript head-tail truncation: chars to keep from the end (default 32000). */
  tailChars?: number;
  /**
   * Output token cap for a single Skill review LLM call. If omitted → the runner inherits llm.maxTokens.
   * Configured independently of llm.maxTokens: skill review output (including the full SKILL.md
   * text inside tool-call parameters) is usually larger than other stages and may need to be raised separately.
   */
  maxTokens?: number;
  /**
   * Cap on the number of pre-retrieved skill list entries (shared by relevant BM25 search & the recent fallback).
   * Constructor default 0 (disabled); the production wiring layer (tdai-core / server) explicitly passes in
   * resolved.extraction.prefixSkillsLimit (default 20) from skill-config. When tests construct it with no arguments,
   * no extra query-gen LLM call is triggered.
   */
  prefixSkillsLimit?: number;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface ExtractInput {
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
  session_id?: string;
  /** Instance id (= space_id); passed through as the runner telemetry's instanceId. */
  space_id?: string;
  messages: ExtractMessage[];
  options?: {
    max_iterations?: number;
  };
  /** The main Agent's extraction hint; when present it is injected at the very front of the extraction LLM's user prompt. */
  reason?: string;
  /**
   * Extraction mode:
   *   - omitted / 'default': uses systemPrompt (SKILL_REVIEW_PROMPT v2 lenient version)
   *   - 'strict'        : uses strictSystemPrompt (SKILL_REVIEW_PROMPT_STRICT
   *                       v1 strict gate); if strictSystemPrompt was not injected, falls back to
   *                       systemPrompt (no crash).
   * Cold start / bulk import scenarios (agents/asset-import.ts) should pass 'strict'; everyday real-time
   * extraction can omit it, and behavior matches the historical version.
   */
  mode?: 'default' | 'strict';
}

export interface ExtractResult {
  candidates: ExtractedSkillCandidate[];
  text?: string;
}

export class SkillExtractor {
  private readonly core: SkillCore;
  private readonly runner?: ExtractorRunner;
  private readonly systemPrompt: string;
  /** Strict prompt for cold start / bulk import; when undefined, mode==='strict' also falls back to systemPrompt. */
  private readonly strictSystemPrompt?: string;
  private readonly maxIterations: number;
  private readonly headChars: number;
  private readonly tailChars: number;
  private readonly maxTokens?: number;
  private readonly prefixSkillsLimit: number;
  private readonly logger?: ExtractorOptions["logger"];

  constructor(opts: ExtractorOptions) {
    this.core = opts.core;
    this.runner = opts.runner;
    this.systemPrompt = opts.systemPrompt ?? "You are a Skill Review Agent. Use tools to look at existing skills, decide what to add/improve, and call skill_create / skill_update / skill_patch / skill_files_write to persist.";
    this.strictSystemPrompt = opts.strictSystemPrompt;
    this.maxIterations = opts.maxIterations ?? 16;
    this.headChars = opts.headChars ?? 8000;
    this.tailChars = opts.tailChars ?? 32000;
    this.maxTokens = opts.maxTokens;
    // Constructor default 0 (disables prefix injection → no extra query-gen LLM call is triggered);
    // production wiring explicitly passes resolved.extraction.prefixSkillsLimit (default 20).
    // <0 or non-numeric falls back to 0 (equivalent to disabled), rather than silently changing to 20 — we do not want a config error
    // to turn into "an unexpected extra LLM call".
    const rawLimit = opts.prefixSkillsLimit;
    this.prefixSkillsLimit = rawLimit === undefined
      ? 0
      : (Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.floor(rawLimit) : 0);
    this.logger = opts.logger;
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const { messages } = input;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("ExtractV2: messages must be a non-empty array of ExtractMessage");
    }
    // [obs] one summary event per extraction; the LLM's internal iterations go through the langfuse trace (trace.report
    // → OTel Span → Langfuse SpanProcessor filtered reporting); here only an "entry → exit"
    // summary of duration / candidate count is recorded, using task_id as the anchor to align with the worker segment. obsLogger
    // has internal try/catch + FileLogger + backend degradation; even if the logger dies, the extraction itself is unaffected.
    const t0 = Date.now();
    const transcript = formatTranscript(messages);

    const truncated = truncateHeadTail(transcript, this.headChars, this.tailChars);

    // Pre-retrieve the skill list and put it in front of the user prompt, so the review agent sees right from the start
    // which skills the agent already owns (avoiding blind skill_create hitting SKILL_NAME_DUPLICATE).
    //
    // Three modes, determined jointly by prefixSkillsLimit + the total number of skills the agent owns:
    //   full     — total ≤ limit: inject all; no query-gen LLM spend.
    //   relevant — total > limit + query-gen succeeds + BM25 hits ≥1: relevance first.
    //   recent   — total > limit + relevant failed (query-gen threw / empty / 0 hits):
    //              fall back to the top-N by updated_at DESC + an "X more not shown" hint.
    //   none     — prefixSkillsLimit=0 or total=0.
    //
    // Key: a single core.list({ limit }) gets both items + total, reused by all later branches,
    // with no second DB query; the total ≤ limit scenario skips query-gen directly, so coverage is actually higher.
    let prefixBlock = "";
    let prefixMode: "full" | "relevant" | "recent" | "none" = "none";
    let prefixQuery: string | undefined;
    if (this.prefixSkillsLimit > 0) {
      let recentPage: Awaited<ReturnType<typeof this.core.list>> | null = null;
      try {
        recentPage = await this.core.list({
          user_id: input.user_id,
          team_id: input.team_id,
          agent_id: input.agent_id,
          pagination: { limit: this.prefixSkillsLimit },
        });
      } catch (e) {
        // if list fails → no data is available for later branches either; go straight to the none branch.
        this.logger?.warn(`${TAG} prefix list failed: ${(e as Error).message}`);
      }
      if (recentPage && recentPage.items.length > 0) {
        if (recentPage.total <= this.prefixSkillsLimit) {
          // Case full: got everything, spread it out directly; query-gen is skipped entirely.
          prefixBlock = renderFullSkillsBlock(recentPage.items);
          prefixMode = "full";
        } else {
          // Case relevant: total exceeds limit; spend one LLM query-gen + BM25 to find the most relevant ones.
          try {
            const relevant = await this.buildRelevantSkillsBlock(input, truncated);
            if (relevant) {
              prefixBlock = relevant.block;
              prefixMode = "relevant";
              prefixQuery = relevant.query;
            }
          } catch (e) {
            this.logger?.warn(`${TAG} buildRelevantSkillsBlock failed: ${(e as Error).message}`);
          }
          if (!prefixBlock) {
            // Case recent: relevant failed; fall back to the top-N obtained at the start, with an
            // "X more not shown" hint so the LLM knows it can pull more manually via skill_list.
            prefixBlock = renderRecentSkillsBlock(recentPage.items, recentPage.total);
            prefixMode = "recent";
          }
        }
      }
    }
    let prompt = prefixBlock ? `${prefixBlock}\n\n---\n\n${truncated}` : truncated;

    // inject the main Agent's extraction hint (placed at the very front of the prompt when reason is non-empty)
    if (input.reason && input.reason.trim().length > 0) {
      const hintBlock = [
        "## Extraction hint from the main Agent",
        "The following is the main Agent's description of this conversation; please refer mainly to its intent when extracting:",
        input.reason,
      ].join("\n");
      prompt = `${hintBlock}\n\n---\n\n${prompt}`;
    }

    const auditSink: ExtractedSkillCandidate[] = [];

    // Choose the systemPrompt: cold-start/bulk-import mode goes strict, otherwise the default v2.
    // Key backward compatibility:
    //   - input.mode omitted / 'default'   → always use this.systemPrompt (zero regression for old traffic)
    //   - input.mode === 'strict' but the constructor did not inject strictSystemPrompt (test environment /
    //     un-upgraded wiring) → fall back to this.systemPrompt (no crash, no silent behavior change)
    const effectiveSystemPrompt = input.mode === 'strict' && this.strictSystemPrompt
      ? this.strictSystemPrompt
      : this.systemPrompt;
    // For observability: record the mode actually in effect (judged against input, rather than "whether the strict prompt was truly enabled").
    //   requested_strict = whether upstream requested strict mode
    //   effective_mode   = which prompt was actually used (strict / default)
    // Makes it easy to count whether wiring missed injecting strictSystemPrompt (a mismatch between the two means it was missed).
    const effectiveMode: 'strict' | 'default' =
      input.mode === 'strict' && this.strictSystemPrompt ? 'strict' : 'default';

    if (!this.runner) {
      // No runner injected (test environment / disabled) → return empty candidates
      this.logger?.info(`${TAG} no runner provided; returning empty candidates`);
      obsLogger.info("skill.extractor.extract", {
        task_id: input.task_id,
        dur_ms: Date.now() - t0,
        msg_count: messages.length,
        candidates: 0,
        skipped: "no_runner",
        requested_mode: input.mode ?? 'default',
        effective_mode: effectiveMode,
      });
      return { candidates: [] };
    }

    const tools = createSkillTools({
      core: this.core,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      auditSink,
      logger: this.logger,
    });

    let text: string;
    try {
      text = await this.runner.run({
        prompt,
        systemPrompt: effectiveSystemPrompt,
        tools,
        enableTools: true,
        maxIterations: input.options?.max_iterations ?? this.maxIterations,
        maxTokens: this.maxTokens,
        taskId: `skill-extract-${input.task_id ?? "unknown"}`,
        // Langfuse trace semantics: give this extraction a stable name / filterable tags in the Langfuse UI.
        // See the traceName/tags/sessionId/userId comments of LLMRunParams in core/types.ts for details.
        traceName: "skill.extract",
        tags: [
          "skill-extract",
          `team:${input.team_id}`,
          `agent:${input.agent_id}`,
        ],
        sessionId: input.session_id,
        userId: input.user_id,
        instanceId: input.space_id,
      });
    } catch (e) {
      // One warn summarizes the failure, including task_id / err_name / dur — the Worker side then decides by classification
      // (transient / permanent) whether to requeue or DLQ. The exception is not swallowed here.
      const dur = Date.now() - t0;
      obsLogger.warn("skill.extractor.extract", {
        task_id: input.task_id,
        dur_ms: dur,
        msg_count: messages.length,
        candidates: auditSink.length,
        err_name: (e as Error).name,
        err_msg: (e as Error).message,
        requested_mode: input.mode ?? 'default',
        effective_mode: effectiveMode,
      });
      try {
        trace.report("skill.extractor.extract", {
          task_id: input.task_id,
          team_id: input.team_id,
          agent_id: input.agent_id,
          session_id: input.session_id,
          msg_count: messages.length,
          candidates: auditSink.length,
          dur_ms: dur,
          success: false,
          error: (e as Error).message,
          requested_mode: input.mode ?? 'default',
          effective_mode: effectiveMode,
        });
      } catch { /* noop */ }
      throw e;
    }

    try { metricProducer.send({ metric: "skill.extract.candidates", instanceId: input.team_id, value: auditSink.length }); } catch { /* noop */ }

    const dur = Date.now() - t0;
    obsLogger.info("skill.extractor.extract", {
      task_id: input.task_id,
      dur_ms: dur,
      msg_count: messages.length,
      candidates: auditSink.length,
      prompt_chars: prompt.length,
      prefix_mode: prefixMode,
      // Take only the first 60 characters (enough to identify keywords; longer is useless for obs).
      prefix_query: prefixQuery ? prefixQuery.slice(0, 60) : undefined,
      requested_mode: input.mode ?? 'default',
      effective_mode: effectiveMode,
    });
    try {
      trace.report("skill.extractor.extract", {
        task_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: input.session_id,
        msg_count: messages.length,
        candidates: auditSink.length,
        prompt_chars: prompt.length,
        dur_ms: dur,
        success: true,
        requested_mode: input.mode ?? 'default',
        effective_mode: effectiveMode,
      });
    } catch { /* noop */ }

    return { candidates: auditSink, text };
  }

  /**
   * Pre-retrieval of skills "possibly relevant to this conversation": have the runner use one lightweight LLM call to squeeze
   * 2-5 BM25 keywords out of the transcript, then go through core.search to get the top-N (bounded by
   * prefixSkillsLimit). On success and non-empty → returns { block, query }; if query is empty
   * / search has no hits / the runner is missing, returns null so upstream takes the recent fallback.
   *
   * Split into two steps (rather than merging the relevant retrieval directly into the review agent's iterations) because:
   *   1. it gives the review agent a concrete candidate pool right from the start, instead of first groping through a scan and then retrieving;
   *   2. query-gen is a short output (≤100 tokens), taking no review agent context;
   *   3. failure can be degraded precisely; running skill_list inside the review agent would only degrade to "all owner",
   *      whereas this function can choose relevant or recent.
   */
  private async buildRelevantSkillsBlock(
    input: ExtractInput,
    transcript: string,
  ): Promise<{ block: string; query: string } | null> {
    if (!this.runner) return null;

    const query = await this.generateSearchQueryFromTranscript(input, transcript);
    if (!query) return null;

    let hits: Awaited<ReturnType<typeof this.core.search>>;
    try {
      hits = await this.core.search({
        user_id: input.user_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        query,
        top_k: this.prefixSkillsLimit,
      });
    } catch (e) {
      this.logger?.warn(`${TAG} relevant search failed for query='${query}': ${(e as Error).message}`);
      return null;
    }
    if (!hits.length) return null;

    const lines = hits.map((h) => formatSkillLine(h.skill.name, h.skill.description));
    const block = [
      `## Skills possibly relevant to this conversation (query='${query}', BM25 prefetched)`,
      "These were retrieved by pre-running skill_list(query=...) against your own skill pool.",
      "If any of these already covers the topic, prefer `skill_update` / `skill_patch` over creating a duplicate.",
      ...lines,
    ].join("\n");
    return { block, query };
  }

  /**
   * Have the runner use one tool-less short LLM call to extract 2-5 BM25 keywords from the transcript.
   * The return value is sanitized (newlines / FTS5 reserved words turned into spaces; an empty string counts as failure). Any exception
   * thrown by the runner is thrown outward; upstream (buildRelevantSkillsBlock) will catch it and degrade.
   */
  private async generateSearchQueryFromTranscript(
    input: ExtractInput,
    transcript: string,
  ): Promise<string> {
    if (!this.runner) return "";
    const raw = await this.runner.run({
      systemPrompt: QUERY_GEN_SYSTEM_PROMPT,
      prompt: [
        "Below is a past conversation. Extract 2-5 short keywords (Chinese or English) that",
        "capture what the user was trying to do. These will feed a BM25 search over an",
        "existing skill library. Output the keywords on a single line, space-separated,",
        "no punctuation, no labels, no explanation.",
        "",
        "<<transcript>>",
        transcript,
        "<<end-of-transcript>>",
      ].join("\n"),
      enableTools: false,
      // Keep the runner from actually running a tool loop; use it as a plain completion.
      maxIterations: 1,
      // The keywords themselves are short (5 words × ~6 CJK chars), but the A₂ family of thinking models
      // (minimax-m3 inline `<think>` / minimax-m2.7 separate reasoning_content /
      // GLM-4-thinking / qwq-32b / DeepSeek-R1) first spend 100~500 tokens on
      // reasoning before emitting visible content. The historical maxTokens=64 would have cut
      // reasoning off at length, m2.7 got empty content and silently degraded to recent, and m3 got an unclosed
      // `<think>...` that after sanitize became a dirty BM25 query hitting random skills.
      // 8192 is a simple one-size-fits-all: the A₁ family (o1/o3/deepseek-v4-pro/no think) content
      // is still just a few words and will never hit the cap; the A₂ family's reasoning segment can run to completion before outputting
      // the keywords. query-gen is a single call, so the cost is controllable.
      maxTokens: 8192,
      taskId: `skill-extract-query-${input.task_id ?? "unknown"}`,
      // This traceName lets you filter this kind of query-gen call separately on Langfuse, apart from the main skill.extract.
      traceName: "skill.extract.query-gen",
      tags: [
        "skill-extract",
        "skill-extract-query-gen",
        `team:${input.team_id}`,
        `agent:${input.agent_id}`,
      ],
      sessionId: input.session_id,
      userId: input.user_id,
      instanceId: input.space_id,
    });
    return sanitizeGeneratedQuery(raw);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  helpers
// ═════════════════════════════════════════════════════════════════════

/**
 * Serialize ExtractMessage[] into a transcript for the Skill Review Agent to read.
 *
 * Key design (aligned with the "Role isolation" section of SKILL_REVIEW_PROMPT):
 *   - the role prefix uses an unnatural `<<past-xxx>>` double-angle-bracket tag, not `[user]` / `[assistant]`.
 *     The latter are the native role signals of chat completion, and the model instinctively treats the trailing
 *     `[assistant]` of the transcript as the anchor for "my turn to continue the next turn", directly continuing the main agent's reply.
 *     Atypical tags like `<<past-user>>` break this hint, making the model clearly aware that "this is historical content I am
 *     reviewing, not a role I should play".
 *   - append an `<<end-of-transcript>>` anchor at the end + a sentence "now decide per the
 *     output contract in the system prompt". Without this anchor, when the model sees the transcript end directly on
 *     a long assistant reply, it easily takes the path of "continue writing another passage in a similar style".
 *
 * Related background: docs/2026-07-28 skill extractor role-capture analysis (trace
 * f546ab8c-c7c5-4598-a310-6b2162372e7c, the extraction LLM completely ignored the SKILL_REVIEW_PROMPT
 * contract and produced a 1235-token continuation of the main conversation, with zero tool calls and zero "Nothing to save.").
 */
function formatTranscript(messages: ExtractMessage[]): string {
  const body = messages.map((m) => `<<past-${m.role}>>\n${m.content}`).join("\n\n");
  return `${body}\n\n<<end-of-transcript>>\nAbove is the past conversation to review. Now decide, and respond only per the output contract in the system prompt.`;
}

function truncateHeadTail(s: string, head: number, tail: number): string {
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n\n... [truncated ${s.length - head - tail} chars] ...\n\n${s.slice(-tail)}`;
}

/**
 * System prompt for "squeeze 2-5 BM25 keywords from the conversation".
 * Key points:
 *   1. state clearly that these keywords will be fed into BM25 → have the LLM pick high-signal words, not compose full sentences;
 *   2. Chinese and English both work; jieba will segment correctly;
 *   3. single-line output + no punctuation + no labels; post-hoc sanitize also enforces this shape.
 */
const QUERY_GEN_SYSTEM_PROMPT = [
  "You are helping build a BM25 keyword query.",
  "Given a past user↔assistant conversation, output 2-5 short high-signal keywords",
  "(Chinese or English mixed as they appear in the transcript) that best represent",
  "what the user was trying to accomplish.",
  "",
  "Rules:",
  "- Output ONLY the keywords, on a single line, separated by single spaces.",
  "- No punctuation, no quotes, no bullets, no labels, no explanation.",
  "- Do NOT invent topics not present in the transcript.",
  "- Prefer nouns / product names / verbs; drop filler words (the, a, 一下, 帮我).",
  "- If the transcript is empty or has no clear intent, output an empty line.",
].join("\n");

/**
 * Making the generated query valid:
 *   - take only the first line (the LLM sometimes first says "Here are the keywords:" and then a line)
 *   - strip FTS5 reserved words (AND/OR/NOT/NEAR) by deleting them directly (the BM25 layer falls back to buildFtsQuery)
 *   - strip common punctuation (punctuation makes the BM25 tokenizer jitter)
 *   - collapse whitespace, trim
 *   - conservative length: cap of 120 characters (5 words × ~24 char)
 * An empty string = considered that the LLM extracted nothing; upstream takes the recent fallback.
 */
export function sanitizeGeneratedQuery(raw: string): string {
  if (typeof raw !== "string") return "";
  // The A₂ family of thinking models (minimax-m3 / GLM-4-thinking / qwq-32b / some vLLM
  // DeepSeek-R1) embed reasoning as `<think>…</think>` inside content.
  // If not stripped first, the first non-empty line of `raw.split(/\r?\n/)` would be `<think>` or the think content,
  // and the later punctuation cleanup would turn `<` `>` into spaces → BM25 gets a dirty query, hits 0 → upstream degrades to
  // recent. The business keeps running, but pre-retrieval silently stops working. Same idea as l1-extractor.ts@ccaa5dc3:
  //   - non-greedy `*?` + mandatory </think> closing: a truncated think tag (stuck at max_tokens)
  //     does not match → kept as is → sanitize later treats it as noise → recent fallback
  //   - `g` flag: strip multiple think segments
  //   - the A₁ family (minimax-m2.7 / deepseek-v4-pro / o1 / o3) content has no <think>,
  //     so replace is a no-op → byte-for-byte equivalent, backward-compatible.
  raw = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  // Take only the first non-empty line — the LLM occasionally adds a metadata line before/after the keywords.
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!firstLine) return "";
  // Strip common punctuation / FTS5 reserved words. Replace with spaces rather than deleting, to avoid "foo,bar" becoming "foobar".
  const noPunct = firstLine
    .replace(/[,;:!?"'`()\[\]{}<>|/\\*+=~@#$%^&]/g, " ")
    .replace(/[，。；：！？、（）【】《》「」『』]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ");
  const collapsed = noPunct.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > 120 ? collapsed.slice(0, 120).trimEnd() : collapsed;
}

/**
 * Build a line "- name — description truncated to 100 chars". An empty description falls back to "- name".
 * Shared by the recent / relevant / full three blocks, to avoid line-format drift.
 */
function formatSkillLine(name: string, description?: string): string {
  const desc = (description ?? "").trim().replace(/\s+/g, " ");
  const short = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
  return short ? `- ${name} — ${short}` : `- ${name}`;
}

/**
 * "Full" prefix block — the agent's total skill count ≤ prefixSkillsLimit, spread out directly.
 * Semantically tells the LLM "these are all your skills, with nothing missing", a stronger prior than the recent segment.
 * No truncated hint on reuse (because nothing was truncated).
 */
function renderFullSkillsBlock(items: Array<{ name: string; description?: string }>): string {
  const lines = items.map((s) => formatSkillLine(s.name, s.description));
  return [
    `## Skills you (this agent) own (${items.length} total — full list, no truncation)`,
    "This is your entire skill inventory. Consider `skill_update` / `skill_patch` on an existing skill before creating a new one.",
    ...lines,
  ].join("\n");
}

/**
 * "Recently updated" prefix block — the fallback when the relevant branch fails. Comes with an "X more not shown"
 * hint, so the LLM knows it can proactively skill_list(query=...) to pull more.
 */
function renderRecentSkillsBlock(
  items: Array<{ name: string; description?: string }>,
  total: number,
): string {
  const lines = items.map((s) => formatSkillLine(s.name, s.description));
  const omitted = total - items.length;
  const header = `## Skills you (this agent) own (${items.length} most-recently-updated of ${total} total, prefetched via skill_list)`;
  const hint = omitted > 0
    ? `Most recent first. ${omitted} more not shown — call skill_list(query=...) to search the rest. Consider \`skill_update\` / \`skill_patch\` on an existing skill before creating a new one.`
    : "Most recent first. Consider `skill_update` / `skill_patch` on an existing skill before creating a new one.";
  return [header, hint, ...lines].join("\n");
}

// ═════════════════════════════════════════════════════════════════════
//  ISkillExtractor adapter — lets SkillConversationExtractWorker (agent queue)
//  drive the V2 extractor. The ISkillExtractor interface the Worker holds accepts
//  conversation: ConversationMessage[] + agent_id; here it is mapped into the V2
//  ExtractMessage[] shape.
// ═════════════════════════════════════════════════════════════════════

const ALLOWED_ROLES = new Set(["user", "assistant", "tool_call", "tool_result"]);

function toExtractMessages(conv: ConversationMessage[]): ExtractMessage[] {
  return conv.map((m) => ({
    role: (ALLOWED_ROLES.has(m.role) ? m.role : "user") as ExtractMessage["role"],
    content: m.content,
  }));
}

function toLegacyCandidates(items: ExtractedSkillCandidate[]): ExtractedCandidate[] {
  return items.map((c) => ({
    action: c.action as ExtractedCandidate["action"],
    name: c.name,
    skill_id: c.skill_id,
    version: c.version,
    description: c.description,
    confidence: c.confidence,
    reason: c.reason,
    file_path: c.file_path,
    file_type: c.file_type,
  }));
}

/**
 * Wrap SkillExtractor into an ISkillExtractor, making it easy for SkillConversationExtractWorker
 * (agent queue) to drive it directly.
 *
 * The input.agent_id must be provided by the caller (at trigger.archive time), sourced from
 * SkillTaskEntry.agent_id. When missing, returns empty candidates and emits a warn log — extraction depends on owner
 * validation, and without an agent_id it cannot be persisted.
 */
export function createExtractorAdapter(
  v2: SkillExtractor,
  logger?: { warn(msg: string): void },
): ISkillExtractor {
  return {
    async extract(input) {
      const agentId = (input as { agent_id?: string }).agent_id;
      if (!agentId) {
        logger?.warn(
          `${TAG} V2 adapter: input.agent_id missing — skipping extract (returns empty candidates)`,
        );
        return { candidates: [] };
      }
      const r = await v2.extract({
        user_id: input.user_id ?? "",
        team_id: input.team_id,
        agent_id: agentId,
        task_id: input.task_id ?? input.taskId,
        // Langfuse trace binding fields: the Worker reads them from SkillTaskEntry and passes them through to here;
        // when missing, the trace gets sessionId=null / instanceId=unknown (cannot be filtered by session).
        session_id: input.session_id,
        space_id: input.space_id,
        messages: toExtractMessages(input.conversation),
        reason: (input as { reason?: string }).reason,
        options: (input as { options?: { max_iterations?: number } }).options,
        // strict_mode passthrough: the Worker → adapter → SkillExtractor three-segment chain is complete;
        // if any link is missing, the cold-start strict_mode is dropped and falls back to the default v2 prompt.
        // This line is the link missed by adff8768 (the adapter explicitly maps fields and did not cover mode).
        mode: (input as { mode?: 'default' | 'strict' }).mode,
      });
      return { candidates: toLegacyCandidates(r.candidates) };
    },
  };
}
