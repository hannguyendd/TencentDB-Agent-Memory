/**
 * Skill Tools Injector — injects a static `<skill_tools>` block describing
 * cloud-skill operations as curl recipes.
 *
 * Why static: the LLM does NOT see these as native tools (we don't push to
 * `body.tools` — the agent host wouldn't know how to handle them). Instead
 * the LLM uses its existing Bash tool to curl `<proxy_base>/skill-bridge/...`,
 * which the proxy's `/skill-bridge/*` reverse proxy then forwards to core
 * with auth + IdFields injected from the session.
 *
 * The block is rendered once per session (at session_init prewarm) — its
 * content depends only on the proxy base URL, which is stable for the
 * session.
 *
 * Tools injected:
 *   Always (read-only): skill_search, skill_view, skill_files_read,
 *                       skill_extract
 *   Only when allowLlmWrite=true: skill_create, skill_update, skill_patch,
 *                                skill_delete, skill_files_write, skill_files_remove
 *
 * Note: skill_list is intentionally omitted — the <available_skills> block
 * already provides the agent's owned skill catalogue at session init.
 *
 * Sister hook: `skill-injector.ts` produces the dynamic `<available_skills>`
 * block (agent-owned skill listing from /v3/skill/listing).
  *
 * See `docs/design/2026-06-17-team-skill-proxy-runtime.md` §4.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";

export interface SkillToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every `<tool>` recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
  /**
   * Whether the main model is allowed to create/modify skills. Default false.
   * When false only read-only tools (search/list/view/files_read) are injected.
   * When explicitly set to true all 10 tools are injected.
   */
  allowLlmWrite?: boolean;
}

/**
 * Render the entire `<skill_tools>` block as a single text string. Pure
 * function for ease of testing.
 */
