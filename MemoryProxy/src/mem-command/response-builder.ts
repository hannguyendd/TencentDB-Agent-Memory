/**
 * Builds a synthetic LLM response following the Anthropic / OpenAI protocol.
 *
 * To the IDE, the returned Response looks like a normal assistant reply.
 */

// ── Anthropic non-streaming ─────────────────────────────────────────────────

export function buildAnthropicResponse(text: string, requestId: string, thinking?: boolean): Response {
  const content: Record<string, unknown>[] = [];
  // When extended thinking is enabled on the request, a thinking block must be included,
  // otherwise Claude Code treats the response as incomplete and issues extra requests.
  if (thinking) {
    content.push({ type: "thinking", thinking: "Processing mem: command.", signature: "" });
  }
  content.push({ type: "text", text });

  const body = {
    id: requestId,
    type: "message",
    role: "assistant",
    content,
    model: "memory-proxy",
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

// ── Anthropic streaming ─────────────────────────────────────────────────────

export function buildAnthropicStreamResponse(text: string, requestId: string, thinking?: boolean): Response {
  const msgId = requestId;
  const lines: string[] = [
    `event: message_start`,
    `data: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model: "memory-proxy", stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}`,
    ``,
  ];

  let blockIndex = 0;

  // When extended thinking is enabled on the request, emit a complete thinking block first,
  // otherwise Claude Code treats the response as incomplete and issues extra requests.
  if (thinking) {
    lines.push(
      `event: content_block_start`,
      `data: ${JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "thinking", thinking: "" } })}`,
      ``,
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: "Processing mem: command." } })}`,
      ``,
      `event: content_block_stop`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}`,
      ``,
    );
    blockIndex++;
  }

  // text block
  lines.push(
    `event: content_block_start`,
    `data: ${JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } })}`,
    ``,
    `event: content_block_delta`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } })}`,
    ``,
    `event: content_block_stop`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}`,
    ``,
  );

  // message end
  lines.push(
    `event: message_delta`,
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } })}`,
    ``,
    `event: message_stop`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    ``,
  );

  const body = lines.join("\n");

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-request-id": requestId,
    },
  });
}

// ── OpenAI non-streaming ────────────────────────────────────────────────────

export function buildOpenAIResponse(text: string, requestId: string): Response {
  const body = {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    model: "memory-proxy",
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

// ── OpenAI streaming ────────────────────────────────────────────────────────

export function buildOpenAIStreamResponse(text: string, requestId: string): Response {
  const chunk = {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    model: "memory-proxy",
  };
  const doneChunk = {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    model: "memory-proxy",
  };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-request-id": requestId,
    },
  });
}

// ── Responses API (Codex) non-streaming ────────────────────────────────────

export function buildResponsesResponse(text: string, requestId: string): Response {
  const body = {
    id: requestId,
    object: "response",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

// ── Responses API (Codex) streaming ────────────────────────────────────────

export function buildResponsesStreamResponse(text: string, requestId: string): Response {
  const messageItem = {
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "output_text" as const, text }],
  };

  const responseObj = {
    id: requestId,
    object: "response",
    status: "completed",
    output: [messageItem],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  // Key point: in the Responses API, each event's data JSON **must** carry a `type` field
  // (same name as the SSE `event:` header). The codex client parser reads data.type first;
  // events missing it are dropped, so the synthetic text never shows in the client. Match the real upstream framing.
  const sse = (event: string, d: Record<string, unknown>) =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, ...d })}\n\n`;

  const lines: string[] = [];

  // response.created
  lines.push(sse("response.created", {
    response: { ...responseObj, status: "in_progress", output: [] },
  }));

  // response.in_progress
  lines.push(sse("response.in_progress", {
    response: { ...responseObj, status: "in_progress", output: [] },
  }));

  // response.output_item.added (message)
  lines.push(sse("response.output_item.added", {
    output_index: 0,
    item: { type: "message", role: "assistant", content: [] },
  }));

  // response.content_part.added
  lines.push(sse("response.content_part.added", {
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  }));

  // response.output_text.delta
  lines.push(sse("response.output_text.delta", {
    output_index: 0,
    content_index: 0,
    delta: text,
  }));

  // response.output_text.done
  lines.push(sse("response.output_text.done", {
    output_index: 0,
    content_index: 0,
    text,
  }));

  // response.content_part.done
  lines.push(sse("response.content_part.done", {
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text },
  }));

  // response.output_item.done
  lines.push(sse("response.output_item.done", {
    output_index: 0,
    item: messageItem,
  }));

  // response.completed
  lines.push(sse("response.completed", {
    response: responseObj,
  }));

  const body = lines.join("");

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-request-id": requestId,
    },
  });
}

// ── Unified builder ─────────────────────────────────────────────────────────

export interface BuildResponseOptions {
  protocol: "anthropic" | "openai" | "responses";
  stream: boolean;
  requestId?: string;
  /** Whether extended thinking is enabled on the request (Anthropic only) */
  thinking?: boolean;
}

export function buildMemResponse(text: string, opts: BuildResponseOptions): Response {
  const requestId = opts.requestId ?? `mem-cmd-${Date.now()}`;

  if (opts.protocol === "anthropic") {
    return opts.stream
      ? buildAnthropicStreamResponse(text, requestId, opts.thinking)
      : buildAnthropicResponse(text, requestId, opts.thinking);
  }
  if (opts.protocol === "responses") {
    return opts.stream
      ? buildResponsesStreamResponse(text, requestId)
      : buildResponsesResponse(text, requestId);
  }
  return opts.stream
    ? buildOpenAIStreamResponse(text, requestId)
    : buildOpenAIResponse(text, requestId);
}
