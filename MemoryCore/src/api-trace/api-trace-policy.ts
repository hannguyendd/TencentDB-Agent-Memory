/**
 * API trace tier policy: inferred from the metadata store backend; no standalone config option.
 */
import type { MetadataBackend } from "../metadata/store/interface.js";

export type ApiTraceProfile = "full" | "lite";

export interface ApiTracePolicy {
  profile: ApiTraceProfile;
  module: string;
  maxFieldChars: number;
  maxJsonChars: number;
  maxSqlChars: number;
  /** Whether to log the HTTP body on the success path */
  httpBodyOnSuccess: boolean;
  /** Whether to log service enter/exit on the success path */
  serviceLayerOnSuccess: boolean;
  /** Whether to log store enter/exit on the success path */
  storeLayerOnSuccess: boolean;
  /** Whether to call trace.report (OTel/Langfuse) */
  httpOtelReport: boolean;
}

export function resolveProfile(backend: MetadataBackend = "sqlite"): ApiTraceProfile {
  return backend === "mongodb" ? "full" : "lite";
}

export function resolvePolicy(backend: MetadataBackend = "sqlite"): ApiTracePolicy {
  const full = resolveProfile(backend) === "full";
  return {
    profile: full ? "full" : "lite",
    module: "meta",
    maxFieldChars: 1024,
    maxJsonChars: 8192,
    maxSqlChars: 2048,
    httpBodyOnSuccess: full,
    serviceLayerOnSuccess: full,
    storeLayerOnSuccess: full,
    httpOtelReport: full,
  };
}
