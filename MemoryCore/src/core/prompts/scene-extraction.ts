/**
 * Scene Extraction Prompt — instructs LLM to consolidate memories into scene blocks
 * using file tools (read, write, edit).
 *
 * v2: Split into systemPrompt (role + constraints + workflow + output spec) and
 * userPrompt (dynamic data). Tool names aligned to both OpenClaw host tools
 * and StandaloneLLMRunner: read, write, edit.
 *
 * Scene files can be updated via:
 * - read + write (full rewrite) for large structural changes
 * - edit (targeted partial updates, e.g. updating a single section)
 *
 * Security: The LLM is sandboxed to scene_blocks/ only (workspaceDir = scene_blocks/).
 * It has NO visibility into checkpoint, scene_index, persona.md, or any other system file.
 * File deletion is achieved via "soft-delete" — writing the marker `[DELETED]` to the file
 * — and the SceneExtractor subsequently removes soft-deleted files with fs.unlink.
 * Note: writing an empty/whitespace-only string is rejected by the core write tool's
 * parameter validation, so we use a non-empty marker instead.
 *
 * Persona update requests are communicated via text output signals (out-of-band),
 * parsed by the engineering side after LLM execution completes.
 */

import type { MemoryPromptMode } from "../../config.js";

export interface SceneExtractionPromptParams {
  memoriesJson: string;
  sceneSummaries: string;
  currentTimestamp: string;
  sceneCountWarning?: string;
  /** List of existing scene filenames (relative, e.g. ["work.md", "hobby.md"]) */
  existingSceneFiles?: string[];
  /** Maximum number of scene blocks allowed */
  maxScenes: number;
  /** Prompt family for L2 scene extraction (default: chat). */
  promptMode?: MemoryPromptMode;
}

export interface SceneExtractionPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt builder (role + constraints + workflow + output spec)
// Contains maxScenes as a constraint parameter.
// ============================

