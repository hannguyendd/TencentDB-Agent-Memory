/**
 * Main-repo-side type definitions for CosLikeBackend / KernelStsCosOptions -- **the authoritative source**.
 *
 * The cost-guard side `packages/cost-guard/src/storage/cos-types.ts` has a structurally equivalent
 * independent definition (to avoid a reverse dependency on the main repo). Both are 5-method interfaces, naturally compatible under structural typing --
 * the main repo gets the assembly function's return value via `await import("@context-proxy/cost-guard")`
 * (a cost-guard-side CosLikeBackend instance); TypeScript automatically accepts assigning it to the
 * main repo's expected CosLikeBackend variable.
 *
 * This makes tsc compilation **independent of whether the submodule exists** -- even if an open-source user clones with
 * an empty `packages/cost-guard/` directory, the main repo's `tsc` still passes (because the CosLikeBackend
 * type definition lives here, not imported from cost-guard).
 *
 * See docs/design/2026-07-11-cos-submodule-extraction-plan.md section 4.2 decision 1 + section 4.4.
 */

/**
 * Minimal COS backend contract -- CosStorage calls down into these 5 methods.
 */
export interface CosLikeBackend {
  /**
   * PUT object.
   * @param headers extra headers -- CAS scenarios pass `{ "If-None-Match": "*" }`;
   *                the backend should throw `{ statusCode: 412 }` on 412
   */
  putObject(key: string, body: Buffer, headers?: Record<string, string>): Promise<void>;
  getObject(key: string): Promise<Buffer | null>;
  headObject(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
  /** List all keys under prefix (may paginate internally). Return full key path. */
  listKeys(prefix: string): Promise<string[]>;
  /**
   * Optional: evict the per-space backend + STS credential cache of a given spaceId.
   *
   * Only implemented by the kernel-sts assembly (cost-guard `CosStorageBackendMultiSpace`);
   * single-space or pool-less implementations (e.g. a mock backend the main repo might attach in future) should
   * leave it undefined. The `/v3/instance/proxy-destroy` handler detects it via optional call.
   *
   * Returns `true` on hit, `false` on miss or unsupported.
   */
  evictSpace?(spaceId: string): Promise<boolean>;
}

/**
 * Input of `openKernelStsCosBackend` -- mirrors the structure of `StorageConfig.cos`
 * (minus fields unrelated to kernel-sts).
 */
export interface KernelStsCosOptions {
  /** COS key business namespace prefix, e.g. `"proxy_cache/"` (isolated from core's memory_v2/cos_data). */
  rootPrefix: string;
  /**
   * Optional: force the VPC internal network / a custom domain (e.g. `"cos.example.com"`).
   * If empty, uses the host in the CosUrl returned by Shark.
   */
  endpointDomain?: string;
  /**
   * Fetch temporary credentials via Shark -- each spaceId gets its own STS, with permissions strictly bound to
   * the two prefixes `proxy_cache/{ttl|nottl}/{spaceId}/*`.
   */
  shark: {
    baseUrl: string;
    timeoutMs?: number;
    retryCount?: number;
    refreshBufferMs?: number;
    maxSpaces?: number;
    graceCloseDelayMs?: number;
  };
}
