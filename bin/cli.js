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

async function cmdDoctor() {
  const { createHash } = await import("node:crypto");
  let failures = 0;
  const check = (ok, label, hint) => {
    console.log(`${ok ? c.green("✔") : (failures++, c.red("✖"))} ${label}${!ok && hint ? c.dim(` — ${hint}`) : ""}`);
    return ok;
  };

  console.log(c.bold("\nDiagnostic\n"));

  const install = findInstallDir();
  check(!!install, `Claude Desktop install${install ? c.dim(` (${install})`) : ""}`, "not found");

  const exe = path.join(DEFAULT_OUTPUT, "claude.exe");
  const patched = fs.existsSync(exe);
  check(patched, "Patched app exists", "run: patch");

  if (patched) {
    const asar = fs.readFileSync(path.join(DEFAULT_OUTPUT, "resources", "app.asar"));
    const jsonLen = asar.readUInt32LE(12);
    const headerHash = createHash("sha256").update(asar.subarray(16, 16 + jsonLen)).digest("hex");
    const exeBuf = fs.readFileSync(exe).toString("latin1");
    check(exeBuf.includes(headerHash), "Asar integrity hash matches patched executable",
      "re-run: patch");
    const src = asar.toString("latin1");
    const stillPatched = /function [A-Za-z_$][\w$]*\(e\)\{return!0\}/.test(src);
    check(stillPatched, "Model-name validator is neutralized", "re-run: patch");
  }

  if (check(fs.existsSync(CONFIG_PATH), "Proxy config exists", "run: configure")) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    check(cfg.upstream?.apiKey && !/BURAYA|YOUR|\.\.\./i.test(cfg.upstream.apiKey),
      "Upstream API key looks real", `edit ${CONFIG_PATH}`);

    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port ?? 8317}/health`, { signal: AbortSignal.timeout(2000) });
      check(res.ok, "Proxy is running");
    } catch {
      check(false, "Proxy is running", "run: proxy (or: run)");
    }

    // upstream auth probe (1 token)
    try {
      const target = new URL(cfg.upstream.chatPath ?? "/v1/chat/completions", cfg.upstream.baseUrl);
      const probe = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.upstream.apiKey}` },
        body: JSON.stringify({ model: cfg.models?.[0]?.upstream_model || cfg.models?.[0]?.id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(15000),
      });
      check(probe.ok, `Upstream accepts the key (HTTP ${probe.status})`, "check baseUrl/apiKey");
    } catch (e) {
      check(false, "Upstream reachable", e.message);
    }
  }

  console.log(failures ? c.red(`\n${failures} problem(s) found.`) : c.green("\nEverything looks healthy."));
  process.exitCode = failures ? 1 : 0;
}

async function cmdInstallStartup() {
  if (process.platform !== "win32") {
    console.error(c.red("install-startup is Windows-only for now (PRs welcome)."));
    process.exit(1);
  }
  // Hidden launcher so no console window pops up at logon.
  const vbs = path.join(ROOT, "run-hidden.vbs");
  const cli = path.join(ROOT, "bin", "cli.js");
  fs.writeFileSync(vbs,
    `CreateObject("Wscript.Shell").Run "node """ & "${cli}" & """ run", 0, False\n`);
  const { execFileSync } = await import("node:child_process");
  execFileSync("reg", [
    "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/v", "ClaudeCustomModels", "/t", "REG_SZ",
    "/d", `wscript.exe "${vbs}"`, "/f",
  ]);
  console.log(c.green("✔ Auto-start installed (proxy + patched app launch at logon)"));
  console.log(c.dim("  Remove with: reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v ClaudeCustomModels"));
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
  ${c.bold("doctor")}     End-to-end health check (patch, config, proxy, upstream key)
  ${c.bold("install-startup")}
              Launch proxy + patched app automatically at logon (Windows)
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
      case "doctor": return await cmdDoctor();
      case "install-startup": return await cmdInstallStartup();
      default: console.log(USAGE);
    }
  } catch (e) {
    console.error(c.red(`\n✖ ${e.message}`));
    process.exit(1);
  }
}

main();
