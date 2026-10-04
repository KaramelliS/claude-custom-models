# claude-custom-models

**Run any LLM inside Claude Desktop** — DeepSeek, Qwen, GPT, Grok, Llama, or your own local model — with custom model names showing up directly in the app's model picker.

Claude Desktop (in custom-inference / "3p" deployment mode) officially supports pointing inference at a custom gateway… but its model-name validator silently rejects any name that isn't Claude-flavored (`deepseek`, `qwen`, `gpt`, `llama` and ~50 more are on a hard-coded denylist). This tool:

1. **Patches your local copy** of Claude Desktop so the picker accepts any model name, and
2. **Bridges the API gap** with a local proxy that translates Anthropic Messages API ⇄ OpenAI Chat Completions (streaming, tool calls included).

```
Claude Desktop (patched)
   │  Anthropic Messages API          ┌──────────────────────────────┐
   ▼                                  │  Your upstream, anything     │
local proxy  ── OpenAI format ───────▶ │  DeepSeek · OpenAI · Groq    │
127.0.0.1:8317 ◀─── translated ──────  │  Together · Ollama · vLLM …  │
                                        └──────────────────────────────┘
```

## Quick start

```bash
git clone https://github.com/<you>/claude-custom-models
cd claude-custom-models
npm install

npm run patch       # find + patch your local Claude Desktop copy  → ./ClaudePatched
npm run configure   # interactive: upstream URL, API key, model list
npm run run         # start the proxy + launch the patched app
```

That's it. Open the patched app, pick `deepseek-chat` (or whatever you configured) from the model dropdown, chat.

## Commands

| Command | What it does |
|---|---|
| `patch` | Copies your Claude Desktop install, neutralizes the foreign-model denylist in `app.asar`, rewrites the embedded asar integrity hash in the copied executable. **Your original install is never modified.** |
| `configure` | Asks for upstream base URL / key / model IDs, writes `proxy.config.json`, and points Claude Desktop's config library at the local proxy (with backup). |
| `proxy` | Starts just the translation proxy. |
| `run` | Starts the proxy and launches the patched app. |
| `status` | Shows what's installed / configured / running. |

## Proxy configuration (`proxy.config.json`)

The proxy re-reads the config on **every request** — edit and save, no restart needed.

```jsonc
{
  "port": 8317,
  "upstream": {                       // default upstream
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-...",
    "format": "openai",               // "openai" | "anthropic" (pass-through)
    "chatPath": "/v1/chat/completions"
  },
  "models": [
    { "id": "deepseek-chat", "display_name": "DeepSeek V3" },
    {
      "id": "my-local-model",         // shown in the picker
      "upstream_model": "llama3.1",   // actual model name sent upstream
      "base_url": "http://127.0.0.1:11434",   // per-model upstream override
      "api_key": "ollama"
    }
  ]
}
```

- **Streaming** is fully translated (text deltas + streamed tool-call arguments).
- **Tool use** is translated both ways (Anthropic `tools`/`tool_use`/`tool_result` ⇄ OpenAI `tools`/`tool_calls`).
- If your upstream already speaks the Anthropic Messages API, set `"format": "anthropic"` and the proxy passes requests through untouched (just swapping the base URL / key).

## How the patch works

- Claude Desktop ships as an Electron app; the validator lives in minified bundles inside `resources/app.asar`. The patcher finds functions shaped like
  `function X(e){let t=e.toLowerCase();return RE.test(t)?!1:…}` — the denylist gate — and replaces the body with `return true`. Identifier-agnostic, so it survives minifier renames between versions.
- This Electron build has the **asar integrity fuse** enabled: the executable embeds the SHA-256 of the asar header. The patcher detects which byte range is hashed by reproducing the original hash first, then rewrites the embedded value in the *copied* executable.
- The patched copy lives in `./ClaudePatched` — the MSIX install in `WindowsApps` is never touched, and Claude Desktop updates can't clobber your copy.

## Requirements

- Node.js ≥ 18
- Claude Desktop (the "3p" / custom-inference build mode — if you signed in with an API key rather than a claude.ai account, you're already there; the config lives in `%LOCALAPPDATA%\Claude-3p`)
- Windows is tested; macOS/Linux paths are scaffolded but untested — PRs welcome.

## Updating Claude Desktop

Re-run `npm run patch` after upgrading Claude Desktop. If the validator's code shape ever changes, the patcher fails loudly (counts 0 matches) instead of producing a broken build.

## Disclaimer

Unofficial, community project — not affiliated with Anthropic. It patches **your local copy** of the app for personal interoperability and never redistributes Anthropic's code or binaries. Using modified clients may violate Anthropic's Terms of Service; you're responsible for how you use it. The proxy only talks to the upstreams *you* configure, with *your* API keys — nothing is proxied through third parties.

## License

MIT
