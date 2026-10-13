/**
 * resolveSkillConfig — pure function: user-facing SkillConfigInput + ambient capabilities
 * (SkillEnvProbe) → resolved ResolvedSkillConfig + downgrade list.
 *
 * Design: SKILL_ENGINEERING_DESIGN.md §11.1.4
 * - Single-step downgrade per field, no recursive probing.
 * - Exactly one log line per downgrade at the right level.
 * - skill.enabled=false or missing → return null, log nothing.
 * - Resolution is deterministic given input + probe; no env reads.
 *
 * Defaults (when input.enabled=true and field is unspecified):
 * - storeBackend: inherit probe.outerStoreBackend, fallback "sqlite"
 * - contentBackend: auto-probe: cos if hasCosCredentials else local
 * - routing.mode: "bm25"
 * - routing.hybridAlpha: 0.3
 * - routing.searchTopK: 20
 * - routing.charBudgetPercent: 0.01
 * - routing.fastPathMinNameLength: 4
 * - extraction.enabled: false
 * - extraction.maxIterations: 16
 * - resources.maxResourceSizeBytes: 5_000_000
 * - resources.allowExecutable: false
 * - resources.downloadDir: "/tmp/tdai-skill-resources"
 */

import { SkillCoreError } from "./skill-core.js";
import type {
  ResolvedSkillConfig,
  SkillConfigInput,
  SkillDegradation,
  SkillEnvProbe,
} from "./types.js";