export function renderSkillToolsBlock(
  proxyBaseUrl: string,
  allowLlmWrite = true,
  sessionId?: string,
  spaceId?: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/skill-bridge/v3/skill`;

  // The gateway requires `x-tdai-service-id: <spaceId>` to let requests through; `x-conversation-id`
  // lets the proxy reuse the identity in the session (user_id / team_id / agent_id).
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  // -- whether skill_view uses skill_id (get) or skill_name (get-by-name) --
  // Default id -> skill_view hits /get, body passes skill_id (paired with available_skills rendering with id).
  // SKILL_VIEW_MODE=name -> falls back to /get-by-name + skill_name (old behavior).
  // Based on the skill_eval v9(name) vs v10(id) comparison experiment: id mode has a higher correct% when called, and unknown is halved.
  const skillViewMode = (process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() === "name" ? "name" : "id";
  const skillViewTool =
    skillViewMode === "id"
      ? [
          `  <tool name="skill_view">`,
          `    path: ${bridge}/get`,
          `    body: {"skill_id": "<skill id, like skl-xxx>", "include_content": true, "include_manifest": true}`,
          `    use:  **The entry point for opening a skill**: gets the full SKILL.md text + the resource directory tree (manifest). To read the bytes of a resource file you must first call this tool to pick the path from the manifest, then use skill_files_read. Take skill_id from the \`id=\` field of each line in <available_skills> (like skl-xxxxxx), or from the skill_id field of skill_search results.`,
          `  </tool>`,
        ]
      : [
          `  <tool name="skill_view">`,
          `    path: ${bridge}/get-by-name`,
          `    body: {"skill_name": "<skill name>", "include_content": true, "include_manifest": true}`,
          `    use:  **The entry point for opening a skill**: gets the full SKILL.md text + the resource directory tree (manifest). To read the bytes of a resource file you must first call this tool to pick the path from the manifest, then use skill_files_read. For skill_name use the name in the \`- name: description\` line of <available_skills>, or the name field of skill_search results.`,
          `  </tool>`,
        ];

  const readTools = [
    `  <tool name="skill_search">`,
    `    path: ${bridge}/search`,
    `    body: {"query": "keywords describing which skill you are looking for (required, >=1 character)"}`,
    `    use:  Search for matches by keyword + semantics among the skills that **you have permission to access in the team** (cross-agent, but **excluding** skills that others set as private -- consistent with what the frontend "Team Assets" tab shows). query must be a non-empty string; writing 2-5 relevant keywords is recommended. When you feel your own skills are not enough, use it to discover other usable skills in the team. The number of results is fixed by the server; if results are unsatisfactory, retry with a different set of keywords, and do not add other fields such as top_k/mode in the body (they will be ignored).`,
    `  </tool>`,
    "",
    // Temporarily offline: the <available_skills> block already injects the agent's own skill list, so the functionality overlaps.
    // Restore later if paginated refresh is needed (when there are too many skills and the list is truncated).
    // `  <tool name="skill_list">`,
    // `    path: ${bridge}/list`,
    // `    body: {"filters": {"owner_agent_id": "?optional", "name_prefix": "?optional"}, "pagination": {"limit": 50}}`,
    // `    use:  list head + active skills; filter by owner / prefix`,
    // `  </tool>`,
    // "",
    ...skillViewTool,
    "",
    `  <tool name="skill_files_read">`,
    `    path: ${bridge}/files/read`,
    `    body: {"skill_id": "skl-xxx", "path": "scripts/run.sh", "encoding": "utf-8|base64"}`,
    `    use:  Read the content of a single resource file. **You must first call skill_view to get the manifest**, pick skill_id + path from it, and only then can this tool locate it. By default returns a JSON envelope (containing base64/utf-8 encoded bytes).\n    To download locally: append -o <local path> at the end of curl, and the proxy returns the raw bytes written directly to the file, without entering the context. Downloaded scripts need chmod +x before running.`,
    `  </tool>`,
    "",
    `  <tool name="skill_extract">`,
    `    path: ${bridge}/extract`,
    `    body: {"reason": "?optional, briefly explain why you think the current conversation is worth extracting as a skill (being clear helps the background extractor identify boundaries)"}`,
    `    use:  Immediately archive the current conversation to trigger one skill extraction (async task; a background agent analyzes the conversation content to generate a skill). The proxy takes identity from the session + uses the conversation buffer accumulated on the core side, so you do not need to pass messages. Suitable for proactively triggering when "the user has run through a complete flow worth reusing".`,
    `  </tool>`,
  ];

  const writeTools = [
    `  <tool name="skill_create">`,
    `    path: ${bridge}/create`,
    `    body: {"name": "string", "content": "full SKILL.md text (including frontmatter)", "resources": "?optional array"}`,
    `    use:  Create a new skill; owner is automatically = the current agent`,
    `  </tool>`,
    "",
    `  <tool name="skill_update">`,
    `    path: ${bridge}/update`,
    `    body: {"skill_id": "skl-xxx", "content": "new SKILL.md"}`,
    `    use:  Replace SKILL.md (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_patch">`,
    `    path: ${bridge}/patch`,
    `    body: {"skill_id": "skl-xxx", "old_string": "...", "new_string": "...", "replace_all": false}`,
    `    use:  SKILL.md substring replacement (avoids large diffs)`,
    `  </tool>`,
    "",
    `  <tool name="skill_delete">`,
    `    path: ${bridge}/delete`,
    `    body: {"skill_id": "skl-xxx"}`,
    `    use:  Physically delete all versions of the skill`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_write">`,
    `    path: ${bridge}/files/write`,
    `    body: {"skill_id": "skl-xxx", "files": [{"path": "scripts/x.sh", "content": "...", "encoding": "utf-8", "is_executable": true}]}`,
    `    use:  Add/modify resource files (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_remove">`,
    `    path: ${bridge}/files/remove`,
    `    body: {"skill_id": "skl-xxx", "paths": ["scripts/old.sh"]}`,
    `    use:  Delete resource files (version+1)`,
    `  </tool>`,
  ];

  const note = allowLlmWrite
    ? "Error handling: the response is a `{code, message, request_id, data?}` envelope; `code != 0` means a business error. Common ones:"
    : "Note: only read-only operations are currently open. To create/modify skills please contact the administrator.\nError handling: the response is a `{code, message, request_id, data?}` envelope; `code != 0` means a business error. Common ones:";

  const readErrors = [
    "- 40001 parameter validation failed: a body field is missing/malformed; see the specific field name in message.",
    "- 40101 session not initialized: the session was not recognized (you are likely using this tool in the wrong conversation environment).",
    "- 40401 SKILL_NOT_FOUND: the skill does not exist or does not belong to your agent; first use skill_search to find similar skills.",
    "- 50301 upstream unavailable: core is temporarily unreachable, retry later.",
  ];
  const writeErrors = [
    "- 40301 SKILL_NOT_OWNER: you are not the owner and cannot modify.",
    "- 40901 SKILL_VERSION_STALE: version is stale; first skill_view to get the latest version, then write.",
    "- 42201 SKILL_NAME_DUPLICATE: duplicate name within the same team.",
    "- 42202 SKILL_PATCH_NOT_UNIQUE: old_string is not unique; pass replace_all=true.",
  ];

  return [
    "<skill_tools>",
    "Below are the cloud skill operation tools. **These are not local tools**; you need to use Bash to call curl against the proxy's skill-bridge path to execute them.",
    "The proxy automatically injects identity and auth (user_id / team_id / agent_id are determined by the session); in the body you only need to pass business fields.",
    "",
    "Call template:",
    `  curl -sSk -X POST <bridge>/<action> -H 'content-type: application/json'${authHeader} -d '{...business fields...}'`,
    `  where <bridge> = ${bridge}`,
    "",
    "Available tools:",
    "",
    ...readTools,
    ...(allowLlmWrite ? [""] : []),
    ...(allowLlmWrite ? writeTools : []),
    "",
    note,
    ...readErrors,
    ...(allowLlmWrite ? writeErrors : []),
    "</skill_tools>",
  ].join("\n");
}

