/**
 * Zod schemas for `/skill/*` (v2 redesign, 2026-06-17).
 *
 * Aligned with docs/design/2026-06-17-skill-redesign-v2.md §3.4 / §3.5.
 *
 * team_id / agent_id constraints:
 *   - agent_id must use team_id as its namespace (an agent requires a team)
 *   - team_id may be passed without agent_id (team-dimension query)
 *   - neither may be passed (global query, no scope restriction)
 *   - write endpoints additionally require user_id to be provided
 *   - user_id / task_id are independently optional
 */

import { z } from "zod";

// ═════════════════════════════════════════════════════════════════════
//  Common fragments
// ═════════════════════════════════════════════════════════════════════

const idFieldsShape = {
  user_id: z.string().min(1).optional(),
  team_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
};

/** agent_id must use team_id as its namespace: an agent requires a team; a team can exist alone. */
function refineAgentNeedsTeam(data: { team_id?: string; agent_id?: string }, ctx: z.RefinementCtx) {
  const hasAgent = !!data.agent_id;
  const hasTeam = !!data.team_id;
  if (hasAgent && !hasTeam) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "agent_id requires team_id — agent is scoped under a team",
      path: ["agent_id"],
    });
  }
}

export const idFieldsReadSchema = z.object(idFieldsShape).superRefine(refineAgentNeedsTeam);
export const idFieldsWriteSchema = z.object(idFieldsShape).superRefine(refineAgentNeedsTeam);

export const skillResourcePayloadSchema = z.object({
  path: z.string().min(1).max(512),
  content: z.string(),
  encoding: z.enum(["utf-8", "base64"]),
  mime_type: z.string().max(128).optional(),
  is_executable: z.boolean().optional(),
});

export const extractMessageSchema = z.object({
  // Five roles, aligned with the conversationMessageSchema on the conversation/add side
  role: z.enum(["user", "assistant", "tool_call", "tool_result", "system"]),
  content: z.string().min(1),
  timestamp: z.string().datetime().optional(),
  // Anchor fields carried by tool_call/tool_result. tool_name is optional (the OpenAI protocol has no tool_name
  // field, see the comment on conversationMessageSchema); tool_call_id is also optional (the schema layer does not enforce it,
  // and the specific validation is decided by the direct-trigger handler; this schema only constrains the shape).
  tool_name: z.string().min(1).max(128).optional(),
  tool_call_id: z.string().min(1).max(128).optional(),
});

/**
 * Similar to extractMessageSchema but allows the system role (aligned with the 5 roles of the /v3/skill/conversation/add
 * §11.1 request body).
 *
 * tool_name / tool_call_id / timestamp (numeric) are used for tool_call/tool_result:
 *   - tool_call_id: optional in the schema, but the conversation-add handler enforces that
 *     tool_call/tool_result must carry it (pairing anchor)
 *   - tool_name: optional in both schema and handler -- OpenAI protocol role=tool messages
 *     have no tool_name field, so forcing a reverse lookup is going in circles; for skill extraction, content is what matters
 */
export const conversationMessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool_call", "tool_result", "system"]),
  content: z.string(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  tool_name: z.string().min(1).max(128).optional(),
  tool_call_id: z.string().min(1).max(128).optional(),
});

export const paginationSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});

// ═════════════════════════════════════════════════════════════════════
//  Request schemas
// ═════════════════════════════════════════════════════════════════════

