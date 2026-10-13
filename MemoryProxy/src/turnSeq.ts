/**
 * Turn sequence counting -- stateless derivation on the host side.
 *
 * One trace = one turn (one user input). The tool loop within a turn produces multiple upstream
 * requests, which must compute the **same** turn sequence number so they merge into the same trace in Langfuse.
 *
 * Since the host side has no per-request persistent state (the turn counter lives inside a private module and does not
 * expose per-turn sequence numbers), we derive it directly from the `messages` history: count the number of
 * "human input rounds" in the message sequence. The rules align with the private module's turn detection logic:
 *   - Anthropic: a user message containing a text block other than <system-reminder> is human input;
 *     pure tool_result / pure system-reminder is a tool loop continuation.
 *   - OpenAI: role=user with non-<system-reminder> text is human input; role=tool is the tool loop.
 *
 * Therefore: the first request of a turn and its subsequent tool-loop requests have the same "human round count", so turnSeq is identical.
 * The next turn's request has one more human input -> turnSeq +1 -> new trace.
 *
 * Note: relies on the client sending the full history (both Claude Code and CodeBuddy do). If the client truncates history,
 * turnSeq may drift, but stays consistent within the same turn (only the absolute value drifts), so "same turn, same trace" is unaffected.
 * Absolute drift can make the sequence number **go backwards** (seen in production: 97 -> 1), colliding with usage rows written earlier in that session --
 * when Redis is enabled, `resolveMonotonicTurnSeq()` replaces the locally derived value with a session-level monotonic sequence.
 */

import type { ProxyConfig } from "./types.js";
import { getRedisClient } from "./db/redis-client.js";
import { log } from "./report/log.js";

/** Determine whether a single user message's content is human input (not a tool loop continuation). */
function isHumanUserContent(content: unknown): boolean {
  if (typeof content === "string") {
    return !content.startsWith("<system-reminder>");
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b && typeof b === "object" && b.type === "text") {
        const text = (b.text as string) ?? "";
        if (!text.startsWith("<system-reminder>")) return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Count the "human input rounds" in messages, used as the current turn sequence number.
 *
 * Returns >= 1 (at least the current round); returns 0 for empty messages or no human input.
 */
export function countHumanTurns(messages: unknown[], protocol: "openai" | "anthropic"): number {
  let count = 0;
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m?.role !== "user") continue;
    // OpenAI tool responses are role=tool (never reach here); user messages are judged by content.
    if (protocol === "openai" || protocol === "anthropic") {
      if (isHumanUserContent(m.content)) count += 1;
    }
  }
  return count;
}

/**
 * OpenAI Responses API (codex / workbuddy) version -- counts items in body.input[]
 * with type="message" && role="user".
 *
 * Aligned with the openai/anthropic versions: the tool loop within a turn (function_call +
 * function_call_output) adds no user message -> same turnSeq -> same langfuse trace.
 *
 * Before migration, the codex/wb runners each kept their own copy of the implementation (blueprint §2.4 copy-paste).
 */
export function countHumanTurnsResponses(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "message") continue;
    if (it.role !== "user") continue;
    count++;
  }
  return count;
}

// --- Session-level monotonic turn sequence (Redis) ---------------------------------------

/**
 * Key prefix exclusively owned by the sequence state.
 *
 * Does not reuse `config.redis.keyPrefix` (`cg:sess:`): RedisSessionStore puts an INCR string counter at
 * `cg:sess:turnseq:<session>`, while a hash is stored here;
 * the same name would directly cause WRONGTYPE.
 */
const TURN_SEQ_KEY_PREFIX = "turnseq:";

const DEFAULT_TURN_SEQ_TTL_DAYS = 30;

/**
 * Allocate a session-level monotonic turn sequence number. Single-key EVAL, serialized by Redis across instances.
 *
 * Hash fields: `seq` = the largest sequence number issued for the session; `k:<lane>` / `s:<lane>` = the last local marker
 * of each lane and its corresponding sequence number.
 *
 * If the marker is unchanged (tool loop of the same turn), reuse the previous sequence number; if the marker changes, take
 * `max(max issued + 1, local value)`: when history is complete the sequence still equals the human round count; when history is truncated
 * (local value falls back) it goes +1 instead, so it only moves forward and never collides with an old turn.
 */
const ALLOCATE_TURN_SEQ_LUA = `
local markField = "k:" .. ARGV[1]
local seqField = "s:" .. ARGV[1]
local state = redis.call("HMGET", KEYS[1], markField, seqField, "seq")
local seq
if state[1] == ARGV[2] and state[2] then
  seq = tonumber(state[2])
else
  seq = (tonumber(state[3]) or 0) + 1
  local localSeq = tonumber(ARGV[2]) or 0
  if localSeq > seq then seq = localSeq end
  redis.call("HSET", KEYS[1], markField, ARGV[2], seqField, seq, "seq", seq)
end
redis.call("EXPIRE", KEYS[1], ARGV[3])
return seq
`;

/**
 * Replace the locally derived turn sequence number with the session's monotonic sequence number on Redis.
 *
 * `lane` separates request streams that share a sessionKey but have completely different history lengths: Claude Code's
 * sidequery / fork history has only one or two entries, and putting it on the same lane as the main conversation would make them judge each other as a "new turn",
 * splitting one turn's tool loop into two traces.
 *
 * If any step is unavailable, return `localTurnSeq` as-is (Redis not enabled, no client available, EVAL failed,
 * sequence number itself is 0), keeping behavior identical to before Redis was enabled -- observability accounting is not worth blocking requests.
 */
export async function resolveMonotonicTurnSeq(
  config: ProxyConfig,
  sessionKey: string,
  localTurnSeq: number,
  lane = "main",
): Promise<number> {
  if (localTurnSeq <= 0 || !sessionKey) return localTurnSeq;
  if (!config.redis?.enabled) return localTurnSeq;

  const client = getRedisClient(config.redis);
  if (!client) return localTurnSeq;

  const ttlDays = config.redis.turnSeqTtlDays ?? DEFAULT_TURN_SEQ_TTL_DAYS;
  try {
    const raw = await client.eval(
      ALLOCATE_TURN_SEQ_LUA,
      1,
      `${TURN_SEQ_KEY_PREFIX}${sessionKey}`,
      lane,
      String(localTurnSeq),
      String(Math.max(1, Math.floor(ttlDays * 24 * 3600))),
    );
    const seq = Number(raw);
    return Number.isFinite(seq) && seq > 0 ? seq : localTurnSeq;
  } catch (err) {
    log.warn("turn_seq.allocate_failed", {
      sessionKey,
      lane,
      localTurnSeq,
      error: err instanceof Error ? err.message : String(err),
    });
    return localTurnSeq;
  }
}
