/**
 * Observability Backend Factory — factory function + global singleton management.
 *
 * Creates observability backend instances driven by configuration:
 * - "noop"     → NoopObservabilityBackend (default, zero overhead)
 * - "console"  → ConsoleObservabilityBackend (development/debugging, outputs to stdout)
 * - "otlp"     → OtlpObservabilityBackend (recommended for open-source users, standard OTLP protocol)
 * - "internal" → dynamically loads a private module (internal environment: Zhiyan + Kafka + Langfuse)
 *
 * Open-source users are recommended to use the "otlp" type; configuring a single endpoint reports
 * Trace/Log/Metric all to any backend that supports the OTLP protocol.
 *
 * See the design pattern of src/core/storage/factory.ts.
 */

import type { IObservabilityBackend, ObservabilityConfig } from "./types.js";
import { NoopObservabilityBackend } from "./noop-backend.js";
import { ConsoleObservabilityBackend } from "./console-backend.js";
import { OtlpObservabilityBackend } from "./otlp-backend.js";

const TAG = "[observability][factory]";

// ============================
// dynamically load the private module
// ============================

/**
 * Try to dynamically load the optional observability module.
 * Returns null on load failure.
 */
async function loadInternalBackend(): Promise<{ createInternalObservabilityBackend: (config: ObservabilityConfig) => Promise<IObservabilityBackend> } | null> {
  try {
    return await import("../../integrations/observability/index.js");
  } catch {
    return null;
  }
}

// ============================
// factory function
// ============================

/**
 * Create an observability backend instance.
 *
 * @param config observability configuration
 * @returns IObservabilityBackend instance
 */
export async function createObservabilityBackend(
  config: ObservabilityConfig,
): Promise<IObservabilityBackend> {
  const type = config.type ?? "noop";

  switch (type) {
    case "internal": {
      const privateModule = await loadInternalBackend();
      if (!privateModule) {
        console.warn(
          `${TAG} Internal observability backend requested but private module not available. ` +
          `Falling back to console backend. Install the private submodule for full observability.`,
        );
        const backend = new ConsoleObservabilityBackend();
        await backend.initialize(config);
        return backend;
      }
      const backend = await privateModule.createInternalObservabilityBackend(config);
      await backend.initialize(config);
      return backend;
    }

    case "otlp": {
      const backend = new OtlpObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }

    case "console": {
      const backend = new ConsoleObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }

    case "noop":
    default: {
      const backend = new NoopObservabilityBackend();
      await backend.initialize(config);
      return backend;
    }
  }
}

// ============================
// global singleton management
// ============================

/** Global observability backend instance */
let _globalBackend: IObservabilityBackend = new NoopObservabilityBackend();

/** Whether it has been initialized */
let _initialized = false;

/**
 * Get the global observability backend instance.
 * If not yet initialized, returns a Noop instance (safe degradation).
 */
export function getObservabilityBackend(): IObservabilityBackend {
  return _globalBackend;
}

/**
 * Initialize the global observability backend.
 * Idempotent: only the first call takes effect.
 *
 * @param config observability configuration
 */
export async function initObservabilityBackend(config: ObservabilityConfig): Promise<void> {
  if (_initialized) return;

  try {
    _globalBackend = await createObservabilityBackend(config);
    _initialized = true;
    console.log(`${TAG} Observability backend initialized: type=${_globalBackend.type}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${TAG} Failed to initialize observability backend: ${msg}. Using noop.`);
    _globalBackend = new NoopObservabilityBackend();
    _initialized = true;
  }
}

/**
 * Reset the global observability backend (for plugin hot reload and tests).
 * Calls the current backend's shutdown() first.
 */
export async function resetObservabilityBackend(): Promise<void> {
  try {
    await _globalBackend.shutdown();
  } catch {
    // silent
  }
  _globalBackend = new NoopObservabilityBackend();
  _initialized = false;
}
