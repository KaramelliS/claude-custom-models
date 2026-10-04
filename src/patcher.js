// Core patcher: copies Claude Desktop, patches the model-name allowlist
// validators inside app.asar, repacks, and rewrites the embedded asar
// integrity hash in the executable. Never touches the original install.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE_NAME = process.platform === "win32" ? "claude.exe" : "claude";

// ---------------------------------------------------------------------------
// Patch definitions. Minified identifiers change between releases, so patterns
// target the *shape* of the validator: `function X(e){let t=e.toLowerCase();
// return RE.test(t)?!1:RE2.test(t)||ARR.some((e=>t.includes(e)))}`
// This is the foreign-model denylist gate (blocks deepseek, qwen, gpt, ...).
// ---------------------------------------------------------------------------
const VALIDATOR_PATTERN =
  /function ([A-Za-z_$][\w$]*)\(e\)\{let t=e\.toLowerCase\(\);return [A-Za-z_$][\w$]*\.test\(t\)\?!1:[A-Za-z_$][\w$]*\.test\(t\)\|\|[A-Za-z_$][\w$]*\.some\(\(e=>t\.includes\(e\)\)\)\}/g;

export function patchJsSource(source) {
  let count = 0;
  const patched = source.replace(VALIDATOR_PATTERN, (_m, name) => {
    count++;
    return `function ${name}(e){return!0}`;
  });
  return { patched, count };
}

// ---------------------------------------------------------------------------
// asar header integrity. Electron (with the EmbeddedAsarIntegrityValidation
// fuse) stores the SHA-256 of the asar header inside the executable as JSON:
//   [{"file":"resources\\app.asar","alg":"SHA256","value":"<hex>"}]
// We recompute the hash for the patched archive and rewrite it in the copied
// executable. To stay robust across Electron versions we detect *which* byte
// range is hashed by matching against the original archive first.
// ---------------------------------------------------------------------------
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function headerCandidates(asarBuf) {
  // asar layout (nested Chromium pickles):
  //   [u32 outer=4][u32 headerPickleSize][u32 innerSize][u32 jsonLength][JSON][pad]
  // Electron's asar-integrity fuse hashes the raw header JSON string bytes.
  const jsonLen = asarBuf.readUInt32LE(12);
  const headerPickleSize = asarBuf.readUInt32LE(4);
  return {
    headerJson: asarBuf.subarray(16, 16 + jsonLen),
    headerPickle: asarBuf.subarray(8, 8 + 4 + headerPickleSize),
    headerBlock: asarBuf.subarray(0, 8 + headerPickleSize),
  };
}

export function extractEmbeddedIntegrity(exeBuf) {
  const m = exeBuf
    .toString("latin1")
    .match(/\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-f]{64})"\}\]/);
  return m ? m[1] : null;
}

function detectHashMode(originalAsarBuf, embeddedHash) {
  const c = headerCandidates(originalAsarBuf);
  for (const mode of Object.keys(c)) {
    if (sha256(c[mode]) === embeddedHash) return mode;
  }
  return null;
}

function rewriteEmbeddedHash(exePath, oldHash, newHash) {
  const buf = fs.readFileSync(exePath);
  const hits = buf.toString("latin1").split(oldHash).length - 1;
  if (hits !== 1) {
    throw new Error(`Expected exactly 1 embedded hash occurrence in executable, found ${hits}`);
  }
  const patched = Buffer.from(buf.toString("latin1").replace(oldHash, newHash), "latin1");
  fs.writeFileSync(exePath, patched);
}

// ---------------------------------------------------------------------------
async function extractAsar(asarPath, destDir, asarLib) {
  fs.mkdirSync(destDir, { recursive: true });
  await Promise.resolve()
    .then(() => asarLib.extractAll(asarPath, destDir))
    .catch((err) => {
    // Native modules marked "unpacked" fail to extract; they live in
    // app.asar.unpacked and are copied separately. Ignore those failures.
      if (!/Unable to extract some files/.test(String(err))) throw err;
    });
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

/**
 * Full patch pipeline.
 * @returns {{outputDir:string, patchedFiles:number, validatorsPatched:number}}
 */
export async function patchInstall({ installDir, outputDir }) {
  const resourcesDir = path.join(installDir, "resources");
  const srcAsar = path.join(resourcesDir, "app.asar");
  const srcUnpacked = path.join(resourcesDir, "app.asar.unpacked");
  const srcExe = path.join(installDir, EXE_NAME);
  if (!fs.existsSync(srcAsar)) throw new Error(`app.asar not found under ${resourcesDir}`);
  if (!fs.existsSync(srcExe)) throw new Error(`${EXE_NAME} not found under ${installDir}`);

  // asar lib lives in devDependencies (only needed at patch time)
  const asarModule = await import("@electron/asar");
  const asarLib = asarModule.default ?? asarModule;

  // 1. Fresh copy of the whole app so the original install stays untouched.
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  copyDir(installDir, outputDir);

  // 2. Extract asar into a temp workspace.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccm-"));
  const extracted = path.join(tmp, "extracted");
  await extractAsar(srcAsar, extracted, asarLib);
  // Merge back the files Electron keeps outside the archive.
  if (fs.existsSync(srcUnpacked)) copyDir(srcUnpacked, extracted);

  // 3. Patch every JS bundle; count how many validators we neutralized.
  let patchedFiles = 0;
  let validatorsPatched = 0;
  for (const rel of walkJs(extracted)) {
    const abs = path.join(extracted, rel);
    const { patched, count } = patchJsSource(fs.readFileSync(abs, "utf8"));
    if (count > 0) {
      fs.writeFileSync(abs, patched);
      patchedFiles++;
      validatorsPatched += count;
    }
  }
  if (validatorsPatched === 0) {
    throw new Error(
      "No model-name validators found. The app layout may have changed — " +
        "please open an issue with your Claude Desktop version."
    );
  }

  // 4. Repack. Native binaries must stay outside the archive (Electron cannot
  //    dlopen .node/.dll/.exe from inside asar), so mark them unpacked.
  const outAsar = path.join(outputDir, "resources", "app.asar");
  await asarLib.createPackageWithOptions(extracted, outAsar, {
    unpack: "**/*.{node,dll,exe}",
  });
  // Replace the unpacked dir with the freshly generated one.
  const genUnpacked = outAsar + ".unpacked";
  const outUnpacked = path.join(outputDir, "resources", "app.asar.unpacked");
  fs.rmSync(outUnpacked, { recursive: true, force: true });
  if (fs.existsSync(genUnpacked)) fs.renameSync(genUnpacked, outUnpacked);

  // 5. Fix the embedded integrity hash in the copied executable.
  const exePath = path.join(outputDir, EXE_NAME);
  const exeBuf = fs.readFileSync(exePath);
  const embedded = extractEmbeddedIntegrity(exeBuf);
  if (!embedded) {
    throw new Error("Embedded asar integrity hash not found in executable.");
  }
  const mode = detectHashMode(fs.readFileSync(srcAsar), embedded);
  if (!mode) {
    throw new Error(
      "Could not reproduce the original asar header hash — unsupported asar layout."
    );
  }
  const newHash = sha256(headerCandidates(fs.readFileSync(outAsar))[mode]);
  rewriteEmbeddedHash(exePath, embedded, newHash);

  fs.rmSync(tmp, { recursive: true, force: true });
  return { outputDir, patchedFiles, validatorsPatched };
}

function* walkJs(dir, prefix = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkJs(path.join(dir, entry.name), rel);
    else if (entry.name.endsWith(".js")) yield rel;
  }
}
