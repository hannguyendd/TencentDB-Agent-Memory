/**
 * PersonaGenerator: generates or updates user persona using the four-layer
 * deep scan model via CleanContextRunner.
 */

import type { MemoryPromptMode } from "../../config.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import { buildPersonaPrompt } from "../prompts/persona-generation.js";
import { BackupManager } from "../../utils/backup.js";
import { escapeXmlTags } from "../../utils/sanitize.js";
import { report } from "../report/reporter.js";
import { reportL3LatencyMetrics } from "../report/metric-tracking-l3-latency.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { ResolvedMemoryPrompt } from "../memory-prompt/types.js";
import { composeMemorySystemPrompt } from "../memory-prompt/composer.js";

const TAG = "[memory-tdai] [persona]";

export class PersonaGenerator {
  private dataDir: string;
  private runner: LLMRunner;
  private logger: Logger | undefined;
  private backupCount: number;
  private promptMode: MemoryPromptMode;
  private memoryPrompt: ResolvedMemoryPrompt | undefined;
  private instanceId: string | undefined;
  private storage: StorageAdapter | undefined;
  private traceContext: TraceContext | undefined;

  constructor(opts: {
    dataDir: string;
    config: unknown;
    model?: string;
    /** Prompt family for L3 generation (default: chat). */
    promptMode?: MemoryPromptMode;
    /** Resolved custom strategy. Undefined preserves the current system prompt exactly. */
    memoryPrompt?: ResolvedMemoryPrompt;
    backupCount?: number;
    logger?: Logger;
    /** Plugin instance ID for metric reporting (optional) */
    instanceId?: string;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * a CleanContextRunner (decouples from OpenClaw runtime).
     * Must be configured with `enableTools: true`.
     */
    llmRunner?: LLMRunner;
    /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
    storage?: StorageAdapter;
    /** langfuse reporting identity quadruple (team/user/agent/session), fills the trace top-level fields. */
    traceContext?: TraceContext;
  }) {
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.promptMode = opts.promptMode ?? "chat";
    this.memoryPrompt = opts.memoryPrompt;
    this.backupCount = opts.backupCount ?? 3;
    this.instanceId = opts.instanceId;
    this.storage = opts.storage;
    this.traceContext = opts.traceContext;
    // Use injected LLMRunner if available, otherwise fall back to CleanContextRunner
    this.runner = opts.llmRunner ?? new CleanContextRunner({
      config: opts.config,
      modelRef: opts.model,
      enableTools: true,
      logger: opts.logger,
    });
    this.logger?.debug?.(`${TAG} Generator created: model=${opts.model ?? "(default)"}, promptMode=${this.promptMode}, dataDir=${opts.dataDir}`);
  }

