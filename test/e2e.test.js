// End-to-end: mock OpenAI upstream -> proxy -> Anthropic-format assertions.
// Run: node test/e2e.test.js
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startProxy } from "../src/proxy.js";

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reqJson = JSON.parse(body);
    assert.strictEqual(req.headers.authorization, "Bearer test-key");
    if (reqJson.stream && reqJson.tools) {
      // streamed tool call (chunks built with stringify to keep escaping sane)
      const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city"' } }] } }] }));
      res.write(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"Istanbul"}' } }] }, finish_reason: "tool_calls" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (reqJson.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"düşün"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Mer"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"haba"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "x",
        choices: [{ message: { content: "Merhaba" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }));
    }
  });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccm-test-"));
const configPath = path.join(dir, "proxy.config.json");
fs.writeFileSync(configPath, JSON.stringify({
  port: 8399,
  upstream: { baseUrl: "http://127.0.0.1:8398", apiKey: "test-key", format: "openai" },
  models: [{ id: "deepseek-chat", display_name: "DeepSeek V3" }],
}));

await new Promise((r) => mock.listen(8398, r));
const proxy = startProxy(configPath);
await new Promise((r) => setTimeout(r, 300));

// 1. model discovery
const models = await fetch("http://127.0.0.1:8399/v1/models").then((r) => r.json());
assert.strictEqual(models.data[0].id, "deepseek-chat");
console.log("✔ /v1/models");

// 2. non-streaming round-trip
const resp = await fetch("http://127.0.0.1:8399/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "deepseek-chat",
    max_tokens: 100,
    system: "Sen yardımsever bir asistansın",
    messages: [{ role: "user", content: "selam" }],
  }),
}).then((r) => r.json());
assert.strictEqual(resp.type, "message");
assert.strictEqual(resp.content[0].text, "Merhaba");
assert.strictEqual(resp.stop_reason, "end_turn");
console.log("✔ non-streaming round-trip");

// 3. streaming round-trip
const sse = await fetch("http://127.0.0.1:8399/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "deepseek-chat",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "selam" }],
  }),
}).then((r) => r.text());
for (const ev of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]) {
  assert.ok(sse.includes(`event: ${ev}`), `missing event ${ev}`);
}
assert.ok(sse.includes('"text":"Mer"') && sse.includes('"text":"haba"'));
assert.ok(sse.includes('thinking_delta'), "reasoning should map to thinking blocks");
assert.ok(sse.includes('"output_tokens":2'), "real usage should flow through");
console.log("✔ streaming round-trip (SSE + thinking + usage)");

// 4. streaming tool call
const toolSse = await fetch("http://127.0.0.1:8399/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "deepseek-chat",
    max_tokens: 100,
    stream: true,
    tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    messages: [{ role: "user", content: "hava?" }],
  }),
}).then((r) => r.text());
assert.ok(toolSse.includes('"type":"tool_use"'), "tool_use block expected");
assert.ok(toolSse.includes('input_json_delta'), "streamed tool args expected");
assert.ok(toolSse.includes('"stop_reason":"tool_use"'));
console.log("✔ streaming tool calls");

mock.close();
proxy.close();
console.log("\nAll tests passed.");
process.exit(0);
