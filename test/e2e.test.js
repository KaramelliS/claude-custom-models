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
    if (reqJson.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Mer"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"haba"},"finish_reason":"stop"}]}\n\n');
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
console.log("✔ streaming round-trip (SSE)");

mock.close();
proxy.close();
console.log("\nAll tests passed.");
process.exit(0);