  /**
   * Execute local persona generation without advancing checkpoint.
   */
  async generateLocalPersona(triggerReason?: string): Promise<boolean> {
    const startMs = Date.now();
    this.logger?.debug?.(`${TAG} Starting generation: reason="${triggerReason ?? "none"}"`);

    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    this.logger?.debug?.(`${TAG} Checkpoint: total_processed=${cp.total_processed}, last_persona_at=${cp.last_persona_at}`);

    const targetFile = StoragePaths.persona;
    const targetLabel = this.promptMode === "code" ? "team operating doctrine" : "persona";

    // 1. Read existing L3 document (strip navigation)
    let existingPersona: string | undefined;
    try {
      let raw: string | null;
      if (this.storage) {
        raw = await this.storage.readFile(targetFile);
      } else {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        raw = await fs.default.readFile(path.default.join(this.dataDir, targetFile), "utf-8");
      }
      if (raw) {
        existingPersona = stripSceneNavigation(raw).trim() || undefined;
      }
      this.logger?.debug?.(`${TAG} Existing ${targetLabel}: ${existingPersona ? `${existingPersona.length} chars` : "empty"}`);
    } catch {
      this.logger?.debug?.(`${TAG} No existing ${targetFile} file`);
    }

    // 2. Load scene index + identify changed scenes
    const index = await readSceneIndex(this.dataDir, this.storage);
    const changedScenes = index.filter((e) => {
      if (!cp.last_persona_time) return true;
      const updatedMs = new Date(e.updated).getTime();
      const personaMs = new Date(cp.last_persona_time).getTime();
      // If either date is unparseable (NaN), treat as changed (conservative)
      if (Number.isNaN(updatedMs) || Number.isNaN(personaMs)) return true;
      return updatedMs > personaMs;
    });
    this.logger?.debug?.(`${TAG} Scene index: ${index.length} total, ${changedScenes.length} changed since last persona`);

    // 3. Read changed scene contents (full raw content including META, matching Python reference)
    const changedSceneContents: string[] = [];
    for (const entry of changedScenes) {
      try {
        let raw: string | null;
        if (this.storage) {
          raw = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${entry.filename}`);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          raw = await fs.default.readFile(path.default.join(this.dataDir, "scene_blocks", entry.filename), "utf-8");
        }
        if (!raw) continue;
        changedSceneContents.push(
          `### [${changedSceneContents.length + 1}] ${entry.filename}\n\n\`\`\`markdown\n${raw}\n\`\`\``,
        );
      } catch {
        this.logger?.warn(`${TAG} Could not read scene block: ${entry.filename}`);
      }
    }

    if (changedSceneContents.length === 0 && existingPersona) {
      this.logger?.debug?.(`${TAG} No scene changes and persona exists, skipping generation`);
      return false;
    }

    // 4. Determine mode
    const mode = existingPersona ? "incremental" : "first";
    this.logger?.debug?.(`${TAG} Generation mode: ${mode}, ${changedSceneContents.length} scene blocks to process`);

    // 5. Build changed scenes section with guidance (matching Python reference format)
    let changedScenesContent: string;
    if (changedSceneContents.length > 0) {
      changedScenesContent =
        `\n\n## 📄 Full Content of Changed Scenes\n\n` +
        `*Since the last Persona update, the following ${changedSceneContents.length} scene(s) have changed. The full content has been preloaded for you:*\n\n` +
        changedSceneContents.join("\n\n") +
        `\n\n---\n\n` +
        `⚠️ **Focus on the changed scenes**: The scenes above are **new/modified content** since the last update; **focus your analysis** on the new information in these scenes.\n`;
    } else {
      changedScenesContent = `\n\n⚠️ **No changed scenes**: All scenes were already analyzed in the last Persona update; this time you may read all scenes directly for a global review.\n`;
    }

    // 6. Build prompt
    const personaFilePath = this.storage
      ? targetFile
      : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, targetFile); })();
    const checkpointPath = this.storage
      ? StoragePaths.checkpoint
      : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, ".metadata", "recall_checkpoint.json"); })();

    const { systemPrompt: baseSystemPrompt, userPrompt } = buildPersonaPrompt({
      mode,
      promptMode: this.promptMode,
      currentTime: new Date().toISOString(),
      totalProcessed: cp.total_processed,
      sceneCount: index.length,
      changedSceneCount: changedScenes.length,
      changedScenesContent,
      existingPersona,
      triggerInfo: triggerReason,
      personaFilePath,
      checkpointPath,
    });
    const systemPrompt = composeMemorySystemPrompt(baseSystemPrompt, this.memoryPrompt);

    // 7. Backup before LLM run (LLM writes persona.md via tools)
    const bm = new BackupManager(this.storage
      ? undefined  // COS mode: BackupManager not used (TODO: adapt BackupManager for StorageAdapter)
      : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, ".backup"); })()
    );
    if (!this.storage) {
      const path = await import("node:path");
      await bm.backupFile(path.default.join(this.dataDir, targetFile), "persona", `offset${cp.total_processed}`, this.backupCount);
    }

    // 8. Run LLM agent (sandboxed to dataDir, tools enabled — LLM writes target L3 file directly)
    try {
      this.logger?.debug?.(`${TAG} Calling LLM for ${targetFile} generation (timeout=180s, tools=enabled, workspaceDir=${this.dataDir})...`);
      // langfuse trace semantics: L3 persona generation has its own name / top-level user/session columns / filterable tags.
      const traceParams = buildTraceParams("memory.persona-generate", this.traceContext);
      await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: "persona-generation",
        timeoutMs: 180_000,
        // maxTokens omitted → core uses the resolved model's maxTokens from catalog
        workspaceDir: this.dataDir,
        // Service mode: LLM tools read/write via StorageAdapter (COS) instead of local FS
        storage: this.storage,
        storagePrefix: this.storage ? "" : undefined,
        ...traceParams,
      });
      this.logger?.debug?.(`${TAG} LLM runner completed`);
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      this.logger?.error(`${TAG} Persona generation failed after ${elapsedMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return false;
    }

    // 9. Read LLM-written persona.md and apply post-processing
    let personaText: string;
    try {
      let raw: string | null;
      if (this.storage) {
        raw = await this.storage.readFile(targetFile);
      } else {
        const fs = await import("node:fs/promises");
        raw = await fs.default.readFile(personaFilePath, "utf-8");
      }
      if (!raw) throw new Error(`${targetFile} not found`);
      personaText = raw;
    } catch {
      // LLM failed to write persona.md — treat as failure
      this.logger?.error(`${TAG} LLM did not write ${targetFile} — file not found after runner completed`);
      return false;
    }

    // 10. Strip any navigation the LLM might have added + sanitize for safe injection
    personaText = escapeXmlTags(stripSceneNavigation(personaText).trim());

    if (!personaText) {
      this.logger?.error(`${TAG} LLM wrote empty ${targetFile} — skipping`);
      return false;
    }

    // 11. Append fresh scene navigation and write final content
    const nav = generateSceneNavigation(index, undefined, false);
    const finalContent = nav ? `${personaText}\n\n${nav}\n` : personaText;
    if (this.storage) {
      await this.storage.writeFile(targetFile, finalContent);
    } else {
      const fs = await import("node:fs/promises");
      await fs.default.writeFile(personaFilePath, finalContent, "utf-8");
    }

    const elapsedMs = Date.now() - startMs;
    this.logger?.info(`${TAG} ${targetFile} written (${finalContent.length} chars) in ${elapsedMs}ms`);

    // ── l3_persona_generation metric ──
    if (this.instanceId && this.logger) {
      report("l3_persona_generation", {
        triggerReason: triggerReason ?? "unknown",
        mode: existingPersona ? "incremental" : "initial",
        newPersonaContent: personaText,
        newPersonaLength: personaText.length,
        totalDurationMs: elapsedMs,
        success: true,
        error: null,
      });
    }

    // ── Eval metrics: L3 latency + persona changes ──
    try {
      reportL3LatencyMetrics({
        instanceId: this.instanceId ?? "",
        generationLatencyMs: elapsedMs,
        personaLengthBefore: existingPersona ? existingPersona.length : 0,
        personaLengthAfter: finalContent.length,
        personaTextBefore: existingPersona ?? "",
        personaTextAfter: personaText,
        hasError: false,
      });
    } catch {
      // silently ignore
    }

    return true;
  }

  /**
   * Backward-compatible wrapper: local generation + checkpoint advance.
   */
  async generate(triggerReason?: string): Promise<boolean> {
    const updated = await this.generateLocalPersona(triggerReason);
    if (!updated) return false;

    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    await cpManager.markPersonaGenerated(cp.total_processed);
    return true;
  }
}