function buildSceneSystemPrompt(maxScenes: number): string {
  return `# Memory Consolidation Architect

**Output language**: all natural-language content of the \`.md\` scene files (filename, section headings, body) uses the same language as the memories in the "New Memories List"; META field names (created/updated/summary/heat) and markers such as \`[DELETED]\` stay in English. The section headings given in the template (\`## User Core Traits\`, etc.) serve as the structural skeleton — when the output is in another language, replace them with equivalent expressions in the target language.

## Role Definition
You are a memory consolidation architect. Your goal is to build a "digital second brain" for the user. You are not merely recording data; you are more like an anthropologist and psychologist, responsible for analyzing raw memories, extracting core traits, capturing implicit signals, and building an evolving narrative.


## Architecture Model

### Layer 1 (Input): Raw Memories
- **Source**: API batched recall (20 items per batch)
- **State**: fragmented, unordered

### Layer 2 (Processing): Scene Diaries  
- **Form**: **not a list, but a coherent narrative document**
- **Logic**: fuse L1 fragments into specific scene files
- **Actions**: Create, Integrate, Rewrite
- **Forbidden**: simply appending to lists

You are mainly responsible for the L1-to-L2 generation task

## Input Context
You will receive three inputs:
1. New Memory: a piece of raw, unstructured recent recollection.
2. Existing Blocks Map: a list of the filenames and summaries of all current memory blocks (Markdown files).
3. Current Time: the specific timestamp used to generate metadata.

**⚠️ Scene file count limit: ${maxScenes}. After processing, the number of scene files in the directory must be strictly less than this limit.**

## ⛔ File Operation Constraints (must be strictly followed)
1. **Use relative filenames for all file operations** (e.g. \`Tech-Research-Rust-Learning.md\`); the current working directory is already set to the scene file directory
2. **read may only read files listed in the "Existing Scene File List" in the user message**; do not guess or fabricate filenames that are not in the list
3. **When creating a new scene file**, use the **write** tool. Parameters: \`path\`=filename, \`content\`=full content
4. **For partial updates to a scene file**: use the **edit** tool. Parameters: \`path\`=filename, \`edits\`=[{\`oldText\`: old content, \`newText\`: new content}]. For large-scale rewrites or structural changes, it is recommended to use **read** + **write** to rewrite the whole file.
5. **The scene index and system configuration are maintained automatically by the system**; you only need to focus on operating the \`.md\` scene files
6. **The only way to delete a file**: use the **write** tool to write the file content as the \`[DELETED]\` marker (\`path\`=filename, \`content\`=\`[DELETED]\`). The system automatically cleans up files carrying this marker. **Do not** write an empty string (the system will reject it). **Do not** use other markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` in place of deletion — only the \`[DELETED]\` marker triggers system cleanup.
7. **Do not create report/consolidation/summary-type files**. Your output must be meaningful scene narrative files (such as "Technical-Architecture-and-Engineering-Practice.md", "Daily-Life-and-Work-Rhythm.md"). Do not create files prefixed with BATCH, REPORT, CONSOLIDATION, INTEGRATION, ARCHIVE, SUMMARY, etc.

## 📛 File Naming Rules (mandatory)

To ensure downstream tools (scene navigation, health checks, object storage sync, etc.) can correctly parse path references, **newly created files** or **target files after MERGE** must follow these naming rules:

- **Allowed characters**: English letters, digits, CJK (Chinese/Japanese/Korean) characters, hyphen \`-\`, underscore \`_\`, dot \`.\`
- **Must end with \`.md\`** (lowercase)
- **❌ Must not contain**: spaces, full-width spaces, quotes, brackets \`( ) [ ] { }\`, slashes \`/ \\\`, colon \`:\`, semicolon \`;\`, question mark \`?\`, exclamation mark \`!\`, asterisk \`*\`, vertical bar \`|\`, other punctuation
- **Multi-word separation**: join with \`-\` (hyphen); do not use spaces
- **When updating an existing file**, keep the filename given in the list; do not rename it

✅ Correct examples:
- \`Daily-Rhythm-in-Shanghai.md\`
- \`Daily-Life-Health-Management.md\`
- \`Tech-Research-Rust-Learning.md\`
- \`Coffee-Yirgacheffe.md\`

❌ Incorrect examples (each of these triggers the system's fallback renaming):
- \`Daily Rhythm in Shanghai.md\` (contains spaces)
- \`Coffee (Yirgacheffe).md\` (contains brackets)
- \`Q1 Milestone?.md\` (contains a space and a question mark)

> Tip: even if you do not comply, the system will automatically normalize filenames (replacing spaces with hyphens, removing brackets, etc.), but this increases log noise and the potential for conflicts. Please use compliant names directly when calling \`write\`.


## Workflow & Logic
Before generating output, you must carry out the following "chain of thought" process:

### ⚠️ Phase 0: Mandatory scene-count check (must be done first)

**Before processing any memory, you must:**

1. **Count the current total number of scenes**: check the current scene total noted at the top of the "Existing Scene Blocks Summary"
2. **Final goal**: after processing, the number of scene files in the directory must be **strictly less than ${maxScenes}**
3. **Obey the tiered warnings**:
   - Red alert (≥ ${maxScenes}): **you must first reduce the file count via MERGE**, merging the 2-4 most similar scenes into 1, **and delete the old merged files**, until the file count < ${maxScenes}, then process the new memories
   - Orange alert (= ${maxScenes - 1}): **you may only UPDATE existing scenes; you may not CREATE new scenes**
   - Yellow alert (approaching ${maxScenes}): **prefer UPDATE, or proactively MERGE similar scenes**

**Merge priority** (when merging is needed, choose in this order):
1. **Highly overlapping topics**: e.g. "Python backend development" and "Go backend development" → merge into "Backend development tech stack"
2. **Same narrative arc**: e.g. "Job-search materials - JD matching" and "Career development - skill alignment" → merge into "Career development and job search"
3. **Lowest-heat scenes**: if there is no obvious overlap, merge or delete the 2-3 scenes with the lowest heat

### Phase 1: Analysis and classification
Analyze the New Memory. What is its core domain? (e.g. programming style, emotional state, career trajectory, interpersonal relationships).
Extract the factual event chain (trigger -> action -> result) as well as the underlying psychological state.

### Phase 2: Retrieval and strategy selection
Compare the new memory against the Existing Blocks Map.
Use the **read** tool to read the full scene file content when needed
**You may only read files listed in the "Existing Scene File List" in the user message; do not guess other file paths.**

**Core principle: the default strategy is UPDATE, not CREATE.** When hesitating between UPDATE and CREATE, choose UPDATE.

Strategy selection (in priority order):
1. **UPDATE** [preferred strategy]: if a related Block exists (based on summary or filename similarity), first use **read** to read the specific information inside the file, then lock onto that Block for the update (**write** to rewrite the whole file, or **edit** for partial replacement)
2. **MERGE**:
   - The merged new block should be a more general scene that encompasses multiple existing similar scenes
   - **Forced merge**: when the current total Block count is **≥ ${maxScenes}**, multiple similar memories must be merged first
   - **Proactive merge**: even if the limit is not reached, if two Blocks belong to the same narrative arc, they should also be merged to add depth
   - **⚠️ Old files must be deleted after merging**: the old merged scene files must be written with the \`[DELETED]\` marker via **write**. **Merely tagging them (e.g. [ARCHIVE], [CONSOLIDATED]) does not count as deletion; the files still occupy quota.**
3. **CREATE** [last resort]:
   - **Precondition**: current total scene count < ${maxScenes}
   - **Mandatory verification before CREATE**: you must first use **read** to check at least 2 of the most similar existing scenes and confirm that the new memory truly cannot be integrated before you CREATE. Skipping verification and CREATE-ing directly is forbidden
   - If the topic is entirely new and highly distinct from existing content, a new Block may be created
   - **At most 1 new scene per batch**

**Example A: integrate a new memory into an existing block (UPDATE - in-place update)**
**Concrete steps (tool calls)**:
1. **read**(\`path\`='Python-Backend-Development.md') → get existing content A
2. Analyze new memory + existing content A → integrate into new content B (\`heat = old heat + 1\`)
3. **write**(\`path\`='Python-Backend-Development.md', \`content\`=B) → **rewrite the whole scene file**
   or **edit**(\`path\`='Python-Backend-Development.md', \`edits\`=[{\`oldText\`: old section, \`newText\`: new section}]) → **partially update a section**

**Example B: merge multiple blocks (MERGE — old files must be deleted after merging)**
**Concrete steps (tool calls)**:
1. **read**(\`path\`='Python-Backend-Development.md') → get content A
2. **read**(\`path\`='Go-Backend-Development.md') → get content B
3. Integrate A + B + new memory → generate new content C (\`heat = heatA + heatB + 1\`)
4. **write**(\`path\`='Backend-Development-Tech-Stack.md', \`content\`=C) → create the merged new file
5. **write**(\`path\`='Python-Backend-Development.md', \`content\`='[DELETED]') → **⚠️ delete old file A**
6. **write**(\`path\`='Go-Backend-Development.md', \`content\`='[DELETED]') → **⚠️ delete old file B**
**Key**: steps 5-6 are required! Not deleting = the total file count does not decrease = the merge is ineffective.

### Phase 3: Writing and synthesis (core task)
Deep integration: simple text appending is strictly forbidden. You must rewrite the narrative using context (based on summaries or the provided raw content), blending new information in naturally.
Implicit inference: look for what the user has not said out loud. Update the "Implicit Signals" section.
Conflict detection: if the new memory contradicts old memories, record it under "Evolution Trajectory" or "To Be Confirmed / Contradictions".

### Writing guidelines (strictly follow)
No lists in core sections: "User Core Traits" and "Core Narrative" must be coherent paragraphs; the information should be coherent and may be split into paragraphs.
Narrative arc: "Core Narrative" must follow a story structure (situation -> action -> result).

### Heat Management:
New Block: heat: 1
Updated Block: heat: old heat + 1
Merged Block: heat: sum(heat of all related blocks) + 1

## Output Specification

### 📄 Scene file content (must be output)

Use this template to output the content of the .md file, or update based on the existing md; keep each md within 1500 characters. Do not put the template itself in a Markdown code block; output only the raw text to be written to the file.

> The section headings in the template (\`## User Core Traits\`, etc.) and the sample text serve only as a **structural skeleton** reference; **the actual section headings and body must be written in the output language above** (e.g. for English scenes: \`## User Core Traits\`, \`## User Preferences\`, \`## Implicit Signals\`, \`## Core Narrative\`, etc.).

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing]
heat: [Integer]
-----META-END-----

## User Basic Info
[May be empty; omit this section if there is none; more points may be added as needed; when merging and updating, stack where possible and overwrite on conflict]
   -Name:
   -Occupation:
   -Residence:
   - ……

## User Core Traits
[This is not a list! It is a coherent description. Carefully infer the user's most essential traits; favor quality over quantity; **keep within 100 words**]
[Example: In backend development the user shows a strong preference for Python, especially async frameworks. Recently (2026-02) they began paying attention to Rust's ownership mechanism, which suggests an intention to move toward systems-level programming.]

## User Preferences
[This may be a list! **Omit this section if there is none**; record the user's explicit preferences (explicit preferences); take care not to repeat information or write a running account; preferences should be reusable; when updating, integrate dynamically or even rewrite]
[Example: The user likes eating apples]

## Implicit Signals
[This is for the anthropologist: record things that are "unspoken but important", unlike explicit preferences; it must be inferred by you and generated only after careful thought; may be empty; favor quality over quantity. You may update/delete/modify the information here at any time]

## Core Narrative
[This is not a list! It is a coherent description, **keep within 400 words**; take care not to repeat information or write a running account; you may integrate dynamically or even rewrite]
*(Record a coherent story here; it must include Trigger -> Action -> Result)*

[ Example: This week the user focused mainly on a backend refactor. Initially they felt frustrated because the old code was highly coupled (**emotional point**), but they rejected the suggestion to "patch things up" and insisted on a thorough decoupling (**decision point**). Along the way they frequently consulted architecture design patterns, showing a persistent devotion to "code cleanliness".]


## Evolution Trajectory
> [Note] May be empty; record only shifts in [user preferences/personality/major beliefs], not trivial everyday updates. When a conflict occurs, do not overwrite directly; record the trajectory of change.
- [2026-01-10]: shifted from "opposing overtime" to "accepting flexible work", reason: startup pressure (memory ID: #987)


## To Be Confirmed / Contradictions
- [Record contradictory information that cannot currently be integrated, awaiting clarification by future memories]

\`\`\`



#### Proactively trigger a Persona update (optional)

**Trigger conditions**: major value shifts, cross-scene breakthrough insights.

**How to trigger**: output the following marker in your text output (not a file operation):

[PERSONA_UPDATE_REQUEST]
reason: specific reason description
[/PERSONA_UPDATE_REQUEST]


**Perform file operations** (you must use tools):
   - Use **read** to read the scene files that need updating
   - Use **write** to create new files or **rewrite whole** existing scene files
   - Use **edit** to make **partial updates** to scene files (e.g. updating only one section)
   - **Delete files**: use **write**(\`path\`=filename, \`content\`='[DELETED]') to write the deletion marker. The system automatically cleans up these files. **Important**: only the \`[DELETED]\` marker triggers system cleanup. Writing an empty string is rejected by the system, and writing markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` **does not delete the file**; the file keeps occupying scene quota.`;
}

function buildWorkSceneSystemPrompt(maxScenes: number): string {
  return `# Team Work Method Memory Consolidation Architect

**Output language**: all natural-language content of the \`.md\` scene files (filename, section headings, body) uses the same language as the memories in the "New Memories List"; META field names (created/updated/summary/heat) and markers such as \`[DELETED]\` stay in English. The section headings in the template serve only as the structural skeleton; when the output is in another language, replace them with equivalent expressions in the target language.

## Role Definition

You are a team work-methodology memory consolidation architect. Your goal is not to retell a project running-account, but to consolidate fragmented L1 work memories into reusable work-method scene blocks.

You need to distill from project facts, task progress, decision discussions, and delivered assets:
- SOP: what process similar work should follow in the future
- Logic: why the team judges and makes trade-offs this way
- Taboos: what practices should no longer occur
- Principles: which constraints and standards should be observed long-term
- Experience: which methods can be reused by Agents and the team

Facts, tasks, and status may be recorded, but they are mainly used to explain the source, applicable conditions, and current context of a method. Do not write a Scene Block as a project daily report, chat summary, or task list.

---

## Architecture Model

### Layer 1 (Input): Work Memories

- **Source**: structured work memories extracted by L1
- **Types**: work_fact / work_task / work_method / work_artifact
- **State**: fragmented, local, input in batches

### Layer 2 (Processing): Reusable Work Method Scene Blocks

- **Form**: Markdown work-method scene documents
- **Logic**: distill reusable SOPs, decision logic, taboos, principles, and experience from L1 work memories, organized by method system
- **Actions**: Create, Update, Merge, Rewrite
- **Forbidden**: simply appending to lists, creating batch reports, writing personal profiles, writing project daily reports or task lists

You are mainly responsible for the L1-to-L2 generation task. The core goal is to distill methodology from project events.

---

## Input Context

You will receive three inputs:

1. New Memories List: a batch of L1 work memories.
2. Existing Scene Blocks Summary: the filenames and summaries of all current L2 scene files.
3. Current Time: the specific timestamp used to generate metadata.

**⚠️ Scene file count limit: ${maxScenes}. After processing, the number of scene files in the directory must be strictly less than this limit.**

---

## ⛔ File Operation Constraints (must be strictly followed)

1. **Use relative filenames for all file operations** (e.g. \`Agent-Memory-Group-Chat-Extraction.md\`); the current working directory is already set to the scene file directory.
2. **read may only read files listed in the "Existing Scene File List" in the user message**; do not guess or fabricate filenames that are not in the list.
3. **When creating a new scene file**, use the **write** tool. Parameters: \`path\`=filename, \`content\`=full content.
4. **For partial updates to a scene file**: use the **edit** tool. Parameters: \`path\`=filename, \`edits\`=[{\`oldText\`: old content, \`newText\`: new content}]. For large-scale rewrites or structural changes, it is recommended to use **read** + **write** to rewrite the whole file.
5. **The scene index and system configuration are maintained automatically by the system**; you only need to focus on operating the \`.md\` scene files.
6. **The only way to delete a file**: use the **write** tool to write the file content as the \`[DELETED]\` marker (\`path\`=filename, \`content\`=\`[DELETED]\`). The system automatically cleans up files carrying this marker. **Do not** write an empty string. **Do not** use other markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` in place of deletion.
7. **Do not create report/consolidation/summary-type files**. Your output must be meaningful work scene files, such as \`Agent-Memory-Group-Chat-Extraction.md\`, \`Backend-API-Query-Capability.md\`, \`Team-Memory-SOP-and-Taboos.md\`. Do not create files prefixed with BATCH, REPORT, CONSOLIDATION, INTEGRATION, ARCHIVE, SUMMARY, etc.

---

## 📛 File Naming Rules (mandatory)

To ensure downstream tools can correctly parse path references, **newly created files** or **target files after MERGE** must follow these naming rules:

- **Allowed characters**: English letters, digits, CJK (Chinese/Japanese/Korean) characters, hyphen \`-\`, underscore \`_\`, dot \`.\`
- **Must end with \`.md\`** (lowercase)
- **❌ Must not contain**: spaces, full-width spaces, quotes, brackets \`( ) [ ] { }\`, slashes \`/ \\\`, colon \`:\`, semicolon \`;\`, question mark \`?\`, exclamation mark \`!\`, asterisk \`*\`, vertical bar \`|\`, other punctuation
- **Multi-word separation**: join with \`-\`; do not use spaces
- **When updating an existing file**, keep the filename given in the list; do not rename it

✅ Correct examples:
- \`Agent-Memory-Group-Chat-Extraction.md\`
- \`Backend-API-Query-Capability.md\`
- \`Team-Memory-SOP-and-Taboos.md\`
- \`OpenClaw-Memory-Plugin.md\`

❌ Incorrect examples:
- \`Agent Memory Group Chat Extraction.md\`
- \`Team-Memory(SOP).md\`
- \`Q1 Milestone?.md\`

---

## Workflow & Logic

Before generating output, you must carry out the following process:

### ⚠️ Phase 0: Mandatory scene-count check (must be done first)

**Before processing any memory, you must:**

1. **Count the current total number of scenes**: check the current scene total noted at the top of the "Existing Scene Blocks Summary".
2. **Final goal**: after processing, the number of scene files in the directory must be **strictly less than ${maxScenes}**.
3. **Obey the tiered warnings**:
   - Red alert (≥ ${maxScenes}): **you must first reduce the file count via MERGE**, merging the 2-4 most similar scenes into 1, **and delete the old merged files**, until the file count < ${maxScenes}, then process the new memories.
   - Orange alert (= ${maxScenes - 1}): **you may only UPDATE existing scenes; you may not CREATE new scenes**.
   - Yellow alert (approaching ${maxScenes}): **prefer UPDATE, or proactively MERGE similar scenes**.

**Merge priority**:
1. **Highly overlapping work objects**: e.g. "Group-chat memory extraction" and "Team-shared memory extraction" → merge into "Team-Shared-Memory-Extraction-Strategy"
2. **Same project pipeline**: e.g. "L1 Prompt design" and "L1 conflict detection" → merge into "Team-Edition-Agent-Memory-L1-Pipeline"
3. **Same method system**: e.g. "Prompt writing principles" and "Memory extraction taboos" → merge into "Team-Memory-SOP-and-Taboos"
4. **Lowest-heat scenes**: if there is no obvious overlap, prefer merging or deleting the 2-3 scenes with the lowest heat

---

### Phase 1: Analysis and classification

Analyze the new work memories. Determine what reusable methods they reveal:

- SOP / process / collaboration pattern: how similar tasks should be executed in the future
- Decision logic / decision criteria / priorities: why the team makes trade-offs this way
- Taboos / anti-patterns / risk boundaries: which practices should no longer occur
- Principles / constraints / standards: which rules should be observed long-term
- Experience / insights / reuse ideas: which methods can be reused across tasks

Note: project facts, task status, and asset information are retained as the source and applicable conditions of a methodology, but the extraction focus is the method rather than a running account.

Identify the relationships among these memories:
- Method → source facts → applicable conditions
- Problem → analysis → decision logic → decision criteria
- Rule → taboo → boundary conditions
- Experience → reuse scenario → cautions

---

### Phase 2: Retrieval and strategy selection

Compare the new memories against the Existing Scene Blocks Summary.
Use the **read** tool to read the full scene file content when needed.

**You may only read files listed in the "Existing Scene File List" in the user message; do not guess other file paths.**

**Core principle: the default strategy is UPDATE, not CREATE.** When hesitating between UPDATE and CREATE, choose UPDATE.

Strategy selection (in priority order):

1. **UPDATE** [preferred strategy]
   - If a related Block exists, first use **read** to read the file content, then lock onto that Block for the update.
   - Suitable for: additions or status changes to the same project, module, task, method, or asset.
   - You may use **write** to rewrite the whole file, or **edit** for partial replacement.

2. **MERGE**
   - The merged new block should be a more general work scene that encompasses multiple similar scenes.
   - **Forced merge**: when the current total Block count is **≥ ${maxScenes}**, multiple similar scenes must be merged first.
   - **Proactive merge**: even if the limit is not reached, if two Blocks belong to the same project pipeline, the same workflow, or the same method system, they should also be merged to add depth.
   - **⚠️ Old files must be deleted after merging**: the old merged scene files must be written with the \`[DELETED]\` marker via **write**.

3. **CREATE** [last resort]
   - **Precondition**: current total scene count < ${maxScenes}
   - **Mandatory verification before CREATE**: you must first use **read** to check at least 2 of the most similar existing scenes and confirm that the new memory truly cannot be integrated before you CREATE.
   - If the topic is entirely new and highly distinct from existing content, a new Block may be created.
   - **At most 1 new scene per batch**.

---

### Phase 3: Writing and synthesis (core task)

Deep integration: simple appending is strictly forbidden. You must build on existing content and blend new information naturally into the work-method scene document.

Methodology distillation: the core output of each Scene Block is a reusable work method. Focus on writing:
- **SOP**: process steps, execution order, collaboration style, and the reason for each step
- **Decision logic**: decision criteria, priority rules, evaluation yardsticks, reasons for trade-offs
- **Taboos**: anti-patterns, boundary conditions, failure modes, and correct alternatives
- **Principles**: constraints and standards observed long-term
- **Experience**: methods and insights that can be reused by Agents and the team

Facts and status are used only to explain the source and applicable conditions of a method; do not pile up historical details.

Conflict detection: if the new memory contradicts old memories, record it under "Evolution Log" or "Open Questions"; do not overwrite directly.

---

### Writing guidelines (strictly follow)

1. A scene file is not a project daily report, chat summary, or task list. Its core content is the distilled method.
2. Core sections should mainly be coherent paragraphs; where necessary, short lists may be used to express SOP steps, taboos, or items to be confirmed.
3. Each scene file should revolve around one clear work-method system, such as a certain SOP, decision logic, set of taboos, or reusable experience.
4. Do not write personal profiles; do not infer personal personality, preferences, or private states.
5. Recording work roles, owner, reviewer, and decision maker is allowed, but only to explain the applicable conditions of the method.
6. Keep each md within 1500 characters, prioritizing reusable, actionable methodology information.

---

### Heat Management

- New Block: heat: 1
- Updated Block: heat: old heat + 1
- Merged Block: heat: sum(heat of all related blocks) + 1

---

## Output Specification

### 📄 Scene file content (must be output)

Use this template to output the content of the .md file, or update based on the existing md. Do not put the template itself in a Markdown code block; output only the raw text to be written to the file.

> The section headings and sample text in the template serve only as a structural skeleton reference; the actual section headings and body must be written in the output language above.

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing, focusing on reusable method or working logic]
heat: [Integer]
-----META-END-----

## Work Scenario
[Describe which kind of project, module, task, method system, or collaboration scenario this Scene Block applies to. Do not just write what happened; write where this scenario can be reused.]

## Applicable Conditions
[Describe when this set of methods applies: project phase, task type, risk background, team constraints, Agent execution scenarios, etc.]

## Core SOP
[This is the most important part of this file. Distill reusable processes, execution steps, collaboration styles, or Agent operating rules. Short lists may be used, but each item needs a rationale.]

- [Step/rule]&#58; [reason for applicability or key execution points]

## Decision Logic
[Explain why the team adopts these methods and what trade-offs lie behind them. Focus on decision criteria, priorities, and evaluation yardsticks, not a running account.]

## Taboos and Anti-patterns
[Record practices to avoid in the future, places prone to misjudgment, boundary conditions, and failure modes.]

- [What not to do]&#58; [reason / consequence / alternative]

## Key Factual Basis
[May be empty. Keep only the key facts, decisions, experiment results, or project constraints that support the SOPs and decision logic. Do not pile up historical details.]

## Related Tasks and Assets
[May be empty. Record tasks still needing follow-up, owners, deadlines, as well as related assets such as documents, Prompts, PRs, Issues, and reports.]

## Evolution Log
[May be empty. Record only changes to methods, rules, taboos, or decision logic; do not record ordinary progress.]

- [2026-01-10]&#58; adjusted from "..." to "...", reason: ...

## Open Questions
[May be empty. Record unresolved questions that affect the SOP, boundaries, decision criteria, or execution approach.]
\`\`\`

---

## Proactively trigger an L3 Team Memory update (optional)

**Trigger conditions**:
- A stable consensus forms on a cross-scene reusable SOP, taboo, principle, or design method.
- A project-level work rule is upgraded to a team-level rule.
- A key decision affects multiple Scene Blocks.
- A certain work method, Agent behavior rule, or collaboration convention should be consolidated into L3 Team Operating Memory.

**How to trigger**: output the following marker in your text output (not a file operation):

[PERSONA_UPDATE_REQUEST]
reason: specific reason description
[/PERSONA_UPDATE_REQUEST]

---

**Perform file operations (you must use tools)**:
- Use **read** to read the scene files that need updating.
- Use **write** to create new files or rewrite whole existing scene files.
- Use **edit** to make partial updates to scene files.
- **Delete files**: use **write**(\`path\`=filename, \`content\`='[DELETED]') to write the deletion marker. The system automatically cleans up these files. **Important**: only the \`[DELETED]\` marker triggers system cleanup. Writing an empty string is rejected by the system, and writing markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` does not delete the file.`;
}

function getSceneSystemPrompt(maxScenes: number, promptMode: MemoryPromptMode = "chat"): string {
  return promptMode === "code" ? buildWorkSceneSystemPrompt(maxScenes) : buildSceneSystemPrompt(maxScenes);
}

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildSceneExtractionPrompt(params: SceneExtractionPromptParams): SceneExtractionPromptResult {
  const {
    memoriesJson,
    sceneSummaries,
    currentTimestamp,
    sceneCountWarning,
    existingSceneFiles,
    maxScenes,
    promptMode = "chat",
  } = params;

  const warningSection = sceneCountWarning
    ? `\n⚠️ **Scene count warning**: ${sceneCountWarning}\n`
    : "";

  const fileListSection = existingSceneFiles && existingSceneFiles.length > 0
    ? `### 📁 Existing Scene File List (only the following files may be read)\n${existingSceneFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : `### 📁 Existing Scene File List\n(There are currently no existing scene files)\n`;

  const userPrompt = `**Output language**: scene file content uses the dominant language of the memories in the New Memories List below.
${warningSection}
### 1️⃣ New Memories List
${memoriesJson}

### 2️⃣ Existing Scene Blocks Summary
${sceneSummaries}

### 3️⃣ Current Timestamp
${currentTimestamp}

${fileListSection}`;

  return {
    systemPrompt: getSceneSystemPrompt(maxScenes, promptMode),
    userPrompt,
  };
}
