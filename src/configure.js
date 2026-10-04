// Writes the inference config into Claude Desktop's config library
// (the user-writable tier the in-app Setup panel uses). Always backs up.
import fs from "node:fs";
import path from "node:path";
import { findActiveConfigEntry, findUserDataDir } from "./paths.js";

/**
 * Point Claude Desktop at the local translation proxy with a custom model list.
 * @param {{port:number, models:string[]}} opts
 */
export function configureDesktop({ port, models }) {
  const userData = findUserDataDir();
  const { libDir, metaPath, entryPath, id } = findActiveConfigEntry(userData);

  fs.mkdirSync(libDir, { recursive: true });
  let targetPath = entryPath;
  if (!targetPath) {
    // No config entry yet — create one and mark it applied.
    const newId = crypto.randomUUID();
    targetPath = path.join(libDir, `${newId}.json`);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ appliedId: newId, entries: [{ id: newId, name: "Default" }] }, null, 2)
    );
  }

  if (fs.existsSync(targetPath)) {
    const backup = `${targetPath}.bak-${Date.now()}`;
    fs.copyFileSync(targetPath, backup);
  }

  const config = {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
    inferenceGatewayApiKey: "local-proxy",
    inferenceCredentialKind: "static",
    inferenceModels: models,
  };
  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2));
  return { userData, configPath: targetPath };
}
