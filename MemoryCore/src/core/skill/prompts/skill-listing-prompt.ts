/**
 * skill-listing-prompt — system prompt boilerplate that frames the
 * `<available_skills>` block injected into agent system prompts.
 *
 * Both header and footer come from SKILL_ENGINEERING_DESIGN appendix C.1.
 * The router (M5) wraps the actual entries between them. Hermes uses the
 * exact same wording, so this file should NOT diverge — keep it byte-equal
 * with the design doc.
 *
 * NOTE (skill_view id mode): the original "load it with skill_view(name)" was changed to a neutral wording that does not bind
 * a specific parameter field, because the default has switched to id mode (skill_view takes skill_id).
 * Whether to pass id or name is decided by the skill_view tool description + the per-line format described in <available_skills>.
 * If syncing Hermes / the design doc, please update this sentence as well; do not revert it as a typo.
 */

export const SKILL_LISTING_HEADER =
  "## Skills (mandatory)\n" +
  "Before replying, scan the skills below. If a skill matches or is even partially relevant " +
  "to your task, you MUST load it with skill_view (see the skill_view tool for how to pass " +
  "the skill identifier) and follow its instructions. " +
  "Err on the side of loading — it is always better to have context you don't need " +
  "than to miss critical steps, pitfalls, or established workflows. " +
  "Skills contain specialized knowledge — API endpoints, tool-specific commands, " +
  "and proven workflows that outperform general-purpose approaches. Load the skill " +
  "even if you think you could handle the task with basic tools like web_search or terminal. " +
  "Skills also encode the user's preferred approach, conventions, and quality standards " +
  "for tasks like code review, planning, and testing — load them even for tasks you " +
  "already know how to do, because the skill defines how it should be done here.\n" +
  "If a skill has issues, fix it with skill_manage(action='patch').\n" +
  "After difficult/iterative tasks, offer to save as a skill. " +
  "If a skill you loaded was missing steps, had wrong commands, or needed " +
  "pitfalls you discovered, update it before finishing.\n";

export const SKILL_LISTING_FOOTER =
  "\nOnly proceed without loading a skill if genuinely none are relevant to the task.";

/**
 * Tool-usage guidance, attached separately from the skill listing.
 * Optional; gateways may inject this in the `tool_guidance` section.
 */
export const SKILLS_GUIDANCE =
  "After completing a complex task (5+ tool calls), fixing a tricky error, " +
  "or discovering a non-trivial workflow, save the approach as a " +
  "skill with skill_manage so you can reuse it next time.\n" +
  "When using a skill and finding it outdated, incomplete, or wrong, " +
  "patch it immediately with skill_manage(action='patch') — don't wait to be asked. " +
  "Skills that aren't maintained become liabilities.";
