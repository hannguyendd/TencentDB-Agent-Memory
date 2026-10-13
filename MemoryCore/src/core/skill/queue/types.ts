/**
 * src/core/skill/queue/types.ts
 *
 * Skill extraction interface-layer type definitions.
 *
 * 2026-07-17 rework: the old job queue (SkillExtractJob / SkillExtractResult /
 * ISkillTaskQueue / SkillQueueConfig) was deleted along with skill_extract converging onto the
 * new "SkillTriggerService.archive → agent queue" path. This file keeps the
 * Worker/extractor interface-layer types (ConversationMessage / ExtractedCandidate /
 * ISkillExtractor / ExtractorLogger), for reuse by conversation-add/extract-worker.ts
 * and skill-extractor.ts.
 */

// ─────────────────────────────────────────────────────────────
// conversation / candidate shapes used inside the queue
// ─────────────────────────────────────────────────────────────

/** Shape of a single conversation message in the queue (loose role field, compatible with user/assistant/tool_*). */
export interface ConversationMessage {
  role: string;
  content: string;
}

/** Shape of a single skill candidate in the extraction result. */
export interface ExtractedCandidate {
  action: "create" | "patch" | "edit" | "update" | "write_file" | "files_write";
  name: string;
  skill_id?: string;
  version?: number;
  description?: string;
  /** Passthrough field: retained for compatibility with the old result persistence payload. */
  content?: string;
  old_string?: string;
  new_string?: string;
  file_path?: string;
  file_type?: "text" | "executable" | "binary";
  confidence?: number;
  reason?: string;
}

/**
 * The minimal extractor interface the Worker calls. SkillExtractor only needs to expose this method.
 * This way the queue does not depend on a concrete class, and tests can mock it directly.
 */
export interface ISkillExtractor {
  extract(input: {
    task_id?: string;
    taskId?: string;                // compatibility field
    team_id: string;
    user_id?: string;
    /** owner agent id; the V2 adapter uses it to verify owner write permission. */
    agent_id?: string;
    /**
     * Langfuse top-level sessionId passthrough. The Worker reads it from SkillTaskEntry.session_id,
     * passing it all the way to the telemetry metadata of runner.run. When missing, the Langfuse trace's
     * sessionId would be null — filtering by session on the page would not show this skill extraction.
     */
    session_id?: string;
    /**
     * Instance id (= space_id / instanceId). Passed through as the runner telemetry's instanceId;
     * otherwise the instanceId on the Langfuse trace degrades to "unknown", and the llm_call metric
     * is skipped because of the `if (params.instanceId)` gate.
     */
    space_id?: string;
    conversation: ConversationMessage[];
    context?: { loaded_skills?: string[] };
    signal?: AbortSignal;
    /**
     * direct-trigger scenario: the main Agent's extraction hint, passed through to the extractor to inject into the prompt.
     * Read by the conversation-add extract-worker from SkillTaskEntry.reason.
     */
    reason?: string;
    /** direct-trigger scenario: LLM iteration cap, passed through to SkillExtractor to override the default. */
    options?: { max_iterations?: number };
    /**
     * Extraction mode; the Worker reads it from SkillTaskEntry.mode and passes it through here, and the adapter passes it on to
     * SkillExtractor.extract({mode}). Omitted/undefined takes the default v2 SKILL_REVIEW_PROMPT;
     * 'strict' takes SKILL_REVIEW_PROMPT_STRICT (v1 strict gate), used for cold start / bulk import.
     */
    mode?: 'default' | 'strict';
  }): Promise<{ candidates: ExtractedCandidate[] }>;
}

/**
 * The minimal logger interface used by the Worker (compatible with console and the project Logger).
 */
export interface ExtractorLogger {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

