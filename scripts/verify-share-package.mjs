#!/usr/bin/env node
// Inspect only the supplied build artifact. Never open the user's runtime store,
// Keychain, environment files, or credential values for comparison.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractFile, getRawHeader } from "@electron/asar";
import { parse } from "acorn";

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('Usage: node scripts/verify-share-package.mjs "release/PE-Studio-mac-arm64.zip" [other .zip or .app]');
  process.exit(2);
}
const forbiddenParts = /^(?:\.env(?:\..*)?|\.git|\.sites-runtime|node_modules|tests?|user[- ]?data|local storage|session storage|indexeddb|leveldb|cookies|history|sessions|credentials(?:\..*)?|desktop-preferences\.json|pe-studio\.(?:sessions|config)\.v1)$/i;
const forbiddenExtensions = /\.(?:map|log|sqlite(?:3)?|db|ldb|pem|key|p12|pfx|mobileprovision)$/i;
const bundleName = "PE Studio.app";

function assert(condition, message) { if (!condition) throw new Error(message); }
function safePath(name) {
  assert(name && !name.includes("\\") && !name.startsWith("/") && !/[\0\r\n]/.test(name), "Unsafe archive path");
  assert(name.split("/").every(part => part !== ".." && part !== "."), "Archive path traverses its root");
}
function checkInventory(entries, appRelative = bundleName) {
  const wrapper = path.posix.dirname(appRelative) === "." ? "" : path.posix.dirname(appRelative);
  assert(!wrapper || /^PE-Studio-[\w.-]+-mac-(?:arm64|x64)$/.test(wrapper), "Unexpected sharing folder name");
  const notes = new Set(["安装与使用说明.txt", "微信转发文案.txt"].map(name => wrapper ? `${wrapper}/${name}` : name));
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, "");
    safePath(name);
    if (name === "__MACOSX") continue;
    const withoutMetadata = (name.startsWith("__MACOSX/") ? name.slice("__MACOSX/".length) : name).split("/").map(part => part.replace(/^\._/, "")).join("/");
    const inBundle = withoutMetadata === appRelative || withoutMetadata.startsWith(`${appRelative}/`);
    assert(inBundle || (wrapper && (withoutMetadata === wrapper || notes.has(withoutMetadata))), "Archive contains content outside its app and two approved instruction files");
    const parts = withoutMetadata.split("/").map(part => part.replace(/^\._/, ""));
    assert(!parts.some(part => forbiddenParts.test(part)) && !forbiddenExtensions.test(parts.at(-1)), `Forbidden runtime/development file: ${withoutMetadata}`);
    if (entry.link !== undefined) {
      assert(inBundle, "Instruction file cannot be a symlink");
      assert(!path.posix.isAbsolute(entry.link), "Bundle contains an absolute symlink");
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), entry.link));
      assert(target.startsWith(`${appRelative}/`), "Bundle symlink escapes the app");
    }
  }
}

async function appInventory(appPath, prefix = bundleName) {
  const entries = [];
  async function visit(relative) {
    const full = path.join(appPath, relative);
    const info = await lstat(full);
    const entry = { name: path.posix.join(prefix, relative.split(path.sep).join("/")) };
    if (info.isSymbolicLink()) entry.link = await readlink(full);
    if (prefix || relative) entries.push(entry);
    if (info.isDirectory()) for (const child of await readdir(full)) await visit(path.join(relative, child));
  }
  await visit("");
  return entries;
}

