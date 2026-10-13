/**
 * Shared type definitions: `MemoryClientConfig` / `Transport`.
 *
 * The v2 `MemoryClient` class has been removed; this SDK only exports the v3 API (strict isolation).
 * These interfaces are kept because the clients in `v3/*.ts` consume them.
 */

export interface MemoryClientConfig {
  /** Base URL, e.g. `https://memory.tencentyun.com` */
  endpoint: string;
  /** Bearer token */
  apiKey: string;
  /** Memory instance ID (sent via `x-tdai-service-id` header). */
  serviceId: string;
  /** Request timeout in ms (default 30 000). */
  timeout?: number;
  /** Whether to reject invalid TLS certificates. Default: false (self-signed friendly). */
  rejectUnauthorized?: boolean;
}

/**
 * Transport interface for testing — inject a mock that satisfies this.
 */
export interface Transport {
  post<T>(path: string, body?: Record<string, unknown>): Promise<T>;
  /** Optional for backward-compatible custom transports; management clients fall back to POST when absent. */
  get?<T>(path: string, query?: Record<string, unknown>): Promise<T>;
}
