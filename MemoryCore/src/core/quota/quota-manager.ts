/**
 * QuotaManager — quota manager
 *
 * Responsibilities:
 * 1. Cache and check whether MemoryLimit / CreditLimit is exceeded
 * 2. Report usage changes via the injected IQuotaReporter
 * 3. Cache Usage locally to avoid calling the remote on every request
 *
 * The quota data source is determined by the injected IQuotaReporter:
 *   - standalone: NoopQuotaReporter (fetchQuota returns null → treated as unlimited)
 *   - service:    remote quota reporter injected by the deployment environment
 */

import type { Logger } from "../logger.js";
import type { IQuotaReporter } from "../abstractions/index.js";

export interface QuotaConfig {
  memoryLimit: number;   // max total memory count (default: 10000)
  creditLimit: number;   // Credit limit (default: 1000)
  memoryUsage: number;   // memory count currently used
  creditUsage: number;   // Credits currently used
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: "memory_limit_exceeded" | "credit_limit_exceeded";
  current?: number;
  limit?: number;
}

export interface QuotaManagerOptions {
  /** Pre-constructed quota reporter for the current deployment. */
  reporter: IQuotaReporter;
  /** Quota cache TTL (ms), default 60s */
  cacheTtlMs?: number;
  /** Default MemoryLimit (used when upstream does not return one) */
  defaultMemoryLimit?: number;
  /** Default CreditLimit (used when upstream does not return one) */
  defaultCreditLimit?: number;
  logger: Logger;
}

const TAG = "[quota-manager]";

export class QuotaManager {
  private reporter: IQuotaReporter;
  private logger: Logger;
  private cacheTtlMs: number;
  private defaultMemoryLimit: number;
  private defaultCreditLimit: number;

  // Per-instance cache
  private cache = new Map<string, { config: QuotaConfig; expiresAt: number }>();

  constructor(opts: QuotaManagerOptions) {
    this.reporter = opts.reporter;
    this.logger = opts.logger;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.defaultMemoryLimit = opts.defaultMemoryLimit ?? 10_000;
    this.defaultCreditLimit = opts.defaultCreditLimit ?? 1_000;
  }

  /**
   * Get the instance quota config (cached)
   *
   * When reporter.fetchQuota() returns null (open-source / no-quota mode), treat as unlimited —
   * return memoryUsage=0/creditUsage=0 + defaultLimit, so all checks pass.
   */
  async getQuota(instanceId: string): Promise<QuotaConfig> {
    const now = Date.now();
    const cached = this.cache.get(instanceId);
    if (cached && now < cached.expiresAt) {
      return cached.config;
    }

    try {
      const snapshot = await this.reporter.fetchQuota(instanceId);

      if (snapshot === null) {
        // No-quota mode (Noop reporter): return default limit + zero usage, never exceeds
        const config: QuotaConfig = {
          memoryLimit: this.defaultMemoryLimit,
          creditLimit: this.defaultCreditLimit,
          memoryUsage: 0,
          creditUsage: 0,
        };
        this.cache.set(instanceId, { config, expiresAt: now + this.cacheTtlMs });
        return config;
      }

      const config: QuotaConfig = {
        memoryLimit: snapshot.memoryLimit,
        creditLimit: snapshot.creditLimit,
        memoryUsage: snapshot.memoryUsage,
        creditUsage: snapshot.creditUsage,
      };
      this.cache.set(instanceId, { config, expiresAt: now + this.cacheTtlMs });
      return config;
    } catch (err) {
      this.logger.warn(`${TAG} Failed to fetch quota for ${instanceId}: ${err instanceof Error ? err.message : String(err)}`);
      return this.getDefaultOrCached(instanceId);
    }
  }