// ZIP directory metadata and the ASAR payload are read without extracting or
// executing the app. Python's stdlib avoids adding packaging dependencies.
function inspectZip(archive, asarDestination) {
  const code = String.raw`
import json, shutil, stat, struct, sys, zipfile, zlib
archive, destination = sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    rows = []
    names = {}
    recovered_utf8_names = 0
    for item in z.infolist():
        # macOS ditto can write UTF-8 bytes without general-purpose flag 11.
        # zipfile decodes those bytes as CP437. Recover only strictly valid
        # UTF-8; keep the original ZipInfo for CRC/local-header verification.
        raw = item.filename.encode('utf-8' if item.flag_bits & 0x800 else 'cp437')
        name = item.filename
        if not item.flag_bits & 0x800:
            try: name = raw.decode('utf-8', errors='strict')
            except UnicodeDecodeError: pass
            if name != item.filename: recovered_utf8_names += 1
        # Do not let an alternate Unicode-path extra field make the extractor
        # use a different path from the name checked against the allowlist.
        extra = item.extra
        while extra:
            if len(extra) < 4: raise ValueError('Truncated ZIP extra field')
            kind, size = struct.unpack('<HH', extra[:4])
            if len(extra) < size + 4: raise ValueError('Truncated ZIP extra field')
            payload, extra = extra[4:4+size], extra[4+size:]
            if kind == 0x7075:
                if len(payload) < 5 or payload[0] != 1: raise ValueError('Invalid Unicode ZIP path field')
                if struct.unpack('<I', payload[1:5])[0] != zlib.crc32(raw): raise ValueError('Invalid Unicode ZIP path checksum')
                if payload[5:].decode('utf-8', errors='strict') != name: raise ValueError('Ambiguous Unicode ZIP path')
        if name in names: raise ValueError('Duplicate decoded ZIP entry')
        names[name] = item
        row = {'name': name}
        if stat.S_ISLNK(item.external_attr >> 16):
            if item.file_size > 4096: raise ValueError('Oversized symbolic link')
            row['link'] = z.read(item).decode('utf-8')
        rows.append(row)
    suffix = 'PE Studio.app/Contents/Resources/app.asar'
    candidates = [name for name in names if name == suffix or name.endswith('/' + suffix)]
    if len(candidates) != 1: raise ValueError('Expected exactly one app.asar')
    asar_name = candidates[0]
    app_relative = asar_name[:-len('/Contents/Resources/app.asar')]
    entry = names[asar_name]
    if entry.file_size > 64 * 1024 * 1024: raise ValueError('Unexpected ASAR size')
    with z.open(entry) as source, open(destination, 'wb') as target:
        shutil.copyfileobj(source, target)
    with z.open(names[app_relative + '/Contents/MacOS/PE Studio']) as executable:
        header = executable.read(32).hex()
    bad = z.testzip()
    if bad: raise ValueError('ZIP CRC check failed')
    print(json.dumps({'entries': rows, 'appRelative': app_relative, 'executableHeader': header, 'crcVerified': True, 'utf8NamesRecoveredWithoutFlag': recovered_utf8_names}))
`;
  return JSON.parse(execFileSync("python3", ["-c", code, archive, asarDestination], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

function checkProductionSmokeGuard(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const variableDeclarations = [], smokeCalls = [], assignments = [], mocks = [];
  function visit(node, ancestors = []) {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && node.id?.name === "smokeDirectory") variableDeclarations.push(node);
    if (node.type === "AssignmentExpression" && node.left?.name === "smokeDirectory") assignments.push(node);
    if (node.type === "CallExpression" && node.callee?.name === "runDesktopSmoke") smokeCalls.push(ancestors);
    if (node.type === "CallExpression" && node.callee?.name === "mockModelTransport") mocks.push(ancestors);
    // Flag embedded literal credentials, without printing the value or knowing
    // any real key. Empty defaults and computed runtime credentials are valid.
    if (node.type === "Property" && ["apiKey", "api_key"].includes(node.key?.name ?? node.key?.value) && node.value?.type === "Literal") {
      assert(typeof node.value.value !== "string" || node.value.value === "", "Nonempty literal API credential found in bundled code");
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child, [...ancestors, node]);
      else if (value && typeof value === "object") visit(value, [...ancestors, node]);
    }
  }
  visit(ast);
  assert(variableDeclarations.length === 1 && assignments.length === 0, "Smoke guard variable is missing or reassigned");
  const init = variableDeclarations[0].init;
  assert(init?.type === "ConditionalExpression" && init.test?.type === "UnaryExpression" && init.test.operator === "!" && init.test.argument?.type === "MemberExpression" && init.test.argument.property?.name === "isPackaged", "Smoke initialization is not gated on !app.isPackaged");
  assert(init.test.argument.object?.property?.name === "app", "Smoke guard does not reference Electron app");
  assert(source.slice(init.consequent.start, init.consequent.end) === "process.env.PE_STUDIO_SMOKE_DIR", "Unexpected smoke directory source");
  assert(init.alternate?.type === "UnaryExpression" && init.alternate.operator === "void", "Packaged app can retain a smoke directory");
  assert(smokeCalls.length === 1 && smokeCalls[0].some((node, index, ancestors) => node.type === "IfStatement" && node.test?.name === "smokeDirectory" && ancestors[index + 1] === node.consequent), "Smoke runner has an unguarded entry point");
  assert(mocks.length === 1 && mocks[0].some(node => node.type === "FunctionDeclaration" && node.id?.name === "runDesktopSmoke"), "Mock model transport is reachable outside the smoke runner");
  return { disabledWhenPackaged: true, onlyGuardedEntry: true, appWasNotExecuted: true };
}

function allowedAsarFile(name) {
  return name === "package.json" || /^dist-desktop\/(?:main|preload)\.cjs$/.test(name) ||
    /^dist-desktop\/native\/glass-(?:arm64|x64)\.node$/.test(name) ||
    /^dist-desktop\/assets\/(?:icon\.(?:icns|png|svg)|trayTemplate(?:@2x)?\.png|hermes-runner\.py)$/.test(name) ||
    /^dist-desktop\/renderer\/(?:index\.html|[\w.-]+\.svg)$/.test(name) ||
    /^dist-desktop\/renderer\/brands\/(?:gpt|claude|gemini)\.svg$/.test(name) ||
    /^dist-desktop\/renderer\/assets\/[\w./-]+\.(?:js|css|svg|png|jpe?g|webp|woff2?|ttf)$/.test(name);
}

async function inspectAsar(archive) {
  const archiveInfo = await lstat(archive);
  assert(archiveInfo.isFile() && !archiveInfo.isSymbolicLink(), "ASAR must be a regular file");
  const { header } = getRawHeader(archive);
  const files = [];
  function walk(tree, parent = "") {
    for (const [base, node] of Object.entries(tree.files ?? {})) {
      const name = parent ? `${parent}/${base}` : base;
      safePath(name);
      assert(!name.split("/").some(part => forbiddenParts.test(part)) && !forbiddenExtensions.test(base), `Forbidden ASAR entry: ${name}`);
      const nativePayload = /^dist-desktop\/native(?:\/glass-(?:arm64|x64)\.node)?$/.test(name);
      const helperPayload = name === "dist-desktop/assets" || name === "dist-desktop/assets/hermes-runner.py";
      assert(!node.link && (!node.unpacked || nativePayload || helperPayload), `ASAR contains an external link or unexpected unpacked payload: ${name}`);
      if (node.files) {
        assert(["dist-desktop", "dist-desktop/assets", "dist-desktop/native", "dist-desktop/renderer", "dist-desktop/renderer/assets", "dist-desktop/renderer/brands"].includes(name) || name.startsWith("dist-desktop/renderer/assets/"), `Unexpected ASAR directory: ${name}`);
        walk(node, name);
      }
      else { assert(allowedAsarFile(name), `Unexpected ASAR file: ${name}`); files.push({ name, ...node }); }
    }
  }
  assert(Object.keys(header.files ?? {}).sort().join(",") === "dist-desktop,package.json", "ASAR root contains unexpected files");
  walk(header);
  const nativeFiles = files.filter(file => file.name.startsWith("dist-desktop/native/"));
  assert(nativeFiles.length === 2 && nativeFiles.every(file => file.unpacked === true), "Expected exactly two unpacked native glass modules");
  const helperFiles = files.filter(file => file.name === "dist-desktop/assets/hermes-runner.py");
  assert(helperFiles.length <= 1 && helperFiles.every(file => file.unpacked === true), "Hermes helper must be the exact unpacked bridge file");
  const unpackedRoot = archive + ".unpacked";
  const unpackedInfo = await lstat(unpackedRoot);
  assert(unpackedInfo.isDirectory() && !unpackedInfo.isSymbolicLink(), "Native payload root must be a real directory");
  const unpackedInventory = await appInventory(unpackedRoot, "");
  const expectedUnpacked = new Set(["dist-desktop", "dist-desktop/native", ...nativeFiles.map(file => file.name), ...(helperFiles.length ? ["dist-desktop/assets", ...helperFiles.map(file => file.name)] : [])]);
  assert(unpackedInventory.length === expectedUnpacked.size && unpackedInventory.every(entry => expectedUnpacked.has(entry.name) && entry.link === undefined), "Unexpected or missing unpacked payload or symlink");
  for (const file of files) {
    const bytes = extractFile(archive, file.name);
    assert(bytes.length === file.size, `ASAR size mismatch: ${file.name}`);
    assert(file.integrity?.algorithm === "SHA256" && createHash("sha256").update(bytes).digest("hex") === file.integrity.hash, `ASAR content hash mismatch: ${file.name}`);
    if (file.unpacked && file.name.startsWith("dist-desktop/native/")) {
      const expectedArch = file.name.includes("arm64") ? "arm64" : "x64";
      assert(architecture(bytes.subarray(0,32)) === expectedArch, "Native glass module architecture mismatch");
      execFileSync("codesign", ["--verify", "--strict", path.join(unpackedRoot, file.name)], { stdio: "pipe" });
    }
    if (/\.(?:cjs|js|html|json|py)$/.test(file.name)) {
      const code = bytes.toString("utf8");
      assert(!/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b|\bAIza[A-Za-z0-9_-]{30,}\b/.test(code), `Possible embedded credential in ${file.name}; value suppressed`);
    }
  }
  const pkg = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  const expectedKeys = ["name", "productName", "version", "main", "description", "author", "license"];
  assert(Object.keys(pkg).every(key => expectedKeys.includes(key)), "Packaged package.json includes unexpected fields");
  assert(pkg.main === "dist-desktop/main.cjs" && pkg.name === "pe-studio", "Unexpected app entry point");
  const source = extractFile(archive, pkg.main).toString("utf8");
  const smokeGuard = checkProductionSmokeGuard(source);
  const asarSha256 = createHash("sha256");
  for await (const chunk of createReadStream(archive)) asarSha256.update(chunk);
  return { fileCount: files.length, nativeModuleCount: nativeFiles.length, rootEntries: Object.keys(header.files).sort(), sha256: asarSha256.digest("hex"), integrityVerified: true, runtimeStoreFiles: 0, smokeGuard, version: pkg.version };
}

function architecture(bytes) {
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) return "unknown";
  return ({ [0x0100000c]: "arm64", [0x01000007]: "x64" })[bytes.readUInt32LE(4)] ?? "unknown";
}

