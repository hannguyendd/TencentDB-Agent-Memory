/**
 * Claude Code CLI client adapter.
 *
 * Specialized implementation:
 *   - classifyRequest: cache_control marker position + three-way split on tools/thinking
 *     (source: reverse-engineered CC source forkedAgent.ts / sideQuery.ts + packet-capture evidence)
 *   - extractUserText: take the last text block
 *     (CC user content often has several <system-reminder> metadata blocks up front; only the last block is the user's input)
 *
 * See docs/design/2026-07-30-cc-request-routing-plan.md for details
 */

import { classifyCcRequest } from "../common/cc-request-classifier.js";
import { extractLastUserText } from "../common/user-text-extractor.js";
import type { AgentAdapter } from "./types.js";

export const claudeCodeAdapter: AgentAdapter = {
  agentKind: "claude-code",
  classifyRequest(body, _path?, _headers?) {
    return classifyCcRequest(body);
  },
  extractUserText(content) {
    return extractLastUserText(content);
  },
};
