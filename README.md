# claude-custom-models

[![test](https://github.com/KaramelliS/claude-custom-models/actions/workflows/test.yml/badge.svg)](https://github.com/KaramelliS/claude-custom-models/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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
git clone https://github.com/KaramelliS/claude-custom-models
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
| `doctor` | End-to-end health check: install, patch integrity, proxy, upstream key. |
| `install-startup` | Launch proxy + patched app automatically at logon (Windows). |
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
- **Reasoning models** (DeepSeek-R1 etc.): `reasoning_content` is mapped to Anthropic **thinking blocks** — you see the model think in the UI.
- **Real usage metrics**: token counts flow through from the upstream (`stream_options.include_usage`).
- **Robust**: upstream timeouts, client-disconnect aborts, config hot-reload on every request.
- If your upstream already speaks the Anthropic Messages API, set `"format": "anthropic"` and the proxy passes requests through untouched (just swapping the base URL / key).

## How the patch works

- Claude Desktop ships as an Electron app; the validator lives in minified bundles inside `resources/app.asar`. The patcher finds functions shaped like
  `function X(e){let t=e.toLowerCase();return RE.test(t)?!1:…}` — the denylist gate — and replaces the body with `return true`. Identifier-agnostic, so it survives minifier renames between versions.
- This Electron build has the **asar integrity fuse** enabled: the executable embeds the SHA-256 of the asar header. The patcher detects which byte range is hashed by reproducing the original hash first, then rewrites the embedded value in the *copied* executable.
- The patched copy lives in `./ClaudePatched` — the MSIX install in `WindowsApps` is never touched, and Claude Desktop updates can't clobber your copy.

## Research notes — how we got here

Everything below was figured out by reading the minified bundles shipped in `resources/app.asar`. No source access, no docs — just `grep`, patience, and a hex viewer.

### 1. The feature was already there

Claude Desktop ships with a hidden enterprise configuration system. Buried in the bundle we found a full inference-provider abstraction with six backends:

```
gateway · anthropic · bedrock · mantle · vertex · foundry
```

plus ~40 managed config keys (`inferenceGatewayBaseUrl`, `inferenceModels`, `inferenceCustomHeaders`, …) readable from MDM profiles (macOS), GPO registry (`HKLM/HKCU\SOFTWARE\Policies\Claude`), `/etc/claude-desktop/managed-settings.json` (Linux), and a user-writable **config library** at `%LOCALAPPDATA%\Claude-3p\configLibrary\` — the same store the in-app Setup panel writes to. The `gateway` provider is exactly what we wanted: custom base URL + API key + a user-defined model list, speaking the standard Anthropic Messages API.

The catch: it only activates in **"3p" deployment mode** (`Claude-3p` user-data dir, `deploymentMode: "3p"` in `claude_desktop_config.json`) — the mode you get when signing in with an API key instead of a claude.ai account.

### 2. The model-name denylist

The gateway validates every configured model name through a gate shaped like:

```js
function Ga(e){let t=e.toLowerCase();return r_e.test(t)?!1:t_e.test(t)||n_e.some((e=>t.includes(e)))}
```

where `r_e` is a hard-coded denylist of ~50 non-Anthropic model families:

```
/ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|
 lfm|ling|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|
 qianfan|qwen|tc-code|unic|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|
 amazon.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|k2.|m2.|
 jamba|arctic|solar|mercury|zamba|kat-coder|ds-|dpsk/
```

and the accept path requires the name to contain `claude`, `sonnet`, `opus`, `haiku`, `fable` or `mythos`. Two copies of this validator exist (main process + agent engine). The patcher finds them by **code shape**, not by identifier name — minified names rotate between builds, the shape doesn't — and replaces the body with `return true`.

### 3. The asar integrity fuse

After repacking, the app crashed with:

```
FATAL: asar_util.cc: Integrity check failed for asar archive entry '<header>'
```

This Electron build enables `EmbeddedAsarIntegrityValidation`: the executable embeds

```json
[{"file":"resources\\app.asar","alg":"SHA256","value":"<hex>"}]PADDINGXPADDINGX…
```

(the `PADDINGX` filler is deliberate — the region is sized for in-place rewriting at build time). Rewriting the hash is easy; knowing **which bytes** are hashed is not documented. We brute-forced it against the *original* pair (untouched exe + untouched asar): nested Chromium pickles mean the header JSON starts at offset 16 (`[u32=4][u32 headerPickleSize][u32 innerSize][u32 jsonLen][JSON…]`), and the hashed range turned out to be exactly the raw header-JSON bytes. The patcher auto-detects the layout by reproducing the original hash first — if a future Electron changes the layout, it fails loudly instead of shipping a broken binary.

### 4. Other traps found along the way

- **HTTPS enforcement**: the gateway base-URL schema rejects plain `http://` unless the host is loopback. If your upstream is a plain-HTTP router on a LAN/VPS, run the bundled proxy on `127.0.0.1` and point the app there.
- **`WindowsApps` ACLs**: the MSIX install dir is read-only, so the patcher always works on a copy. Side effect: app updates never clobber your patched build.
- **V8 compile cache**: the app ships `.jsc` bytecode caches — stale entries are rejected automatically on source mismatch, so no extra handling needed.

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
