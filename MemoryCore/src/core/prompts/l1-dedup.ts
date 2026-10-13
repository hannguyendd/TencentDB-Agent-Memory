/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a memory conflict detector. Compare multiple [new memories] in batch against the existing memories in the [unified candidate memory pool], and decide how to handle each one.

**Output language**: \`merged_content\` uses the same language as the existing memories in the candidate pool; JSON field names, enum values, record_id, and ISO timestamps stay in English.

## Core Rules

- **Cross-type merging**: memories of different types (persona / episodic / instruction / work_fact / work_task / work_method / work_artifact) that semantically describe the same fact/event **may be merged**.
- **Many-to-many merging**: one new memory may replace/merge **multiple** existing memories in the candidate pool at once (specified via the target_ids array).
- After merging, you must determine the best type for the new memory (merged_type).

## Decision Logic

1. **Identify the nature of the memory**:
   - **State type** (persona/instruction): preferences, traits, long-term settings, relatively stable facts, behavior rules
   - **Event type** (episodic): one-off experiences, objective records with a point in time; it is recommended to merge the cause and effect of the same matter

2. **Determine whether it is the same fact/event**: same subject, consistent topic, close in time, similar scene_name

3. **Choose an action**:
   - "store": treat as new information and add the current memory.
   - "skip": the existing memory is better; the new memory adds nothing or is vaguer, so ignore the current memory.
   - "update": the same fact/event, and the new memory is better in content or time (more specific, later, or a correction); let the new memory take precedence and overwrite the old one, optionally keeping details from the old memory that are still correct.
   - "merge": the same fact or the same evolving process, where multiple memories are complementary and not contradictory; merge them into one more complete memory with as little redundant information as possible.

4. **Strategy tendencies**:
   - State type: multiple memories describing the same preference/trait → lean toward merge; no new information → skip; clear update → update
   - Event type: cause/effect or different stages of the same event → lean toward merging into one complete narrative; exactly identical → skip
   - Cross-type example: an episodic "The user started a podcast in 2018" + a persona "The user has podcast production experience" → can be merged into one persona or episodic (depending on the information emphasis)

5. **Timestamp handling**:
   - On merge / update, merged_timestamps should contain the **union of the timestamps of all related memories** (deduplicated and sorted)
   - This preserves the complete timeline of when the events happened

## Output Format

Output strictly a JSON array, with each element corresponding to the decision for one new memory. Output nothing else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id 1 of the candidate memory to delete", "record_id 2"],
    "merged_content": "merged/updated memory content (required for merge/update)",
    "merged_type": "best type after merging: persona|episodic|instruction|work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["merged timestamp array containing the union of all new and old memory timestamps (required for merge/update)"]
  }
]

Field descriptions:
- target_ids: **array** of old memory IDs to delete/replace (may be one or more). Omit or leave empty for store/skip.
- merged_content: the final memory text for merge/update. Omit for store/skip.
- merged_type: the type the memory should belong to after merge/update. Judge based on the essence of the merged content.
- merged_priority: the new priority after merge/update (integer 0-100, required for merge/update). The merged information is more complete and more certain, so you should usually **raise the priority as appropriate** (e.g. merging two priority-70 memories can raise it to 80). Reference scale: 80-100 (core traits/important events), 60-79 (general preferences/ordinary activities), <60 (minor information).
- merged_timestamps: the merged timestamp array. Collect the timestamps of the new memory + all merged old memories, deduplicated and sorted.`;

export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a team work-memory conflict detector. Compare multiple [new memories] in batch against the existing memories in the [unified candidate memory pool], and decide how to handle each one.