  /**
   * Check whether writing memory is allowed (MemoryUsage < MemoryLimit)
   */
  async checkMemoryQuota(instanceId: string, delta: number = 1): Promise<QuotaCheckResult> {
    const quota = await this.getQuota(instanceId);
    // limit < 0 means unlimited (compatible with the control plane using -1 to express unlimited).
    if (quota.memoryLimit >= 0 && quota.memoryUsage + delta > quota.memoryLimit) {
      return {
        allowed: false,
        reason: "memory_limit_exceeded",
        current: quota.memoryUsage,
        limit: quota.memoryLimit,
      };
    }
    return { allowed: true };
  }

  /**
   * Check whether LLM use is allowed (CreditUsage < CreditLimit)
   */
  async checkCreditQuota(instanceId: string): Promise<QuotaCheckResult> {
    const quota = await this.getQuota(instanceId);
    // limit < 0 means unlimited (compatible with the control plane using -1 to express unlimited).
    if (quota.creditLimit >= 0 && quota.creditUsage >= quota.creditLimit) {
      return {
        allowed: false,
        reason: "credit_limit_exceeded",
        current: quota.creditUsage,
        limit: quota.creditLimit,
      };
    }
    return { allowed: true };
  }

  /**
   * Report usage changes (via the injected reporter)
   * @param memoryDelta memory count change (positive = added, negative = deleted)
   * @param creditDelta Credit consumption change (positive = consumed)
   * @param level memory level ("L0" | "L1" | "L2" | "L3")
   */
  async reportUsage(instanceId: string, memoryDelta: number, creditDelta: number, level: "L0" | "L1" | "L2" | "L3" | "Skill" = "L0"): Promise<void> {
    if (memoryDelta === 0 && creditDelta === 0) return;

    // The reporter guarantees it does not throw; try/catch here anyway in case the interface contract is violated
    try {
      await this.reporter.reportUsage(instanceId, memoryDelta, creditDelta, level);

      // Update the local cache synchronously (whether the reporter is noop or real, local tracking is always needed)
      const cached = this.cache.get(instanceId);
      if (cached) {
        cached.config.memoryUsage += memoryDelta;
        cached.config.creditUsage += creditDelta;
      }

      this.logger.debug?.(`${TAG} Usage reported: instance=${instanceId}, memDelta=${memoryDelta}, creditDelta=${creditDelta}`);
    } catch (err) {
      // Defensive: the reporter should not throw, but if it does it must not affect business logic
      this.logger.error(`${TAG} reportUsage unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Shortcut: report memory added
   */
  async reportMemoryAdded(instanceId: string, count: number, level: "L0" | "L1" | "L2" | "L3" = "L0"): Promise<void> {
    return this.reportUsage(instanceId, count, 0, level);
  }

  /**
   * Shortcut: report memory deleted
   */
  async reportMemoryDeleted(instanceId: string, count: number, level: "L0" | "L1" | "L2" | "L3" = "L0"): Promise<void> {
    return this.reportUsage(instanceId, -count, 0, level);
  }

  /**
   * Shortcut: report Credit consumption
   */
  async reportCreditUsed(instanceId: string, credits: number, level: "L0" | "L1" | "L2" | "L3" = "L1"): Promise<void> {
    return this.reportUsage(instanceId, 0, credits, level);
  }

  /**
   * Shortcut: report Skill VDB added (new skill / new version)
   */
  async reportSkillAdded(instanceId: string, count: number = 1): Promise<void> {
    return this.reportUsage(instanceId, count, 0, "Skill");
  }

  /**
   * Shortcut: report Skill VDB deleted (soft delete / TTL cleanup)
   */
  async reportSkillDeleted(instanceId: string, count: number = 1): Promise<void> {
    return this.reportUsage(instanceId, -count, 0, "Skill");
  }

  /** Clear the cache (for tests) */
  clearCache(): void {
    this.cache.clear();
  }

  private getDefaultOrCached(instanceId: string): QuotaConfig {
    const cached = this.cache.get(instanceId);
    if (cached) return cached.config; // use the stale old cache
    return {
      memoryLimit: this.defaultMemoryLimit,
      creditLimit: this.defaultCreditLimit,
      memoryUsage: 0,
      creditUsage: 0,
    };
  }
}
