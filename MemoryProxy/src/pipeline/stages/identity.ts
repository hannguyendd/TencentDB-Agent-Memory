/**
 * stages/identity.ts — identity tracking stage (Phase 4 stage-ification).
 *
 * Extracted from the inspectAndRecord calls, one each in openai-chat / anthropic.
 * Missing in old codex/wb (handler-audit bug B5, P1) — to fix the bug later, just
 * add the same call line in the codex/wb runner.
 *
 * Semantics: fire-and-forget, never blocks the business flow.
 */

import type { Context } from "hono";
import { inspectAndRecord } from "../../identity.js";

export function stageIdentity(
  c: Context,
  body: Record<string, unknown>,
  agentSource: string,
): void {
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  try {
    inspectAndRecord("POST", c.req.path, reqHeaders, body, agentSource);
  } catch {
    // fire-and-forget: never block the business flow
  }
}
