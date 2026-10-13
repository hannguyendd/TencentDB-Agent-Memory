/**
 * v3 instance tenant: resolve instance_id from x-tdai-service-id (v2.8).
 */
import type { IncomingHttpHeaders } from "node:http";
import { InvalidInstanceIdError, resolveMetadataDbName } from "../store/db-name.js";
import { MetadataError } from "../service/metadata-service.js";

/**
 * Validate that instance_id can be routed to a metadata database name; throw MetadataError if invalid.
 * Validated uniformly at the route layer so the store-layer InvalidInstanceIdError does not leak as a 500.
 */
export function normalizeInstanceIdForRoute(instanceId: string): string {
  const trimmed = instanceId.trim();
  if (!trimmed) {
    throw new MetadataError("missing_instance_id", "x-tdai-service-id header is required");
  }
  try {
    resolveMetadataDbName(trimmed);
  } catch (err) {
    if (err instanceof InvalidInstanceIdError) {
      throw new MetadataError("invalid_instance_id", err.message);
    }
    throw err;
  }
  return trimmed;
}

export function extractInstanceId(headers: IncomingHttpHeaders): string {
  const raw = headers["x-tdai-service-id"];
  const id = Array.isArray(raw) ? raw[0] : raw ?? "";
  return normalizeInstanceIdForRoute(id);
}
