// Translation proxy: speaks the Anthropic Messages API on the front,
// any OpenAI-compatible (or native Anthropic) API on the back.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  anthropicToOpenaiRequest,
  createStreamTranslator,
  openaiToAnthropicResponse,
} from "./translate.js";

const DEFAULT_CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "proxy.config.json"
);

function loadConfig(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    port: cfg.port ?? 8317,
    host: cfg.host ?? "127.0.0.1",
    upstream: {
      baseUrl: cfg.upstream?.baseUrl ?? "https://api.deepseek.com",
      apiKey: cfg.upstream?.apiKey ?? "",
      chatPath: cfg.upstream?.chatPath ?? "/v1/chat/completions",
      // "openai" = translate; "anthropic" = pass through untouched
      format: cfg.upstream?.format ?? "openai",
    },
    models: cfg.models ?? [],
  };
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function anthropicError(res, status, message, type = "api_error") {
  json(res, status, { type: "error", error: { type, message } });
}

function upstreamRequest(target, headers, body, onResponse) {
  const mod = target.protocol === "https:" ? https : http;
  const req = mod.request(
    {
      method: "POST",
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      headers,
    },
    onResponse
  );
  req.write(typeof body === "string" ? body : JSON.stringify(body));
  req.end();
  return req;
}

export function startProxy(configPath = DEFAULT_CONFIG_PATH) {
  const server = http.createServer((req, res) => {
    let cfg;
    try {
      cfg = loadConfig(configPath); // hot-reload: every request re-reads config
    } catch (e) {
      return anthropicError(res, 500, `proxy config error: ${e.message}`);
    }
    const url = new URL(req.url, "http://localhost");
    log(req.method, url.pathname);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, upstream: cfg.upstream.baseUrl, models: cfg.models.length });
    }

    // Model discovery — the desktop model picker reads this.
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, {
        data: cfg.models.map((m) => ({
          type: "model",
          id: m.id,
          display_name: m.display_name || m.id,
          created_at: "2025-01-01T00:00:00Z",
        })),
        has_more: false,
        first_id: cfg.models[0]?.id,
        last_id: cfg.models[cfg.models.length - 1]?.id,
      });
    }

    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      return anthropicError(res, 404, "not found", "not_found_error");
    }

    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let anthReq;
      try { anthReq = JSON.parse(raw); } catch {
        return anthropicError(res, 400, "invalid JSON body", "invalid_request_error");
      }

      // Per-model upstream override: models[].upstream_model renames the model,
      // models[].base_url/api_key can route a model to a different provider.
      const modelCfg = cfg.models.find((m) => m.id === anthReq.model) || {};
      const upstream = {
        baseUrl: modelCfg.base_url || cfg.upstream.baseUrl,
        apiKey: modelCfg.api_key || cfg.upstream.apiKey,
        chatPath: modelCfg.chat_path || cfg.upstream.chatPath,
        format: modelCfg.format || cfg.upstream.format,
      };

      if (upstream.format === "anthropic") {
        // Pass-through: upstream already speaks the Messages API.
        const target = new URL("/v1/messages", upstream.baseUrl);
        log("-> upstream(anthropic)", target.href, "model:", anthReq.model);
        const upReq = upstreamRequest(
          target,
          {
            "Content-Type": "application/json",
            "x-api-key": upstream.apiKey,
            "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
          },
          raw,
          (upRes) => {
            res.writeHead(upRes.statusCode, {
              "Content-Type": upRes.headers["content-type"] || "application/json",
            });
            upRes.pipe(res);
          }
        );
        upReq.on("error", (e) => anthropicError(res, 502, e.message));
        return;
      }

      // OpenAI-compatible upstream
      const outReq = anthropicToOpenaiRequest({
        ...anthReq,
        model: modelCfg.upstream_model || anthReq.model,
      });
      const target = new URL(upstream.chatPath, upstream.baseUrl);
      log("-> upstream(openai)", target.href, "model:", outReq.model, "stream:", outReq.stream);

      const upReq = upstreamRequest(
        target,
        { "Content-Type": "application/json", Authorization: `Bearer ${upstream.apiKey}` },
        outReq,
        (upRes) => {
          if (upRes.statusCode !== 200) {
            let err = "";
            upRes.on("data", (c) => (err += c));
            upRes.on("end", () => {
              log("upstream error", upRes.statusCode, err.slice(0, 300));
              anthropicError(res, upRes.statusCode, err.slice(0, 500));
            });
            return;
          }
          if (outReq.stream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            const tr = createStreamTranslator(anthReq.model);
            const emit = (frames) => {
              for (const f of frames) res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
            };
            upRes.on("data", (c) => emit(tr.feed(c.toString("utf8"))));
            upRes.on("end", () => { emit(tr.finish()); res.end(); });
            upRes.on("error", () => res.end());
          } else {
            let data = "";
            upRes.on("data", (c) => (data += c));
            upRes.on("end", () => {
              try {
                json(res, 200, openaiToAnthropicResponse(JSON.parse(data), anthReq.model));
              } catch {
                anthropicError(res, 502, "failed to parse upstream response");
              }
            });
          }
        }
      );
      upReq.on("error", (e) => anthropicError(res, 502, e.message));
    });
  });

  const boot = loadConfig(configPath);
  server.listen(boot.port, boot.host, () => {
    log(`proxy listening on http://${boot.host}:${boot.port} -> ${boot.upstream.baseUrl} (${boot.upstream.format})`);
  });
  return server;
}