/**
 * Skill tools injector.
 *
 * Anchor: lands BEFORE the `skills` slot (CodeBuddy: `<agent_skills>`),
 * priority just before SkillInjector so `<skill_tools>` reads naturally
 * before `<cloud_skills>`.
 */
export class SkillToolsInjector implements InjectionHook {
  id = "skill-tools-injector";
  point = "system.before_tools" as const;
  /** Place ahead of `<available_skills>` (which uses slot=skills, before). */
  anchor: AnchorTarget = { slot: "skills", relation: "before" };
  /** Slightly higher priority than SkillInjector so this block precedes it. */
  priority: HookPriority = HOOK_PRIORITY.SKILL - 1;
  description = "Inject the static <skill_tools> curl-recipe block.";
  /** Block content depends only on proxy base URL — fully session-static. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private config: SkillToolsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { skill?: boolean } | undefined;
    if (caps?.skill === false) return [];
    return this.renderBlocks(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.skill === false) return [];
    return this.renderBlocks(undefined, input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(ctx?: AgentContext, prewarmSessionId?: string, prewarmSpaceId?: string): ContextBlock[] {
    const allowLlmWrite = this.config.allowLlmWrite ?? false;

    let sessionId = prewarmSessionId;
    let spaceId = prewarmSpaceId;
    if (ctx) {
      const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
      const session = custom?.session as Record<string, unknown> | undefined;
      const sid = session?.session_id;
      if (typeof sid === "string" && sid.length > 0) {
        sessionId = sid;
      }
      const sp = session?.space_id;
      if (typeof sp === "string" && sp.length > 0) {
        spaceId = sp;
      }
    }

    const content = renderSkillToolsBlock(this.config.proxyBaseUrl, allowLlmWrite, sessionId, spaceId);
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // Stable cache-dedup key — varies by allowLlmWrite + skillViewMode to avoid stale cache
        // (SKILL_VIEW_MODE=id/name must be distinguished in the cache, otherwise the two modes share the same session_init block)
        cacheKey: `skill-tools-injector:catalog:${allowLlmWrite ? "rw" : "ro"}:${(process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() === "name" ? "name" : "id"}`,
      },
    }];
  }
}