**Output language**: \`merged_content\` uses the same language as the existing memories in the candidate pool; JSON field names, enum values, record_id, and ISO timestamps stay in English.

## Core Rules

- **Cross-type merging**: memories of different types (work_fact / work_task / work_method / work_artifact) that semantically describe the same work object, task, method, or asset **may be merged**.
- **Many-to-many merging**: one new memory may replace/merge **multiple** existing memories in the candidate pool at once (specified via the target_ids array).
- After merging, you must determine the best type for the new memory (merged_type).
- Memories are shared within the project team by default, so merged content should retain only work-related information.

## Decision Logic

1. **Identify the nature of the memory**:
   - **Work facts (work_fact)**: project facts, requirements, decisions, status, risks, constraints, experiment results, customer feedback.
   - **Work tasks (work_task)**: to-dos, owner, deadline, next-step plans, task status changes.
   - **Work methods (work_method)**: SOPs, taboos, principles, experience, design ideas, judgment criteria, Agent behavior rules.
   - **Work assets (work_artifact)**: documents, PRs, Issues, Prompts, reports, code branches, design drafts, links, etc.

2. **Determine whether it is the same work object/evolving process**:
   - Same project, module, requirement, task, risk, decision, method, or asset, with highly similar scene_name or semantics.
   - Different stages of the same task, additions to the same method, or version/purpose changes of the same asset can usually be merged.
   - Items that merely belong to the same large project but concern different objects should not be force-merged.

3. **Choose an action**:
   - "store": treat as new information and add the current memory.
   - "skip": the existing memory is better; the new memory adds nothing or is vaguer, so ignore the current memory.
   - "update": the same work object, and the new memory is more specific, newer, more authoritative, or corrects the old information; let the new memory take precedence and overwrite the old one, optionally keeping details from the old memory that are still correct.
   - "merge": the same work object or the same evolving process, where old and new memories are complementary and not contradictory; merge them into one more complete memory with as little redundant information as possible.

4. **Strategy tendencies**:
   - work_fact: supplement or correction of the same fact/decision/status → lean toward update or merge.
   - work_task: owner, deadline, or status change of the same task → lean toward update; added dependencies or acceptance criteria → lean toward merge.
   - work_method: supplement to the same SOP, taboo, principle, or experience → lean toward merge; a clearer, more general statement → lean toward update.
   - work_artifact: supplement to the purpose, version, or link of the same document, PR, Prompt, report, or other asset → lean toward merge or update.
   - Cross-type example: a work_fact "The team decided to keep L1 types as a small number of high-level categories" + a work_method "L1 types should not be too fine-grained, otherwise L2/L3 aggregation suffers" → can be merged into a work_method.

5. **Timestamp handling**:
   - On merge / update, merged_timestamps should contain the **union of the timestamps of all related memories** (deduplicated and sorted).
   - This preserves the complete timeline of how the work fact, task, or method evolved.

## Output Format

Output strictly a JSON array, with each element corresponding to the decision for one new memory. Output nothing else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id 1 of the candidate memory to delete", "record_id 2"],
    "merged_content": "merged/updated memory content (required for merge/update)",
    "merged_type": "best type after merging: work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["merged timestamp array containing the union of all new and old memory timestamps (required for merge/update)"]
  }
]

Field descriptions:
- target_ids: **array** of old memory IDs to delete/replace (may be one or more). Omit or leave empty for store/skip.
- merged_content: the final memory text for merge/update. Omit for store/skip.
- merged_type: the type the memory should belong to after merge/update. Judge based on the essence of the merged content.
- merged_priority: the new priority after merge/update (integer 0-100, required for merge/update). The merged information is more complete and more certain, so you should usually **raise the priority as appropriate**. Reference scale: 80-100 (key facts/important tasks/core methods/important assets), 60-79 (general work information), <60 (minor information).
- merged_timestamps: the merged timestamp array. Collect the timestamps of the new memory + all merged old memories, deduplicated and sorted.`;

export function getConflictDetectionSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT : CONFLICT_DETECTION_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## Unified Candidate Memory Pool\n\n(Empty; there are no existing memories, so store all new memories directly)";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Unified Candidate Memory Pool (${poolList.length} existing memories in total)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (no similar candidates; store directly)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### New memory #${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n[Related candidate IDs] ${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**Output language**: \`merged_content\` uses the same language as the existing memories in the candidate pool.

${poolSection}

${"═".repeat(50)}

## New memories to judge (${matches.length} in total)

${newMemoriesText}

Please judge each one and output the decision JSON array. When a new memory's candidate list is empty, output action=store for it directly.`;
}
