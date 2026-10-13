/**
 * Unified entry point for the Task external-source module.
 *
 * Only exposes: types, registry, import service, TAPD provider.
 * All internal service addresses come from deployment config; this module embeds no domain names.
 *
 * Note: import is a **one-time snapshot**; there is no "sync remote changes" capability (no scheduled sync,
 * no manual sync from the drawer page), so this module has no sync export.
 */

export * from "./types.js";
export { TaskSourceRegistry, type TaskSourceMeta } from "./registry.js";
export {
  TaskSourceImportService,
  readExternalRef,
  IMPORT_AGENT_ID,
  type ExternalRef,
  type ImportItem,
  type ImportResult,
} from "./import-service.js";
export { tapdProvider } from "./providers/tapd/index.js";