export const createRequestSchema = z.object({
  ...idFieldsShape,
  name: z.string().min(1).max(64),
  content: z.string().min(1),
  resources: z.array(skillResourcePayloadSchema).max(100).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).superRefine(refineAgentNeedsTeam);

export const updateRequestSchema = z.object({
  ...idFieldsShape,
  skill_id: z.string().min(1),
  expected_version: z.number().int().min(1),
  content: z.string().min(1),
}).superRefine(refineAgentNeedsTeam);

export const patchRequestSchema = z.object({
  ...idFieldsShape,
  skill_id: z.string().min(1),
  expected_version: z.number().int().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
}).superRefine(refineAgentNeedsTeam);

export const deleteRequestSchema = z.object({
  ...idFieldsShape,
  skill_id: z.string().min(1),
}).superRefine(refineAgentNeedsTeam);

export const getRequestSchema = z.object({
  ...idFieldsShape,
  skill_id: z.string().min(1),
  version: z.number().int().min(1).optional(),
  include_content: z.boolean().optional(),
  include_manifest: z.boolean().optional(),
}).superRefine(refineAgentNeedsTeam);

/**
 * `POST /v3/skill/get-by-name` -- uniquely locates by (team_id, agent_id, skill_name).
 *
 * Motivation: when an agent invokes a skill via tools, it more naturally uses skill_name (consistent with the
 * `- name: description` rendered in the `<available_skills>` block), rather than the internal
 * `skl-xxx` id. Previously the agent had to skill_list first and then parse out the skill_id before it could get,
 * which was two calls for one interaction and wasted tokens. The new endpoint lets the agent get the full text in one go.
 *
 * Uniqueness contract: skill_name is unique under the same `(team_id, agent_id)` (guaranteed by the skill_create side's
 * 42201 SKILL_NAME_DUPLICATE). All three fields are required:
 *   - team_id + agent_id → owner scope
 *   - skill_name          -> the specific name
 *
 * Missing team_id or agent_id returns 40001 directly; a name not found returns 40401 (aligned with get).
 */
export const getByNameRequestSchema = z.object({
  user_id: z.string().min(1).optional(),
  team_id: z.string().min(1),
  agent_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
  skill_name: z.string().min(1).max(64),
  version: z.number().int().min(1).optional(),
  include_content: z.boolean().optional(),
  include_manifest: z.boolean().optional(),
});

export const listRequestSchema = z.object({
  ...idFieldsShape,
  filters: z.object({
    owner_agent_id: z.string().min(1).optional(),
    name_prefix: z.string().min(1).max(64).optional(),
    status: z.array(z.enum(["active", "archived"])).optional(),
  }).optional(),
  pagination: paginationSchema.optional(),
}).superRefine(refineAgentNeedsTeam);

export const searchRequestSchema = z.object({
  ...idFieldsShape,
  query: z.string().min(1).max(2048),
  top_k: z.number().int().min(1).max(50).optional(),
  mode: z.enum(["bm25", "embedding", "hybrid"]).optional(),
  /** When "team", the handler strips agent_id before passing to core (team-wide search, no owner filter). */
  scope: z.enum(["team"]).optional(),
}).superRefine(refineAgentNeedsTeam);

export const versionsRequestSchema = z.object({
  ...idFieldsShape,
  skill_id: z.string().min(1),
  pagination: paginationSchema.optional(),
}).superRefine(refineAgentNeedsTeam);

export const filesWriteRequestSchema = z.object({
  ...idFieldsShape,
  skill_id: z.string().min(1),
  expected_version: z.number().int().min(1),
  files: z.array(skillResourcePayloadSchema).min(1).max(100),
}).superRefine(refineAgentNeedsTeam);

export const filesRemoveRequestSchema = z.object({
  ...idFieldsShape,
  skill_id: z.string().min(1),
  expected_version: z.number().int().min(1),
  paths: z.array(z.string().min(1)).min(1).max(100),
}).superRefine(refineAgentNeedsTeam);

export const filesReadRequestSchema = z.object({
  ...idFieldsShape,
  skill_id: z.string().min(1),
  version: z.number().int().min(1).optional(),
  path: z.string().min(1),
  encoding: z.enum(["utf-8", "base64"]).optional(),
}).superRefine(refineAgentNeedsTeam);

export const exportRequestSchema = z.object({
  ...idFieldsShape,
  skill_id: z.string().min(1),
  version: z.number().int().min(1).optional(),
  format: z.enum(["zip"]).optional(),
}).superRefine(refineAgentNeedsTeam);

export const listingRequestSchema = z.object({
  ...idFieldsShape,
  query: z.string().max(2048).optional(),
  char_budget: z.number().int().min(0).max(64_000).optional(),
  /**
   * Recall mode:
   *  - undefined / 'auto': the original logic -- a non-empty query goes through search, an empty one goes through mode=full head
   *  - 'activity': default-task activity recall -- reads skill_usage_logs and sorts by MRR
   *
   * Design: docs/design/2026-09-09-skill-usage-telemetry-and-default-task-recall.md
   *
   * `activity` mode automatically falls back to the original logic in any of the following cases, fully backward compatible:
   *   - CH not configured (analytics.clickhouse.enabled=false or endpoint empty)
   *   - CH query failed / timed out
   *   - the agent has 0 active skills in the past 30 days (cold start)
   *   - store batch query exception
   */
  mode: z.enum(["auto", "activity"]).optional(),
}).superRefine(refineAgentNeedsTeam);

/**
 * `POST /v3/skill/extract` -- direct-trigger archive of one conversation slice, with semantics equivalent to
 * manually triggering a skill extraction. The contract follows `/v3/skill/conversation/add`:
 * just without accumulation / threshold judgment; one call produces one independent archive + task.
 *
 * `space_id`: aligned with the other 12 skill endpoints -- obtained from the `x-tdai-service-id` header
 * (the gateway resolves it to `auth.serviceId`); the body also accepts it, the handler prefers the body value,
 * and falls back to `auth.serviceId` when omitted. The two values should be equal by design (both are "the currently logged-in instance"),
 * and inequality indicates the caller passed the wrong instance.
 *
 * See `docs/design/2026-07-17-skill-extract-direct-trigger-plan.md` for details.
 */
export const extractRequestSchema = z.object({
  space_id: z.string().min(1)
    .refine((v) => !v.includes("|"), "space_id must not contain '|'")
    .optional(),
  user_id: z.string().min(1).refine((v) => !v.includes("|"), "user_id must not contain '|'"),
  team_id: z.string().min(1).refine((v) => !v.includes("|"), "team_id must not contain '|'"),
  agent_id: z.string().min(1).refine((v) => !v.includes("|"), "agent_id must not contain '|'"),
  session_id: z.string().min(1).optional()
    .refine((v) => !v || !v.includes("|"), { message: "session_id must not contain '|'" }),
  task_id: z.string().min(1).max(128).optional(),   // business task_ref_id, passed through to SkillTaskEntry
  messages: z.array(extractMessageSchema).min(1).max(500),
  reason: z.string().min(1).max(500).optional(),
  options: z.object({
    max_iterations: z.number().int().min(1).max(64).optional(),
  }).optional(),
  /**
   * In cold start / bulk import scenarios (agents/asset-import.ts) explicitly pass true to trigger strict-gate extraction
   * (SKILL_REVIEW_PROMPT_STRICT v1: five categories + four-dimension scoring). Daily real-time calls need not pass it,
   * and go through the current v2 SKILL_REVIEW_PROMPT (lenient, broad recall); fully compatible with old clients.
   */
  strict_mode: z.boolean().optional(),
});

/**
 * `POST /v3/skill/conversation/add` -- after each conversation turn ends, the Client passes this turn's incremental messages.
 *
 * Strong constraints (aligned with `docs/design/2026-07-15-skill-trigger-in-core-design.md` §11.1 & §13):
 *   - session_id / user_id / team_id / agent_id are required
 *   - none of the above 4 ID fields may contain `|` (conflicts with the Redis queue element separator)
 *   - `space_id` is optional: aligned with the other skill endpoints, obtained from the `x-tdai-service-id` header
 *     (`auth.serviceId`); also accepted if passed in the body, the handler prefers the body and falls back to auth when omitted
 *   - messages non-empty; each role valid; tool_call/tool_result must carry tool_name + tool_call_id
 *   - at most 500 messages per call (guards against oversized single requests; the upper layer also has a byte fallback)
 */
export const conversationAddRequestSchema = z.object({
  session_id: z.string().min(1).refine((v) => !v.includes("|"), "session_id must not contain '|'"),
  space_id: z.string().min(1)
    .refine((v) => !v.includes("|"), "space_id must not contain '|'")
    .optional(),
  user_id: z.string().min(1).refine((v) => !v.includes("|"), "user_id must not contain '|'"),
  team_id: z.string().min(1).refine((v) => !v.includes("|"), "team_id must not contain '|'"),
  agent_id: z.string().min(1).refine((v) => !v.includes("|"), "agent_id must not contain '|'"),
  task_id: z.string().min(1).max(128).optional(),
  messages: z.array(conversationMessageSchema).min(1).max(500),
  /**
   * In cold start / bulk import scenarios (agents/asset-import.ts) explicitly pass true to trigger strict-gate extraction
   * (SKILL_REVIEW_PROMPT_STRICT v1: five categories + four-dimension scoring). On archiving, the handler
   * stores this field in SkillTaskEntry.mode='strict', and the worker passes it through to SkillExtractor after receiving it.
   * Old clients need not pass it, going through the current v2 SKILL_REVIEW_PROMPT (lenient, broad recall); zero regression.
   */
  strict_mode: z.boolean().optional(),
});

// ═════════════════════════════════════════════════════════════════════
//  Type exports
// ═════════════════════════════════════════════════════════════════════

export type CreateRequest = z.infer<typeof createRequestSchema>;
export type UpdateRequest = z.infer<typeof updateRequestSchema>;
export type PatchRequest = z.infer<typeof patchRequestSchema>;
export type DeleteRequest = z.infer<typeof deleteRequestSchema>;
export type GetRequest = z.infer<typeof getRequestSchema>;
export type GetByNameRequest = z.infer<typeof getByNameRequestSchema>;
export type ListRequest = z.infer<typeof listRequestSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type VersionsRequest = z.infer<typeof versionsRequestSchema>;
export type FilesWriteRequest = z.infer<typeof filesWriteRequestSchema>;
export type FilesRemoveRequest = z.infer<typeof filesRemoveRequestSchema>;
export type FilesReadRequest = z.infer<typeof filesReadRequestSchema>;
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export type ListingRequest = z.infer<typeof listingRequestSchema>;
export type ExtractRequest = z.infer<typeof extractRequestSchema>;
export type ConversationAddRequest = z.infer<typeof conversationAddRequestSchema>;

// ═════════════════════════════════════════════════════════════════════
//  force-archive (manually force archiving, skip the threshold)
// ═════════════════════════════════════════════════════════════════════

export const forceArchiveRequestSchema = z.object({
  space_id: z.string().min(1),
  user_id: z.string().min(1),
  team_id: z.string().min(1),
  agent_id: z.string().min(1),
  session_id: z.string().min(1),
  reason: z.string().max(2000).optional(),
  task_id: z.string().optional(),
});
export type ForceArchiveRequest = z.infer<typeof forceArchiveRequestSchema>;
