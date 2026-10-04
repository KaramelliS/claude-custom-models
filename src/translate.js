// Anthropic Messages API <-> OpenAI Chat Completions translation layer.
// Supports: text, system prompts, multi-turn, tool definitions, tool calls,
// tool results, streaming (including streamed tool-call argument deltas).

// ---------------------------------------------------------------------------
// Request: Anthropic -> OpenAI
// ---------------------------------------------------------------------------
export function anthropicToOpenaiRequest(body) {
  const messages = [];
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : String(body.system);
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const m of body.messages || []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      // user turn: plain text parts + tool_result parts become tool messages
      const texts = [];
      for (const b of m.content) {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "tool_result") {
          if (texts.length) {
            messages.push({ role: "user", content: texts.join("\n") });
            texts.length = 0;
          }
          messages.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content:
              typeof b.content === "string"
                ? b.content
                : (b.content || [])
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("\n") || JSON.stringify(b.content),
          });
        }
      }
      if (texts.length) messages.push({ role: "user", content: texts.join("\n") });
    }
  }

  const out = { model: body.model, messages, stream: !!body.stream };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length)
    out.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
    if (body.tool_choice) {
      const tc = body.tool_choice;
      out.tool_choice =
        tc.type === "any" ? "required"
        : tc.type === "tool" ? { type: "function", function: { name: tc.name } }
        : "auto";
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response (non-streaming): OpenAI -> Anthropic
// ---------------------------------------------------------------------------
export function openaiToAnthropicResponse(data, model) {
  const choice = data.choices?.[0] ?? {};
  const content = [];
  const text = choice.message?.content;
  if (text) content.push({ type: "text", text });
  for (const tc of choice.message?.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { /* keep {} */ }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  return {
    id: data.id || "msg_proxy",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(choice.finish_reason, content),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

function mapStopReason(reason, content = []) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "stop") return "end_turn";
  return content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
}

// ---------------------------------------------------------------------------
// Streaming: incremental translator, OpenAI SSE chunks -> Anthropic SSE events.
// Feed raw text; receive an array of {event, data} frames ready to serialize.
// ---------------------------------------------------------------------------
export function createStreamTranslator(model) {
  let buffer = "";
  let textBlockOpen = false;
  let nextIndex = 0;
  let stopReason = null;
  const toolBlocks = new Map(); // openai tool_call index -> {anthropicIndex, name, id}

  const frames = [];
  const push = (event, data) => frames.push({ event, data });

  push("message_start", {
    type: "message_start",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  function closeTextBlock() {
    if (!textBlockOpen) return;
    push("content_block_stop", { type: "content_block_stop", index: nextIndex });
    nextIndex++;
    textBlockOpen = false;
  }

  function handleChunk(chunk) {
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (typeof delta.content === "string" && delta.content) {
      if (!textBlockOpen) {
        push("content_block_start", {
          type: "content_block_start",
          index: nextIndex,
          content_block: { type: "text", text: "" },
        });
        textBlockOpen = true;
      }
      push("content_block_delta", {
        type: "content_block_delta",
        index: nextIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    for (const tc of delta.tool_calls || []) {
      const key = tc.index ?? 0;
      if (!toolBlocks.has(key)) {
        closeTextBlock();
        const block = {
          anthropicIndex: nextIndex,
          id: tc.id || `toolu_${Date.now()}_${key}`,
          name: tc.function?.name || "tool",
        };
        toolBlocks.set(key, block);
        push("content_block_start", {
          type: "content_block_start",
          index: block.anthropicIndex,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        });
        nextIndex++;
      }
      const block = toolBlocks.get(key);
      if (tc.function?.arguments) {
        push("content_block_delta", {
          type: "content_block_delta",
          index: block.anthropicIndex,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments },
        });
      }
    }

    if (choice.finish_reason) stopReason = choice.finish_reason;
  }

  return {
    /** Feed a raw chunk of the upstream SSE body. Returns new frames. */
    feed(text) {
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try { handleChunk(JSON.parse(payload)); } catch { /* partial json, skip */ }
        }
      }
      return frames.splice(0);
    },
    /** Flush remaining frames + emit the closing event sequence. */
    finish() {
      closeTextBlock();
      for (const block of toolBlocks.values()) {
        push("content_block_stop", { type: "content_block_stop", index: block.anthropicIndex });
      }
      const content = toolBlocks.size ? [{ type: "tool_use" }] : [];
      push("message_delta", {
        type: "message_delta",
        delta: { stop_reason: mapStopReason(stopReason, content), stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      push("message_stop", { type: "message_stop" });
      return frames.splice(0);
    },
  };
}
