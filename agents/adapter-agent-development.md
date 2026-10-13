# New Client Adaptation Guide

> **Purpose**: If you want to integrate a new AI Agent client that Memory Proxy does **not yet support** (Aider / Cursor / a new desktop IDE / a home-grown CLI / some future harness), follow this guide all the way from "packet capture reconnaissance -> define the adaptation scope -> 20 code steps -> e2e passing". Five clients have already been verified in practice (Claude Code / CodeBuddy / Codex / Workbuddy / dsh); the common pitfalls and adaptation points hit each time are codified here so the next client does not have to step on all of them again.
>
> **Don't skip steps** — every step was distilled from a pitfall. When you hit a problem, check [Phase 3: Common Pitfalls Quick Reference](#phase-3-common-pitfalls-quick-reference) first.
>
> **Reference implementation**: dsh is currently the most complete integration case in terms of pitfalls hit, and all of its code is in this repo. See the section at the end, [Reference Implementation: dsh (Grouped by Capability)](#reference-implementation-dsh-grouped-by-capability) — it lists, **item by item per adaptation scope**, where dsh was changed, so you can copy it for your own client.

---

## Phase 0: Packet Capture Reconnaissance (30–60 minutes, no code changes)

**Why capture first**: assuming clients are equivalent = stepping on a pitfall every time. For **each** of the 5 clients, the body shape / session_id header / metadata wrapper / options count limit / ask-user tool name are all different. **Pin down the 5 differences first**, then touch the code.

### 0.1 Capture 3–5 real requests

Use **mitmproxy**:

```bash
pip3 install --user mitmproxy    # skip if already installed
mitmdump -p 8888 -s /tmp/capture.py --set stream_large_bodies=100m
```

The addon in `/tmp/capture.py` does only one thing: grep requests of the target client by `user-agent` and save each request/response body as JSON. Just swap the grep keyword for the new client's fingerprint.

**Key**: Node >=18 clients need `NODE_OPTIONS='--use-env-proxy'` to honor `HTTPS_PROXY` (undici ignores it by default). See [Pitfall G in Phase 3](#pitfall-g-https_proxy-has-no-effect-when-capturing-on-node-22).

### 0.2 Fill in the table for the 5 differences after capturing

Create a `<client>-recon/` directory (outside this repo or local) to store fixtures + analysis, and compare item by item against the table below:

| Dimension | What to look at in the capture |
|---|---|
| **body shape** | Is the main body field `messages[]` (OpenAI/Anthropic) or `input[]` (OpenAI Responses)? Is the user text in `messages[i].content[j].text`, in `messages[i].content` (str), or in `input[i].content[j].text`? |
| **session_id header** | Which headers exist, and which one is the sid? Is there a backup field in the body? |
| **First-frame metadata role=user** | Count how many role=user messages the client stuffs into `messages[]`, and identify a stable signature for each (such as prefixes like `<system-reminder>` / runtime context / available_skills) — only the one that is the real user input should be treated by the proxy as the "user message"; the other metadata entries must be filtered out |
| **ask-user tool name + shape** | Find the client source `packages/*/tool-ask-user/**` or similar, and get the tool name + parameter schema (required fields / snake vs camel case) |
| **options count limit** | Open the client UI source and search `options.length` / `maxOptions` / `slice`; no truncation = no pagination needed |

**These 5 differences determine the subsequent code changes**. Missing any one will lead to a pitfall.

### 0.3 Decide whether an aux short-circuit is needed

Check whether the client sends **independent types of requests** (compaction / title-gen / memgen, etc.). Criteria:

- Does it have a separate endpoint path? (codex has `/responses/compact`, workbuddy is similar)
- Does it have a separate header? (dsh has `x-deepseek-harness-compact:1`)
- Does it rely on body characteristics? (dsh title-gen relies on missing tools + `thinking.disabled` + `max_tokens <= 128` + a system prompt prefix)

**For any client that has aux requests, the adapter `classifyRequest` must be able to classify them**. CC/CB are all main with no aux; codex/workbuddy/dsh all have aux.

---

## Phase 1: Adaptation Scope Overview (Clarify What to Do First)

Memory Proxy does the following 10 things for a client **at minimum**. Don't start by diffing dsh and copying code — **first tick through the table below**: which capabilities **must** run on the new client, which are **optional**, and which are **not applicable**. Once the list is ticked, move on to Phase 2 and write code, and you will have a feel for the workload.

| # | Adaptation capability | Problem it solves | Required? | Related modules |
|---|---|---|---|---|
| 1 | **Routing & allowlist** | Make the proxy recognize the path `/<client>/<spaceId>/...` and add `<client>` to the various regex allowlists; otherwise auth returns 401 / requests fall through to 404 | ✅ Required | `MemoryProxy/src/server.ts`, `MemoryProxy/src/credit-reporter.ts` |
| 2 | **Session ID resolution** | Find a stable "unique conversation identifier" in the client header/body so that all requests of the same conversation land on the same sessionKey; if missed → all sessions collide into the same key and the session-init state gets corrupted | ✅ Required | `MemoryProxy/src/session/session-key.ts::resolveConversationId` |
| 3 | **Request classification (main / aux / headless)** | Distinguish "real user conversation" from "client background auxiliary requests" (title-gen / compaction / memgen); aux must **entirely skip** session-init / mem / injection / L0 / skill trigger and pass straight through | ✅ Required | `MemoryProxy/src/agent-adapters/<client>.ts::classifyRequest`, top of `MemoryProxy/src/handler.ts` |
| 4 | **User text extraction** | Pick the "real user input" string out of the body (used for mem command recognition / L0 archiving / skill extraction), skipping metadata role=user | ✅ Required | `MemoryProxy/src/agent-adapters/<client>.ts::extractUserText`, `MemoryProxy/src/session/store.ts::tryHistoryScan`, `MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` |
| 5 | **Session Init Form** | On the first conversation, pop up a 4-step form for the user to pick team / agent / task (`asset_confirm → team → agent → task`); the carrier is the `ask_user_question` (or similar) tool_call hung on the client preset | ⚠️ Client has interactive capability = required; pure CLI headless = optional (use the bypass from Pitfall C) | `MemoryProxy/src/session/<client>/form.ts`, `MemoryProxy/src/session/index.ts` dispatch, `MemoryProxy/src/session/codebuddy/init.ts` split-stage gate |
| 6 | **Header preselection (skip the form)** | CI/CD / automation / clients that cannot respond to a form can directly carry the `x-team-id` + `x-agent-id` + `x-task-id` + `x-conversation-id` headers to register a session in one step; already generically supported, most clients **need no code changes** | ➖ Optional (already generic) | No changes needed; handled generically by `MemoryProxy/src/session/registrar.ts` |
| 7 | **Asset injection (Injection)** | On every main conversation turn, stuff asset blocks such as `<agent_skills>` / `<user_memory>` / `<session_context>` / `<tdai_profile_memory>` into the system message, delivering team memory to the LLM | ✅ Required | Use the existing `MemoryProxy/src/injection/adapters/{openai,anthropic}.ts`; if the client wire has special fields (such as dsh `reasoning_content`), add a metadata round-trip |
| 8 | **Wire compatibility / special field passthrough** | The client may strictly validate that certain non-standard fields are round-tripped (dsh's `reasoning_content` / DeepSeek thinking chain); the injection pipeline's parse→serialize must not erase them | ⚠️ Only needed if the client has special fields | `parseMessage` / `serializeMessage` in `MemoryProxy/src/injection/adapters/openai.ts` or `anthropic.ts`, stored via `ContextMessage.metadata` |
| 9 | **Mem command interception** | When the user sends `mem:help` / `mem:sync` / `mem:create-skill` / `mem:session-reset` in the conversation, the proxy intercepts and returns a short-circuit response (open the panel / refresh assets / trigger extraction / reset state) without going to the upstream LLM | ✅ All take effect when the client has form capability; headless bypass clients support only some | The mem-command section of `MemoryProxy/src/handler.ts` (generic; takes effect automatically as long as `agentSource` is recognized) |
| 10 | **L0 archiving / Skill extraction** | Both directions of main-conversation messages are written to `tdai-recorder:write-l0`; when the conversation exceeds a threshold or the user force-archives, `skill/conversation/add` is triggered to let core extract skills | ✅ Required | Tail of `MemoryProxy/src/handler.ts` (generic; takes effect automatically as long as the aux/headless criteria are correct) |
| 11 | **Observability / Langfuse** | The trace carries the `agent_source:<client>` tag, session-init stage logs, and tool_call instrumentation, to ease online troubleshooting | ✅ Required (one-line tag, nearly zero cost) | `agentAdapter.agentKind` is injected generically; confirm the new `agent_source` is visible in the langfuse trace tags |

**Decision principles**:

- Capabilities marked "Required" must **all be done** for it to count as basically usable
- "Optional" ones are decided by the client scenario (CLI-only clients can skip 5 and 9 and keep only 6, header preselection)
- If the client has unique wire fields (such as DeepSeek's thinking chain) → capability 8 is a must, otherwise the upstream returns 400
- If the client sends aux requests such as title-gen / compact → capability 3 is a must, otherwise aux requests wrongly pop up a form / wrongly write L0

**Effort estimate**: a complete adaptation (covering 1–11), given the verified dsh reference, takes about 3–4 working days for capture + coding + unit tests + e2e; pitfalls never seen before are extra.

---

## Phase 2: Code Changes (20-step checklist, in order)

Take the capabilities ticked in the Phase 1 table and land them in concrete files. Each step has a corresponding capability number (capability #1 = "Routing & allowlist", and so on).

### 2.1 Skeleton, 4 steps (30 minutes) — maps to capabilities #1, #3, #4

| # | File | Change | Capability |
|---|---|---|---|
| 1 | `MemoryProxy/src/agent-adapters/<client>.ts` | New — `classifyRequest` triple signal + `extractUserText` | #3 #4 |
| 2 | `MemoryProxy/src/agent-adapters/types.ts` | Add `"<client>"` to the `AgentKind` union | #3 |
| 3 | `MemoryProxy/src/agent-adapters/index.ts` | Add a case to the factory switch | #3 |
| 4 | `MemoryProxy/src/server.ts` | Add 9 routes (with/without `v1` × main endpoint/aux/cost-guard/analyse marker), copy from the dsh section | #1 |

### 2.2 Allowlist & Session identification, 3 steps — maps to capabilities #1, #2, #7

| # | File | Change | Capability |
|---|---|---|---|
| 5 | `MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | Add `\|<client>` to the regex — **if missed it returns auth 401 `missing service_id`** | #1 |
| 6 | `MemoryProxy/src/session/session-key.ts::resolveConversationId` | Add the client-specific session header to the header fallback chain | #2 |
| 7 | Skip if no standalone profile is needed; otherwise a set under `MemoryProxy/src/injection/agents/<client>/*` (see `MemoryProxy/src/injection/agents/workbuddy/`) | #7 |

### 2.3 Session Init Form carrier, 4 steps — maps to capability #5

| # | File | Change | Capability |
|---|---|---|---|
| 8 | `MemoryProxy/src/session/<client>/form.ts` | New — tool name / parameter shape strictly follow the client preset; don't reuse another client's | #5 |
| 9 | `MemoryProxy/src/session/index.ts` | Add a dispatch branch (see the workbuddy section: the CB state machine produces `formData` and the outer layer re-renders) | #5 |
| 10 | `MemoryProxy/src/session/codebuddy/init.ts` split-stage gate | Add `\|\| agentSource === "<client>"` at 5 gates — if missed, agent+task are asked together and it bypasses directly | #5 |
| 11 | `MemoryProxy/src/session/codebuddy/cleaner.ts` `tool_call_id` regex | Add the `\|<client>_` prefix recognition | #5 |

### 2.4 Metadata filtering & Wire compatibility, 3 steps — maps to capabilities #4, #8

| # | File | Change | Capability |
|---|---|---|---|
| 12 | `MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` | Skip user counting by the client's first-frame metadata signature — if missed it wrongly judges "has history" and skips session-init | #4 |
| 13 | `MemoryProxy/src/session/store.ts::tryHistoryScan` | Same filtering logic | #4 |
| 14 | Wire special field round-trip (such as dsh's `reasoning_content`) — preserve via metadata in the parse/serialize of `MemoryProxy/src/injection/adapters/openai.ts` or `anthropic.ts`; must be verified with a debug env bidirectional body dump comparison | #8 |

### 2.5 Handler short-circuit, 2 steps — maps to capabilities #3, #5, #9, #10

| # | File | Change | Capability |
|---|---|---|---|
| 15 | Top of `MemoryProxy/src/handler.ts` | Call `agentAdapter.classifyRequest(body, path, headers)` to classify; when `isAuxiliary=true`, session-init / mem / injection / L0 / skill trigger are **all skipped** and the request passes straight through | #3 #9 #10 |
| 16 | Top of `MemoryProxy/src/handler.ts` | If the client has a CLI headless scenario (the preset lacks tools, no ask-user among them), add a `_headless` criterion like dsh's, skipping the form like aux; mem commands give a hint or degrade to header preselection | #5 #9 |

### 2.6 Testing & verification, 4 steps — maps to capabilities #5, #9, #10, #11

| # | Content | Capability |
|---|---|---|
| 17 | Unit tests: adapter `classifyRequest` + form builder shape + real-capture fixture end-to-end — placed in `MemoryProxy/src/__tests__/agent-adapters/<client>.test.ts` + `MemoryProxy/src/session/<client>/__tests__/form.test.ts` | #3 #5 |
| 18 | curl smoke: hit `/<client>/default/*` directly to trigger the form, and verify the three-state transitions of session-init (`asset_confirm → team → agent → task`) | #5 |
| 19 | web e2e (playwright recommended): **actually run the client web UI** (session-init 4 steps + 1 real conversation turn, verifying injection + archiving + langfuse trace) | #5 #7 #10 #11 |
| 20 | mem / L0 / skill end-to-end: in an already-initialized session send `mem:help` / `mem:sync` / `mem:create-skill` / a long conversation to trigger skill extraction / grep the proxy log to verify L0 writes | #9 #10 |

---

## Phase 3: Common Pitfalls Quick Reference

Each of the first 5 clients hit at least 3 pitfalls. **Check here first before debugging on your own**.

### Pitfall A: `missing service_id (spaceId not in request path)` 401

**Root cause**: the allowlist regex in `credit-reporter.ts::extractSpaceIdFromPath` does not include the new client name.

**Fix**: add it to `^(claude-code|codebuddy|codex|cursor|hermes|openclaw|workbuddy|dsh|<new-client>)$`.

### Pitfall B: the session-init form pops up / or never pops up

- **Never pops up** = the `resolveConversationId` fallback does not recognize the client's session header → sessionKey falls back to keyId, or `isFreshCBConversation` treats the first-frame metadata user as "has history" → goes to the markerless bypass.
  - Fix the `session-key.ts` fallback chain + `codebuddy/init.ts::isFreshCBConversation` + `store.ts::tryHistoryScan` to add metadata signature filtering
- **Pops up but the task is not asked after picking the agent** = the split-stage gate was not added for the new client → goes through CB's old ask-both-at-once pending_agent_task → task is empty and bypasses directly.
  - Fix the 5 gates in `codebuddy/init.ts` by adding `|| agentSource === "<client>"`
- **Pagination infinite loop / the default task appears at the start of every page** = reused CC's 4-per-page pagination but did not write MORE interception.
  - Fix: when the client UI has no options limit, **turn off pagination directly and render everything** (dsh takes this route)

### Pitfall C: upstream 400 `unknown tool ""`

**Root cause**: the client preset does not hang `ask_user_question` (or this client's UI tool), and the fake `tool_call` stuffed in by the proxy is rejected by validation.

**Fix**: add a headless bypass — when `body.tools` is non-empty but lacks that tool, pass through directly without popping a form.

### Pitfall D: upstream 400 `The reasoning_content in the thinking mode must be passed back to the API`

**Root cause** (two pitfalls hit together):

1. The fake session-init assistant message carries no `reasoning_content` field
2. An empty string `""` was stuffed in → the client's translate.ts swallows it with a `length > 0` criterion

**Fix**: stuff the fake response with a **non-empty** placeholder string (such as `[proxy session-init form]`).

**Secondary pitfall**: a non-empty placeholder was stuffed in and the client also replays it back to the proxy, but the **injection pipeline's parse→serialize erased the field**.

- Use the two env vars `PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY` to capture inbound/outbound bodies for comparison.
- Fix `parseMessage`/`serializeMessage` in `MemoryProxy/src/injection/adapters/openai.ts` / `anthropic.ts`, storing passthrough fields in `ContextMessage.metadata`.

### Pitfall E: aux requests (compaction / title) wrongly go through session-init and pop a form

**Root cause**: there is no `classifyRequest` at the top of `handler.ts`, so all requests are treated as main.

**Fix**: call `agentAdapter.classifyRequest(body, path, headers)` at the top of `handler.ts`; when `isAuxiliary=true`, session-init / mem / injection / L0 / skill trigger are **all skipped**.

### Pitfall F: client-specific wire fields (such as `reasoning_content`) lost in the round-trip

See the secondary pitfall of Pitfall D. **General approach**: compare inbound/outbound fields with `PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY`, and patch the adapter whenever any is lost.

### Pitfall G: HTTPS_PROXY has no effect when capturing on Node 22

**Fix**: add `NODE_OPTIONS='--use-env-proxy'`. undici is experimental, but it is currently the only way.

### Pitfall H: capturing with headless and assuming the tool does not exist

**Lesson**: the preset system decides the tools, and it is normal for different profiles to hang different tools. **The tools array in web / tui scenarios is always more complete than headless**. It is best to capture web, or capture both once.

---

## Completion Criteria

The adaptation counts as complete only when **all** of the following are verified (the corresponding capability number is marked on the left):

| Capability | Completion criteria |
|---|---|
| #1 Routing | `curl -X POST /<client>/default/chat/completions` returns neither 404 nor 401 `missing service_id` |
| #2 sessionKey | Multiple requests with the same session_id show a consistent `sessionKey=` in the proxy log |
| #3 Request classification | Aux requests (compaction / title-gen) show `[request-classify] → auxiliary (skip ...)` in the proxy log and pass straight through |
| #5 Session Init | The first frame returns a form (role=assistant + `tool_call` is the client preset's ask-user tool name); playwright completes the 4 steps `asset_confirm → team → agent → task` |
| #7 Injection | The main conversation upstream returns 200, and the system message seen upstream contains asset blocks such as `<agent_skills>` / `<user_memory>` |
| #8 Wire compatibility | The main conversation upstream **does not return** 400 (`reasoning_content` / `unknown tool` / `invalid_request_error`) |
| #9 Mem commands | The three commands `mem:help` / `mem:sync` / `mem:create-skill` are intercepted and return short-circuit responses |
| #10 L0 & skill | `tdai-recorder:write-l0` in the proxy log means L0 was persisted; `[skill-conversation-add] archived reason=tool_calls` means skill extraction was triggered |
| #11 Observability | The Langfuse trace carries the `agent_source:<client>` tag |
| — Unit tests | `npx vitest run src/session/<client> src/__tests__/agent-adapters/<client>.test.ts` all green |
| — Full tests | `npx vitest run` has zero regressions |

---

## Reference Implementation: dsh (Grouped by Capability)

dsh is **currently the integration case with the most pitfalls hit and the most complete coverage**. The table below, by capability number from the [Phase 1 adaptation scope](#phase-1-adaptation-scope-overview-clarify-what-to-do-first), lists **the code location of each capability in dsh**, which you can copy and rename for your own client.

| Capability | dsh implementation location | Notes |
|---|---|---|
| #1 Routing & allowlist | dsh section of `MemoryProxy/src/server.ts` (9 routes)<br>`MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | Main `/chat/completions` × (with/without v1) × (main/aux/cost-guard/analyse marker) combinations |
| #2 Session ID resolution | `MemoryProxy/src/session/session-key.ts::resolveConversationId` (`x-deepseek-harness-session-id` fallback) | dsh gets the sid only from the header; no body fallback |
| #3 Request classification | `MemoryProxy/src/agent-adapters/dsh.ts::classifyRequest`<br>aux short-circuit at the top of `MemoryProxy/src/handler.ts` | Triple signal: compact header > title body-shape > main |
| #4 User text & metadata filtering | `MemoryProxy/src/agent-adapters/dsh.ts::extractUserText`<br>`MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation`<br>`MemoryProxy/src/session/store.ts::tryHistoryScan` | dsh stuffs 3 metadata role=user messages in the first frame; matching signatures are skipped |
| #5 Session Init Form | `MemoryProxy/src/session/dsh/form.ts` (tool = `ask_user_question`, call_id prefix `call_dsh_session_init_`)<br>dsh dispatch branch in `MemoryProxy/src/session/index.ts`<br>5 split-stage gates in `MemoryProxy/src/session/codebuddy/init.ts` add `agentSource === "dsh"`<br>`tool_call_id` regex in `MemoryProxy/src/session/codebuddy/cleaner.ts` adds the `dsh_` prefix | State machine reuses CB; the dsh UI has no options limit so it **does not paginate** |
| #7 Injection | Reuses `MemoryProxy/src/injection/adapters/openai.ts` (no standalone profile) | dsh is standard OpenAI Chat; the injection template follows CB's |
| #8 Wire compatibility | `MemoryProxy/src/injection/adapters/openai.ts::parseMessage`/`serializeMessage` (`reasoning_content` preserved via `ContextMessage.metadata`) | DeepSeek thinking chain strictly requires round-tripping |
| #9 Mem commands | The generic mem-command section takes effect automatically; degrades only in dsh headless (`handler.ts::_dshHeadless` criterion) | For headless bypass clients, `mem:session-reset` has a dedicated degradation hint |
| #10 L0 & Skill | The generic handler tail takes effect automatically; skipped when `_dshHeadless` (the relevant `if !_dshHeadless` in `handler.ts`) | Once the aux criteria are correct, no dsh-specific handling is needed |
| #11 Observability | `agentAdapter.agentKind = "dsh"` is injected generically into the langfuse trace tag | No extra instrumentation code needed |
| — Headless Bypass (dsh-only capability) | `MemoryProxy/src/handler.ts::_dshHeadless` (`body.tools` non-empty but lacks `ask_user_question` → bypass) | dsh CLI scenario has no preset, so the whole flow skips form / mem / injection |
| — Unit tests (39, the most complete fixture set) | `MemoryProxy/src/__tests__/agent-adapters/dsh.test.ts` (19 adapter tests)<br>`MemoryProxy/src/session/dsh/__tests__/form.test.ts` (17 form tests)<br>`MemoryProxy/src/injection/adapters/__tests__/openai.test.ts` (3 openai round-trip tests) | Copying and renaming the client name basically works |

For user-facing configuration docs (baseURL / config file / session-init interaction flow), see [`agents/dsh/README.md`](./dsh/README.md).