export interface ResolverLogger {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const TAG = "[skill][config]";

/** Generic positive-integer validation: use the passed value if valid, otherwise warn and fall back to the default. */
function validPositiveInteger(
  raw: number | undefined,
  fallback: number,
  logger: ResolverLogger,
  fieldName: string,
): number {
  if (raw === undefined) return fallback;
  if (Number.isInteger(raw) && raw > 0) return raw;
  logger.warn(
    `${TAG} ${fieldName}=${raw} invalid (must be positive integer); falling back to ${fallback}`,
  );
  return fallback;
}

/**
 * @param strictMode — when true, COS/contentBackend degradations throw instead of silently
 *   falling back to local. Use in service mode where COS is always required.
 */
export function resolveSkillConfig(
  input: SkillConfigInput | undefined,
  probe: SkillEnvProbe,
  logger: ResolverLogger,
  strictMode = false,
): ResolvedSkillConfig | null {
  if (!input?.enabled) {
    return null;
  }

  const degradations: SkillDegradation[] = [];

  // --------------- store ---------------
  const requestedStore =
    input.storeBackend ?? probe.outerStoreBackend ?? "sqlite";
  let storeBackend: "sqlite" | "tcvdb" | "mongodb" = requestedStore;
  if (storeBackend === "tcvdb" && !probe.hasTcvdbCredentials) {
    degradations.push({
      field: "storeBackend",
      from: "tcvdb",
      to: "sqlite",
      reason: "TCVDB credentials missing (url / apiKey / database)",
      level: "warn",
    });
    logger.warn(
      `${TAG} storeBackend=tcvdb requested but credentials missing — degrading to sqlite`,
    );
    storeBackend = "sqlite";
  }

  // --------------- content ---------------
  const explicitContent = input.contentBackend;
  let contentBackend: "local" | "cos";
  if (explicitContent === "cos") {
    if (probe.hasCosCredentials) {
      contentBackend = "cos";
    } else if (strictMode) {
      throw new SkillCoreError(
        "SKILL_COS_REQUIRED",
        "contentBackend=cos required but COS credentials missing (secretId / secretKey / bucket). " +
          "Verify Shark COS config or cos.env in service mode — refusing to silently fall back to local fs.",
      );
    } else {
      degradations.push({
        field: "contentBackend",
        from: "cos",
        to: "local",
        reason: "COS credentials missing (secretId / secretKey / bucket)",
        level: "info",
      });
      logger.info(
        `${TAG} contentBackend=cos requested but credentials missing — degrading to local fs`,
      );
      contentBackend = "local";
    }
  } else if (explicitContent === "local") {
    contentBackend = "local";
  } else {
    // auto-probe: prefer COS when available
    contentBackend = probe.hasCosCredentials ? "cos" : "local";
  }

  // --------------- routing ---------------
  const requestedMode = input.routing?.mode ?? "bm25";
  let routingMode: "bm25" | "embedding" | "hybrid" = requestedMode;
  if (
    (routingMode === "embedding" || routingMode === "hybrid") &&
    !probe.embeddingAvailable
  ) {
    degradations.push({
      field: "routing.mode",
      from: routingMode,
      to: "bm25",
      reason: "embedding subsystem unavailable (disabled / provider invalid)",
      level: "warn",
    });
    logger.warn(
      `${TAG} routing.mode=${routingMode} requested but embedding unavailable — degrading to bm25`,
    );
    routingMode = "bm25";
  }

  // --------------- extraction ---------------
  const extractionEnabled = input.extraction?.enabled === true;
  if (extractionEnabled && !probe.llmRunnerAvailable) {
    // /v3/skill/extract will return empty candidates when LLMRunner is absent
    degradations.push({
      field: "extraction.runtime",
      from: "enabled",
      to: "noop",
      reason: "no LLMRunnerFactory provided by host",
      level: "warn",
    });
    logger.warn(
      `${TAG} extraction.enabled=true but no LLMRunner — extract will return empty candidates`,
    );
  }

  // --------------- archiveBytes (single archive-size knob) ---------------
  // Derives 7 internal fields: bytesThreshold / requestCompressThresholdBytes /
  // chunkMaxBytes / headKeepBytes / tailKeepBytes / headChars / tailChars。
  // Invalid values (<=0 or non-integer) fall back to the default 40KB + warn.
  const DEFAULT_ARCHIVE_BYTES = 40 * 1024;
  const rawArchive = input.extraction?.archiveBytes;
  let archiveBytes = DEFAULT_ARCHIVE_BYTES;
  if (rawArchive !== undefined) {
    if (!Number.isInteger(rawArchive) || rawArchive <= 0) {
      logger.warn(
        `${TAG} extraction.archiveBytes=${rawArchive} invalid (must be positive integer); ` +
          `falling back to default ${DEFAULT_ARCHIVE_BYTES}`,
      );
    } else {
      archiveBytes = rawArchive;
    }
  }

  // --------------- worker (2026-07-30) ---------------
  // Worker pool concurrency. Priority: env > yaml > default 60. Invalid values warn and fall back to the default.
  const DEFAULT_WORKER_CONCURRENCY = 60;
  const DEFAULT_WORKER_BRPOP_MS = 5000;
  const DEFAULT_EXTRACT_LOCK_TTL_MS = 600_000;
  // Priority: env (valid) > yaml (valid) > default. Invalid env/yaml values both warn and continue to
  // fall through, so that a bad high-priority value does not swallow a good low-priority value.
  let workerConcurrency = DEFAULT_WORKER_CONCURRENCY;
  const envConcurrencyRaw = process.env.TDAI_SKILL_WORKER_CONCURRENCY;
  let envConcurrencyValid = false;
  if (envConcurrencyRaw !== undefined && envConcurrencyRaw !== "") {
    const parsed = Number.parseInt(envConcurrencyRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && String(parsed) === envConcurrencyRaw.trim()) {
      workerConcurrency = parsed;
      envConcurrencyValid = true;
    } else {
      logger.warn(
        `${TAG} TDAI_SKILL_WORKER_CONCURRENCY=${envConcurrencyRaw} invalid (must be positive integer); ignored`,
      );
    }
  }
  if (!envConcurrencyValid && input.worker?.concurrency !== undefined) {
    const raw = input.worker.concurrency;
    if (Number.isInteger(raw) && raw > 0) {
      workerConcurrency = raw;
    } else {
      logger.warn(
        `${TAG} worker.concurrency=${raw} invalid (must be positive integer); ` +
          `falling back to default ${DEFAULT_WORKER_CONCURRENCY}`,
      );
    }
  }

  const workerBrpopMs = validPositiveInteger(input.worker?.brpopBlockMs, DEFAULT_WORKER_BRPOP_MS, logger, "worker.brpopBlockMs");
  const workerExtractLockTtlMs = validPositiveInteger(
    input.worker?.extractLockTtlMs,
    DEFAULT_EXTRACT_LOCK_TTL_MS,
    logger,
    "worker.extractLockTtlMs",
  );
  const workerExtractLockRenewMs = validPositiveInteger(
    input.worker?.extractLockRenewIntervalMs,
    Math.floor(workerExtractLockTtlMs / 4),
    logger,
    "worker.extractLockRenewIntervalMs",
  );

  const resolved: ResolvedSkillConfig = {
    enabled: true,
    storeBackend,
    contentBackend,
    routing: {
      mode: routingMode,
      hybridAlpha: input.routing?.hybridAlpha ?? 0.3,
      searchTopK: input.routing?.searchTopK ?? 20,
      charBudgetPercent: input.routing?.charBudgetPercent ?? 0.01,
      fastPathMinNameLength: input.routing?.fastPathMinNameLength ?? 4,
    },
    extraction: {
      enabled: extractionEnabled,
      toolCallThreshold: input.extraction?.toolCallThreshold ?? 10,
      model: input.extraction?.model,
      maxIterations: input.extraction?.maxIterations ?? 16,
      archiveBytes,
      maxTokens: input.extraction?.maxTokens,
      prefixSkillsLimit: validPositiveInteger(
        input.extraction?.prefixSkillsLimit,
        20,
        logger,
        "extraction.prefixSkillsLimit",
      ),
      // Derived fields — naming and defaults come from the DEFAULT_* constants of add-handler.ts / oversize-strategy.ts,
      // keeping the semantics of "change one archiveBytes and everything follows".
      bytesThreshold: archiveBytes,
      requestCompressThresholdBytes: archiveBytes,
      chunkMaxBytes: 2 * archiveBytes,
      headKeepBytes: archiveBytes,
      tailKeepBytes: archiveBytes,
      headChars: archiveBytes,
      tailChars: archiveBytes,
    },
    compress: {
      toolContentThresholdBytes: input.compress?.toolContentThresholdBytes ?? 2048,
      headBytes: input.compress?.headBytes ?? 1024,
      tailBytes: input.compress?.tailBytes ?? 1024,
    },
    resources: {
      maxResourceSizeBytes:
        input.resources?.maxResourceSizeBytes ?? 5_000_000,
      downloadDir: input.resources?.downloadDir ?? "/tmp/tdai-skill-resources",
      allowExecutable: input.resources?.allowExecutable === true,
    },
    versionTtlSeconds: (input.versionTtlDays ?? 0) * 86400,
    // maxVersions:
    //  - Not configured / explicit 0: disabled (backward compatible: all old instances that are not configured keep the original behavior)
    //  - Positive integer: used as the cap on the number of non-head versions
    //  - Invalid value (negative / non-integer / NaN): goes through validPositiveInteger's warn + falls back to 0
    // An explicit 0 short-circuits, to avoid validPositiveInteger treating it as "must be positive" and falsely warning.
    maxNonHeadVersions:
      input.maxVersions === 0
        ? 0
        : validPositiveInteger(input.maxVersions, 0, logger, "maxVersions"),
    worker: {
      concurrency: workerConcurrency,
      brpopBlockMs: workerBrpopMs,
      extractLockTtlMs: workerExtractLockTtlMs,
      extractLockRenewIntervalMs: workerExtractLockRenewMs,
    },
    degradations,
  };

  logger.info(
    `${TAG} initialized: storeBackend=${resolved.storeBackend}, ` +
      `contentBackend=${resolved.contentBackend}, ` +
      `routing.mode=${resolved.routing.mode}, ` +
      `extraction=${resolved.extraction.enabled}, ` +
      `degradations=${resolved.degradations.length}`,
  );

  return resolved;
}