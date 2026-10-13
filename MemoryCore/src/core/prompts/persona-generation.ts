/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

import type { MemoryPromptMode } from "../../config.js";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). */
  promptMode?: MemoryPromptMode;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

**Output language**: all natural-language content of \`persona.md\` (Archetype, basic info, the body of Chapters 1-4, etc.) uses the same language as the changed-scene content; Markdown syntax, tag formats, and the filename \`persona.md\` stay in English. The Chapter labels in the template are kept as the skeleton; when the output is in another language, use equivalent annotations in the target language.

Combine the existing persona.md with the new/changed block information for in-depth analysis, then use the file tools to write the result to the \`persona.md\` file.

## ⛔ File Operation Constraints (must be strictly followed)

1. **You must use the file tools to write the final persona content to \`persona.md\`**. The current working directory is already set to the data directory; use the filename \`persona.md\` directly.
   - **First generation / major rewrite**: use the **write** tool to write the whole file. Parameters: \`path\`=\`persona.md\`, \`content\`=full content
   - **Incremental update (local changes)**: use the **edit** tool for precise replacement. Parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}]
2. **Operate on the single file \`persona.md\` only**; reading or writing any other file (including scene_blocks/, .metadata/, etc.) is forbidden.
3. **The written content must contain only the final persona document**; do not include your thought process, analysis steps, or any non-persona content.
4. **No read tool needed**: the full content of the current persona.md is provided in the user message; update directly based on it.

### 🚫 Strictly Forbidden
- **No excessive length**: keep the total length of persona.md within 2000 characters; summarize in time and delete unimportant information.
- **No over-speculation**: do not over-imagine information that was not mentioned and cause hallucinations; especially in the cold-start phase, stay restrained, and if there is no relevant information it is perfectly fine to leave it blank!
- **No information from non-scene sources**: all content of the Persona must and can only come from the scene data provided below. Do not extract any personal information about the user from technical metadata such as the workspace directory structure, file paths, or system information.
- **Do not operate on any file other than persona.md**.

---

## ⚙️ The Core Logic

🧠 Core thinking engine: Connect & Synthesize
Process information following the principle of "narrative coherence". Simple listing is forbidden (No Bullet-point Spamming).

1. Find the "Connecting Thread"
Do not look at information in isolation. Look for the common logic behind behaviors in different domains.
** Stay concise, do not over-speculate, and leave it out if uncertain **

Perform the following **four-layer deep scan**:

### 🟢 Layer 1: The Base & Facts -> [Build Connection]
* **Scan target**: established facts, demographic characteristics, current status.
* **Practical value**: gives the Agent **icebreaker topics** and **context awareness**.

### 🔵 Layer 2: The Interest Graph -> [Provide Conversation Material]
* **Scan target**: things the user invests time, money, or attention in.
* **Extraction principle**: **distinguish activity level** (active hobbies / passive consumption / dormant interests).
* **Practical value**: enables the Agent to hold **high-quality chit-chat** and make **lifestyle recommendations**.

### 🟡 Layer 3: The Interface -> [Remove Friction]
* **Scan target**: the user's communication habits, red lines, and workflow preferences.
* **Practical value**: guides the Agent on **how to speak and how to deliver results**, avoiding landmines.

### 🔴 Layer 4: The Core -> [Deep Resonance]
* **Scan target**: decision logic, contradictions, ultimate drivers.
* **Practical value**: makes the Agent a "co-pilot" that can **make decisions on the user's behalf**.

---

## 📝 The Persona Template

Refer to the format below and use the **write** tool to write the final content. You may adjust it on your own (reduce or add chapters when information is insufficient) (**Markdown format must be kept**):

\`\`\`\`markdown
# User Narrative Profile

> **Archetype (Core Archetype)**: [One-sentence definition. For example: a "pragmatic idealist" who struggles under the gravity of reality but tries to build a utopia through technology.]

> **Basic Info**
(The user's basic information, such as age, gender, occupation, etc.; on update, overwrite if conflicting, and stack where not conflicting)
 -
 -

> **Long-term Preferences**
(The user's most stable and reusable preferences that you have observed)
    -
    -

## 📖 Chapter 1: Context & Current State (Panoramic Context)
*(Fuse basic facts with the current state into one coherent background introduction)*

**[Write a coherent description here; when the differences are large, you may elaborate in points]**

## 🎨 Chapter 2: The Texture of Life (Texture of Life)
*(Connect interests, consumption, and living habits to show lifestyle taste)*

**[Write a coherent description here, focusing on the unity of "interests/preferences" and "taste"; when the differences are large, you may elaborate in points]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol (Interaction and Cognitive Protocol)
*(This is the action guide for the Main Agent. For practicality, keep it semi-structured here, but explain "why")*

### 3.1 Communication Strategy (How to Speak)
### 3.2 Decision Logic (How to Think)

## 🧩 Chapter 4: Deep Insights & Evolution (Deep Insights and Evolution)
*(Anthropological observation notes)*

* **Unity of contradictions**: [Describe traits in the user that seem conflicting but are actually reasonable].
* **Evolution trajectory**: [May include time, split into several points, describing recent changes in the user].
* **Emergent traits**: distill 3-7 of the most essential trait tags, each on its own line with a short note (10-15 words)
  - \`TagName\` - short note
\`\`\`\`

---

### ⚠️ Success Criteria
- ✅ **You must use the write or edit tool to write the final result to \`persona.md\`**
- ✅ Generate deep insights based on scene evidence
- ✅ Content ends at Chapter 4 (do not include scene navigation; the system appends it automatically)
- ✅ Strictly follow the template format above
- ✅ Do not add scene navigation (the system appends it automatically)
- ✅ Operate only on persona.md; do not touch other files`;

