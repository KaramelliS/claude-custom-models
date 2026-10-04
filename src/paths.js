// Locates Claude Desktop installation and user-data directories across platforms.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Find the Claude Desktop install directory (folder containing claude.exe / Claude.app). */
export function findInstallDir() {
  if (process.platform === "win32") {
    // MSIX install: C:\Program Files\WindowsApps\Claude_<version>_x64__pzs8sxrjxfjjc\app
    try {
      const out = execSync(
        'powershell -NoProfile -Command "(Get-AppxPackage Claude).InstallLocation"',
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      if (out) {
        const appDir = path.join(out, "app");
        if (fs.existsSync(path.join(appDir, "resources", "app.asar"))) return appDir;
      }
    } catch { /* not installed via MSIX */ }
    const candidates = [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Claude"),
      "C:\\Program Files\\Claude",
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, "resources", "app.asar"))) return c;
    }
  } else if (process.platform === "darwin") {
    const c = "/Applications/Claude.app/Contents/Resources";
    if (fs.existsSync(path.join(c, "app.asar"))) return path.dirname(c);
  } else {
    for (const c of ["/opt/Claude", "/usr/lib/claude", "/usr/local/lib/claude"]) {
      if (fs.existsSync(path.join(c, "resources", "app.asar"))) return c;
    }
  }
  return null;
}

/**
 * Claude Desktop user-data root. In 3p (custom inference) deployment mode the
 * app uses a "-3p" suffixed directory.
 */
export function findUserDataDir() {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : path.join(os.homedir(), ".config");
  const p3 = path.join(base, "Claude-3p");
  if (fs.existsSync(p3)) return p3;
  const p1 = path.join(base, "Claude");
  if (fs.existsSync(p1)) return p1;
  return p3; // default to 3p (custom provider mode)
}

/** The active config-library entry file (written by the in-app Setup panel). */
export function findActiveConfigEntry(userDataDir = findUserDataDir()) {
  const libDir = path.join(userDataDir, "configLibrary");
  const metaPath = path.join(libDir, "_meta.json");
  if (!fs.existsSync(metaPath)) return { libDir, metaPath, entryPath: null, id: null };
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const id = meta.appliedId;
  return { libDir, metaPath, entryPath: id ? path.join(libDir, `${id}.json`) : null, id };
}