function verifySignature(appPath) {
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
  const signed = spawnSync("codesign", ["-dv", "--verbose=2", appPath], { encoding: "utf8" });
  assert(signed.status === 0, "Could not read code-signature metadata");
  return { verified: true, adHoc: /Signature=adhoc/.test(signed.stderr), developerId: /Authority=Developer ID Application:/.test(signed.stderr), notarization: "not established by this check" };
}

let failed = false;
for (const input of inputs) {
  const artifact = path.resolve(input);
  const temporary = await mkdtemp(path.join(tmpdir(), "pe-studio-share-check-"));
  try {
    let inventory, asarPath, executableHeader, signature, zipCrcVerified, utf8NamesRecoveredWithoutFlag, extractedBundleVerified = false;
    if (artifact.endsWith(".zip")) {
      asarPath = path.join(temporary, "app.asar");
      const zip = inspectZip(artifact, asarPath);
      inventory = zip.entries;
      // Validate all paths and link targets before allowing ditto to extract.
      checkInventory(inventory, zip.appRelative);
      executableHeader = Buffer.from(zip.executableHeader, "hex");
      zipCrcVerified = zip.crcVerified;
      utf8NamesRecoveredWithoutFlag = zip.utf8NamesRecoveredWithoutFlag;
      const extraction = path.join(temporary, "extracted");
      execFileSync("ditto", ["-x", "-k", artifact, extraction], { stdio: "pipe" });
      const extractedApp = path.join(extraction, zip.appRelative);
      const extractedInventory = await appInventory(extraction, "");
      checkInventory(extractedInventory, zip.appRelative);
      const wrapper = path.posix.dirname(zip.appRelative);
      if (wrapper !== ".") {
        for (const note of ["安装与使用说明.txt", "微信转发文案.txt"]) {
          const expected = `${wrapper}/${note}`;
          assert(extractedInventory.some(entry => entry.name === expected && entry.link === undefined) && (await stat(path.join(extraction, expected))).isFile(), "Instruction filename was not preserved after ditto extraction");
        }
      }
      signature = verifySignature(extractedApp);
      const extractedAsar = path.join(extractedApp, "Contents/Resources/app.asar");
      assert((await readFile(extractedAsar)).equals(await readFile(asarPath)), "ASAR changed during ZIP extraction");
      asarPath = extractedAsar;
      extractedBundleVerified = true;
    } else {
      assert(artifact.endsWith(".app") && (await stat(artifact)).isDirectory(), "Expected a .zip or .app artifact");
      inventory = await appInventory(artifact);
      asarPath = path.join(artifact, "Contents/Resources/app.asar");
      executableHeader = (await readFile(path.join(artifact, "Contents/MacOS/PE Studio"))).subarray(0, 32);
      signature = verifySignature(artifact);
      checkInventory(inventory);
    }
    const asar = await inspectAsar(asarPath);
    const arch = architecture(executableHeader);
    assert(arch !== "unknown", "Unexpected Mach-O executable architecture");
    const expectedArch = artifact.match(/(?:mac|darwin)-(arm64|x64)(?:\/|-|\.|$)/)?.[1];
    assert(!expectedArch || arch === expectedArch, "Archive label and executable architecture differ");
    console.log(JSON.stringify({ artifact, ok: true, architecture: arch, inventoryEntries: inventory.length, zipCrcVerified, utf8NamesRecoveredWithoutFlag, extractedBundleVerified, asar, signature, userRuntimeStoreRead: false }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ artifact, ok: false, error: error instanceof Error ? error.message : "Package verification failed", userRuntimeStoreRead: false }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (failed) process.exitCode = 1;