const TEAM_MEMORY_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

**Output language**: all natural-language content of \`persona.md\` uses the same language as the changed-scene content; Markdown syntax, tag formats, and the filename \`persona.md\` stay in English.

Combine the existing \`persona.md\` with the new/changed L2 scene blocks to generate or update a highly condensed team working-principles document.

This L3 is not a project summary, progress log, scene index, or fact roundup, but an Operating Doctrine that the team can reuse in all kinds of work settings. It should help the Agent know how to judge, how to execute, and how to avoid mistakes when facing new tasks in the future.

## ⛔ File Operation Constraints

1. **You must use the file tools to write the final content to \`persona.md\`**.
   - First generation / major rewrite: use **write**, parameters: \`path\`=\`persona.md\`, \`content\`=full content.
   - Incremental update: use **edit**, parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}].
2. **Operate on the single file \`persona.md\` only**; reading or writing any other file is forbidden.
3. **No read tool needed**: the full content of the current \`persona.md\` is provided in the user message.
4. The written content must contain only the final Markdown document, with no analysis process or explanation.

## 🚫 Strictly Forbidden

- **No more than 1200 words**: the final \`persona.md\` must be highly compressed; favor precision over volume.
- **No project-specific fragments**: do not write content that is only understandable within a particular project context, e.g. "project v2 needs optimizing" or "a certain module continues to advance".
- **No running-account logs**: do not record what happened, who did what, or how a task is progressing, unless it has been abstracted into a general method.
- **No piling up of low-level facts**: project names, version numbers, task names, PRs, Issues, and document names generally should not enter L3, unless they represent a reusable paradigm.
- **No semantic incompleteness**: every principle must be understandable apart from the original project and must include its action object, applicable conditions, or judgment logic.
- **No personal profiling**: do not generate member personalities, personal preferences, private states, or emotional judgments.
- **No over-speculation**: do not guess at information without scene evidence.

---

## Core Goals

You must distill from the L2 scenes what is reusable across all work settings:

1. **SOP**: what process similar tasks should follow in the future.
2. **Principle**: working principles the team observes over the long term.
3. **Decision Logic**: what criteria to use when making trade-offs.
4. **Boundary**: what must not be done, and what must not be automated.
5. **Anti-pattern**: practices that lead to errors, pollute memory, or lower quality.
6. **Agent Rule**: what rules the Agent should follow when executing tasks, updating memory, and producing results.

Project facts, task status, and asset names serve only as evidence sources and should not enter L3 directly. Write them only when they can be abstracted into cross-scene rules.

---

## Filtering Criteria

Check each item before writing it to L3:

1. **Generality**: does this apply to multiple projects, multiple tasks, or multiple work settings?
2. **Completeness**: once detached from the original project, can the reader still understand what it asks for?
3. **Actionability**: can the Agent change its future behavior based on it?
4. **Stability**: is it likely to stay valid long-term, rather than being a one-off task status?
5. **Conciseness**: can it be expressed in fewer words? Can it be merged into an existing principle?

If any answer is no, prefer not to write it.

---

## Incremental Update Strategy

When facing changed scenes, judge autonomously:

- **Reinforce**: the new scene merely corroborates an existing principle; compress it into the original sentence or leave unchanged.
- **Supplement**: a new general SOP, taboo, decision logic, or Agent rule appears.
- **Correct**: an old principle is overturned by new evidence or its boundary becomes clearer.
- **Restructure**: when the document becomes scattered, long, or project-specific, compress and rewrite it as a whole.
- **No change**: when the new content is only project status, ordinary tasks, or low-level facts, do not update L3.

Do not append every change as a new entry. L3 should keep compressing, staying small and accurate.

---

## Output Template

Refer to the format below and use the **write** or **edit** tool to write the final content. Sections may be removed, but Markdown format must be kept and the full text must not exceed 1200 words.

# Team Operating Doctrine

> **Operating Thesis**: [One sentence summarizing the team's most core and most general working method or Agent execution principle.]

## Core Principles
[Write only high-level principles that hold stably across work scenarios. Each must be semantically complete.]

- [Principle]&#58; [applicable conditions / decision logic / why it matters]

## Reusable SOPs
[Write only processes that can be executed repeatedly. Do not write project-specific steps.]

- [SOP name]&#58; When [trigger condition], first [step 1], then [step 2], and finally [output / acceptance criteria].

## Decision Logic
[Record trade-off criteria and priorities.]

- When [scenario], prefer [A] over [B], because [reason].

## Boundaries & Anti-patterns
[Record taboos, boundaries, and error patterns.]

- Do not [wrong practice]; instead [recommended practice], because [reason].

## Agent Rules
[Record the behavior rules the Agent follows by default at work.]

- The Agent should [behavior rule], avoiding [risk].

---

> **Last updated**: [current time] · **Source scenes**: [number of scenes] · **Total memories**: [total memories]

---

## Success Criteria

- ✅ You must use write or edit to write \`persona.md\`
- ✅ Final content must not exceed 1200 words
- ✅ Keep only principles, SOPs, taboos, decision logic, and Agent rules reusable across all work settings
- ✅ Every item remains semantically complete once detached from a specific project
- ✅ Favor precision over volume: omit what you can, merge what you can
- ✅ Do not write project progress, task running-accounts, version fragments, or scene indexes
- ✅ Do not add scene navigation (the system automatically appends Scene Navigation and the scene index)
- ✅ Operate only on \`persona.md\``;

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isCodeMode = promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "🆕 First generation" : "🔄 Iterative update";

  const triggerSection = triggerInfo
    ? `\n### Trigger Info\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isCodeMode
      ? `\n## 📄 Current Team Operating Doctrine (preloaded by the system)\n\n` +
        `*Below is the full content of the Team Operating Doctrine in the existing persona.md (${existingPersona.length} characters). After updating it must be compressed to within 1200 words:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 Current Persona (preloaded by the system)\n\n` +
        `*Below is the full content of the existing persona.md (${existingPersona.length} characters). After updating based on it, keep it within 2000 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isCodeMode
      ? `\n## 🔄 Iteration Decision Guide\n\n` +
        `When facing changed scenes, judge how to handle them autonomously: reinforce (corroborate existing principles) / supplement (new general SOPs, taboos, decision logic, or Agent rules) / correct (old principles updated) / restructure (content grown long, scattered, or project-specific) / no change (only project status or low-level facts).\n`
      : `\n## 🔄 Iteration Decision Guide\n\n` +
        `When facing changed scenes, judge how to handle them autonomously: reinforce (corroborate existing insights) / supplement (new dimensions) / correct (contradictions) / restructure (structural adjustment) / no change (no useful new content).\n`
    : "";

  const userPrompt = `**Output language**: \`${targetFile}\` uses the dominant language of the changed-scene content below.

**⏰ Update time**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## 📊 Statistics
- **Total memories**: ${totalProcessed}
- **Total scenes**: ${sceneCount}
- **Changed scenes**: ${changedSceneCount} (since the last update)

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
