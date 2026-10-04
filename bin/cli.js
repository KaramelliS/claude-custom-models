#!/usr/bin/env node
// claude-custom-models — patch Claude Desktop to accept any model, and bridge
// it to any OpenAI-compatible API via a local translation proxy.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { patchInstall } from "../src/patcher.js";
import { findInstallDir, findUserDataDir } from "../src/paths.js";
import { configureDesktop } from "../src/configure.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "proxy.config.json");
const DEFAULT_OUTPUT = path.join(ROOT, "ClaudePatched");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const BANNER = `
${c.bold("claude-custom-models")} — any LLM inside Claude Desktop
${c.dim("patches your local copy only · original install stays untouched")}
`;

function ask(rl, question, def = "") {
  return new Promise((resolve) =>
    rl.question(def ? `${question} ${c.dim(`(${def})`)}: ` : `${question}: `, (a) =>
      resolve(a.trim() || def)
    )
  );
}

async function cmdPatch(args) {
  const source = args.source || findInstallDir();
  if (!source) {
    console.error(c.red("Could not find a Claude Desktop installation."));
    console.error("Pass it manually: claude-custom-models patch --source <path-to-app-folder>");
    process.exit(1);
  }
  const output = args.output || DEFAULT_OUTPUT;
  console.log(`Install dir : ${source}`);
  console.log(`Output dir  : ${output}`);
  console.log("Patching… (copying, extracting, repacking — this can take a minute)");
  const t0 = Date.now();
  const result = await patchInstall({ installDir: source, outputDir: output });
  console.log(
    c.green(`✔ Patched ${result.validatorsPatched} validator(s) in ${result.patchedFiles} file(s)`) +
      c.dim(` in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  );
  console.log(`\nPatched app ready: ${c.bold(path.join(output, process.platform === "win32" ? "claude.exe" : "claude"))}`);
}

async function cmdConfigure() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(c.bold("Upstream API setup") + c.dim("  (any OpenAI-compatible endpoint works)\n"));
  const baseUrl = await ask(rl, "Upstream base URL", "https://api.deepseek.com");
  const apiKey = await ask(rl, "Upstream API key");
  const format = await ask(rl, "Upstream format (openai/anthropic)", "openai");
  const port = Number(await ask(rl, "Proxy port", "8317"));
  const modelsRaw = await ask(
    rl,
    "Model IDs, comma separated",
    "deepseek-chat, deepseek-reasoner"
  );
  rl.close();

  const models = modelsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const config = {
    port,
    upstream: { baseUrl, apiKey, format, chatPath: "/v1/chat/completions" },
    models: models.map((id) => ({ id, display_name: id })),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(c.green(`✔ Proxy config written: ${CONFIG_PATH}`));

  const { configPath } = configureDesktop({ port, models });
  console.log(c.green(`✔ Claude Desktop pointed at the proxy: ${configPath}`));
  console.log(`\nNext: ${c.bold("claude-custom-models run")}`);
}

async function cmdProxy() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(c.red(`Missing ${CONFIG_PATH} — run "configure" first.`));
    process.exit(1);
  }
  const { startProxy } = await import("../src/proxy.js");
  startProxy(CONFIG_PATH);
}

async function cmdRun() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(c.red(`Missing ${CONFIG_PATH} — run "configure" first.`));
    process.exit(1);
  }
  const { startProxy } = await import("../src/proxy.js");
  startProxy(CONFIG_PATH);

  const exe = path.join(DEFAULT_OUTPUT, process.platform === "win32" ? "claude.exe" : "claude");
  if (!fs.existsSync(exe)) {
    console.error(c.red(`Patched app not found at ${exe} — run "patch" first.`));
    process.exit(1);
  }
  console.log(c.dim(`Launching ${exe}`));
  const child = spawn(exe, [], { detached: true, stdio: "ignore" });
  child.unref();
  console.log(c.green("✔ Patched Claude Desktop launched (proxy keeps running here)"));
}

async function cmdStatus() {
  console.log(`Install dir : ${findInstallDir() ?? c.red("not found")}`);
  console.log(`User data   : ${findUserDataDir()}`);
  console.log(`Patched app : ${fs.existsSync(path.join(DEFAULT_OUTPUT, "claude.exe")) ? c.green("yes") : c.yellow("no — run patch")}`);
  console.log(`Proxy config: ${fs.existsSync(CONFIG_PATH) ? c.green(CONFIG_PATH) : c.yellow("missing — run configure")}`);
  try {
    const res = await fetch("http://127.0.0.1:8317/health");
    console.log(`Proxy       : ${res.ok ? c.green("running") : c.yellow("unhealthy")}`);
  } catch {
    console.log(`Proxy       : ${c.yellow("not running")}`);
  }
}

const USAGE = `${BANNER}
Usage: claude-custom-models <command>

  ${c.bold("patch")}      Patch your local Claude Desktop copy
              --source <dir>   custom install location
              --output <dir>   output folder (default ./ClaudePatched)
  ${c.bold("configure")}  Set up upstream API + model list (interactive)
  ${c.bold("proxy")}      Start the translation proxy only
  ${c.bold("run")}        Start proxy + launch the patched app
  ${c.bold("status")}     Show what's set up
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i].startsWith("--")) args[rest[i].slice(2)] = rest[i + 1];
  }
  try {
    switch (command) {
      case "patch": return await cmdPatch(args);
      case "configure": return await cmdConfigure();
      case "proxy": return await cmdProxy();
      case "run": return await cmdRun();
      case "status": return await cmdStatus();
      default: console.log(USAGE);
    }
  } catch (e) {
    console.error(c.red(`\n✖ ${e.message}`));
    process.exit(1);
  }
}

main();
